"use client";

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { StarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GmailThreadSummary } from "@/lib/admin/google/gmail/types";

/** The day a row falls on, as its group heading: Today, Yesterday, then the date. */
function band(at: number, now: Date): string {
  const d = new Date(at);
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { weekday: "long", month: "long", day: "numeric" } : { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function shortDate(at: number, now: Date): string {
  const d = new Date(at);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString("en-US", opts).toUpperCase();
}

/**
 * The inbox as a full-width table, Superhuman's layout: sender, then subject
 * and snippet on one line, date at the end, grouped by date band. Shown on
 * arrival; the first click opens the split view.
 */
export function EmailTable({
  threads,
  activeId,
  onSelect,
  hasMore,
  onLoadMore,
  pending,
  error,
}: {
  threads: GmailThreadSummary[];
  /** The row open in the card beside the table. */
  activeId: string | null;
  onSelect: (id: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  pending: boolean;
  error: ReactNode;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    loadMoreRef.current = onLoadMore;
  });
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, threads.length]);

  const now = new Date();
  // Newest first by last message, whatever order Gmail listed the threads
  // in, so the date bands run once each and never repeat.
  const rows = [...threads].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  const bands = rows.map((t) => band(t.lastMessageAt, now));

  return (
    <div className={cn("quiet-scrollbar min-h-0 flex-1 overflow-y-auto bg-background-surface", pending && "opacity-60")}>
      <div className="mx-auto w-full max-w-5xl px-6 py-5">
        {error ? (
          <p className="py-6 text-sm text-muted-foreground">{error}</p>
        ) : (
          rows.length === 0 && !pending && <p className="py-6 text-sm text-muted-foreground">No email.</p>
        )}
        {rows.map((t, i) => {
          const heading = i > 0 && bands[i] !== bands[i - 1] ? bands[i] : null;
          return (
            <Fragment key={t.id}>
              {heading && <div className="px-3 pt-7 pb-2.5 text-xs text-muted-foreground">{heading}</div>}
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className={cn(
                  "flex h-11 w-full items-center gap-5 rounded-md px-3 text-left text-sm leading-none hover:bg-muted/60",
                  t.unread ? "text-foreground" : "text-foreground/70",
                  activeId === t.id && "bg-muted"
                )}
              >
                <span className={cn("w-44 shrink-0 truncate", t.unread && "font-semibold")}>
                  {t.who}
                  {t.messageCount > 1 ? ` (${t.messageCount})` : ""}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                  {t.starred && <StarIcon className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />}
                  <span className="min-w-0 truncate">
                  <span className={cn("text-foreground", t.unread && "font-semibold")}>{t.subject}</span>
                  <span className="ml-3 text-muted-foreground">
                    {t.lastIsMine ? "You: " : ""}
                    {t.snippet}
                  </span>
                  </span>
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {shortDate(t.lastMessageAt, now)}
                </span>
              </button>
            </Fragment>
          );
        })}
        {hasMore && <div ref={sentinelRef} className="h-px" />}
      </div>
    </div>
  );
}
