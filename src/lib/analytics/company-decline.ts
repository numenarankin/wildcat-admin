import "server-only";

import { hasSupabase } from "@/lib/env";
import { memoScope, withRequestScope } from "@/lib/cache/request-cache";
import { getCompanyProduction } from "@/lib/reports/production-data";
import type { CompanyProductionRow } from "@/lib/reports/types";
import { getRealizedPrices } from "@/lib/analytics/summary";
import { currentStreamRate, ownDateSeries, streamAsOf } from "@/lib/analytics/ema";
import {
  fleetDecline,
  FLEET_PROJECTION_MONTHS,
  wellUnitKey,
  type FleetDecline,
  type FleetStream,
  type UnitStream,
} from "@/lib/analytics/fleet-decline";
import { EMA_DAYS } from "@/lib/leases/revenue";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { cachedWells } from "@/lib/wells/wells";
import { listAllInterests } from "@/lib/interest/interest";
import { ASSUMED_NRI, operatorNriByLease } from "@/lib/interest/gross-net";
import { rrcProductionHorizon } from "@/lib/rrc/record-currency";
import { monthlyRatesFromPoints } from "@/lib/wells/arps";

/**
 * The dashboard's "Proj. 12-mo decline", assembled: every well's oil and gas
 * as a fitted curve anchored at its current rate, summed forward
 * (`./fleet-decline` — read that first; this file only builds its input).
 *
 * ## The units
 *
 * One unit per WELL. A lease's decline is then its wells' curves summed
 * (`unitDecline` over `wellUnitKeys`), not a curve fitted through the lease's
 * summed series: two wells on one lease declining at different rates change
 * their shares of the lease as the faster one falls away, and a single fit
 * through the sum cannot see that. The company is every well summed the same
 * way, so the card, the lease rows and the well rows under them are one
 * projection read at three grains.
 *
 * ## Each well's series
 *
 * The operator's own measured production — the SAME per-well daily rows the
 * chart plots (`getCompanyProduction`). Those rows are the battery's
 * production multiplied by each well's allocation IN EFFECT ON THAT DAY, period
 * by period, so a well whose share was 60% last year and is 40% now carries
 * last year's 60% in last year's rows. That is the series its curve is fitted
 * over; the current share is never projected back over history, which would
 * hand every well on the lease the lease's decline.
 *
 * The state's monthly filings are NOT in the series. The public record is an
 * estimate drawn behind the charts for context; it never enters a fit or an
 * allocation, so a well's curve is the operator's own measurements and nothing
 * else. Days a stream was not measured are left out, not read as zero
 * (`CompanyProductionRow.measured`).
 *
 * ## Each well's current rate, and its weight
 *
 * Its 14-day EMA, read as of its own last reading or the record's horizon,
 * whichever is later — the rule `/leases` prices by (`currentStreamRate`).
 * Its weight in the sum is those barrels priced and then NETTED by its
 * lease's interest (`UnitStream.nri`, the same recorded-or-assumed NRI the
 * revenue card nets by), so the card is the decline of the operator's net
 * revenue rather than of the field's gross: a lease they keep 80% of counts
 * four times one they keep 20% of.
 *
 * ## Cost
 *
 * No new production read: the rows are the chart's. One public-record pass for
 * the fleet, batched by record and concurrent across records. This runs behind
 * `/api/analytics/company`, off the page's critical path, and once per request
 * scope after that.
 */

export interface CompanyDecline extends FleetDecline {
  /** Wells the fleet was assembled from. */
  units: number;
}

const EMPTY: CompanyDecline = {
  annual: null,
  byUnit: {},
  coverage: 0,
  producing: 0,
  fitted: 0,
  projection: { oil: [], gas: [], boe: [] },
  anchorMonth: "",
  units: 0,
};

const LOG = "[company-decline]";

export function getCompanyDecline(): Promise<CompanyDecline> {
  return withRequestScope(() => memoScope("company-decline", load));
}

/** A dated volume, the shape both `monthlyRatesFromPoints` and the EMA read. */
export interface Point {
  date: string;
  value: number;
}

/**
 * Pure: each well's own measured series per stream, oldest first, from the
 * allocated daily rows. A row's volume is taken AS ALLOCATED ON ITS DATE; a
 * stream a row did not measure contributes no point. Exported for the test
 * that pins that.
 */
export function ownSeriesByWell(
  production: readonly Pick<CompanyProductionRow, "wellId" | "date" | "oilProduction" | "gasProduction" | "measured">[]
): Map<string, Record<FleetStream, Point[]>> {
  const byDate = new Map<string, Record<FleetStream, Map<string, number>>>();
  for (const r of production) {
    let d = byDate.get(r.wellId);
    if (!d) {
      d = { oil: new Map(), gas: new Map() };
      byDate.set(r.wellId, d);
    }
    const measured = r.measured ?? { oil: true, gas: true, water: true };
    if (measured.oil) d.oil.set(r.date, (d.oil.get(r.date) ?? 0) + r.oilProduction);
    if (measured.gas) d.gas.set(r.date, (d.gas.get(r.date) ?? 0) + r.gasProduction);
  }
  const out = new Map<string, Record<FleetStream, Point[]>>();
  for (const [wellId, d] of byDate) {
    const series = { oil: [] as Point[], gas: [] as Point[] };
    for (const stream of ["oil", "gas"] as const) {
      series[stream] = [...d[stream].entries()]
        .map(([date, value]) => ({ date, value }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    out.set(wellId, series);
  }
  return out;
}

/**
 * Pure: every well's two streams as the fit reads them — the record first, cut
 * before the first own reading, then the own series; the current rate its
 * 14-day EMA carried to the later of its last day and the record's horizon.
 * Shared with the backtest, which feeds it truncated series.
 */
/**
 * Several wells' series added up by date: a lease's (or any group's) own
 * measured series, built from the same per-well rows the fleet fits so a
 * curve drawn over it and the fleet's sum of the wells' curves read one
 * history. The lease page fits its chart on this.
 */
export function summedSeries(
  own: ReadonlyMap<string, Record<FleetStream, Point[]>>
): Record<FleetStream, Point[]> {
  const out = { oil: [] as Point[], gas: [] as Point[] };
  for (const stream of ["oil", "gas"] as const) {
    const byDate = new Map<string, number>();
    for (const series of own.values()) {
      for (const p of series[stream]) byDate.set(p.date, (byDate.get(p.date) ?? 0) + p.value);
    }
    out[stream] = [...byDate.entries()]
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return out;
}

export function streamsFrom(
  own: ReadonlyMap<string, Record<FleetStream, Point[]>>,
  horizon: string | null,
  /** Well id → its lease's NRI; a well not listed is netted at `ASSUMED_NRI`. */
  nriByWell: ReadonlyMap<string, number> = new Map(),
  /** Well id → its lease's realized prices; a well not listed takes the fleet's. */
  priceByWell: ReadonlyMap<string, { oilPerBbl: number; gasPerMcf: number }> = new Map()
): { streams: UnitStream[] } {
  const streams: UnitStream[] = [];
  for (const [wellId, series] of own) {
    for (const stream of ["oil", "gas"] as const) {
      const ownPoints = series[stream];
      const points = ownPoints;
      if (points.length === 0) continue;

      const rates = monthlyRatesFromPoints(
        points.map((p) =>
          stream === "oil"
            ? { date: p.date, oilProduction: p.value }
            : { date: p.date, gasProduction: p.value }
        ),
        stream
      );
      const dated = ownDateSeries({
        s: points.map((p) => ({ date: p.date, rate: p.value })),
      }).s;
      const fallback = ownPoints[ownPoints.length - 1].value;
      streams.push({
        unit: wellUnitKey(wellId),
        stream,
        rates,
        current: currentStreamRate(dated, fallback, horizon, EMA_DAYS),
        nri: nriByWell.get(wellId) ?? ASSUMED_NRI,
        price: stream === "oil" ? priceByWell.get(wellId)?.oilPerBbl : priceByWell.get(wellId)?.gasPerMcf,
        asOf: streamAsOf(dated.lastDate, horizon),
      });
    }
  }
  return { streams };
}

async function load(): Promise<CompanyDecline> {
  if (!hasSupabase()) return EMPTY;
  const startedAt = Date.now();
  const sb = await getRequestSupabase();
  const [production, prices, horizon, wells, interests] = await Promise.all([
    getCompanyProduction(),
    getRealizedPrices(),
    rrcProductionHorizon(),
    cachedWells(sb),
    listAllInterests(sb),
  ]);
  // Interest is held on the lease; a well inherits its lease's. Same rule and
  // same fallback as the dashboard's revenue rows (`nriOf` in lease-summaries).
  const nriByLease = operatorNriByLease(interests);
  const nriByWell = new Map<string, number>();
  for (const w of wells) {
    if (w.leaseId && nriByLease[w.leaseId] != null) nriByWell.set(w.id, nriByLease[w.leaseId]);
  }

  // Each well sells at ITS lease's realized prices, so a well on a lease that
  // settles gas at twice the price carries twice the weight per MCF. One
  // selection per lease off the inputs already read (`getRealizedPrices`).
  const leaseIds = [...new Set(wells.map((w) => w.leaseId).filter((id): id is string => !!id))];
  const priceByLease = new Map(
    await Promise.all(leaseIds.map(async (id) => [id, await getRealizedPrices(id)] as const))
  );
  const priceByWell = new Map<string, { oilPerBbl: number; gasPerMcf: number }>();
  for (const w of wells) {
    const p = w.leaseId ? priceByLease.get(w.leaseId) : undefined;
    if (p) priceByWell.set(w.id, { oilPerBbl: p.oilPerBbl, gasPerMcf: p.gasPerMcf });
  }

  const own = ownSeriesByWell(production);
  const { streams } = streamsFrom(own, horizon, nriByWell, priceByWell);

  const fleet = fleetDecline(
    streams,
    { oilPerBbl: prices.oilPerBbl, gasPerMcf: prices.gasPerMcf },
    new Date(),
    FLEET_PROJECTION_MONTHS
  );
  const result: CompanyDecline = { ...fleet, units: own.size };
  console.info(
    `${LOG} ${Date.now() - startedAt}ms wells=${result.units} streams=${streams.length} producing=${result.producing} ` +
      `fitted=${result.fitted} coverage=${(result.coverage * 100).toFixed(0)}% ` +
      `horizon=${horizon ?? "none"} ` +
      (result.annual == null
        ? "annual=none (no producing stream has six post-peak months to fit)"
        : `annual=${(result.annual * 100).toFixed(2)}%/yr`)
  );
  return result;
}
