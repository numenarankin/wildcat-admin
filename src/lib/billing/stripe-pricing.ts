import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/billing/stripe";
import { getWellsPriceId, hasStripe } from "@/lib/env";
import type { PriceTier, TiersMode } from "@/lib/billing/stripe-tiers";
import type { BillingInterval, WellPrice, WellPricing } from "@/lib/billing/tiers";

/**
 * The well prices, read from Stripe: the only place a dollar amount for a band
 * comes from. Held per server instance for a few minutes, so a page render does
 * not cost two Stripe round trips while a price edited in the dashboard still
 * shows up without a deploy.
 */
const TTL_MS = 5 * 60_000;
let cached: { at: number; pricing: Promise<WellPricing> } | null = null;

async function readPrice(interval: BillingInterval): Promise<WellPrice> {
  const id = getWellsPriceId(interval);
  if (!id) {
    throw new Error(
      `Stripe ${interval}ly well price is not configured: set ${interval === "year" ? "STRIPE_PRICE_WELLS_YEARLY" : "STRIPE_PRICE_WELLS"}.`
    );
  }
  // `tiers` is an expansion: a plain retrieve leaves it off.
  const price: Stripe.Price = await getStripe().prices.retrieve(id, { expand: ["tiers"] });
  return {
    tiersMode: (price.tiers_mode as TiersMode | null) ?? null,
    tiers: ((price.tiers ?? []) as PriceTier[]).map((t) => ({
      up_to: t.up_to,
      flat_amount: t.flat_amount,
      unit_amount: t.unit_amount,
    })),
    unitAmount: price.unit_amount,
  };
}

/** Both well prices from Stripe. Throws when Stripe is not configured or unreachable. */
export function getWellPricing(): Promise<WellPricing> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.pricing;
  const pricing = Promise.all([readPrice("month"), readPrice("year")]).then(
    ([month, year]) => ({ month, year })
  );
  cached = { at: Date.now(), pricing };
  // A failed read is not cached: the next caller tries Stripe again.
  pricing.catch(() => {
    if (cached?.pricing === pricing) cached = null;
  });
  return pricing;
}

/**
 * The well prices for a page that can render without them: null when this
 * deployment has no Stripe, or when Stripe could not be read (logged, so a
 * missing price is never silent).
 */
export async function getWellPricingOrNull(): Promise<WellPricing | null> {
  if (!hasStripe()) return null;
  try {
    return await getWellPricing();
  } catch (err) {
    console.error("getWellPricing failed", err instanceof Error ? err.message : err);
    return null;
  }
}
