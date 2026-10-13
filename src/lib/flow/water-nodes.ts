/**
 * Which nodes a produced-water total is measured at, and how each is measured.
 *
 * The measured-points model (docs/swd-connections-architecture.md) says a water
 * node contributes its full gauge+haul series when TERMINAL (nothing downstream
 * measures its throughput) and its hauls alone when not (the meter downstream
 * measures the rest, and counting both would double it).
 *
 * Batteries add one rule to that (docs/swd-batteries-plan.md): a water tank in a
 * battery is never a node — its BATTERY is, contributing the sum of its members.
 * A battery is how the site is actually worked, and counting the tanks as well
 * as the battery would report the same barrels twice.
 *
 * MODE B counts as measured-downstream. A tank (or battery) wired to an SWD well
 * is FLOW-THROUGH: "unlike an oil tank, an SWD well's tank is flow-through, so
 * tank level is not a production proxy" — the well's own meter is the volume
 * source (`@/lib/disposal/disposal-series`). Reading its gauge as well would
 * count the same barrels at the tank and at the disposal well, so it contributes
 * only its hauls, exactly as a tank feeding a meter does. The link is not an
 * edge in `flow_connections` (it predates that table), which is why it has to be
 * passed in rather than resolved from the graph.
 *
 * This is the single place that decision is made. The roll-ups
 * (`leaseWaterSeries` / `orgWaterSeries`) and the per-well attribution both plan
 * from here, so they cannot disagree about what was measured where — which is
 * the failure this whole change is most likely to produce.
 *
 * Pure, so the invariant that matters can be checked without a database:
 * GROUPING TANKS INTO A BATTERY MUST NOT CHANGE WHAT IS COUNTED.
 */

import { batteryIsConnected, tankIsConnected } from "@/lib/flow/battery-edges";
import type { FlowConnection, FlowNodeRef } from "@/lib/flow/types";

/** How a node's water volume is read off its tanks. */
export type WaterNodeKind = "terminal_gauge" | "haul";

/** One measured water node and the tanks whose series make it up. */
export interface WaterNodePlan {
  node: FlowNodeRef;
  /** The tanks summed into this node — one for a standalone tank, the members
   *  of a battery otherwise. Always non-empty. */
  tankIds: string[];
  /** `terminal_gauge`: each tank's gauge+haul series. `haul`: hauls only. */
  kind: WaterNodeKind;
}

/** A water tank as the planner needs it. */
export interface PlannableTank {
  id: string;
  batteryId?: string | null;
  /** Mode B: the SWD well this tank feeds (`tanks.injection_well_id`). */
  injectionWellId?: string | null;
}

/**
 * Plan the measured water nodes over a set of water tanks.
 *
 * Tanks are grouped by battery; the batteries are ordered by first appearance so
 * the output is deterministic. `date` picks which edges are in force — a battery
 * edge dated next month does not make today's tank non-terminal.
 */
export function planWaterNodes(
  tanks: PlannableTank[],
  edges: FlowConnection[],
  date: string,
  /** Battery ids wired to an SWD well (`tank_batteries.injection_well_id`). */
  injectedBatteryIds: ReadonlySet<string> = new Set()
): WaterNodePlan[] {
  const batteryByTank: Record<string, string | null | undefined> = {};
  const injectionById = new Map<string, string | null>();
  for (const t of tanks) {
    batteryByTank[t.id] = t.batteryId ?? null;
    injectionById.set(t.id, t.injectionWellId ?? null);
  }

  const plans: WaterNodePlan[] = [];
  const membersByBattery = new Map<string, string[]>();
  for (const t of tanks) {
    if (t.batteryId) {
      const list = membersByBattery.get(t.batteryId);
      if (list) list.push(t.id);
      else membersByBattery.set(t.batteryId, [t.id]);
      continue;
    }
    plans.push({
      node: { type: "tank", id: t.id },
      tankIds: [t.id],
      kind:
        t.injectionWellId ||
        tankIsConnected(edges, t.id, batteryByTank, "water", date)
          ? "haul"
          : "terminal_gauge",
    });
  }

  for (const [batteryId, tankIds] of membersByBattery) {
    plans.push({
      node: { type: "battery", id: batteryId },
      tankIds,
      kind:
        injectedBatteryIds.has(batteryId) ||
        tankIds.some((id) => injectionById.get(id)) ||
        batteryIsConnected(edges, batteryId, tankIds, "water", date)
          ? "haul"
          : "terminal_gauge",
    });
  }
  return plans;
}
