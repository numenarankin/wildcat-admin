/**
 * Battery edge inheritance — "a battery's connection IS its member tanks'".
 *
 * A water connection can be drawn from a TANK or from a BATTERY, and both are
 * legal (docs/swd-batteries-plan.md §2b). Drawing `battery -> SWD well` means
 * every water tank on that battery feeds that well: nobody should have to draw
 * the same edge four times, and a tank added to the battery next month must
 * inherit it without anyone revisiting the graph.
 *
 * Two rules follow, and the second is the one that bites:
 *
 *   REACHABILITY — "does this tank feed anything?", which is what terminality
 *   asks — a member tank counts as connected when EITHER its own edge or its
 *   battery's edge is active. Per substance and per period: a battery edge dated
 *   2026-03 onward does not make a tank connected in 2025.
 *
 *   VOLUME — the battery edge stays ONE edge. Expanding it into one edge per
 *   member tank would attribute the station's water to the SWD well once per
 *   tank. The battery is the upstream node; its members are not separately
 *   upstream of anything the battery already feeds.
 *
 * PRECEDENCE: a tank's own edge wins over its battery's FOR THAT TANK, so a
 * station where one tank is trucked off instead of injected is expressed by
 * giving that tank its own edge — no need to dissolve the battery.
 *
 * Membership is current (`tanks.battery_id`), matching how terminality is
 * already evaluated as-of today: a tank moved between batteries inherits its new
 * battery's edges from that moment, and history is not rewritten.
 *
 * Pure — no I/O — so every rule above is checked against a hand-built graph.
 */

import type { FlowConnection, FlowSubstance } from "@/lib/flow/types";

/** Is this edge in force on `date` (ISO `YYYY-MM-DD`)? */
export function edgeActiveOn(edge: FlowConnection, date: string): boolean {
  return (
    edge.effectiveFrom <= date &&
    (edge.effectiveTo == null || edge.effectiveTo >= date)
  );
}

/** Which battery each tank belongs to (`tanks.battery_id`), tank id → battery id. */
export type BatteryByTank = Record<string, string | null | undefined>;

/**
 * The OUTBOUND edges that apply to one tank on a substance: its own if it has
 * any, otherwise its battery's (inherited). Specific beats inherited, so a tank
 * with its own edge never also carries its battery's.
 *
 * The returned edges are the BATTERY's rows when inherited — deliberately not
 * rewritten to look like the tank's. A caller asking "is this tank connected"
 * gets its answer; a caller attributing volume must not treat these as the
 * tank's own edges (see the VOLUME rule above).
 */
export function outboundEdgesForTank(
  edges: FlowConnection[],
  tankId: string,
  batteryByTank: BatteryByTank,
  substance: FlowSubstance,
  date: string
): FlowConnection[] {
  const own = edges.filter(
    (e) =>
      e.substance === substance &&
      e.fromType === "tank" &&
      e.fromId === tankId &&
      edgeActiveOn(e, date)
  );
  if (own.length > 0) return own;

  const batteryId = batteryByTank[tankId];
  if (!batteryId) return [];
  return edges.filter(
    (e) =>
      e.substance === substance &&
      e.fromType === "battery" &&
      e.fromId === batteryId &&
      edgeActiveOn(e, date)
  );
}

/** Does this tank feed anything on `substance` as of `date`, its battery included? */
export function tankIsConnected(
  edges: FlowConnection[],
  tankId: string,
  batteryByTank: BatteryByTank,
  substance: FlowSubstance,
  date: string
): boolean {
  return (
    outboundEdgesForTank(edges, tankId, batteryByTank, substance, date).length >
    0
  );
}

/**
 * Does this BATTERY feed anything on `substance` as of `date`?
 *
 * True for an edge drawn on the battery itself OR on any of its member tanks:
 * inheritance runs both ways for reachability, since a station one of whose
 * tanks feeds a meter is not a terminal measured point — the meter downstream is
 * already measuring some of the same water.
 */
export function batteryIsConnected(
  edges: FlowConnection[],
  batteryId: string,
  memberTankIds: string[],
  substance: FlowSubstance,
  date: string
): boolean {
  const members = new Set(memberTankIds);
  return edges.some(
    (e) =>
      e.substance === substance &&
      edgeActiveOn(e, date) &&
      ((e.fromType === "battery" && e.fromId === batteryId) ||
        (e.fromType === "tank" && members.has(e.fromId)))
  );
}

/**
 * The set of tank ids whose water is measured DOWNSTREAM of them — i.e. the
 * non-terminal tanks, counting inherited battery edges. The complement of this
 * set, among an org's water tanks, is what contributes a full gauge+haul series.
 */
export function nonTerminalTankIds(
  edges: FlowConnection[],
  tankIds: string[],
  batteryByTank: BatteryByTank,
  substance: FlowSubstance,
  date: string
): Set<string> {
  const out = new Set<string>();
  for (const id of tankIds) {
    if (tankIsConnected(edges, id, batteryByTank, substance, date)) out.add(id);
  }
  return out;
}
