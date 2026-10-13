/**
 * What one billing period costs for a quantity on a Stripe price, from the
 * price's own tier table. Pure, so the arithmetic is testable against the
 * band table by hand. Amounts are in the price's minor unit (cents).
 */

export interface PriceTier {
  up_to: number | null;
  flat_amount: number | null;
  unit_amount: number | null;
}

export type TiersMode = "volume" | "graduated";

export function periodAmountCents(
  price: { tiers_mode: TiersMode | null; tiers?: PriceTier[] | null; unit_amount: number | null },
  quantity: number
): number {
  const tiers = price.tiers ?? [];
  if (!price.tiers_mode || tiers.length === 0) return (price.unit_amount ?? 0) * quantity;

  if (price.tiers_mode === "volume") {
    // The whole quantity is priced by the tier it lands in.
    const tier = tiers.find((t) => t.up_to === null || quantity <= t.up_to) ?? tiers[tiers.length - 1];
    return (tier.flat_amount ?? 0) + (tier.unit_amount ?? 0) * quantity;
  }

  // Graduated: each tier prices the units that fall inside it.
  let remaining = quantity;
  let floor = 0;
  let total = 0;
  for (const t of tiers) {
    if (remaining <= 0) break;
    const span = t.up_to === null ? remaining : Math.min(remaining, t.up_to - floor);
    total += (t.flat_amount ?? 0) + (t.unit_amount ?? 0) * span;
    remaining -= span;
    if (t.up_to !== null) floor = t.up_to;
  }
  return total;
}
