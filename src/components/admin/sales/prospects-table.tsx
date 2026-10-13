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
import { prospectStageLabel, type Prospect } from "@/lib/admin/prospect-types";

/**
 * Every prospect, one row each: the admin dashboard's customers table with
 * prospects for rows and the same sort behaviour (first click descending,
 * second ascending). A row opens the same modal a pipeline card does; the
 * Stage column is the column the card sits in, read from the same row.
 */

const count = new Intl.NumberFormat("en-US");
const dayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
});

type SortKey =
  | "company"
  | "contactName"
  | "email"
  | "phone"
  | "county"
  | "wells"
  | "stage"
  | "source"
  | "createdAt";
type Direction = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "company", label: "Company", numeric: false },
  { key: "contactName", label: "Contact", numeric: false },
  { key: "email", label: "Email", numeric: false },
  { key: "phone", label: "Phone", numeric: false },
  { key: "county", label: "County", numeric: false },
  { key: "wells", label: "Wells", numeric: true },
  { key: "stage", label: "Stage", numeric: false },
  { key: "source", label: "Source", numeric: false },
  { key: "createdAt", label: "Added", numeric: true },
];

export function ProspectsTable({
  prospects,
  onOpenProspect,
}: {
  prospects: Prospect[];
  onOpenProspect: (prospect: Prospect) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [direction, setDirection] = useState<Direction>("desc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) setDirection((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setDirection("desc");
    }
  }

  function compare(a: Prospect, b: Prospect): number {
    const av = a[sortKey];
    const bv = b[sortKey];
    let cmp: number;
    if (typeof av === "number" || typeof bv === "number") {
      // Unknown sizes sort below every known one, whichever way the column goes.
      cmp = (av as number | undefined ?? -1) - (bv as number | undefined ?? -1);
    } else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
    return direction === "desc" ? -cmp : cmp;
  }

  const sorted = [...prospects].sort(compare);

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
                No prospects to display.
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer [&>td]:py-3.5"
                onClick={() => onOpenProspect(row)}
              >
                <TableCell className="font-medium">{row.company}</TableCell>
                <TableCell>{row.contactName ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.email ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">{row.phone ?? "—"}</TableCell>
                <TableCell>{row.county ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.wells != null ? count.format(row.wells) : "—"}
                </TableCell>
                <TableCell>{prospectStageLabel(row.stage)}</TableCell>
                <TableCell className="text-muted-foreground">{row.source ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {dayFormatter.format(new Date(row.createdAt))}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
