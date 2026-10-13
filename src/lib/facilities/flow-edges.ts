/**
 * Merge operator-drawn `flow_connections` edges into the derived facility graph.
 * Pure and DB-free so it unit-tests without a database.
 *
 * The facility graph's built-in edges come from the legacy FK/allocation tables;
 * these are the NEW generic connections a user draws on the map. An endpoint is
 * resolved to an existing graph node by trying the node kinds a flow type can map
 * to (a flow `well` is either a producing `well` or an `injection` well; a
 * `gatherer` has no node yet, so its edges are skipped). Edges whose endpoints
 * aren't both present, or that duplicate an existing edge, are dropped — matching
 * the builder's own `pushEdge` guards.
 */

import { nodeId, type FacilityEdge, type FacilityGraph, type FacilityKind, type Substance } from "@/lib/facilities/graph";
import type { FlowConnection, FlowNodeType } from "@/lib/flow/types";

/** The facility node kinds a flow endpoint type can resolve to, most-specific first. */
const KIND_CANDIDATES: Record<FlowNodeType, FacilityKind[]> = {
  well: ["well", "injection"],
  tank: ["tank"],
  meter: ["meter"],
  gatherer: ["gatherer"],
  battery: ["battery"],
};

/** Resolve a flow endpoint to an existing facility node id, or null. */
function resolveNodeId(
  present: Set<string>,
  type: FlowNodeType,
  refId: string
): string | null {
  for (const kind of KIND_CANDIDATES[type]) {
    const id = nodeId(kind, refId);
    if (present.has(id)) return id;
  }
  return null;
}

/** One end of a connection, as the splice below rewrites it. */
type End = { type: FlowNodeType; id: string };

/**
 * Rewrite connections so they do not pass through anything that is not a card.
 *
 * Batteries and water meters are wiring on this map, not facilities
 * (`graph.ts`): a battery is its member water tanks, and a water meter sits
 * between what feeds it and the SWD well it measures. A connection drawn
 * through either would otherwise be dropped as dangling and the chain it
 * carried (well → tank → meter → SWD well) would fall apart on screen.
 *
 *   - a battery endpoint becomes one endpoint per member water tank;
 *   - a meter endpoint with no node is spliced out: every connection INTO it
 *     is joined to every connection OUT of it, taking the outgoing side's
 *     substance and share.
 *
 * Gas meters are cards, so they resolve as before. Pure, and bounded: each
 * pass removes at least one absent meter, and a meter nothing leads out of
 * simply drops with what fed it.
 */
function spliceThroughWiring(
  connections: FlowConnection[],
  present: Set<string>,
  batteryByTank: Record<string, string | null | undefined>
): FlowConnection[] {
  const tanksByBattery = new Map<string, string[]>();
  for (const [tankId, batteryId] of Object.entries(batteryByTank)) {
    if (!batteryId) continue;
    (tanksByBattery.get(batteryId) ?? tanksByBattery.set(batteryId, []).get(batteryId)!).push(tankId);
  }
  const expand = (end: End): End[] =>
    end.type === "battery"
      ? (tanksByBattery.get(end.id) ?? []).map((id) => ({ type: "tank", id }))
      : [end];

  let list: FlowConnection[] = [];
  for (const c of connections) {
    for (const from of expand({ type: c.fromType, id: c.fromId })) {
      for (const to of expand({ type: c.toType, id: c.toId })) {
        list.push({ ...c, fromType: from.type, fromId: from.id, toType: to.type, toId: to.id });
      }
    }
  }

  const absentMeter = (type: FlowNodeType, id: string) =>
    type === "meter" && !present.has(nodeId("meter", id));
  for (;;) {
    const gone = list.find((c) => absentMeter(c.toType, c.toId) || absentMeter(c.fromType, c.fromId));
    if (!gone) return list;
    const meterId = absentMeter(gone.toType, gone.toId) ? gone.toId : gone.fromId;
    const into = list.filter((c) => c.toType === "meter" && c.toId === meterId);
    const outOf = list.filter((c) => c.fromType === "meter" && c.fromId === meterId);
    const rest = list.filter((c) => !into.includes(c) && !outOf.includes(c));
    for (const a of into) {
      for (const b of outOf) {
        rest.push({ ...b, fromType: a.fromType, fromId: a.fromId, id: `${a.id}+${b.id}` });
      }
    }
    list = rest;
  }
}

/**
 * Return the custom edges to append to `graph.edges` for the given connections.
 * `connections` should already be filtered to those active on the target date
 * (the loader does this); this function only maps + dedupes.
 */
export function flowConnectionEdges(
  graph: FacilityGraph,
  connections: FlowConnection[],
  /** `tanks.battery_id`, so a connection on a battery lands on its tanks. */
  batteryByTank: Record<string, string | null | undefined> = {}
): FacilityEdge[] {
  const present = new Set(graph.nodes.map((n) => n.id));
  const seen = new Set(graph.edges.map((e) => e.id));
  const out: FacilityEdge[] = [];

  for (const c of spliceThroughWiring(connections, present, batteryByTank)) {
    const from = resolveNodeId(present, c.fromType, c.fromId);
    const to = resolveNodeId(present, c.toType, c.toId);
    if (!from || !to || from === to) continue;
    const id = `${from}->${to}:${c.substance}`;
    if (seen.has(id)) continue; // don't double an FK-derived edge
    seen.add(id);
    out.push({
      id,
      from,
      to,
      substance: c.substance as Substance,
      flow: null,
      custom: true,
      connectionId: c.id,
    });
  }
  return out;
}

/** A new graph with the custom connection edges merged in. */
export function withFlowConnections(
  graph: FacilityGraph,
  connections: FlowConnection[],
  batteryByTank: Record<string, string | null | undefined> = {}
): FacilityGraph {
  return {
    ...graph,
    edges: [...graph.edges, ...flowConnectionEdges(graph, connections, batteryByTank)],
  };
}
