"use server";

import { revalidatePath } from "next/cache";
import { getActiveOrgId } from "@/lib/auth/orgs";
import { requireUser } from "@/lib/auth/session";
import { requireAdmin, userCan } from "@/lib/auth/permissions";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { getStripe } from "@/lib/billing/stripe";
import { wildcatAppUrl } from "@/lib/wildcat-app-url";
import {
  getPaymentMethods,
  type PaymentMethodInfo,
} from "@/lib/billing/payment-methods";
import {
  getAiCreditsPriceId,
  getAiCreditsProductId,
  getWellsPriceId,
  hasStripe,
  hasSupabase,
  isPaidMode,
} from "@/lib/env";
import {
  billableQuantity,
  countBillableWells,
  getBillingBlock,
  type BillingBlock,
  readSubscriptionRow,
} from "@/lib/billing/subscription";
import {
  TIERS,
  UNLIMITED_WELLS,
  bandPriceDeltaUsd,
  bandRateUsd,
  dollarsToTopUpCredits,
  isPerWell,
  isTierKey,
  priceUsdForWells,
  recommendTier,
  tierByKey,
  type BillingInterval,
  type TierKey,
} from "@/lib/billing/tiers";
import { getWellPricing, getWellPricingOrNull } from "@/lib/billing/stripe-pricing";
import {
  addPlatformCredit,
  getPlatformCreditBalance,
  spendPlatformCredit,
} from "@/lib/billing/platform-credit";
import { splitWithCredit } from "@/lib/billing/credit-split";
import { switchOrgToAnnual } from "@/lib/billing/org-billing";

/**
 * Stripe checkout / portal / top-up server actions.
 *
 * Each returns a URL the client redirects to. Subscription state is written by
 * the webhook (see /api/billing/webhook), never here — these only create Stripe
 * sessions. The `org_id` travels in session/subscription/customer metadata so
 * the webhook can map events back to an org.
 */

interface OrgContext {
  orgId: string;
  name: string | null;
  email: string | null;
  stripeCustomerId: string | null;
}

/**
 * Free trial on signup, for everyone. Referred orgs used to get 60 days; the
 * referral reward is now platform credit paid to BOTH sides at conversion
 * instead (see docs/plans/referral-platform-credit.md), so there is one trial
 * length and no branch.
 */
const TRIAL_DAYS = 30;

/** The org's Stripe subscription id, or null when it has never subscribed. */
async function currentSubscriptionId(orgId: string): Promise<string | null> {
  const sb = await getSupabaseServer();
  const { data } = await sb
    .from("subscriptions")
    .select("stripe_subscription_id")
    .eq("org_id", orgId)
    .maybeSingle<{ stripe_subscription_id: string | null }>();
  return data?.stripe_subscription_id ?? null;
}

/** Resolve the signed-in user's org + its Stripe customer (if any). */
async function loadOrgContext(): Promise<OrgContext> {
  const user = await requireUser();
  const sb = await getSupabaseServer();

  const { data: orgId, error: orgErr } = await sb.rpc("current_org_id");
  if (orgErr || !orgId) throw new Error("No organization for the current user.");

  const { data: org } = await sb
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle<{ name: string | null }>();

  const { data: sub } = await sb
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("org_id", orgId)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  return {
    orgId: orgId as string,
    name: org?.name ?? null,
    email: user.email ?? null,
    stripeCustomerId: sub?.stripe_customer_id ?? null,
  };
}

/** Reuse the org's Stripe customer, or create one and persist its id. */
async function ensureCustomer(ctx: OrgContext): Promise<string> {
  if (ctx.stripeCustomerId) return ctx.stripeCustomerId;
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: ctx.email ?? undefined,
    name: ctx.name ?? undefined,
    metadata: { org_id: ctx.orgId },
  });
  // Persist via admin (service role) so it survives regardless of RLS writes.
  await getSupabaseAdmin()
    .from("subscriptions")
    .upsert(
      { org_id: ctx.orgId, stripe_customer_id: customer.id },
      { onConflict: "org_id" }
    );
  return customer.id;
}


/**
 * Start a subscription on the single tiered Price and return the client secret
 * for collecting a card in-app with a card-only Stripe Elements form (no Checkout,
 * no Link/bank). The item `quantity` is the org's billable well count clamped
 * into the selected band, so the tiered (volume) price bills that band's amount.
 *
 * Created with `payment_behavior: "default_incomplete"` so the subscription begins
 * in `trialing` immediately (every org gets the same `TRIAL_DAYS` free trial)
 * with a `pending_setup_intent` we confirm client-side via `confirmCardSetup`.
 * The SELECTED band (tier/well cap/credits) is persisted here (service role) so the
 * webhook — which no longer derives the band — preserves it. Access itself is
 * provisioned by the `customer.subscription.created` webhook.
 */
export async function createSubscription(
  tierKey: TierKey,
  interval: BillingInterval = "month"
): Promise<{ clientSecret: string }> {
  await requireAdmin();
  if (!hasStripe()) throw new Error("Billing is not configured.");
  if (!isTierKey(tierKey)) throw new Error("Unknown tier.");
  if (interval !== "month" && interval !== "year") {
    throw new Error("Unknown billing interval.");
  }
  const priceId = getWellsPriceId(interval);
  if (!priceId) {
    throw new Error(
      interval === "year"
        ? "Annual billing is not configured (STRIPE_PRICE_WELLS_YEARLY)."
        : "Missing Stripe price (STRIPE_PRICE_WELLS)."
    );
  }
  const tier = tierByKey(tierKey);

  const ctx = await loadOrgContext();
  const customerId = await ensureCustomer(ctx);
  // The band the operator picked decides the amount, so the quantity is clamped
  // into it (`billableQuantity`) rather than sent raw: a tier-2 signup with 10
  // wells must bill tier 2 from the first invoice, not bill tier 1 and then get
  // silently corrected by the first `syncWellQuantity`.
  const quantity = billableQuantity(
    await countBillableWells(getSupabaseAdmin(), ctx.orgId),
    tier.key
  );

  const stripe = getStripe();
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId, quantity }],
    trial_period_days: TRIAL_DAYS,
    payment_behavior: "default_incomplete",
    payment_settings: {
      save_default_payment_method: "on_subscription",
      payment_method_types: ["card"],
    },
    trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    metadata: { org_id: ctx.orgId, tier: tier.key, interval },
    expand: ["pending_setup_intent"],
  });

  // Persist the selected band + the item id/quantity (service role). The webhook
  // only syncs status/period/quantity, so the band written here is authoritative.
  // The Stripe subscription already exists at this point, so a failed write here
  // would orphan it (row left with no stripe_subscription_id) — surface it loudly
  // rather than returning a client secret over a half-written row.
  const { error: persistError } = await getSupabaseAdmin()
    .from("subscriptions")
    .upsert(
      {
        org_id: ctx.orgId,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,
        stripe_subscription_item_id: sub.items.data[0]?.id ?? null,
        tier: tier.key,
        billing_interval: interval,
        well_cap: tier.wellCap,
        monthly_credits: tier.monthlyCredits,
        well_quantity: quantity,
      },
      { onConflict: "org_id" }
    );
  if (persistError) {
    throw new Error(`createSubscription: failed to persist subscription: ${persistError.message}`);
  }

  const psi = sub.pending_setup_intent;
  const clientSecret =
    psi && typeof psi !== "string" ? psi.client_secret : null;
  if (!clientSecret) {
    throw new Error("Stripe did not return a setup client secret.");
  }
  return { clientSecret };
}

/**
 * Move the org up to a higher band, raising its well cap so more wells can be
 * added — the explicit "approve the upgrade" step for tiers 1–3. There is no
 * Stripe price swap (one tiered price); the higher charge follows once wells
 * cross the new band via `syncWellQuantity`. Only the stored band/cap/credits
 * change. Refuses anything that isn't strictly higher than the current band.
 */
export async function upgradeBand(tierKey: TierKey): Promise<{ ok: true }> {
  await requireAdmin();
  if (!isTierKey(tierKey)) throw new Error("Unknown tier.");
  const next = tierByKey(tierKey);

  const ctx = await loadOrgContext();
  const sb = await getSupabaseServer();
  const { data: row } = await sb
    .from("subscriptions")
    .select("tier")
    .eq("org_id", ctx.orgId)
    .maybeSingle<{ tier: string }>();
  const current = tierByKey(row?.tier);
  if (next.minWells <= current.minWells) {
    throw new Error("Choose a higher plan than your current one.");
  }

  await getSupabaseAdmin()
    .from("subscriptions")
    .update({
      tier: next.key,
      well_cap: next.wellCap,
      monthly_credits: next.monthlyCredits,
    })
    .eq("org_id", ctx.orgId);

  // Keep the metadata hint current (reference only; the webhook doesn't read it).
  const subId = await currentSubscriptionId(ctx.orgId);
  if (subId && hasStripe()) {
    await getStripe().subscriptions.update(subId, {
      metadata: { org_id: ctx.orgId, tier: next.key },
    });
  }

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * What a well the org cannot yet afford would cost, for the confirm modal.
 *
 * A tier change is never automatic (docs/plans/billing-test-suite.md §The rule):
 * an action that would push the org past its band's cap is refused, this states
 * what saying yes costs, and the confirm is the assent. Null means the action is
 * inside the band the org already bought, which is the normal case, so the
 * caller just proceeds.
 *
 * Readable by anyone, because everyone can be REFUSED. `canUpgrade` is what
 * decides whether they see a confirm button or are told to ask an admin.
 */
export interface TierUpgradePrompt {
  from: TierKey;
  to: TierKey;
  /** Billable wells now. */
  wells: number;
  /** Billable wells the action would leave them with. */
  newWells: number;
  fromUsd: number;
  toUsd: number;
  deltaUsd: number;
  interval: BillingInterval;
  /** True when the new band bills per well (tier 4), which reads differently. */
  perWell: boolean;
  /** Whether THIS caller may confirm it. */
  canUpgrade: boolean;
}

/**
 * The prompt for adding `adding` billable wells, or null when they fit.
 *
 * Deliberately not admin-gated and deliberately cheap: it runs before every
 * well create, and it short-circuits on the cap before counting anything when
 * billing is off or the org is on the open-ended band.
 */
export async function getWellCapacityPrompt(
  adding = 1
): Promise<TierUpgradePrompt | null> {
  if (!isPaidMode() || !hasSupabase()) return null;
  const count = Math.max(1, Math.floor(adding) || 1);
  try {
    const sb = await getSupabaseServer();
    const { data: row } = await sb
      .from("subscriptions")
      .select("tier, well_cap, billing_interval")
      .maybeSingle<{
        tier: string | null;
        well_cap: number | null;
        billing_interval: string | null;
      }>();
    // No plan yet (onboarding) or the open-ended top band: nothing to refuse.
    if (!row) return null;
    const cap = Number(row.well_cap ?? 0);
    if (cap <= 0 || cap >= UNLIMITED_WELLS) return null;

    const wells = await countBillableWells(sb);
    const newWells = wells + count;
    if (newWells <= cap) return null;

    const from = tierByKey(row.tier);
    const to = recommendTier(newWells);
    // Already at the top of what bands offer, or the count went backwards:
    // nothing to sell them, so let the server-side cap speak for itself.
    if (to.minWells <= from.minWells) return null;

    const interval: BillingInterval =
      row.billing_interval === "year" ? "year" : "month";
    const pricing = await getWellPricing();
    const fromUsd = priceUsdForWells(wells, interval, pricing);
    const toUsd = priceUsdForWells(newWells, interval, pricing);
    return {
      from: from.key,
      to: to.key,
      wells,
      newWells,
      fromUsd,
      toUsd,
      deltaUsd: toUsd - fromUsd,
      interval,
      perWell: isPerWell(to),
      canUpgrade: await userCan("admin"),
    };
  } catch (err) {
    // A prompt we could not price must not block the attempt: the server-side
    // cap (`assertWellCapacity`) is the enforcement, and it still refuses.
    console.error(
      "getWellCapacityPrompt failed",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Accept the band the confirm modal quoted, for `adding` more wells.
 *
 * Takes a COUNT, never a band: the band is re-derived here from the org's own
 * well count, so a crafted request cannot buy a cheaper band than the one it was
 * shown, or a more expensive one for somebody else's fleet. Refuses when the
 * wells now fit, which is what makes a double-submit harmless.
 */
export async function confirmWellCapacityUpgrade(
  adding = 1
): Promise<{ ok: true; tier: TierKey }> {
  await requireAdmin();
  const prompt = await getWellCapacityPrompt(adding);
  if (!prompt) throw new Error("Your plan already covers these wells.");
  await upgradeBand(prompt.to);
  revalidatePath("/wells");
  return { ok: true, tier: prompt.to };
}

/** What the band-change prompt is offering, priced for the button. */
export interface PendingBandChange {
  from: TierKey;
  to: TierKey;
  direction: "up" | "down";
  /** Wells on the platform now — what put them in the new band. */
  wells: number;
  /** Change per billing period in USD; positive on an upgrade. */
  deltaUsd: number;
  interval: BillingInterval;
}

/**
 * Apply the band the org's wells now land in — the one click behind both
 * buttons (`docs/plans/annual-pricing.md` §4).
 *
 * ONE ACTION FOR BOTH DIRECTIONS, because it is one decision: the well count
 * moved, and the subscription follows it. What differs is the money, and only
 * the money:
 *
 *  - UP: `always_invoice`, so the difference is charged when they click. On an
 *    annual plan Stripe prorates it over the term left, which is the whole
 *    reason the prompt states an amount rather than "your bill will change".
 *  - DOWN: `none` — no credit for the period they already bought, the lower
 *    amount simply lands on the next invoice. Same rule removals have always
 *    followed.
 *
 * The band is taken from the org's OWN well count, never from the caller: the
 * button posts no amount, so a crafted request cannot buy tier 1 while holding
 * 500 wells. `pending_band` is cleared here, which is what dismisses the prompt.
 */
export async function applyBandChange(): Promise<{ ok: true; tier: TierKey }> {
  await requireAdmin();
  const ctx = await loadOrgContext();
  const admin = getSupabaseAdmin();

  const { data: row } = await admin
    .from("subscriptions")
    .select(
      "tier, billing_interval, well_quantity, stripe_subscription_id, stripe_subscription_item_id"
    )
    .eq("org_id", ctx.orgId)
    .maybeSingle<{
      tier: string | null;
      billing_interval: string | null;
      well_quantity: number | null;
      stripe_subscription_id: string | null;
      stripe_subscription_item_id: string | null;
    }>();
  if (!row) throw new Error("No subscription to change.");

  const current = tierByKey(row.tier);
  const wells = await countBillableWells(getSupabaseAdmin(), ctx.orgId);
  const next = recommendTier(wells);
  if (next.key === current.key) {
    // Someone else applied it, or wells moved back. Clear the stale prompt
    // rather than charging for a change that is no longer real.
    await admin
      .from("subscriptions")
      .update({ pending_band: null })
      .eq("org_id", ctx.orgId);
    revalidatePath("/settings");
    return { ok: true, tier: current.key };
  }

  const up = next.minWells > current.minWells;
  const quantity = billableQuantity(wells, next.key);

  if (row.stripe_subscription_id && hasStripe()) {
    const stripe = getStripe();
    let itemId = row.stripe_subscription_item_id;
    if (!itemId) {
      const s = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      itemId = s.items.data[0]?.id ?? null;
    }
    if (itemId) {
      await stripe.subscriptions.update(row.stripe_subscription_id, {
        items: [{ id: itemId, quantity }],
        // The click is the consent: an upgrade invoices now, a downgrade waits.
        proration_behavior: up ? "always_invoice" : "none",
        metadata: { org_id: ctx.orgId, tier: next.key },
      });
    }
  }

  const { error } = await admin
    .from("subscriptions")
    .update({
      tier: next.key,
      well_cap: next.wellCap,
      monthly_credits: next.monthlyCredits,
      well_quantity: quantity,
      pending_band: null,
    })
    .eq("org_id", ctx.orgId);
  if (error) throw new Error(`applyBandChange: ${error.message}`);

  const interval: BillingInterval =
    row.billing_interval === "year" ? "year" : "month";
  // The change is already made: a price we cannot read drops the amount from
  // the notice rather than failing the click after Stripe was updated.
  const pricing = await getWellPricingOrNull();
  await admin.rpc("enqueue_notification", {
    p_org: ctx.orgId,
    p_type: "billing_payments",
    p_caps: [] as string[],
    p_actor: null,
    p_payload: {
      event: up ? "band_upgraded" : "band_downgraded",
      from: current.key,
      to: next.key,
      wells,
      delta_usd: pricing
        ? Math.abs(bandPriceDeltaUsd(row.well_quantity ?? wells, wells, interval, pricing))
        : null,
      interval,
    },
    p_group_key: `band-applied:${ctx.orgId}:${next.key}`,
  });

  revalidatePath("/settings");
  revalidatePath("/wells");
  return { ok: true, tier: next.key };
}

/**
 * The band change waiting for a click, or null when none is.
 *
 * Priced HERE rather than in the component so the button's number and the
 * invoice Stripe raises come from one place (`priceUsdForWells`).
 */
export async function getPendingBandChange(): Promise<PendingBandChange | null> {
  // Nothing for a reader who cannot act on it: `applyBandChange` is admin-only,
  // so a prompt shown to a pumper is an ad for a button they will be refused.
  /*
   * The admin check and the subscription read run together: the read is
   * RLS-scoped whatever the check decides, and a reader who fails it still
   * gets null. This used to be a five-hop chain on the root layout (admin
   * check -> current_org_id -> organizations -> subscriptions -> subscriptions)
   * that every page's first byte waited on. The row is the one
   * `getBillingBlock` already reads in the same request, and the org id is
   * the memoized active org, not another `current_org_id` round trip.
   */
  const [isAdmin, read, orgId] = await Promise.all([
    requireAdmin().then(
      () => true,
      () => false
    ),
    readSubscriptionRow(),
    getActiveOrgId(),
  ]);
  if (!isAdmin || !read.ok || !read.data?.pending_band || !orgId) return null;
  const data = read.data;

  const from = tierByKey(data.tier);
  const to = tierByKey(data.pending_band);
  if (from.key === to.key) return null;
  // Rendered on every page: an unreadable price hides the prompt, not the page.
  const [wells, pricing] = await Promise.all([
    countBillableWells(getSupabaseAdmin(), orgId),
    getWellPricingOrNull(),
  ]);
  if (!pricing) return null;
  const interval: BillingInterval =
    data.billing_interval === "year" ? "year" : "month";
  const billed = Number(data.well_quantity ?? from.minWells);

  return {
    from: from.key,
    to: to.key,
    direction: to.minWells > from.minWells ? "up" : "down",
    wells,
    deltaUsd: bandPriceDeltaUsd(billed, wells, interval, pricing),
    interval,
  };
}

/**
 * Schedule cancellation at the end of the paid period (the org keeps access until
 * then). The `customer.subscription.updated` webhook mirrors `cancel_at_period_end`.
 */
/**
 * Move a monthly subscription onto the annual price, starting today.
 *
 * THE RULE (docs/plans/billing-test-suite.md §Monthly to annual): the annual
 * term starts the day you switch, and the unused remainder of the current month
 * is credited against the annual invoice, so they pay the annual price minus
 * that credit.
 *
 * Two Stripe arguments do exactly that and nothing else does:
 *  - `billing_cycle_anchor: "now"` restarts the term today. Without it the year
 *    would still be anchored to the old monthly date.
 *  - `proration_behavior: "always_invoice"` turns the unused-month credit and
 *    the annual charge into ONE invoice they settle on the spot. Platform
 *    credit is applied to it by the ordinary `invoice.created` path.
 *
 * DURING A TRIAL, neither applies. There is no unused month to credit, and
 * resetting the anchor would end the trial early — so the price is swapped, the
 * trial is left alone, and the first invoice at trial end is simply the annual
 * one.
 *
 * Quantity is untouched, so the band does not move: this changes the interval,
 * not what they are subscribed to.
 */
export async function switchToAnnual(): Promise<{ ok: true }> {
  await requireAdmin();
  const ctx = await loadOrgContext();
  await switchOrgToAnnual(ctx.orgId);
  revalidatePath("/settings");
  return { ok: true };
}

export async function cancelSubscription(): Promise<{ ok: true }> {
  await requireAdmin();
  if (!hasStripe()) throw new Error("Billing is not configured.");
  const ctx = await loadOrgContext();
  const subId = await currentSubscriptionId(ctx.orgId);
  if (!subId) throw new Error("No active subscription to cancel.");
  await getStripe().subscriptions.update(subId, { cancel_at_period_end: true });
  return { ok: true };
}

/** Undo a scheduled cancellation, keeping the subscription active. */
export async function resumeSubscription(): Promise<{ ok: true }> {
  await requireAdmin();
  if (!hasStripe()) throw new Error("Billing is not configured.");
  const ctx = await loadOrgContext();
  const subId = await currentSubscriptionId(ctx.orgId);
  if (!subId) throw new Error("No subscription to resume.");
  await getStripe().subscriptions.update(subId, { cancel_at_period_end: false });
  return { ok: true };
}

/** Open the Stripe customer portal for self-serve plan/payment management. */
export async function startCustomerPortal(): Promise<{ url: string }> {
  await requireAdmin();
  if (!hasStripe()) throw new Error("Billing is not configured.");
  const ctx = await loadOrgContext();
  const customerId = await ensureCustomer(ctx);

  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: wildcatAppUrl("/settings?section=billing"),
  });
  return { url: session.url };
}

/**
 * Re-read the whole-app billing block. Called by the blocking modal when the
 * user returns from the Stripe portal (window refocus) or hits "refresh", so the
 * lock clears once the webhook has flipped the subscription back to active. No
 * admin gate: any member may re-check their own org's status.
 */
export async function recheckBillingBlock(): Promise<BillingBlock> {
  return getBillingBlock();
}

/**
 * Create a SetupIntent to save a card on file, collected in-app with a card-only
 * Stripe Elements form (no Link/wallets — see CardForm). Returns the client
 * secret for the browser's <Elements> + PaymentElement. On success the card is
 * attached to the customer and the `setup_intent.succeeded` webhook marks it the
 * default, so later credit top-ups can charge it off-session.
 *
 * We use a raw SetupIntent rather than a Checkout Session here because embedded
 * Checkout always surfaces Link when it's enabled on the account; Elements lets us
 * restrict the form to cards (`payment_method_types: ["card"]` + wallets off).
 */
export async function createCardSetupIntent(): Promise<{
  clientSecret: string;
}> {
  await requireAdmin();
  if (!hasStripe()) throw new Error("Billing is not connected yet.");
  const ctx = await loadOrgContext();
  const customerId = await ensureCustomer(ctx);

  const stripe = getStripe();
  const intent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
    usage: "off_session",
    metadata: { org_id: ctx.orgId, kind: "save_card" },
  });
  if (!intent.client_secret) {
    throw new Error("Stripe did not return a setup client secret.");
  }
  return { clientSecret: intent.client_secret };
}

/** The org's default card payment method id, or null if none on file. */
async function defaultPaymentMethodId(customerId: string): Promise<string | null> {
  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer.deleted) {
    const def = customer.invoice_settings?.default_payment_method;
    if (def) return typeof def === "string" ? def : def.id;
  }
  const pms = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 1,
  });
  return pms.data[0]?.id ?? null;
}

/** List the org's saved cards for client UIs (e.g. the buy-credits modal). */
export async function listPaymentMethods(): Promise<PaymentMethodInfo[]> {
  return getPaymentMethods();
}

/**
 * Stripe Tax on a top-up subtotal (cents), keyed on the org customer's address.
 * Credits are a SaaS purchase, so the account's default tax code applies. Returns
 * zero tax (and a null calculation) whenever tax can't be computed — no customer
 * address on file, or no active tax registration for the buyer's location — since
 * there is then legally nothing to collect. The `calcId` is committed as a filed
 * tax transaction after the charge succeeds.
 */
async function calcTopUpTax(
  customerId: string,
  subtotalCents: number
): Promise<{ taxCents: number; calcId: string | null }> {
  if (subtotalCents <= 0) return { taxCents: 0, calcId: null };
  try {
    const productId = getAiCreditsProductId();
    const calc = await getStripe().tax.calculations.create({
      currency: "usd",
      customer: customerId,
      line_items: [
        // Priced as the product when there is one, so the quote in the modal is
        // computed off the same tax code the invoice will use. One credit is one
        // cent, so the quantity IS the cents.
        {
          amount: subtotalCents,
          // The product carries the tax code the invoice will use, so the quote
          // and the charge are taxed as the same thing. `quantity` is the credit
          // count (one credit = one cent), which is what the invoice bills.
          ...(productId
            ? { product: productId, quantity: subtotalCents }
            : {}),
          reference: "ai-credits",
          tax_behavior: "exclusive" as const,
        },
      ],
    });
    return { taxCents: calc.tax_amount_exclusive ?? 0, calcId: calc.id ?? null };
  } catch {
    return { taxCents: 0, calcId: null };
  }
}

/**
 * Quote the sales tax on an AI-credit top-up so the buy modal can show
 * Subtotal / Sales tax / Total before the user commits. Read-only: it never
 * creates a Stripe customer (an org with no customer/card yet just sees $0 tax).
 * The charge itself recomputes tax authoritatively at capture time.
 */
export async function estimateTopUpTax(usd: number): Promise<{
  subtotalCents: number;
  /** Cents the org's platform credit will cover. */
  creditCents: number;
  taxCents: number;
  /** What the card will actually be charged. */
  totalCents: number;
}> {
  await requireAdmin();
  const dollars = Math.max(0, Math.round(Number.isFinite(usd) ? usd : 0));
  const subtotalCents = dollars * 100;
  if (!hasStripe() || subtotalCents <= 0) {
    return { subtotalCents, creditCents: 0, taxCents: 0, totalCents: subtotalCents };
  }
  const ctx = await loadOrgContext();
  // Preview only. `chargeTopUp` re-derives the split from what the spend RPC
  // actually spent, so a balance that moves between quote and charge changes
  // the amounts the user sees but can never overspend.
  const balanceCents = await getPlatformCreditBalance();
  const { fromCreditCents, fromCardCents } = splitWithCredit(
    subtotalCents,
    balanceCents
  );
  if (!ctx.stripeCustomerId || fromCardCents <= 0) {
    return {
      subtotalCents,
      creditCents: fromCreditCents,
      taxCents: 0,
      totalCents: fromCardCents,
    };
  }
  // Tax is computed on the card leg only: credit reduces the taxable base.
  const { taxCents } = await calcTopUpTax(ctx.stripeCustomerId, fromCardCents);
  return {
    subtotalCents,
    creditCents: fromCreditCents,
    taxCents,
    totalCents: fromCardCents + taxCents,
  };
}

/**
 * Bill a top-up as a line of the AI-credits product, and take the money now.
 *
 * WHY AN INVOICE. A PaymentIntent cannot carry a Price, so a bare charge shows
 * up in Stripe as an amount and nothing else: no product, no quantity, no
 * revenue line to report on, and a tax code supplied per call instead of by the
 * thing being sold. An invoice can, and `invoices.pay` with a card on file is
 * still synchronous — the customer waits three more API calls, not a redirect.
 *
 * QUANTITY IS CREDITS. The price is one credit at $0.01, so the quantity billed
 * is exactly the number of credits the card is paying for. Platform credit is
 * NOT on the invoice: it is a giveaway, not revenue, so the invoice states the
 * money that changed hands and the ledger grants the full amount.
 *
 * Returns null when this could not be done as an invoice — no price configured,
 * or Stripe refused to finalize (an address it cannot compute tax for is the
 * likely one). The caller then charges the old way rather than failing a sale
 * over bookkeeping.
 */
async function chargeCreditsInvoice(
  stripe: ReturnType<typeof getStripe>,
  input: {
    customerId: string;
    paymentMethod: string;
    /** Credits the CARD is paying for — one cent each, so also the cents. */
    quantity: number;
    orgId: string;
    credits: number;
    fromCreditCents: number;
  }
): Promise<{ invoiceId: string; paid: boolean } | null> {
  const priceId = getAiCreditsPriceId();
  if (!priceId || input.quantity <= 0) return null;

  let invoiceId: string | null = null;
  try {
    // Created before the item so the item can name it: an invoice built from
    // whatever pending items happen to be on the customer is an invoice that can
    // bill something else by accident.
    const invoice = await stripe.invoices.create({
      customer: input.customerId,
      collection_method: "charge_automatically",
      default_payment_method: input.paymentMethod,
      auto_advance: false,
      automatic_tax: { enabled: true },
      description: "AI credits",
      metadata: {
        org_id: input.orgId,
        kind: "topup",
        credits: String(input.credits),
        platform_credit_cents: String(input.fromCreditCents),
      },
    });
    invoiceId = invoice.id ?? null;
    if (!invoiceId) return null;

    await stripe.invoiceItems.create({
      customer: input.customerId,
      invoice: invoiceId,
      // `pricing.price` in the 2025 API — the old top-level `price` is gone.
      pricing: { price: priceId },
      quantity: input.quantity,
    });
    await stripe.invoices.finalizeInvoice(invoiceId);
    const paid = await stripe.invoices.pay(invoiceId, {
      off_session: true,
      payment_method: input.paymentMethod,
    });
    return { invoiceId, paid: paid.status === "paid" };
  } catch (err) {
    // Leave nothing half-finished behind: an open invoice would be emailed and
    // chased by Stripe for money we are about to take another way.
    if (invoiceId) {
      await stripe.invoices.voidInvoice(invoiceId).catch(() => {});
    }
    console.error(
      "chargeCreditsInvoice failed; falling back to a direct charge",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Buy an AI-credit top-up for `usd` dollars by charging a card on file
 * off-session. When `paymentMethodId` is given, that card is charged (after
 * verifying it belongs to the org); otherwise the default card is used. Credits
 * are granted by the webhook on `payment_intent.succeeded`. Returns nothing to
 * redirect to — the charge happens server-side.
 */
export async function chargeTopUp(
  usd: number,
  paymentMethodId?: string
): Promise<{
  ok: true;
  credits: number;
  credited: boolean;
  fromCreditCents: number;
  fromCardCents: number;
}> {
  await requireAdmin();
  if (!hasStripe()) throw new Error("Billing is not connected yet.");
  const amount = Math.round(usd);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Enter a positive amount.");
  }

  const ctx = await loadOrgContext();
  const admin = getSupabaseAdmin();
  const credits = dollarsToTopUpCredits(amount);
  const subtotalCents = amount * 100;

  // Spend platform credit FIRST, and take the split from what the RPC actually
  // spent rather than from a balance we read — only the RPC is authoritative
  // under concurrency (an invoice may be draining the same balance right now).
  const fromCreditCents = await spendPlatformCredit(
    admin,
    ctx.orgId,
    subtotalCents,
    "spend_topup",
    `AI credit top-up ($${amount})`
  );
  const fromCardCents = subtotalCents - fromCreditCents;

  // Fully covered by credit: no customer, no card, no PaymentIntent, and no
  // tax — the taxable base is zero once the credit is applied.
  if (fromCardCents <= 0) {
    const credited = await grantTopUpCredits(admin, ctx.orgId, credits, {
      platform_credit_cents: fromCreditCents,
    });
    return { ok: true, credits, credited, fromCreditCents, fromCardCents: 0 };
  }

  let customerId: string;
  let paymentMethod: string | null;
  const stripe = getStripe();
  try {
    customerId = await ensureCustomer(ctx);
    paymentMethod = paymentMethodId ?? null;
    if (paymentMethod) {
      // Verify the chosen card belongs to this org's customer before charging.
      const pm = await stripe.paymentMethods.retrieve(paymentMethod);
      const owner =
        typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
      if (owner !== customerId) {
        throw new Error(
          "That payment method does not belong to your organization."
        );
      }
    } else {
      paymentMethod = await defaultPaymentMethodId(customerId);
    }
    if (!paymentMethod) {
      throw new Error("No card on file. Add a payment method on the Billing tab.");
    }
  } catch (err) {
    // Nothing was charged, so the credit we just spent must go back.
    await refundTopUpCredit(admin, ctx.orgId, fromCreditCents);
    throw err;
  }

  // Preferred path: bill the AI-credits product, `quantity = credits`, with
  // Stripe Tax on the invoice. Falls through to the direct charge below when it
  // is not configured or Stripe would not finalize it.
  const invoiced = await chargeCreditsInvoice(stripe, {
    customerId,
    paymentMethod,
    quantity: fromCardCents,
    orgId: ctx.orgId,
    credits,
    fromCreditCents,
  });
  if (invoiced) {
    if (!invoiced.paid) {
      // Finalized but not paid — the card was declined, or the charge needs the
      // cardholder present. Same outcome as a declined PaymentIntent: give the
      // platform credit back and say so.
      await stripe.invoices.voidInvoice(invoiced.invoiceId).catch(() => {});
      await refundTopUpCredit(admin, ctx.orgId, fromCreditCents);
      throw new Error(
        "We couldn't charge your card on file. Update your payment method on the Billing tab."
      );
    }
    // Keyed on the INVOICE, which is this path's payment object: the
    // `invoice.paid` webhook keys on the same id, so the two cannot double-credit.
    const credited = await grantTopUpCredits(admin, ctx.orgId, credits, {
      invoice: invoiced.invoiceId,
      platform_credit_cents: fromCreditCents,
    });
    return { ok: true, credits, credited, fromCreditCents, fromCardCents };
  }

  // Sales tax rides on top of the card leg only: platform credit reduces the
  // taxable base, so a fully credited top-up owes no tax at all. Credits granted
  // are always based on the pre-tax dollars (tax is not spendable credit).
  const { taxCents, calcId } = await calcTopUpTax(customerId, fromCardCents);

  let pi: import("stripe").Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create({
      amount: fromCardCents + taxCents,
      currency: "usd",
      customer: customerId,
      payment_method: paymentMethod,
      off_session: true,
      confirm: true,
      metadata: {
        org_id: ctx.orgId,
        kind: "topup",
        credits: String(credits),
        tax_cents: String(taxCents),
        platform_credit_cents: String(fromCreditCents),
      },
    });
  } catch {
    // The card declined, so the platform credit we already spent must go back —
    // otherwise a failed purchase silently eats the balance.
    await refundTopUpCredit(admin, ctx.orgId, fromCreditCents);
    throw new Error(
      "We couldn't charge your card on file. Update your payment method on the Billing tab."
    );
  }

  // Commit the tax to a filed Stripe Tax transaction (only when tax was actually
  // charged). Best-effort: the charge already went through, so a recording hiccup
  // is logged, not surfaced.
  if (pi.status === "succeeded" && calcId && taxCents > 0) {
    try {
      await stripe.tax.transactions.createFromCalculation({
        calculation: calcId,
        reference: pi.id,
      });
    } catch (err) {
      console.error(
        "chargeTopUp: tax transaction record failed",
        err instanceof Error ? err.message : err
      );
    }
  }

  // The charge is confirmed synchronously here (off_session + confirm), so credit
  // the balance immediately instead of waiting on the payment_intent.succeeded
  // webhook — which can lag or, if the endpoint's signing secret drifts, never
  // arrive. The webhook stays as an idempotent backstop (it skips a PaymentIntent
  // already in the ledger), so this never double-credits. `p_meta.payment_intent`
  // is the idempotency key both paths key on.
  let credited = false;
  if (pi.status === "succeeded") {
    credited = await grantTopUpCredits(admin, ctx.orgId, credits, {
      payment_intent: pi.id,
      platform_credit_cents: fromCreditCents,
    });
  }
  return { ok: true, credits, credited, fromCreditCents, fromCardCents };
}

/**
 * Grant the AI credits for a completed top-up. Shared by the card path and the
 * fully-credit-funded path so both write the same ledger shape.
 *
 * A failure here is logged, not thrown: the money is already gone (card charged
 * or platform credit spent), so erroring back at the user would be worse than
 * letting the `payment_intent.succeeded` webhook backstop settle it. The
 * credit-funded path has no such backstop, which is why its meta carries the
 * cents spent instead of a PaymentIntent id.
 */
async function grantTopUpCredits(
  admin: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  credits: number,
  meta: Record<string, unknown>
): Promise<boolean> {
  const { error } = await admin.rpc("billing_add_paid", {
    p_org: orgId,
    p_amount: credits,
    p_reason: "top-up",
    p_meta: meta,
  });
  if (error) {
    console.error("chargeTopUp: billing_add_paid failed", error.message);
    return false;
  }
  return true;
}

/** Put back platform credit spent on a top-up that never completed. */
async function refundTopUpCredit(
  admin: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  cents: number
): Promise<void> {
  if (cents <= 0) return;
  await addPlatformCredit(
    admin,
    orgId,
    cents,
    "reverse_topup",
    "Top-up did not complete"
  );
}

/** Verify a payment method belongs to the caller's org, returning the Stripe client. */
async function assertOwnsPaymentMethod(paymentMethodId: string) {
  await requireAdmin();
  if (!hasStripe()) throw new Error("Billing is not connected yet.");
  const ctx = await loadOrgContext();
  if (!ctx.stripeCustomerId) throw new Error("No customer on file.");
  const stripe = getStripe();
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  const owner = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
  if (owner !== ctx.stripeCustomerId) {
    throw new Error("That payment method does not belong to your organization.");
  }
  return { stripe, customerId: ctx.stripeCustomerId };
}

/** Make a saved card the default for the subscription and off-session top-ups. */
export async function setDefaultPaymentMethod(
  paymentMethodId: string
): Promise<{ ok: true }> {
  const { stripe, customerId } = await assertOwnsPaymentMethod(paymentMethodId);
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  return { ok: true };
}

/** Update the editable details of a saved card (name + expiry). */
export async function updatePaymentMethod(
  paymentMethodId: string,
  details: { name?: string; expMonth?: number; expYear?: number }
): Promise<{ ok: true }> {
  const { stripe } = await assertOwnsPaymentMethod(paymentMethodId);
  await stripe.paymentMethods.update(paymentMethodId, {
    ...(details.name !== undefined
      ? { billing_details: { name: details.name } }
      : {}),
    ...(details.expMonth && details.expYear
      ? { card: { exp_month: details.expMonth, exp_year: details.expYear } }
      : {}),
  });
  return { ok: true };
}

/** Remove (detach) a saved card from the org's customer. */
export async function removePaymentMethod(
  paymentMethodId: string
): Promise<{ ok: true }> {
  const { stripe } = await assertOwnsPaymentMethod(paymentMethodId);
  await stripe.paymentMethods.detach(paymentMethodId);
  return { ok: true };
}

/**
 * All bands for the UI (tier 4 is per-well, not contact-sales), each priced
 * from the Stripe monthly price. Prices are null when Stripe cannot be read.
 */
export async function listTiers() {
  const pricing = await getWellPricingOrNull();
  return TIERS.map((t) => {
    const rate = pricing ? bandRateUsd(t, pricing) : null;
    return {
      key: t.key,
      label: t.label,
      monthlyUsd: rate?.flatUsd ?? null,
      perWellUsd: rate?.perWellUsd ?? null,
      wellCap: t.wellCap,
      monthlyCredits: t.monthlyCredits,
      perWell: isPerWell(t),
    };
  });
}
