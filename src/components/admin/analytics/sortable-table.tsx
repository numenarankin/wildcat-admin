"use client";

import { useState, type ReactNode } from "react";
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

/**
 * The customers table's header, sort behaviour (first click descending,
 * second ascending) and row treatment, over any rows: the analytics tabs'
 * tables are that table with different columns.
 */

export interface SortColumn<T> {
  key: string;
  label: string;
  numeric: boolean;
  /** What the column sorts by; strings compare alphabetically. */
  sortValue: (row: T) => number | string | null;
  cell: (row: T) => ReactNode;
  className?: string;
}

export function SortableTable<T>({
  rows,
  columns,
  rowKey,
  defaultSort,
  empty,
}: {
  rows: T[];
  columns: SortColumn<T>[];
  rowKey: (row: T) => string;
  defaultSort: string;
  empty: string;
}) {
  const [sortKey, setSortKey] = useState(defaultSort);
  const [direction, setDirection] = useState<"asc" | "desc">("desc");

  function toggleSort(key: string) {
    if (key === sortKey) setDirection((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setDirection("desc");
    }
  }

  const column = columns.find((c) => c.key === sortKey) ?? columns[0];
  const sorted = [...rows].sort((a, b) => {
    const av = column.sortValue(a);
    const bv = column.sortValue(b);
    // Blanks sink to the bottom whichever way the column runs.
    if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return direction === "desc" ? -cmp : cmp;
  });

  return (
    <div className="rounded-[0.15rem] border">
      <Table className="text-[0.95rem]">
        <TableHeader className="bg-muted [&_th]:h-12 [&_th]:font-mono [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
          <TableRow className="hover:bg-muted">
            {columns.map((col) => {
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
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((row) => (
              <TableRow key={rowKey(row)} className="[&>td]:py-3.5">
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={cn(col.numeric && "text-right tabular-nums", col.className)}
                  >
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
