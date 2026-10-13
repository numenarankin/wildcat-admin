import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { countBillableWells } from "@/lib/billing/subscription";
import { customerRow, type CustomerRow } from "@/lib/admin/customer-rows";
import { listRecurringSubscriptions } from "@/lib/admin/stripe-subscriptions";
import { hasStripe } from "@/lib/env";

/**
 * Every CUSTOMER org, for the people running Wildcat. Orgs labelled demo or
 * test in /admin/settings > Users (`organizations.account_type`) are left
 * out, so the dashboard's figures are the business and nothing else.
 *
 * Reads with the SERVICE ROLE: a platform admin is not a member of these orgs,
 * so RLS as the signed-in user would return nothing. That is why this module
 * does its own gate first and throws for anyone off `platform_admins`; the
 * page's `requirePlatformAdmin()` is the 404, this is the boundary the data
 * path enforces on its own (CLAUDE.md: every service-role path checks).
 */
export async function listCustomers(): Promise<CustomerRow[]> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  const admin = getSupabaseAdmin();

  const [orgs, subs, users, stripeSubs] = await Promise.all([
    admin
      .from("organizations")
      .select("id, name, owner_uid, created_at, referred_by_org, onboarding_completed_at")
      .eq("account_type", "customer")
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error) throw new Error(`organizations: ${error.message}`);
        return (data ?? []) as { id: string; name: string; owner_uid: string; created_at: string; referred_by_org: string | null; onboarding_completed_at: string | null }[];
      }),
    admin
      .from("subscriptions")
      .select("org_id, status, billing_interval, well_quantity, stripe_subscription_id")
      .then(({ data, error }) => {
        if (error) throw new Error(`subscriptions: ${error.message}`);
        return (data ?? []) as {
          org_id: string;
          status: string;
          billing_interval: string | null;
          well_quantity: number;
          stripe_subscription_id: string | null;
        }[];
      }),
    // Owner emails live in auth, which PostgREST does not expose; one listing
    // instead of a lookup per org.
    admin.auth.admin.listUsers({ perPage: 1000 }).then(({ data, error }) => {
      if (error) throw new Error(`auth users: ${error.message}`);
      return new Map(data.users.map((u) => [u.id, u.email ?? null]));
    }),
    // Revenue is what Stripe bills, read from the same subscription list the
    // ARR series is built from, so a customer's row and ARR cannot disagree.
    hasStripe() ? listRecurringSubscriptions(new Set()) : Promise.resolve([]),
  ]);
  // Paused: still a customer, but paying nothing, as ARR has it.
  const pausedNow = new Set(
    stripeSubs.filter((s) => (s.pauses ?? []).some((p) => p.to === null)).map((s) => s.id)
  );
  const liveAnnualUsd = new Map(
    stripeSubs
      .filter((s) => s.endedAt === null && !pausedNow.has(s.id))
      .map((s) => [s.id, s.annualUsd])
  );

  const subByOrg = new Map(subs.map((s) => [s.org_id, s]));
  // A referral is an org that signed up on another's code (`referred_by_org`).
  const referralsOf = new Map<string, number>();
  for (const o of orgs) {
    if (o.referred_by_org) referralsOf.set(o.referred_by_org, (referralsOf.get(o.referred_by_org) ?? 0) + 1);
  }
  const wellCounts = await Promise.all(orgs.map((o) => countBillableWells(admin, o.id)));

  return orgs.map((o, i) => {
    const s = subByOrg.get(o.id);
    return customerRow({
      orgId: o.id,
      name: o.name,
      ownerEmail: users.get(o.owner_uid) ?? null,
      createdAt: o.created_at,
      onboardingCompletedAt: o.onboarding_completed_at,
      subscription: s
        ? {
            status: s.status,
            billingInterval: s.billing_interval,
            wellQuantity: s.well_quantity,
            stripeSubscriptionId: s.stripe_subscription_id,
            stripeAnnualUsd: s.stripe_subscription_id
              ? liveAnnualUsd.get(s.stripe_subscription_id) ?? null
              : null,
            pausedNow: s.stripe_subscription_id ? pausedNow.has(s.stripe_subscription_id) : false,
          }
        : null,
      activeWells: wellCounts[i],
      referrals: referralsOf.get(o.id) ?? 0,
      referredByOrg: o.referred_by_org,
    });
  });
}

/**
 * The Stripe subscription ids held by orgs that are NOT customers (demo,
 * test), so the ARR history read from Stripe can leave them out the way the
 * table does.
 */
export async function listNonCustomerStripeSubscriptionIds(): Promise<Set<string>> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  const { data, error } = await getSupabaseAdmin()
    .from("subscriptions")
    .select("stripe_subscription_id, organizations!inner(account_type)")
    .neq("organizations.account_type", "customer")
    .not("stripe_subscription_id", "is", null);
  if (error) throw new Error(`subscriptions: ${error.message}`);
  return new Set((data ?? []).map((r) => r.stripe_subscription_id as string));
}
