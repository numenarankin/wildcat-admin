/**
 * Closing the gap a deleted facility leaves in a flowline.
 *
 * A chain says something about where the stream goes: `A -> B -> C` means A's
 * water reaches C. Delete B and both of its edges go with it, and what is left
 * claims A reaches nothing — the operator took one tank off the map and lost the
 * fact that the well behind it still feeds the hole in front of it. Nobody said
 * the stream stopped; they said the tank is gone.
 *
 * So a deleted facility hands its line on: every feeder is rejoined to every
 * outlet, per substance, and the edges through the deleted node are dropped.
 *
 * Shares COMPOSE, they do not carry over. A share is the fraction of the TO node
 * that came FROM — so if two wells each put half of B's water in and B sends all
 * of it to C, each well is half of C, not all of it.
 *
 * ## What this does not reach
 *
 * Only `flow_connections`. The map's other edges are derived from the allocation
 * tables (`tank_well_allocations` and friends), and those rows belong to the
 * facility being deleted — a tank's allocations describe that tank and are
 * meaningless once it is gone. A chain whose upstream half is an allocation
 * therefore heals only as far as the drawn part of it.
 */

import type { FlowConnection, FlowNodeRef, FlowSubstance } from "@/lib/flow/types";

export interface BridgePlan {
  /** Edges to draw in place of the ones through the deleted facility. */
  add: {
    from: FlowNodeRef;
    to: FlowNodeRef;
    substance: FlowSubstance;
    sharePct: number;
  }[];
  /** Every connection that touched it. */
  removeIds: string[];
}

const same = (a: FlowNodeRef, b: { type: string; id: string }) =>
  a.type === b.type && a.id === b.id;

export function planConnectionBridge(
  node: FlowNodeRef,
  /** The connections on file (the caller filters to those active today). */
  connections: FlowConnection[]
): BridgePlan {
  const touching = connections.filter(
    (c) =>
      same(node, { type: c.fromType, id: c.fromId }) ||
      same(node, { type: c.toType, id: c.toId })
  );
  const inbound = touching.filter((c) => same(node, { type: c.toType, id: c.toId }));
  const outbound = touching.filter((c) =>
    same(node, { type: c.fromType, id: c.fromId })
  );

  const drawn = new Set(
    connections.map(
      (c) => `${c.fromType}:${c.fromId}->${c.toType}:${c.toId}:${c.substance}`
    )
  );
  const add: BridgePlan["add"] = [];
  for (const into of inbound) {
    for (const out of outbound) {
      // Oil into a tank and water out of it are not one stream; only a line that
      // runs THROUGH this facility is a line to rejoin.
      if (into.substance !== out.substance) continue;
      const from: FlowNodeRef = { type: into.fromType, id: into.fromId };
      const to: FlowNodeRef = { type: out.toType, id: out.toId };
      // A loop back onto the feeder is not a chain, it is the deletion of one.
      if (same(from, { type: to.type, id: to.id })) continue;
      const key = `${from.type}:${from.id}->${to.type}:${to.id}:${into.substance}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      add.push({
        from,
        to,
        substance: into.substance,
        sharePct: Math.round(((into.sharePct * out.sharePct) / 100) * 100) / 100,
      });
    }
  }

  return {
    add,
    removeIds: touching.map((c) => c.id).filter((id): id is string => Boolean(id)),
  };
}
