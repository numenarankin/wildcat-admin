/**
 * Reporting-window math for the company digests — pure, no I/O, deterministic.
 *
 * Given an anchor date (the last day the digest covers) and a period, computes
 * the inclusive `[start, end]` ISO window, the immediately-preceding window of
 * the same length (for period-over-period deltas), and a human label. All date
 * arithmetic is UTC on `YYYY-MM-DD` strings so it never depends on the server's
 * timezone and is trivially unit-testable.
 */

export type DigestPeriod = "daily" | "weekly" | "monthly";

export interface DigestWindow {
  period: DigestPeriod;
  /** Inclusive first ISO date of the reporting window. */
  start: string;
  /** Inclusive last ISO date of the reporting window (the anchor, or month-end). */
  end: string;
  /** Inclusive first ISO date of the prior comparison window. */
  priorStart: string;
  /** Inclusive last ISO date of the prior comparison window. */
  priorEnd: string;
  /** Display label, e.g. "July 2026" or "Jul 11 to Jul 17, 2026". */
  label: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function asUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** Shift an ISO date by whole days (UTC), returning `YYYY-MM-DD`. */
export function shiftDays(iso: string, delta: number): string {
  const d = asUtc(iso);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Number of whole days spanned inclusively by `[start, end]` (>= 1). */
export function spanDays(start: string, end: string): number {
  const ms = asUtc(end).getTime() - asUtc(start).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** First ISO day of the calendar month containing `iso`. */
function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Last ISO day of the calendar month containing `iso`. */
function lastOfMonth(iso: string): string {
  const d = asUtc(firstOfMonth(iso));
  // Day 0 of the next month is the last day of this one.
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return next.toISOString().slice(0, 10);
}

function dayLabel(iso: string): string {
  const d = asUtc(iso);
  return `${MONTHS_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function rangeLabel(start: string, end: string): string {
  const a = asUtc(start);
  const b = asUtc(end);
  const left = `${MONTHS_ABBR[a.getUTCMonth()]} ${a.getUTCDate()}`;
  const right = `${MONTHS_ABBR[b.getUTCMonth()]} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
  return `${left} to ${right}`;
}

function monthLabel(iso: string): string {
  const d = asUtc(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Resolve the reporting window for a digest.
 *
 * - `daily`: the single day `anchor`.
 * - `weekly`: the 7 days ending on `anchor` (`[anchor-6, anchor]`).
 * - `monthly`: the whole calendar month that contains `anchor` (so a month-end
 *   anchor and a mid-month anchor both yield the same full-month window).
 *
 * The prior window is always the same length, immediately before the current
 * one (the previous day / previous 7 days / previous calendar month).
 */
export function digestWindow(
  period: DigestPeriod,
  anchor: string
): DigestWindow {
  if (period === "monthly") {
    const start = firstOfMonth(anchor);
    const end = lastOfMonth(anchor);
    const priorEnd = shiftDays(start, -1); // last day of previous month
    const priorStart = firstOfMonth(priorEnd);
    return {
      period,
      start,
      end,
      priorStart,
      priorEnd,
      label: monthLabel(anchor),
    };
  }

  const length = period === "weekly" ? 7 : 1;
  const end = anchor;
  const start = shiftDays(anchor, -(length - 1));
  const priorEnd = shiftDays(start, -1);
  const priorStart = shiftDays(priorEnd, -(length - 1));
  return {
    period,
    start,
    end,
    priorStart,
    priorEnd,
    label: period === "weekly" ? rangeLabel(start, end) : dayLabel(end),
  };
}
