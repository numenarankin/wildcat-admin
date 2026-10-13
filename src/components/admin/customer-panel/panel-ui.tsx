"use client";

import { useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import type { ActionResult } from "@/lib/admin/customer-panel-types";

/**
 * Pieces every tab of the customer panel shares: formatters, the action
 * runner's type, and the sortable header from `CustomersTable` (same markup,
 * same first-click-descending behaviour) so the panel's tables read like the
 * page they opened from.
 */

/** Runs a panel write; on success the panel reloads its data. */
export type RunAction = (work: () => Promise<ActionResult>, done: string) => Promise<boolean>;

export const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const usdCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const count = new Intl.NumberFormat("en-US");

const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: ADMIN_TIME_ZONE,
});
const dateOnly = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: ADMIN_TIME_ZONE,
});
// A civil date (`YYYY-MM-DD`) is a calendar day, not an instant: format it in
// UTC so no zone can move it to the day before.
const civil = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** An instant, with time. */
export function fmtDateTime(isoString: string | null | undefined): string {
  return isoString ? dateTime.format(new Date(isoString)) : "—";
}

/** An instant, date only. */
export function fmtDate(isoString: string | null | undefined): string {
  return isoString ? dateOnly.format(new Date(isoString)) : "—";
}

/** A `YYYY-MM-DD` calendar day. */
export function fmtDay(day: string | null | undefined): string {
  return day ? civil.format(new Date(`${day}T00:00:00Z`)) : "—";
}

const STRIPE_STATUS: Record<string, string> = {
  active: "Active",
  trialing: "Trial",
  past_due: "Past due",
  unpaid: "Unpaid",
  canceled: "Canceled",
  incomplete: "Incomplete",
  incomplete_expired: "Expired",
  paused: "Paused",
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return STRIPE_STATUS[status] ?? status;
}

/** Header cells for the panel's tables: `CustomersTable`'s treatment. */
export const TABLE_HEAD_CLASS =
  "bg-muted [&_th]:h-12 [&_th]:font-mono [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground";

export type Direction = "asc" | "desc";

/** Sort state with the customers table's rule: first click descending, second ascending. */
export function useSort<K extends string>(initial: K, initialDirection: Direction = "desc") {
  const [key, setKey] = useState<K>(initial);
  const [direction, setDirection] = useState<Direction>(initialDirection);
  function toggle(next: K) {
    if (next === key) setDirection((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setKey(next);
      setDirection("desc");
    }
  }
  /** Sorts by `value(row)`; nulls sink to the bottom either way. */
  function sort<T>(rows: T[], value: (row: T, key: K) => string | number | null): T[] {
    return [...rows].sort((a, b) => {
      const av = value(a, key);
      const bv = value(b, key);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return direction === "desc" ? -cmp : cmp;
    });
  }
  return { key, direction, toggle, sort };
}

export function SortHead<K extends string>({
  column,
  label,
  numeric = false,
  sort,
}: {
  column: K;
  label: string;
  numeric?: boolean;
  sort: { key: K; direction: Direction; toggle: (k: K) => void };
}) {
  const active = sort.key === column;
  return (
    <TableHead
      className={numeric ? "text-right" : undefined}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => sort.toggle(column)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-foreground",
          numeric && "flex-row-reverse",
          active && "text-foreground"
        )}
      >
        {label}
        <span className="inline-flex w-3 justify-center">
          {active && sort.direction === "asc" ? (
            <ArrowUpIcon className="size-3" />
          ) : (
            <ArrowDownIcon className={cn("size-3", !active && "invisible")} />
          )}
        </span>
      </button>
    </TableHead>
  );
}

/** One label / value line in a facts list. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2.5 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium">{children}</dd>
    </div>
  );
}
