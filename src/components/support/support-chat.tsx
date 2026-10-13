"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { CheckIcon, PaperclipIcon, XIcon } from "lucide-react";
import { motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { useComposerShape } from "@/components/ai/use-composer-shape";
import {
  COMPOSER_SHELL,
  COMPOSER_ROW,
  COMPOSER_TEXTAREA,
  SendButton,
} from "@/components/ai/composer";
import {
  sendSupportMessage,
  uploadSupportAttachments,
  markSupportThreadRead,
} from "@/lib/support/actions";
import type {
  SupportAttachment,
  SupportMessage,
  SupportSenderRole,
  SupportStatus,
  SupportThread,
} from "@/lib/support/types";

/**
 * How a send, an upload and a read stamp reach the server. The user side
 * uses the RLS actions; the staff desk (/admin/support) supplies its
 * service-role equivalents, so one chat surface serves both sides.
 */
export interface SupportChatActions {
  send: (threadId: string, body: string, fileIds: string[]) => Promise<{ id: string; createdAt: number }>;
  upload: (threadId: string, formData: FormData) => Promise<SupportAttachment[]>;
  markRead: (threadId: string) => Promise<void>;
}

const USER_ACTIONS: SupportChatActions = {
  send: sendSupportMessage,
  upload: (_threadId, formData) => uploadSupportAttachments(formData),
  markRead: markSupportThreadRead,
};

/**
 * Message body type, matching Orion's `CHAT_BODY_CLASS`. Support messages are
 * plain text rather than markdown (nobody writes tables into a support ticket,
 * and rendering staff replies as markdown would be a behavior change, not a
 * styling one), so this is only the type treatment, plus the wrapping a
 * hand-typed message needs.
 */
const MESSAGE_BODY_CLASS = "text-[15px] leading-relaxed whitespace-pre-wrap";

/**
 * How long ago a message landed, as `comments-thread` renders comment times.
 *
 * Relative rather than a clock time on purpose. A wall clock has to be
 * formatted in SOME timezone, and this component server-renders: the server is
 * UTC and the operators are Central, so "2:14 PM" would render one value on the
 * server and another on hydration, which is a mismatch on every message. A
 * relative distance is the same string on both sides. It also happens to be the
 * more useful reading here, where a thread can sit for days and "2:14 PM" with
 * no date says nothing.
 */
function relativeTime(epochMs: number): string {
  return formatDistanceToNow(new Date(epochMs), { addSuffix: true });
}

/**
 * Whether the thread is waiting on Wildcat, and so should show the
 * acknowledgement note.
 *
 * True when the last word in the thread is the user's and the thread is still
 * open. Each clause earns its place:
 *
 *   - Empty thread: nothing has been asked, so nothing is owed. The empty state
 *     already says what this page is for.
 *   - Last message is staff: they HAVE responded. Promising a response under a
 *     response reads as though the reply did not count.
 *   - Closed: no one is coming. Promising a response on a closed thread is the
 *     one case here that would be an outright false statement to the user.
 */
export function isAwaitingReply(
  messages: SupportMessage[],
  status: SupportStatus
): boolean {
  if (status === "closed") return false;
  return messages[messages.length - 1]?.senderRole === "user";
}

/**
 * Fold one message into the list: append it, or merge it onto the row already
 * carrying that id.
 *
 * A message the user sends arrives by BOTH paths and there is no ordering to
 * rely on. The row is inserted server-side, so the realtime broadcast can land
 * before `sendSupportMessage` has even returned to the component. Guarding with
 * a "seen ids" ref lost that race — the id was recorded only once the action
 * resolved, by which point realtime had already appended — and the message
 * rendered twice, which is what React's duplicate-key warning was reporting.
 *
 * Deduping against the list itself makes arrival order irrelevant: the check
 * reads the very list the row is about to join.
 *
 * Attachments merge rather than overwrite, because the two paths do not carry
 * the same thing. The realtime payload is the raw `support_messages` row and
 * has none; the send response has the uploaded ones. Whichever lands second
 * must not blank what the first brought.
 */
export function mergeMessage(
  prev: SupportMessage[],
  incoming: SupportMessage
): SupportMessage[] {
  const at = prev.findIndex((m) => m.id === incoming.id);
  if (at === -1) return [...prev, incoming];
  const next = [...prev];
  next[at] = {
    ...prev[at],
    ...incoming,
    attachments:
      incoming.attachments.length > 0
        ? incoming.attachments
        : prev[at].attachments,
  };
  return next;
}

interface SupportChatProps {
  thread: SupportThread;
  /** Lift the live message list back to the workspace (ordering / preview). */
  onMessagesChange: (messages: SupportMessage[]) => void;
  /**
   * Signed-in user's first name, for the empty state's "How can we help" line.
   * Fixed copy rather than Orion's time-of-day greeting: this page is a request
   * form, and asking the question is more useful than saying good morning.
   */
  firstName: string;
  /**
   * Which side of the conversation is typing. Decides which bubbles are
   * "mine" (right, grey, "Delivered") and which are the other party's.
   */
  side?: SupportSenderRole;
  actions?: SupportChatActions;
  placeholder?: string;
}

interface RealtimeRow {
  id: string;
  thread_id: string;
  sender_role: SupportMessage["senderRole"];
  body: string;
  created_at: string;
}

/**
 * The user's side of a support conversation, styled as the Orion chat page: an
 * empty state that is a heading over a centered composer, and once there is a
 * message, a max-w-3xl thread under a floating pill composer.
 * Sends go through the `sendSupportMessage` action; staff replies arrive live
 * via a Supabase realtime subscription on the thread.
 *
 * The composer primitives are imported from `@/components/ai/composer` rather
 * than restated, so the pill here cannot drift from Orion's.
 */
export function SupportChat({
  thread,
  onMessagesChange,
  firstName,
  side = "user",
  actions = USER_ACTIONS,
  placeholder = "Message support…",
}: SupportChatProps) {
  const [messages, setMessages] = useState<SupportMessage[]>(thread.messages);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The composer shell whose corners round in and out. Only one of the two
  // composers below is mounted at a time (landing vs in-thread), as in Orion.
  const composerShellRef = useRef<HTMLDivElement>(null);
  const diskInputRef = useRef<HTMLInputElement>(null);

  /** Add a message, or fold it into the one already there. See {@link mergeMessage}. */
  const upsertMessage = useCallback((incoming: SupportMessage) => {
    setMessages((prev) => mergeMessage(prev, incoming));
  }, []);

  // Keep the latest lift callback without retriggering the sync effect.
  const changeRef = useRef(onMessagesChange);
  changeRef.current = onMessagesChange;
  const seeded = useRef(true);
  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    changeRef.current(messages);
  }, [messages]);

  // Clear the unread dot for this thread when it's opened.
  useEffect(() => {
    actions.markRead(thread.id).catch((error) =>
      console.error("markSupportThreadRead failed", error)
    );
    // `actions` is a module-level constant on both sides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  // Live staff replies (and any other new rows) for this thread.
  useEffect(() => {
    let sb;
    try {
      sb = getSupabaseBrowser();
    } catch {
      return; // Supabase not configured in the browser (dev) — no realtime.
    }
    const channel = sb
      .channel(`support-thread-${thread.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "support_messages",
          filter: `thread_id=eq.${thread.id}`,
        },
        (payload) => {
          const row = payload.new as RealtimeRow;
          upsertMessage({
            id: row.id,
            threadId: row.thread_id,
            senderRole: row.sender_role,
            body: row.body,
            createdAt: new Date(row.created_at).getTime(),
            attachments: [],
          });
          if (row.sender_role !== side) {
            actions.markRead(thread.id).catch(() => {});
          }
        }
      )
      .subscribe();
    return () => {
      sb.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, side, upsertMessage]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Grow the input with its content, and swap the shell from pill to rounded
  // rectangle once the text wraps past one line (or attachments are staged).
  useComposerShape({
    textareaRef,
    shellRef: composerShellRef,
    value: input,
    maxHeight: 240,
    forceExpanded: attachments.length > 0,
  });

  function addDiskFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setAttachments((prev) => [...prev, ...Array.from(list)]);
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSend() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || sending) return;
    setSending(true);
    setInput("");
    const files = attachments;
    setAttachments([]);

    try {
      let uploaded: SupportAttachment[] = [];
      if (files.length > 0) {
        const formData = new FormData();
        for (const file of files) formData.append("files", file);
        uploaded = await actions.upload(thread.id, formData);
      }

      const result = await actions.send(
        thread.id,
        text,
        uploaded.map((a) => a.id)
      );
      upsertMessage({
        id: result.id,
        threadId: thread.id,
        senderRole: side,
        body: text,
        createdAt: result.createdAt,
        attachments: uploaded,
      });
    } catch (error) {
      console.error("sendSupportMessage failed", error);
      // Restore the draft so the user doesn't lose their message.
      setInput(text);
      setAttachments(files);
    } finally {
      setSending(false);
    }
  }

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !sending;
  const hasMessages = messages.length > 0;

  // Read off the LIVE message list rather than the thread's own `lastMessageAt`
  // so the note disappears the instant a staff reply arrives over realtime, and
  // appears the instant a send lands, without waiting for the workspace to fold
  // the change back down.
  // Staff never see it: it is the customer's acknowledgement, not theirs.
  const awaitingReply = side === "user" && isAwaitingReply(messages, thread.status);

  // The staged-attachment chips, identical in both composers below.
  const attachmentChips = attachments.length > 0 && (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map((file, i) => (
        <span
          key={`${file.name}-${i}`}
          className="ty-caption flex items-center gap-1 rounded-md bg-background-subtle py-1 pl-2 pr-1 text-primary-text"
        >
          <PaperclipIcon className="size-3.5 text-tertiary-text" />
          <span className="max-w-[180px] truncate">{file.name}</span>
          <button
            type="button"
            aria-label="Remove attachment"
            onClick={() => removeAttachment(i)}
            className="rounded p-0.5 text-tertiary-text hover:bg-background-hover hover:text-primary-text"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );

  // Orion's composer, minus the knowledge-base plus button: attaching a file
  // from disk is a support affordance, attaching one from the AI's knowledge
  // base is not. The shell ref is shared because only one composer is mounted
  // at a time (landing vs in-thread).
  const composerBody = (
    <>
      {attachmentChips}
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
          placeholder={placeholder}
          className={COMPOSER_TEXTAREA}
        />
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Attach a file"
            onClick={() => diskInputRef.current?.click()}
          >
            <PaperclipIcon />
          </Button>
          <SendButton onClick={handleSend} disabled={!canSend} />
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
    </>
  );

  // New request: Orion's landing, on a plain ground — a heading floating above
  // a centered composer, both flying in on mount. No dot field and no subtitle;
  // the question in the heading is the whole instruction.
  if (!hasMessages) {
    return (
      <div className="relative flex h-full min-h-0 flex-1 flex-col bg-background-surface">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <div className="relative flex w-full max-w-2xl flex-col items-center px-4">
            <motion.h1
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="absolute bottom-full mb-6 w-full text-center font-heading text-4xl font-medium tracking-tight"
            >
              How can we help, {firstName}?
            </motion.h1>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: "easeOut", delay: 0.08 }}
              className="w-full"
            >
              <div ref={composerShellRef} className={COMPOSER_SHELL}>
                {composerBody}
              </div>
            </motion.div>
          </div>
        </div>
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
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} mine={m.senderRole === side} />
          ))}
          {awaitingReply && <AwaitingReplyNote />}
        </div>
      </div>

      {/* Composer floats at the bottom; pb leaves a small gap below it through
          which the scrolling history stays visible. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-4">
        <div
          ref={composerShellRef}
          className={`pointer-events-auto mx-auto max-w-3xl shadow-sm ${COMPOSER_SHELL}`}
        >
          {composerBody}
        </div>
      </div>
    </div>
  );
}

/**
 * The acknowledgement shown while a thread waits on Wildcat.
 *
 * Sits in the staff column so it reads as coming from the support side, but
 * deliberately NOT as a staff message: dashed border, muted text, and no
 * Wildcat mark. A reader must never mistake an automatic line for a person
 * having answered them, which is exactly what a solid bubble with the logo
 * would imply, and would make the real reply feel like a repeat.
 *
 * It is presentation only. Nothing is written to `support_messages`, so it
 * cannot land in the staff view, the thread preview, or an email.
 */
function AwaitingReplyNote() {
  return (
    // pl-7 puts it in line with a staff bubble, past the 20px mark and the
    // 8px gap that sits to the left of one.
    <div className="flex pl-7">
      <div className="ty-body-2 max-w-[85%] rounded-2xl border border-dashed border-border px-3.5 py-2 text-tertiary-text">
        Thanks for reaching out. We have your message, and a Wildcat
        representative will respond as soon as possible.
      </div>
    </div>
  );
}

/**
 * One message, as a bubble.
 *
 * This is the deliberate departure from Orion, where only the USER gets a
 * bubble and Orion's own answer is plain text running the full width. That
 * works there because the answer is the page — it is the thing you came to
 * read. A support thread is a conversation between two people, and giving one
 * of them the page and the other a bubble would read as an authored document
 * with the reader's questions pasted into it.
 *
 * So both sides get one, distinguished by fill rather than by colour: the user
 * keeps Orion's exact grey bubble, and staff get an outlined bubble on the page
 * ground, plus the Wildcat mark. Neither uses `bg-primary` — a saturated bubble
 * is the loudest thing on a page whose whole design is quiet.
 */
function MessageBubble({ message, mine }: { message: SupportMessage; mine: boolean }) {
  // "Mine" takes the user's treatment (right, grey, "Delivered") whichever
  // side is looking; the other party's takes the outlined bubble. The Wildcat
  // mark goes beside a STAFF message only, on whichever side it lands.
  const isUser = mine;
  const fromStaff = message.senderRole === "staff";

  const attachments = message.attachments.length > 0 && (
    <div
      className={cn("flex max-w-[85%] flex-wrap gap-1.5", isUser && "justify-end")}
    >
      {message.attachments.map((a) => (
        <a
          key={a.id}
          href={a.url ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="ty-caption flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-primary-text hover:bg-background-subtle"
        >
          <PaperclipIcon className="size-3.5 text-tertiary-text" />
          <span className="max-w-[180px] truncate">{a.name}</span>
        </a>
      ))}
    </div>
  );

  const bubble = message.body && (
    <div
      className={cn(
        MESSAGE_BODY_CLASS,
        "max-w-[85%] rounded-2xl px-3.5 py-2 text-primary-text",
        isUser ? "bg-background-subtle" : "border border-border bg-background"
      )}
    >
      {message.body}
    </div>
  );

  // Both sides carry their time, on the side their bubble sits.
  //
  // The user's reads "Delivered", which is a statement of fact rather than an
  // optimistic guess: the row exists in the database by the time it renders,
  // since the send response and the realtime broadcast both come from the
  // committed insert. A staff reply gets the time alone. There is nothing to
  // acknowledge about someone else's message arriving, and "delivered" under a
  // reply would answer the wrong question: the reader can see it, what they
  // want is when it came in.
  const timestamp = (
    <span className="ty-caption flex items-center gap-1 px-1 text-tertiary-text">
      {isUser && <CheckIcon className="size-3" />}
      {isUser
        ? `Delivered ${relativeTime(message.createdAt)}`
        : relativeTime(message.createdAt)}
    </span>
  );

  // User messages sit flush right, with nothing beside them.
  if (isUser) {
    return (
      <div className="flex min-w-0 flex-col items-end gap-1.5">
        {attachments}
        {bubble}
        {timestamp}
      </div>
    );
  }

  // A staff (Wildcat) reply gets the Wildcat mark to its left, so it is clear
  // the reply came from Wildcat. On the staff desk the left side is the
  // customer, who gets no mark.
  //
  // The mark is centred on the BUBBLE, not on the whole message: it sits in the
  // bubble's own row, and the attachments and timestamp are indented past it by
  // hand (pl-7 = the 20px mark plus the 8px gap). Centring it on the column
  // instead would drift as the message grew — on a one-line reply it lands in
  // the gap under the bubble, pointing at the timestamp rather than the words.
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      {attachments && <div className="pl-7">{attachments}</div>}
      <div className="flex w-full items-center gap-2">
        {fromStaff ? (
          <Image
            src="/slim_normal.png"
            alt="Wildcat"
            width={20}
            height={20}
            className="size-5 shrink-0 object-contain dark:invert"
          />
        ) : (
          <span aria-hidden className="size-5 shrink-0" />
        )}
        {bubble}
      </div>
      <div className="pl-7">{timestamp}</div>
    </div>
  );
}
