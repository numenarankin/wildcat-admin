"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveIcon,
  ForwardIcon,
  MailIcon,
  PaperclipIcon,
  ReplyAllIcon,
  ReplyIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { emailDocument, stripQuotedHtml, stripQuotedText } from "@/lib/admin/google/gmail/view";
import type { GmailAttachment, GmailMessageView, GmailThreadView } from "@/lib/admin/google/gmail/types";
import { isViewable } from "@/lib/admin/google/gmail/mime";
import { AttachmentViewer } from "@/components/admin/email/attachment-viewer";

/** Plain-text email body type. */
const MESSAGE_BODY_CLASS = "text-[15px] leading-relaxed whitespace-pre-wrap";

/** As `support-chat.tsx`: relative, so server and client render the same string. */
function relativeTime(epochMs: number): string {
  return formatDistanceToNow(new Date(epochMs), { addSuffix: true });
}

/** Gmail's header date: "Oct 8, 2026, 9:38 AM (3 hours ago)". */
function headerDate(epochMs: number): string {
  const at = new Date(epochMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${at} (${relativeTime(epochMs)})`;
}

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/**
 * An open email thread, laid out as Gmail lays one out: the subject on top,
 * then each message with its sender, recipients and date above the body.
 * Remote images load by default.
 */
export interface ThreadActions {
  /** Reply, or reply all, to one message (the newest from the top row). */
  reply: (message: GmailMessageView, all: boolean) => void;
  forward: (message: GmailMessageView) => void;
  archive: () => void;
  trash: () => void;
  toggleStar: () => void;
  markUnread: () => void;
  starred: boolean;
}

export function EmailThread({
  thread,
  embedded = false,
  actions,
}: {
  thread: GmailThreadView;
  /** Inside the read card: no subject (the card's title has it) and no scroller of its own (the card scrolls). */
  embedded?: boolean;
  actions: ThreadActions;
}) {
  const [viewing, setViewing] = useState<GmailAttachment | null>(null);
  // Newest first, as the list is.
  const messages = [...thread.messages].reverse();
  const newest = messages[0];
  const column = (
    <div className={cn("mx-auto flex w-full flex-col", !embedded && "max-w-4xl")}>
      {!embedded && <h1 className="pb-3 font-heading text-2xl font-medium tracking-tight">{thread.subject}</h1>}
      {/* Reply and forward act on the newest message; the rest on the thread. */}
      <div className="flex flex-wrap items-center gap-1 pb-3">
        <Button variant="outline" size="sm" onClick={() => newest && actions.reply(newest, false)} disabled={!newest}>
          <ReplyIcon />
          Reply
        </Button>
        <Button variant="outline" size="sm" onClick={() => newest && actions.reply(newest, true)} disabled={!newest}>
          <ReplyAllIcon />
          Reply all
        </Button>
        <Button variant="outline" size="sm" onClick={() => newest && actions.forward(newest)} disabled={!newest}>
          <ForwardIcon />
          Forward
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Button variant="ghost" size="icon-sm" aria-label="Archive" title="Archive" onClick={actions.archive}>
          <ArchiveIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Delete" title="Delete" onClick={actions.trash}>
          <Trash2Icon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={actions.starred ? "Unstar" : "Star"}
          title={actions.starred ? "Unstar" : "Star"}
          aria-pressed={actions.starred}
          onClick={actions.toggleStar}
        >
          <StarIcon className={cn(actions.starred && "fill-amber-400 text-amber-400")} />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Mark as unread" title="Mark as unread" onClick={actions.markUnread}>
          <MailIcon />
        </Button>
      </div>
      {messages.map((m) => (
        <EmailMessage key={m.id} message={m} onView={setViewing} onReply={(all) => actions.reply(m, all)} onForward={() => actions.forward(m)} />
      ))}
    </div>
  );
  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col bg-background-surface", !embedded && "h-full")}>
      {embedded ? (
        <div className="px-5 pt-1 pb-5">{column}</div>
      ) : (
        <div className="quiet-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-6">{column}</div>
      )}
      <AttachmentViewer
        attachment={viewing}
        href={viewing ? attachmentHref(viewing) : ""}
        onClose={() => setViewing(null)}
      />
    </div>
  );
}

function attachmentHref(a: GmailAttachment): string {
  return `/api/admin/google/gmail/attachment?m=${encodeURIComponent(a.messageId)}&p=${encodeURIComponent(a.partId)}`;
}

const CHIP =
  "ty-caption flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-primary-text hover:bg-background-subtle";

function EmailMessage({
  message,
  onView,
  onReply,
  onForward,
}: {
  message: GmailMessageView;
  onView: (a: GmailAttachment) => void;
  onReply: (all: boolean) => void;
  onForward: () => void;
}) {
  const name = message.mine ? "Me" : message.fromName;
  // A reply's quoted history is folded away: the thread shows those messages.
  const [showQuoted, setShowQuoted] = useState(false);
  const stripped = useMemo(
    () => (message.html !== null ? stripQuotedHtml(message.html) : message.text !== null ? stripQuotedText(message.text) : null),
    [message.html, message.text]
  );
  const html = message.html !== null ? (showQuoted ? message.html : (stripped ?? message.html)) : null;
  const text = message.text !== null ? (showQuoted ? message.text : (stripped ?? message.text)) : null;

  return (
    <article className="flex min-w-0 flex-col gap-3 border-t py-4 first-of-type:border-t-0 first-of-type:pt-1">
      <header className="flex min-w-0 items-center gap-3">
        <Avatar className="size-8 shrink-0">
          <AvatarFallback className="text-xs">{initials(message.fromName || message.fromEmail)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-sm font-semibold">{name}</span>
            {message.fromEmail && (
              <span className="truncate text-xs text-muted-foreground">&lt;{message.fromEmail}&gt;</span>
            )}
          </div>
          {message.to && <span className="truncate text-xs text-muted-foreground">to {message.to}</span>}
        </div>
        <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(message.date).toISOString()}>
          {headerDate(message.date)}
        </time>
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="icon-sm" aria-label="Reply" title="Reply" onClick={() => onReply(false)}>
            <ReplyIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Forward" title="Forward" onClick={onForward}>
            <ForwardIcon />
          </Button>
        </div>
      </header>

      <div className="min-w-0">
        {html !== null ? <EmailFrame html={html} /> : text && <div className={MESSAGE_BODY_CLASS}>{text}</div>}
        {stripped !== null && (
          <button
            type="button"
            onClick={() => setShowQuoted((v) => !v)}
            aria-label={showQuoted ? "Hide quoted text" : "Show quoted text"}
            title={showQuoted ? "Hide quoted text" : "Show quoted text"}
            className="mt-2 inline-flex h-4 items-center rounded-full bg-muted px-2 text-[10px] leading-none tracking-widest text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            •••
          </button>
        )}
      </div>

      {message.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.attachments.map((a) => {
            const label = (
              <>
                <PaperclipIcon className="size-3.5 text-tertiary-text" />
                <span className="max-w-[180px] truncate">{a.filename}</span>
              </>
            );
            // Viewable types open in place; the rest download.
            return isViewable(a.mimeType) ? (
              <button key={a.partId} type="button" onClick={() => onView(a)} className={CHIP}>
                {label}
              </button>
            ) : (
              <a key={a.partId} href={attachmentHref(a)} className={CHIP}>
                {label}
              </a>
            );
          })}
        </div>
      )}
    </article>
  );
}

/**
 * An HTML email in a frame with scripts, forms and navigation of the page
 * disabled (`sandbox` without `allow-scripts`). `allow-same-origin` is there
 * only so this component can read the frame's height; with no scripts in the
 * frame it grants the email nothing. The frame's own CSP allows images, styles
 * and fonts from the network and blocks everything else.
 */
function EmailFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const srcDoc = useMemo(() => emailDocument(html, true), [html]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      const size = () => Math.max(24, doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      setHeight(size());
      observer?.disconnect();
      observer = new ResizeObserver(() => setHeight(size()));
      observer.observe(doc.documentElement);
      if (doc.body) observer.observe(doc.body);
    };
    frame.addEventListener("load", measure);
    measure();
    return () => {
      frame.removeEventListener("load", measure);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      title="Email"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      scrolling="no"
      style={{ height, overflow: "hidden" }}
      className="block w-full border-0 bg-white"
    />
  );
}
