import type { BillingInterval } from "@/lib/billing/tiers";

/**
 * One customer as the admin dashboard lists them: the org, who owns it, what
 * they pay and when they arrived. Pure derivation over the billing rows so it
 * can be tested against hand-computed figures; `customers.ts` does the reads.
 */

/** A `subscriptions.status` that is currently billing (or about to). */
const RECURRING_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * Where a customer is with us:
 *   paying      a live Stripe subscription past its trial
 *   trial       a live Stripe subscription still in its trial (card on file)
 *   paused      charging is paused (`pauseSpans`): still a customer, not paying
 *   canceled    they had a subscription and it ended
 *   onboarding  they started signing up and never reached payment: no
 *               subscription, or an org that never finished onboarding. A
 *               comped org (no Stripe subscription) reads the same way.
 */
export type CustomerStatus = "paying" | "trial" | "paused" | "onboarding" | "canceled";

const ENDED_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);

export function customerStatus(
  sub: CustomerInput["subscription"],
  onboardingCompletedAt: string | null
): CustomerStatus {
  if (!sub || !sub.stripeSubscriptionId) return "onboarding";
  if (ENDED_STATUSES.has(sub.status)) return "canceled";
  if (!onboardingCompletedAt) return "onboarding";
  if (sub.pausedNow) return "paused";
  if (sub.status === "trialing") return "trial";
  if (RECURRING_STATUSES.has(sub.status)) return "paying";
  return "onboarding";
}

export interface CustomerInput {
  orgId: string;
  name: string;
  ownerEmail: string | null;
  createdAt: string;
  /** When they finished sign-up (details, plan, card); null while they have not. */
  onboardingCompletedAt: string | null;
  /** Null when the org has no subscription row at all. */
  subscription: {
    status: string;
    billingInterval: string | null;
    wellQuantity: number;
    stripeSubscriptionId: string | null;
    /**
     * What Stripe bills this subscription per year, from its own price tiers
     * and quantity (`stripe-subscriptions.ts`, the same figure ARR sums). Null
     * when Stripe has no live subscription by that id.
     */
    stripeAnnualUsd: number | null;
    /** Charging is paused (`pauseSpans`). */
    pausedNow?: boolean;
  } | null;
  activeWells: number;
  /** Orgs that signed up on this org's referral code. */
  referrals: number;
  /** The org whose code this one signed up on, if any. */
  referredByOrg: string | null;
}

export interface CustomerRow {
  orgId: string;
  name: string;
  email: string | null;
  term: BillingInterval | null;
  status: CustomerStatus;
  activeWells: number;
  /**
   * What this customer is worth per year, as Stripe bills it: their
   * subscription's price tiers at its quantity, annualized (a monthly plan × 12,
   * an annual plan at its yearly amount). Zero for a comped org (no Stripe
   * subscription) and for one Stripe has ended, so the pie and the ARR line
   * count the same money.
   */
  revenueUsd: number;
  signedUpAt: string;
  referrals: number;
  referredByOrg: string | null;
  /** The org's Stripe subscription, so its revenue can be dated by this sign-up. */
  subscriptionId: string | null;
}

export function annualRevenueUsd(sub: CustomerInput["subscription"]): number {
  if (!sub || !sub.stripeSubscriptionId) return 0;
  return sub.stripeAnnualUsd ?? 0;
}

export function termOf(interval: string | null | undefined): BillingInterval | null {
  if (interval === "year") return "year";
  if (interval === "month") return "month";
  return null;
}

export function customerRow(input: CustomerInput): CustomerRow {
  return {
    orgId: input.orgId,
    name: input.name,
    email: input.ownerEmail,
    term: input.subscription ? termOf(input.subscription.billingInterval) : null,
    status: customerStatus(input.subscription, input.onboardingCompletedAt),
    activeWells: input.activeWells,
    revenueUsd: annualRevenueUsd(input.subscription),
    signedUpAt: input.createdAt,
    referrals: input.referrals,
    referredByOrg: input.referredByOrg,
    subscriptionId: input.subscription?.stripeSubscriptionId ?? null,
  };
}
