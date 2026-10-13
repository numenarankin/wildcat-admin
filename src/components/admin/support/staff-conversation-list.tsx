"use client";

import { cn } from "@/lib/utils";
import { relativeAge } from "@/lib/format/relative";
import type { StaffSupportThread } from "@/lib/support/types";

/**
 * The staff inbox: the customer Support page's request panel with the one
 * substitution that page's comment describes. Staff triage across customers,
 * so WHO wrote in leads the row and the subject sits under it. `You:` marks a
 * preview staff wrote. No "new request" button: a thread starts with a
 * customer, never with us.
 */
export function StaffConversationList({
  threads,
  activeId,
  onSelect,
}: {
  threads: StaffSupportThread[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex w-80 shrink-0 flex-col border-r bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b pl-4 pr-2 text-sm font-medium">
        Inbox
      </div>

      <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto">
        {threads.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">No support requests yet.</p>
        )}
        {threads.map((t) => {
          const last = t.messages[t.messages.length - 1];
          const who = t.customer.orgName
            ? `${t.customer.name} · ${t.customer.orgName}`
            : t.customer.name;
          return (
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
                {t.unread && (
                  <span className="size-2 shrink-0 rounded-full bg-blue-500" aria-label="Unread" />
                )}
                <span className={cn("truncate text-sm font-medium", t.unread && "font-semibold")}>
                  {who}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {relativeAge(t.lastMessageAt)}
                </span>
              </div>
              <span className="truncate text-xs text-muted-foreground/80">
                {last ? (
                  <>
                    {last.senderRole === "staff" ? "You: " : ""}
                    {last.body || (last.attachments.length ? "📎 attachment" : "")}
                  </>
                ) : (
                  t.subject
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
