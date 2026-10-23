"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { getSessionUser } from "@/lib/auth/session";
import { getStripe } from "@/lib/billing/stripe";
import { hasStripe } from "@/lib/env";
import { getWildcatAppUrl, wildcatAppUrl } from "@/lib/wildcat-app-url";
import { countBillableWells } from "@/lib/billing/subscription";
import { billableQuantity, isTierKey, recommendTier, tierByKey } from "@/lib/billing/tiers";
import { addPlatformCredit, deductPlatformCredit } from "@/lib/billing/platform-credit";
import { switchOrgToAnnual } from "@/lib/billing/org-billing";
import { sendResetEmail } from "@/lib/email/reset-email";
import type { ActionResult } from "@/lib/admin/customer-panel-types";

/**
 * Writes behind the admin customer panel. Each one acts on an org named by
 * the caller, so each starts at the platform-admin gate, and each that touches
 * a Stripe or member object first proves the object belongs to that org.
 *
 * Results, not throws: a server function's thrown message is replaced with a
 * generic one in production, and the panel has to say what went wrong.
 *
 * Stripe is the source of truth for subscription state; our row follows it
 * through the webhook (`/api/billing/webhook`), as it does for the customer's
 * own billing actions. The exceptions are the columns the webhook never
 * writes (band, cap, suspension), which are written here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(orgId: string, work: (actorId: string) => Promise<void>): Promise<ActionResult> {
  try {
    if (!(await isPlatformAdmin())) return { ok: false, error: "Platform admin required." };
    if (!UUID.test(orgId)) return { ok: false, error: "Unknown organization." };
    const actor = await getSessionUser();
    await work(actor?.id ?? "");
    revalidatePath("/dashboard");
    revalidatePath("/clients");
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("admin customer action failed", message);
    return { ok: false, error: message };
  }
}

interface SubRow {
  tier: string | null;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  well_quantity: number | null;
}

async function subRow(orgId: string): Promise<SubRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("subscriptions")
    .select("tier, status, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, well_quantity")
    .eq("org_id", orgId)
    .maybeSingle<SubRow>();
  if (error) throw new Error(`subscriptions: ${error.message}`);
  return data;
}

async function stripeSubId(orgId: string): Promise<string> {
  if (!hasStripe()) throw new Error("Billing is not configured.");
  const row = await subRow(orgId);
  if (!row?.stripe_subscription_id) throw new Error("This customer has no Stripe subscription.");
  return row.stripe_subscription_id;
}

// --- Collection and cancellation ----------------------------------------------

/**
 * Stop charging without ending anything: Stripe keeps creating invoices and
 * voids each one, the subscription stays `active`, and the customer keeps
 * access. The halt for a seasonal or struggling operator.
 */
export async function pauseCollection(orgId: string): Promise<ActionResult> {
  return run(orgId, async () => {
    await getStripe().subscriptions.update(await stripeSubId(orgId), {
      pause_collection: { behavior: "void" },
    });
  });
}

export async function resumeCollection(orgId: string): Promise<ActionResult> {
  return run(orgId, async () => {
    await getStripe().subscriptions.update(await stripeSubId(orgId), { pause_collection: "" });
  });
}

/** End at the close of the paid period; access continues until then. */
export async function setCancelAtPeriodEnd(orgId: string, cancel: boolean): Promise<ActionResult> {
  return run(orgId, async () => {
    await getStripe().subscriptions.update(await stripeSubId(orgId), { cancel_at_period_end: cancel });
  });
}

/**
 * End now. The `customer.subscription.deleted` webhook does the rest exactly
 * as for any cancellation: status `canceled` (the app locks), platform credit
 * forfeited, referral grant clawed back if unvested, owner notified.
 */
export async function cancelNow(orgId: string): Promise<ActionResult> {
  return run(orgId, async () => {
    await getStripe().subscriptions.cancel(await stripeSubId(orgId));
  });
}

/** Move a trial's end to `endDate` (`YYYY-MM-DD`, end of that day UTC). */
export async function extendTrial(orgId: string, endDate: string): Promise<ActionResult> {
  return run(orgId, async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error("Pick a date.");
    const end = Math.floor(Date.parse(`${endDate}T23:59:59Z`) / 1000);
    if (!Number.isFinite(end) || end * 1000 <= Date.now()) throw new Error("The new trial end must be in the future.");
    const id = await stripeSubId(orgId);
    const sub = await getStripe().subscriptions.retrieve(id);
    if (sub.status !== "trialing") throw new Error("Only a subscription in its trial can have the trial extended.");
    await getStripe().subscriptions.update(id, { trial_end: end, proration_behavior: "none" });
  });
}

// --- Plan ---------------------------------------------------------------------

/**
 * Put the org on a band staff choose, whatever its well count says.
 *
 * The band's cap and monthly credits follow, and the billed quantity is
 * clamped into the band exactly as the customer's own band change does
 * (`billableQuantity`): a 10-well org moved to tier 2 is billed tier 2. An
 * upgrade prorates onto the next invoice, a downgrade waits for it (the
 * within-band rule in `syncWellQuantity`). `pending_band` is recomputed so the
 * customer's prompt reflects the new band.
 */
export async function changeBand(orgId: string, tierKey: string): Promise<ActionResult> {
  return run(orgId, async () => {
    if (!isTierKey(tierKey)) throw new Error("Unknown band.");
    const next = tierByKey(tierKey);
    const row = await subRow(orgId);
    if (!row) throw new Error("This customer has no subscription row.");
    const current = tierByKey(row.tier);
    const admin = getSupabaseAdmin();
    const wells = await countBillableWells(admin, orgId);
    const quantity = billableQuantity(wells, next.key);
    const landsIn = recommendTier(wells).key;

    if (row.stripe_subscription_id && hasStripe()) {
      const stripe = getStripe();
      const itemId =
        row.stripe_subscription_item_id ??
        (await stripe.subscriptions.retrieve(row.stripe_subscription_id)).items.data[0]?.id ??
        null;
      if (!itemId) throw new Error("Could not find the subscription's item.");
      await stripe.subscriptions.update(row.stripe_subscription_id, {
        items: [{ id: itemId, quantity }],
        proration_behavior: next.minWells > current.minWells ? "create_prorations" : "none",
        metadata: { org_id: orgId, tier: next.key },
      });
    }

    const { error } = await admin
      .from("subscriptions")
      .update({
        tier: next.key,
        well_cap: next.wellCap,
        monthly_credits: next.monthlyCredits,
        well_quantity: quantity,
        pending_band: landsIn === next.key ? null : landsIn,
      })
      .eq("org_id", orgId);
    if (error) throw new Error(`subscriptions: ${error.message}`);
  });
}

export async function switchCustomerToAnnual(orgId: string): Promise<ActionResult> {
  return run(orgId, () => switchOrgToAnnual(orgId));
}

/**
 * Override the well cap the band set. It stands until the band next changes
 * (any band change writes the band's own cap).
 */
export async function setWellCap(orgId: string, cap: number): Promise<ActionResult> {
  return run(orgId, async () => {
    if (!Number.isInteger(cap) || cap < 1) throw new Error("The cap must be a whole number of wells, 1 or more.");
    const { data, error } = await getSupabaseAdmin()
      .from("subscriptions")
      .update({ well_cap: cap })
      .eq("org_id", orgId)
      .select("org_id");
    if (error) throw new Error(`subscriptions: ${error.message}`);
    if (!data?.length) throw new Error("This customer has no subscription row.");
  });
}

// --- Discounts, refunds, credit -------------------------------------------------

export type DiscountDuration = "once" | "forever" | "repeating";

/**
 * Replace the subscription's discounts with a new percentage coupon. 100%
 * forever is a free account. The coupon is made for this one customer.
 */
export async function applyDiscount(
  orgId: string,
  percentOff: number,
  duration: DiscountDuration,
  months?: number
): Promise<ActionResult> {
  return run(orgId, async () => {
    if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 100) {
      throw new Error("Percent off must be more than 0 and at most 100.");
    }
    if (!["once", "forever", "repeating"].includes(duration)) throw new Error("Unknown duration.");
    if (duration === "repeating" && (!Number.isInteger(months) || (months ?? 0) < 1)) {
      throw new Error("Give the number of months.");
    }
    const id = await stripeSubId(orgId);
    const stripe = getStripe();
    const coupon = await stripe.coupons.create({
      percent_off: percentOff,
      duration,
      ...(duration === "repeating" ? { duration_in_months: months } : {}),
      metadata: { org_id: orgId, source: "admin_panel" },
    });
    await stripe.subscriptions.update(id, { discounts: [{ coupon: coupon.id }] });
  });
}

export async function removeDiscounts(orgId: string): Promise<ActionResult> {
  return run(orgId, async () => {
    await getStripe().subscriptions.update(await stripeSubId(orgId), { discounts: "" });
  });
}

/**
 * Refund a paid invoice, in full or `amountCents` of it. The invoice must be
 * this org's: its customer is checked against the org's Stripe customer before
 * anything moves.
 */
export async function refundInvoice(
  orgId: string,
  invoiceId: string,
  amountCents?: number
): Promise<ActionResult> {
  return run(orgId, async () => {
    if (!hasStripe()) throw new Error("Billing is not configured.");
    const row = await subRow(orgId);
    if (!row?.stripe_customer_id) throw new Error("This customer has no Stripe account.");
    const stripe = getStripe();
    const invoice = await stripe.invoices.retrieve(invoiceId);
    const customer = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    if (customer !== row.stripe_customer_id) throw new Error("That invoice is not this customer's.");
    if (amountCents !== undefined && (!Number.isInteger(amountCents) || amountCents <= 0)) {
      throw new Error("The refund amount must be more than zero.");
    }
    const payments = await stripe.invoicePayments.list({ invoice: invoiceId, status: "paid" });
    const pi = payments.data[0]?.payment.payment_intent;
    const paymentIntent = typeof pi === "string" ? pi : pi?.id;
    if (!paymentIntent) throw new Error("That invoice has no card payment to refund.");
    await stripe.refunds.create({
      payment_intent: paymentIntent,
      ...(amountCents ? { amount: amountCents } : {}),
      metadata: { org_id: orgId, invoice: invoiceId, source: "admin_panel" },
    });
  });
}

/** Add (positive) or take away (negative) platform credit (USD), spent on the customer's invoices and top-ups. */
export async function adjustPlatformCredit(orgId: string, usd: number, reason: string): Promise<ActionResult> {
  return run(orgId, async (actorId) => {
    const cents = Math.round(usd * 100);
    if (!Number.isFinite(cents) || cents === 0) throw new Error("Give an amount, not zero.");
    if (!reason.trim()) throw new Error("Give a reason; the customer sees it in their credit history.");
    const meta = { source: "admin_panel", by: actorId };
    if (cents > 0) {
      const balance = await addPlatformCredit(getSupabaseAdmin(), orgId, cents, "adjustment", reason.trim(), meta);
      if (balance <= 0) throw new Error("The credit could not be recorded.");
    } else {
      const removed = await deductPlatformCredit(getSupabaseAdmin(), orgId, -cents, reason.trim(), meta);
      if (removed <= 0) throw new Error("That is more than their platform credit balance.");
    }
  });
}

/** Add (positive) or take away (negative) AI credits. */
export async function adjustAiCredits(orgId: string, delta: number, reason: string): Promise<ActionResult> {
  return run(orgId, async (actorId) => {
    if (!Number.isInteger(delta) || delta === 0) throw new Error("Give a whole number of credits, not zero.");
    if (!reason.trim()) throw new Error("Give a reason; it is kept in the credit ledger.");
    const { data, error } = await getSupabaseAdmin().rpc("billing_admin_adjust", {
      p_org: orgId,
      p_delta: delta,
      p_reason: reason.trim(),
      p_meta: { source: "admin_panel", by: actorId },
    });
    if (error) throw new Error(`billing_admin_adjust: ${error.message}`);
    if (!(data as { ok?: boolean } | null)?.ok) throw new Error("The adjustment was refused.");
  });
}

// --- Access -----------------------------------------------------------------------

/**
 * Lock the org out (or let it back in) whatever its billing says. Enforced by
 * the same lockout as a lapsed subscription (`getBillingBlock`, web and phone
 * sync) and by `billing_gate` for AI calls.
 */
export async function setSuspended(orgId: string, suspended: boolean): Promise<ActionResult> {
  return run(orgId, async () => {
    const { data, error } = await getSupabaseAdmin()
      .from("subscriptions")
      .update({ suspended_at: suspended ? new Date().toISOString() : null })
      .eq("org_id", orgId)
      .select("org_id");
    if (error) throw new Error(`subscriptions: ${error.message}`);
    if (!data?.length) {
      throw new Error("This customer has no subscription row, so there is no access to suspend.");
    }
  });
}

/** The member row, proven to be in this org. */
async function memberOf(orgId: string, memberId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("org_members")
    .select("id, is_owner, status, auth_user_id, email")
    .eq("id", memberId)
    .eq("org_id", orgId)
    .maybeSingle<{ id: string; is_owner: boolean; status: string; auth_user_id: string | null; email: string }>();
  if (error) throw new Error(`org_members: ${error.message}`);
  if (!data) throw new Error("That person is not a member of this organization.");
  return data;
}

/**
 * Mail a password-reset link to someone in this org. Same link and mail as
 * the sign-in page's reset (`account-recovery.ts`), but loud: staff need to
 * know whether it went.
 */
export async function sendMemberPasswordReset(orgId: string, authUserId: string): Promise<ActionResult> {
  return run(orgId, async () => {
    const admin = getSupabaseAdmin();
    const [{ data: member }, { data: org }] = await Promise.all([
      admin.from("org_members").select("id").eq("org_id", orgId).eq("auth_user_id", authUserId).maybeSingle(),
      admin.from("organizations").select("owner_uid").eq("id", orgId).maybeSingle<{ owner_uid: string }>(),
    ]);
    if (!member && org?.owner_uid !== authUserId) throw new Error("That person is not in this organization.");
    const { data: user, error: userError } = await admin.auth.admin.getUserById(authUserId);
    if (userError || !user.user?.email) throw new Error("That account has no email address.");
    const { data, error } = await admin.auth.admin.generateLink({
      type: "recovery",
      email: user.user.email,
      // A customer resets in the customer app, not here.
      options: { redirectTo: wildcatAppUrl("/auth/reset") },
    });
    if (error || !data?.properties?.hashed_token) throw new Error(error?.message ?? "No reset link was issued.");
    await sendResetEmail({ email: user.user.email, tokenHash: data.properties.hashed_token, appUrl: getWildcatAppUrl() });
  });
}

/**
 * Offboard or restore a member: the same soft delete as the customer's own
 * Settings (`removeMember` / `restoreMember`), so nothing they entered is
 * touched and restore returns them to the status their row implies.
 */
export async function setMemberRemoved(orgId: string, memberId: string, removed: boolean): Promise<ActionResult> {
  return run(orgId, async (actorId) => {
    const member = await memberOf(orgId, memberId);
    if (member.is_owner) throw new Error("The owner can't be removed.");
    const update = removed
      ? member.status === "removed"
        ? null
        : { status: "removed", removed_at: new Date().toISOString(), removed_by: actorId || null }
      : member.status !== "removed"
        ? null
        : { status: member.auth_user_id ? "active" : "invited", removed_at: null, removed_by: null };
    if (!update) return;
    const { error } = await getSupabaseAdmin().from("org_members").update(update).eq("id", member.id);
    if (error) throw new Error(`org_members: ${error.message}`);
  });
}

