/**
 * Report time windows — pure, no I/O, no clock reads.
 *
 * Every report that summarizes activity now states the range it covers (client
 * spec, 2026-07-26). Before this, several reports summarized ALL history, which
 * meant the same report meant something different every month and two runs could
 * not be compared. One vocabulary of windows, resolved here, so the row title,
 * the document subtitle, and the export filename always agree.
 *
 * `mtd` (month-to-date) is deliberately distinct from `30d`: month-to-date is what
 * reconciles against a purchaser's monthly statement, while a trailing 30 days is
 * what tells you how the field is running right now. Both are useful; conflating
 * them is what makes a reconciliation argument unwinnable.
 */

/** The windows a report can be run over. */
export type ReportWindowKind = "7d" | "30d" | "mtd" | "365d";

/** A resolved window: inclusive ISO bounds plus how to name it to a reader. */
export interface ReportWindow {
  kind: ReportWindowKind;
  /** Inclusive first ISO date. */
  from: string;
  /** Inclusive last ISO date. */
  to: string;
  /** Human range, e.g. "2026-06-25 to 2026-07-24 (30 days)". */
  label: string;
  /** Short suffix for filenames and row keys, e.g. "30d" / "mtd". */
  slug: string;
}

const DAY_MS = 86_400_000;

/** `iso` shifted by `days` (negative shifts back). */
function shift(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** First day of `iso`'s calendar month. */
function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Whole days between two ISO dates, inclusive of both ends. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
}

/**
 * Resolve a window against an as-of date. `asOf` is always passed in (the caller
 * owns the clock) so a report renders identically for a given day.
 */
export function resolveWindow(
  kind: ReportWindowKind,
  asOf: string
): ReportWindow {
  if (kind === "mtd") {
    const from = firstOfMonth(asOf);
    return {
      kind,
      from,
      to: asOf,
      label: `${from} to ${asOf} (month to date)`,
      slug: "mtd",
    };
  }
  const days = kind === "7d" ? 7 : kind === "365d" ? 365 : 30;
  const from = shift(asOf, -(days - 1));
  return {
    kind,
    from,
    to: asOf,
    label: `${from} to ${asOf} (${days} days)`,
    slug: `${days}d`,
  };
}

/** Narrow an arbitrary string (a query param) to a known window. */
export function parseWindowKind(
  value: string | null | undefined,
  fallback: ReportWindowKind = "30d"
): ReportWindowKind {
  return value === "7d" || value === "30d" || value === "mtd" || value === "365d"
    ? value
    : fallback;
}

/** Whether an ISO date (or timestamp) falls inside the window. */
export function inWindow(date: string, window: ReportWindow): boolean {
  const day = date.slice(0, 10);
  return day >= window.from && day <= window.to;
}

/** Label a window for a row title, e.g. "last 30 days" / "month to date". */
export function windowTitleSuffix(kind: ReportWindowKind): string {
  if (kind === "mtd") return "month to date";
  const days = kind === "7d" ? 7 : kind === "365d" ? 365 : 30;
  return `last ${days} days`;
}
