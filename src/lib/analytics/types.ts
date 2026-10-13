/**
 * Analytics types + pure pricing constants. This module is PURE (no server
 * imports) so client components — the production chart, pie, and log table — can
 * import these shapes without dragging the server-only data layer
 * (`./analytics` → `@/lib/accounting/ledger`, which is `server-only`) into the
 * browser bundle. Server-side data access lives in `./analytics`.
 */

/**
 * Last-resort commodity prices, used only when the live price feed is
 * unavailable, so dollar figures never collapse to zero. Real valuation uses the
 * current WTI / Henry Hub quotes from the price feed (see `getCompanyAnalytics`).
 */
export const OIL_PRICE_PER_BBL = 75;
export const GAS_PRICE_PER_MCF = 2.5;

/** The commodity prices used to value production, in USD. */
export interface CommodityPrices {
  /** Oil price, USD per barrel (WTI from the feed, or the fallback). */
  oilPerBbl: number;
  /** Gas price, USD per MCF (Henry Hub from the feed, or the fallback). */
  gasPerMcf: number;
}

/**
 * Company-wide production + dollars for one month, merged across the two
 * sources. Months the accounting ledger covers are `official` (the record of
 * truth — what the company was paid for); later months fall back to the
 * self-reported production reports and are flagged unofficial.
 */
export interface MonthlyProduction {
  /** Month as `YYYY-MM`. */
  month: string;
  /** Oil, in barrels. */
  oilBbl: number;
  /** Gas, in MCF. */
  gasMcf: number;
  /** Produced (salt) water, in barrels (always from production reports). */
  water: number;
  /** Net revenue — actual (official) or volume×price estimate (unofficial). */
  revenue: number;
  /** Cash flow (revenue − expenses); 0 for unofficial months (no expenses). */
  cashFlow: number;
  /** True when every well's figures for the month come from accounting. */
  official: boolean;
  /**
   * The month's RATE, normalized by measured days rather than by the calendar.
   *
   * Each well's volume is divided by the days that well was gauged, and the
   * wells are then summed — so a month where the pumper missed a week is not a
   * month at a lower rate. Dividing the month's total by its calendar days does
   * exactly that, and it is why the decline curve's August point sat under the
   * production chart's for the same month and the same barrels.
   *
   * A settled (accounting) month has no gauges behind it and falls back to the
   * calendar. Optional so an older payload still renders.
   */
  oilBblPerDay?: number;
  gasMcfPerDay?: number;
  waterBblPerDay?: number;
}

/**
 * One well's monthly series — the same shape as the company series, scoped to a
 * single well — plus its period production, powering the analytics chart's well
 * picker. Each month's `official` flag is that well's own status (not the
 * company-tainted one).
 */
export interface WellMonthlySeries {
  wellId: string;
  name: string;
  /** The well's monthly figures, oldest first. */
  monthly: MonthlyProduction[];
  /** Period production in BOE (oil + gas/6) — the picker's sort key. */
  boe: number;
}

/**
 * One DAY of measured production, company-wide or for one well.
 *
 * Volumes only. Revenue is priced on the client from these, because accounting
 * settles by month: a day can never be `official`, and pretending otherwise
 * would let a daily bucket claim a status a month's worth of ledger gives it.
 */
export interface DailyProduction {
  /** Day as `YYYY-MM-DD`. */
  date: string;
  oilBbl: number;
  gasMcf: number;
  water: number;
  /**
   * Which streams were MEASURED on this day — true when at least one well's
   * series covers it.
   *
   * A day exists here because ANY stream reported, so a day the gas meter was
   * read and no tank was gauged carries `oilBbl: 0`. Averaging that as a day of
   * production is what made the current week read low: the bucket divided by
   * days nobody gauged.
   */
  measured: { oil: boolean; gas: boolean; water: boolean };
  /**
   * The day's oil and gas valued at THAT DATE's realized price, USD. Set by the
   * server (`dailySeriesFromRows` with a pricer) so the chart's revenue view
   * carries the price move as well as the production's; absent on series that
   * were never priced, where the client falls back to today's price.
   */
  oilRevenue?: number;
  gasRevenue?: number;
}

/** One well's daily series, for the chart's short-window (1M/3M/6M) views. */
export interface WellDailySeries {
  wellId: string;
  daily: DailyProduction[];
}

/** A single well's production totals + actual accounting figures. */
export interface WellProductionTotal {
  wellId: string;
  name: string;
  oilBbl: number;
  gasMcf: number;
  /** Actual net revenue booked to this well in the ledger, USD. */
  revenue: number;
  /** Actual cash flow (revenue − expenses) for this well, USD. */
  cashFlow: number;
}

/** One production reading across the company, with its well + oil in barrels. */
export interface ProductionLogRow {
  id: string;
  wellId: string;
  wellName: string;
  date: string;
  time: string;
  /** Oil figures are in barrels (already converted from gauge inches). */
  oilProduction: number;
  oilStock: number;
  oilSales: number;
  gasProduction: number;
  saltWater: number;
}

export interface CompanyAnalytics {
  /** Merged monthly series (accounting where official, production after). */
  monthly: MonthlyProduction[];
  byWell: WellProductionTotal[];
  /** Per-well monthly series for the chart's well picker, sorted by production. */
  byWellMonthly: WellMonthlySeries[];
  /**
   * Recent DAILY measured production, company-wide and per well — what the
   * short windows plot. A month bucket cannot show a well that went down for a
   * week, which is the resolution the last quarter is actually read at.
   */
  daily: DailyProduction[];
  dailyByWell: WellDailySeries[];
  /** Prices used to value production in dollars (from the live feed). */
  prices: CommodityPrices;
}
