"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ListChecksIcon, ListPlusIcon, XIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ACCOUNTING_HEADER_CLASS,
  ACCOUNTING_HEADER_ROW_CLASS,
  ACCOUNTING_ROW_CLASS,
  ACCOUNTING_TABLE_CLASS,
} from "@/components/accounting/accounting-table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ENRICH_STATUS_LABEL, type EnrichStatus } from "@/lib/admin/outreach/types";
import { compareTargets, type TargetRow, type TargetSortKey } from "@/lib/admin/target-types";

/**
 * Every target, one row each, in the accounting app's dense table look
 * (`accounting-table.ts`: no frame, short rows, hover-only row action).
 * Sortable on every column, first click descending; opens on date added,
 * newest first.
 */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US");
const dayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
});

type Direction = "asc" | "desc";

const COLUMNS: { key: TargetSortKey; label: string; numeric: boolean }[] = [
  { key: "name", label: "Operator", numeric: false },
  { key: "county", label: "County", numeric: false },
  { key: "activeWells", label: "Wells", numeric: true },
  { key: "revenueUsd", label: "Revenue /mo", numeric: true },
  { key: "projectedUsd", label: "Sub /mo", numeric: true },
  { key: "projectedYearUsd", label: "Sub /yr", numeric: true },
  { key: "createdAt", label: "Added", numeric: true },
];

export function TargetsTable({
  targets,
  onOpen,
  onRemove,
  onQueue,
  queued,
}: {
  targets: TargetRow[];
  /** Operators already on the Enrich queue, with where their research stands. */
  queued: Map<number, EnrichStatus>;
  /** A row click: opens the operator's dossier. */
  onOpen: (target: TargetRow) => void;
  onRemove: (target: TargetRow) => void;
  /** Put the operator on the Enrich queue. */
  onQueue: (target: TargetRow) => void;
}) {
  const [sortKey, setSortKey] = useState<TargetSortKey>("createdAt");
  const [direction, setDirection] = useState<Direction>("desc");

  function toggleSort(key: TargetSortKey) {
    if (key === sortKey) setDirection((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setDirection("desc");
    }
  }

  const sorted = [...targets].sort((a, b) => {
    const cmp = compareTargets(a, b, sortKey);
    return direction === "desc" ? cmp : -cmp;
  });

  return (
    <div>
      <Table className={ACCOUNTING_TABLE_CLASS}>
        <TableHeader className={ACCOUNTING_HEADER_CLASS}>
          <TableRow className={ACCOUNTING_HEADER_ROW_CLASS}>
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
                      "inline-flex items-center gap-1 transition-colors hover:text-foreground",
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
            <TableHead className="w-16">
              <span className="sr-only">Row actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMNS.length + 1} className="h-24 text-center text-muted-foreground">
                No targets to display.
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((row) => (
              <TableRow
                key={row.operatorNo}
                className={cn(ACCOUNTING_ROW_CLASS, "cursor-pointer")}
                onClick={() => onOpen(row)}
              >
                <TableCell>
                  <span className="font-medium">{row.name}</span>
                  {(row.city || row.state) && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {[row.city, row.state].filter(Boolean).join(", ")}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {row.hqCounty ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{count.format(row.activeWells)}</TableCell>
                <TableCell className="text-right tabular-nums">{usd.format(row.revenueUsd)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.projectedUsd != null ? usd.format(row.projectedUsd) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.projectedYearUsd != null ? usd.format(row.projectedYearUsd) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {dayFormatter.format(new Date(row.createdAt))}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-0.5">
                  {queued.has(row.operatorNo) ? (
                    // Always shown: the row is on the queue already.
                    <Tooltip>
                      <TooltipTrigger
                        render={<span onClick={(event) => event.stopPropagation()} />}
                        aria-label={`${row.name} is on the enrich queue`}
                        className="flex size-6 items-center justify-center text-primary"
                      >
                        <ListChecksIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent>On the enrich queue · {ENRICH_STATUS_LABEL[queued.get(row.operatorNo)!]}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={<button type="button" />}
                        aria-label={`Add ${row.name} to the enrich queue`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onQueue(row);
                        }}
                        // Hover-only, like the accounting rosters' row actions.
                        className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <ListPlusIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent>Add to queue</TooltipContent>
                    </Tooltip>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${row.name}`}
                    // Not the row's click: removing must not also open the dossier.
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemove(row);
                    }}
                    className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
