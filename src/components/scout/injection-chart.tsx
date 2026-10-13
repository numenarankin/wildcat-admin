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
import {
  INJECTION_WINDOWS,
  buildInjectionSeries,
  type InjectionWindow,
} from "@/lib/scout/injection-series";
import type { InjectionMonth } from "@/lib/scout/rrc-types";

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });
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

/*
 * ===========================================================================
 * INJECTION CHART — H-10 monthly volume against the permitted ceiling.
 * ===========================================================================
 *
 * Deliberately NOT ProductionChart with different columns. The two series
 * answer different questions and the furniture follows: production asks "is it
 * declining" and gets an Arps fit; injection asks "how much room is left" and
 * gets the permit's own ceiling drawn on the same axis, so the comparison needs
 * no arithmetic from the reader.
 *
 * BOTH AXES CARRY THAT ARGUMENT. Volume is read against permitted bbl/day, and
 * pressure against permitted PSIG: the reported max sits above or below the
 * permit's own line and an exceedance is a crossing, not a subtraction. The two
 * ceilings are drawn the same way and computed differently — see the rules at
 * the top of `injection-series.ts`, which is where all of the arithmetic lives.
 *
 * TWO THINGS THAT MUST NOT BE DRAWN NAIVELY
 *   1. The volume permit is a rate — barrels PER DAY — and the series is a
 *      monthly total. That ceiling is therefore redrawn per month as rate x
 *      days in that month, which is why it steps between 28 and 31 day months
 *      rather than running flat. The pressure permit is not a rate and does run
 *      flat.
 *   2. H-10 filing runs about fourteen months behind, far further than the
 *      three-month production lag. Months past `reportedThrough` are shaded,
 *      exactly as the production chart shades its unreported tail. Left
 *      unmarked they read as a well that stopped taking water.
 */
export function InjectionChart({
  monthly,
  reportedThrough,
  permittedBblPerDay,
  permittedPressurePsig,
  height = 260,
}: {
  /** Oldest-first, as `getWellInjection` returns it. */
  monthly: InjectionMonth[];
  /** Last substantially complete filing month, "YYYY-MM". */
  reportedThrough: string;
  /** Summed authorised rate across live permits; null hides the ceiling. */
  permittedBblPerDay: number | null;
  /** Highest authorised PSIG across live permits; null hides that ceiling. */
  permittedPressurePsig: number | null;
  height?: number;
}) {
  const [window, setWindow] = useState<InjectionWindow>("10Y");
  const [pressure, setPressure] = useState(false);
  const [ceiling, setCeiling] = useState(true);
  const [logScale, setLogScale] = useState(false);

  const series = useMemo(
    () =>
      buildInjectionSeries({
        monthly,
        window,
        permittedBblPerDay,
        permittedPressurePsig,
        showVolumeCeiling: ceiling,
        showPressure: pressure,
      }),
    [monthly, window, permittedBblPerDay, permittedPressurePsig, ceiling, pressure]
  );
  const { rows: seriesRows, hasPressure, showVolumeCeiling, showPressureCeiling, unreportedFrom, lastCycle } =
    series;
  // A log axis cannot plot 0: a month with no water injected becomes a gap,
  // and a pressure band that touches 0 is dropped rather than drawn to it.
  const rows = useMemo(() => {
    if (!logScale) return seriesRows;
    const pos = (v: number | null) => (v != null && v > 0 ? v : null);
    return seriesRows.map((r) => ({
      ...r,
      volume: pos(r.volume),
      pressure: pos(r.pressure),
      pressureMax: pos(r.pressureMax),
      pressureBand:
        r.pressureBand && r.pressureBand[0] > 0 ? r.pressureBand : null,
    }));
  }, [seriesRows, logScale]);

  const config = {
    volume: { label: "Injected (bbl)", color: "#0284c7" },
    permitted: { label: "Permitted (bbl)", color: "var(--muted-foreground)" },
    pressure: { label: "Avg pressure (PSIG)", color: "#b45309" },
    pressureMax: { label: "Max pressure (PSIG)", color: "#f59e0b" },
    pressureBand: { label: "Pressure range (PSIG)", color: "#f59e0b" },
    permittedPressure: { label: "Permitted (PSIG)", color: "#f59e0b" },
  } satisfies ChartConfig;

  return (
    /*
     * Sized to its CONTENT, like the production chart. Header, plot and footer
     * are all shrink-0 with a fixed pixel plot height, so as `flex-1` in a pane
     * with less room than their sum nothing could shrink and the footer drew on
     * top of the permit table below it. The pane scrolls instead.
     */
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Injection
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant={showVolumeCeiling ? "default" : "outline"}
            disabled={permittedBblPerDay == null || permittedBblPerDay <= 0}
            onClick={() => setCeiling((v) => !v)}
          >
            Permitted
          </Button>
          <Button
            size="xs"
            variant={pressure ? "default" : "outline"}
            disabled={!hasPressure}
            onClick={() => setPressure((v) => !v)}
          >
            Pressure
          </Button>
          <Button
            size="xs"
            variant={logScale ? "default" : "outline"}
            onClick={() => setLogScale((v) => !v)}
          >
            Log
          </Button>
          <div className="flex gap-1">
            {INJECTION_WINDOWS.map((w) => (
              <Button
                key={w.value}
                size="xs"
                variant={window === w.value ? "default" : "outline"}
                onClick={() => setWindow(w.value)}
              >
                {w.value}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <ChartContainer
        config={config}
        className="aspect-auto w-full shrink-0"
        style={{ height }}
      >
        <ComposedChart data={rows} margin={{ left: 8, right: 8, top: 8 }}>
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
            yAxisId="vol"
            tickLine={false}
            axisLine={false}
            width={52}
            scale={logScale ? "log" : "auto"}
            domain={logScale ? ["auto", "auto"] : undefined}
            allowDataOverflow={logScale}
            tickFormatter={(v: number) => compact.format(v)}
          />
          {pressure && (
            <YAxis
              yAxisId="psi"
              orientation="right"
              tickLine={false}
              axisLine={false}
              width={46}
              scale={logScale ? "log" : "auto"}
              domain={logScale ? ["auto", "auto"] : undefined}
              allowDataOverflow={logScale}
              tickFormatter={(v: number) => compact.format(v)}
            />
          )}
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(v) => fullMonth.format(monthDate(String(v)))}
              />
            }
          />
          <Area
            yAxisId="vol"
            dataKey="volume"
            type="monotone"
            stroke="var(--color-volume)"
            fill="var(--color-volume)"
            fillOpacity={0.12}
            strokeWidth={2}
            dot={false}
            connectNulls={logScale}
          />
          {showVolumeCeiling && (
            <Line
              yAxisId="vol"
              dataKey="permitted"
              type="stepAfter"
              stroke="var(--color-permitted)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              connectNulls
            />
          )}
          {pressure && (
            <>
              {/*
                * The band is a RANGE area: recharts reads a [low, high] pair on
                * the point and fills between them, so this is the spread from
                * the month's average up to its max rather than a second area
                * standing on the axis. It carries no tooltip row of its own
                * (`tooltipType="none"`) because the two numbers it is drawn
                * from are already listed there — a third row reading "900,1100"
                * is the pair leaking out of the renderer, not a fact.
                *
                * `connectNulls` is off on every pressure series, and the volume
                * ceiling keeps it on. That is not an inconsistency: a permit
                * holds through a month nobody filed, while a pressure reading
                * nobody took is unknown, and bridging it would draw a gauge
                * reading that does not exist.
                */}
              <Area
                yAxisId="psi"
                dataKey="pressureBand"
                type="monotone"
                stroke="none"
                fill="var(--color-pressureBand)"
                fillOpacity={0.16}
                dot={false}
                tooltipType="none"
                isAnimationActive={false}
              />
              <Line
                yAxisId="psi"
                dataKey="pressureMax"
                type="monotone"
                stroke="var(--color-pressureMax)"
                strokeWidth={1.5}
                dot={false}
              />
              <Line
                yAxisId="psi"
                dataKey="pressure"
                type="monotone"
                stroke="var(--color-pressure)"
                strokeWidth={1.5}
                dot={false}
              />
              {/*
                * Same dash and weight as the volume ceiling above, in the
                * pressure family's colour so it is unambiguous which axis it
                * belongs to. Drawn as a per-point series rather than a
                * ReferenceLine so the PSIG axis includes it in its domain: a
                * permit far above what the well has ever pulled must still be
                * on screen, or the headroom it is there to show is invisible.
                * When no live permit states a PSIG the series is not rendered
                * at all, and the column it would read is null besides. Never a
                * zero line along the axis pretending to be a permit.
                */}
              {showPressureCeiling && (
                <Line
                  yAxisId="psi"
                  dataKey="permittedPressure"
                  type="linear"
                  stroke="var(--color-permittedPressure)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                />
              )}
            </>
          )}
        </ComposedChart>
      </ChartContainer>

      <p className="shrink-0 text-xs leading-relaxed text-muted-foreground">
        Reported through {fullMonth.format(monthDate(reportedThrough))}. The
        shaded tail is months operators have not filed yet, not months the well
        sat idle — H-10 runs about a year behind.
        {showVolumeCeiling
          ? " The grey dashed line is the permitted daily volume times the days in each month."
          : ""}
      </p>
    </div>
  );
}
