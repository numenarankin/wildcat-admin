"use client";

import { useState } from "react";
import { Download, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { getOperatorsLast12, getOperatorsP5 } from "@/lib/scout/queries";
import {
  activityLabel,
  OperatorListControls,
  useOperatorList,
} from "@/components/scout/operator-list-controls";
import type { OperatorP5 } from "@/lib/scout/types";
import { fmtUsd, fmtVol, fmtDate8, fmtPhone, perMonth, P5_STATUS } from "@/lib/scout/format";
import type { CommodityPrices } from "@/lib/analytics/types";
import type { TargetInput } from "@/lib/admin/target-types";
// Archon's copy of this panel uses its own little CSV writer; here the export
// runs through Wildcat's shared export stack instead (same quoting, BOM, and
// download path as every other CSV in the app).
import { columnsToCsv, CSV_BOM } from "@/lib/export/csv";
import type { ColumnSpec } from "@/lib/export/columns";
import { downloadFile } from "@/lib/export/download";
import { slugify } from "@/lib/slug";
import { cn } from "@/lib/utils";

export interface OperatorListItem {
  n: number; // operator number
  nm: string; // name
  a: string; // address line 1
  c: string; // city
  s: string; // state
  z: number; // zip
  w: number; // effective well count shown on the map (active-only when excluded)
  wt: number; // total well count
  wa: number; // active (non-plugged) well count
}

/** Side panel listing the operators inside a clicked cluster. */
export function OperatorListPanel({
  title,
  operators,
  onClose,
  onSelectOperator,
  excludePlugged = false,
  prices,
  onAddTargets,
  targetNumbers,
}: {
  title: string | null;
  operators: OperatorListItem[];
  onClose: () => void;
  onSelectOperator: (operatorNumber: number) => void;
  excludePlugged?: boolean;
  /** Live quotes behind the revenue sort; the map's own. */
  prices?: CommodityPrices;
  /**
   * Adds the checked operators to the Targets list. When set, each row gets a
   * checkbox and the header an Add button; the customer app passes nothing.
   */
  onAddTargets?: (targets: TargetInput[]) => void;
  /** Operators already on the Targets list: shown ticked and greyed, not addable again. */
  targetNumbers?: ReadonlySet<number>;
}) {
  const isTarget = (n: number) => targetNumbers?.has(n) ?? false;
  const [exporting, setExporting] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const {
    sort,
    setSort,
    activity,
    setActivity,
    visible,
    production: prod,
    status,
    revenueOf,
  } = useOperatorList(operators, prices);

  function toggleChecked(n: number, on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(n);
      else next.delete(n);
      return next;
    });
  }

  // Select-all works on the VISIBLE rows: what the activity filter is showing
  // is what "all" means to the reader, and a hidden row must not be added.
  // Rows already on the list are out of the count: they cannot be ticked.
  const selectable = visible.filter((o) => !isTarget(o.n));
  const visibleChecked = selectable.filter((o) => checked.has(o.n)).length;
  const allVisibleChecked = selectable.length > 0 && visibleChecked === selectable.length;
  function toggleAll(on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const o of selectable) {
        if (on) next.add(o.n);
        else next.delete(o.n);
      }
      return next;
    });
  }
  const addable = [...checked].filter((n) => !isTarget(n)).length;

  function handleAddTargets() {
    if (!onAddTargets || addable === 0) return;
    onAddTargets(
      operators
        .filter((o) => checked.has(o.n) && !isTarget(o.n))
        .map((o) => ({
          operatorNo: o.n,
          name: o.nm || `Operator #${o.n}`,
          city: o.c || null,
          state: o.s || null,
        }))
    );
    setChecked(new Set());
  }

  // Build and download a CSV of the listed operators: identity + mailing address
  // + well counts + last-12mo production (Tier 1, already loaded) plus the P-5
  // master fields (Tier 2, one batched fetch on demand).
  async function handleExport() {
    if (!visible.length || exporting) return;
    setExporting(true);
    try {
      // The VISIBLE rows, not every operator in the cluster: the panel now
      // filters by activity, and a CSV that quietly carried the rows the screen
      // is hiding would not be the list the button sits under.
      const nums = visible.map((o) => o.n);
      const [p5, prodMap] = await Promise.all([
        getOperatorsP5(nums),
        prod.size ? Promise.resolve(prod) : getOperatorsLast12(nums),
      ]);

      const zip = (o: OperatorListItem, m?: OperatorP5) => {
        const base = m?.zip ?? (o.z || null);
        if (!base) return "";
        return m?.zip_suffix ? `${base}-${m.zip_suffix}` : String(base);
      };

      const cols: ColumnSpec<OperatorListItem>[] = [
        { header: "Operator number", value: (o) => o.n },
        { header: "Operator name", value: (o) => o.nm },
        {
          header: "P-5 status",
          value: (o) => {
            const st = p5.get(o.n)?.p5_status;
            return st ? P5_STATUS[st] ?? st : "";
          },
        },
        { header: "Last P-5 date", value: (o) => fmtDate8(p5.get(o.n)?.last_p5_date) ?? "" },
        { header: "Phone", value: (o) => fmtPhone(p5.get(o.n)?.phone) ?? "" },
        { header: "Address 1", value: (o) => p5.get(o.n)?.addr_line1 ?? o.a ?? "" },
        { header: "Address 2", value: (o) => p5.get(o.n)?.addr_line2 ?? "" },
        { header: "City", value: (o) => p5.get(o.n)?.city ?? o.c ?? "" },
        { header: "State", value: (o) => p5.get(o.n)?.state ?? o.s ?? "" },
        { header: "ZIP", value: (o) => zip(o, p5.get(o.n)) },
        { header: "Oil gatherer", value: (o) => p5.get(o.n)?.oil_gatherer ?? "" },
        { header: "Gas gatherer", value: (o) => p5.get(o.n)?.gas_gatherer ?? "" },
        { header: "Wells (total)", value: (o) => o.wt },
        { header: "Wells (active)", value: (o) => o.wa },
        // Rounded, not raw: a per-month average of an integer sum is otherwise
        // 3,205.4166666666665 in a spreadsheet cell.
        {
          header: "Oil (bbl/mo)",
          value: (o) => Math.round(perMonth(prodMap.get(o.n)?.oil, prodMap.get(o.n)?.months)),
        },
        {
          header: "Gas (MCF/mo)",
          value: (o) => Math.round(perMonth(prodMap.get(o.n)?.gas, prodMap.get(o.n)?.months)),
        },
      ];

      const csv = columnsToCsv(cols, visible);
      const base = slugify(title ?? "operators");
      downloadFile(
        `${base}${excludePlugged ? "-active-only" : ""}.csv`,
        "text/csv;charset=utf-8",
        CSV_BOM + csv
      );
    } catch {
      /* swallow: a failed export should not crash the panel */
    } finally {
      setExporting(false);
    }
  }

  if (title == null) return null;

  return (
    <div className="no-scrollbar flex h-full w-[36rem] shrink-0 flex-col overflow-y-auto border-l bg-background shadow-xl">
      <div className="sticky top-0 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex items-start justify-between gap-2">
          <div className="truncate font-heading text-lg font-semibold tracking-tight">
            {title}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          {/* Both counts when the activity filter is hiding some, so a shrunken
              list reads as filtered rather than as a cluster that lost members. */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {onAddTargets && (
              <Checkbox
                aria-label="Select all"
                checked={allVisibleChecked}
                indeterminate={visibleChecked > 0 && !allVisibleChecked}
                onCheckedChange={(on) => toggleAll(on === true)}
              />
            )}
            {visible.length === operators.length
              ? `${operators.length.toLocaleString()} operator${operators.length === 1 ? "" : "s"}`
              : `${visible.length.toLocaleString()} of ${operators.length.toLocaleString()}`}
          </div>
          <div className="flex items-center gap-1.5">
            {onAddTargets && (
              <Button size="xs" onClick={handleAddTargets} disabled={addable === 0}>
                <Plus className="size-3.5" />
                Add to targets{addable > 0 ? ` (${addable})` : ""}
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              onClick={handleExport}
              disabled={exporting || !visible.length}
            >
              <Download className="size-3.5" />
              {exporting ? "Exporting…" : "CSV"}
            </Button>
          </div>
        </div>
        <div className="mt-2">
          <OperatorListControls
            sort={sort}
            onSort={setSort}
            activity={activity}
            onActivity={setActivity}
          />
        </div>
      </div>

      <ul className="flex flex-col divide-y">
        {visible.map((o) => (
          <li key={o.n} className="flex items-center">
            {onAddTargets && (
              // Beside the row's button, not inside it: a tick must not open
              // the dossier, and a click on the name must not tick the row.
              <span className="flex shrink-0 items-center pl-4">
                <Checkbox
                  aria-label={
                    isTarget(o.n)
                      ? `${o.nm || `Operator #${o.n}`} is already a target`
                      : `Select ${o.nm || `Operator #${o.n}`}`
                  }
                  checked={isTarget(o.n) || checked.has(o.n)}
                  disabled={isTarget(o.n)}
                  // A plain grey tick, not the primary fill at half opacity,
                  // which on a light ground still reads as black.
                  className={cn(
                    isTarget(o.n) &&
                      "disabled:opacity-100 data-checked:border-transparent data-checked:bg-muted-foreground/35 data-checked:text-background"
                  )}
                  onCheckedChange={(on) => toggleChecked(o.n, on === true)}
                />
              </span>
            )}
            <button
              onClick={() => onSelectOperator(o.n)}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 px-4 py-2 text-left hover:bg-muted"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-primary">
                  {o.nm || `Operator #${o.n}`}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[
                    [o.c, o.s].filter(Boolean).join(", "),
                    activityLabel(status.get(o.n)),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">
                <span className="block">
                  {o.w.toLocaleString()} {o.w === 1 ? "well" : "wells"}
                </span>
                {sort === "revenue" && (
                  <span className="block">{fmtUsd(revenueOf(o.n))}/mo</span>
                )}
                {sort === "oil" && (
                  <span className="block">
                    {fmtVol(Math.round(perMonth(prod.get(o.n)?.oil, prod.get(o.n)?.months)))} bbl/mo
                  </span>
                )}
                {sort === "gas" && (
                  <span className="block">
                    {fmtVol(Math.round(perMonth(prod.get(o.n)?.gas, prod.get(o.n)?.months)))} MCF/mo
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
