import "server-only";
import { memoScope } from "@/lib/cache/request-cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServer, getSupabaseAdmin } from "@/lib/supabase/server";
import { hasSupabase, hasStripe, isPaidMode } from "@/lib/env";
import { getStripe } from "@/lib/billing/stripe";
import { getWellPricingOrNull } from "@/lib/billing/stripe-pricing";
import {
  billableQuantity,
  tierByKey,
  priceUsdForWells,
  recommendTier,
  UNLIMITED_WELLS,
  type BillingInterval,
  type TierKey,
} from "@/lib/billing/tiers";

/** The current org's subscription, as the UI and guards need it. */
export interface OrgSubscription {
  tier: TierKey;
  status: string;
  /** Selected band's well cap (enforced on tiers 1–3; unlimited on tier 4). */
  wellCap: number;
  /** Wells currently billed (the tiered-price quantity). */
  wellQuantity: number;
  monthlyCredits: number;
  /** Which Stripe Price this org bills on — monthly, or annual (2 months free). */
  interval: BillingInterval;
  /**
   * What one billing period costs at the current quantity, on that interval,
   * from the Stripe price. Null when Stripe could not be read.
   */
  periodUsd: number | null;
  /**
   * The band the org's well count now lands in, when it differs from the band
   * they are subscribed to — the state behind the one-click prompt. Null when
   * the two agree, which is the normal state.
   */
  pendingBand: TierKey | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasStripe: boolean;
}

interface SubscriptionRow {
  tier: string;
  status: string;
  billing_interval: string | null;
  pending_band: string | null;
  well_cap: number;
  well_quantity: number;
  monthly_credits: number;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  stripe_subscription_id: string | null;
  /**
   * Set when Wildcat staff have suspended the org from the admin side
   * (`2026100100100_admin_customer_panel.sql`). Optional because the row is
   * read with `*`: see {@link SUBSCRIPTION_COLUMNS}.
   */
  suspended_at?: string | null;
}

/**
 * One read, retried once on a transport failure.
 *
 * The distinction that matters to {@link getBillingBlock} is "the database
 * answered" versus "we never heard back". A PostgREST error carries a `code`,
 * which means the database DID answer (a missing table, a policy refusal), so
 * asking again gets the same answer and there is nothing to retry. A thrown
 * fetch or a timeout carries no code, and that is the case a single dropped
 * connection produces.
 *
 * Two attempts, 150ms apart. This runs on every page load, so the ceiling it
 * adds to a healthy request is nothing and to a failing one about 150ms.
 */
const READ_ATTEMPTS = 2;
const RETRY_DELAY_MS = 150;

type Read<T> = { ok: true; data: T | null } | { ok: false };

interface QueryError {
  code?: string | null;
  message?: string;
}

async function readWithRetry<T>(
  run: () => Promise<{ data: T | null; error: QueryError | null }>
): Promise<Read<T>> {
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try {
      const { data, error } = await run();
      if (!error) return { ok: true, data: data ?? null };
      // The database answered. Retrying asks the same question.
      if (error.code) return { ok: false };
    } catch {
      // Thrown: no answer at all. Worth one more try.
    }
    if (attempt < READ_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return { ok: false };
}

/**
 * Every column, not a list. The lockout reads `suspended_at`, which arrives
 * with a migration; a named column the database does not have yet is a 42703
 * error, and an error here is `unavailable`, which locks out EVERY org. `*`
 * reads whatever the row has, so code that ships ahead of the migration sees
 * no suspension rather than a lockout.
 */
const SUBSCRIPTION_COLUMNS = "*";

/**
 * The caller's subscription row, distinguishing "none" from "could not read".
 * Once per request: the root layout asks for it through `getBillingBlock`
 * and `getPendingBandChange` in the same render.
 */
export function readSubscriptionRow(): Promise<Read<SubscriptionRow>> {
  return memoScope("subscription-row", loadSubscriptionRow);
}

async function loadSubscriptionRow(): Promise<Read<SubscriptionRow>> {
  try {
    const sb = await getSupabaseServer();
    return await readWithRetry<SubscriptionRow>(async () =>
      sb
        .from("subscriptions")
        .select(SUBSCRIPTION_COLUMNS)
        .maybeSingle<SubscriptionRow>()
    );
  } catch {
    return { ok: false };
  }
}

/**
 * Whether the caller's org has finished onboarding, null when they have no org
 * row at all (nothing to block: they have no workspace yet).
 */
async function readOnboardingCompleted(): Promise<Read<boolean>> {
  try {
    const sb = await getSupabaseServer();
    const read = await readWithRetry<{ onboarding_completed_at: string | null }>(
      async () =>
        sb
          .from("organizations")
          .select("onboarding_completed_at")
          .maybeSingle<{ onboarding_completed_at: string | null }>()
    );
    if (!read.ok) return read;
    return {
      ok: true,
      data: read.data ? read.data.onboarding_completed_at !== null : null,
    };
  } catch {
    return { ok: false };
  }
}

/** Read the current org's subscription (RLS-scoped), or null if none/unset. */
export async function getSubscription(): Promise<OrgSubscription | null> {
  if (!hasSupabase()) return null;
  try {
    const [read, pricing] = await Promise.all([readSubscriptionRow(), getWellPricingOrNull()]);
    if (!read.ok || !read.data) return null;
    const data = read.data;
    const wellQuantity = Number(data.well_quantity ?? 1);
    const interval: BillingInterval =
      data.billing_interval === "year" ? "year" : "month";
    return {
      tier: tierByKey(data.tier).key,
      status: data.status,
      interval,
      periodUsd: pricing ? priceUsdForWells(wellQuantity, interval, pricing) : null,
      pendingBand: data.pending_band ? tierByKey(data.pending_band).key : null,
      wellCap: Number(data.well_cap ?? 0),
      wellQuantity,
      monthlyCredits: Number(data.monthly_credits ?? 0),
      currentPeriodEnd: data.current_period_end,
      trialEnd: data.trial_end,
      cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
      hasStripe: Boolean(data.stripe_subscription_id),
    };
  } catch {
    return null;
  }
}

/**
 * Whole-app access block. `reason` drives the modal copy variant.
 *
 * FAILS CLOSED. When we cannot confirm the org is entitled to be here, the org
 * does not get in: a missing subscription, a read we never got an answer to, and
 * a status we do not recognize all block. The one exception is the dev switch,
 * and it is not doubt: `PAID_MODE` off is an explicit statement that this
 * deployment does not bill.
 *
 * Onboarding is a DESTINATION, not an exemption. An owner who has not finished
 * onboarding has no subscription row and never will until they do, so they stay
 * unblocked here and `src/proxy.ts` routes them to `/onboarding`. Blocking them
 * would be a lockout with no way out.
 *
 * The cost of failing closed is that one database outage locks out every
 * customer at once, which is why the reads retry once (see `readWithRetry`) and
 * why a failed read gets its own `unavailable` reason: telling a paying customer
 * during a blip that their subscription was cancelled is worse than the lockout.
 */
export type BillingBlockReason =
  | "suspended"
  | "canceled"
  | "payment_failed"
  | "not_subscribed"
  | "unavailable";
export interface BillingBlock {
  blocked: boolean;
  reason: BillingBlockReason | null;
}

/** Statuses that mean the org is paying (or is inside its free trial). */
const ENTITLED = new Set(["active", "trialing"]);

/**
 * Statuses that mean a payment is owed or was refused. `incomplete` is here
 * because it means the FIRST payment never completed; an org still working
 * through it is on `/onboarding`, which the proxy exempts.
 */
const PAYMENT_LAPSED = new Set([
  "past_due",
  "unpaid",
  "incomplete",
  "incomplete_expired",
]);

/**
 * Decide whether the current org is locked out of the app. `active`/`trialing`
 * (including a scheduled `cancel_at_period_end` that hasn't hit period end) stay
 * unblocked: Stripe keeps the status `active` through the paid period, then flips
 * it to `canceled` at period end, which is exactly when this returns blocked.
 */
export async function getBillingBlock(): Promise<BillingBlock> {
  const none: BillingBlock = { blocked: false, reason: null };
  // Master switch off / pre-billing dev → never block.
  if (!isPaidMode() || !hasSupabase()) return none;

  const read = await readSubscriptionRow();
  if (!read.ok) return { blocked: true, reason: "unavailable" };

  if (!read.data) {
    const onboarding = await readOnboardingCompleted();
    if (!onboarding.ok) return { blocked: true, reason: "unavailable" };
    // No org row visible at all: no workspace to lock. Membership gating owns
    // that case, and blocking here would only hide its message.
    if (onboarding.data === null) return none;
    // Mid-onboarding: the proxy sends them to `/onboarding` to get a plan.
    if (onboarding.data === false) return none;
    return { blocked: true, reason: "not_subscribed" };
  }

  // Staff suspension outranks billing: a suspended org is out whatever it pays.
  if (read.data.suspended_at) return { blocked: true, reason: "suspended" };

  const status = read.data.status;
  if (ENTITLED.has(status)) return none;
  if (status === "canceled") return { blocked: true, reason: "canceled" };
  if (PAYMENT_LAPSED.has(status)) {
    return { blocked: true, reason: "payment_failed" };
  }
  // A status we have never seen is not a confirmation that they are paying.
  return { blocked: true, reason: "unavailable" };
}

/** Thrown when a create would exceed the org's selected-band well cap. */
export class WellCapReachedError extends Error {
  readonly cap: number;
  constructor(cap: number) {
    super(
      `Your plan includes up to ${cap} wells. Upgrade to the next plan to add more.`
    );
    this.name = "WellCapReachedError";
    this.cap = cap;
  }
}

/**
 * Block well creation once the org hits its selected band's well cap (tiers 1–3),
 * surfacing an upgrade prompt. Tier 4 (100+) is uncapped and never blocks. Fails
 * open when billing isn't configured or there's no subscription yet (dev), so the
 * app keeps working before billing is wired. Pass the request-scoped client so the
 * subscription + count reads are RLS-scoped to the caller's org.
 */
export async function assertWellCapacity(sb: SupabaseClient): Promise<void> {
  // Master switch off → no cap enforcement.
  if (!isPaidMode()) return;
  if (!hasSupabase()) return;
  const { data: sub } = await sb
    .from("subscriptions")
    .select("well_cap")
    .maybeSingle<{ well_cap: number }>();
  const cap = Number(sub?.well_cap ?? 0);
  // No plan (0) or the open-ended top band → don't block.
  if (!sub || cap <= 0 || cap >= UNLIMITED_WELLS) return;

  let count: number;
  try {
    count = await countBillableWells(sb);
  } catch {
    return; // don't block on a count error
  }
  if (count >= cap) throw new WellCapReachedError(cap);
}

/**
 * Count an org's BILLABLE wells: every PRODUCER that is not explicitly retired.
 *
 * Disposal (injection) wells are never billed: `.neq("type", "injection")`.
 * `type` is `not null default 'producer'`, so `neq` cannot drop a null row here
 * the way it would on `active`. A plugged well is `active = false` by DB
 * constraint, so it is already outside the count (plugged-wells.md §6).
 *
 * The filter is `not ... is false`, not `eq(true)` and never `neq(false)`. A
 * retired well is one someone switched off; anything else — including a null
 * `active` — is still a well we bill for, so the count fails toward charging
 * rather than silently zeroing revenue. `.neq("active", false)` is the trap:
 * Postgres evaluates `NULL <> false` to NULL, which would DROP a null row from
 * the count. `NOT (active IS FALSE)` keeps it.
 *
 * `orgId` is optional because the request-scoped client is already RLS-scoped to
 * the caller's org; the service-role client is not and must pass it. For the
 * same reason `deleted_at is null` is explicit: soft-deleted wells
 * (2026081800200_facility_soft_delete.sql) are hidden from the request client by
 * RLS, but the service role sees straight through it — without this filter a
 * deleted well kept being billed, which is exactly what `deleteWell` says it
 * re-syncs to prevent.
 *
 * Returns the honest number — no minimum-of-1 clamp. Stripe won't take
 * `quantity: 0`, but that floor belongs to the quantity, and
 * {@link billableQuantity} already applies it. Throws on a query error rather
 * than reporting 1: a swallowed error that reads as "one well" could invoice a
 * 200-well org at the tier-1 floor. Both callers sit behind a fail-open catch,
 * so a throw costs a skipped sync, not a wrong charge.
 */
export async function countBillableWells(
  client: SupabaseClient,
  orgId?: string
): Promise<number> {
  let q = client
    .from("wells")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null)
    .not("active", "is", false)
    .neq("type", "injection");
  if (orgId) q = q.eq("org_id", orgId);
  const { count, error } = await q;
  if (error) throw new Error(`countBillableWells: ${error.message}`);
  return count ?? 0;
}

/**
 * Tell the org's owner + admins that their well count has moved into another
 * band and a one-click change is waiting.
 *
 * Rides on `billing_payments` — the existing "billing & payments" preference —
 * rather than a new type: this IS a billing change, and a second toggle row for
 * money would only invite someone to switch half of it off. `p_group_key`
 * dedupes, so a fleet import that crosses a boundary while wells are still
 * landing raises ONE notification for that band, not one per well.
 *
 * Best-effort: never throws into the write that triggered it.
 */
async function notifyBandAvailable(
  orgId: string,
  from: TierKey,
  to: TierKey,
  wellCount: number
): Promise<void> {
  const direction = tierByKey(to).minWells > tierByKey(from).minWells ? "up" : "down";
  try {
    const { error } = await getSupabaseAdmin().rpc("enqueue_notification", {
      p_org: orgId,
      p_type: "billing_payments",
      p_caps: [] as string[],
      p_actor: null,
      p_payload: {
        event: direction === "up" ? "band_up_available" : "band_down_available",
        from,
        to,
        wells: wellCount,
      },
      p_group_key: `band:${orgId}:${to}`,
    });
    if (error) console.error("notifyBandAvailable failed", error.message);
  } catch (err) {
    // Its own catch, not the caller's: the prompt row is already written, and a
    // notification that could not be queued must not cost the quantity sync that
    // comes after it.
    console.error("notifyBandAvailable threw", err instanceof Error ? err.message : err);
  }
}

/** Moved to `tiers.ts` so the admin panel can price a band client-side. */
export { billableQuantity };

/**
 * Sync the org's billed well quantity to its actual well count, and raise the
 * band-change prompt when the count has crossed a band boundary.
 *
 * Two jobs, deliberately together: the well count is read once, and the same
 * number decides both what Stripe bills and whether the operator is now owed a
 * prompt. Quantity is clamped by {@link billableQuantity}, so crossing a
 * boundary changes `pending_band` and NOTHING about the money — the click on
 * Upgrade / Downgrade is what moves the bill (`applyBandChange`).
 *
 * Proration for the within-band part is asymmetric (docs/billing.md): **adds
 * prorate immediately** (`create_prorations`), **removals don't credit** the
 * current period (`none`).
 *
 * Best-effort: a billing hiccup must never fail the well write that triggered it,
 * so this catches and logs. No-op when paid mode is off / Stripe unconfigured /
 * the org has no Stripe subscription. Called from well create, the webhook, and
 * the reconcile sweep, so it takes an explicit `orgId` (service role).
 */
export async function syncWellQuantity(orgId: string): Promise<void> {
  if (!isPaidMode() || !hasStripe() || !hasSupabase()) return;
  try {
    const admin = getSupabaseAdmin();
    const { data: sub } = await admin
      .from("subscriptions")
      .select(
        "stripe_subscription_id, stripe_subscription_item_id, well_quantity, tier, pending_band"
      )
      .eq("org_id", orgId)
      .maybeSingle<{
        stripe_subscription_id: string | null;
        stripe_subscription_item_id: string | null;
        well_quantity: number | null;
        tier: string | null;
        pending_band: string | null;
      }>();
    if (!sub?.stripe_subscription_id) return;

    const wellCount = await countBillableWells(admin, orgId);
    const tier = tierByKey(sub.tier).key;

    // The prompt, first: it is a row write that must land even if Stripe is
    // having a bad day, and it is what tells the operator why their bill is
    // about to move.
    const landsIn = recommendTier(wellCount).key;
    const pending = landsIn === tier ? null : landsIn;
    if (pending !== (sub.pending_band ?? null)) {
      await admin
        .from("subscriptions")
        .update({ pending_band: pending })
        .eq("org_id", orgId);
      if (pending) await notifyBandAvailable(orgId, tier, pending, wellCount);
    }

    const quantity = billableQuantity(wellCount, tier);
    const current = Number(sub.well_quantity ?? 0);
    if (quantity === current) return;

    const stripe = getStripe();
    let itemId = sub.stripe_subscription_item_id;
    if (!itemId) {
      const s = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      itemId = s.items.data[0]?.id ?? null;
      if (!itemId) return;
    }

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: itemId, quantity }],
      // Adds charge immediately; removals wait for the next invoice.
      proration_behavior: quantity > current ? "create_prorations" : "none",
    });

    await admin
      .from("subscriptions")
      .update({ well_quantity: quantity, stripe_subscription_item_id: itemId })
      .eq("org_id", orgId);
  } catch (err) {
    console.error(
      "syncWellQuantity failed",
      err instanceof Error ? err.message : err
    );
  }
}
