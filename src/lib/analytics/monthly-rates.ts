import type { MonthlyRate } from "@/lib/wells/arps";

/**
 * Company monthly TOTALS as daily RATES, which is what an Arps fit expects.
 *
 * `fitDecline` works in rate space (barrels per day), so a series of month
 * totals has to be divided by the length of each month. By the length of THAT
 * month: dividing everything by 30 makes February read 7% high and makes every
 * leap year a step in the curve, which a fit reads as real.
 *
 * Months with no production are dropped rather than plotted as zero. A month the
 * company sold nothing in is not a point on a decline curve, and `fitDecline`
 * filters non-positive rates anyway — dropping them here keeps the chart's
 * points and the fit's points the same set.
 *
 * Producing days would be better than calendar days and are not available at the
 * company level: the monthly series is an aggregate over every well, and one
 * well down for a week is not the company being down for a week.
 *
 * THE MONTH IN PROGRESS is divided by the days it has actually had, not by its
 * full length. Six days into August, a month holding six days of oil was reading
 * as a fifth of the rate the company was making, and the decline chart ended on
 * a cliff that was nothing but the calendar. Only COMPLETE days count — today is
 * itself half-finished — so on the 1st there is nothing to average and the month
 * drops out until it has a day behind it.
 */
export function monthlyRateSeries<T extends { month: string }>(
  rows: T[],
  volumeOf: (row: T) => number,
  /** Today. Omit to divide every month by its full length. */
  asOf?: Date
): MonthlyRate[] {
  const currentMonth = asOf ? asOf.toISOString().slice(0, 7) : null;
  const completeDays = asOf ? asOf.getUTCDate() - 1 : 0;
  return rows
    .map((row) => {
      const days =
        row.month === currentMonth ? completeDays : daysInMonth(row.month);
      return {
        month: row.month,
        // A month with no complete days yet is dropped by the filter below
        // rather than dividing by zero.
        rate: days > 0 ? volumeOf(row) / days : 0,
      };
    })
    .filter((r) => Number.isFinite(r.rate) && r.rate > 0)
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** Days in a `YYYY-MM`, leap years included. */
export function daysInMonth(month: string): number {
  const [year, m] = month.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

/**
 * A monthly series that already carries a per-day RATE, filtered to the months
 * that have one.
 *
 * Preferred over {@link monthlyRateSeries} wherever the payload computes its own
 * rate, because that one divides by MEASURED days per well while this file's
 * fallback can only divide by calendar days. Null when no row carries a rate,
 * which is the caller's signal to fall back rather than to plot zeros.
 */
export function measuredRateSeries<T extends { month: string }>(
  rows: T[],
  rateOf: (row: T) => number | undefined | null
): MonthlyRate[] | null {
  if (rows.length === 0 || rows.every((r) => rateOf(r) == null)) return null;
  return rows
    .map((r) => ({ month: r.month, rate: rateOf(r) ?? 0 }))
    .filter((r) => Number.isFinite(r.rate) && r.rate > 0)
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}
