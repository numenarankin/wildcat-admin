import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { leaseProductionSeries, leaseWaterSeries } from "@/lib/tanks/series-loaders";
import { leaseGasDailySeries } from "@/lib/meters/engine";
import { leaseRrcMonths, leaseRrcSeries } from "@/lib/rrc/lease-history";
import { earliestMeasuredDate } from "@/lib/rrc/lease-history-series";
import { rrcProductionHorizon } from "@/lib/rrc/record-currency";
import { rateWindowFrom } from "@/lib/wells/rate-cache";
import { currentStreamRate, ownDateSeries } from "@/lib/analytics/ema";
import { getPriceHistory } from "@/lib/pricing/feed";
import { getRealizedPrices } from "@/lib/analytics/summary";
import {
  getOrgRealization,
  modelsFor,
  type RealizationModels,
} from "@/lib/pricing/realization";
import {
  effectiveFactor,
  predictRealized,
} from "@/lib/pricing/realization-model";

type Sb = SupabaseClient;

/** The moving-average window, in days, for BOTH production and price. */
export const MA_DAYS = 30;

/**
 * The production EMA window, in days. 14 because that is the window the lease
 * page's headline cards and the chart's `ema14` line use; the roster has to
 * read the same number for the same lease.
 */
export const EMA_DAYS = 14;

/**
 * Days in an average month. `365/12`, not 30 — a 30-day rate scaled by 30 is a
 * 30-day figure, and twelve of those fall five days short of a year.
 */
export const DAYS_PER_MONTH = 365 / 12;

/**
 * The price a barrel and an MCF are assumed to fetch this month.
 *
 * `oilPerBbl` / `gasPerMcf` are the 30-day moving average of BOTH BENCHMARKS
 * (the front-month contracts charted on /prices) read through the org's
 * realization model — the same fit `getRealizedPrices` uses, which measures
 * from the org's own ledger how its receipts track WTI and Henry Hub.
 *
 * The model is read from `getRealizedPrices` rather than refitted, so there is
 * exactly one definition of the adjustment in the app. Only the price BASE
 * differs: that function reads the model at a single day's average, which is
 * the right answer for "what is a barrel worth right now" and the wrong one for
 * a monthly figure, where one volatile session should not move the column.
 */
export interface AdjustedPrices {
  oilPerBbl: number;
  gasPerMcf: number;
  /** The adjustment factors applied, for display. */
  oilFactor: number;
  gasFactor: number;
  /** False when a factor fell back to a default (too thin a ledger to measure). */
  measured: boolean;
}

/**
 * What one lease is running at.
 *
 * Production is a DAILY rate and revenue is MONTHLY, which is the pairing the
 * industry actually reads: a lease is "a 10 barrel a day lease", and what it is
 * worth is a monthly cheque. The month is bridged by `DAYS_PER_MONTH`, so the
 * row still reconciles — rate x 365/12 x price is the revenue beside it.
 */
export interface LeaseEstimate {
  /** Latest oil rate on the series, barrels per day. */
  oilBblPerDay: number;
  /** Latest gas rate on the series, MCF per day. */
  gasMcfPerDay: number;
  /** Latest produced-water rate, barrels per day. Null when unmeasurable. */
  waterBblPerDay: number | null;
  /**
   * Those rates over an average month at the adjusted prices, in dollars, or
   * NULL when there is no rate to price from either source.
   *
   * State-derived rates ARE priced, at the same prices a measured rate gets.
   * The row reconciles either way — rate x 365/12 x price IS the figure beside
   * it — and the alternative was worse: a seeded account, whose leases have
   * tanks and meters but no readings yet, printed the state's oil and gas rates
   * across three columns and then dashed the one column that is their product.
   * The lease page already prices the same public record into its headline
   * revenue card, so withholding it here also put the two surfaces in
   * disagreement about one lease.
   *
   * What stays true: this is an ESTIMATE of what production is worth, not
   * settled revenue. Where a purchaser statement exists it is the truth and
   * this will differ from it. `source` says which rate it was built from.
   */
  revenue: number | null;
  /** Where the oil and gas rates came from. */
  source: "measured" | "rrc" | "none";
}

/**
 * One lease's monthly estimate from its already-averaged daily rates.
 *
 * Pulled out of the loader so the arithmetic can be checked without a database:
 * it is the whole formula, and the loader's only other job is producing the two
 * rates it takes.
 *
 * The rates it returns are the SAME ones its revenue is computed from, so the
 * row on /leases reconciles by construction: the oil and gas columns times
 * 365/12 times the prices are the revenue column, with no second derivation to
 * drift from the first.
 */
export function monthlyEstimateFrom(
  rates: {
    bblPerDay: number;
    mcfPerDay: number;
    waterBblPerDay?: number | null;
    source?: LeaseEstimate["source"];
  },
  prices: Pick<AdjustedPrices, "oilPerBbl" | "gasPerMcf">
): LeaseEstimate {
  const source = rates.source ?? "measured";
  return {
    oilBblPerDay: rates.bblPerDay,
    gasMcfPerDay: rates.mcfPerDay,
    waterBblPerDay: rates.waterBblPerDay ?? null,
    /*
     * Priced whenever there is a rate to price, measured or state-derived. Only
     * "none" — no reading and no filing, so both rates are a placeholder zero —
     * returns null, which is what keeps a row of dashes from ending in "$0".
     */
    revenue:
      source === "none"
        ? null
        : rates.bblPerDay * DAYS_PER_MONTH * prices.oilPerBbl +
          rates.mcfPerDay * DAYS_PER_MONTH * prices.gasPerMcf,
    source,
  };
}

/** The revenue half alone. */
export function monthlyRevenueFrom(
  rates: { bblPerDay: number; mcfPerDay: number },
  prices: Pick<AdjustedPrices, "oilPerBbl" | "gasPerMcf">
): number {
  // Always measured here: this overload takes bare rates, and every caller of it
  // is pricing the operator's own production.
  return monthlyEstimateFrom({ ...rates, source: "measured" }, prices).revenue ?? 0;
}

/** Mean of the last `days` points in a daily series, or null if it is empty. */
export function movingAverage(
  series: { price: number }[],
  days: number
): number | null {
  const tail = series.slice(-days);
  if (tail.length === 0) return null;
  return tail.reduce((s, p) => s + p.price, 0) / tail.length;
}

/**
 * 30-day moving-average benchmark prices, adjusted by the /prices factor.
 *
 * "3M" is the shortest range the feed offers that certainly contains 30 trading
 * days — a 1M window would come up short across a holiday stretch, and the
 * average is taken over the points present rather than over calendar days
 * because a market that was closed has no price to average in.
 */
/**
 * Prices resolved per lease, with the company's as the fallback.
 *
 * The prices an operator receives differ enormously between leases — a 2.5x
 * spread inside one statement is ordinary once condensate is involved — so a
 * lease is valued at ITS price, and only a lease that has settled nothing falls
 * back to the company's.
 */
export interface LeasePricing {
  /** That lease's prices, or the company's when it has settled nothing. */
  for(leaseId?: string | null): AdjustedPrices;
  /** The company-wide prices. For aggregate surfaces only. */
  company: AdjustedPrices;
}

/** Pure: one commodity pair read at the 30-day moving-average benchmarks. */
function adjustedFrom(
  models: RealizationModels,
  oilMa: number,
  gasMa: number
): AdjustedPrices {
  return {
    oilPerBbl: predictRealized(models.oil, oilMa, gasMa),
    gasPerMcf: predictRealized(models.gas, gasMa, oilMa),
    oilFactor: effectiveFactor(models.oil, oilMa, gasMa),
    gasFactor: effectiveFactor(models.gas, gasMa, oilMa),
    measured: models.measured,
  };
}

export async function getAdjustedPrices(): Promise<LeasePricing> {
  const [realized, org, oilHistory, gasHistory] = await Promise.all([
    getRealizedPrices(),
    getOrgRealization(),
    getPriceHistory("oil", "3M"),
    getPriceHistory("gas", "3M"),
  ]);

  const oilMa = movingAverage(oilHistory, MA_DAYS);
  const gasMa = movingAverage(gasHistory, MA_DAYS);

  // With no history to average, fall back to the realized prices already in
  // hand rather than to zero — a blank column reads as "no production". Both
  // averages come from the same feed, so they are absent together; the model
  // needs BOTH to price either commodity, so one missing means neither is used.
  if (oilMa == null || gasMa == null) {
    const flat: AdjustedPrices = {
      oilPerBbl: realized.oilPerBbl,
      gasPerMcf: realized.gasPerMcf,
      oilFactor: realized.oilFactor,
      gasFactor: realized.gasFactor,
      measured: realized.measured,
    };
    return { for: () => flat, company: flat };
  }

  const company = adjustedFrom(org.company, oilMa, gasMa);
  const cache = new Map<string, AdjustedPrices>();
  return {
    company,
    for(leaseId) {
      if (!leaseId) return company;
      const models = modelsFor(org, leaseId);
      if (models === org.company) return company;
      const hit = cache.get(leaseId);
      if (hit) return hit;
      const priced = adjustedFrom(models, oilMa, gasMa);
      cache.set(leaseId, priced);
      return priced;
    },
  };
}

/**
 * Estimated monthly production and revenue per lease.
 *
 *   (14-day EMA of the daily rate)
 *     x 365/12
 *     x (30-day moving average benchmark price x adjustment factor)
 *
 * summed over oil and gas.
 *
 * Both sides of the product are an average on purpose: a rate against a rate.
 * Taking a raw monthly production total against a spot price would let one
 * violent session in the futures market restate every lease on the page, and
 * would read as production rather than as a run rate.
 *
 * ## Why the EMA, and why the state's record is loaded here
 *
 * These are the SAME rates the lease page's headline cards show, computed the
 * same way — 14-day EMA over the operator's series with the public record
 * behind it, both streams on one calendar so a day with no gas counts as a zero
 * gas day (`alignDailyStreams`). They have to be: a roster saying 12 bbl/d and
 * a lease page saying 30 for the same lease is a bug whichever is right, and
 * the roster read the single latest point, which is one gauge reading and
 * swings with it.
 *
 * The last measured value survives as the fallback for a lease with fewer than
 * 14 days of history, which is exactly what the lease page falls back to.
 *
 * ## What this is not
 *
 *   - **Not net revenue.** It values the whole lease's production, before
 *     royalty and before working-interest splits. `Lease.netInterestPct` is its
 *     own column beside this one so both inputs stay visible rather than one
 *     being folded silently into the other.
 *   - **Not settled revenue.** Nothing here reads a purchaser statement. Where
 *     statements exist they are the truth and this will differ from them.
 *   - **Not a forecast.** It is a trailing rate held flat, so it carries no
 *     decline: a lease reads at what it has just been doing, not at what it
 *     will do next month.
 *
 * ## Cost
 *
 * Three series per lease, but the loaders memoize per TANK and per METER inside
 * the request scope, so the real work is bounded by the org's tank and meter
 * count rather than by the number of leases. The public-record read is one
 * query per lease against the RRC mirror; it was already paid for every lease
 * with nothing measured, which on a seeded account is all of them.
 * `listLeases` deliberately does not do any of this: its other callers are
 * pickers.
 */
export async function leaseMonthlyEstimates(
  sb: Sb,
  leaseIds: string[],
  /**
   * May be a promise: prices are one read nobody needs until the rates are in
   * hand, and awaiting them first put that read ahead of every series read.
   */
  pricing: LeasePricing | Promise<LeasePricing>
): Promise<Map<string, LeaseEstimate>> {
  // How current the public record is, so a lease that stopped filing reads as
  // shut in rather than as whatever it made the last month it filed. Null when
  // the mirror is off, which leaves every rate exactly where its series left it.
  // Started here, awaited where it is used: on a cold process it is a read.
  const horizon = rrcProductionHorizon();
  /*
   * The reads are WINDOWED (`RATE_WINDOW_DAYS`, applied at the RPC with an
   * anchor row), as /production's are. A 14-day EMA cannot see past the
   * window, and reading whole history was the page's largest cost twice
   * over: the rows themselves, and in dev a stack capture per response chunk.
   * The boundary against the public record moves from the operator's earliest
   * reading to the window's first point; the record months that now sit
   * under measured history are older than the window and weigh (13/15)^90 in
   * the rate, i.e. nothing a displayed digit can show.
   */
  const from = rateWindowFrom();
  const rows = await Promise.all(
    leaseIds.map(async (id) => {
      /*
       * The public record behind the operator's own, STARTED beside the series
       * rather than after them: its only dependency on them is the boundary,
       * applied below once both are loaded. Cut strictly before the operator's
       * first reading so the two never overlap — the boundary the lease page
       * uses, for the same reason: a lease seeded from the state's filings has
       * a real rate and would otherwise read as nothing.
       */
      const record = leaseRrcMonths(id);
      const [oil, gas, water] = await Promise.all([
        leaseProductionSeries(sb, id, { mode: "reading", from }),
        leaseGasDailySeries(sb, id, { from }),
        leaseWaterSeries(sb, id, { from }),
      ]);
      const history = leaseRrcSeries(id, await record, earliestMeasuredDate(oil, gas, water));

      // History first so a measurement wins its own day, then EACH STREAM ON
      // ITS OWN DATES. A day the tanks were gauged and the gas meter was not is
      // a day nobody measured gas, not a zero-gas day; see `ownDateSeries`.
      const streams = ownDateSeries({
        oil: [
          ...history.oil.map((p) => ({ date: p.date, rate: p.value })),
          ...oil.map((p) => ({ date: p.date, rate: p.bbls })),
        ],
        gas: [
          ...history.gas.map((p) => ({ date: p.date, rate: p.value })),
          ...gas.map((p) => ({ date: p.date, rate: p.mcf })),
        ],
        // Texas publishes no produced water, so this stream is measured or
        // nothing — and stays NULL when nothing measures it, which is what
        // dashes the column rather than claiming a dry lease.
        water: water.map((p) => ({ date: p.date, rate: p.bbls })),
      });

      const measuredOil = latest(oil.map((p) => ({ date: p.date, v: p.bbls })));
      const measuredGas = latest(gas.map((p) => ({ date: p.date, v: p.mcf })));
      const measuredWater = latest(water.map((p) => ({ date: p.date, v: p.bbls })));
      const rrcOil = latest(history.oil.map((p) => ({ date: p.date, v: p.value })));
      const rrcGas = latest(history.gas.map((p) => ({ date: p.date, v: p.value })));

      const measured = measuredOil !== null || measuredGas !== null;
      const found = rrcOil !== null || rrcGas !== null;

      const [recordHorizon, priced] = await Promise.all([horizon, pricing]);
      // Each stream read as of the later of its own last day and the record's
      // horizon, its EMA carried there — the rule and its reasons live with
      // `currentStreamRate`.
      const rate = (
        stream: { values: number[]; lastDate: string | null },
        fallback: number | null
      ) => currentStreamRate(stream, fallback, recordHorizon, EMA_DAYS);

      return [
        id,
        monthlyEstimateFrom(
          {
            bblPerDay: rate(streams.oil, measuredOil ?? rrcOil),
            mcfPerDay: rate(streams.gas, measuredGas ?? rrcGas),
            waterBblPerDay:
              measuredWater === null ? null : rate(streams.water, measuredWater),
            source: measured ? "measured" : found ? "rrc" : "none",
          },
          // THIS lease's prices, not the company blend.
          priced.for(id)
        ),
      ] as const;
    })
  );

  return new Map(rows);
}

/** The value at the latest date in a series, or null when it is empty. */
function latest(points: { date: string; v: number }[]): number | null {
  let best: { date: string; v: number } | null = null;
  for (const p of points) if (best === null || p.date > best.date) best = p;
  return best?.v ?? null;
}

