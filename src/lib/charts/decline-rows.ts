import {
  decline12,
  declineAt,
  project,
  type DeclineFit,
  type MonthlyRate,
} from "@/lib/wells/arps";
import { gasBarrelsPerMcf } from "@/lib/analytics/boe";
import type { FleetMonth } from "@/lib/analytics/fleet-decline";
import type { CommodityPrices } from "@/lib/analytics/types";

/**
 * The rows a decline chart plots: one per month, carrying the filed rate and
 * the fitted Arps rate at that month.
 *
 * Pure and side-effect free so the WINDOW — which months appear, and how far the
 * curve runs — can be checked against a hand-computed oracle instead of against
 * a rendered chart. The horizon rule below is the part that was wrong: an end
 * date past the default projection used to be clamped away, so a user who asked
 * for August 2030 got February 2028 and no explanation.
 */

/** One month on a decline chart. */
export interface DeclineRow {
  /** ISO `YYYY-MM`. */
  month: string;
  /** Filed producing-day rate for the month, or null (a projected month). */
  actual: number | null;
  /** Fitted Arps rate, or null before the fit's start month / with no fit. */
  fit: number | null;
  /**
   * The fitted curve's decline rate AT this month, as a fraction per year — how
   * far the rate falls over the following twelve months. Null wherever `fit` is.
   *
   * Per month, not once per curve: under a hyperbolic fit the decline flattens
   * as the well ages, so a single number for the whole chart would be wrong
   * everywhere except the month it was measured at.
   */
  decline: number | null;
}

/** How far past the last filed month the curve runs when nothing is chosen. */
export const DECLINE_FORWARD_MONTHS = 18;

/** How much history a decline chart opens on, in months. */
export const DECLINE_DEFAULT_MONTHS = 60;

/** Integer month index (year·12 + month) for `YYYY-MM`, for stepping months. */
export function monthOrdinal(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
}

export function ordinalToYm(o: number): string {
  return `${Math.floor(o / 12)}-${String((o % 12) + 1).padStart(2, "0")}`;
}

function monthKeyMs(month: string): number {
  return Date.parse(`${month}-01T00:00:00Z`);
}

const YEAR_MS = 365.25 * 86_400_000;

export interface DeclineWindow {
  /** ISO date; the month it falls in is included. Empty or absent = no bound. */
  from?: string;
  to?: string;
}

/**
 * The window a decline chart OPENS on: the five years ending at the most recent
 * month with production, or null when there is none.
 *
 * Anchored to the last filed month rather than to today, because that is where
 * the curve is: a lease whose last filing was in 2019 would otherwise open on
 * five empty years and no data at all. The end is left unbounded so the fit's
 * 18-month projection still runs past it — the horizon is what a decline chart
 * is for, and pinning the end to the last filed month would cut it off.
 *
 * `rates` may be several streams' series; the latest month across all of them
 * wins, so oil, gas and BOE open on the same span and stay comparable.
 */
export function defaultDeclineWindow(
  rates: MonthlyRate[]
): { from: string; to: string } | null {
  if (rates.length === 0) return null;
  const lastOrd = Math.max(...rates.map((r) => monthOrdinal(r.month)));
  return {
    from: `${ordinalToYm(lastOrd - (DECLINE_DEFAULT_MONTHS - 1))}-01`,
    to: "",
  };
}

/**
 * A price-equivalent BOE rate series from an oil and a gas one: each month's oil
 * rate plus its gas rate converted at `barrelsPerMcf` (see
 * `@/lib/analytics/boe` — the ratio is the PRICE ratio, not 6:1, so a BOE
 * decline is the decline of the money).
 *
 * Both sides are producing-day rates, so their sum is one too. A month present
 * in only one stream keeps that stream's rate: a lease that made oil and no gas
 * that month is worth its oil, not nothing.
 */
export function boeMonthlyRates(
  oil: MonthlyRate[],
  gas: MonthlyRate[],
  barrelsPerMcf: number
): MonthlyRate[] {
  const byMonth = new Map<string, number>();
  for (const o of oil) byMonth.set(o.month, o.rate);
  for (const g of gas) {
    byMonth.set(g.month, (byMonth.get(g.month) ?? 0) + g.rate * barrelsPerMcf);
  }
  return [...byMonth.entries()]
    .map(([month, rate]) => ({ month, rate }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/**
 * One curve through oil and gas as priced barrels — the summary API's TRAILING
 * company decline (`summary-pure.ts`), fitted over its lookback window.
 *
 * NOT a headline. Every card and chart in the app reads each stream's own
 * curve anchored at its current rate and summed forward (`fleet-decline`);
 * fitting one curve through a sum of streams that fall at different rates
 * reads their combined peak as the story and cannot see the faster one stop
 * mattering. This stays for the one caller that wants "how has the measured
 * total been trending", which is a different question.
 *
 * Null when there is not enough post-peak history to fit at all.
 */
export function boeForward12Decline(
  oil: MonthlyRate[],
  gas: MonthlyRate[],
  prices: CommodityPrices | undefined
): number | null {
  const rates = boeMonthlyRates(oil, gas, gasBarrelsPerMcf(prices));
  if (rates.length === 0) return null;
  return decline12(rates);
}

/**
 * Build the chart's rows.
 *
 * THE HORIZON. By default the curve runs {@link DECLINE_FORWARD_MONTHS} past the
 * last filed month. A chosen END DATE replaces that, however far out it is:
 * `project` is defined for any t — hyperbolic until the fit's `tSwitch`, terminal
 * exponential after — so asking for 2030 draws the fit to 2030. With no fit
 * there is nothing to draw past the last filed month, so that case clamps.
 *
 * THE START always clamps to the first filed month. There is no rate before it
 * and the fit is null before its own start month, so an earlier bound would only
 * pad the axis with empty columns.
 *
 * `logScale` nulls non-positive values, which a log axis cannot plot.
 */
export function declineChartRows(
  rates: MonthlyRate[],
  fit: DeclineFit | null,
  window: DeclineWindow | null = null,
  logScale = false,
  /** How far past the last filed month the curve runs. Defaults to
   *  {@link DECLINE_FORWARD_MONTHS}; the dashboard asks for five years. */
  forwardMonths: number = DECLINE_FORWARD_MONTHS
): DeclineRow[] {
  if (rates.length === 0) return [];

  const byMonth = new Map(rates.map((m) => [m.month, m.rate]));
  const ords = [...byMonth.keys()].map(monthOrdinal);
  const firstOrd = Math.min(...ords);
  // Project past the last filed month only when there is a fit to project.
  const lastOrd = Math.max(...ords) + (fit ? forwardMonths : 0);

  const fromOrd = window?.from ? monthOrdinal(window.from.slice(0, 7)) : null;
  const toOrd = window?.to ? monthOrdinal(window.to.slice(0, 7)) : null;
  const lo = fromOrd == null ? firstOrd : Math.max(firstOrd, fromOrd);
  const hi = toOrd == null ? lastOrd : fit ? toOrd : Math.min(lastOrd, toOrd);

  const startMs = fit ? monthKeyMs(fit.startMonth) : 0;
  const guard = (v: number | null): number | null =>
    logScale && v != null && !(v > 0) ? null : v;

  const rows: DeclineRow[] = [];
  for (let o = lo; o <= hi; o++) {
    const month = ordinalToYm(o);
    const t = fit ? (monthKeyMs(month) - startMs) / YEAR_MS : -1;
    const fitted = fit && t >= 0 ? project(fit, t) : null;
    rows.push({
      month,
      actual: guard(byMonth.get(month) ?? null),
      fit: guard(fitted),
      // Read off the same fit the curve is drawn from, so the tooltip cannot
      // disagree with the line above it.
      decline: fit && fitted != null ? declineAt(fit, t) : null,
    });
  }
  return rows;
}

/**
 * The rows for a FLEET's decline chart: what the company measured, and where
 * the sum of its leases' curves is going (`@/lib/analytics/fleet-decline`).
 *
 * Unlike {@link declineChartRows} there is no fitted line through the history.
 * A fleet has no single curve: each lease's fit tracks that lease, and their sum
 * over past months is a line that jumps every time a lease came on. What a
 * company chart is read for is the forecast, so the curve here starts at the
 * anchor month and runs the projection's length; the tooltip's decline is the
 * projected sum's own, month by month.
 *
 * The window clamps the START, as the single-curve rows do; the end is the last
 * projected month, or a chosen end date past it.
 */
export function fleetChartRows(
  rates: MonthlyRate[],
  projection: FleetMonth[],
  window: DeclineWindow | null = null,
  logScale = false
): DeclineRow[] {
  if (rates.length === 0 && projection.length === 0) return [];

  const actualByMonth = new Map(rates.map((m) => [m.month, m.rate]));
  const projected = new Map(projection.map((m) => [m.month, m]));
  const ords = [...actualByMonth.keys(), ...projected.keys()].map(monthOrdinal);
  const firstOrd = Math.min(...ords);
  const lastOrd = Math.max(...ords);

  const fromOrd = window?.from ? monthOrdinal(window.from.slice(0, 7)) : null;
  const toOrd = window?.to ? monthOrdinal(window.to.slice(0, 7)) : null;
  const lo = fromOrd == null ? firstOrd : Math.max(firstOrd, fromOrd);
  const hi = toOrd == null ? lastOrd : Math.max(lastOrd, toOrd);

  const guard = (v: number | null): number | null =>
    logScale && v != null && !(v > 0) ? null : v;

  const rows: DeclineRow[] = [];
  for (let o = lo; o <= hi; o++) {
    const month = ordinalToYm(o);
    const p = projected.get(month);
    rows.push({
      month,
      actual: guard(actualByMonth.get(month) ?? null),
      fit: guard(p?.rate ?? null),
      decline: p?.decline ?? null,
    });
  }
  return rows;
}
