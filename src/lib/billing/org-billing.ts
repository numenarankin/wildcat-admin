import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getStripe } from "@/lib/billing/stripe";
import { getWellsPriceId, hasStripe } from "@/lib/env";

/**
 * Subscription changes that take the org as an argument, shared by the
 * customer's own billing actions (`actions.ts`, which resolve the org from the
 * session and gate on org admin) and the admin customer panel
 * (`lib/admin/customer-actions.ts`, which gates on platform admin). No gate
 * here: every caller must have done its own.
 */

/**
 * Move a monthly subscription onto the annual price, starting today. The rule
 * and why these Stripe arguments are the ones that implement it are on
 * `switchToAnnual` in `actions.ts`.
 */
export async function switchOrgToAnnual(orgId: string): Promise<void> {
  if (!hasStripe()) throw new Error("Billing is not configured.");
  const priceId = getWellsPriceId("year");
  if (!priceId) {
    throw new Error("Annual billing is not configured (STRIPE_PRICE_WELLS_YEARLY).");
  }

  const admin = getSupabaseAdmin();
  const { data: row } = await admin
    .from("subscriptions")
    .select(
      "billing_interval, stripe_subscription_id, stripe_subscription_item_id"
    )
    .eq("org_id", orgId)
    .maybeSingle<{
      billing_interval: string | null;
      stripe_subscription_id: string | null;
      stripe_subscription_item_id: string | null;
    }>();
  if (!row?.stripe_subscription_id) throw new Error("No subscription to change.");
  if (row.billing_interval === "year") {
    throw new Error("You're already billed annually.");
  }

  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
  const itemId = row.stripe_subscription_item_id ?? sub.items.data[0]?.id ?? null;
  if (!itemId) throw new Error("Could not find the subscription's item.");
  const trialing = sub.status === "trialing";

  await stripe.subscriptions.update(row.stripe_subscription_id, {
    items: [{ id: itemId, price: priceId }],
    proration_behavior: trialing ? "none" : "always_invoice",
    ...(trialing ? {} : { billing_cycle_anchor: "now" as const }),
    metadata: { org_id: orgId, interval: "year" },
  });

  const { error } = await admin
    .from("subscriptions")
    .update({ billing_interval: "year", stripe_subscription_item_id: itemId })
    .eq("org_id", orgId);
  if (error) throw new Error(`switchToAnnual: ${error.message}`);

  await admin.rpc("enqueue_notification", {
    p_org: orgId,
    p_type: "billing_payments",
    p_caps: [] as string[],
    p_actor: null,
    p_payload: { event: "switched_to_annual", trialing },
    p_group_key: `interval:${orgId}:year`,
  });
}
