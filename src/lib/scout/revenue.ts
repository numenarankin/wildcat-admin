import {
  GAS_PRICE_PER_MCF,
  OIL_PRICE_PER_BBL,
  type CommodityPrices,
} from "@/lib/analytics/types";

/**
 * Rough revenue estimate for a Scout operator, from its last-12-month lease
 * production valued at the topbar's live commodity prices.
 *
 * This is a PROSPECTING heuristic, not revenue:
 *   - The production is the operator's OWN reported volume (see `OperatorPoint`
 *     o12/g12), so it counts barrels other working-interest owners are paid for.
 *   - It is the TRAILING year revalued at today's prices, not a forecast: a
 *     declining lease reads high and a new one reads low.
 *   - Prices are today's front-month futures applied to a year of past
 *     production, with no differential, deducts, or royalty.
 *
 * The gas quote is $/MMBtu applied per MCF (~3.7% low at 1.037 MMBtu/MCF).
 * That's deliberate: `src/lib/analytics/analytics.ts:115` values the company's
 * own production exactly this way (`gasPerMcf: gasPrice` straight off the NG
 * quote), and one convention across the app beats a more precise second one.
 */
export function annualRevenue(
  oil12: number | undefined,
  gas12: number | undefined,
  prices: CommodityPrices
): number {
  const oil = (oil12 ?? 0) * prices.oilPerBbl;
  const gas = (gas12 ?? 0) * prices.gasPerMcf;
  return oil + gas;
}

/**
 * The same estimate per month, from volumes that are ALREADY per month.
 *
 * Not `annualRevenue / 12`, which is what this used to be. That division
 * assumed the year's volume covered twelve reported months, and the RRC's ~3
 * month lag means it routinely does not — the caller now divides its own sum by
 * the cycles it actually observed (see `perMonth` in `format.ts`) and hands the
 * rate here. Pricing is otherwise identical, so a page showing both a monthly
 * and an annual figure gets them from one place.
 */
export function monthlyRevenue(
  oilPerMonth: number | undefined,
  gasPerMonth: number | undefined,
  prices: CommodityPrices
): number {
  return annualRevenue(oilPerMonth, gasPerMonth, prices);
}

/** Fallbacks when the quote feed is unreachable — the same ones analytics uses. */
export const FALLBACK_PRICES: CommodityPrices = {
  oilPerBbl: OIL_PRICE_PER_BBL,
  gasPerMcf: GAS_PRICE_PER_MCF,
};
