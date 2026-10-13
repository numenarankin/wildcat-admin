"use client";

import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  declineAt,
  fitDecline,
  project,
  type MonthlyRate,
} from "@/lib/wells/arps";
import type { LeaseMonth } from "@/lib/scout/rrc-types";

type Stream = "oil" | "gas" | "cond" | "csgd";
type Range = "12M" | "5Y" | "10Y" | "All";

const STREAMS: {
  key: Stream;
  label: string;
  unit: string;
  vol: keyof LeaseMonth;
  allow: keyof LeaseMonth;
  color: string;
}[] = [
  { key: "oil", label: "Oil", unit: "bbl", vol: "oil_prod_vol", allow: "oil_allow", color: "#059669" },
  { key: "gas", label: "Gas", unit: "MCF", vol: "gas_prod_vol", allow: "gas_allow", color: "#800000" },
  { key: "cond", label: "Condensate", unit: "bbl", vol: "cond_prod_vol", allow: "cond_limit", color: "#b45309" },
  { key: "csgd", label: "Casinghead", unit: "MCF", vol: "csgd_prod_vol", allow: "csgd_limit", color: "#4169e1" },
];

/**
 * The time selector, same segmented control the facility charts carry
 * (`PRODUCTION_RANGES` in `@/components/wells/production-chart`). Spans differ
 * because the data does: a facility logs daily and opens on 3M, while the RRC
 * publishes one row a month, so a 1M or 3M window here would be one or three
 * bars.
 */
const RANGES: { value: Range; months: number }[] = [
  { value: "12M", months: 12 },
  { value: "5Y", months: 60 },
  { value: "10Y", months: 120 },
  { value: "All", months: Number.POSITIVE_INFINITY },
];

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });
/** Percent with one decimal, matching the well page's decline tooltip. */
const declinePercent = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const tickMonth = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});
const fullMonth = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const monthDate = (cycle: string) => new Date(`${cycle}-01T00:00:00Z`);

/** One plotted month. `declineRate` is a property of the fit, not a series. */
interface ChartRow {
  cycle: string;
  /** Null only under a log axis, where an unfiled month's 0 cannot be drawn. */
  volume: number | null;
  allowable: number | null;
  curve: number | null;
  /** Fraction per year the curve falls over the next 12 months at this month. */
  declineRate: number | null;
  filed: boolean;
  reported: boolean;
}

/*
 * ===========================================================================
 * PRODUCTION CHART — monthly volume, allowable, decline fit, filing state.
 * ===========================================================================
 *
 * Used by the lease modal and the operator modal. Takes `LeaseMonth[]` ordered
 * oldest-first; every field it reads is listed in STREAMS below plus
 * `prod_report_filed` and `reported`.
 *
 * WIRING NOTES
 *   - `reported: false` = a cycle the RRC has not published yet (the last ~3).
 *     `prod_report_filed: "N"` = published cycle, no report filed — 18% of
 *     lease-months statewide. BOTH are zero volume and they mean different
 *     things; the strip under the chart is what tells them apart. Derive
 *     `reported` from the data (max cycle with statewide volume), not from a
 *     hardcoded lag.
 *   - Allowables (`oil_allow`, `gas_allow`, `cond_limit`, `csgd_limit`) are
 *     often null for gas leases; the overlay simply skips nulls.
 *   - At operator grain only the four volume columns are populated; the
 *     allowable overlay will be empty and that is correct.
 */

/**
 * A lease's monthly production, with the two things RRC data makes mandatory
 * and a naive line chart gets wrong:
 *
 *   1. **Unfiled months.** 18% of lease-months statewide were never filed
 *      (`prod_report_filed = 'N'`). They are zeros in the series and look
 *      exactly like a shut-in. The strip under the axis is the difference
 *      between "made nothing" and "told nobody".
 *   2. **The unreported tail.** RRC publishes ~3 months late, so the last few
 *      cycles read zero for everyone. Shaded, not plotted as a collapse.
 *
 * The allowable overlay is the other half of the story: at allowable vs well
 * under it is a real signal, and it is on the same axis as the volume so the
 * comparison needs no arithmetic.
 */
export function ProductionChart({
  monthly,
  title = "Production",
  defaultStream,
  showAllowable = true,
  minHeight = 260,
}: {
  monthly: LeaseMonth[];
  title?: string;
  defaultStream?: Stream;
  showAllowable?: boolean;
  /**
   * The plot's FLOOR, not its height: it grows to fill the tab pane and stops
   * shrinking here. A pane holding a table as well can push it to the floor and
   * scroll, which is what it did at a fixed height on every pane.
   */
  minHeight?: number;
}) {
  // Default to whichever stream this lease actually makes.
  const firstWithVolume =
    STREAMS.find((s) => monthly.some((m) => Number(m[s.vol]) > 0))?.key ?? "oil";
  const [stream, setStream] = useState<Stream>(defaultStream ?? firstWithVolume);
  const [range, setRange] = useState<Range>("10Y");
  const [allowable, setAllowable] = useState(showAllowable);
  const [decline, setDecline] = useState(true);
  const [logScale, setLogScale] = useState(false);

  const spec = STREAMS.find((s) => s.key === stream)!;

  // One row per month, so the window is a row count.
  const months = RANGES.find((r) => r.value === range)!.months;
  const rows = Number.isFinite(months) ? monthly.slice(-months) : monthly;

  /**
   * The decline fit, from the app's own Modified Arps
   * (`@/lib/wells/arps` — the same fit the well and lease pages use, so a
   * decline quoted here and one quoted there are the same number).
   *
   * Two RRC-specific inputs to be careful about, both handled here rather than
   * inside the fitter:
   *   - The RRC publishes a monthly VOLUME with no producing-day count, so the
   *     "rate" fed to the fit is volume per month. Months are near enough equal
   *     length that the shape is right; the level is per month, not per day.
   *   - Unfiled and unreported months are zeros in the series. Feeding them in
   *     would read as a collapse to nothing, so they are dropped — the fitter
   *     already ignores non-positive rates, this makes the intent explicit.
   */
  const fit = useMemo(() => {
    const rates: MonthlyRate[] = rows
      .filter((m) => m.reported && m.prod_report_filed !== "N")
      .map((m) => ({ month: m.cycle, rate: Number(m[spec.vol]) || 0 }))
      .filter((r) => r.rate > 0);
    return fitDecline(rates);
  }, [rows, spec]);

  const data = useMemo<ChartRow[]>(
    () =>
      rows.map((m) => {
        // Sample the fitted curve at this month's offset from the fit window's
        // start; before the window (pre-peak) there is no curve to draw.
        let curve: number | null = null;
        // The decline the curve implies AT this month, per year. Read off the
        // same fit at the same t as the point above it, so the tooltip cannot
        // disagree with the line it is quoting. Per month, not once per curve:
        // under a hyperbolic fit the decline flattens as the lease ages, so a
        // single figure would be right only at the month it was measured.
        let declineRate: number | null = null;
        if (fit && decline) {
          const [fy, fm] = fit.startMonth.split("-").map(Number);
          const [y, mo] = m.cycle.split("-").map(Number);
          const t = ((y - fy) * 12 + (mo - fm)) / 12;
          if (t >= 0) {
            curve = Math.round(project(fit, t));
            declineRate = declineAt(fit, t);
          }
        }
        const volume = Number(m[spec.vol]) || 0;
        return {
          cycle: m.cycle,
          // A log axis cannot plot 0; unfiled and unreported months become
          // gaps, which the filing strip below still accounts for.
          volume: logScale && volume <= 0 ? null : volume,
          allowable: allowable ? Number(m[spec.allow]) || null : null,
          curve: logScale && curve != null && curve <= 0 ? null : curve,
          declineRate,
          filed: m.prod_report_filed !== "N",
          reported: m.reported,
        };
      }),
    [rows, spec, allowable, fit, decline, logScale]
  );

  const unreportedFrom = data.find((d) => !d.reported)?.cycle;
  const lastCycle = data[data.length - 1]?.cycle;
  const unfiled = data.filter((d) => d.reported && !d.filed).length;

  const config = {
    volume: { label: `${spec.label} (${spec.unit})`, color: spec.color },
    allowable: { label: "Allowable", color: "var(--muted-foreground)" },
    curve: { label: "Arps fit", color: "#7c3aed" },
  } satisfies ChartConfig;

  return (
    /*
     * Fills the pane, down to a floor.
     *
     * Header and strip are shrink-0 and only the plot flexes, so the box grows
     * with the modal instead of sitting at a fixed 260px in a tall one. The
     * floor is what keeps the old failure from coming back: with nothing
     * shrinkable and less room than the content needed, the strip used to
     * overflow the box and draw on top of the panel underneath. Now the plot
     * stops at `minHeight` and the tab pane scrolls.
     *
     * No `min-h-0` on THIS box: it would let the box shrink below that floor
     * while the plot inside it cannot, and whatever follows the chart in the
     * pane (the well modal's W-10 panel) is then laid over the spill. Without
     * it the box is never shorter than its content, so the pane scrolls.
     * Pinned by `modal-layout.test.tsx`.
     */
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          <div className="flex gap-1">
            {STREAMS.map((s) => (
              <Button
                key={s.key}
                size="xs"
                variant={stream === s.key ? "default" : "outline"}
                onClick={() => setStream(s.key)}
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant={allowable ? "default" : "outline"}
            onClick={() => setAllowable((v) => !v)}
          >
            Allowable
          </Button>
          <Button
            size="xs"
            variant={decline ? "default" : "outline"}
            disabled={!fit}
            onClick={() => setDecline((v) => !v)}
          >
            Decline
          </Button>
          <Button
            size="xs"
            variant={logScale ? "default" : "outline"}
            onClick={() => setLogScale((v) => !v)}
          >
            Log
          </Button>
          {/* Same segmented control as the facility charts, so the time
              selector is one object across the app. */}
          <div
            role="group"
            aria-label="Select time range"
            className="inline-flex items-center gap-0.5 rounded-sm bg-muted p-0.5"
          >
            {RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                aria-pressed={range === r.value}
                onClick={() => setRange(r.value)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                  range === r.value &&
                    "bg-background text-foreground shadow-sm hover:text-foreground"
                )}
              >
                {r.value}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ChartContainer
        config={config}
        className="aspect-auto w-full min-h-0 flex-1"
        style={{ minHeight }}
      >
        <ComposedChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          {unreportedFrom && lastCycle && (
            <ReferenceArea
              x1={unreportedFrom}
              x2={lastCycle}
              fill="var(--muted-foreground)"
              fillOpacity={0.1}
            />
          )}
          <XAxis
            dataKey="cycle"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={28}
            tickFormatter={(v) => tickMonth.format(monthDate(String(v)))}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={52}
            scale={logScale ? "log" : "auto"}
            domain={logScale ? ["auto", "auto"] : undefined}
            allowDataOverflow={logScale}
            tickFormatter={(v: number) => compact.format(v)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(v) => fullMonth.format(monthDate(String(v)))}
                footer={(p) => {
                  const rate = (p[0]?.payload as ChartRow | undefined)
                    ?.declineRate;
                  if (rate == null) return null;
                  return (
                    <>
                      <span className="text-muted-foreground">Decline</span>
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {declinePercent.format(rate)}/yr
                      </span>
                    </>
                  );
                }}
              />
            }
          />
          <Area
            dataKey="volume"
            type="monotone"
            stroke="var(--color-volume)"
            fill="var(--color-volume)"
            fillOpacity={0.12}
            strokeWidth={2}
            dot={false}
            connectNulls={logScale}
          />
          {decline && fit && (
            <Line
              dataKey="curve"
              type="monotone"
              stroke="var(--color-curve)"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          )}
          {allowable && (
            <Line
              dataKey="allowable"
              type="monotone"
              stroke="var(--color-allowable)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              connectNulls
            />
          )}
        </ComposedChart>
      </ChartContainer>

      {/* Filing strip: one cell per month, aligned to the plot area. */}
      <div className="shrink-0 pl-[52px] pr-2">
        <div className="flex h-2 w-full gap-px overflow-hidden rounded-[2px]">
          {data.map((d) => (
            <div
              key={d.cycle}
              title={`${fullMonth.format(monthDate(d.cycle))} — ${
                !d.reported
                  ? "not yet reported by the RRC"
                  : d.filed
                    ? "production report filed"
                    : "NO production report filed"
              }`}
              className={cn(
                "h-full flex-1",
                !d.reported
                  ? "bg-muted-foreground/25"
                  : d.filed
                    ? "bg-emerald-600/60"
                    : "bg-amber-500"
              )}
            />
          ))}
        </div>
        {/* The fit's own numbers used to be spelled out here. They are on the
            curve itself now — hover any month for the decline it implies — and
            the headline above the chart carries the lease-level figure, so a
            third copy under the strip was one number too many. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-3 rounded-[2px] bg-emerald-600/60" />
            filed
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-3 rounded-[2px] bg-amber-500" />
            no report filed ({unfiled} of {data.filter((d) => d.reported).length})
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-3 rounded-[2px] bg-muted-foreground/25" />
            not yet reported (RRC lags ~3 months)
          </span>
        </div>
      </div>
    </div>
  );
}
