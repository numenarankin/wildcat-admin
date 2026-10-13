/**
 * Tank-level time series (production overhaul, Phase 2) — the ONE derived
 * primitive the whole oil-production feature reads from.
 *
 * The series is not stored; it is built from two source tables as a stream of
 * typed level ANCHORS:
 *
 *   - a reading contributes one anchor: `bbls` at its timestamp.
 *   - a run contributes two anchors at its departure timestamp: `run-open`
 *     (level before the haul) then `run-close` (level after). A run's open is a
 *     legitimate purchaser measurement, a first-class anchor like a pumper read.
 *
 * Production is arithmetic over adjacent anchors:
 *
 *   reading → reading        production
 *   reading → run.open       production (tank filled up to the haul)
 *   run.open → run.close     EXCLUDED (the haul, not production)
 *   run.close → reading      production (the fill after the haul)
 *
 * Each production segment yields `impl bbl/day = Δbbls / Δhours × 24`.
 * "Regularizing" resamples that piecewise-constant rate onto uniform 24h days so
 * irregular pumper timing stops making one day read 2× another.
 *
 * Pure and dependency-free (types + math only) so the tank page re-derives live
 * as readings are edited in the browser, and it unit-tests without a database.
 */

import type { ProductionPoint } from "@/lib/wells/wells";

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * A run missing a departure time sorts to this fixed hour on its ticket date, so
 * it lands after that day's pumper readings without fabricating precision.
 */
export const DEFAULT_RUN_TIME = "23:59";

// --- Inputs (structurally satisfied by TankReading / RunTicket) -------------

/** A reading reduced to what the series needs. */
export interface SeriesReading {
  id: string;
  date: string;
  time: string;
  bbls: number;
}

/** A run reduced to what the series needs. */
export interface SeriesRun {
  id: string;
  date: string;
  /** `HH:MM`, or "" when unknown (falls back to {@link DEFAULT_RUN_TIME}). */
  departureTime: string;
  /** Derived level before the haul (barrels), or null on a gauge-less ticket. */
  openBbls: number | null;
  /** Derived level after the haul (barrels), or null on a gauge-less ticket. */
  closeBbls: number | null;
  /** Gross barrels hauled — the fallback drop for a gauge-less run. */
  grossBbls: number;
}

// --- Anchors & segments -----------------------------------------------------

export type AnchorKind = "reading" | "run-open" | "run-close";

export interface LevelAnchor {
  tMs: number;
  /** Absolute tank level in barrels, or null for a gauge-less run anchor. */
  bbls: number | null;
  kind: AnchorKind;
  /** Source row id (reading id or run ticket id). */
  sourceId: string;
  /** Gross barrels hauled, carried on a `run-close` for the gauge-less fallback. */
  grossBbls?: number;
}

export interface Segment {
  fromMs: number;
  toMs: number;
  hours: number;
  /** Barrels gained over the segment (`to − from` level). Negative kept as-is. */
  deltaBbls: number;
  /** `deltaBbls / hours × 24`, or 0 when the segment has no elapsed time. */
  bblPerDay: number;
  /** True for the `run-open → run-close` haul segment (excluded from production). */
  isHaul: boolean;
  /** Anchor kinds bounding the segment, for downstream tagging (e.g. "since run"). */
  fromKind: AnchorKind;
  toKind: AnchorKind;
  /** Source id of the segment's END anchor (the reading a row is shown against). */
  toSourceId: string;
}

/** Epoch ms for an ISO date + `HH:MM` (UTC), matching decline.ts / summary-calc.ts. */
export function anchorMs(date: string, time: string): number {
  const t = time && time.length >= 4 ? time : "00:00";
  return Date.parse(`${date}T${t}:00Z`);
}

/** ISO `YYYY-MM-DD` (UTC) for an epoch ms. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The ids of readings that sit at exactly a run's timestamp.
 *
 * A pumper does not gauge a tank while the truck is loading it. The real events
 * are a gauge shortly before the truck or shortly after, and those carry
 * different times, so an exact match means the run's time was copied into the
 * reading. The ticket's own opening and closing gauges already measure that
 * instant, and they are the driver's measurement of the same tank, so they are
 * the ones the series uses.
 *
 * Exported because the reading is NOT deleted: it stays on the tank's readings
 * table, marked as unused, so a conflict between it and the ticket's gauges is
 * visible and someone can fix the time. Silently dropping a reading that
 * disagrees with both gauges would hide the very thing worth seeing.
 */
export function readingsAtRunTimes(
  readings: SeriesReading[],
  runs: SeriesRun[]
): Set<string> {
  const runTimes = new Set(
    runs.map((run) => anchorMs(run.date, run.departureTime || DEFAULT_RUN_TIME))
  );
  const out = new Set<string>();
  for (const r of readings) {
    if (runTimes.has(anchorMs(r.date, r.time))) out.add(r.id);
  }
  return out;
}

/**
 * Build the timestamp-sorted anchor list from a tank's readings + runs.
 *
 * Readings that land on a run's timestamp are left out entirely (see
 * {@link readingsAtRunTimes}). Nothing is lost by that: production is the level
 * difference between consecutive anchors, and the run's two gauges already
 * bracket that moment -- the fill before the haul is measured from the previous
 * reading up to the opening gauge, and the fill after it from the closing gauge
 * to the next reading.
 *
 * With those removed, the only remaining tie is a run's own two anchors, which
 * order open then close. Nothing can sort between them, so the haul is always
 * one segment.
 *
 * This used to keep such a reading and sort it first, then pattern-match the
 * result to move an out-of-order one back after the haul. That second step
 * rewrote a timestamp the pumper actually entered, which is not this software's
 * call: a mistyped time is reported as entered, and only the ambiguous case --
 * two anchors sharing one minute, where nothing was said about the order -- is
 * resolved here.
 */
export function buildTankLevelSeries(
  readings: SeriesReading[],
  runs: SeriesRun[]
): LevelAnchor[] {
  const anchors: LevelAnchor[] = [];
  const superseded = readingsAtRunTimes(readings, runs);

  for (const r of readings) {
    if (superseded.has(r.id)) continue;
    anchors.push({
      tMs: anchorMs(r.date, r.time),
      bbls: r.bbls,
      kind: "reading",
      sourceId: r.id,
    });
  }

  for (const run of runs) {
    const tMs = anchorMs(run.date, run.departureTime || DEFAULT_RUN_TIME);
    anchors.push({ tMs, bbls: run.openBbls, kind: "run-open", sourceId: run.id });
    anchors.push({
      tMs,
      bbls: run.closeBbls,
      kind: "run-close",
      sourceId: run.id,
      grossBbls: run.grossBbls,
    });
  }

  const order: Record<AnchorKind, number> = {
    reading: 0,
    "run-open": 1,
    "run-close": 2,
  };
  anchors.sort((a, b) => a.tMs - b.tMs || order[a.kind] - order[b.kind]);
  return anchors;
}

/**
 * Resolve each anchor to an effective level, carrying the last known level
 * forward across gauge-less run anchors: a gauge-less run-open holds the carried
 * level (its fill can't be measured), and a gauge-less run-close drops it by the
 * run's gross barrels — so the haul reads as a `−gross` step and the following
 * fill is measured off the post-haul level.
 */
function resolveLevels(anchors: LevelAnchor[]): number[] {
  const levels: number[] = [];
  let carry = 0;
  for (const a of anchors) {
    let eff: number;
    if (a.bbls != null && Number.isFinite(a.bbls)) {
      eff = a.bbls;
    } else if (a.kind === "run-close") {
      eff = carry - (a.grossBbls ?? 0);
    } else {
      eff = carry; // reading with no bbls (shouldn't happen) / gauge-less run-open
    }
    levels.push(eff);
    carry = eff;
  }
  return levels;
}

/** One segment per adjacent anchor pair; the haul segment is flagged, not dropped. */
export function deriveSegments(anchors: LevelAnchor[]): Segment[] {
  if (anchors.length < 2) return [];
  const levels = resolveLevels(anchors);
  const segments: Segment[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const from = anchors[i - 1];
    const to = anchors[i];
    const hours = (to.tMs - from.tMs) / HOUR_MS;
    const deltaBbls = levels[i] - levels[i - 1];
    const isHaul = from.kind === "run-open" && to.kind === "run-close";
    segments.push({
      fromMs: from.tMs,
      toMs: to.tMs,
      hours,
      deltaBbls,
      bblPerDay: hours > 0 ? (deltaBbls / hours) * 24 : 0,
      isHaul,
      fromKind: from.kind,
      toKind: to.kind,
      toSourceId: to.sourceId,
    });
  }
  return segments;
}

/** The production segments (everything but the excluded haul). */
export function productionSegments(segments: Segment[]): Segment[] {
  return segments.filter((s) => !s.isHaul);
}

/**
 * The tank's CURRENT daily rate: the rate of its most recent gauge interval, and
 * the date that interval closed on. Null when nothing has been measured.
 *
 * NOT the last point of `dailyProduction`, which is what this replaces. A
 * regularized series spreads each interval's barrels over the calendar days it
 * covers, and the final day only gets the hours up to the gauge — a tank read at
 * 8am contributes eight hours to its last day, so that point is a third of a
 * day's production. Read as a rate it understated every tank by the fraction of
 * the day the last reading happened to land on: the company headline showed 18
 * bbl/d over wells summing to 50.
 */
export function latestSegmentRate(
  segments: Segment[]
): { bblPerDay: number; asOf: string } | null {
  const prod = productionSegments(segments);
  for (let i = prod.length - 1; i >= 0; i--) {
    const s = prod[i];
    // A zero-elapsed segment is a correction, not an interval; it has no rate.
    if (!(s.hours > 0)) continue;
    return { bblPerDay: s.bblPerDay, asOf: dayKey(s.toMs) };
  }
  return null;
}

/**
 * Production barrels over an arbitrary `[fromMs, toMs]` window — the same overlap
 * integration {@link dailyProduction} does per calendar day, but for one span.
 *
 * This is what a WELL TEST reads: the isolation tank's (and each control tank's)
 * production between the test's open and close observations, with the haul segment
 * excluded so a run ticket inside the window doesn't read as negative production.
 * A segment straddling a window edge contributes only its overlapping hours at its
 * own rate, so the window needn't line up with reading timestamps.
 *
 * Returns 0 for a non-positive or unparseable window.
 */
export function productionInWindow(
  segments: Segment[],
  fromMs: number,
  toMs: number
): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return 0;
  }
  let bbls = 0;
  for (const s of productionSegments(segments)) {
    const overlapMs = Math.min(s.toMs, toMs) - Math.max(s.fromMs, fromMs);
    if (overlapMs <= 0) continue;
    if (!(s.hours > 0)) {
      // Zero-elapsed correction: it belongs to an instant, so count it whole when
      // that instant falls inside the window.
      if (s.toMs >= fromMs && s.toMs <= toMs) bbls += s.deltaBbls;
      continue;
    }
    bbls += (overlapMs / HOUR_MS) * (s.bblPerDay / 24);
  }
  return bbls;
}

// --- Daily series (raw vs regularized) --------------------------------------

export type SeriesMode = "raw" | "regularized" | "reading";

export interface DailyPoint {
  /** ISO `YYYY-MM-DD` (UTC). */
  date: string;
  /** Barrels attributed to the day. */
  bbls: number;
}

/** Inclusive `[from, to]` day span covering all production segments, or null. */
function segmentSpan(segs: Segment[]): { from: string; to: string } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of segs) {
    if (s.fromMs < lo) lo = s.fromMs;
    if (s.toMs > hi) hi = s.toMs;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { from: dayKey(lo), to: dayKey(hi) };
}

/**
 * Per-day production over `[from, to]`.
 *
 *  - `regularized` (default): resample the piecewise-constant per-segment rate
 *    onto uniform calendar days — `Σ (hours of the segment overlapping day D) ×
 *    bblPerDay / 24`. A 36-hour gap spreads its oil across both days instead of
 *    dumping 1.5 days onto one.
 *  - `raw`: assign each segment's whole `deltaBbls` to the calendar day of its
 *    END anchor (lumpy, matches what was physically recorded).
 *  - `reading`: one point per gauge interval — each segment's RATE (`bblPerDay`)
 *    on the day of its closing reading. This is what the tank's Production tab
 *    prints, so a lease built from it reports the same days and the same
 *    figures as the tanks under it: N readings produce N-1 production days, and
 *    a reading interval that happens to cross midnight stays one day rather
 *    than being split by the hour. Readings are taken around midday, so hour-
 *    weighting a gauge to the minute claims a precision the reading does not
 *    have. Segments closed by a run ticket are left out, exactly as the tank
 *    table leaves them out.
 *
 * `raw` and `regularized` integrate to the same total over a span containing the
 * segments. `reading` does not: it is a series of RATES, not of volumes.
 */
export type NegativeSegments = "keep" | "unmeasured";

export function dailyProduction(
  segments: Segment[],
  opts: {
    from?: string;
    to?: string;
    mode?: SeriesMode;
    /**
     * What a NEGATIVE gauge interval means to the series.
     *
     * `keep` (default): the interval's net is attributed as-is. The level fell
     * with no run ticket to explain it, and the tank pages and the exception
     * report show that number because it is where the missing ticket gets
     * entered.
     *
     * `unmeasured`: every day the interval touches is left out of the series,
     * so a consumer keyed on "which days were measured" (the dashboard's
     * company line, `chart-buckets.ts`) carries the last measured rate across
     * them instead of averaging a haul-shaped hole into the fleet's current
     * rate. The whole day goes, not just the negative hours: the day the
     * interval opens on is a mix of the real fill before the gauge and the
     * drop after it, and its total is unknowable until the ticket is filed.
     */
    negativeSegments?: NegativeSegments;
  } = {}
): DailyPoint[] {
  const prod = productionSegments(segments);
  const mode = opts.mode ?? "regularized";

  const span = segmentSpan(prod);
  const from = opts.from ?? span?.from;
  const to = opts.to ?? span?.to;
  if (!from || !to) return [];

  const byDay = new Map<string, number>();
  const startMs = anchorMs(from, "00:00");
  const endMs = anchorMs(to, "00:00");

  if (mode === "raw") {
    for (const s of prod) {
      const d = dayKey(s.toMs);
      if (d < from || d > to) continue;
      byDay.set(d, (byDay.get(d) ?? 0) + s.deltaBbls);
    }
  } else if (mode === "reading") {
    for (const s of prod) {
      if (s.toKind !== "reading") continue;
      const d = dayKey(s.toMs);
      if (d < from || d > to) continue;
      byDay.set(d, (byDay.get(d) ?? 0) + s.bblPerDay);
    }
  } else {
    for (const s of prod) {
      if (!(s.hours > 0)) {
        // Zero-elapsed correction: drop its whole delta on the end day.
        const d = dayKey(s.toMs);
        if (d >= from && d <= to) byDay.set(d, (byDay.get(d) ?? 0) + s.deltaBbls);
        continue;
      }
      const ratePerDay = s.bblPerDay; // barrels per 24h over the segment
      for (let dayMs = startMs; dayMs <= endMs; dayMs += DAY_MS) {
        const dayEnd = dayMs + DAY_MS;
        const overlapMs =
          Math.min(s.toMs, dayEnd) - Math.max(s.fromMs, dayMs);
        if (overlapMs <= 0) continue;
        const bbls = (overlapMs / HOUR_MS) * (ratePerDay / 24);
        const d = dayKey(dayMs);
        byDay.set(d, (byDay.get(d) ?? 0) + bbls);
      }
    }
  }

  if (opts.negativeSegments === "unmeasured") {
    for (const s of prod) {
      if (!(s.deltaBbls < 0)) continue;
      // Every calendar day the interval overlaps, [open, close]; a zero-elapsed
      // correction is an instant on its end day.
      const first = dayKey(s.hours > 0 ? s.fromMs : s.toMs);
      const last = dayKey(s.toMs);
      for (let d = first; d <= last; d = dayKey(anchorMs(d, "00:00") + DAY_MS)) {
        byDay.delete(d);
      }
    }
  }

  return [...byDay.entries()]
    .map(([date, bbls]) => ({ date, bbls }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface MonthlyPoint {
  /** ISO `YYYY-MM` bucket. */
  month: string;
  bbls: number;
  /** Distinct producing days in the month (rate = bbls / days). */
  days: number;
}

/** Roll a daily series up to monthly volume + producing-day count (decline grain). */
export function monthlyProduction(
  segments: Segment[],
  opts: { from?: string; to?: string; mode?: SeriesMode } = {}
): MonthlyPoint[] {
  const daily = dailyProduction(segments, opts);
  const byMonth = new Map<string, { bbls: number; days: number }>();
  for (const d of daily) {
    const m = d.date.slice(0, 7);
    const s = byMonth.get(m) ?? { bbls: 0, days: 0 };
    s.bbls += d.bbls;
    s.days += 1;
    byMonth.set(m, s);
  }
  return [...byMonth.entries()]
    .map(([month, s]) => ({ month, bbls: s.bbls, days: s.days }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

// --- Aggregation ------------------------------------------------------------

/** Sum several tanks' daily series into one, aligned by date (battery rollup). */
export function sumDailySeries(seriesList: DailyPoint[][]): DailyPoint[] {
  const byDay = new Map<string, number>();
  for (const series of seriesList) {
    for (const p of series) byDay.set(p.date, (byDay.get(p.date) ?? 0) + p.bbls);
  }
  return [...byDay.entries()]
    .map(([date, bbls]) => ({ date, bbls }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Split a tank's daily series to wells by a per-date share function (the same
 * `methodShares` seam the allocation engine uses). Returns each well's daily
 * series. A date with no shares (all wells offline) drops out.
 */
export function splitDailyByShares(
  daily: DailyPoint[],
  sharesForDate: (date: string) => Map<string, number>
): Map<string, DailyPoint[]> {
  const out = new Map<string, DailyPoint[]>();
  for (const p of daily) {
    const shares = sharesForDate(p.date);
    for (const [wellId, share] of shares) {
      const list = out.get(wellId) ?? [];
      list.push({ date: p.date, bbls: p.bbls * share });
      out.set(wellId, list);
    }
  }
  return out;
}

// --- Output shape -----------------------------------------------------------

/**
 * Map a daily oil series to `ProductionPoint`-compatible rows so the chart,
 * production table, and decline fit consume it with no shape change. Gas / stock
 * / sales are the caller's to fill (this module is oil-volume only).
 */
export function toProductionPoints(daily: DailyPoint[]): ProductionPoint[] {
  return daily.map((d) => ({
    date: d.date,
    time: "12:00",
    oilProduction: d.bbls,
    oilStock: 0,
    oilSales: 0,
    gasProduction: 0,
    saltWater: 0,
  }));
}

/** Convenience: readings + runs → daily production points in one call. */
export function tankDailyProduction(
  readings: SeriesReading[],
  runs: SeriesRun[],
  opts: { from?: string; to?: string; mode?: SeriesMode } = {}
): DailyPoint[] {
  const segments = deriveSegments(buildTankLevelSeries(readings, runs));
  return dailyProduction(segments, opts);
}
