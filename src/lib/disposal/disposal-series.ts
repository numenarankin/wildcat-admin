/**
 * Disposal (Mode B) meter series — the derived primitive for SWD/injection wells.
 *
 * Unlike an oil tank, an SWD well's tank is flow-through, so tank level is not a
 * production proxy. Volume comes from the well's flow meter, entered as a
 * CUMULATIVE reading. Disposal volume is arithmetic over adjacent readings:
 *
 *   delta water   = meterᵢ − meterᵢ₋₁              (per interval)
 *   normalized    = volume / Δhours × 24            (bbl/day, timing-invariant)
 *
 * A hand-entered "water transferred" value (the legacy `injected_bbls`) overrides
 * the computed delta when present, and is the primary input when the meter is
 * unused / broken (no `meterReading`). A meter that drops (reset / swap) blanks
 * the delta rather than reporting negative disposal, and re-baselines on the
 * current reading so the next interval measures from there.
 *
 * Pure and dependency-free (types + math only) so it unit-tests without a DB and
 * can re-derive live in the browser. Mirrors `tank-series.ts` over one scalar.
 */

import { anchorMs } from "@/lib/tanks/tank-series";
import type { DisposalReading } from "@/lib/disposal/types";

const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;

/** A reading reduced to what the disposal series needs. */
export interface SeriesDisposalReading {
  id?: string;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`, or "" when unknown. */
  time: string;
  /** Cumulative flow-meter reading (barrels), or null when the meter is unused. */
  meterReading: number | null;
  /** Hand-entered / override water transferred (barrels), or null. Wins over the
   * computed meter delta when present. */
  waterTransferred: number | null;
}

/** Per-reading derived disposal figures (the readings-tab row + chart input). */
export interface DisposalSegment {
  /** Source reading id (the segment's END anchor), when known. */
  readingId?: string;
  /** Epoch ms of this reading (UTC), for ordering/plotting. */
  tMs: number;
  /** Cumulative meter reading at this row (echoed for the table), or null. */
  meterReading: number | null;
  /** Δ from the previous meter reading (barrels), or null (first / reset / no meter). */
  meterDelta: number | null;
  /** Effective disposed volume: `waterTransferred` when present, else `meterDelta`. */
  volume: number | null;
  /** Hours since the previous reading, or null for the first (oldest) reading. */
  hours: number | null;
  /** Time-normalized rate: `volume / hours × 24` (bbl/day), or null. */
  bblPerDay: number | null;
  /** True when the meter dropped vs the prior reading (reset / swap); delta blanked. */
  isReset: boolean;
  /** True for the first (oldest) reading — no prior anchor, derived cols blank. */
  isFirst: boolean;
}

/**
 * Build per-reading disposal segments, oldest first. Input order-independent
 * (sorted internally by timestamp). A `run-close`-style re-baseline is applied on
 * a meter reset so the next interval measures from the current reading.
 *
 * A row that measures NO VOLUME — no meter index and no water transferred, which
 * is what a gauge reading of the wellhead pressures is — does not move the
 * clock. It is an observation about the well, not about the water: standing it
 * in the interval chain left the next real reading's barrels (measured from the
 * last METER index, which the pressure row does not touch) divided by the hours
 * since the pressure row, which is a shorter span. A day's 100 bbl read at 06:00
 * with a pressure noted at noon came out as 133 bbl/day.
 */
export function buildDisposalSegments(
  readings: SeriesDisposalReading[]
): DisposalSegment[] {
  const sorted = [...readings].sort(
    (a, b) => anchorMs(a.date, a.time) - anchorMs(b.date, b.time)
  );

  let prevMeter: number | null = null;
  let prevMs: number | null = null;

  return sorted.map((r, i) => {
    const tMs = anchorMs(r.date, r.time);
    const isFirst = i === 0;
    /** Does this row measure water at all? See the note above. */
    const measuresVolume = r.meterReading != null || r.waterTransferred != null;
    const hours = prevMs == null || !measuresVolume ? null : (tMs - prevMs) / HOUR_MS;

    // Meter delta only when both this and the prior reading carry a cumulative
    // meter value. A drop is a reset / meter swap: blank it, never negative.
    let meterDelta: number | null = null;
    let isReset = false;
    if (r.meterReading != null && prevMeter != null) {
      const d = r.meterReading - prevMeter;
      if (d < 0) isReset = true;
      else meterDelta = d;
    }

    // An explicit water-transferred entry wins (hand-entry or override); else the
    // computed meter delta.
    const volume = r.waterTransferred != null ? r.waterTransferred : meterDelta;

    const bblPerDay =
      volume != null && hours != null && hours > 0
        ? (volume / hours) * DAY_HOURS
        : null;

    // Advance the baseline. On a reset, re-baseline on THIS reading so the next
    // interval measures forward from here rather than across the reset. A row
    // that measured no volume advances neither: it is not an end point for the
    // interval before it, nor a start point for the one after.
    if (r.meterReading != null) prevMeter = r.meterReading;
    if (measuresVolume) prevMs = tMs;

    return {
      readingId: r.id,
      tMs,
      meterReading: r.meterReading,
      meterDelta,
      volume,
      hours,
      bblPerDay,
      isReset,
      isFirst,
    };
  });
}

// --- Daily rate (chart input) ----------------------------------------------

/** A day's normalized disposal rate, for the disposal-rate chart. */
export interface DisposalRatePoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** bbl/day. */
  rate: number;
}

/** One measured interval, reduced to what the daily rate needs. */
export interface RateInterval {
  /** ISO `YYYY-MM-DD` of the interval's end anchor. */
  date: string;
  /** Effective disposed volume over the interval (barrels), or null. */
  volume: number | null;
  /** Hours the interval spans, or null for the first reading of a source. */
  hours: number | null;
  /** What measured it — intervals from different devices are pooled separately
   * and then SUMMED, since two meters into one well genuinely add up. */
  sourceId: string;
}

/**
 * Daily normalized disposal rate. Each source's intervals are pooled per day
 * (Σvolume ÷ Σhours × 24, so an irregular reading cadence doesn't distort the
 * rate the way a plain average of interval rates would), then the sources are
 * summed. The one definition of "bbl/day on a date" — the SWD well chart and the
 * SWD meter chart both plot this.
 */
export function buildDisposalRatePoints(
  intervals: RateInterval[]
): DisposalRatePoint[] {
  const pools = new Map<string, { date: string; volume: number; hours: number }>();
  for (const i of intervals) {
    if (i.volume == null || i.hours == null || !(i.hours > 0)) continue;
    const key = `${i.date}|${i.sourceId}`;
    const pool = pools.get(key) ?? { date: i.date, volume: 0, hours: 0 };
    pool.volume += i.volume;
    pool.hours += i.hours;
    pools.set(key, pool);
  }
  const byDate = new Map<string, number>();
  for (const p of pools.values()) {
    byDate.set(p.date, (byDate.get(p.date) ?? 0) + (p.volume / p.hours) * 24);
  }
  return [...byDate.entries()]
    .map(([date, rate]) => ({ date, rate }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Total effective disposed volume over the readings (Σ segment volume). */
export function totalDisposedVolume(readings: SeriesDisposalReading[]): number {
  return buildDisposalSegments(readings).reduce(
    (sum, s) => sum + (s.volume ?? 0),
    0
  );
}

// --- DisposalReading adapters (map the stored field to the series input) -----

/** Adapt a stored `DisposalReading` (whose `injectedBbls` holds the manual /
 * override water-transferred value) to a `SeriesDisposalReading`. */
export function toSeriesReading(r: DisposalReading): SeriesDisposalReading {
  return {
    id: r.id,
    date: r.date,
    time: r.time,
    meterReading: r.meterReading,
    waterTransferred: r.injectedBbls,
  };
}

/**
 * NOTE: there is deliberately no "total for a well's readings" helper here.
 * A disposal well's volume comes from the meters wired into it, with these
 * hand-entered readings counting only where no meter was — that resolution lives
 * in `well-series.ts`, and it is the only place allowed to total a well.
 */
