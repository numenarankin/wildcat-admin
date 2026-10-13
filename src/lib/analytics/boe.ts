/**
 * BOE by PRICE, not by energy.
 *
 * The industry's 6:1 barrel-of-oil-equivalent is an energy conversion: six MCF
 * of gas holds about as much heat as a barrel of oil. It has not been an
 * economic statement for a long time. At $75 oil and $2.50 gas, six MCF is worth
 * $15, a fifth of the barrel it is being counted as, so a 6:1 BOE decline curve
 * for a gassy lease describes a business that does not exist: the volume can
 * hold up while the revenue falls away, or the reverse.
 *
 * So the dashboard converts at the PRICE ratio instead. One MCF counts as
 * `gasPerMcf / oilPerBbl` barrels, which makes a BOE here mean "the barrels this
 * production is worth" and makes a BOE decline the decline of the money.
 *
 * Pure, and separate from `./types` so the well-level 6:1 `boe` field (a sort
 * key for the well picker, where energy is the honest unit because it is
 * comparing wells, not valuing them) cannot be confused for this one.
 */

import type { CommodityPrices } from "@/lib/analytics/types";

/**
 * What one MCF of gas is worth in barrels of oil, at these prices.
 *
 * Guarded against a zero or missing oil price: with no denominator there is no
 * ratio, and counting gas as zero barrels understates a gas well to nothing, so
 * it falls back to the 6:1 energy convention and says so by being the only place
 * that number appears.
 */
export function gasBarrelsPerMcf(prices: CommodityPrices | undefined): number {
  const oil = prices?.oilPerBbl;
  const gas = prices?.gasPerMcf;
  // Missing prices land in the same fallback as unusable ones: a page that never
  // loaded a quote is not a page where gas is worth nothing.
  if (oil == null || gas == null || !(oil > 0) || !(gas >= 0)) return 1 / 6;
  return gas / oil;
}

/** Oil plus price-equivalent gas, in barrels. */
export function priceBoe(
  oilBbl: number,
  gasMcf: number,
  prices: CommodityPrices
): number {
  return oilBbl + gasMcf * gasBarrelsPerMcf(prices);
}
