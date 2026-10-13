"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { TableBox, THead, Th } from "./modal-ui";
import type { DispositionMonth, DispositionStream } from "@/lib/scout/rrc-types";

/*
 * ===========================================================================
 * DISPOSITION PANEL — where the hydrocarbons went, by RRC disposition code.
 * ===========================================================================
 *
 * DATA IT NEEDS
 *   disposition: Record<"oil"|"gas"|"cond"|"csgd", DispositionMonth[]>
 *   where DispositionMonth = { cycle: "YYYY-MM", codes: { "00": 12345, ... } }
 *
 * WIRING NOTES
 *   - Source is `lease_cycle_disp`, which is 44 volume columns named
 *     LEASE_<STREAM>_DISPCD<NN>_VOL (casinghead uses DISPCDE<NN>). PIVOT them
 *     into the `codes` map rather than passing 44 fields: the component ranks
 *     codes itself and only charts the top few.
 *   - Codes present per stream: oil/cond 00-09 + 99, gas 01-09 + 99, csgd
 *     01-08 + 99. Statewide the mix is lopsided (oil: 00 = 65.6%, 01 = 34.2%),
 *     which is why the chart shows the top three and folds the rest.
 *   - For an operator, sum the same table across their leases before passing.
 *
 * See also the note below on why the codes are not labelled.
 */

/**
 * Where the hydrocarbons went, by RRC disposition code.
 *
 * The RRC publishes 44 disposition volume columns, but the statewide mix is
 * lopsided enough that charting all of them would be noise: oil is two codes
 * (00 = 65.6%, 01 = 34.2%), gas is three (02 = 61.5%, 03 = 33.6%, 09 = 2.5%).
 * So the chart draws the top codes for the stream and folds the rest into
 * "Other" — which the table below expands, so nothing is hidden, just not
 * plotted.
 *
 * CODES ARE UNLABELLED ON PURPOSE. The code -> meaning lookup (stock, gathering
 * system, lease use, vented/flared, ...) is not in the mirror; it comes from the
 * RRC PDQ manual. A mislabelled "flared" number is worse than a raw code, so
 * this ships with codes until that lookup exists — see
 * `docs/plans/scout-rrc-mirror-ui.md` §5.
 */

const STREAMS: { key: DispositionStream; label: string; unit: string }[] = [
  { key: "oil", label: "Oil", unit: "bbl" },
  { key: "gas", label: "Gas", unit: "MCF" },
  { key: "cond", label: "Condensate", unit: "bbl" },
  { key: "csgd", label: "Casinghead", unit: "MCF" },
];

/** Enough hues to cover the 3-4 codes that ever matter, plus Other. */
const SERIES_COLORS = ["#059669", "#800000", "#4169e1", "#b45309", "#6b7280"];
const TOP_N = 3;
const OTHER = "other";

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

export function DispositionPanel({
  disposition,
  months = 120,
  height = 180,
}: {
  disposition: Record<DispositionStream, DispositionMonth[]>;
  months?: number;
  /** Chart height; the code table takes whatever is left. */
  height?: number;
}) {
  const [stream, setStream] = useState<DispositionStream>("oil");
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(
    () => (disposition[stream] ?? []).slice(-months),
    [disposition, stream, months]
  );

  // Rank codes by lifetime volume, then split into charted + Other.
  const { top, rest, totals, grand } = useMemo(() => {
    const totals = new Map<string, number>();
    for (const m of rows) {
      for (const [code, v] of Object.entries(m.codes)) {
        totals.set(code, (totals.get(code) ?? 0) + v);
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const grand = ranked.reduce((a, [, v]) => a + v, 0) || 1;
    return {
      top: ranked.slice(0, TOP_N).map(([code]) => code),
      rest: ranked.slice(TOP_N).map(([code]) => code),
      totals: ranked,
      grand,
    };
  }, [rows]);

  const data = useMemo(
    () =>
      rows.map((m) => {
        const row: Record<string, number | string> = { cycle: m.cycle };
        for (const code of top) row[`c${code}`] = m.codes[code] ?? 0;
        row[OTHER] = rest.reduce((a, code) => a + (m.codes[code] ?? 0), 0);
        return row;
      }),
    [rows, top, rest]
  );

  const config = Object.fromEntries([
    ...top.map((code, i) => [
      `c${code}`,
      { label: `Code ${code}`, color: SERIES_COLORS[i] },
    ]),
    [OTHER, { label: "Other codes", color: SERIES_COLORS[4] }],
  ]) satisfies ChartConfig;

  const unit = STREAMS.find((s) => s.key === stream)!.unit;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-1">
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

      <ChartContainer
        config={config}
        className="aspect-auto w-full shrink-0"
        style={{ height }}
      >
        <AreaChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
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
            tickFormatter={(v: number) => compact.format(v)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(v) => fullMonth.format(monthDate(String(v)))}
              />
            }
          />
          {top.map((code) => (
            <Area
              key={code}
              dataKey={`c${code}`}
              type="monotone"
              stackId="d"
              stroke={`var(--color-c${code})`}
              fill={`var(--color-c${code})`}
              fillOpacity={0.5}
            />
          ))}
          <Area
            dataKey={OTHER}
            type="monotone"
            stackId="d"
            stroke={`var(--color-${OTHER})`}
            fill={`var(--color-${OTHER})`}
            fillOpacity={0.4}
          />
        </AreaChart>
      </ChartContainer>

      <TableBox>
        <table className="w-full text-sm">
          <THead>
            <Th>Disposition code</Th>
            <Th right>Volume ({unit})</Th>
            <Th right>Share</Th>
          </THead>
          <tbody className="divide-y">
            {(expanded ? totals : totals.slice(0, TOP_N + 1)).map(([code, v]) => (
              <tr key={code} className="hover:bg-muted">
                <td className="px-3 py-1.5">
                  <span className="font-mono text-xs">{code}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    label pending the RRC PDQ code table
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {v.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {((100 * v) / grand).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>

      {totals.length > TOP_N + 1 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-left text-xs text-primary hover:underline"
        >
          {expanded
            ? "Show top codes only"
            : `Show all ${totals.length} disposition codes`}
        </button>
      )}
    </div>
  );
}
