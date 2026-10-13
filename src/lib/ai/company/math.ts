/**
 * The arithmetic behind the company analysis catalog.
 *
 * Pure and dependency-free so every result can be checked against a
 * hand-computed oracle. The point of these existing at all is that a model
 * eyeballing twenty rows produces a slightly different ranking each time it is
 * asked, and nobody can tell which run was wrong.
 */

/**
 * Where one value sits in its cohort, 0 (lowest) to 1 (highest).
 *
 * Defined as the share of the OTHER members strictly below it, so the bottom
 * member is 0 and the top is 1 regardless of cohort size. Null for a cohort of
 * fewer than two, because a percentile against yourself is not a statement about
 * anything.
 *
 * Ties sit at the bottom of their run: three wells at 10 bbl/d are all at the
 * same rank, which is the honest reading of "you are not distinguishable from
 * these two".
 *
 * The `n - 1` denominator assumes `value` is one of the cohort, which is the
 * normal call: a well against every well. A value from outside that beats all of
 * them divides by one fewer than it should and comes out above 1, so the result
 * is bounded. Being above everything is a rank of 1, not of 1.25.
 */
export function percentileRank(cohort: number[], value: number): number | null {
  const values = cohort.filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;
  const below = values.filter((v) => v < value).length;
  return Math.min(1, below / (values.length - 1));
}

/** The middle value, averaging the two middles on an even count. */
export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Least-squares slope of y against x.
 *
 * Null when there are fewer than two points or when every x is the same, both
 * of which are cases where a slope is undefined rather than zero. Reporting zero
 * would say "flat", which is a claim.
 */
export function slope(points: { x: number; y: number }[]): number | null {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length < 2) return null;
  const n = usable.length;
  const meanX = usable.reduce((s, p) => s + p.x, 0) / n;
  const meanY = usable.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of usable) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? null : num / den;
}

export interface Change {
  absolute: number;
  /** Null when the baseline is zero: growth from nothing has no percentage. */
  pct: number | null;
}

export function change(from: number, to: number): Change {
  return {
    absolute: to - from,
    pct: from === 0 ? null : (to - from) / Math.abs(from),
  };
}

/**
 * Each member's share of the total, and the count needed to reach a threshold.
 *
 * Answers "how much of this comes from how few", which is the shape behind every
 * concentration question an operator actually asks.
 */
export function shares<T extends { value: number }>(
  members: T[],
  threshold = 0.8
): { total: number; withShare: (T & { share: number | null })[]; countTo: number | null } {
  const total = members.reduce((s, m) => s + (Number.isFinite(m.value) ? m.value : 0), 0);
  const withShare = members.map((m) => ({
    ...m,
    share: total === 0 ? null : m.value / total,
  }));

  if (total === 0) return { total, withShare, countTo: null };
  const sorted = [...withShare].sort((a, b) => b.value - a.value);
  let running = 0;
  let countTo: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i].value;
    if (running / total >= threshold) {
      countTo = i + 1;
      break;
    }
  }
  return { total, withShare, countTo };
}

/** Month index for a `YYYY-MM` label, so a slope is per month rather than per row. */
export function monthIndex(period: string): number | null {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  return year * 12 + (month - 1);
}

/**
 * The slope of a monthly series, per month, using real month gaps.
 *
 * Indexing by position instead would make a gap in the series compress the time
 * axis, so a well that stopped reporting for six months and came back lower
 * would read as a much steeper decline than it had.
 */
export function monthlySlope(points: { period: string; value: number }[]): number | null {
  const xy = points
    .map((p) => ({ x: monthIndex(p.period), y: p.value }))
    .filter((p): p is { x: number; y: number } => p.x !== null);
  return slope(xy);
}

/**
 * Median absolute deviation: the spread of a series, robust to the outlier we
 * are trying to find.
 *
 * A standard deviation is not usable here. One catastrophic month drags the
 * spread up enough that the month itself stops looking unusual, which is exactly
 * backwards for a detector.
 */
export function mad(values: number[]): number | null {
  const mid = median(values);
  if (mid === null) return null;
  return median(values.map((v) => Math.abs(v - mid)));
}

export interface Deviation {
  period: string;
  value: number;
  /** The entity's own expected level for that period. */
  baseline: number;
  /** value - baseline. Negative is a shortfall. */
  residual: number;
  /** Residuals per unit of the entity's own noise. Null when it never varies. */
  sigmas: number | null;
  flagged: boolean;
}

/**
 * Flag the periods where a series departs from its OWN history.
 *
 * The threshold is fitted from the entity's own spread rather than asserted, so
 * a well that always swings 20% does not fire and a steady one that moves 8%
 * does. `1.4826 * MAD` is the usual consistency constant that puts MAD on the
 * same scale as a standard deviation for normal data.
 *
 * Only periods with at least `minHistory` earlier periods are judged: the first
 * few months of a well have no baseline to depart from, and flagging them
 * reports every new well as an anomaly.
 *
 * A zero-spread series returns `sigmas: null` and flags nothing. A perfectly
 * flat well that moves at all would otherwise divide by zero and read as
 * infinitely anomalous.
 */
export function deviations(
  points: { period: string; value: number }[],
  opts: { minHistory?: number; threshold?: number } = {}
): Deviation[] {
  const minHistory = opts.minHistory ?? 3;
  const threshold = opts.threshold ?? 3;
  const out: Deviation[] = [];

  for (let i = 0; i < points.length; i++) {
    const history = points.slice(0, i).map((p) => p.value);
    if (history.length < minHistory) continue;
    const baseline = median(history);
    if (baseline === null) continue;
    const spread = mad(history);
    const scaled = spread === null || spread === 0 ? null : spread * 1.4826;
    const residual = points[i].value - baseline;
    const sigmas = scaled === null ? null : residual / scaled;
    out.push({
      period: points[i].period,
      value: points[i].value,
      baseline,
      residual,
      sigmas,
      flagged: sigmas !== null && Math.abs(sigmas) >= threshold,
    });
  }
  return out;
}

/**
 * Two independent measurements of one quantity, and what they disagree by.
 *
 * The disagreement is the finding. `pct` is against the first figure, which is
 * the one being checked; null when that side is zero, because a variance from
 * nothing has no percentage.
 */
export function variance(
  expected: number,
  actual: number
): { expected: number; actual: number; difference: number; pct: number | null } {
  return {
    expected,
    actual,
    difference: actual - expected,
    pct: expected === 0 ? null : (actual - expected) / Math.abs(expected),
  };
}

/**
 * Split a monthly series at the month in progress.
 *
 * A month-to-date total is not comparable with a whole month, and every trend
 * that compared them reported a collapse in the first week of every month. The
 * partial point is not discarded — it is real production — it is just kept out
 * of the arithmetic and named, so an answer can quote it as month-to-date.
 */
export function splitMonthInProgress<T extends { period: string }>(
  points: T[],
  currentMonth: string
): { complete: T[]; inProgress: T | null } {
  const last = points[points.length - 1];
  if (!last || last.period !== currentMonth) {
    return { complete: points, inProgress: null };
  }
  return { complete: points.slice(0, -1), inProgress: last };
}

/**
 * Daily points rolled to one RATE PER MEASURED DAY per month.
 *
 * Comparing month VOLUMES makes a month that is only half entered look like a
 * halving, which is the difference between a well that fell off and a pumper who
 * has not finished their paperwork. Dividing by the days each month actually
 * carries removes that; `days` travels so a month too thin to judge can still be
 * dropped downstream.
 */
export function monthlyRatesFromDaily(
  points: { period: string; value: number }[]
): { period: string; value: number; days: number }[] {
  const byMonth = new Map<string, { volume: number; days: number }>();
  for (const p of points) {
    const month = p.period.slice(0, 7);
    const agg = byMonth.get(month) ?? { volume: 0, days: 0 };
    agg.volume += Number.isFinite(p.value) ? p.value : 0;
    agg.days += 1;
    byMonth.set(month, agg);
  }
  return [...byMonth.entries()]
    .map(([period, agg]) => ({
      period,
      value: agg.days > 0 ? agg.volume / agg.days : 0,
      days: agg.days,
    }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
}
