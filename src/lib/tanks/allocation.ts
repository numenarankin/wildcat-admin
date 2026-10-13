/**
 * A single well split row, as the pure derivation sees it — identity-agnostic
 * (it does not care whether the row is keyed to a tank or a battery), so the same
 * math serves tank, battery, meter, and disposal allocation. Concrete rows
 * (`BatteryAllocation`, `MeterAllocation`, …) satisfy this shape.
 */
export type AllocationMethod = "straight" | "weighted";

export interface AllocationRow {
  wellId: string;
  /** Fixed % of the total going to this well (0–100), straight method. */
  straightPct: number;
  /** ISO `YYYY-MM-DD` the split takes effect. */
  effectiveFrom: string;
  /** ISO `YYYY-MM-DD` the split ends, or null when still active. */
  effectiveTo: string | null;
}

/**
 * Straight-method allocation derivation (GBC-4 minimal slice of GBC-2).
 *
 * Turns a tank's total product for a period into per-well shares using the
 * fixed straight percentages. A single-well tank (one 100% row) derives that
 * well's production at 100%. Percentages are normalised against their own sum,
 * so a tank whose splits don't total exactly 100 still allocates the whole
 * total (no product is lost or invented).
 *
 * Pure and dependency-free (types only) so it unit-tests without a database and
 * can be shared by every derivation path. GBC-2's engine
 * (`@/lib/tanks/engine.ts`) builds on these helpers — its method dispatch calls
 * `straightShares`/`activeAllocations` for the straight method and layers
 * period `tank_total` and weighted (GBC-11) selection on top.
 */

// --- Validation (pure) -----------------------------------------------------

const PCT_TOLERANCE = 0.01;
/** Open-ended period sentinels for date-string interval comparison. */
const MIN_DATE = "0000-01-01";
const MAX_DATE = "9999-12-31";

export interface AllocationValidation {
  ok: boolean;
  sum: number;
  error?: string;
}

/** A split row for validation; dates optional (a blank `from` defaults to the
 * device's history start server-side, a blank/undefined `to` is open-ended). */
export interface AllocationInput {
  wellId: string;
  straightPct: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

/**
 * Validate a straight-split set that may span MULTIPLE explicit periods:
 *   • every % in [0, 100];
 *   • each period (rows sharing one effective date range) sums to 100 within
 *     tolerance — an all-zero period is allowed (it derives nothing);
 *   • no two active (non-zero) periods OVERLAP in time — otherwise a day is
 *     double-allocated (e.g. two 100% ranges → 200% on the overlap).
 * `effectiveTo` is inclusive, matching {@link activeAllocations}.
 */
export function validateStraightAllocationSet(
  rows: AllocationInput[]
): AllocationValidation {
  const live = rows.filter((r) => r.wellId);
  const totalSum = live.reduce(
    (s, r) => s + (Number.isFinite(r.straightPct) ? r.straightPct : 0),
    0
  );
  const bad = live.find((r) => r.straightPct < 0 || r.straightPct > 100);
  if (bad)
    return {
      ok: false,
      sum: totalSum,
      error: `Split % must be between 0 and 100 (well ${bad.wellId}).`,
    };

  // Bucket rows into their effective period (same from + to).
  const groups = new Map<string, { from: string; to: string | null; sum: number }>();
  for (const r of live) {
    const from = r.effectiveFrom || "";
    const to = r.effectiveTo ?? null;
    const key = `${from}|${to ?? ""}`;
    const g = groups.get(key) ?? { from, to, sum: 0 };
    g.sum += Number.isFinite(r.straightPct) ? r.straightPct : 0;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.sum === 0) continue;
    if (Math.abs(g.sum - 100) > PCT_TOLERANCE)
      return {
        ok: false,
        sum: g.sum,
        error: `Each date range must total 100% (a range totals ${g.sum}%).`,
      };
  }

  // No two active periods may overlap in time.
  const active = [...groups.values()].filter((g) => g.sum > 0);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      const aFrom = a.from || MIN_DATE;
      const aTo = a.to || MAX_DATE;
      const bFrom = b.from || MIN_DATE;
      const bTo = b.to || MAX_DATE;
      if (aFrom <= bTo && bFrom <= aTo)
        return {
          ok: false,
          sum: totalSum,
          error:
            "Date ranges overlap. Set the earlier period's end before the next begins.",
        };
    }
  }
  return { ok: true, sum: totalSum };
}

/** Do two effective ranges overlap? Inclusive bounds; blank from/to are open. */
export function periodsOverlap(
  a: { effectiveFrom: string | null; effectiveTo: string | null },
  b: { effectiveFrom: string | null; effectiveTo: string | null }
): boolean {
  const aFrom = a.effectiveFrom || MIN_DATE;
  const aTo = a.effectiveTo || MAX_DATE;
  const bFrom = b.effectiveFrom || MIN_DATE;
  const bTo = b.effectiveTo || MAX_DATE;
  return aFrom <= bTo && bFrom <= aTo;
}

/** ISO `YYYY-MM-DD` one day before `iso` — for chaining a period's end to the day
 * before the next period's start. */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Chain straight rows into a partitioned, non-overlapping timeline by START date:
 * rows are grouped by `effectiveFrom`; each period runs until the day before the
 * NEXT distinct start, and the latest period stays open (`null`). Returns new rows
 * with `effectiveTo` filled. This is what makes the from-only model safe for the
 * engine's inclusive-bound {@link activeAllocations}.
 */
export function chainPeriodEnds<T extends AllocationRow>(rows: T[]): T[] {
  const starts = [...new Set(rows.map((r) => r.effectiveFrom))].sort();
  const endByStart = new Map<string, string | null>();
  starts.forEach((from, i) => {
    const next = starts[i + 1];
    endByStart.set(from, next ? dayBefore(next) : null);
  });
  return rows.map((r) => ({ ...r, effectiveTo: endByStart.get(r.effectiveFrom) ?? null }));
}

/**
 * Per-well split percentages (summing to 100) from each well's OIL test RATE on a
 * test date: a well's share = its rate ÷ the sum of all wells' rates. Wells with a
 * zero/absent rate get 0. Empty or all-zero input yields an empty list.
 */
export function wellTestShares(
  rates: { wellId: string; rate: number }[]
): { wellId: string; pct: number }[] {
  const positive = rates.filter((r) => Number.isFinite(r.rate) && r.rate > 0);
  const total = positive.reduce((s, r) => s + r.rate, 0);
  if (total <= 0) return [];
  return positive.map((r) => ({ wellId: r.wellId, pct: (r.rate / total) * 100 }));
}

/** One well's resolved share of a device, as a percentage (0–100). */
export interface WellShare {
  wellId: string;
  pct: number;
}

/**
 * Turn per-well test FRACTIONS (each well's share of the device's total, 0–1) into
 * a 100% split, given the device's full member set. This is the one rule every
 * well-test-derived split obeys — oil isolation (`iso ÷ (iso + control)`) and gas
 * subtractive shut-in (`(baseline − shutin) ÷ baseline`) both land here:
 *
 *   • 0 untested  → normalize the tested fractions to 100 (drift absorbed);
 *   • 1 untested  → tested wells keep raw `frac × 100`, the single leftover well
 *                   absorbs `100 − Σ(tested)`, clamped to ≥ 0;
 *   • > 1 untested → cannot be derived; returns an error and no shares.
 *
 * Fractions are assumed already clamped to ≥ 0 by the caller. Untested = a member
 * well with no entry in `fracByWell`. `untestedError` lets each caller phrase the
 * >1-untested case in its own field terms ("never shut in" for gas, "not tested"
 * for an oil isolation test).
 */
export function sharesFromFractions(
  fracByWell: Map<string, number>,
  memberWellIds: string[],
  opts: { untestedError?: (untested: number, members: number) => string } = {}
): { shares: WellShare[]; error?: string } {
  const members = [...new Set(memberWellIds)];
  const tested = members.filter((id) => fracByWell.has(id));
  const untested = members.filter((id) => !fracByWell.has(id));

  if (untested.length > 1) {
    const message =
      opts.untestedError ??
      ((n: number, total: number) =>
        `${n} wells were not tested. Test at least ${total - 1} of the ${total} ` +
        `wells so the remaining split can be derived.`);
    return { shares: [], error: message(untested.length, members.length) };
  }

  const fracOf = (id: string): number => fracByWell.get(id) ?? 0;

  if (untested.length === 0) {
    const total = tested.reduce((s, id) => s + fracOf(id), 0);
    if (total <= 0) return { shares: [] };
    return {
      shares: tested.map((id) => ({ wellId: id, pct: (fracOf(id) / total) * 100 })),
    };
  }

  const testedShares = tested.map((id) => ({ wellId: id, pct: fracOf(id) * 100 }));
  const sumTested = testedShares.reduce((s, r) => s + r.pct, 0);
  return {
    shares: [
      ...testedShares,
      { wellId: untested[0], pct: Math.max(0, 100 - sumTested) },
    ],
  };
}

/** Which split rows are active for a date (`YYYY-MM-DD`, inclusive bounds). */
export function activeAllocations<T extends AllocationRow>(
  allocations: T[],
  onDate: string
): T[] {
  return allocations.filter(
    (a) =>
      a.effectiveFrom <= onDate &&
      (a.effectiveTo == null || a.effectiveTo >= onDate)
  );
}

/**
 * Per-well shares (well id → fraction in [0,1]) for a set of straight splits.
 * Returns an empty map when the percentages sum to zero (nothing to allocate).
 */
export function straightShares(
  allocations: AllocationRow[]
): Map<string, number> {
  const total = allocations.reduce(
    (sum, a) => sum + (a.straightPct > 0 ? a.straightPct : 0),
    0
  );
  const shares = new Map<string, number>();
  if (total <= 0) return shares;
  for (const a of allocations) {
    if (a.straightPct <= 0) continue;
    shares.set(a.wellId, (shares.get(a.wellId) ?? 0) + a.straightPct / total);
  }
  return shares;
}

/**
 * Allocate a tank's period total (barrels) to its wells by the straight method.
 * Returns well id → barrels. A single-well tank yields `{ well: tankTotal }`.
 */
export function allocateStraight(
  tankTotal: number,
  allocations: AllocationRow[]
): Map<string, number> {
  const out = new Map<string, number>();
  const total = Number.isFinite(tankTotal) ? tankTotal : 0;
  for (const [wellId, share] of straightShares(allocations)) {
    out.set(wellId, share * total);
  }
  return out;
}

/**
 * Split 100% evenly across `count` wells, as percentage strings.
 *
 * The point is that the result SUMS TO EXACTLY 100. Three wells at 33.33 leave
 * a hundredth on the floor and the panel's "should be 100%" warning fires on a
 * split the operator just asked the app to make; three at 33.3333 round to 100
 * on screen while `numeric` stores a repeating tail nobody typed. So the shares
 * are quantized to hundredths and the remainder is handed out one hundredth at a
 * time, to the first rows: 33.34 / 33.33 / 33.33.
 *
 * Two decimals because that is what the panels display and what an operator
 * would write on a division order — never more precision than the number means.
 */
export function evenSplitPercents(count: number): string[] {
  if (count <= 0) return [];
  // Work in hundredths of a percent so the arithmetic is integer and exact.
  const HUNDREDTHS = 10_000;
  const base = Math.floor(HUNDREDTHS / count);
  const remainder = HUNDREDTHS - base * count;
  return Array.from({ length: count }, (_, i) => {
    const hundredths = base + (i < remainder ? 1 : 0);
    return (hundredths / 100).toFixed(2);
  });
}
