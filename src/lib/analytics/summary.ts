import "server-only";
import { memoScope, withRequestScope } from "@/lib/cache/request-cache";
import { hasSupabase } from "@/lib/env";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import {
  cachedTankReadings,
  cachedTankTickets,
  cachedTanks,
} from "@/lib/cache/loaders";
import { getCompanyProduction } from "@/lib/reports/production-data";
import { getBenchmarkPrice } from "@/lib/pricing/feed";
import { getOrgRealization, modelsFor, PRIOR_MODELS } from "@/lib/pricing/realization";
import { OIL_PRICE_PER_BBL, GAS_PRICE_PER_MCF } from "@/lib/analytics/types";
import {
  DEFAULT_GAS_FACTOR,
  DEFAULT_OIL_FACTOR,
  type DeclineSummary,
} from "@/lib/analytics/summary-calc";
import {
  declineFrom,
  declineWindow,
  EMPTY_DECLINE,
  factorsFrom,
  pricesFrom,
  revenuePerDayFrom,
  type RealizationFactors,
  type SummaryPrices,
} from "@/lib/analytics/summary-pure";
import {
  buildTankLevelSeries,
  deriveSegments,
  latestSegmentRate,
} from "@/lib/tanks/tank-series";
import { getCompanyRates } from "@/lib/analytics/company-rates";

/**
 * Analytics summary stats — the headline cards above the charts. Fuses the
 * measurement layer (tank gauges, gas meters) with the pricing + accounting
 * layers into three numbers, using the pure math in `./summary-calc`:
 *
 *  - **Est. daily production**: the sum of every active producing well's rate,
 *    each a 14-day EMA of that well's own measured series — the SAME numbers
 *    the Facilities cards show, so the headline is their total by construction
 *    (`@/lib/analytics/company-rates`).
 *  - **Est. 24h revenue**: that production valued at the *realized* price —
 *    the latest WTI / Henry Hub tick scaled by what the operator
 *    historically collected relative to the benchmark (factor 1 until there's
 *    revenue history to measure a basis differential from).
 *  - **Cumulative decline**: every well's per-stream annual decline, blended by
 *    each stream's dollar value into one same-well company decline rate.
 *
 * All reads go through the request-scoped RLS client, so the numbers are scoped
 * to the caller's org.
 */

/**
 * The pure half (the price read-out, the lease-by-lease revenue, the decline)
 * lives in `summary-pure.ts` so the device can run it too; the types it
 * defines are re-exported here for the routes that read them.
 */
export type { RealizationFactors, SummaryPrices } from "@/lib/analytics/summary-pure";

export interface AnalyticsSummary {
  /** Est. daily production. */
  oilBblPerDay: number;
  gasMcfPerDay: number;
  /**
   * Est. daily produced water, bbl/day — the water tanks' rate, derived exactly
   * as the oil rate is. Not on the dashboard's cards; the Facilities header
   * shows it beside oil and gas, and it lives here so all three come from one
   * derivation and cannot disagree.
   */
  waterBblPerDay: number;
  /** Latest reading date the oil rate is anchored on (production freshness). */
  asOf: string | null;
  /** Est. 24h revenue at realized prices, USD. */
  revenuePerDay: number;
  prices: SummaryPrices;
  decline: DeclineSummary;
}

const EMPTY: AnalyticsSummary = {
  oilBblPerDay: 0,
  gasMcfPerDay: 0,
  waterBblPerDay: 0,
  asOf: null,
  revenuePerDay: 0,
  prices: {
    oilPerBbl: OIL_PRICE_PER_BBL,
    gasPerMcf: GAS_PRICE_PER_MCF,
    oilFactor: DEFAULT_OIL_FACTOR,
    gasFactor: DEFAULT_GAS_FACTOR,
    measured: false,
    models: PRIOR_MODELS,
  },
  decline: EMPTY_DECLINE,
};

/**
 * Just the realization models — the ledger + price-feed reads ONLY, none of the
 * tank / meter / decline work `getAnalyticsSummary` does. For callers that need
 * to value a volume and nothing else (the production chart's est. revenue).
 *
 * Same fit as the summary cards, so the two can't disagree.
 */
export async function getRealizationFactors(
  leaseId?: string | null
): Promise<RealizationFactors> {
  if (!hasSupabase()) {
    return {
      oilFactor: DEFAULT_OIL_FACTOR,
      gasFactor: DEFAULT_GAS_FACTOR,
      measured: false,
      models: PRIOR_MODELS,
    };
  }
  const [org, oilDayAvg, gasDayAvg] = await Promise.all([
    getOrgRealization(),
    getBenchmarkPrice("oil"),
    getBenchmarkPrice("gas"),
  ]);
  const models = modelsFor(org, leaseId);
  return factorsFrom(
    models,
    oilDayAvg ?? OIL_PRICE_PER_BBL,
    gasDayAvg ?? GAS_PRICE_PER_MCF
  );
}

/** The realized prices, with the models that produced them. */
export type RealizedPrices = SummaryPrices;

/**
 * The two price scalars, and NOTHING else.
 *
 * Most callers of {@link getAnalyticsSummary} only ever read `summary.prices`
 * (the /production revenue column, the tank / meter / battery / lease pages), and
 * were paying the entire company-wide production derivation for them. This is
 * that half on its own: the ledger + price feed, no wells, no series.
 *
 * {@link loadAnalyticsSummary} computes its prices through the same helper below,
 * so the summary cards and every page that prices a volume cannot disagree.
 */
export async function getRealizedPrices(
  leaseId?: string | null
): Promise<RealizedPrices> {
  if (!hasSupabase()) return EMPTY.prices;

  const [oilDayAvg, gasDayAvg, org] = await realizedPriceInputs();
  return pricesFrom(oilDayAvg, gasDayAvg, modelsFor(org, leaseId));
}

/**
 * The reads behind `getRealizedPrices`, memoized for the request. None of them
 * depend on the lease: the lease only selects a model from the org's
 * realization AFTER the read. So a page can start them in its first tick with
 * `primeRealizedPrices()` and ask for a lease's prices later without a wave
 * of its own; the tank page paid ~700ms for that wave (statements,
 * transactions, categories) after everything else had landed.
 */
function realizedPriceInputs() {
  return memoScope("realized-price-inputs", () =>
    Promise.all([
      getBenchmarkPrice("oil"),
      getBenchmarkPrice("gas"),
      getOrgRealization(),
    ])
  );
}

/** Start the realized-price reads now; `getRealizedPrices` will find them. */
export function primeRealizedPrices(): void {
  if (!hasSupabase()) return;
  realizedPriceInputs().catch(() => {});
}

/**
 * Memoized for the request: the dashboard renders the summary cards, the well
 * table and the AI brief in one page load, and each used to pay the full
 * company-wide production read on its own.
 */
export function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  return withRequestScope(() =>
    memoScope("analytics-summary", loadAnalyticsSummary)
  );
}

async function loadAnalyticsSummary(): Promise<AnalyticsSummary> {
  if (!hasSupabase()) return EMPTY;
  const sb = await getRequestSupabase();

  const { cutoffDate, currentMonth } = declineWindow();

  const [tanks, production, oilDayAvg, gasDayAvg, org] =
    await Promise.all([
      // Oil tanks only for `asOf` now — the rates come from the per-well EMAs.
      cachedTanks(sb),
      getCompanyProduction(undefined, { since: cutoffDate }),
      getBenchmarkPrice("oil"),
      getBenchmarkPrice("gas"),
      getOrgRealization(),
    ]);

  /*
   * --- Est. daily production -----------------------------------------------
   *
   * The company's rate is the SUM OF ITS WELLS' rates — each a 14-day EMA of
   * that well's own measured series, and each one the number that well's card
   * carries on the Facilities map (`@/lib/analytics/company-rates`). One
   * derivation, so the headline and the cards under it cannot disagree;
   * `well-rates.test.ts` pins the arithmetic.
   *
   * This replaced three separate estimators over three populations: the last
   * gauge interval of every active oil tank, the gas meters' latest readings,
   * and a 30-day trailing produced-water rate. Each was defensible alone and
   * none of them added up to what the map showed.
   */
  const { totals, perWell, leaseByWell } = await getCompanyRates();
  const oilBblPerDay = totals.oil;
  const gasMcfPerDay = totals.gas;
  const waterBblPerDay = totals.water;

  /*
   * `asOf` is still the gauges' freshness, not the rate's: the newest tank
   * interval behind the oil number. It answers "how current is this", which the
   * EMA itself cannot.
   */
  const oilTanks = tanks.filter((t) => t.active && t.product === "oil");
  const perTankAsOf = await Promise.all(
    oilTanks.map(async (t) => {
      const [readings, tickets] = await Promise.all([
        cachedTankReadings(sb, t.id),
        cachedTankTickets(sb, t.id),
      ]);
      const segments = deriveSegments(buildTankLevelSeries(readings, tickets));
      return latestSegmentRate(segments)?.asOf ?? null;
    })
  );
  let asOf: string | null = null;
  for (const stamp of perTankAsOf) {
    if (stamp != null && (asOf == null || stamp > asOf)) asOf = stamp;
  }

  /*
   * --- Realized prices, and revenue as the SUM OF PRICED LEASES -------------
   *
   * `prices` is the company-wide read-out, and it is what the card DISPLAYS.
   * Revenue is not computed from it. Each well's volume is valued at its own
   * lease's realized price and the results are added up, because one company
   * price against one company volume is blind to mix: when a cheap lease grows
   * and a rich one declines, revenue falls and a blended factor holds it flat.
   * The spread that makes this matter is real — a 2.5x range inside a single
   * settlement statement once condensate is involved.
   */
  const prices = pricesFrom(oilDayAvg, gasDayAvg, org.company);
  const revenuePerDay = revenuePerDayFrom(perWell, leaseByWell, org, oilDayAvg, gasDayAvg, prices);

  // --- Cumulative decline ---------------------------------------------------
  // `production` was already fetched windowed to `cutoffDate`; `declineFrom`
  // still applies the upper bound (complete months only).
  const decline: DeclineSummary = declineFrom(production, { cutoffDate, currentMonth }, prices);

  return {
    oilBblPerDay,
    gasMcfPerDay,
    waterBblPerDay,
    asOf,
    revenuePerDay,
    prices,
    decline,
  };
}
