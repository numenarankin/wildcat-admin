/**
 * Which water meters measured what an SWD well took — following the chain, not
 * just the last hop.
 *
 * `well-series.ts` states the rule: a disposal well is a SINK, so its volume is
 * whatever the flow meter on the line into it measured. That line is not always
 * one edge long. A saltwater station is normally plumbed
 *
 *     (producing wells) -> METER -> tank battery -> SWD well
 *
 * with the meter on the INLET, because that is where the water is bought and
 * sold; the tanks are surge before the transfer pump. Reading only
 * `meter -> well` edges says such a well is unmetered while its own meter sits
 * two hops upstream, and the operator gets a hand-entry form for barrels the
 * meter already counted. This module walks those hops.
 *
 * ## What counts as a hop
 *
 * Only `tank` and `battery` are walked through: they hold water and pass it on,
 * so a meter upstream of them still measures what reached the hole. A `well`
 * upstream is a SOURCE (the producers feeding the station) and a `gatherer` is a
 * haul-off destination — neither measures anything, so the walk stops there
 * rather than treating a producing well as a meter.
 *
 * ## Windows are intersected along the path
 *
 * An edge only carries water while it is effective, so a meter measured this
 * well only on the dates EVERY edge between the two was live: the intersection.
 * A meter that reaches the well by two paths keeps both windows, and
 * `windowActiveOn` treats them as a union — which is why the series counts such
 * a meter once, not once per path.
 *
 * Pure and DB-free, so the reachability rule is unit-tested without a database.
 */

import type { FlowConnection, FlowNodeType } from "@/lib/flow/types";
import type { FlowWindow } from "@/lib/disposal/well-series";

/**
 * How many edges deep to look. `meter -> tank -> battery -> well` is three, so
 * four leaves a hop of headroom for a station wired more elaborately than the
 * seed. A cap at all is because these edges are operator-drawn: a cycle is a
 * data error, not an impossibility, and the visited-set guards the path while
 * this guards the depth.
 */
const MAX_HOPS = 4;

/** Node kinds water passes THROUGH on its way to a disposal well. */
const PASS_THROUGH: FlowNodeType[] = ["tank", "battery"];

/** One meter that measures this well, and how it is wired in. */
export interface MeterReach {
  meterId: string;
  /**
   * When this meter actually measured the well — one window per path, each the
   * intersection of the edges along it.
   */
  windows: FlowWindow[];
  /**
   * The meter's OWN edges into the chain (its first hop). What "detach this
   * meter" closes: the meter leaves the line, and the rest of the plumbing —
   * which is the battery's relationship to the well, not the meter's — stands.
   */
  firstHop: FlowConnection[];
  /** False when the meter is wired straight to the well (`meter -> well`). */
  chained: boolean;
}

/** `${type}:${id}`, the key both endpoints of an edge are indexed by. */
function key(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * The overlap of a path window and one more edge, or null when they never
 * overlap. Bounds are inclusive and a null `effectiveTo` is +infinity, matching
 * `windowActiveOn`.
 */
function overlap(window: FlowWindow, edge: FlowConnection): FlowWindow | null {
  const from =
    window.effectiveFrom > edge.effectiveFrom
      ? window.effectiveFrom
      : edge.effectiveFrom;
  const to =
    window.effectiveTo == null
      ? edge.effectiveTo
      : edge.effectiveTo == null
        ? window.effectiveTo
        : window.effectiveTo < edge.effectiveTo
          ? window.effectiveTo
          : edge.effectiveTo;
  if (to != null && from > to) return null;
  return { effectiveFrom: from, effectiveTo: to };
}

/** Add a window unless an identical one is already recorded for that meter. */
function record(
  out: Map<string, MeterReach>,
  edge: FlowConnection,
  window: FlowWindow,
  chained: boolean
): void {
  const found = out.get(edge.fromId);
  const reach: MeterReach = found ?? {
    meterId: edge.fromId,
    windows: [],
    firstHop: [],
    chained,
  };
  if (
    !reach.windows.some(
      (w) =>
        w.effectiveFrom === window.effectiveFrom &&
        w.effectiveTo === window.effectiveTo
    )
  ) {
    reach.windows.push(window);
  }
  if (!reach.firstHop.some((e) => e === edge)) reach.firstHop.push(edge);
  // A meter wired BOTH ways is direct: the direct edge is the shorter, more
  // specific statement, and it is the one `attachMeterToWell` writes.
  reach.chained = reach.chained && chained;
  out.set(edge.fromId, reach);
}

/**
 * Every water meter that measures `wellId`, keyed by meter id.
 *
 * `connections` is the org's flow graph; anything that is not a water edge is
 * ignored here rather than by the caller, so no reader can forget to filter.
 */
export function metersReachingWell(
  wellId: string,
  connections: FlowConnection[]
): Map<string, MeterReach> {
  const inbound = new Map<string, FlowConnection[]>();
  for (const c of connections) {
    if (c.substance !== "water") continue;
    const k = key(c.toType, c.toId);
    const list = inbound.get(k);
    if (list) list.push(c);
    else inbound.set(k, [c]);
  }

  const out = new Map<string, MeterReach>();
  const start = key("well", wellId);

  const walk = (
    node: string,
    window: FlowWindow,
    seen: Set<string>,
    hops: number,
    direct: boolean
  ): void => {
    if (hops > MAX_HOPS) return;
    for (const edge of inbound.get(node) ?? []) {
      const next = overlap(window, edge);
      if (!next) continue;
      if (edge.fromType === "meter") {
        record(out, edge, next, !direct);
        continue;
      }
      if (!PASS_THROUGH.includes(edge.fromType)) continue;
      const upstream = key(edge.fromType, edge.fromId);
      if (seen.has(upstream)) continue; // operator-drawn cycle
      walk(upstream, next, new Set([...seen, upstream]), hops + 1, false);
    }
  };

  walk(
    start,
    { effectiveFrom: "0000-01-01", effectiveTo: null },
    new Set([start]),
    1,
    true
  );
  return out;
}
