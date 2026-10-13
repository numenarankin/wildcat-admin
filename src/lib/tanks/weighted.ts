import { activeAllocations, straightShares, type AllocationRow } from "@/lib/tanks/allocation";
import {
  latestTestAsOf,
  testRateFor,
  type WeightProduct,
  type WellTest,
} from "@/lib/wells/well-tests";
import {
  daysInclusive,
  onlineDays,
  type WellEvent,
} from "@/lib/wells/well-events";

/**
 * Weighted allocation (GBC-11) — the pure core of the `weighted` method.
 *
 * A commingled tank's total is split to its wells by `weight = test_rate ×
 * online_days`, where the rate comes from each well's most recent FRESH test
 * (within a freshness window before the period end) and online days = period
 * days − downtime/shut-in. A well whose test is MISSING or STALE can't be
 * weighted, so it falls back to its `straight_pct` share and is FLAGGED — the
 * "don't leave operators out to dry" rule. Freshness makes the method
 * effective-dated for free: a weighted tank derives via straight fallback for
 * periods before a test exists and switches to weighted once a fresh test lands.
 *
 * Pure and dependency-free (types + the straight/test helpers) so it unit-tests
 * without a database; the engine's `weighted` ShareFn and the Well Test Report
 * report both build on it, so there is one weighting path, not two.
 */

/** Default test freshness window (days) before a test is considered stale. */
export const DEFAULT_FRESHNESS_DAYS = 90;

/** Inclusive period bounds (ISO `YYYY-MM-DD`). */
export interface WeightPeriod {
  from: string;
  to: string;
}

/** Per-well tests + events, keyed by well id, plus the period/product/freshness. */
export interface WeightingContext {
  period: WeightPeriod;
  /** Stream whose test rate weights the split — tank oil/water, or gas (meters). */
  product: WeightProduct;
  testsByWell: Map<string, WellTest[]>;
  eventsByWell: Map<string, WellEvent[]>;
  /** Days a test stays fresh; defaults to `DEFAULT_FRESHNESS_DAYS`. */
  freshnessDays?: number;
}

/** Why a well couldn't be weighted (so it fell back to straight). */
export type FallbackReason = "missing_test" | "stale_test" | null;

/** Full per-well weighting detail — the Well Test Report reads this. */
export interface WeightedWellShare {
  wellId: string;
  /** Final share of the tank, 0–1. */
  share: number;
  /** Fixed % the well would get under straight (0–100). */
  straightPct: number;
  /** Per-day product rate from the chosen fresh test, or null if none. */
  testRate: number | null;
  /** Date of the test used, or null (missing / stale). */
  testDate: string | null;
  /** Age of that test in days at the period end, or null. */
  testAgeDays: number | null;
  /** Online days over the period (period days − downtime/shut-in). */
  onlineDays: number;
  /** Period length in days. */
  periodDays: number;
  /** `testRate × online_days`, or null when the well fell back to straight. */
  weight: number | null;
  /** Whether the well used its straight fallback. */
  fallback: boolean;
  fallbackReason: FallbackReason;
}

/** The weighted split for a tank: engine-facing `shares` + report `detail`. */
export interface WeightedAllocation {
  /** well id → share (0–1); only positive shares, like `straightShares`. */
  shares: Map<string, number>;
  /** Every well on the tank, with its weighting story (for the report). */
  detail: WeightedWellShare[];
}

/** Clamp a straight percentage to a [0,1] fraction. */
function pctFraction(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.min(1, pct / 100);
}

/**
 * Compute the weighted split of a tank whose wells are the active allocation
 * rows at `onDate`. Each well is weighted by `test_rate × online_days`; wells
 * without a fresh test are pinned to their `straight_pct` fraction (flagged),
 * and the fresh-test wells share the remainder in proportion to their weights.
 * If no well can be weighted (all missing/stale, or all weights zero), the whole
 * tank degrades to the straight split — fallback flags are preserved on `detail`.
 */
export function weightedAllocation(
  allocations: AllocationRow[],
  onDate: string,
  ctx: WeightingContext
): WeightedAllocation {
  const active = activeAllocations(allocations, onDate);
  const { period, product } = ctx;
  const freshnessDays = ctx.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;
  const periodDays = daysInclusive(period.from, period.to);

  const detail: WeightedWellShare[] = active.map((a) => {
    const tests = ctx.testsByWell.get(a.wellId) ?? [];
    const events = ctx.eventsByWell.get(a.wellId) ?? [];
    const online = onlineDays(events, period.from, period.to);
    const chosen = latestTestAsOf(tests, period.to);
    const testAgeDays =
      chosen != null ? daysInclusive(chosen.testDate, period.to) - 1 : null;
    const fresh = chosen != null && (testAgeDays ?? 0) <= freshnessDays;

    if (!fresh) {
      return {
        wellId: a.wellId,
        share: 0,
        straightPct: a.straightPct,
        testRate: null,
        testDate: chosen?.testDate ?? null,
        testAgeDays,
        onlineDays: online,
        periodDays,
        weight: null,
        fallback: true,
        fallbackReason: chosen ? "stale_test" : "missing_test",
      };
    }

    const rate = testRateFor(chosen, product);
    return {
      wellId: a.wellId,
      share: 0,
      straightPct: a.straightPct,
      testRate: rate,
      testDate: chosen.testDate,
      testAgeDays,
      onlineDays: online,
      periodDays,
      weight: Math.max(0, rate) * online,
      fallback: false,
      fallbackReason: null,
    };
  });

  const weighted = detail.filter((d) => d.weight != null && d.weight > 0);
  const sumWeight = weighted.reduce((s, d) => s + (d.weight ?? 0), 0);

  // No usable weights anywhere → degrade the whole tank to the straight split
  // (keeping the fallback flags already recorded on `detail`).
  if (sumWeight <= 0) {
    const straight = straightShares(active);
    for (const d of detail) d.share = straight.get(d.wellId) ?? 0;
    return { shares: prune(straight), detail };
  }

  // Fallback wells keep their straight_pct fraction; the fresh-test wells split
  // whatever remains, weighted by `test_rate × online_days`.
  let pinnedTotal = detail
    .filter((d) => d.fallback)
    .reduce((s, d) => s + pctFraction(d.straightPct), 0);
  const pinnedScale = pinnedTotal > 1 ? 1 / pinnedTotal : 1;
  pinnedTotal = Math.min(1, pinnedTotal);
  const remaining = Math.max(0, 1 - pinnedTotal);

  const shares = new Map<string, number>();
  for (const d of detail) {
    if (d.fallback) {
      d.share = pctFraction(d.straightPct) * pinnedScale;
    } else {
      d.share = ((d.weight ?? 0) / sumWeight) * remaining;
    }
    if (d.share > 0) shares.set(d.wellId, d.share);
  }
  return { shares, detail };
}

/** Drop non-positive entries from a share map (matches `straightShares`). */
function prune(shares: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of shares) if (v > 0) out.set(k, v);
  return out;
}
