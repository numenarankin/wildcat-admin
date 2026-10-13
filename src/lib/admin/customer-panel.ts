"use server";

import type Stripe from "stripe";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { countBillableWells } from "@/lib/billing/subscription";
import { getStripe } from "@/lib/billing/stripe";
import { hasStripe } from "@/lib/env";
import { getWellPricingOrNull } from "@/lib/billing/stripe-pricing";
import { annualUsdOfSubscription, isPausedNow } from "@/lib/admin/stripe-subscriptions";
import { isAccountType } from "@/lib/admin/accounts";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import { usageWindow } from "@/lib/admin/customer-usage";
import type {
  AiSpendGroup,
  AuthorInputs,
  CustomerBillingData,
  CustomerPanelData,
  DailyInputs,
  FacilityInputs,
  PanelInvoice,
  PanelMember,
  PanelSubscription,
} from "@/lib/admin/customer-panel-types";

/**
 * Reads for the admin customer panel: one org, everything staff need to look
 * at it. Server functions because the panel is a client modal that loads when
 * it opens, from whichever table the name was clicked in.
 *
 * SERVICE ROLE behind the platform-admin check, like `customers.ts`: staff are
 * not members of the org, so RLS as the signed-in user would return nothing.
 * The check is the boundary; it runs first in every export.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function gate(orgId: string): Promise<void> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  if (!UUID.test(orgId)) throw new Error("Unknown organization.");
}

function must<T>(label: string, res: { data: T | null; error: { message: string } | null }): T | null {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  return res.data;
}

interface MemberDbRow {
  id: string;
  name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email: string | null;
  is_owner: boolean;
  permissions: string[] | null;
  status: string;
  auth_user_id: string | null;
  /** Arrives with 2026100100100; read with `*` so the panel works before it. */
  phone_last_seen_at?: string | null;
}

interface InputSummary {
  facilities: FacilityInputs[];
  daily: DailyInputs[];
  members: AuthorInputs[];
}

export async function loadCustomerPanel(orgId: string): Promise<CustomerPanelData> {
  await gate(orgId);
  const admin = getSupabaseAdmin();
  const window = usageWindow(new Date(), ADMIN_TIME_ZONE);

  const [org, sub, credits, referrals, members, billableWells, inputs, creditDaily] =
    await Promise.all([
      admin
        .from("organizations")
        .select("id, name, owner_uid, created_at, onboarding_completed_at, referred_by_org, account_type")
        .eq("id", orgId)
        .maybeSingle<{
          id: string;
          name: string;
          owner_uid: string;
          created_at: string;
          onboarding_completed_at: string | null;
          referred_by_org: string | null;
          account_type: string;
        }>()
        .then((r) => must("organizations", r)),
      // `*`: `suspended_at` arrives with a migration (see SUBSCRIPTION_COLUMNS).
      admin
        .from("subscriptions")
        .select("*")
        .eq("org_id", orgId)
        .maybeSingle<Record<string, unknown>>()
        .then((r) => must("subscriptions", r)),
      admin
        .from("org_credits")
        .select("*")
        .eq("org_id", orgId)
        .maybeSingle<Record<string, unknown>>()
        .then((r) => must("org_credits", r)),
      admin
        .from("organizations")
        .select("id", { count: "exact", head: true })
        .eq("referred_by_org", orgId)
        .then(({ count, error }) => {
          if (error) throw new Error(`referrals: ${error.message}`);
          return count ?? 0;
        }),
      admin
        .from("org_members")
        .select("*")
        .eq("org_id", orgId)
        .order("created_at", { ascending: true })
        .then((r) => (must("org_members", r) ?? []) as MemberDbRow[]),
      countBillableWells(admin, orgId),
      admin
        .rpc("admin_org_input_summary", { p_org: orgId, p_since: window.since, p_recent: window.recent })
        .then((r) => must("admin_org_input_summary", r) as InputSummary | null),
      admin
        .rpc("admin_org_credit_daily", { p_org: orgId, p_since: window.since, p_tz: ADMIN_TIME_ZONE })
        .then((r) => (must("admin_org_credit_daily", r) ?? []) as Record<keyof AiSpendGroup, unknown>[]),
    ]);
  if (!org) throw new Error("No such organization.");

  // The owner's account, and each member's, for email and last sign-in. An
  // owner with no member row (older orgs) is listed from their account.
  const authIds = new Set<string>(members.map((m) => m.auth_user_id).filter((id): id is string => !!id));
  authIds.add(org.owner_uid);
  const [users, devices, referrer] = await Promise.all([
    Promise.all(
      [...authIds].map(async (id) => {
        const { data } = await admin.auth.admin.getUserById(id);
        return [id, data.user ?? null] as const;
      })
    ).then((pairs) => new Map(pairs)),
    admin
      .from("push_devices")
      .select("user_id, platform, device_name, last_seen_at")
      .in("user_id", [...authIds])
      .order("last_seen_at", { ascending: false })
      .then(
        (r) =>
          (must("push_devices", r) ?? []) as {
            user_id: string;
            platform: string;
            device_name: string;
            last_seen_at: string;
          }[]
      ),
    org.referred_by_org
      ? admin
          .from("organizations")
          .select("id, name")
          .eq("id", org.referred_by_org)
          .maybeSingle<{ id: string; name: string }>()
          .then((r) => must("referrer", r))
      : Promise.resolve(null),
  ]);

  const authors = inputs?.members ?? [];
  const byAuthor = new Map(authors.filter((a) => a.userId).map((a) => [a.userId as string, a]));

  const panelMembers: PanelMember[] = members.map((m) => {
    const user = m.auth_user_id ? users.get(m.auth_user_id) : null;
    const authored = m.auth_user_id ? byAuthor.get(m.auth_user_id) : undefined;
    const fullName = [m.first_name, m.last_name].filter(Boolean).join(" ");
    return {
      memberId: m.id,
      authUserId: m.auth_user_id,
      name: m.name || fullName || m.email || "Unnamed",
      email: m.email ?? user?.email ?? null,
      isOwner: m.is_owner || m.auth_user_id === org.owner_uid,
      isAdmin: (m.permissions ?? []).includes("admin"),
      status: m.status === "removed" ? "removed" : m.status === "invited" ? "invited" : "active",
      lastSignInAt: user?.last_sign_in_at ?? null,
      phoneLastSeenAt: m.phone_last_seen_at ?? null,
      devices: devices
        .filter((d) => m.auth_user_id && d.user_id === m.auth_user_id)
        .map((d) => ({ platform: d.platform, name: d.device_name, lastSeenAt: d.last_seen_at })),
      entries: Number(authored?.entries ?? 0),
      lastEntry: authored?.last ?? null,
    };
  });
  if (!members.some((m) => m.auth_user_id === org.owner_uid)) {
    const owner = users.get(org.owner_uid);
    const authored = byAuthor.get(org.owner_uid);
    panelMembers.unshift({
      memberId: null,
      authUserId: org.owner_uid,
      name: owner?.email ?? "Owner",
      email: owner?.email ?? null,
      isOwner: true,
      isAdmin: true,
      status: "active",
      lastSignInAt: owner?.last_sign_in_at ?? null,
      phoneLastSeenAt: null,
      devices: devices
        .filter((d) => d.user_id === org.owner_uid)
        .map((d) => ({ platform: d.platform, name: d.device_name, lastSeenAt: d.last_seen_at })),
      entries: Number(authored?.entries ?? 0),
      lastEntry: authored?.last ?? null,
    });
  }

  return {
    orgId: org.id,
    name: org.name,
    createdAt: org.created_at,
    onboardingCompletedAt: org.onboarding_completed_at,
    accountType: isAccountType(org.account_type) ? org.account_type : "customer",
    ownerEmail: users.get(org.owner_uid)?.email ?? null,
    referredBy: referrer ? { orgId: referrer.id, name: referrer.name } : null,
    referrals,
    subscription: sub ? panelSubscription(sub) : null,
    billableWells,
    credits: {
      freeRemaining: Number(credits?.free_remaining ?? 0),
      paidBalance: Number(credits?.paid_balance ?? 0),
      platformCents: Number(credits?.platform_cents ?? 0),
    },
    window,
    facilities: (inputs?.facilities ?? []).map((f) => ({
      ...f,
      entries: Number(f.entries ?? 0),
      days: Number(f.days ?? 0),
    })),
    daily: (inputs?.daily ?? []).map((d) => ({ ...d, entries: Number(d.entries) })),
    authors: authors.map((a) => ({ ...a, entries: Number(a.entries) })),
    aiSpend: creditDaily.map((g) => ({
      day: String(g.day),
      provider: String(g.provider),
      kind: String(g.kind),
      model: g.model == null ? null : String(g.model),
      credits: Number(g.credits ?? 0),
      calls: Number(g.calls ?? 0),
      costUsd: Number(g.costUsd ?? 0),
      input: Number(g.input ?? 0),
      output: Number(g.output ?? 0),
      cacheRead: Number(g.cacheRead ?? 0),
      cacheWrite: Number(g.cacheWrite ?? 0),
      requests: Number(g.requests ?? 0),
      chars: Number(g.chars ?? 0),
      unpriced: Number(g.unpriced ?? 0),
    })),
    members: panelMembers,
  };
}

function panelSubscription(row: Record<string, unknown>): PanelSubscription {
  const str = (k: string) => (typeof row[k] === "string" ? (row[k] as string) : null);
  return {
    tier: str("tier") ?? "tier_1",
    status: str("status") ?? "unknown",
    interval: row.billing_interval === "year" ? "year" : "month",
    wellCap: Number(row.well_cap ?? 0),
    wellQuantity: Number(row.well_quantity ?? 0),
    monthlyCredits: Number(row.monthly_credits ?? 0),
    pendingBand: str("pending_band"),
    currentPeriodEnd: str("current_period_end"),
    trialEnd: str("trial_end"),
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    suspendedAt: str("suspended_at"),
    stripeCustomerId: str("stripe_customer_id"),
    stripeSubscriptionId: str("stripe_subscription_id"),
  };
}

/** Unix seconds → ISO, or null. */
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);

function couponLabel(coupon: Stripe.Coupon): string {
  const amount =
    coupon.percent_off != null
      ? `${coupon.percent_off}% off`
      : coupon.amount_off != null
        ? `$${(coupon.amount_off / 100).toFixed(2)} off`
        : "Discount";
  const term =
    coupon.duration === "forever"
      ? "forever"
      : coupon.duration === "once"
        ? "once"
        : `for ${coupon.duration_in_months ?? 0} months`;
  return `${amount} ${term}`;
}

/**
 * The org's billing as Stripe has it right now: the subscription's live state
 * (pause, discounts and the rest are not mirrored into our row), the card on
 * file, and recent invoices with what was refunded on each.
 */
export async function loadCustomerBilling(orgId: string): Promise<CustomerBillingData> {
  await gate(orgId);
  const empty: CustomerBillingData = {
    hasStripe: false,
    dashboardUrl: null,
    annualUsd: 0,
    pricing: null,
    subscription: null,
    card: null,
    invoices: [],
  };
  if (!hasStripe()) return empty;
  const pricing = await getWellPricingOrNull();
  empty.pricing = pricing;

  const { data: row, error } = await getSupabaseAdmin()
    .from("subscriptions")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("org_id", orgId)
    .maybeSingle<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>();
  if (error) throw new Error(`subscriptions: ${error.message}`);
  const customerId = row?.stripe_customer_id;
  if (!customerId) return empty;

  const stripe = getStripe();
  const [sub, customer, invoices, charges] = await Promise.all([
    row.stripe_subscription_id
      ? stripe.subscriptions.retrieve(row.stripe_subscription_id, { expand: ["discounts"] })
      : Promise.resolve(null),
    stripe.customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method"] }),
    stripe.invoices.list({ customer: customerId, limit: 24, expand: ["data.payments"] }),
    stripe.charges.list({ customer: customerId, limit: 100 }),
  ]);

  // Refunds sit on the charge, the charge on the payment intent, and the
  // payment intent on the invoice's payments.
  const refundedByIntent = new Map<string, number>();
  for (const c of charges.data) {
    const pi = typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id;
    if (pi) refundedByIntent.set(pi, (refundedByIntent.get(pi) ?? 0) + c.amount_refunded);
  }

  const panelInvoices: PanelInvoice[] = invoices.data.map((inv) => {
    let refunded = 0;
    for (const p of inv.payments?.data ?? []) {
      const pi = p.payment.payment_intent;
      const id = typeof pi === "string" ? pi : pi?.id;
      if (id) refunded += refundedByIntent.get(id) ?? 0;
    }
    return {
      id: inv.id ?? "",
      number: inv.number,
      createdAt: new Date(inv.created * 1000).toISOString(),
      totalCents: inv.total,
      amountPaidCents: inv.amount_paid,
      amountRefundedCents: refunded,
      status: inv.status ?? "draft",
      hostedUrl: inv.hosted_invoice_url ?? null,
      topUp: inv.metadata?.kind === "topup",
    };
  });

  let card: CustomerBillingData["card"] = null;
  if (!customer.deleted) {
    const pm = customer.invoice_settings?.default_payment_method;
    if (pm && typeof pm !== "string" && pm.card) {
      card = {
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
      };
    }
  }

  const live = process.env.STRIPE_SECRET_KEY ?? "";
  const testMode = /^(sk|rk)_test_/.test(live);
  const item = sub?.items.data[0] as unknown as { current_period_end?: number } | undefined;
  // Zero once ended, or paused with a payment skipped: the Clients table's rule.
  const pausedNow = sub ? isPausedNow(sub) : false;
  const annualUsd = sub && !sub.ended_at && !pausedNow ? await annualUsdOfSubscription(sub) : 0;

  return {
    hasStripe: true,
    dashboardUrl: `https://dashboard.stripe.com/${testMode ? "test/" : ""}customers/${customerId}`,
    annualUsd,
    pricing,
    subscription: sub
      ? {
          id: sub.id,
          status: sub.status,
          paused: sub.pause_collection != null,
          pausedNow,
          pausedUntil: iso(sub.pause_collection?.resumes_at),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          currentPeriodEnd: iso(item?.current_period_end),
          trialEnd: iso(sub.trial_end),
          discounts: (sub.discounts ?? [])
            .filter((d): d is Stripe.Discount => typeof d !== "string")
            .map((d) => {
              const coupon = d.source?.coupon;
              return {
                id: d.id,
                label: coupon && typeof coupon !== "string" ? couponLabel(coupon) : "Discount",
              };
            }),
        }
      : null,
    card,
    invoices: panelInvoices,
  };
}
