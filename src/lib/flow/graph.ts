/**
 * Pure flow-graph math over `FlowConnection[]` — DB-free so it unit-tests without
 * a database and can re-derive live in the browser.
 *
 * The one operation everything needs is UPSTREAM ATTRIBUTION: given a measured
 * volume at some node (a meter's throughput, a tank's haul, a terminal tank's
 * gauge), attribute it back to the producing wells that fed it. Because edge
 * shares are TO-NORMALIZED (see `flow/types.ts`), this is a reverse walk that
 * multiplies fractions along every path:
 *
 *   fraction(measuredNode <- well w) =
 *     Σ over inbound edges e:  (e.share / Σ inbound shares) × fraction(e.from <- w)
 *
 * with wells as the base case (a producing well contributes 100% of itself).
 * Shares are normalized against their own inbound sum at each node, so a
 * partially-specified split still attributes the whole volume (nothing invented
 * or lost) — the same robustness `straightShares` gives the single-hop case.
 *
 * This replaced the fixed two-layer disposal allocation (SWD well ->
 * tanks -> producing wells) to arbitrary-length chains, and it is acyclic by
 * assumption: a cycle is a data error, guarded here so it terminates and is
 * reported rather than looping forever.
 */

import { activeAllocations } from "@/lib/tanks/allocation";
import type {
  FlowConnection,
  FlowNodeRef,
  FlowNodeType,
  FlowSubstance,
} from "@/lib/flow/types";

/** A stable string key for a node (type + id). */
function nodeKey(type: FlowNodeType, id: string): string {
  return `${type}:${id}`;
}

/** Far-past sentinel a backfilled earliest edge starts from (covers all history). */
const BACKFILL_FROM = "1900-01-01";

/**
 * Make each node's allocation RETROACTIVE for attribution: extend the
 * chronologically FIRST inbound edge (per substance, per `to` node) back to a
 * far-past date, so a measured volume dated before the first split is still
 * attributed by that first split. The flow analogue of the gas engine's
 * `flattenTimelineForEngine` (which backfills the earliest period to MIN_DATE);
 * apply it ONLY on the attribution read, never to stored/displayed edges, so the
 * UI keeps each period's real dates. Pure.
 */
export function backfillEarliestInbound(
  connections: FlowConnection[],
  substance: FlowSubstance
): FlowConnection[] {
  const minByNode = new Map<string, string>();
  for (const c of connections) {
    if (c.substance !== substance) continue;
    const key = nodeKey(c.toType, c.toId);
    const cur = minByNode.get(key);
    if (cur == null || c.effectiveFrom < cur) minByNode.set(key, c.effectiveFrom);
  }
  return connections.map((c) => {
    if (c.substance !== substance) return c;
    return c.effectiveFrom === minByNode.get(nodeKey(c.toType, c.toId))
      ? { ...c, effectiveFrom: BACKFILL_FROM }
      : c;
  });
}

/** Edges active on `onDate` for one substance. Reuses the allocation date rule
 * (inclusive bounds; open `effectiveTo`). */
export function activeConnections(
  connections: FlowConnection[],
  substance: FlowSubstance,
  onDate: string
): FlowConnection[] {
  const forSubstance = connections.filter((c) => c.substance === substance);
  // activeAllocations keys off effectiveFrom/effectiveTo, which FlowConnection has.
  return activeAllocations(
    forSubstance.map((c) => ({
      ...c,
      wellId: "",
      straightPct: c.sharePct,
    })),
    onDate
  ).map((c) => c as unknown as FlowConnection);
}

/** The result of attributing a measured node's volume back to producing wells. */
export interface Attribution {
  /** Producing well id -> fraction of the measured node (0-1). Sums to ≤ 1. */
  shares: Map<string, number>;
  /** Fraction that dead-ended at a non-well source (unlinked node). */
  unattributed: number;
  /** True if a cycle was detected and a branch was cut to terminate. */
  cycle: boolean;
}

/**
 * Attribute a measured node's throughput back to the producing wells upstream of
 * it, following `substance` edges active on `onDate`. A `well` node is a source
 * (base case) — water/oil/gas originates at producing wells, and injection wells
 * never appear as an upstream `from`, so any well reached upstream is a producer.
 * A non-well node with no inbound edges is an unlinked dead-end: its fraction is
 * reported as `unattributed` rather than dropped silently.
 */
export function attributeToWells(
  target: FlowNodeRef,
  substance: FlowSubstance,
  onDate: string,
  connections: FlowConnection[],
  /**
   * Downtime hook: a producing well DOWN on `onDate` produces nothing, so its
   * inbound edge is dropped and its siblings feeding the same node renormalize up
   * (the water analogue of `downtimeAdjustedShares`). Default: nobody down.
   */
  isWellDown: (wellId: string) => boolean = () => false
): Attribution {
  const active = activeConnections(connections, substance, onDate);

  // Reverse adjacency: for each node, the edges flowing INTO it.
  const inboundByNode = new Map<string, FlowConnection[]>();
  for (const e of active) {
    const key = nodeKey(e.toType, e.toId);
    (inboundByNode.get(key) ?? inboundByNode.set(key, []).get(key)!).push(e);
  }

  const shares = new Map<string, number>();
  let unattributed = 0;
  let cycle = false;

  // DFS over the reverse graph, accumulating well fractions. `visiting` is the
  // current path (for cycle detection); `weight` is the fraction of the original
  // measured node flowing through the current node. A node with NO inbound edges
  // is a source — a producing well is a graph source (nothing flows into it),
  // while an injection/SWD well is interior (tanks flow into it), so being a
  // source is defined by topology, not by the `well` type. This lets the target
  // itself be an SWD well: it has inbound edges, so it is traced upstream rather
  // than attributed to itself.
  const walk = (
    type: FlowNodeType,
    id: string,
    weight: number,
    visiting: Set<string>
  ): void => {
    if (weight <= 0) return;

    const key = nodeKey(type, id);
    const inbound = inboundByNode.get(key) ?? [];
    const positive = inbound.filter((e) => e.sharePct > 0);
    const sumAll = positive.reduce((s, e) => s + e.sharePct, 0);

    if (sumAll <= 0) {
      // Source node. A well source is a producing well; anything else is an
      // unlinked dead-end whose volume can't be traced to a well.
      if (type === "well") shares.set(id, (shares.get(id) ?? 0) + weight);
      else unattributed += weight;
      return;
    }

    if (visiting.has(key)) {
      // A cycle — cut this branch so we terminate. The looped fraction is lost.
      cycle = true;
      unattributed += weight;
      return;
    }

    // Downtime: drop edges coming FROM a well that is down today; the surviving
    // (online) edges renormalize against their own sum, so a down well's share
    // flows to its siblings. If EVERY feeder of this node is a down well
    // (sumOnline == 0), fall back to the full inbound set — never strand a
    // measured volume (the owner's "pretend there was no downtime" rule).
    const online = positive.filter(
      (e) => !(e.fromType === "well" && isWellDown(e.fromId))
    );
    const sumOnline = online.reduce((s, e) => s + e.sharePct, 0);
    const useEdges = sumOnline > 0 ? online : positive;
    const useSum = sumOnline > 0 ? sumOnline : sumAll;

    visiting.add(key);
    for (const e of useEdges) {
      walk(e.fromType, e.fromId, weight * (e.sharePct / useSum), visiting);
    }
    visiting.delete(key);
  };

  walk(target.type, target.id, 1, new Set());
  return { shares, unattributed, cycle };
}

/**
 * Is a node terminal — does its substance connect to nothing downstream? A tank
 * with no outbound water edge is terminal, so (per the water-production model)
 * its gauge readings are the definitive production signal rather than a
 * double-count against a downstream meter. Uses edges active on `onDate`.
 */
export function isTerminal(
  node: FlowNodeRef,
  substance: FlowSubstance,
  onDate: string,
  connections: FlowConnection[]
): boolean {
  const active = activeConnections(connections, substance, onDate);
  return !active.some(
    (e) => e.fromType === node.type && e.fromId === node.id
  );
}

/**
 * Validate that the edges feeding a node (per substance, on a date) sum to ~100.
 * A short-of-100 set still attributes correctly (shares normalize), but the UI
 * wants to flag it. `sum` is the raw percent total; `ok` is within tolerance or
 * an all-zero (unallocated) node.
 */
export function validateInboundShares(
  target: FlowNodeRef,
  substance: FlowSubstance,
  onDate: string,
  connections: FlowConnection[],
  tolerance = 0.01
): { ok: boolean; sum: number } {
  const active = activeConnections(connections, substance, onDate);
  const sum = active
    .filter((e) => e.toType === target.type && e.toId === target.id)
    .reduce((s, e) => s + (e.sharePct > 0 ? e.sharePct : 0), 0);
  if (sum === 0) return { ok: true, sum };
  return { ok: Math.abs(sum - 100) <= tolerance, sum };
}
