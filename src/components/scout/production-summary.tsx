"use client";

import { useMemo } from "react";
import { fitDecline, forward12moDecline, type MonthlyRate } from "@/lib/wells/arps";
import { fmtVol } from "@/lib/scout/format";
import type { LeaseMonth } from "@/lib/scout/rrc-types";
import {
  GAS_KEYS,
  monthlyRate,
  OIL_KEYS,
  streamOf,
} from "@/lib/scout/allocate-months";

/*
 * ===========================================================================
 * PRODUCTION SUMMARY — the stat row above a production chart.
 * ===========================================================================
 *
 * Pure function of `LeaseMonth[]`; no fetching. Drop it above `ProductionChart`
 * on any surface that has a monthly series (lease modal, operator modal).
 * Nothing to wire beyond passing the same array the chart gets.
 */

/**
 * The headline row above a production chart: the average month over the
 * trailing year and the fitted decline, **per stream** — oil and gas decline at
 * different rates on the same
 * lease, and a single blended number hides which one is falling away.
 *
 * The fit is the app's Modified Arps (`@/lib/wells/arps`), the same one the well
 * and lease pages use, run over reported+filed months only: an unfiled month is
 * a zero in the series and would read as a collapse.
 */
function declineFor(
  monthly: LeaseMonth[],
  keys: readonly (keyof LeaseMonth)[]
): number | null {
  const rates: MonthlyRate[] = monthly
    .filter((m) => m.reported && m.prod_report_filed !== "N")
    .map((m) => ({ month: m.cycle, rate: streamOf(m, keys) }))
    .filter((r) => r.rate > 0);
  const fit = fitDecline(rates);
  return fit ? forward12moDecline(fit) : null;
}

const pct = (v: number | null) =>
  v == null ? "—" : `${(v * 100).toFixed(1)}%/yr`;

export function ProductionSummary({ monthly }: { monthly: LeaseMonth[] }) {
  const stats = useMemo(() => {
    const oilMo = monthlyRate(monthly, OIL_KEYS);
    const gasMo = monthlyRate(monthly, GAS_KEYS);
    return {
      oilMo,
      gasMo,
      oilDecline: oilMo > 0 ? declineFor(monthly, OIL_KEYS) : null,
      gasDecline: gasMo > 0 ? declineFor(monthly, GAS_KEYS) : null,
      lastReported: [...monthly].reverse().find((m) => m.reported)?.cycle ?? "—",
      unfiled: monthly.filter((m) => m.reported && m.prod_report_filed === "N").length,
    };
  }, [monthly]);

  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
      <Cell label="Oil · per month" value={`${fmtVol(Math.round(stats.oilMo))} bbl`} />
      <Cell label="Oil decline" value={pct(stats.oilDecline)} />
      <Cell
        label="Gas · per month"
        value={`${fmtVol(Math.round(stats.gasMo))} MCF`}
        title={`Through ${stats.lastReported}. ${stats.unfiled} month${
          stats.unfiled === 1 ? "" : "s"
        } published by the RRC with no production report filed; those read as zero volume and are excluded from the decline fit.`}
      />
      <Cell label="Gas decline" value={pct(stats.gasDecline)} />
    </div>
  );
}

/**
 * One figure, two lines, no third.
 *
 * Deliberately tighter than the `Stat` card the other tabs use: this row sits
 * directly above a chart that needs the vertical room more than the numbers do.
 */
function Cell({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      className="flex flex-col gap-0.5 rounded-[0.15rem] border px-3 py-2"
    >
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
    </div>
  );
}
