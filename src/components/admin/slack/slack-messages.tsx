"use client";

import { useRef, useState } from "react";
import { CheckIcon, PaperclipIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useComposerShape } from "@/components/ai/use-composer-shape";
import { COMPOSER_ROW, COMPOSER_SHELL, COMPOSER_TEXTAREA, SendButton } from "@/components/ai/composer";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import { initialsOf, slackTextParts, type SlackMessage, type SlackPerson } from "@/lib/admin/slack/map";

/**
 * The Slack transcript and composer: `MessageThread`'s rows, class for class
 * (`components/messages/message-thread.tsx`). Mine is a right-aligned blue
 * bubble; everyone else's is avatar, name and an outlined bubble; a run from
 * one sender inside five minutes groups; a clock closes each run; day dividers
 * break the days. Slack-only: its markup (mentions, channels, links) and a
 * thread's "N replies" under its parent.
 */

const MESSAGE_BODY_CLASS = "text-[15px] leading-relaxed whitespace-pre-wrap break-words";
const GROUP_WINDOW_MS = 5 * 60_000;

const clockFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: ADMIN_TIME_ZONE });
const dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: ADMIN_TIME_ZONE });
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ADMIN_TIME_ZONE });
const dayKey = (ms: number) => dayKeyFormat.format(new Date(ms));

function dayLabel(ms: number, now: number): string {
  const key = dayKey(ms);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - 86_400_000)) return "Yesterday";
  return dayFormat.format(new Date(ms));
}

export interface SlackPeople {
  byId: Map<string, SlackPerson>;
  /** The connected admin's Slack id: their messages are "mine". */
  selfId: string;
}

/** Who sent it: a person, else the bot's name. Same key groups a run. */
const senderKey = (m: SlackMessage) => m.userId ?? `bot:${m.botName ?? ""}`;

function sender(m: SlackMessage, people: SlackPeople): { name: string; avatarUrl: string | null; initials: string } {
  const p = m.userId ? people.byId.get(m.userId) : undefined;
  if (p) return p;
  const name = m.botName ?? (m.userId ? "Unknown" : "Integration");
  return { name, avatarUrl: null, initials: initialsOf(name) };
}

export function SlackMessageList({
  messages,
  people,
  now,
  onOpenThread,
}: {
  messages: SlackMessage[];
  people: SlackPeople;
  /** The clock "Today" and "Yesterday" are read against. */
  now: number;
  /** Omitted inside a thread, where replies are not threads of their own. */
  onOpenThread?: (ts: string) => void;
}) {
  return (
    <div className="flex w-full flex-col">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || dayKey(prev.at) !== dayKey(m.at);
        const grouped = !newDay && prev !== undefined && senderKey(prev) === senderKey(m) && m.at - prev.at < GROUP_WINDOW_MS;
        const next = messages[i + 1];
        const showTime = !next || next.at - m.at >= GROUP_WINDOW_MS || senderKey(next) !== senderKey(m);
        return (
          <div key={m.ts} className={cn("flex flex-col", newDay ? "gap-4" : grouped ? "mt-1" : "mt-4")}>
            {newDay && <DayDivider label={dayLabel(m.at, now)} />}
            <SlackMessageRow
              message={m}
              people={people}
              grouped={grouped}
              showTime={showTime}
              onOpenThread={onOpenThread}
            />
          </div>
        );
      })}
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function SlackMessageRow({
  message,
  people,
  grouped,
  showTime,
  onOpenThread,
}: {
  message: SlackMessage;
  people: SlackPeople;
  grouped: boolean;
  showTime: boolean;
  onOpenThread?: (ts: string) => void;
}) {
  const isMine = message.userId === people.selfId;
  const who = sender(message, people);
  const isParent = message.replyCount > 0 && message.threadTs === message.ts;

  const files = message.files.length > 0 && (
    <div className={cn("flex flex-wrap gap-1.5", isMine && "justify-end")}>
      {message.files.map((f, i) => (
        <a
          key={`${f.name}-${i}`}
          href={f.url ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="ty-caption flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-primary-text hover:bg-background-subtle"
        >
          <PaperclipIcon className="size-3.5 text-tertiary-text" />
          <span className="max-w-[180px] truncate">{f.name}</span>
        </a>
      ))}
    </div>
  );

  const replies =
    isParent && onOpenThread ? (
      <button
        type="button"
        onClick={() => onOpenThread(message.ts)}
        className={cn("ty-caption px-1 font-medium text-data-accent hover:underline", isMine && "self-end")}
      >
        {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
      </button>
    ) : null;

  if (isMine) {
    return (
      <div className="flex min-w-0 flex-col items-end gap-1.5">
        {files}
        {message.text && (
          <div className={cn(MESSAGE_BODY_CLASS, "max-w-[min(85%,42rem)] rounded-2xl px-3.5 py-2", "bg-data-accent text-white")}>
            <SlackText text={message.text} people={people} onAccent />
          </div>
        )}
        {replies}
        {showTime && (
          <span className="ty-caption flex items-center gap-1 px-1 text-tertiary-text">
            <CheckIcon className="size-3" />
            {clockFormat.format(new Date(message.at))}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 gap-3">
      {grouped ? (
        <span className="w-10 shrink-0" aria-hidden />
      ) : (
        <Avatar size="lg" className="mt-0.5 size-10">
          {who.avatarUrl && <AvatarImage src={who.avatarUrl} alt={who.name} />}
          <AvatarFallback className="text-sm">{who.initials}</AvatarFallback>
        </Avatar>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {!grouped && <span className="text-sm font-medium">{who.name}</span>}
        {message.text && (
          <div
            className={cn(
              MESSAGE_BODY_CLASS,
              "w-fit max-w-[min(85%,42rem)] rounded-2xl border border-border bg-background px-3.5 py-2 text-primary-text"
            )}
          >
            <SlackText text={message.text} people={people} onAccent={false} />
          </div>
        )}
        {files}
        {replies}
        {showTime && <span className="ty-caption px-1 text-tertiary-text">{clockFormat.format(new Date(message.at))}</span>}
      </div>
    </div>
  );
}

/** Slack's markup drawn: people and broadcasts tinted like Messages' mentions, links live. */
function SlackText({ text, people, onAccent }: { text: string; people: SlackPeople; onAccent: boolean }) {
  const tint = cn("rounded px-1 font-medium", onAccent ? "bg-white/20" : "bg-data-accent/10 text-data-accent");
  return (
    <>
      {slackTextParts(text).map((p, i) => {
        if (p.kind === "text") return <span key={i}>{p.text}</span>;
        if (p.kind === "user")
          return (
            <span key={i} className={tint}>
              @{p.label ?? people.byId.get(p.id)?.name ?? "unknown"}
            </span>
          );
        if (p.kind === "channel")
          return (
            <span key={i} className={tint}>
              #{p.label ?? "channel"}
            </span>
          );
        if (p.kind === "broadcast")
          return (
            <span key={i} className={tint}>
              {p.label}
            </span>
          );
        return (
          <a key={i} href={p.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            {p.label}
          </a>
        );
      })}
    </>
  );
}

/** Messages' composer pill, text only. Enter sends, Shift+Enter breaks the line. */
export function SlackComposer({
  placeholder,
  onSend,
}: {
  placeholder: string;
  /** Resolves true when sent; false gives the draft back. */
  onSend: (text: string) => Promise<boolean>;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  useComposerShape({ textareaRef, shellRef, value: input, maxHeight: 240 });

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    const ok = await onSend(text);
    // Give the draft back rather than losing what they typed.
    if (!ok) setInput(text);
    setSending(false);
  }

  const canSend = input.trim().length > 0 && !sending;

  return (
    <div ref={shellRef} className={`pointer-events-auto mx-auto max-w-3xl shadow-sm ${COMPOSER_SHELL}`}>
      <div className={COMPOSER_ROW}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className={COMPOSER_TEXTAREA}
        />
        <SendButton
          onClick={() => void send()}
          disabled={!canSend}
          className={cn(
            canSend ? "bg-data-accent text-white hover:bg-data-accent/90" : "bg-muted text-tertiary-text disabled:opacity-100"
          )}
        />
      </div>
    </div>
  );
}
