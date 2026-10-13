"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsCard, SettingsField, SettingsSection, SettingsTabs } from "@/components/settings/panel";
import { Stat } from "@/components/admin/admin-summary-stats";
import { AdminMetricsChart, type ChartView } from "@/components/admin/admin-metrics-chart";
import { adjustAiCredits } from "@/lib/admin/customer-actions";
import {
  LONG_WINDOW_DAYS,
  RECENT_WINDOW_DAYS,
  aiEconomics,
  costSeries,
  creditSeries,
  profitSeries,
  entrySeries,
  usageTotals,
} from "@/lib/admin/customer-usage";
import { UNLIMITED_WELLS } from "@/lib/billing/tiers";
import type { CustomerPanelData, FacilityInputs, FacilityKind } from "@/lib/admin/customer-panel-types";
import {
  SortHead,
  TABLE_HEAD_CLASS,
  count,
  fmtDay,
  usdCents,
  useSort,
  type RunAction,
} from "@/components/admin/customer-panel/panel-ui";

const VIEWS: ChartView[] = [
  { value: "entries", label: "Data entries", kind: "count" },
  { value: "well", label: "Well entries", kind: "count" },
  { value: "tank", label: "Tank entries", kind: "count" },
  { value: "meter", label: "Meter entries", kind: "count" },
  { value: "credits", label: "AI credits used", kind: "count" },
  { value: "cost", label: "AI cost", kind: "money" },
  { value: "profit", label: "AI profit", kind: "money" },
];

const KIND_LABEL: Record<FacilityKind, string> = {
  well: "Well",
  tank: "Tank",
  meter: "Meter",
  battery: "Battery",
};

const DETAIL_LABEL: Record<string, string> = {
  producer: "Producer",
  injection: "Disposal",
  oil: "Oil",
  water: "Water",
  gas: "Gas",
};

type KindTab = "all" | FacilityKind;
type SortKey = "name" | "kind" | "last" | "entries" | "days";

const DAY_MS = 86_400_000;

/** How the org uses Wildcat: its facilities, what gets entered against them, AI. */
export function UsageTab({ panel, run }: { panel: CustomerPanelData; run: RunAction }) {
  const totals = usageTotals(panel);
  const sub = panel.subscription;
  const [kindTab, setKindTab] = useState<KindTab>("all");
  const sort = useSort<SortKey>("entries");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const series = useMemo(
    () => ({
      entries: entrySeries(panel.daily, panel.window),
      well: entrySeries(panel.daily, panel.window, "well"),
      tank: entrySeries(panel.daily, panel.window, "tank"),
      meter: entrySeries(panel.daily, panel.window, "meter"),
      credits: creditSeries(panel.aiSpend, panel.window),
      cost: costSeries(panel.aiSpend, panel.window),
      profit: profitSeries(panel.aiSpend, panel.window),
    }),
    [panel.daily, panel.aiSpend, panel.window]
  );
  const ai = useMemo(() => aiEconomics(panel.aiSpend, panel.window.recent), [panel.aiSpend, panel.window.recent]);
  // The window ends at the close of today, so "1M" is exactly the 30 days the
  // per-facility counts cover.
  const nowMs = Date.parse(`${panel.window.today}T00:00:00Z`) + DAY_MS - 1;

  const kindTabs = (["all", "well", "tank", "meter", "battery"] as const)
    .filter((k) => k === "all" || totals.facilities[k] > 0)
    .map((k) => ({
      id: k as KindTab,
      label: k === "all" ? `All ${totals.facilities.total}` : `${KIND_LABEL[k]}s ${totals.facilities[k]}`,
    }));

  const listed = sort.sort(
    panel.facilities.filter((f) => kindTab === "all" || f.kind === kindTab),
    (f: FacilityInputs, key) =>
      key === "name"
        ? f.name
        : key === "kind"
          ? f.kind
          : key === "last"
            ? f.last
            : f.kind === "battery"
              ? null
              : key === "entries"
                ? f.entries
                : f.days
  );

  async function adjust() {
    setBusy(true);
    const n = Number(delta);
    const ok = await run(
      () => adjustAiCredits(panel.orgId, n, reason),
      n > 0 ? `${count.format(n)} AI credits added.` : `${count.format(-n)} AI credits removed.`
    );
    setBusy(false);
    if (ok) {
      setDelta("");
      setReason("");
    }
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <Stat label="Facilities" value={count.format(totals.facilities.total)} />
        <Stat
          label="Billable wells"
          value={
            sub && sub.wellCap > 0 && sub.wellCap < UNLIMITED_WELLS
              ? `${count.format(panel.billableWells)} / ${count.format(sub.wellCap)}`
              : count.format(panel.billableWells)
          }
        />
        <Stat label={`Entries (${RECENT_WINDOW_DAYS}d)`} value={count.format(totals.entriesRecent)} />
        <Stat
          label={`With data (${RECENT_WINDOW_DAYS}d)`}
          value={`${count.format(totals.withData)} / ${count.format(totals.enterable)}`}
        />
        <Stat
          label="AI credits"
          value={count.format(panel.credits.freeRemaining + panel.credits.paidBalance)}
        />
      </div>

      <AdminMetricsChart
        views={VIEWS}
        series={series}
        nowMs={nowMs}
        ranges={["1M", "3M"]}
        defaultRange="3M"
      />

      <SettingsSection title="Facilities">
        {kindTabs.length > 1 && <SettingsTabs tabs={kindTabs} value={kindTab} onChange={setKindTab} />}
        <div className="rounded-[0.15rem] border">
          <Table className="text-[0.95rem]">
            <TableHeader className={TABLE_HEAD_CLASS}>
              <TableRow className="hover:bg-muted">
                <SortHead column="name" label="Facility" sort={sort} />
                <SortHead column="kind" label="Type" sort={sort} />
                <SortHead column="last" label="Last entry" numeric sort={sort} />
                <SortHead column="entries" label={`Entries (${RECENT_WINDOW_DAYS}d)`} numeric sort={sort} />
                <SortHead column="days" label={`Days with data (${RECENT_WINDOW_DAYS}d)`} numeric sort={sort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {listed.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                    No facilities.
                  </TableCell>
                </TableRow>
              ) : (
                listed.map((f) => (
                  <TableRow key={`${f.kind}:${f.id}`} className="[&>td]:py-3">
                    <TableCell className="font-medium">{f.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {KIND_LABEL[f.kind]}
                      {f.detail && DETAIL_LABEL[f.detail] ? ` · ${DETAIL_LABEL[f.detail]}` : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.kind === "battery" ? "—" : f.last ? fmtDay(f.last) : `None in ${LONG_WINDOW_DAYS} days`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.kind === "battery" ? "—" : count.format(f.entries)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.kind === "battery" ? "—" : `${f.days} / ${RECENT_WINDOW_DAYS}`}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </SettingsSection>

      <SettingsSection title={`AI (${RECENT_WINDOW_DAYS}d)`}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Credits used" value={count.format(ai.credits)} />
          <Stat label="Credit value" value={usdCents.format(ai.valueUsd)} />
          <Stat label="Our AI cost" value={usdCents.format(ai.costUsd)} />
          <Stat
            label="Profit"
            value={`${usdCents.format(ai.profitUsd)}${ai.valueUsd > 0 ? ` · ${Math.round((ai.profitUsd / ai.valueUsd) * 100)}%` : ""}`}
          />
        </div>
        <div className="rounded-[0.15rem] border">
          <Table className="text-[0.95rem]">
            <TableHeader className={TABLE_HEAD_CLASS}>
              <TableRow className="hover:bg-muted">
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Profit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ai.lines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                    No AI use.
                  </TableCell>
                </TableRow>
              ) : (
                ai.lines.map((l) => (
                  <TableRow key={l.label} className="[&>td]:py-3">
                    <TableCell className="font-medium">{l.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{count.format(l.calls)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count.format(l.credits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{usdCents.format(l.valueUsd)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {l.costUsd === null ? "Not recorded" : usdCents.format(l.costUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {l.profitUsd === null ? "—" : usdCents.format(l.profitUsd)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <SettingsCard className="flex flex-wrap items-end gap-3">
          <SettingsField label="Free this period">
            <span className="flex h-9 items-center text-sm font-medium tabular-nums">
              {count.format(panel.credits.freeRemaining)}
            </span>
          </SettingsField>
          <SettingsField label="Purchased">
            <span className="flex h-9 items-center text-sm font-medium tabular-nums">
              {count.format(panel.credits.paidBalance)}
            </span>
          </SettingsField>
          <SettingsField label="Add or remove">
            <Input
              type="number"
              step={1}
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              className="h-9 w-36"
            />
          </SettingsField>
          <SettingsField label="Reason" className="min-w-48 flex-1">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} className="h-9" />
          </SettingsField>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !delta || Number(delta) === 0 || !reason.trim()}
            onClick={() => void adjust()}
          >
            {Number(delta) < 0 ? "Remove credits" : "Add credits"}
          </Button>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
