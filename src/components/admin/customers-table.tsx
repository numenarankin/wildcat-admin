"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { customersTableSlice } from "@/lib/ai/admin/page-slices";
import { Badge } from "@/components/ui/badge";
import type { CustomerRow, CustomerStatus } from "@/lib/admin/customer-rows";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import { CustomerName } from "@/components/admin/customer-panel/customer-panel";

/**
 * Every customer. The customer dashboard's lease table with customers for
 * rows: same header, same sort behaviour (first click descending, second
 * ascending), no expansion because a customer has no children here. Which
 * column it opens on is the host page's call (`defaultSort`).
 */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US");
// "09/16/26, 1:05 PM", in Wildcat's own zone (see `ADMIN_TIME_ZONE`).
const signupFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  timeZone: ADMIN_TIME_ZONE,
});

const TERM_LABEL: Record<string, string> = { month: "Monthly", year: "Annual" };

/**
 * Label and badge tint per status; the order is the sort order (best first).
 * Tinted, not filled: a solid green or red pill is the loudest thing on the
 * page, and this column repeats on every row.
 */
const STATUS: Record<CustomerStatus, { label: string; badge: string; rank: number }> = {
  paying: { label: "Paying", badge: "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", rank: 0 },
  trial: { label: "Trial", badge: "border-blue-500/30 bg-blue-500/15 text-blue-600 dark:text-blue-400", rank: 1 },
  paused: { label: "Paused", badge: "border-zinc-400/30 bg-zinc-400/15 text-zinc-600 dark:text-zinc-300", rank: 2 },
  onboarding: { label: "Onboarding", badge: "border-amber-400/30 bg-amber-400/15 text-amber-600 dark:text-amber-300", rank: 3 },
  canceled: { label: "Canceled", badge: "border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-400", rank: 4 },
};

type SortKey = "name" | "email" | "term" | "status" | "revenueUsd" | "referrals" | "signedUpAt";
type Direction = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "name", label: "Company", numeric: false },
  { key: "email", label: "Email", numeric: false },
  { key: "term", label: "Term", numeric: false },
  { key: "status", label: "Status", numeric: false },
  { key: "revenueUsd", label: "Revenue /yr", numeric: true },
  { key: "referrals", label: "Referrals", numeric: true },
  { key: "signedUpAt", label: "Signed up", numeric: true },
];

export function CustomersTable({
  rows,
  defaultSort = "revenueUsd",
}: {
  rows: CustomerRow[];
  /**
   * The column the table opens on, descending. The dashboard wants the
   * newest sign-ups (who just arrived); Clients wants the biggest accounts.
   */
  defaultSort?: SortKey;
}) {
  const [sortKey, setSortKey] = useState<SortKey>(defaultSort);
  const [direction, setDirection] = useState<Direction>("desc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) setDirection((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setDirection("desc");
    }
  }

  function compare(a: CustomerRow, b: CustomerRow): number {
    const av = a[sortKey];
    const bv = b[sortKey];
    let cmp: number;
    if (sortKey === "status") cmp = STATUS[a.status].rank - STATUS[b.status].rank;
    else if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
    return direction === "desc" ? -cmp : cmp;
  }

  const sorted = [...rows].sort(compare);
  const sortLabel = COLUMNS.find((c) => c.key === sortKey)?.label ?? sortKey;
  usePageContextSlice(
    "admin-customers-table",
    customersTableSlice(sorted, `${sortLabel}, ${direction === "desc" ? "descending" : "ascending"}`)
  );

  return (
    <div className="rounded-[0.15rem] border">
      <Table className="text-[0.95rem]">
        <TableHeader className="bg-muted [&_th]:h-12 [&_th]:font-mono [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
          <TableRow className="hover:bg-muted">
            {COLUMNS.map((col) => {
              const active = col.key === sortKey;
              return (
                <TableHead
                  key={col.key}
                  className={col.numeric ? "text-right" : undefined}
                  aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className={cn(
                      "inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-foreground",
                      col.numeric && "flex-row-reverse",
                      active && "text-foreground"
                    )}
                  >
                    {col.label}
                    <span className="inline-flex w-3 justify-center">
                      {active && direction === "asc" ? (
                        <ArrowUpIcon className="size-3" />
                      ) : (
                        <ArrowDownIcon className={cn("size-3", !active && "invisible")} />
                      )}
                    </span>
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMNS.length} className="h-24 text-center text-muted-foreground">
                No customers to display.
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((row) => (
              <TableRow key={row.orgId} className="[&>td]:py-3.5">
                <TableCell>
                  <CustomerName orgId={row.orgId} name={row.name} />
                </TableCell>
                <TableCell className="text-muted-foreground">{row.email ?? "—"}</TableCell>
                <TableCell>{row.term ? TERM_LABEL[row.term] : "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={STATUS[row.status].badge}>
                    {STATUS[row.status].label}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{usd.format(row.revenueUsd)}</TableCell>
                <TableCell className="text-right tabular-nums">{count.format(row.referrals)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {signupFormatter.format(new Date(row.signedUpAt))}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
