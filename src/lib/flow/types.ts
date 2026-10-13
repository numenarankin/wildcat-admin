/**
 * Flow-connection (edge) domain types — pure, no I/O.
 *
 * A `FlowConnection` is one effective-dated edge in the physical flow graph:
 * substance moves FROM one node TO another. It is the generic replacement for
 * the per-pair allocation tables (tank_well_allocations, meter_well_allocations,
 * battery_well_allocations) and the tanks.injection_well_id FK, and it is what
 * lets the UI build arbitrary chains (well -> tank -> meter -> tank -> disposal
 * well) and split flows (a tank whose water is partly hauled, partly injected).
 *
 * `sharePct` is TO-NORMALIZED: the fraction of the DOWNSTREAM (`to`) node's
 * throughput on that substance attributable to the UPSTREAM (`from`) node.
 * Siblings feeding the same (to, substance, period) sum to 100 — matching the
 * three legacy allocation tables. This makes attributing a measured volume back
 * to producing wells a plain upstream multiply (see `flow/graph.ts`).
 *
 * Kept dependency-free so the graph math unit-tests without a database.
 */

/** A node in the flow graph. `well` covers producing and injection (SWD) wells
 * (distinguished by the well's `type`); `gatherer` is a haul-off destination;
 * `battery` is a tank battery, which stands in for its member tanks (see
 * `@/lib/flow/battery-edges` — a battery's connection IS its tanks'). */
export type FlowNodeType = "well" | "tank" | "meter" | "gatherer" | "battery";

export type FlowSubstance = "oil" | "gas" | "water";

/** A node reference: a type plus the row id of that entity. */
export interface FlowNodeRef {
  type: FlowNodeType;
  /** wells.id is a text slug; tanks/meters/gatherers are uuid strings. */
  id: string;
}

/** One directional, effective-dated edge: `share` of `to`'s throughput came from `from`. */
export interface FlowConnection {
  id?: string;
  fromType: FlowNodeType;
  fromId: string;
  toType: FlowNodeType;
  toId: string;
  substance: FlowSubstance;
  /** Fraction of the TO node attributable to FROM, 0-100 (to-normalized). */
  sharePct: number;
  /** ISO `YYYY-MM-DD` the edge takes effect. */
  effectiveFrom: string;
  /** ISO `YYYY-MM-DD` the edge ends, or null when still active. */
  effectiveTo: string | null;
}
