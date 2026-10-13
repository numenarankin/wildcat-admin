/**
 * Pure share math for a gas well test (subtractive shut-in), DB-free so it
 * unit-tests without a database. A gas meter measures one total, so a well test
 * shuts one well in and reads the meter's DROP against what it was making with
 * everything online:
 *
 *   fracᵢ = (baselineRate − shutInRateᵢ) / baselineRate      // clamp negatives to 0
 *
 * The BASELINE is not entered. The meter was being read before the well was shut
 * in, so the rate it was making then is already on file: it is read off the
 * meter's own series over the window immediately before the test
 * (`gas-campaigns.ts`). A test therefore records one well and one window, which
 * is all a pumper actually does.
 *
 * A shut-in that reads ABOVE baseline (the total rose between measurements) yields
 * a spurious negative; it is clamped to 0. The clamped per-well fractions become a
 * 100% split exactly like the oil campaign: normalize when every member well was
 * shut in, or let a single never-shut-in well absorb the leftover. More than one
 * never-shut-in well cannot be derived.
 *
 * The `frac → clamp → normalize/leftover` skeleton is shared with the oil path
 * (which forms `frac = iso / (iso + control)` from a well test) through
 * `sharesFromFractions` in `@/lib/tanks/allocation` — one rule for every
 * well-test-derived split, not a copy per substance.
 */

import { sharesFromFractions } from "@/lib/tanks/allocation";

/** A campaign's rates: one baseline (all on) + one shut-in rate per tested well. */
export interface GasCampaign {
  /** Meter rate with every well online (MCF/day). */
  baselineRate: number;
  /** One entry per tested well: that well off, the rest on (MCF/day). */
  shutIns: { wellId: string; rate: number }[];
}

/**
 * One well's share of the meter from ONE shut-in, or null when it cannot be
 * derived.
 *
 * `frac = (baseline − shutIn) ÷ baseline`, clamped at 0. A shut-in that reads
 * ABOVE the baseline (the meter's total rose between the two windows) gives a
 * spurious negative, which is clamped rather than allowed to subtract from
 * somebody else's share. A baseline of zero or less is no baseline at all: every
 * fraction would divide by it.
 */
export function shutInFrac(
  baselineRate: number | null,
  shutInRate: number | null,
): number | null {
  if (baselineRate == null || !Number.isFinite(baselineRate) || baselineRate <= 0) {
    return null;
  }
  if (shutInRate == null || !Number.isFinite(shutInRate)) return null;
  const frac = (baselineRate - shutInRate) / baselineRate;
  return frac > 0 ? frac : 0;
}

/** One well's resolved share of the meter. */
export interface GasShare {
  wellId: string;
  pct: number;
}

/**
 * Resolve a gas campaign to a per-well % split (subtractive, single baseline).
 * `baselineRate <= 0` yields an error (no usable baseline). Each tested well's
 * fraction is `(baseline − shutin) / baseline` clamped to ≥ 0; the fractions then
 * normalize (0 untested) or leave a leftover (1 untested); `> 1` untested errors.
 */
export function gasCampaignShares(
  c: GasCampaign,
  memberWellIds: string[]
): { shares: GasShare[]; error?: string } {
  if (!Number.isFinite(c.baselineRate) || c.baselineRate <= 0) {
    return {
      shares: [],
      error: "No usable baseline: the baseline rate must be greater than 0.",
    };
  }

  const fracByWell = new Map<string, number>();
  for (const s of c.shutIns) {
    if (!s.wellId) continue;
    const rate = Number.isFinite(s.rate) ? s.rate : 0;
    const frac = (c.baselineRate - rate) / c.baselineRate;
    // Clamp negatives to 0 (a shut-in reading above baseline is spurious).
    fracByWell.set(s.wellId, frac > 0 ? frac : 0);
  }

  return sharesFromFractions(fracByWell, memberWellIds, {
    untestedError: () =>
      "More than one well was never shut in, so the split can't be derived. " +
      "Shut in all but at most one well.",
  });
}
