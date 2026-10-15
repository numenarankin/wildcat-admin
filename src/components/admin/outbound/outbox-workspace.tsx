"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ACCOUNTING_HEADER_CLASS,
  ACCOUNTING_HEADER_ROW_CLASS,
  ACCOUNTING_ROW_CLASS,
  ACCOUNTING_TABLE_CLASS,
} from "@/components/accounting/accounting-table";
import { OutboxModal } from "@/components/admin/outbound/outbox-modal";
import { cn } from "@/lib/utils";
import type { EmailSettings } from "@/lib/admin/google/gmail/email-style";
import { isOutboxDue, splitOutboxes, unsentEmails, type Outbox } from "@/lib/admin/outreach/outbox-types";

const when = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Chicago",
});

/**
 * The Outbox tab: the open batches first (a due one in bold), then the sent
 * ones folded under a heading. A row opens the outbox.
 */
export function OutboxWorkspace({
  outboxes,
  emailSettings,
  onChanged,
}: {
  outboxes: Outbox[];
  emailSettings: EmailSettings;
  onChanged: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const { current, past } = splitOutboxes(outboxes);
  const open = openId ? outboxes.find((o) => o.id === openId) ?? null : null;
  const now = new Date();

  const row = (o: Outbox) => {
    const due = isOutboxDue(o, now);
    const failed = o.emails.filter((e) => e.status === "failed").length;
    return (
      <TableRow key={o.id} className={cn(ACCOUNTING_ROW_CLASS, "cursor-pointer", o.status === "sent" && "text-muted-foreground")} onClick={() => setOpenId(o.id)}>
        <TableCell className={cn("font-medium", due && "font-semibold")}>{o.scheduleName ?? "Outbox"}</TableCell>
        <TableCell className={cn("tabular-nums", due && "font-semibold")}>{when.format(new Date(o.dueAt))}</TableCell>
        <TableCell className="tabular-nums">{o.emails.length}</TableCell>
        <TableCell>
          {o.status === "sent" ? (
            "Sent"
          ) : failed > 0 ? (
            <span className="text-red-600 dark:text-red-400">{failed} failed</span>
          ) : due ? (
            "Due"
          ) : (
            `${unsentEmails(o).length} to send`
          )}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Table className={ACCOUNTING_TABLE_CLASS}>
        <TableHeader className={ACCOUNTING_HEADER_CLASS}>
          <TableRow className={ACCOUNTING_HEADER_ROW_CLASS}>
            <TableHead>Outbox</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Recipients</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {current.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                Nothing in an outbox. Add emails from the Queue tab.
              </TableCell>
            </TableRow>
          ) : (
            current.map(row)
          )}
        </TableBody>
      </Table>

      {past.length > 0 && (
        <section className="border-t">
          <button
            type="button"
            onClick={() => setShowPast((v) => !v)}
            aria-expanded={showPast}
            className="flex w-full items-center gap-1 px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <ChevronRightIcon className={cn("size-3.5 transition-transform", showPast && "rotate-90")} />
            Past ({past.length})
          </button>
          {showPast && (
            <Table className={ACCOUNTING_TABLE_CLASS}>
              <TableBody>{past.map(row)}</TableBody>
            </Table>
          )}
        </section>
      )}

      {open && <OutboxModal key={open.id} outbox={open} emailSettings={emailSettings} onClose={() => setOpenId(null)} onChanged={onChanged} />}
    </div>
  );
}
