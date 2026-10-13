import type { SupabaseClient } from "@supabase/supabase-js";
import { getTank } from "@/lib/tanks/tanks";
import type { TankAllocation } from "@/lib/tanks/allocations";
import { batteryAllocationForTank } from "@/lib/batteries/allocations";
import { getMeter } from "@/lib/meters/meters";
import { listMeterAllocations } from "@/lib/meters/allocations";
import { nodeEffectiveWaterSplit } from "@/lib/flow/effective-water";
import { methodShares } from "@/lib/tanks/engine";
import {
  daysInclusive,
  listAllWellEvents,
  type WellEvent,
} from "@/lib/wells/well-events";
import { listAllWellTests, type WellTest } from "@/lib/wells/well-tests";

/**
 * Revenue split (GBC) — turn a statement line's net value at a tank/meter into
 * per-well shares over the settlement period.
 *
 * A statement line settles ONE tank (oil) or meter (gas); the money is split to
 * the wells feeding that point by the SAME allocation the production engine uses:
 * the tank's configured method (`straight` fixed % or `weighted` test_rate ×
 * online_days), or — for meters — the straight method, downtime-adjusted. Shares
 * are computed over the statement period `[from, to]`, never a single day, so a
 * mid-period test/downtime change is integrated. Nothing is frozen: the split is
 * recomputed on read, so a late downtime report re-splits automatically.
 *
 * The period-share math is PURE (`straightPeriodShares`) so it unit-tests without
 * a database; `revenueShares` is the thin DB wrapper.
 */

/** Inclusive settlement window, ISO `YYYY-MM-DD`. */
export interface Period {
  from: string;
  to: string;
}

/** Minimal allocation-row shape shared by tank + meter splits. */
export interface RevenueSplit {
  wellId: string;
  straightPct: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Preloaded tests + downtime so a batch (e.g. reconcile) doesn't reload per line. */
export interface RevenueWeighting {
  eventsByWell: Map<string, WellEvent[]>;
  testsByWell: Map<string, WellTest[]>;
}

/** The measurement point a line settles. */
export type RevenuePoint =
  | { type: "tank"; id: string; wellId?: string | null }
  | { type: "meter"; id: string; wellId?: string | null };

function pctFraction(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.min(1, pct / 100);
}

/** Split rows whose effective window covers `onDate`. */
function activeOn(splits: RevenueSplit[], onDate: string): RevenueSplit[] {
  return splits.filter(
    (s) =>
      s.effectiveFrom <= onDate && (s.effectiveTo == null || onDate <= s.effectiveTo)
  );
}

/** Adapt a revenue split to the `TankAllocation` shape `methodShares` reads. */
function toAllocation(s: RevenueSplit): TankAllocation {
  return {
    id: "",
    tankId: "",
    wellId: s.wellId,
    straightPct: s.straightPct,
    effectiveFrom: s.effectiveFrom,
    effectiveTo: s.effectiveTo,
  };
}

/** Never enumerate more than this many days (guards a pathological period). */
const MAX_PERIOD_DAYS = 400;

/** Inclusive list of ISO dates in `[from, to]`, capped for safety. */
function eachDay(from: string, to: string): string[] {
  const n = daysInclusive(from, to);
  if (n <= 0) return [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const out: string[] = [];
  for (let i = 0; i < Math.min(n, MAX_PERIOD_DAYS); i++) {
    out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Straight split shares over a period, computed the SAME way the meter/tank
 * engine does: run the downtime-adjusted straight split (`methodShares`) for each
 * day in `[from, to]` and average the daily share vectors. This matches
 * `meters/engine.ts` exactly — on a day a well is shut in, it drops out and the
 * online wells absorb that day's split (renormalized), rather than the online
 * well's weight merely shrinking. Because a statement gives a period lump (no
 * daily volumes) each day is weighted equally, so the only difference from the
 * engine is that it can't volume-weight — which a lump makes impossible anyway.
 *
 * When every day derives nothing (all wells down for the whole period, or all
 * %s zero) it falls back to the plain fixed split so revenue isn't dropped;
 * returns empty only when there are no positive %s at all.
 */
export function straightPeriodShares(
  splits: RevenueSplit[],
  period: Period,
  eventsByWell: Map<string, WellEvent[]>
): Map<string, number> {
  const allocations = splits.map(toAllocation);
  const acc = new Map<string, number>();
  let total = 0;
  for (const date of eachDay(period.from, period.to)) {
    const dayShares = methodShares("straight", allocations, date, {
      period: { from: date, to: date },
      product: "oil",
      testsByWell: new Map(),
      eventsByWell,
    });
    for (const [wellId, share] of dayShares) {
      acc.set(wellId, (acc.get(wellId) ?? 0) + share);
      total += share;
    }
  }

  const out = new Map<string, number>();
  if (total > 0) {
    for (const [wellId, sum] of acc) {
      const f = sum / total;
      if (f > 0) out.set(wellId, f);
    }
    return out;
  }

  // No online day anywhere → plain fixed split (downtime-blind).
  const active = activeOn(splits, period.to);
  const psum = active.reduce((a, s) => a + pctFraction(s.straightPct), 0);
  if (psum <= 0) return out;
  for (const s of active) {
    const f = pctFraction(s.straightPct) / psum;
    if (f > 0) out.set(s.wellId, f);
  }
  return out;
}

function fallback(wellId: string | null | undefined): Map<string, number> {
  return wellId ? new Map([[wellId, 1]]) : new Map();
}

/** Load org-wide tests + downtime once, keyed by well id. */
export async function loadRevenueWeighting(
  sb: SupabaseClient
): Promise<RevenueWeighting> {
  const [events, tests] = await Promise.all([
    listAllWellEvents(sb),
    listAllWellTests(sb),
  ]);
  const eventsByWell = new Map<string, WellEvent[]>();
  for (const e of events) {
    const arr = eventsByWell.get(e.wellId) ?? [];
    arr.push(e);
    eventsByWell.set(e.wellId, arr);
  }
  const testsByWell = new Map<string, WellTest[]>();
  for (const t of tests) {
    const arr = testsByWell.get(t.wellId) ?? [];
    arr.push(t);
    testsByWell.set(t.wellId, arr);
  }
  return { eventsByWell, testsByWell };
}

/**
 * Per-well shares for a statement line's tank/meter over the settlement period.
 * Pass a preloaded `weighting` when splitting many lines at once (reconcile) so
 * tests/downtime load once, not per line.
 */
export async function revenueShares(
  sb: SupabaseClient,
  point: RevenuePoint,
  period: Period,
  weighting?: RevenueWeighting
): Promise<Map<string, number>> {
  const w = weighting ?? (await loadRevenueWeighting(sb));

  if (point.type === "tank") {
    const tank = await getTank(sb, point.id);
    if (!tank) return fallback(point.wellId);

    // WATER revenue splits by the tank's EFFECTIVE water split — the same seam the
    // production series and the allocation card read (manual override wins, else
    // the wells' well-test water rates). Reading it here is what keeps a water
    // haul's revenue and its production attribution from disagreeing.
    if (tank.product === "water") {
      const shares = await nodeEffectiveWaterSplit(sb, {
        type: "tank",
        id: point.id,
      });
      const total = shares.reduce((sum, sh) => sum + sh.pct, 0);
      if (total <= 0) return fallback(point.wellId);
      return new Map(shares.map((sh) => [sh.wellId, sh.pct / total]));
    }

    // OIL revenue splits at the tank's BATTERY (oil allocation lives there). The
    // battery timeline is already resolved to straight rows — well-test periods
    // included — so there is no second method to dispatch on here.
    const { allocations } = await batteryAllocationForTank(sb, tank);
    if (allocations.length === 0) return fallback(point.wellId);
    const shares = straightPeriodShares(allocations, period, w.eventsByWell);
    return shares.size ? shares : fallback(point.wellId);
  }

  const meter = await getMeter(sb, point.id);
  if (!meter) return fallback(point.wellId);
  const allocations = await listMeterAllocations(sb, point.id);
  if (allocations.length === 0) return fallback(point.wellId);
  const shares = straightPeriodShares(allocations, period, w.eventsByWell);
  return shares.size ? shares : fallback(point.wellId);
}

/**
 * Blend several sale points' well shares into one lease-wide split.
 *
 * Each part is one battery's (or meter's) shares over the period, already
 * summing to 1, and its weight is how much of the product left through it:
 * barrels hauled off its tanks, MCF through the meter. A lease with one sale
 * point - the common case - is that point's split unchanged. When nothing was
 * hauled or metered in the period the points weigh equally, so the split still
 * lands on the wells rather than stopping at the lease. Pure.
 */
export function blendShares(
  parts: { shares: Map<string, number>; weight: number }[]
): Map<string, number> {
  const live = parts.filter((p) => p.shares.size > 0);
  if (live.length === 0) return new Map();
  const total = live.reduce((a, p) => a + Math.max(0, p.weight), 0);
  const acc = new Map<string, number>();
  for (const p of live) {
    const w = total > 0 ? Math.max(0, p.weight) / total : 1 / live.length;
    if (w <= 0) continue;
    for (const [wellId, f] of p.shares) {
      acc.set(wellId, (acc.get(wellId) ?? 0) + f * w);
    }
  }
  const sum = [...acc.values()].reduce((a, b) => a + b, 0);
  const out = new Map<string, number>();
  if (sum <= 0) return out;
  for (const [wellId, f] of acc) if (f > 0) out.set(wellId, f / sum);
  return out;
}
