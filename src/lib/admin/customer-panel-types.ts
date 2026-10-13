/**
 * What the admin customer panel shows, shaped for the client. Read by
 * `customer-panel.ts` (service role, behind the platform-admin gate); the
 * pure derivations over it live in `customer-usage.ts` so they can be tested
 * against hand-computed figures.
 */

import type { AccountType } from "@/lib/admin/account-types";
import type { WellPricing } from "@/lib/billing/tiers";

export type FacilityKind = "well" | "tank" | "meter" | "battery";

/** One live facility and the data entered against it. */
export interface FacilityInputs {
  kind: FacilityKind;
  id: string;
  name: string;
  /** Well type (producer / injection), tank product, or meter substance. */
  detail: string | null;
  /** Entries dated in the recent window (`UsageWindow.recent` onward). */
  entries: number;
  /** Distinct days with at least one entry in the recent window. */
  days: number;
  /** Latest entry date (`YYYY-MM-DD`) since `UsageWindow.since`, or null. */
  last: string | null;
}

/** Entries per day and facility kind, for the activity chart. */
export interface DailyInputs {
  day: string;
  kind: FacilityKind;
  entries: number;
}

/** Entries per author in the recent window; `userId` null = no author recorded. */
export interface AuthorInputs {
  userId: string | null;
  entries: number;
  last: string | null;
}

/**
 * One day's AI spend for one provider, kind and model, with what its vendor
 * cost is rebuilt from (`admin_org_credit_daily`). `costUsd` is what the meter
 * recorded; the quantities are only for rows that recorded none.
 */
export interface AiSpendGroup {
  day: string;
  provider: string;
  kind: string;
  model: string | null;
  credits: number;
  calls: number;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  chars: number;
  /** Calls nothing can price (speech-to-text records no duration). */
  unpriced: number;
}

export interface UsageWindow {
  /** First day of the long window (charts, last entry). `YYYY-MM-DD`. */
  since: string;
  /** First day of the recent window (per-facility counts). `YYYY-MM-DD`. */
  recent: string;
  /** Today, the last day of both. `YYYY-MM-DD`. */
  today: string;
}

export interface PanelMember {
  /** `org_members.id`; null for an owner with no member row. */
  memberId: string | null;
  authUserId: string | null;
  name: string;
  email: string | null;
  isOwner: boolean;
  isAdmin: boolean;
  status: "active" | "invited" | "removed";
  lastSignInAt: string | null;
  phoneLastSeenAt: string | null;
  /** Phones registered for push, newest first. */
  devices: { platform: string; name: string; lastSeenAt: string }[];
  /** Entries this person made in the recent window. */
  entries: number;
  lastEntry: string | null;
}

export interface PanelSubscription {
  tier: string;
  status: string;
  interval: "month" | "year";
  wellCap: number;
  wellQuantity: number;
  monthlyCredits: number;
  pendingBand: string | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  suspendedAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

export interface CustomerPanelData {
  orgId: string;
  name: string;
  createdAt: string;
  onboardingCompletedAt: string | null;
  accountType: AccountType;
  ownerEmail: string | null;
  referredBy: { orgId: string; name: string } | null;
  referrals: number;
  subscription: PanelSubscription | null;
  billableWells: number;
  credits: {
    freeRemaining: number;
    paidBalance: number;
    /** Platform credit (USD) in cents. */
    platformCents: number;
  };
  window: UsageWindow;
  facilities: FacilityInputs[];
  daily: DailyInputs[];
  authors: AuthorInputs[];
  /** AI spend per day since `window.since`, by provider. */
  aiSpend: AiSpendGroup[];
  members: PanelMember[];
}

/** One invoice as the Billing tab lists it. */
export interface PanelInvoice {
  id: string;
  number: string | null;
  createdAt: string;
  totalCents: number;
  amountPaidCents: number;
  amountRefundedCents: number;
  status: string;
  hostedUrl: string | null;
  /** True for an AI-credit top-up, false for the subscription. */
  topUp: boolean;
}

/** What Stripe itself says, read live when the Billing tab opens. */
export interface CustomerBillingData {
  /** False when the org has no Stripe customer at all (comped / onboarding). */
  hasStripe: boolean;
  /** Link to the customer in the Stripe dashboard. */
  dashboardUrl: string | null;
  /**
   * What the subscription bills per year, valued as the Clients table values
   * it (`annualUsdOfSubscription`); 0 once Stripe has ended it.
   */
  annualUsd: number;
  /** The well prices, for quoting a band or interval change. Null when unreadable. */
  pricing: WellPricing | null;
  subscription: {
    id: string;
    status: string;
    /** Set while collection is paused: invoices are voided, access continues. */
    pausedUntil: string | null;
    paused: boolean;
    /** Same as `paused`; the dashboard counts them as not paying. */
    pausedNow: boolean;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    trialEnd: string | null;
    discounts: { id: string; label: string }[];
  } | null;
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  invoices: PanelInvoice[];
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}
