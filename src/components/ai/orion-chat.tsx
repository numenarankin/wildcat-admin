"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PlusIcon,
  PaperclipIcon,
  XIcon,
  FileTextIcon,
  Volume2Icon,
  SquareIcon,
  Loader2Icon,
  CopyIcon,
  CheckIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import type { UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AddFileDialog } from "@/components/projects/add-file-dialog";
import { ApprovalCard, pendingApprovals } from "@/components/ai/tool-approval";
import { OrionChart } from "@/components/ai/orion-chart";
import { messageBlocks } from "@/lib/ai/chart-spec";
import { useSpeech, type SpeechState } from "@/components/ai/use-speech";
import { useComposerShape } from "@/components/ai/use-composer-shape";
import { currentSlices, usePageActionDispatch } from "@/lib/ai/use-ai-context";
import { buildPageContext } from "@/lib/ai/page-context";
import { ThinkingIndicator } from "@/components/ai/thinking-indicator";
import { errorText, logOrionClientError } from "@/components/ai/log-error";
import {
  hasText,
  hasVisibleContent,
  messageText,
  stripMarkdown,
  textIsLatest,
  toolActivityLabels,
} from "@/components/ai/message-utils";
import { useResearchActivity } from "@/components/ai/use-research-activity";
import { useMessageTimes } from "@/components/ai/use-message-times";
import { messageTime } from "@/lib/format/relative";
import {
  COMPOSER_SHELL_RING,
  COMPOSER_ROW,
  COMPOSER_TEXTAREA,
  SendButton,
} from "@/components/ai/composer";
import type { Conversation } from "@/lib/ai/conversations";
import type { KBFile } from "@/lib/kb/types";
import { logGeologyTrace } from "@/lib/ai/geology/client-log";
import { logToolParts } from "@/lib/ai/tool-log";

interface DisplayAttachment {
  kind: "kb" | "disk";
  name: string;
}

/**
 * Split a message into display text + attachment chips: disk uploads come
 * through as `file` parts, knowledge-base attachments as a trailing text marker.
 */
function splitAttachments(message: UIMessage): {
  text: string;
  attachments: DisplayAttachment[];
} {
  const attachments: DisplayAttachment[] = [];

  let text = messageText(message);
  const marker = text.match(/\n*\[Attached from knowledge base: ([^\]]*)\]\s*$/);
  if (marker) {
    text = text.slice(0, marker.index).trimEnd();
    for (const name of marker[1].split(",")) {
      const trimmed = name.trim();
      if (trimmed) attachments.push({ kind: "kb", name: trimmed });
    }
  }

  for (const part of message.parts) {
    if (part.type === "file") {
      const filePart = part as { filename?: string };
      attachments.push({ kind: "disk", name: filePart.filename ?? "file" });
    }
  }

  return { text, attachments };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

type Attachment =
  | { kind: "kb"; key: string; refId: string; name: string }
  | { kind: "disk"; key: string; file: File };

interface OrionChatProps {
  conversation: Conversation;
  /** Persist the live message list back to the conversation store. */
  onMessagesChange: (messages: UIMessage[]) => void;
  /** Signed-in user's first name, for the new-chat greeting (matches home). */
  firstName: string;
  /**
   * When set, scope the chat to a project: the folder id is sent with every
   * request so the route does folder-scoped retrieval + project prompt (same
   * plumbing the drawer's ChatPanel uses). Omitted on the global /orion page.
   */
  folderId?: string;
  projectName?: string;
  /** Hide the knowledge-base and disk attachment buttons (a chat with nothing to attach). */
  noAttachments?: boolean;
  /**
   * A one-click opener: with nothing typed (and Orion idle), the send circle
   * becomes a pill with this label that sends `text` as the user's message.
   */
  quickAction?: { label: string; text: string };
  /**
   * Where a turn is posted. The admin side points this at its own route,
   * which hands the model a different catalog; nothing else about the
   * surface changes.
   */
  api?: string;
  /**
   * Fields added to every turn's body, for a route that needs more than the
   * project (the admin Enrich chat sends its target number).
   */
  extraBody?: Record<string, unknown>;
}

/**
 * Full-page Orion chat surface backed by the AI SDK (`/api/chat` → Claude).
 * Supports attaching files from the knowledge base (plus) or uploading from
 * disk (paperclip). Disk files are sent to Claude as file parts; knowledge-base
 * attachments are referenced by name (prototype — no stored content yet).
 */
export function OrionChat({
  conversation,
  onMessagesChange,
  firstName,
  folderId,
  projectName,
  api = "/api/chat",
  extraBody,
  noAttachments = false,
  quickAction,
}: OrionChatProps) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api,
        // Page context on every turn, like the drawer.
        //
        // This surface used to send none, on the reasoning that a full-page chat
        // has no page under it to describe. It does: a project page embeds this
        // chat beside its files, and even on /orion the selection published by
        // the last page visited is how "the log I was just looking at" resolves.
        // Sending nothing is what left the geology harness with no way to find a
        // LAS here (see docs/plans/page-context-awareness.md).
        body: () => ({
          ...extraBody,
          ...(folderId ? { folderId, projectName } : {}),
          pageContext: buildPageContext(
            window.location.pathname,
            currentSlices()
          ),
        }),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- extraBody is read at send time; callers pass a stable object
    [folderId, projectName, api]
  );
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
      id: conversation.id,
      messages: conversation.messages,
      transport,
      experimental_throttle: 50,
      // Once the user has approved/denied every pending write tool, resume the
      // run automatically so the approved action executes (or Orion is told it
      // was declined).
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      // Every failed turn gets logged with its full shape and the server's turn
      // id; without this the browser shows a red box and the console is silent.
      onError: (err) =>
        logOrionClientError(err, {
          surface: "orion-page",
          conversationId: conversation.id,
          folderId,
          messageCount: conversation.messages.length,
        }),
    });
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [kbOpen, setKbOpen] = useState(false);
  const [greeting, setGreeting] = useState<string | null>(null);
  const speech = useSpeech();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);
  const pinnedUserIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The composer shell whose corners round in and out; only one of the two
  // composers below is mounted at a time (landing vs in-chat), so they share it.
  const composerShellRef = useRef<HTMLDivElement>(null);
  const diskInputRef = useRef<HTMLInputElement>(null);
  const diskIdRef = useRef(0);

  const isBusy = status === "submitted" || status === "streaming";
  const hasMessages = messages.length > 0;

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

  // Compute the greeting on the client to use local time (avoids SSR mismatch).
  useEffect(() => {
    setGreeting(timeOfDayGreeting());
  }, []);

  // While Orion works, narrate what it's doing in plain English. The in-progress
  // assistant message is the last one. The indicator tracks every stretch of the
  // turn where output has stopped — before the first token AND after a preliminary
  // line while the next tool runs — not just the first one (see textIsLatest).
  const lastMessage = messages[messages.length - 1];
  const inProgress = lastMessage?.role === "assistant" ? lastMessage : undefined;
  // Researchers first: they run before the answering model, so their labels are
  // the earliest thing the turn can honestly say it is doing.
  const activeTools = isBusy
    ? [...research.activities, ...toolActivityLabels(inProgress)]
    : [];
  const showThinking = isBusy && !textIsLatest(inProgress);

  // The backstop. A stopped turn, a dropped connection or a stage that threw
  // past its own guard never sends `phase: "done"`, and the labels would sit
  // under the orb describing work that is not happening.
  const clearResearch = research.clear;
  useEffect(() => {
    if (status !== "submitted" && status !== "streaming") clearResearch();
  }, [status, clearResearch]);

  const seededRef = useRef(true);
  /*
   * Lift messages to the workspace ONCE the turn settles, never mid-stream.
   *
   * `onMessagesChange` writes parent state unconditionally — a fresh
   * conversations array and a fresh conversation object on every call. Firing it
   * per streamed chunk meant: SDK store notifies, this component re-renders, the
   * effect writes parent state, the parent re-renders, and the next chunk lands
   * inside that flush. React counts those as nested updates and trips its
   * 50-deep guard, which killed the turn outright. It showed up on long threads
   * first, because each update copies a bigger array.
   *
   * ## But "settled only" lost conversations, so it is settled OR a new message
   *
   * Gating on the settled turn alone meant the parent never heard about the
   * user's own message until the answer finished. Persistence runs off parent
   * state, so a turn that was slow, stopped, or navigated away from took the
   * QUESTION with it — the exchange never reached the database and the chat was
   * missing from history entirely.
   *
   * The storm came from the last message's PARTS mutating on every delta, not
   * from the list growing. Message COUNT changes exactly twice a turn (the user
   * turn, then the assistant's), so lifting on a count change costs two writes
   * and gets the question persisted immediately, while the per-delta writes that
   * tripped React's nested-update guard stay suppressed.
   *
   * ## And nothing is lifted for merely OPENING a conversation
   *
   * `useChat` hydrates a loaded thread on a render after mount, so `messages`
   * changed and the effect fired even though the user had done nothing. That
   * lift ran a save, the save upserts the conversation row, and the row's
   * `updated_at` moved to now — so opening a chat aged it to "just now", the
   * history panel sorts on that column, and every conversation you had merely
   * CLICKED jumped above the ones you had actually written in. Nothing was lost;
   * the list was reordered by reading it, which reads as loss.
   *
   * `dirty` is what separates a turn from a page view. It is set only when the
   * chat actually starts working, so an open cannot write to the database at
   * all.
   */
  const liftedCount = useRef(-1);
  const dirty = useRef(false);

  useEffect(() => {
    const working = status === "submitted" || status === "streaming";
    // Set inside the effect, not during render: a ref written while rendering
    // is a lint error and, under StrictMode's double render, a lie.
    if (working) dirty.current = true;

    if (seededRef.current) {
      seededRef.current = false;
      liftedCount.current = messages.length;
      return;
    }
    // Hydration and re-renders of an untouched thread land here and stop.
    if (!dirty.current) return;
    const grew = messages.length !== liftedCount.current;
    if (!grew && working) return;
    liftedCount.current = messages.length;
    onMessagesChange(messages);
  }, [messages, status, onMessagesChange]);

  // When the user sends a message, pin THAT message to the top of the scroll
  // area (rather than auto-scrolling to the bottom) so its answer streams into
  // view right below it. A trailing spacer reserves just enough room that the
  // latest turn can reach the top even before the reply has arrived; it
  // collapses once the reply fills the viewport.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    const spacer = bottomSpacerRef.current;
    if (!scroller || !content || !spacer) return;

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) {
      spacer.style.height = "0px";
      return;
    }
    const el = content.querySelector<HTMLElement>(
      `[data-mid="${lastUser.id}"]`
    );
    if (!el) return;

    const scrollerTop = scroller.getBoundingClientRect().top;
    const elTop = el.getBoundingClientRect().top;
    const contentBottom = content.getBoundingClientRect().bottom;
    const turnHeight = contentBottom - elTop;
    spacer.style.height = `${Math.max(
      0,
      scroller.clientHeight - turnHeight - 24
    )}px`;

    if (pinnedUserIdRef.current !== lastUser.id) {
      pinnedUserIdRef.current = lastUser.id;
      scroller.scrollTop += elTop - scrollerTop - 24;
    }
  }, [messages, status]);

  // Grow the input with its content, and swap the shell from pill to rounded
  // rectangle once the text wraps past one line (or attachments are staged).
  useComposerShape({
    textareaRef,
    shellRef: composerShellRef,
    value: input,
    maxHeight: 240,
    forceExpanded: attachments.length > 0,
  });

  const kbAttachedIds = new Set(
    attachments.filter((a) => a.kind === "kb").map((a) => a.refId)
  );

  function addKbFiles(files: KBFile[]) {
    setAttachments((prev) => {
      const have = new Set(
        prev.filter((a) => a.kind === "kb").map((a) => a.refId)
      );
      const next = files
        .filter((f) => !have.has(f.id))
        .map((f) => ({
          kind: "kb" as const,
          key: `kb-${f.id}`,
          refId: f.id,
          name: f.name,
        }));
      return [...prev, ...next];
    });
  }

  function addDiskFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const next = Array.from(list).map((file) => ({
      kind: "disk" as const,
      key: `disk-${diskIdRef.current++}`,
      file,
    }));
    setAttachments((prev) => [...prev, ...next]);
  }

  function removeAttachment(key: string) {
    setAttachments((prev) => prev.filter((a) => a.key !== key));
  }

  /**
   * A message the user sent while Orion was still working, held until the run it
   * cut off has finished unwinding.
   *
   * It cannot be sent straight after `stop()`: the aborted request tears itself
   * down asynchronously, and its teardown sets the chat back to "ready" and clears
   * the SDK's active response — so a send issued in between would have its status
   * and its stream state pulled out from under it. Waiting for the status to settle
   * costs a few milliseconds and makes the hand-off deterministic.
   */
  const pendingSendRef = useRef<{
    text: string;
    files?: { type: "file"; mediaType: string; filename: string; url: string }[];
  } | null>(null);

  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    const queued = pendingSendRef.current;
    if (!queued) return;
    pendingSendRef.current = null;
    void sendMessage(queued);
  }, [status, sendMessage]);

  async function handleSend() {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    const disk = attachments.filter(
      (a): a is Extract<Attachment, { kind: "disk" }> => a.kind === "disk"
    );
    const kb = attachments.filter(
      (a): a is Extract<Attachment, { kind: "kb" }> => a.kind === "kb"
    );

    const fileParts = await Promise.all(
      disk.map(async (d) => ({
        type: "file" as const,
        mediaType: d.file.type || "application/octet-stream",
        filename: d.file.name,
        url: await fileToDataUrl(d.file),
      }))
    );

    let finalText = text;
    if (kb.length > 0) {
      const list = kb.map((k) => k.name).join(", ");
      finalText = `${text}\n\n[Attached from knowledge base: ${list}]`.trim();
    }

    const payload = {
      text: finalText,
      files: fileParts.length > 0 ? fileParts : undefined,
    };
    // Orion is not in charge; the user is. Sending mid-stream cuts the current
    // reply off rather than queueing behind it or being refused.
    if (isBusy) {
      pendingSendRef.current = payload;
      void stop();
    } else {
      void sendMessage(payload);
    }
    setInput("");
    setAttachments([]);
  }

  const hasDraft = input.trim().length > 0 || attachments.length > 0;
  const canSend = hasDraft;
  // Mid-stream with nothing typed, the circle stops Orion instead of sending —
  // the standard affordance, and the only way to call off a run you don't want to
  // replace with a new question.
  const sendControl =
    isBusy && !hasDraft ? (
      <SendButton
        onClick={() => void stop()}
        disabled={false}
        label="Stop generating"
      >
        <SquareIcon className="size-4 fill-current" />
      </SendButton>
    ) : quickAction && !hasDraft && !isBusy ? (
      <Button
        type="button"
        onClick={() => void sendMessage({ text: quickAction.text })}
        className="h-10 shrink-0 rounded-full px-4"
      >
        {quickAction.label}
      </Button>
    ) : (
      <SendButton onClick={handleSend} disabled={!canSend} />
    );
  const attachButtons = noAttachments ? null : (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Attach from knowledge base"
        onClick={() => setKbOpen(true)}
      >
        <PlusIcon />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Upload from disk"
        onClick={() => diskInputRef.current?.click()}
      >
        <PaperclipIcon />
      </Button>
    </>
  );

  // Home-style composer used on the new-chat (empty) screen: a centered box
  // with the controls in a row beneath the textarea — the Orion landing IS
  // the former home view now that `/` redirects here.
  const landingComposer = (
    <div
      ref={composerShellRef}
      className={COMPOSER_SHELL_RING}
    >
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span
              key={a.key}
              className="ty-caption flex items-center gap-1 rounded-md bg-background-subtle py-1 pl-2 pr-1 text-primary-text"
            >
              {a.kind === "kb" ? (
                <FileTextIcon className="size-3.5 text-tertiary-text" />
              ) : (
                <PaperclipIcon className="size-3.5 text-tertiary-text" />
              )}
              <span className="max-w-[180px] truncate">
                {a.kind === "kb" ? a.name : a.file.name}
              </span>
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => removeAttachment(a.key)}
                className="rounded p-0.5 text-tertiary-text hover:bg-background-hover hover:text-primary-text"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={COMPOSER_ROW}>
        <textarea
          ref={textareaRef}
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={1}
          placeholder="How can I help you today?"
          className={COMPOSER_TEXTAREA}
        />
        <div className="flex items-center gap-0.5">
          {attachButtons}
          {sendControl}
        </div>
      </div>

      <input
        ref={diskInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          addDiskFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );

  // New chat: mirror the home page — a time-of-day greeting floating above a
  // centered composer over a fading dot field. Once a message exists, the chat
  // thread + floating composer below take over.
  if (!hasMessages) {
    return (
      <div className="relative flex h-full min-h-0 flex-1 flex-col bg-background-surface">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          {/* Decorative dot field, densest around the composer and fading out. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 [background-image:radial-gradient(circle,_color-mix(in_oklch,_var(--foreground)_24%,_transparent)_1.25px,_transparent_1.75px)] [background-size:18px_18px] [mask-image:radial-gradient(ellipse_58%_48%_at_50%_50%,_black,_transparent_78%)]"
          />
          {/* Composer is vertically centered; the greeting floats above it.
              Both fly in on mount — the greeting drops from above, the composer
              rises from below, lightly staggered. */}
          <div className="relative flex w-full max-w-2xl flex-col items-center px-4">
            <motion.h1
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="absolute bottom-full mb-6 w-full text-center font-heading text-4xl font-medium tracking-tight"
            >
              {greeting ?? "Welcome"}, {firstName}
            </motion.h1>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: "easeOut", delay: 0.08 }}
              className="w-full"
            >
              {landingComposer}
            </motion.div>
          </div>
        </div>

        <AddFileDialog
          open={kbOpen}
          onOpenChange={setKbOpen}
          existingIds={kbAttachedIds}
          onAdd={addKbFiles}
        />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-background-surface">
      {/* Full-height scroll area — history scrolls underneath the floating
          composer, including into the small padding gap below it. */}
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-28"
      >
        <div className="mx-auto w-full max-w-3xl">
          <div
            ref={contentRef}
            className="relative flex flex-col gap-6"
          >
          {messages.map((m, i) =>
            // Empty assistant turns (tool calls, no text yet) render nothing —
            // see hasVisibleContent. Mapped to null rather than filtered so `i`
            // still indexes `messages` for the streaming check below.
            !hasVisibleContent(m) ? null : (
            <div key={m.id} data-mid={m.id} className="flex flex-col gap-2">
              <MessageBubble
                role={m.role}
                message={m}
                at={messageTimeOf(m)}
                streaming={
                  i === messages.length - 1 &&
                  m.role === "assistant" &&
                  status === "streaming"
                }
                speech={
                  m.role === "assistant" && hasText(m)
                    ? {
                        state:
                          speech.activeId === m.id ? speech.state : "idle",
                        onToggle: (text) => speech.toggle(m.id, text),
                      }
                    : undefined
                }
              />
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
            )
          )}

          {/* Thinking → answer is a true crossfade, and getting there is all
              about LAYOUT, not easing.
              `mode="popLayout"` takes the exiting indicator out of flow the
              instant it starts leaving, so the answer immediately occupies the
              indicator's slot and the indicator fades out on top of it. Without
              it, AnimatePresence keeps the exiting node in flow for its whole
              duration — the answer renders ~72px too low (indicator + gap-6),
              then snaps up when the exit ends, which is the jerk.
              Opacity only: any y-translate here reads as a second, competing
              motion on top of the reflow. */}
          <AnimatePresence initial={false} mode="popLayout">
            {showThinking && (
              <motion.div
                key="thinking"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: "linear" }}
              >
                <ThinkingIndicator activities={activeTools} />
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <div
              className="text-[15px] rounded-lg bg-error/10 px-3 py-2 text-error"
            >
              {errorText(error)}
            </div>
          )}
          </div>
          <div ref={bottomSpacerRef} aria-hidden />
        </div>
      </div>

      {/* Composer floats at the bottom; pb leaves a small gap below it through
          which the scrolling history stays visible. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-4"
      >
        <div
          ref={composerShellRef}
          className={`pointer-events-auto mx-auto max-w-3xl ${COMPOSER_SHELL_RING}`}
        >
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <span
                  key={a.key}
                  className="ty-caption flex items-center gap-1 rounded-md bg-background-subtle py-1 pl-2 pr-1 text-primary-text"
                >
                  {a.kind === "kb" ? (
                    <FileTextIcon className="size-3.5 text-tertiary-text" />
                  ) : (
                    <PaperclipIcon className="size-3.5 text-tertiary-text" />
                  )}
                  <span className="max-w-[180px] truncate">
                    {a.kind === "kb" ? a.name : a.file.name}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove attachment"
                    onClick={() => removeAttachment(a.key)}
                    className="rounded p-0.5 text-tertiary-text hover:bg-background-hover hover:text-primary-text"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className={COMPOSER_ROW}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={1}
              placeholder="Ask Orion…"
              className={COMPOSER_TEXTAREA}
            />
            <div className="flex items-center gap-0.5">
              {attachButtons}
              {sendControl}
            </div>
          </div>

          <input
            ref={diskInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addDiskFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <AddFileDialog
        open={kbOpen}
        onOpenChange={setKbOpen}
        existingIds={kbAttachedIds}
        onAdd={addKbFiles}
      />
    </div>
  );
}

interface SpeechControl {
  state: SpeechState;
  onToggle: (text: string) => void;
}

// Markdown body styling shared with the /home chat: larger type, relaxed
// leading, visible list markers, and clear spacing between blocks so a
// multi-paragraph answer reads as distinct sections.
const CHAT_BODY_CLASS =
  "text-[15px] leading-relaxed [&>*+*]:mt-4 " +
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 " +
  "[&_h1]:mt-5 [&_h1]:text-[1.05rem] [&_h1]:font-semibold " +
  "[&_h2]:mt-5 [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold " +
  // Tables: stretch to the full content width and give cells real padding so
  // columns breathe instead of jamming together.
  "[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[0.925em] " +
  "[&_th]:border [&_th]:border-border [&_th]:bg-background-subtle [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold " +
  "[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top";

/**
 * Streaming text with a smooth, frame-paced reveal that still renders markdown
 * live. The received text is buffered; a requestAnimationFrame loop advances the
 * revealed prefix at an even cadence so the display trails arrival by a small
 * margin. Because tokens arrive in bursts but are drained at a steady rate, the
 * text glides in continuously instead of stuttering — no per-character
 * animation, no blur. It speeds up when the buffer is deep so it never lags more
 * than ~0.7s behind. The revealed prefix feeds the same markdown renderer as a
 * finished message, so formatting appears as it streams and the hand-off at
 * completion is seamless.
 */
function GlideText({ text }: { text: string }) {
  const targetRef = useRef("");
  const shownRef = useRef(0);
  const [revealed, setRevealed] = useState("");

  useEffect(() => {
    targetRef.current = text;
  }, [text]);

  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    const tick = (ts: number) => {
      const target = targetRef.current;
      if (target.length > shownRef.current) {
        const backlog = target.length - shownRef.current;
        const dt = last == null ? 0 : (ts - last) / 1000;
        const charsPerSecond = Math.max(55, backlog / 0.7);
        const step = Math.max(1, Math.round(charsPerSecond * dt));
        shownRef.current = Math.min(target.length, shownRef.current + step);
        setRevealed(target.slice(0, shownRef.current));
      }
      last = ts;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={CHAT_BODY_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{revealed}</ReactMarkdown>
    </div>
  );
}

function MessageBubble({
  role,
  message,
  speech,
  streaming = false,
  at,
}: {
  role: string;
  message: UIMessage;
  speech?: SpeechControl;
  /** True only for the assistant message currently being generated. */
  streaming?: boolean;
  /** When this message was written. See `useMessageTimes`. */
  at?: number;
}) {
  const isUser = role === "user";
  const { text, attachments } = splitAttachments(message);
  // Assistant turns render as ordered blocks (text ⇄ chart). `text` stays the
  // flattened form, which is what copy + read-aloud want.
  const blocks = isUser ? [] : messageBlocks(message);

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5",
        isUser ? "items-end" : "items-start"
      )}
    >
      {attachments.length > 0 && (
        <div
          className={cn(
            "flex max-w-[85%] flex-wrap gap-1.5",
            isUser && "justify-end"
          )}
        >
          {attachments.map((a, i) => (
            <span
              key={i}
              className="ty-caption flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-primary-text"
            >
              {a.kind === "kb" ? (
                <FileTextIcon className="size-3.5 text-tertiary-text" />
              ) : (
                <PaperclipIcon className="size-3.5 text-tertiary-text" />
              )}
              <span className="max-w-[180px] truncate">{a.name}</span>
            </span>
          ))}
        </div>
      )}
      {isUser
        ? text && (
            // User: a gray bubble (the treatment AI messages used to have).
            <div className="max-w-[85%] rounded-2xl bg-background-subtle px-3.5 py-2 text-primary-text">
              <div className={CHAT_BODY_CLASS}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
              </div>
            </div>
          )
        : // AI: text and charts INTERLEAVED in the order Orion produced them, so
          // a chart stays anchored to the paragraph it followed instead of being
          // pushed down the page by whatever streams in after it. Plain text, no
          // bubble, full container width; only the trailing block glides, since
          // that's the one still arriving.
          blocks.map((block, i) =>
            block.kind === "chart" ? (
              // A chart lands mid-answer, with text already above it, so a small
              // rise reads as "settling in" rather than fighting a reflow.
              <motion.div
                key={`chart-${i}`}
                className="w-full"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.26, ease: "easeOut" }}
              >
                <OrionChart spec={block.spec} surface="page" />
              </motion.div>
            ) : (
              // Fades in as it mounts — the other half of the crossfade with the
              // thinking indicator. Opacity only and slightly slower than the
              // indicator's fade, so the handoff is one continuous change rather
              // than two. Mount-only, so streaming tokens don't re-trigger it.
              <motion.div
                key={`text-${i}`}
                className="w-full text-primary-text"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.24, ease: "linear" }}
              >
                {streaming && i === blocks.length - 1 ? (
                  <GlideText text={block.text} />
                ) : (
                  <div className={CHAT_BODY_CLASS}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {block.text}
                    </ReactMarkdown>
                  </div>
                )}
              </motion.div>
            )
          )}
      {/*
        Under every message, both sides, and ABOVE the actions — the time
        belongs to the message, the copy and read-aloud buttons belong to the
        reader, so the stamp sits against the text it dates and the controls
        close the block. Hidden while an answer streams: it has no settled time
        yet.
      */}
      {at !== undefined && !streaming && (
        <time
          dateTime={new Date(at).toISOString()}
          className="px-0.5 text-[11px] tabular-nums text-muted-foreground/60"
        >
          {messageTime(at)}
        </time>
      )}
      {!isUser && text && (
        <div className="flex items-center gap-0.5">
          <CopyButton text={stripMarkdown(text)} />
          {speech && (
            <ReadAloudButton
              state={speech.state}
              onToggle={() => speech.onToggle(stripMarkdown(text))}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Copy an assistant response to the clipboard, with a brief confirmation. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error("Copy failed", error);
    }
  }

  const label = copied ? "Copied" : "Copy";
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-tertiary-text transition-colors hover:bg-background-hover hover:text-primary-text"
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-data-accent" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

/** Small play/stop control under an assistant message. */
function ReadAloudButton({
  state,
  onToggle,
}: {
  state: SpeechState;
  onToggle: () => void;
}) {
  const label =
    state === "playing"
      ? "Stop"
      : state === "loading"
        ? "Loading audio…"
        : "Read aloud";

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-tertiary-text transition-colors hover:bg-background-hover hover:text-primary-text"
    >
      {state === "loading" ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : state === "playing" ? (
        <SquareIcon className="size-3.5 fill-current" />
      ) : (
        <Volume2Icon className="size-3.5" />
      )}
    </button>
  );
}
