/**
 * The pure half of the analytics summary: reading the fitted realization at a
 * benchmark, valuing a day's rates lease by lease, and the company decline.
 *
 * Split out of `summary.ts` (which stays the server loader) so the device can
 * run the same arithmetic over its own mirror and its cached price snapshot.
 * Nothing here reads a feed, a ledger or a database; every input is handed in.
 */
import type { CompanyProductionRow } from "@/lib/reports/types";
import { boeForward12Decline } from "@/lib/charts/decline-rows";
import { monthlyRateSeries } from "@/lib/analytics/monthly-rates";
import { OIL_PRICE_PER_BBL, GAS_PRICE_PER_MCF } from "@/lib/analytics/types";
import {
  aggregateDecline,
  wellStreamsForDeclineArps,
  DECLINE_LOOKBACK_MONTHS,
  type DeclineRow,
  type DeclineSummary,
} from "@/lib/analytics/summary-calc";
import { modelsFor, type OrgRealization, type RealizationModels } from "@/lib/pricing/realization";
import { effectiveFactor } from "@/lib/pricing/realization-model";
import { realizedPriceByDate } from "@/lib/pricing/daily-realized";
import type { PricePoint } from "@/lib/pricing/types";

export interface SummaryPrices {
  /** Realized oil price used to value production, USD/bbl. */
  oilPerBbl: number;
  /** Realized gas price used to value production, USD/MCF. */
  gasPerMcf: number;
  /**
   * Realized ÷ benchmark at the CURRENT benchmark levels, for display. A
   * read-out of the model at one point, not the model itself: it moves as the
   * benchmark moves, because a fixed deduct is a bigger share of a cheap barrel
   * than an expensive one.
   */
  oilFactor: number;
  gasFactor: number;
  /** False when either model fell back to its prior (thin ledger) — show "est.". */
  measured: boolean;
  /**
   * The fitted models themselves. Surfaces that price a volume on a DATE (the
   * lease page, the exports, the digests) read these rather than the scalars
   * above, so the cross-commodity term survives.
   */
  models: RealizationModels;
}

/** The org's realization models, plus their read-out at today's benchmarks. */
export interface RealizationFactors {
  oilFactor: number;
  gasFactor: number;
  /** False when either model fell back to its prior (thin ledger) — show "est.". */
  measured: boolean;
  /** The models themselves, for anything pricing a volume on a DATE. */
  models: RealizationModels;
}

export const EMPTY_DECLINE: DeclineSummary = {
  blended: null,
  oil: null,
  gas: null,
  wellsCovered: 0,
  wellsTotal: 0,
  revenueCoveredPct: 0,
};

/** Pure: today's effective factors from already-fitted models. */
export function factorsFrom(
  models: RealizationModels,
  oilBenchmark: number,
  gasBenchmark: number
): RealizationFactors {
  return {
    oilFactor: effectiveFactor(models.oil, oilBenchmark, gasBenchmark),
    gasFactor: effectiveFactor(models.gas, gasBenchmark, oilBenchmark),
    measured: models.measured,
    models,
  };
}

/**
 * Pure: read the fitted models at today's benchmarks.
 *
 * Both commodities are priced from BOTH benchmarks. A gas stream carrying
 * condensate settles partly off crude, so valuing an MCF reads WTI as well as
 * Henry Hub; the model decides how much that matters, and says zero when the
 * operator's own statements show no such relationship.
 */
export function pricesFrom(
  oilDayAvg: number | null,
  gasDayAvg: number | null,
  models: RealizationModels
): SummaryPrices {
  const oilBenchmark = oilDayAvg ?? OIL_PRICE_PER_BBL;
  const gasBenchmark = gasDayAvg ?? GAS_PRICE_PER_MCF;
  const factors = factorsFrom(models, oilBenchmark, gasBenchmark);
  return {
    oilPerBbl: oilBenchmark * factors.oilFactor,
    gasPerMcf: gasBenchmark * factors.gasFactor,
    oilFactor: factors.oilFactor,
    gasFactor: factors.gasFactor,
    measured: factors.measured,
    models,
  };
}

/**
 * Est. 24h GROSS revenue as the SUM OF PRICED LEASES.
 *
 * `prices` is the company-wide read-out, and it is what the card DISPLAYS.
 * Revenue is not computed from it. Each well's volume is valued at its own
 * lease's realized price and the results are added up, because one company
 * price against one company volume is blind to mix: when a cheap lease grows
 * and a rich one declines, revenue falls and a blended factor holds it flat.
 * The spread that makes this matter is real — a 2.5x range inside a single
 * settlement statement once condensate is involved.
 */
export function revenuePerDayFrom(
  perWell: ReadonlyMap<string, { oil: number; gas: number }>,
  leaseByWell: ReadonlyMap<string, string | null>,
  org: OrgRealization,
  oilDayAvg: number | null,
  gasDayAvg: number | null,
  prices: SummaryPrices
): number {
  const leasePrices = leasePricer(org, oilDayAvg, gasDayAvg, prices);

  let revenuePerDay = 0;
  for (const [wellId, rate] of perWell) {
    const p = leasePrices(leaseByWell.get(wellId) ?? null);
    revenuePerDay += rate.oil * p.oilPerBbl + rate.gas * p.gasPerMcf;
  }
  return revenuePerDay;
}

/**
 * What one lease's barrel and MCF are worth: its own fitted realization read at
 * today's benchmarks, falling back to the company model when the lease has none
 * of its own (`modelsFor`). Memoized per lease across the returned function's
 * life, so a table with a row per lease fits nothing twice.
 *
 * Factored out of {@link revenuePerDayFrom} so the dashboard's per-lease revenue
 * COLUMN and the company revenue CARD price a barrel the same way. Two
 * transcriptions of the same fallback rule is how they start to disagree.
 */
export function leasePricer(
  org: OrgRealization,
  oilDayAvg: number | null,
  gasDayAvg: number | null,
  /** The company-wide read-out, reused verbatim for leases on the company model. */
  prices: SummaryPrices
): (leaseId: string | null) => SummaryPrices {
  const pricedByLease = new Map<string, SummaryPrices>();
  return (leaseId: string | null) => {
    const key = leaseId ?? "";
    const hit = pricedByLease.get(key);
    if (hit) return hit;
    const models = modelsFor(org, leaseId);
    const priced =
      models === org.company
        ? prices
        : pricesFrom(oilDayAvg, gasDayAvg, models);
    pricedByLease.set(key, priced);
    return priced;
  };
}

/** What a lease's barrel and MCF were worth over some past dates. */
export interface DatedPrices {
  oilPerBbl: number;
  gasPerMcf: number;
}

/**
 * What one lease's barrel and MCF were worth ON PAST DATES: its own realization
 * (the same `modelsFor` fallback as {@link leasePricer}) read at the daily
 * benchmark closes, averaged over the dates asked for. Business days only trade,
 * so a date takes the last close on or before it (`realizedPriceByDate`).
 *
 * This is the PREVIOUS side of the dashboard's revenue moves. The current side
 * is today's price on the last measured day (the figure the card shows), and
 * the previous side is the earlier day's barrels at the earlier day's price, so
 * the move is the change in what a day earns: production AND price. Valuing
 * both days at today's price, which this page used to do, showed a fleet making
 * exactly the same barrels as "flat" through a 10% drop in crude.
 *
 * With no history to read (the feed down, or a date the series never reaches),
 * `fallback` prices the day instead, which is the price-blind move of before
 * rather than a hole in the table. Memoized per lease and date set, so a lease
 * table prices each day once.
 */
export function datedLeasePricer(
  org: OrgRealization,
  oilHistory: readonly PricePoint[],
  gasHistory: readonly PricePoint[],
  fallback: (leaseId: string | null) => DatedPrices
): (leaseId: string | null, dates: readonly string[]) => DatedPrices {
  const memo = new Map<string, DatedPrices>();
  const oil = [...oilHistory];
  const gas = [...gasHistory];
  return (leaseId, dates) => {
    const key = `${leaseId ?? ""}|${dates.join(",")}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const models = modelsFor(org, leaseId);
    const wanted = [...dates];
    const oilOn = realizedPriceByDate(oil, gas, models.oil, wanted);
    const gasOn = realizedPriceByDate(gas, oil, models.gas, wanted);
    const today = fallback(leaseId);
    const priced: DatedPrices = {
      oilPerBbl: mean(wanted.map((d) => oilOn[d])) ?? today.oilPerBbl,
      gasPerMcf: mean(wanted.map((d) => gasOn[d])) ?? today.gasPerMcf,
    };
    memo.set(key, priced);
    return priced;
  };
}

/** Mean of the numbers present, or null when none are. */
function mean(values: readonly (number | undefined)[]): number | null {
  const present = values.filter((v): v is number => typeof v === "number");
  if (present.length === 0) return null;
  return present.reduce((s, v) => s + v, 0) / present.length;
}

/** The seven calendar days ending on `end`, oldest first. */
export function weekEnding(end: string): string[] {
  const endMs = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(endMs - (6 - i) * 86_400_000).toISOString().slice(0, 10)
  );
}

/**
 * Company oil and gas totals per month, from the per-well daily rows.
 *
 * The chart builds the same thing from its own monthly payload; both end up
 * dividing by the month's days (`monthlyRateSeries`) and fitting once, so the
 * card and the curve are one calculation read in two places.
 */
export function companyMonthlyTotals(
  rows: { date: string; oilProduction: number; gasProduction: number }[]
): { month: string; oilBbl: number; gasMcf: number }[] {
  const byMonth = new Map<string, { month: string; oilBbl: number; gasMcf: number }>();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    const cur = byMonth.get(month) ?? { month, oilBbl: 0, gasMcf: 0 };
    cur.oilBbl += r.oilProduction ?? 0;
    cur.gasMcf += r.gasProduction ?? 0;
    byMonth.set(month, cur);
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** The complete-month window fed to the decline fit: [cutoff, currentMonth). */
export function declineWindow(now: Date = new Date()): { cutoffDate: string; currentMonth: string } {
  const currentMonth = now.toISOString().slice(0, 7);
  const [y, m] = currentMonth.split("-").map(Number);
  // First day of the month DECLINE_LOOKBACK_MONTHS before the current one.
  const startMs = Date.UTC(y, m - 1 - DECLINE_LOOKBACK_MONTHS, 1);
  return { cutoffDate: new Date(startMs).toISOString().slice(0, 10), currentMonth };
}

/**
 * The summary API's TRAILING decline: one curve through the company's last
 * `DECLINE_LOOKBACK_MONTHS` of measured BOE.
 *
 * NOT the dashboard card. The card is the fleet's curves summed forward from
 * their current rates over all of history and the public record
 * (`company-decline`); this is a windowed fit of the company total, served by
 * `/api/analytics/summary` and the reconcile route, and it answers "how has the
 * measured total been trending" rather than "where is the fleet going". The
 * two are different questions and will give different numbers.
 *
 * Coverage comes from the per-well pass, which is what knows how many wells and
 * how much revenue the fit actually reached.
 *
 * `production` is already windowed to `cutoffDate`; the filter still applies
 * the upper bound (complete months only).
 */
export function declineFrom(
  production: Pick<CompanyProductionRow, "wellId" | "date" | "oilProduction" | "gasProduction">[],
  window: { cutoffDate: string; currentMonth: string },
  prices: Pick<SummaryPrices, "oilPerBbl" | "gasPerMcf">
): DeclineSummary {
  const { cutoffDate, currentMonth } = window;
  const declineRows: DeclineRow[] = production
    .filter((r) => r.date >= cutoffDate && r.date.slice(0, 7) < currentMonth)
    .map((r) => ({
      wellId: r.wellId,
      date: r.date,
      oilProduction: r.oilProduction,
      gasProduction: r.gasProduction,
    }));
  const coverage = aggregateDecline(
    wellStreamsForDeclineArps(declineRows),
    prices.oilPerBbl,
    prices.gasPerMcf
  );
  const monthlyTotals = companyMonthlyTotals(declineRows);
  return {
    ...coverage,
    blended:
      boeForward12Decline(
        monthlyRateSeries(monthlyTotals, (m) => m.oilBbl),
        monthlyRateSeries(monthlyTotals, (m) => m.gasMcf),
        prices
      ) ?? coverage.blended,
  };
}
