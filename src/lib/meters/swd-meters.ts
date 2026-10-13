/**
 * SWD (water) meter derivation — a water meter reads a CUMULATIVE barrels index,
 * so its daily volume is the delta between adjacent readings, exactly like a
 * disposal well's flow meter. This reuses the tested disposal-series math
 * (`@/lib/disposal/disposal-series`) rather than the gas meter's direct-daily
 * model. For a water meter, `MeterReading.mcf` holds the cumulative barrels.
 *
 * Pure over its inputs (takes already-loaded readings), so it unit-tests without
 * a DB and can re-derive in the browser.
 */

import {
  buildDisposalSegments,
  buildDisposalRatePoints,
  type SeriesDisposalReading,
  type DisposalSegment,
  type DisposalRatePoint,
} from "@/lib/disposal/disposal-series";
import type { DailyPoint } from "@/lib/tanks/tank-series";
import type { MeterReading } from "@/lib/meters/meters";

/** Adapt a water meter's readings (cumulative bbls in `mcf`) to the disposal series. */
function toSeriesReadings(readings: MeterReading[]): SeriesDisposalReading[] {
  return readings.map((r) => ({
    id: r.id,
    date: r.date,
    time: r.time,
    meterReading: r.mcf,
    waterTransferred: null,
  }));
}

/** Per-reading derived disposal figures (delta bbls + normalized bbl/day), oldest first. */
export function swdMeterSegments(readings: MeterReading[]): DisposalSegment[] {
  return buildDisposalSegments(toSeriesReadings(readings));
}

/** This meter's daily normalized disposal rate — the meter page's chart input,
 *  through the same definition the SWD well chart uses. */
export function swdMeterRatePoints(
  readings: MeterReading[],
  meterId: string
): DisposalRatePoint[] {
  return buildDisposalRatePoints(
    swdMeterSegments(readings).map((s) => ({
      date: new Date(s.tMs).toISOString().slice(0, 10),
      volume: s.volume,
      hours: s.hours,
      sourceId: meterId,
    }))
  );
}

/** Segments indexed by source reading id, for O(1) table-row lookup. */
export function swdSegmentsByReadingId(
  readings: MeterReading[]
): Record<string, DisposalSegment> {
  const out: Record<string, DisposalSegment> = {};
  for (const s of swdMeterSegments(readings)) {
    if (s.readingId) out[s.readingId] = s;
  }
  return out;
}

/** Headline stats for a water meter (the detail-page stat row). */
export interface SwdMeterStats {
  /** Number of readings. */
  readingCount: number;
  /** Most recent cumulative index (barrels), or null. */
  latestReading: number | null;
  /** Most recent normalized disposal rate (bbl/day), or null. */
  latestRatePerDay: number | null;
  /** Total disposed over the readings (Σ segment volume), barrels. */
  totalBbls: number;
  /** Date of the most recent reading (ISO `YYYY-MM-DD`), or null. */
  lastDate: string | null;
}

/** Derive the headline stats from a water meter's readings. */
export function swdMeterStats(readings: MeterReading[]): SwdMeterStats {
  const segments = swdMeterSegments(readings);
  const last = segments[segments.length - 1];
  const totalBbls = segments.reduce((sum, s) => sum + (s.volume ?? 0), 0);
  return {
    readingCount: readings.length,
    latestReading: last?.meterReading ?? null,
    latestRatePerDay: last?.bblPerDay ?? null,
    totalBbls,
    lastDate: last ? readingDateFromMs(last.tMs) : null,
  };
}

/** ISO `YYYY-MM-DD` for a segment's epoch ms (UTC). */
function readingDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A water meter's throughput over an arbitrary `[fromMs, toMs]` window — the water
 * analogue of `productionInWindow` for tanks, and what a WELL TEST reads when it
 * names a water meter.
 *
 * Each disposal segment covers `[tMs − hours, tMs]`; a segment straddling a window
 * edge contributes only its overlapping hours at its own rate, so the test window
 * needn't line up with reading timestamps. Reset segments (`volume` null)
 * contribute nothing, exactly as they do in the daily series.
 */
export function swdMeterVolumeInWindow(
  readings: MeterReading[],
  fromMs: number,
  toMs: number
): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return 0;
  }
  let bbls = 0;
  for (const s of swdMeterSegments(readings)) {
    if (s.volume == null || s.hours == null || !(s.hours > 0)) continue;
    const segFrom = s.tMs - s.hours * 3_600_000;
    const overlapMs = Math.min(s.tMs, toMs) - Math.max(segFrom, fromMs);
    if (overlapMs <= 0) continue;
    bbls += s.volume * (overlapMs / (s.hours * 3_600_000));
  }
  return bbls;
}

/**
 * A water meter's daily disposal throughput (`bbls` per day), the meter analogue
 * of a tank's production series — used as a measured point when composing lease
 * water production. Each segment's derived volume (delta bbls) is attributed to
 * its reading date; same-day segments sum. Reset segments contribute nothing.
 */
export function swdMeterDailyBbls(readings: MeterReading[]): DailyPoint[] {
  const byDate = new Map<string, number>();
  for (const s of swdMeterSegments(readings)) {
    if (s.volume == null) continue;
    const date = readingDateFromMs(s.tMs);
    byDate.set(date, (byDate.get(date) ?? 0) + s.volume);
  }
  return [...byDate.entries()]
    .map(([date, bbls]) => ({ date, bbls }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
