/**
 * Water-production measurement model (pure) — turns MEASURED water volumes into
 * per-producing-well production, without double-counting.
 *
 * `flow_connections` says WHERE water goes; it carries no volumes. Production
 * magnitude comes only from measured points, and there are exactly three kinds:
 *
 *   1. throughput      — water passing through a meter (or an SWD well's disposal
 *                        meter). The primary measurement.
 *   2. haul            — water trucked off a tank (haul tickets / dispositions).
 *                        A haul bypasses any downstream meter, so it is a real,
 *                        separate measurement, always additive.
 *   3. terminal_gauge  — the gauge-derived volume of a TERMINAL tank (one whose
 *                        water connects to nothing downstream). Only a terminal
 *                        tank's gauge counts: a non-terminal tank is flow-through,
 *                        so its gauge would double-count the downstream meter.
 *
 *   water produced = Σ throughput + Σ haul + Σ terminal_gauge
 *
 * Each measured volume is then attributed back to producing wells through the
 * flow graph (`attributeToWells`). Callers decide which tanks are terminal via
 * `isTerminal` and supply the volumes; this module stays pure and DB-free so the
 * no-double-count rule is unit-tested directly.
 */

import { attributeToWells } from "@/lib/flow/graph";
import type { FlowConnection, FlowNodeType } from "@/lib/flow/types";

/** How a measured water volume was obtained (drives the double-count rule). */
export type WaterMeasurementKind = "throughput" | "haul" | "terminal_gauge";

/** One measured water volume at a node on a date. */
export interface WaterMeasurement {
  /** The node the volume was measured at (meter for throughput; tank for haul /
   * terminal_gauge; a well for an SWD disposal-meter throughput). */
  nodeType: FlowNodeType;
  nodeId: string;
  kind: WaterMeasurementKind;
  /** Measured barrels (already net of resets/negatives by the series layer). */
  bbls: number;
  /** ISO `YYYY-MM-DD` the volume is attributed on (picks the active edges). */
  date: string;
}

/** Per-well attributed water plus the portion that couldn't be traced to a well. */
export interface WaterProduction {
  /** Producing well id -> attributed barrels. */
  byWell: Map<string, number>;
  /** Total measured barrels (Σ of every measurement's bbls). */
  totalMeasured: number;
  /** Barrels that dead-ended at an unlinked node (no producing well upstream). */
  unattributed: number;
  /** True if any attribution hit a cycle in the graph (data error). */
  cycle: boolean;
}

/**
 * Attribute a set of measured water volumes to producing wells via the flow
 * graph. Every measurement is traced independently on its own date, so a tank
 * that both feeds a meter and hauls contributes its meter throughput and its
 * haul as distinct, non-overlapping barrels. Terminal-tank gauge volumes must
 * already be filtered by the caller (only pass `terminal_gauge` for tanks that
 * are actually terminal); this function trusts the kind it is given.
 */
export function attributeWaterProduction(
  measurements: WaterMeasurement[],
  connections: FlowConnection[],
  /**
   * Downtime hook: a producing well down on a given date produces no water, so
   * its share of any node measured that date flows to its online siblings. Bound
   * by the caller to `(wellId, date) => well is down on date`. Default: nobody
   * down (behavior unchanged).
   */
  isWellDown: (wellId: string, date: string) => boolean = () => false
): WaterProduction {
  const byWell = new Map<string, number>();
  let totalMeasured = 0;
  let unattributed = 0;
  let cycle = false;

  for (const m of measurements) {
    const bbls = Number.isFinite(m.bbls) ? m.bbls : 0;
    if (bbls === 0) continue;
    totalMeasured += bbls;

    const attribution = attributeToWells(
      { type: m.nodeType, id: m.nodeId },
      "water",
      m.date,
      connections,
      (wellId) => isWellDown(wellId, m.date)
    );
    if (attribution.cycle) cycle = true;
    unattributed += attribution.unattributed * bbls;
    for (const [wellId, frac] of attribution.shares) {
      byWell.set(wellId, (byWell.get(wellId) ?? 0) + frac * bbls);
    }
  }

  return { byWell, totalMeasured, unattributed, cycle };
}

/**
 * One DAY's water, attributed — including the zeros.
 *
 * {@link attributeWaterProduction} answers "who made these barrels", which is
 * silent about a well that made none. A rate is an average over days, so a day
 * missing from a well's series is not a zero, it is a day that never happened:
 * ten wells whose down days were dropped averaged 15.8 bbl/d each under a meter
 * averaging 15.6, and the page showed 158 against 156 for one stream of water.
 *
 * So every well that FEEDS something measured today appears today, at zero if
 * that is what it made. Candidates are resolved with downtime ignored, because a
 * shut-in well is exactly the one whose zero has to be recorded.
 *
 * The invariant this buys, and what `water-production.test.ts` pins: the values
 * sum to the day's measured barrels (less anything unattributable), so — the EMA
 * being linear — the wells feeding a meter sum to the meter's own rate.
 */
export function attributeWaterDay(
  measurements: WaterMeasurement[],
  connections: FlowConnection[],
  isWellDown: (wellId: string, date: string) => boolean = () => false
): Map<string, number> {
  const { byWell } = attributeWaterProduction(measurements, connections, isWellDown);
  const out = new Map<string, number>();
  for (const m of measurements) {
    const candidates = attributeToWells(
      { type: m.nodeType, id: m.nodeId },
      "water",
      m.date,
      connections
    ).shares;
    for (const wellId of candidates.keys()) {
      out.set(wellId, byWell.get(wellId) ?? 0);
    }
  }
  // A well the split reached that the candidate pass did not still counts.
  for (const [wellId, bbls] of byWell) {
    if (!out.has(wellId)) out.set(wellId, bbls);
  }
  return out;
}
