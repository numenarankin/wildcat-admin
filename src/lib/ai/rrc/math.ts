/**
 * Shared arithmetic for the RRC analysis tools.
 *
 * Pure, dependency-free, and small on purpose. Every tool in this catalog exists
 * because the model was doing this in prose; none of it should be reimplemented
 * per tool, and none of it should grow into a statistics library.
 */

/** Mean, or null for an empty set. Nulls in the input are dropped, not zeroed. */
export function mean(values: readonly (number | null | undefined)[]): number | null {
  const nums = clean(values);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function sum(values: readonly (number | null | undefined)[]): number {
  return clean(values).reduce((a, b) => a + b, 0);
}

/** Nulls dropped. A null is "not reported", which is not zero. */
export function clean(values: readonly (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/** Linear interpolation percentile over a sorted copy. `p` in [0, 1]. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

export function stddev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  const variance = values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export interface Fit {
  slope: number;
  intercept: number;
  /** Coefficient of determination. Null when the input has no variance to explain. */
  r2: number | null;
  n: number;
}

/** Ordinary least squares on (x, y) pairs. */
export function linearFit(points: readonly (readonly [number, number])[]): Fit | null {
  const pts = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((a, [x]) => a + x, 0) / n;
  const my = pts.reduce((a, [, y]) => a + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return {
    slope,
    intercept: my - slope * mx,
    r2: syy === 0 ? null : (sxy * sxy) / (sxx * syy),
    n,
  };
}

/** Great-circle distance in statute miles. */
export function distanceMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees from north. */
export function bearingDegrees(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Months between two `YYYY-MM` cycles. Negative when `b` precedes `a`. */
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** Add months to a `YYYY-MM` cycle. */
export function addMonths(cycle: string, months: number): string {
  const [y, m] = cycle.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Days in the calendar month of a `YYYY-MM` cycle. */
export function daysInCycle(cycle: string): number {
  const [y, m] = cycle.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Herfindahl-Hirschman index over shares of a total, on the 0 to 10,000 scale.
 * Null when the total is zero, because concentration of nothing is undefined.
 */
export function hhi(values: readonly number[]): number | null {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return values.reduce((a, v) => a + ((v / total) * 100) ** 2, 0);
}

/**
 * A deterministic pseudo-random generator.
 *
 * Every sampling tool takes an explicit seed and reports it, so a number that
 * reached an answer can be reproduced exactly. `Math.random` would make the one
 * part of this system carrying error bars the one part nobody can check.
 */
export function seeded(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) | 0;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}
