/**
 * What a WATER meter's pickers mean, as edges.
 *
 * A meter is not a destination — it is a thing the water passes through on its
 * way down a hole. So the two lists on the new-water-meter form are not two
 * separate outlets: a meter created with an outflow tank AND a disposal well
 * means "through the tank, then down the hole", and drawing it as a fork out of
 * the meter says the water went to both, which is twice as much water as there
 * is. The chain is the assumption; the operator can still split it afterwards on
 * the map.
 *
 * The other half is not duplicating a path the operator already drew. A
 * producing well wired straight to its disposal well is the common state before
 * anyone meters it; metering it does not add a second route to the same hole, it
 * puts the meter IN the one that is there. So that connection is taken over — the
 * well reaches the hole through the meter — rather than left beside the new one
 * for the map to draw the stream twice.
 *
 * Pure: the caller supplies the connections already on file and applies the plan
 * (`setFacilityLinks` and friends do the writing), so the same rule runs against
 * a real org and against the sandbox the lab is built on.
 */

import type { FlowConnection, FlowNodeRef } from "@/lib/flow/types";

export interface WaterMeterPicks {
  /** The meter these were picked on. */
  meterId: string;
  /** Producing wells the meter measures (an allocation, not an edge — they are
   *  here only to find the paths this meter is standing in). */
  wellIds: string[];
  /** Saltwater tanks whose water runs THROUGH the meter. */
  feedTankIds: string[];
  /** Saltwater tanks the meter fills. */
  outTankIds: string[];
  /** Disposal wells the water ends up in. */
  injectionWellIds: string[];
}

/** One edge to draw: substance and share are the caller's to stamp. */
export interface PlannedEdge {
  from: FlowNodeRef;
  to: FlowNodeRef;
}

export interface WiringPlan {
  add: PlannedEdge[];
  /** `flow_connections` ids the meter takes over. */
  removeIds: string[];
}

const key = (from: FlowNodeRef, to: FlowNodeRef) =>
  `${from.type}:${from.id}->${to.type}:${to.id}`;

export function planWaterMeterWiring(
  picks: WaterMeterPicks,
  /** Water connections already on file (the caller filters to active). */
  existing: FlowConnection[]
): WiringPlan {
  const meter: FlowNodeRef = { type: "meter", id: picks.meterId };
  const tank = (id: string): FlowNodeRef => ({ type: "tank", id });
  // A disposal well is a `wells` row like any other; only the map draws it apart.
  const hole = (id: string): FlowNodeRef => ({ type: "well", id });

  const wanted: PlannedEdge[] = [];
  for (const id of picks.feedTankIds) wanted.push({ from: tank(id), to: meter });
  for (const id of picks.outTankIds) wanted.push({ from: meter, to: tank(id) });

  if (picks.outTankIds.length > 0 && picks.injectionWellIds.length > 0) {
    // Through the tank, then down the hole — never out of the meter to both.
    for (const tankId of picks.outTankIds) {
      for (const wellId of picks.injectionWellIds) {
        wanted.push({ from: tank(tankId), to: hole(wellId) });
      }
    }
  } else {
    for (const id of picks.injectionWellIds) wanted.push({ from: meter, to: hole(id) });
  }

  /*
   * The paths this meter now stands in: a well it measures, wired straight to a
   * hole it feeds. Only an operator-drawn row can be taken over — the rest of the
   * map's edges are derived from the allocation tables and are not rows to
   * delete.
   *
   * Taking one over is a SPLICE, not a cut: the well keeps its line to the hole,
   * with the meter in the middle of it. Deleting it and leaning on the well's
   * meter allocation to carry the attribution would work only once somebody has
   * run a water test — until then the hole would attribute to nobody
   * (`loadEffectiveFlowConnections` computes a well -> node water edge from the
   * tests, and skips a node with none).
   */
  const wells = new Set(picks.wellIds);
  const holes = new Set(picks.injectionWellIds);
  const takenOver = existing.filter(
    (c) =>
      c.fromType === "well" &&
      c.toType === "well" &&
      wells.has(c.fromId) &&
      holes.has(c.toId)
  );
  for (const c of takenOver) {
    wanted.push({ from: { type: "well", id: c.fromId }, to: meter });
  }

  const drawn = new Set(
    existing.map((c) =>
      key({ type: c.fromType, id: c.fromId }, { type: c.toType, id: c.toId })
    )
  );
  const add: PlannedEdge[] = [];
  const added = new Set<string>();
  for (const e of wanted) {
    const k = key(e.from, e.to);
    if (drawn.has(k) || added.has(k)) continue;
    added.add(k);
    add.push(e);
  }

  const removeIds = takenOver
    .map((c) => c.id)
    .filter((id): id is string => Boolean(id));

  return { add, removeIds };
}
