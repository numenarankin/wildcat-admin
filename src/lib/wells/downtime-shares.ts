/**
 * Downtime-aware allocation reweighting (pure).
 *
 * A well that is DOWN (a `well_events` shut-in / downtime covering the day)
 * produces none of oil, gas, or water that day. So its share of every allocation
 * group it belongs to goes to 0 and the online wells absorb it in their existing
 * proportions — the group still sums to 100%. Example, base A 20 / B 30 / C 50
 * with A down: A→0, B→30/80 = 37.5%, C→50/80 = 62.5% (B and C keep their 30:50
 * relative standing, they don't split A's share evenly).
 *
 * This is the flat-map reweight for the oil (tank/battery) and gas (meter)
 * allocation paths, whose split is a `wellId -> fraction` map. Water uses the same
 * RULE but a different mechanism (the multi-hop `flow_connections` graph in
 * `@/lib/flow/graph`), so it renormalizes there rather than here. Both share the
 * per-day primitive `isOnlineOn` and the same all-down fallback.
 *
 * Pure and DB-free so it unit-tests directly and layers on top of the existing
 * straight-share split without touching it.
 */

import { isOnlineOn, type WellEvent } from "@/lib/wells/well-events";

/**
 * Re-normalize a per-well straight split (`wellId -> fraction`, as
 * `straightShares` returns) for one day so any well DOWN that day gets 0 and the
 * online wells absorb its share in their existing proportions.
 *
 * Returns `base` unchanged on the fast path (nobody down that day) and on the
 * all-down degenerate case (no online well to carry the total): per the owner's
 * rule, if every member is down but the point still measured production, we
 * pretend there was no downtime and keep the pre-downtime split rather than lose
 * the day's barrels or emit NaN. This should never happen; it is robustness only.
 */
export function downtimeAdjustedShares(
  base: Map<string, number>,
  eventsByWell: Map<string, WellEvent[]>,
  date: string
): Map<string, number> {
  const online = (wellId: string) =>
    isOnlineOn(eventsByWell.get(wellId) ?? [], date);

  let onlineSum = 0;
  let anyDown = false;
  for (const [wellId, share] of base) {
    if (online(wellId)) onlineSum += share;
    else anyDown = true;
  }
  if (!anyDown) return base; // fast path — common case, no reweighting needed
  if (onlineSum <= 0) return base; // all down: keep base, never lose barrels

  const out = new Map<string, number>();
  for (const [wellId, share] of base) {
    out.set(wellId, online(wellId) ? share / onlineSum : 0);
  }
  return out;
}
