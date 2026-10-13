"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  PaperclipIcon,
  SparklesIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { SparkleIcon } from "@/components/ai/sparkle-icon";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import type { UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { uuid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ApprovalCard, pendingApprovals } from "@/components/ai/tool-approval";
import { OrionChart } from "@/components/ai/orion-chart";
import { messageBlocks } from "@/lib/ai/chart-spec";
import {
  hasVisibleContent,
  messageText,
  textIsLatest,
  toolActivityLabels,
} from "@/components/ai/message-utils";
import { useResearchActivity } from "@/components/ai/use-research-activity";
import { useMessageTimes } from "@/components/ai/use-message-times";
import { messageTime } from "@/lib/format/relative";
import { ThinkingIndicator } from "@/components/ai/thinking-indicator";
import { errorText, logOrionClientError } from "@/components/ai/log-error";
import {
  refreshProjectMemory,
  saveMessages,
} from "@/lib/ai/conversation-actions";
import { useComposerShape } from "@/components/ai/use-composer-shape";
import {
  AttachmentChips,
  COMPOSER_SHELL_DENSE,
  COMPOSER_ROW,
  COMPOSER_TEXTAREA_DENSE,
  DropOverlay,
  SendButton,
  buildSendPayload,
  useStagedFiles,
  type ComposerFilePart,
} from "@/components/ai/composer";
import { currentSlices, usePageActionDispatch } from "@/lib/ai/use-ai-context";
import { buildPageContext } from "@/lib/ai/page-context";
import {
  isOutOfCreditsError,
  useCredits,
} from "@/components/billing/credits-context";
import { logGeologyTrace } from "@/lib/ai/geology/client-log";
import { logToolParts } from "@/lib/ai/tool-log";

interface ChatPanelProps {
  onClose?: () => void;
  /** When set, the chat is scoped to a project. */
  folderId?: string;
  projectName?: string;
  /**
   * Controlled active conversation id. When the parent switches conversations
   * (e.g. picking one from the history dropdown) it should also remount this
   * panel with a matching `key` so the chat state resets cleanly.
   */
  conversationId?: string;
  /** Messages to rehydrate a previously saved conversation. */
  initialMessages?: UIMessage[];
  /** Fired after a debounced save so the parent can refresh its history list. */
  onSaved?: () => void;
  /**
   * First bubble, shown until the chat has a message. Defaults to Orion's
   * introduction; a surface with a different job for Orion (help docs, say)
   * says so here instead.
   */
  greeting?: React.ReactNode;
  /** Where a turn is posted; the admin drawer points at the admin route. */
  api?: string;
  /** Where the chat is saved; the admin drawer saves to the admin history. */
  save?: (id: string, messages: UIMessage[], folderId?: string) => Promise<void>;
}

/**
 * Live chat panel backed by the AI SDK (`/api/chat` → Claude). Streams the
 * assistant's response token-by-token. Requires ANTHROPIC_API_KEY in the
 * environment for the route to authenticate. When `folderId` is set the chat is
 * scoped to that project (folder-scoped retrieval + page prompt).
 */
export function ChatPanel({
  onClose,
  folderId,
  projectName,
  conversationId,
  initialMessages,
  onSaved,
  greeting,
  api = "/api/chat",
  save = saveMessages,
}: ChatPanelProps) {
  // Ground the assistant in the user's current location + selected file/folder
  // so it can resolve "this page" / "this file" references. `useChat` captures
  // the transport once (it only recreates on chat-id change), so we read the
  // route + selection *live* at send-time via the transport's function `body`
  // (re-resolved on every request, including tool-approval auto-resends) rather
  // than baking a snapshot in. folderId/projectName are stable per mount.
  // AI-credit gate: the server refuses out-of-credit calls with a 402; latch
  // that here so the send button turns into a "buy credits" prompt instead of
  // hammering a route that will keep refusing.
  const { exhausted, markExhausted, openBuyCredits } = useCredits();
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api,
        // Detect the credit gate's refusal by the ACTUAL HTTP status, not by
        // pattern-matching the thrown error's text (which the SDK doesn't
        // guarantee). A 402 means "out of credits" -> flip to the buy upsell.
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          if (res.status === 402) markExhausted();
          return res;
        },
        body: () => ({
          ...(folderId ? { folderId, projectName } : {}),
          pageContext: buildPageContext(
            window.location.pathname,
            currentSlices()
          ),
        }),
      }),
    [folderId, projectName, markExhausted, api]
  );
  // A draft conversation id so this chat is saved into chat history (persisted
  // on first message, see effect below). When the parent supplies an id (an
  // existing conversation), use that instead.
  const [generatedId] = useState(() => uuid());
  const activeId = conversationId ?? generatedId;
  // Throttle UI updates so the streamed markdown repaints on a smooth, steady
  // cadence instead of thrashing on every token.
  const research = useResearchActivity();
  const messageTimeOf = useMessageTimes();
  const { messages, sendMessage, status, error, stop, addToolApprovalResponse } =
    useChat({
      // Two consumers of the side channel: the geology trace goes to the console
      // (the answer never mentions a tool or the reference library, so this is
      // the only way to see whether either was used) and the research phase
      // drives the thinking line. Both transient — nothing renders from the
      // message and nothing is persisted.
      onData: (part) => {
        logGeologyTrace(part);
        research.onData(part);
      },
      id: activeId,
      messages: initialMessages,
      transport,
      experimental_throttle: 50,
      // Resume automatically once the user has approved/denied pending writes.
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      // Belt-and-suspenders: also catch the 402 if it surfaces as a thrown error.
      onError: (err) => {
        if (isOutOfCreditsError(err)) markExhausted();
        logOrionClientError(err, {
          surface: "drawer",
          conversationId: activeId,
          folderId,
          messageCount: initialMessages?.length ?? 0,
        });
      },
    });
  const [input, setInput] = useState("");
  // Files dragged onto the panel or pasted into it, staged until the next send.
  const {
    staged,
    remove: removeStaged,
    clear: clearStaged,
    dragging,
    dropProps,
  } = useStagedFiles();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the first effect run so rehydrating a saved chat doesn't immediately
  // re-save it (and ping onSaved) before the user has changed anything.
  const seededRef = useRef(true);
  /**
   * A message the user sent while Orion was still working, held until the run it
   * cut off has unwound.
   *
   * It cannot go out immediately after `stop()`: the aborted request tears itself
   * down asynchronously, and that teardown sets the chat back to "ready" and clears
   * the SDK's active response — so a send issued in between would have its status
   * and stream state pulled out from under it. Waiting for the status to settle
   * costs a few milliseconds and makes the hand-off deterministic.
   */
  const pendingSendRef = useRef<{
    text: string;
    files?: ComposerFilePart[];
  } | null>(null);
  // Track status transitions so we can finalize exactly once per assistant turn.
  const prevStatusRef = useRef(status);

  const isBusy = status === "submitted" || status === "streaming";
  // Any stretch of the turn where output has stopped but work hasn't — before the
  // first token, and again after a preliminary line while a tool runs. Same rule
  // and same predicate as /orion, so the two surfaces can't drift.
  const lastMessage = messages[messages.length - 1];
  const inProgress =
    lastMessage?.role === "assistant" ? lastMessage : undefined;
  const showThinking = isBusy && !textIsLatest(inProgress);
  // Researchers first: they run before the answering model, so their labels are
  // the earliest thing the turn can honestly say it is doing.
  const activeTools = showThinking
    ? [...research.activities, ...toolActivityLabels(inProgress)]
    : [];

  // The backstop. A stopped turn, a dropped connection or a stage that threw
  // past its own guard never sends `phase: "done"`, and the labels would sit
  // under the orb describing work that is not happening.
  const clearResearch = research.clear;
  useEffect(() => {
    if (!isBusy) clearResearch();
  }, [isBusy, clearResearch]);

  // Persist chats into Supabase chat history (debounced; only once there is
  // content, so empty opens never create rows). Tags the conversation with the
  // folder so it shows up in this project's history.
  /*
   * Every tool call, in the console, ONCE the turn settles.
   *
   * Gated on `status`: the message array gets a new identity on every streamed
   * chunk, and scanning the whole transcript hundreds of times a turn is waste.
   * Tool parts are only logged in their terminal state anyway, so there is
   * nothing to see mid-stream.
   *
   * A failed tool comes back to the model as an ordinary `{ ok: false }` result
   * and the answer simply works around it, so a break is invisible on screen.
   * See `@/lib/ai/tool-log`.
   */
  useEffect(() => {
    if (status === "submitted" || status === "streaming") return;
    logToolParts(messages);
  }, [messages, status]);

  /*
   * A directive Orion produced for the page under this chat — the Scout map's
   * filters and camera. Applied here because the surface is the only thing
   * holding the messages; the page itself registered the handler. See
   * `usePageActionDispatch`.
   */
  usePageActionDispatch(messages);

  useEffect(() => {
    if (seededRef.current) {
      seededRef.current = false;
      return;
    }
    if (messages.length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      save(activeId, messages, folderId)
        .then(() => onSaved?.())
        .catch((err) => console.error("Failed to save chat", err));
    }, 800);
  }, [messages, activeId, folderId, onSaved, save]);

  // When an assistant turn completes inside a project, finalize: flush the save
  // immediately (beat the debounce) and regenerate the project's curated memory
  // so the agent carries this turn forward. Folder-scoped only — the global /
  // drawer chats don't have project memory.
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    const justFinished =
      (prev === "streaming" || prev === "submitted") && status === "ready";
    if (!justFinished || !folderId || messages.length === 0) return;
    // An interrupt lands as streaming -> ready too, but nothing finished: the turn
    // was abandoned and its replacement is already queued. Regenerating project
    // memory off a half-turn costs an Opus call and summarises a fragment, so leave
    // finalizing to the turn that actually completes.
    if (pendingSendRef.current) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    (async () => {
      try {
        await save(activeId, messages, folderId);
        onSaved?.();
        await refreshProjectMemory(folderId);
      } catch (err) {
        console.error("Failed to finalize project chat turn", err);
      }
    })();
  }, [status, folderId, activeId, messages, onSaved, save]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isBusy]);

  // Grow the input with its content (up to a max), shrink back when cleared, and
  // swap the shell between pill and rounded rectangle as the text wraps —
  // identical behavior to the /orion composers.
  useComposerShape({
    textareaRef,
    shellRef: composerShellRef,
    value: input,
    maxHeight: 208,
    forceExpanded: staged.length > 0,
  });

  // Send what the user typed over the top of the run it interrupted, once that run
  // has finished unwinding (see pendingSendRef).
  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    const queued = pendingSendRef.current;
    if (!queued) return;
    pendingSendRef.current = null;
    void sendMessage(queued);
  }, [status, sendMessage]);

  const hasDraft = input.trim().length > 0 || staged.length > 0;

  async function handleSend() {
    const text = input.trim();
    if (!hasDraft) return;
    // Out of credits: don't hit a route that will 402 again; prompt to top up.
    if (exhausted) {
      openBuyCredits();
      return;
    }
    const payload = await buildSendPayload(text, staged);
    // The user outranks the run in progress: interrupt it and ask this instead.
    if (isBusy) {
      pendingSendRef.current = payload;
      void stop();
    } else {
      void sendMessage(payload);
    }
    setInput("");
    clearStaged();
  }

  return (
    <div
      {...dropProps}
      className="relative flex h-full min-h-0 flex-col bg-background-surface"
    >
      {dragging && <DropOverlay />}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <SparkleIcon className="size-4 text-data-accent" />
        <span className="ty-body-1 font-medium text-primary-text">Orion</span>
        <span className="ty-caption rounded-full bg-background-subtle px-1.5 py-0.5 text-tertiary-text">
          AI
        </span>
        {onClose && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close Orion"
            onClick={onClose}
            className="ml-auto"
          >
            <XIcon />
          </Button>
        )}
      </header>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          {messages.length === 0 && (
            <div className="flex justify-start">
              <div className="ty-body-2 max-w-[85%] rounded-2xl bg-background-subtle px-3.5 py-2 text-primary-text">
                {greeting ?? (
                  <>
                    Hi, I&apos;m <strong>Orion</strong>. Ask me about the wells,
                    geology, or anything in this folder.
                  </>
                )}
              </div>
            </div>
          )}

          {messages.map((m) => {
            const text = messageText(m);
            // Empty assistant turns (tool calls, no text yet) render nothing, so
            // the thinking indicator doesn't get shoved down a gap when a tool
            // fires. Same rule as /orion.
            if (!hasVisibleContent(m)) return null;
            return (
              <div key={m.id} className="flex flex-col gap-2">
                {m.role === "user" ? (
                  <>
                    <SentAttachments message={m} />
                    {text && <MessageBubble role={m.role} text={text} />}
                  </>
                ) : (
                  // Text and charts interleaved in production order, so text
                  // streaming in after a chart lands BELOW it instead of pushing
                  // it down the panel (same fix as /orion). Each block fades in
                  // as it mounts — the other half of the crossfade with the
                  // thinking indicator.
                  messageBlocks(m).map((block, i) =>
                    block.kind === "chart" ? (
                      <motion.div
                        key={`chart-${i}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.26, ease: "easeOut" }}
                      >
                        <OrionChart spec={block.spec} surface="drawer" />
                      </motion.div>
                    ) : (
                      <motion.div
                        key={`text-${i}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.24, ease: "linear" }}
                      >
                        <MessageBubble role={m.role} text={block.text} />
                      </motion.div>
                    )
                  )
                )}
                {/* Under every message, same rule as /orion: the gap between
                    two turns is often what explains them. Suppressed on the
                    answer still streaming, which has no settled time yet. */}
                {!(isBusy && m === messages[messages.length - 1]) && (
                  <time
                    dateTime={new Date(messageTimeOf(m)).toISOString()}
                    className={cnTime(m.role)}
                  >
                    {messageTime(messageTimeOf(m))}
                  </time>
                )}
                {pendingApprovals(m).map((req) => (
                  <ApprovalCard
                    key={req.id}
                    request={req}
                    onApprove={() =>
                      addToolApprovalResponse({ id: req.id, approved: true })
                    }
                    onDeny={() =>
                      addToolApprovalResponse({ id: req.id, approved: false })
                    }
                  />
                ))}
              </div>
            );
          })}

          {/* Same crossfade as /orion: `popLayout` pulls the exiting indicator
              out of flow immediately, so the answer takes its slot and the
              indicator fades out on top of it rather than the text rendering a
              gap too low and snapping up. Shown for the whole pre-text window
              (submitted AND streaming-but-still-calling-tools), not just
              `submitted`, so a tool call doesn't blank the panel. */}
          <AnimatePresence initial={false} mode="popLayout">
            {showThinking && (
              <motion.div
                key="thinking"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: "linear" }}
              >
                <ThinkingIndicator activities={activeTools} size={20} />
              </motion.div>
            )}
          </AnimatePresence>

          {exhausted ? (
            <CreditsUpsell onBuy={openBuyCredits} />
          ) : (
            error && (
              <div className="ty-body-2 rounded-lg bg-error/10 px-3 py-2 text-error">
                {errorText(error)}
              </div>
            )
          )}
        </div>
      </div>

      <div className="shrink-0 p-3 pb-5">
        <div ref={composerShellRef} className={COMPOSER_SHELL_DENSE}>
          <AttachmentChips
            items={staged.map((s) => ({
              key: s.key,
              name: s.file.name,
              kind: "disk" as const,
            }))}
            onRemove={removeStaged}
            className="px-1"
          />
          <div className={COMPOSER_ROW}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              rows={1}
              placeholder="Ask Orion…"
              className={COMPOSER_TEXTAREA_DENSE}
            />
            {/* Mid-stream with nothing typed, the circle stops Orion. With text in
                it, it sends — which interrupts the run in flight. */}
            {isBusy && !exhausted && !hasDraft ? (
              <SendButton
                dense
                onClick={() => void stop()}
                disabled={false}
                label="Stop generating"
              >
                <SquareIcon className="size-3 fill-current" />
              </SendButton>
            ) : (
              <SendButton
                dense
                onClick={() => void handleSend()}
                disabled={!exhausted && !hasDraft}
                label={exhausted ? "Buy AI credits" : "Send"}
              >
                {/* Out of credits: the same circle, but it opens the top-up modal
                    rather than sending — the icon is the tell. */}
                {exhausted ? <SparklesIcon /> : undefined}
              </SendButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown in place of the generic error when the AI-credit gate refused the call
 * (HTTP 402). Turns the dead end into a one-click path to top up: the button
 * opens the same "Buy AI credits" modal as the account dropdown's "Buy more".
 */
function CreditsUpsell({ onBuy }: { onBuy: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background-subtle px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <SparklesIcon className="size-4 shrink-0 text-data-accent" />
        <span className="ty-body-2 font-medium text-primary-text">
          You&apos;re out of AI credits
        </span>
      </div>
      <p className="ty-body-2 text-tertiary-text">
        Orion is paused until your organization tops up its balance.
      </p>
      <Button type="button" size="sm" className="mt-1 self-start" onClick={onBuy}>
        Buy AI credits
      </Button>
    </div>
  );
}

// Markdown body styling shared with the /home and /orion chats: larger type,
// relaxed leading, visible list markers, and clear spacing between blocks.
const CHAT_BODY_CLASS =
  "text-[13px] leading-relaxed [&>*+*]:mt-4 " +
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 " +
  "[&_h1]:mt-5 [&_h1]:text-[1.05rem] [&_h1]:font-semibold " +
  "[&_h2]:mt-5 [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold " +
  // Tables: same bordered, padded treatment as the full-page chats, but tighter
  // (smaller type, less cell padding) for the drawer's narrow width. Cells wrap
  // and break long tokens (e.g. IDs) so a wide table stays inside the drawer
  // instead of overflowing or jamming columns together.
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px] " +
  "[&_th]:border [&_th]:border-border [&_th]:bg-background-subtle [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:break-words " +
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_td]:break-words";

/**
 * Files the user sent with a turn, shown above their bubble — the same chip the
 * composer stages them in, minus the remove control. Without this an image-only
 * message renders as nothing at all.
 */
function SentAttachments({ message }: { message: UIMessage }) {
  const names = message.parts
    .filter((p) => p.type === "file")
    .map((p) => (p as { filename?: string }).filename ?? "file");
  if (names.length === 0) return null;
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5 self-end">
      {names.map((name, i) => (
        <span
          key={i}
          className="ty-caption flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-primary-text"
        >
          <PaperclipIcon className="size-3.5 text-tertiary-text" />
          <span className="max-w-[180px] truncate">{name}</span>
        </span>
      ))}
    </div>
  );
}

function MessageBubble({ role, text }: { role: string; text: string }) {
  // User: a gray bubble, right-aligned. Assistant: plain full-width markdown
  // (no bubble) — matching the home and Orion page chats.
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-background-subtle px-3.5 py-2 text-primary-text">
          <div className={CHAT_BODY_CLASS}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="w-full text-primary-text">
      <div className={CHAT_BODY_CLASS}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}

/** Right-aligned under a user turn, left under Orion's, matching the bubbles. */
function cnTime(role: string): string {
  return `px-0.5 text-[11px] tabular-nums text-muted-foreground/60 ${
    role === "user" ? "self-end" : "self-start"
  }`;
}
