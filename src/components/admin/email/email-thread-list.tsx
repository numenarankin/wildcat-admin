"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { StarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeAge } from "@/lib/format/relative";
import type { GmailThreadSummary } from "@/lib/admin/google/gmail/types";

/**
 * The email thread list: the staff support inbox's panel
 * (`components/admin/support/staff-conversation-list.tsx`), class for class.
 * The folder filter and search live in `EmailToolbar` above it. The row is
 * the staff row with the subject added between the sender and the snippet. Scrolling to the end loads the
 * next page.
 */
export function EmailThreadList({
  threads,
  activeId,
  onSelect,
  hasMore,
  onLoadMore,
  pending,
  error,
}: {
  threads: GmailThreadSummary[];
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

  return (
    <div className="flex w-80 shrink-0 flex-col border-r bg-background">
      <div className={cn("quiet-scrollbar min-h-0 flex-1 overflow-y-auto", pending && "opacity-60")}>
        {error ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{error}</p>
        ) : (
          threads.length === 0 && !pending && <p className="px-4 py-6 text-sm text-muted-foreground">No email.</p>
        )}
        {threads.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            title={t.subject}
            className={cn(
              "flex w-full flex-col gap-1 border-b py-4 pl-4 pr-3 text-left hover:bg-muted/50",
              activeId === t.id && "bg-muted"
            )}
          >
            <div className="flex items-center gap-2">
              {t.unread && <span className="size-2 shrink-0 rounded-full bg-blue-500" aria-label="Unread" />}
              <span className={cn("truncate text-sm font-medium", t.unread && "font-semibold")}>
                {t.who}
                {t.messageCount > 1 ? ` (${t.messageCount})` : ""}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relativeAge(t.lastMessageAt)}</span>
            </div>
            <span className={cn("flex items-center gap-1.5 truncate text-xs", t.unread && "font-semibold")}>
              {t.starred && <StarIcon className="size-3 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />}
              <span className="truncate">{t.subject}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground/80">
              {t.lastIsMine ? "You: " : ""}
              {t.snippet}
            </span>
          </button>
        ))}
        {hasMore && <div ref={sentinelRef} className="h-px" />}
      </div>
    </div>
  );
}
