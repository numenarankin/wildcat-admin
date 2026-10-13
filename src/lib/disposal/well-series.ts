/**
 * An SWD/injection well's disposal series — the single source of truth for how
 * much water a disposal well took, and where that was measured.
 *
 * A disposal well is a SINK, not a source. Nothing is produced there, so its
 * volume is whatever the flow meter on the line into it measured — the same
 * shape as gas, where a gas well's volume comes from its meter rather than from
 * anything entered on the well. A water meter is wired to a disposal well by a
 * `meter -> well` water edge in `flow_connections`; this module sums those
 * meters' throughput, derived by the tested cumulative-index delta math in
 * `swd-meters.ts`.
 *
 * **Hand entry always counts.** Every `disposal_readings` row is a reading the
 * pumper took, on a metered date or not; the phone records every SWD reading
 * there. `isMetered` (an edge active on `onDate`) still says whose counter the
 * cumulative index is.
 *
 * **Edge shares are deliberately ignored here.** `flow_connections.share_pct` is
 * TO-normalized — the share of the DOWNSTREAM node from each upstream one — which
 * is the right convention for attributing a measured volume upstream, and it is
 * what `attributeToWells` uses to push this well's water back to producers. It is
 * NOT a from-normalized routing split, and per the architecture doc split routing
 * is never stored: "60% injected / 40% hauled" is implied by the physically
 * distinct measured volumes. So a meter wired to a disposal well contributes ALL
 * of its throughput (edges are written at 100). One meter feeding two disposal
 * wells is not representable and is a deferred case, not a silent misallocation.
 *
 * Pure and dependency-free (types + math), so it unit-tests without a DB and can
 * re-derive live in the browser. See `docs/swd-connections-architecture.md`.
 */

import { anchorMs } from "@/lib/tanks/tank-series";
import { swdMeterSegments } from "@/lib/meters/swd-meters";
import {
  buildDisposalSegments,
  buildDisposalRatePoints,
  toSeriesReading,
  type DisposalRatePoint,
} from "@/lib/disposal/disposal-series";
import type { MeterReading } from "@/lib/meters/meters";
import type { DisposalReading } from "@/lib/disposal/types";

/** The effective-date window of one `meter -> well` edge. */
export interface FlowWindow {
  /** ISO `YYYY-MM-DD` the edge takes effect. */
  effectiveFrom: string;
  /** ISO `YYYY-MM-DD` the edge ends, or null while still wired in. */
  effectiveTo: string | null;
}

/** One water meter wired into the well, with everything the series needs. */
export interface DisposalMeterFeed {
  meterId: string;
  meterName: string;
  /** The meter's readings (cumulative barrels index in `mcf`), any order. */
  readings: MeterReading[];
  /** This meter's `meter -> well` water edges for THIS well. */
  edges: FlowWindow[];
}

/** Where a row's volume was measured. */
export type DisposalRowSource = "meter" | "manual";

/**
 * One row of the well's disposal log — a meter interval, or a hand-entered
 * reading from before the well was metered. Shaped so the readings table, the
 * export, and the chart all render the same numbers.
 */
export interface DisposalRow {
  /** Stable key for React / dedup: source id + reading id. */
  key: string;
  /** ISO `YYYY-MM-DD` of the interval's END anchor. */
  date: string;
  /** `HH:MM`, or "" when unknown. */
  time: string;
  /** Epoch ms of the END anchor (UTC), for ordering/plotting. */
  tMs: number;
  source: DisposalRowSource;
  /** Meter id for a meter row, else null. */
  sourceId: string | null;
  /** Meter name for a meter row, else "" (hand entry has no device). */
  sourceName: string;
  /** Cumulative index at this row (barrels), or null. */
  meterReading: number | null;
  /** Effective disposed volume over the interval (barrels), or null. */
  volume: number | null;
  /** Hours since the previous reading on the same source, or null. */
  hours: number | null;
  /** Time-normalized rate, `volume / hours × 24` (bbl/day), or null. */
  bblPerDay: number | null;
  /** Injection (tubing) pressure, psi, or null. */
  injectionPressure: number | null;
  /** Casing pressure, psi, or null. */
  casingPressure: number | null;
  /** Free-text remarks, or "". */
  notes: string;
  /** True when the index dropped vs the prior reading (reset / meter swap). */
  /** Auth user id of whoever recorded a hand-entered row; null on a meter row. */
  recordedBy: string | null;
  isReset: boolean;
}

/** Everything the SWD well surfaces derive from — one resolver, one answer. */
export interface DisposalWellSeries {
  /** The disposal log, oldest first. */
  rows: DisposalRow[];
  /** Daily normalized rate for the chart, oldest first. */
  ratePoints: DisposalRatePoint[];
  /** Σ effective volume over every counted row (barrels). */
  total: number;
  /** Most recent day's total rate (bbl/day), or null. */
  latestRate: number | null;
  /** Σ latest cumulative index across the meters wired in on `onDate`, or the
   * last hand-entered index when the well is unmetered. Null when neither. */
  cumulativeIndex: number | null;
  /** Mean injection pressure over the counted rows that carry one, or null. */
  avgInjectionPressure: number | null;
  /** True when a meter edge is active on `onDate` — hand entry is closed. */
  isMetered: boolean;
  /** Meters wired into the well on `onDate`. */
  meterCount: number;
  /** Number of counted rows (the "readings" count on roll-ups). */
  readingCount: number;
  /** ISO date of the most recent counted row, or null. */
  lastDate: string | null;
}

/** ISO `YYYY-MM-DD` (UTC) for an epoch ms. */
function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Is any of these edges active on `date`? Inclusive bounds with an open
 * `effectiveTo`, matching `activeAllocations` / `activeConnections` so a well's
 * "is it metered" answer can't drift from what attribution thinks.
 */
export function windowActiveOn(windows: FlowWindow[], date: string): boolean {
  return windows.some(
    (w) =>
      w.effectiveFrom <= date && (w.effectiveTo == null || w.effectiveTo >= date)
  );
}

/** Sort key for a hand-entered reading (must match `buildDisposalSegments`). */
function manualOrder(r: DisposalReading): number {
  return anchorMs(r.date, r.time);
}

/**
 * Build the well's disposal log from its meters plus any hand-entered fallback
 * readings, oldest first. Date-by-date, never both sources at once.
 */
export function buildDisposalWellRows(
  feeds: DisposalMeterFeed[],
  manualReadings: DisposalReading[]
): DisposalRow[] {
  const rows: DisposalRow[] = [];

  // Meter rows: each meter's own interval math, kept only for the intervals that
  // meter was actually wired into this well.
  for (const feed of feeds) {
    const ordered = [...feed.readings].sort(
      (a, b) => anchorMs(a.date, a.time) - anchorMs(b.date, b.time)
    );
    const indexById = new Map(ordered.map((r, i) => [r.id, i]));

    for (const seg of swdMeterSegments(feed.readings)) {
      const date = dateOf(seg.tMs);
      if (!windowActiveOn(feed.edges, date)) continue;

      const i = seg.readingId ? indexById.get(seg.readingId) : undefined;
      const reading = i == null ? undefined : ordered[i];
      const prior = i == null || i === 0 ? undefined : ordered[i - 1];

      // An interval whose START anchor predates the wiring measures water that
      // went somewhere else — it is this well's BASELINE, not its volume. Without
      // this, moving a meter between disposal wells would credit one interval to
      // both. The row still shows (the index is real); the volume is blanked.
      const isBaseline =
        prior != null && !windowActiveOn(feed.edges, prior.date);

      rows.push({
        key: `meter:${feed.meterId}:${seg.readingId ?? seg.tMs}`,
        date,
        time: reading?.time ?? "",
        tMs: seg.tMs,
        source: "meter",
        sourceId: feed.meterId,
        sourceName: feed.meterName,
        meterReading: seg.meterReading,
        volume: isBaseline ? null : seg.volume,
        hours: isBaseline ? null : seg.hours,
        bblPerDay: isBaseline ? null : seg.bblPerDay,
        injectionPressure: reading?.injectionPressure ?? null,
        casingPressure: reading?.casingPressure ?? null,
        notes: "",
        recordedBy: null,
        isReset: seg.isReset,
      });
    }
  }

  // Hand-entered rows ALWAYS count. They used to be dropped on dates a meter
  // covered, which hid a reading the pumper had just recorded whenever the
  // phone put it here on a metered well; the phone now records every SWD
  // reading here, so the rows are the record and nothing filters them.
  const kept = [...manualReadings].sort((a, b) => manualOrder(a) - manualOrder(b));
  const manualSegments = buildDisposalSegments(kept.map(toSeriesReading));
  manualSegments.forEach((seg, i) => {
    const r = kept[i];
    rows.push({
      key: `manual:${r.id ?? seg.tMs}`,
      date: r.date,
      time: r.time,
      tMs: seg.tMs,
      source: "manual",
      sourceId: null,
      sourceName: "",
      meterReading: seg.meterReading,
      volume: seg.volume,
      hours: seg.hours,
      bblPerDay: seg.bblPerDay,
      injectionPressure: r.injectionPressure,
      casingPressure: r.casingPressure,
      notes: r.notes,
      recordedBy: r.createdBy ?? null,
      isReset: seg.isReset,
    });
  });

  return rows.sort((a, b) => a.tMs - b.tMs || a.key.localeCompare(b.key));
}

/** The well's daily disposal rate — its rows as rate intervals, per source. */
export function disposalWellRatePoints(rows: DisposalRow[]): DisposalRatePoint[] {
  return buildDisposalRatePoints(
    rows.map((r) => ({
      date: r.date,
      volume: r.volume,
      hours: r.hours,
      sourceId: r.sourceId ?? "manual",
    }))
  );
}

/**
 * The full derived series for one disposal well. Every SWD surface — the well
 * page, the disposal index roll-up, the series/export routes, the Water Disposed
 * report, and Orion — reads this, so they cannot disagree about a well's volume.
 */
export function buildDisposalWellSeries(
  feeds: DisposalMeterFeed[],
  manualReadings: DisposalReading[],
  onDate: string
): DisposalWellSeries {
  const rows = buildDisposalWellRows(feeds, manualReadings);
  const ratePoints = disposalWellRatePoints(rows);

  const liveFeeds = feeds.filter((f) => windowActiveOn(f.edges, onDate));
  // Cumulative index: the meters' own counters summed while metered; the last
  // hand-entered index otherwise. Never both — they measure the same barrels.
  let cumulativeIndex: number | null = null;
  if (liveFeeds.length > 0) {
    for (const f of liveFeeds) {
      const last = swdMeterSegments(f.readings).at(-1)?.meterReading;
      if (last != null) cumulativeIndex = (cumulativeIndex ?? 0) + last;
    }
  } else {
    cumulativeIndex =
      [...rows].reverse().find((r) => r.meterReading != null)?.meterReading ??
      null;
  }

  const pressures = rows
    .map((r) => r.injectionPressure)
    .filter((p): p is number => p != null);

  return {
    rows,
    ratePoints,
    total: rows.reduce((sum, r) => sum + (r.volume ?? 0), 0),
    latestRate: ratePoints.at(-1)?.rate ?? null,
    cumulativeIndex,
    avgInjectionPressure:
      pressures.length > 0
        ? pressures.reduce((s, p) => s + p, 0) / pressures.length
        : null,
    isMetered: liveFeeds.length > 0,
    meterCount: liveFeeds.length,
    readingCount: rows.length,
    lastDate: rows.at(-1)?.date ?? null,
  };
}
