/**
 * Company-digest domain types — pure, no I/O, safe on client and server.
 *
 * A digest is a composite document (KPIs + tables + charts + an AI narrative)
 * for a daily / weekly / monthly window. These shapes are the deterministic
 * output of `buildCompanyDigest` (see `./build`); the PDF document, the HTML
 * email body, and the AI-summary prompt all read from the same object so the
 * three surfaces can never disagree.
 */

import type { DigestPeriod, DigestWindow } from "@/lib/reports/digest/period";

export type { DigestPeriod, DigestWindow };

/**
 * Where a revenue figure comes from:
 * - `estimated`: production valued at the realized benchmark price
 *   (commodity benchmark × the operator's historic realization factor). Used for
 *   daily / weekly digests and the month-end production digest.
 * - `settled`: actual dollars from purchaser settlement statements. Used for the
 *   monthly settlement digest, once statement price data has landed.
 */
export type RevenueBasis = "estimated" | "settled";

/** A metric's value this window plus its change vs the prior window. */
export interface KpiDelta {
  value: number;
  /** Prior-window value (for context/label), or null when there was none. */
  prior: number | null;
  /**
   * Percent change vs prior (signed), or null when there is nothing to compare.
   *
   * Compared as a RATE PER REPORTED DAY, never as window total against window
   * total. A window whose gauges have not been entered yet holds less volume
   * because it holds fewer readings, and comparing those totals reported a
   * company that had collapsed every time a digest went out ahead of the
   * pumper's data entry.
   */
  changePct: number | null;
  /** Days in this window carrying a reading for this stream. */
  measuredDays?: number;
  /** The same for the prior window. */
  priorMeasuredDays?: number;
  /** Calendar days in the window, so partial coverage can be stated. */
  windowDays?: number;
}

/** The headline figures for a digest window. */
export interface DigestKpis {
  /** Oil produced in the window (bbl). */
  oil: KpiDelta;
  /** Gas produced in the window (mcf). */
  gas: KpiDelta;
  /** Water produced in the window (bbl). */
  water: KpiDelta;
  /** Oil sold / run in the window (bbl). */
  oilSales: KpiDelta;
  /** Revenue for the window (USD), by the digest's basis. */
  revenue: KpiDelta;
  /** Basis of the revenue figure. */
  revenueBasis: RevenueBasis;
  /**
   * For the settlement digest: the estimate this settled figure is compared
   * against, and the variance (settled − estimated) as a signed percent. Null
   * on estimated digests.
   */
  revenueEstimate: number | null;
  revenueVariancePct: number | null;
}

/**
 * Production + revenue for one scope: the company, a lease, or a well. The same
 * five measures at every level, so a lease is the sum of its wells and the
 * company is the sum of its leases — the reports show all three and they must
 * reconcile.
 */
export interface DigestTotals {
  oil: number;
  gas: number;
  water: number;
  oilSales: number;
  /** Revenue for this scope over the window (USD), on the digest's basis. */
  revenue: number;
}

/** One well's line inside its lease section. */
export interface DigestWellRow extends DigestTotals {
  wellId: string;
  wellName: string;
}

/**
 * One lease's section: the lease's own totals plus a line per well under it.
 * Wells with no lease assigned group under {@link UNASSIGNED_LEASE}.
 */
export interface DigestLeaseSection extends DigestTotals {
  name: string;
  /** The lease's wells, largest revenue first. */
  wells: DigestWellRow[];
  /**
   * The lease's aggregate daily production over the charts' trailing range (the
   * same range the company charts use), for its section's charts. Aggregated
   * across its wells, so the charts and the section total tell one story.
   *
   * Oil and water share a chart (same unit, so the comparison is the point); gas
   * gets its own, in mcf.
   */
  daily: {
    oil: DigestDailyPoint[];
    gas: DigestDailyPoint[];
    water: DigestDailyPoint[];
  };
}

/** One row of the flat by-lease rollup table (a lease section without wells). */
export interface DigestRollupRow extends DigestTotals {
  /** Lease name. */
  name: string;
}

/** Section name for wells that aren't assigned to a lease. */
export const UNASSIGNED_LEASE = "Unassigned";

/** One point of a daily chart series. */
export interface DigestDailyPoint {
  date: string;
  value: number;
}

/** The chart series a digest renders (all daily over the window). */
export interface DigestCharts {
  oil: DigestDailyPoint[];
  gas: DigestDailyPoint[];
  water: DigestDailyPoint[];
  /** Estimated daily revenue (production × realized price), USD. */
  revenue: DigestDailyPoint[];
}

/**
 * Where an exception came from. Purely OPERATIONAL (client, 2026-07-26): a
 * commodity price move is not an exception, it is context — the operator can't act
 * on it, and mixing it into the action list buried the things they can act on.
 * Realized-vs-benchmark prices still ride on the digest as summary stats.
 */
export type DigestExceptionKind = "production" | "comment";

/**
 * One flagged exception. The cover page renders `message` as a bullet, so that
 * string is the contract; the numeric fields are context for the AI narrative
 * and for anyone reading the JSON.
 */
export interface DigestException {
  kind: DigestExceptionKind;
  /** Battery for a production exception, facility for a comment. */
  scope: string;
  /** "oil" / "gas", or the facility type for a comment. */
  metric: string;
  /** The 30-day moving-average baseline (production only). */
  baseline: number | null;
  /** The recent 3-day average (production only). */
  recent: number | null;
  /** Signed percent divergence, or null for a comment-derived exception. */
  variancePct: number | null;
  /** The bullet as it appears on the cover page. */
  message: string;
}

/** The facility kinds a pumper comment can be attached to. */
export type DigestCommentFacility =
  | "well"
  | "tank"
  | "meter"
  | "battery"
  | "lease"
  | "disposal";

/**
 * One pumper comment: either a free-text remark typed on a daily reading or a
 * comment left on a facility's thread. Both are the pumper's own words, which is
 * why they feed one summary and one exception trigger.
 */
export interface DigestComment {
  facilityType: DigestCommentFacility;
  facilityName: string;
  /** ISO `YYYY-MM-DD` the comment or reading belongs to. */
  date: string;
  /** Author name, or "" for a remark typed on a reading. */
  author: string;
  body: string;
}

/**
 * A commodity price and how it moved, period over period. Drives the price
 * exception on every digest and the realized-vs-benchmark stats on the monthly.
 */
export interface DigestPriceMove {
  product: "oil" | "gas";
  /** Mean REALIZED price over the window (benchmark × realization factor). */
  average: number;
  /** Mean realized price over the prior window. */
  priorAverage: number;
  /** Mean raw commodity benchmark over the window (no realization applied). */
  benchmarkAverage: number;
  /**
   * Realized against benchmark as a signed percent — the differential the
   * operator actually captured. Null when there is no benchmark to compare to.
   */
  realizedVsBenchmarkPct: number | null;
}

/** The complete, render-ready company digest. */
export interface CompanyDigest {
  period: DigestPeriod;
  window: DigestWindow;
  kpis: DigestKpis;
  /**
   * The breakdown below the company headline: one section per lease, largest
   * revenue first, each carrying its own wells. This is the ONLY grouped
   * representation on the digest — the flat by-lease table the exports and the
   * email render is derived from it (`leaseRollupRows`), so the two can't
   * disagree.
   */
  leases: DigestLeaseSection[];
  /**
   * Settled revenue that could NOT be attributed to a well (USD). Statement
   * dollars posted without a tank/meter link have no allocation basis, so they
   * are reported here instead of being silently dropped: company revenue equals
   * the sum of the lease sections plus this. Always 0 on the estimated basis,
   * where every dollar is derived from a well's own volumes.
   */
  unallocatedRevenue: number;
  charts: DigestCharts;
  /**
   * Exceptions for this window (battery production, price movement, pumper
   * comments), most divergent first. Empty on the monthly digest, which reports
   * settled fact rather than operational alarms.
   */
  exceptions: DigestException[];
  /**
   * The pumper's comments over the window, and a natural-language summary of
   * them. Daily digests only: the weekly and monthly sends omit both (a month of
   * remarks is noise at that altitude).
   */
  comments: DigestComment[];
  commentsSummary: string;
  /**
   * Realized and benchmark prices with their period-over-period move. Rendered
   * as summary stats on the monthly digest (where revenue is settled, so the
   * realized-vs-benchmark differential is a real number) and used by the price
   * exception on every period.
   */
  priceMoves: DigestPriceMove[];
  /** Realized prices used to value estimated revenue (for display/context). */
  prices: {
    oilPerBbl: number;
    gasPerMcf: number;
    /** False when a realization factor fell back to a default (thin ledger). */
    measured: boolean;
  };
  /** AI narrative; empty string until generated (kept optional so build is pure). */
  summary: string;
}
