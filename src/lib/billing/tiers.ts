/**
 * Subscription band catalog + credit economics.
 *
 * Pure module (no server imports) so both the onboarding UI and server actions
 * can use it. Billing is a SINGLE Stripe Product with one tiered (volume) Price
 * per interval (`STRIPE_PRICE_WELLS`, `STRIPE_PRICE_WELLS_YEARLY`); the org's
 * **well count is the billed quantity**, and the tiered price computes the
 * amount for the band that count lands in.
 *
 * PRICES LIVE IN STRIPE, NOT HERE. Every dollar figure is computed from the
 * Stripe prices' own tier tables ({@link WellPricing}, read server-side by
 * `stripe-pricing.ts`), so the app can never quote a number Stripe does not
 * bill. This module owns only what Stripe does not: the band keys, their well
 * caps (enforced on well creation; crossing one needs an approved upgrade) and
 * the AI credits each band grants. Tier 4 is uncapped and bills per well.
 * See docs/billing.md.
 *
 * CREDITS — the internal unit metered for every AI call. One credit = one cent
 * (`DOLLARS_PER_CREDIT`); a call is billed at provider cost × `CREDIT_MARKUP`.
 * Each band's `monthlyCredits` resets every period (no rollover).
 */

import { periodAmountCents, type PriceTier, type TiersMode } from "@/lib/billing/stripe-tiers";

export type TierKey = "tier_1" | "tier_2" | "tier_3" | "tier_4";

export interface Tier {
  key: TierKey;
  /** Inclusive lower bound of the well-count band. */
  minWells: number;
  /** Inclusive upper bound, or null for the open-ended top band (tier 4). */
  maxWells: number | null;
  label: string;
  /** Max wells the band allows; crossing it needs an upgrade (tier 4 = unlimited). */
  wellCap: number;
  /** Free AI credits granted at the start of each billing period (no rollover). */
  monthlyCredits: number;
}

/** Practical "no cap" for the open-ended top band. */
export const UNLIMITED_WELLS = 1_000_000;

export const TIERS: readonly Tier[] = [
  { key: "tier_1", minWells: 1, maxWells: 24, label: "Tier 1", wellCap: 24, monthlyCredits: 10_000 },
  { key: "tier_2", minWells: 25, maxWells: 49, label: "Tier 2", wellCap: 49, monthlyCredits: 25_000 },
  { key: "tier_3", minWells: 50, maxWells: 99, label: "Tier 3", wellCap: 99, monthlyCredits: 50_000 },
  { key: "tier_4", minWells: 100, maxWells: null, label: "Tier 4", wellCap: UNLIMITED_WELLS, monthlyCredits: 50_000 },
] as const;

/** True when this band bills per well (tier 4) rather than a flat amount. */
export function isPerWell(tier: Tier): boolean {
  return tier.maxWells === null;
}

export function isTierKey(value: string | null | undefined): value is TierKey {
  return (
    value === "tier_1" || value === "tier_2" || value === "tier_3" || value === "tier_4"
  );
}

/** Look up a band by key, falling back to the entry band for unknown keys. */
export function tierByKey(key: string | null | undefined): Tier {
  return TIERS.find((t) => t.key === key) ?? TIERS[0];
}

/**
 * The band a well count falls in. Counts below the first band fall back to
 * tier 1 (the entry band); the open-ended top band catches everything at 100+.
 */
export function recommendTier(wellCount: number): Tier {
  const wells = Number.isFinite(wellCount) ? Math.max(0, Math.floor(wellCount)) : 0;
  const match = TIERS.find(
    (t) => wells >= t.minWells && (t.maxWells === null || wells <= t.maxWells)
  );
  return match ?? TIERS[0];
}

/**
 * The quantity to bill for a well count, held inside the band the org is
 * SUBSCRIBED to.
 *
 * The Stripe price is volume-tiered, so quantity alone decides the amount: send
 * 55 on a tier-1 subscription and Stripe silently bills tier 2, send 45 on a
 * tier-2 one and it silently bills tier 1. Neither is allowed to happen without
 * the operator pressing a button (`docs/plans/annual-pricing.md` §4), so the
 * quantity is clamped to the subscribed band and the crossing becomes a PROMPT
 * instead of a charge. `applyBandChange` is what releases the clamp.
 *
 * Changes WITHIN a band still flow through, which is what keeps tier 4 (per
 * well, uncapped) billing honestly as wells come and go.
 */
export function billableQuantity(wellCount: number, tier: TierKey): number {
  const band = tierByKey(tier);
  const floor = Math.max(1, band.minWells);
  const ceiling = band.maxWells ?? UNLIMITED_WELLS;
  return Math.min(Math.max(wellCount, floor), ceiling);
}

/** Alias of `recommendTier` for readability where "which band" is the question. */
export const bandForWells = recommendTier;

// --- Prices (from Stripe) ---------------------------------------------------

/** Which Stripe Price an org bills on: monthly, or annual at a discount. */
export type BillingInterval = "month" | "year";

/** One Stripe tiered Price as the app needs it: amounts in cents. */
export interface WellPrice {
  tiersMode: TiersMode | null;
  tiers: PriceTier[];
  unitAmount: number | null;
}

/**
 * The two Stripe Prices subscriptions bill on, read from Stripe. Plain data,
 * so the server can hand it to client components.
 */
export interface WellPricing {
  month: WellPrice;
  year: WellPrice;
}

const MONTHS_PER_YEAR = 12;

/** Clamped to a minimum of 1 well (Stripe bills the first flat tier at quantity 0). */
function billedWells(wellCount: number): number {
  return Number.isFinite(wellCount) ? Math.max(1, Math.floor(wellCount)) : 1;
}

/** What a well count costs per BILLING PERIOD on the given interval, in USD. */
export function priceUsdForWells(
  wellCount: number,
  interval: BillingInterval,
  pricing: WellPricing
): number {
  const price = pricing[interval];
  return (
    periodAmountCents(
      { tiers_mode: price.tiersMode, tiers: price.tiers, unit_amount: price.unitAmount },
      billedWells(wellCount)
    ) / 100
  );
}

/** What a well count costs for a MONTH on the monthly price, in USD. */
export function monthlyUsdForWells(wellCount: number, pricing: WellPricing): number {
  return priceUsdForWells(wellCount, "month", pricing);
}

/** What a well count costs for a YEAR on the annual price, in USD. */
export function annualUsdForWells(wellCount: number, pricing: WellPricing): number {
  return priceUsdForWells(wellCount, "year", pricing);
}

/**
 * What a year of annual billing works out to per month — the figure the plan
 * step leads with when annual is selected, so the two options can be compared
 * on the same basis. Not a price anyone is charged: the charge is the year.
 */
export function annualMonthlyEquivalentUsd(wellCount: number, pricing: WellPricing): number {
  return annualUsdForWells(wellCount, pricing) / MONTHS_PER_YEAR;
}

/** What paying annually saves over twelve monthly payments, in USD. */
export function annualSavingsUsd(wellCount: number, pricing: WellPricing): number {
  return monthlyUsdForWells(wellCount, pricing) * MONTHS_PER_YEAR - annualUsdForWells(wellCount, pricing);
}

/** The annual saving in months of the monthly price, for the "N months free" badge. */
export function annualFreeMonths(wellCount: number, pricing: WellPricing): number {
  const monthly = monthlyUsdForWells(wellCount, pricing);
  return monthly > 0 ? Math.round(annualSavingsUsd(wellCount, pricing) / monthly) : 0;
}

/**
 * A band's monthly rate as Stripe states it: the flat amount for bands 1–3, the
 * per-well amount for tier 4. Read from the Stripe tier the band's first well
 * lands in.
 */
export function bandRateUsd(
  tier: Tier,
  pricing: WellPricing
): { flatUsd: number | null; perWellUsd: number | null } {
  const tiers = pricing.month.tiers;
  const t = tiers.find((x) => x.up_to === null || tier.minWells <= x.up_to) ?? tiers[tiers.length - 1];
  if (!t) return { flatUsd: null, perWellUsd: (pricing.month.unitAmount ?? 0) / 100 };
  return isPerWell(tier)
    ? { flatUsd: null, perWellUsd: (t.unit_amount ?? 0) / 100 }
    : { flatUsd: ((t.flat_amount ?? 0) + (t.unit_amount ?? 0) * tier.minWells) / 100, perWellUsd: null };
}

/**
 * What moving between bands changes on the bill, per period, in USD.
 *
 * Positive when the new band costs more. Both sides are priced at the well count
 * that PUT them in that band — a band's flat amount is the same at any count
 * inside it, so this is the honest difference for bands 1–3; at tier 4 it is the
 * per-well amount at the given counts.
 */
export function bandPriceDeltaUsd(
  fromWells: number,
  toWells: number,
  interval: BillingInterval,
  pricing: WellPricing
): number {
  return priceUsdForWells(toWells, interval, pricing) - priceUsdForWells(fromWells, interval, pricing);
}

// --- Referral reward --------------------------------------------------------

/**
 * Platform credit granted to BOTH sides of a referral when the referred org
 * converts. A FLAT amount, deliberately: bands run $1,000 to $10/well, so "one
 * free month" is a different number for every org and cannot be stated up front
 * on a sign-up form or a share link. One figure is what both parties can be told
 * before they act on it.
 *
 * See docs/plans/referral-platform-credit.md.
 */
export const REFERRAL_REWARD_USD = 1000;

/** The same reward in cents, which is how platform credit is stored. */
export const REFERRAL_REWARD_CENTS = REFERRAL_REWARD_USD * 100;

// --- Credit economics -------------------------------------------------------

/** USD a single credit represents — one cent. */
export const DOLLARS_PER_CREDIT = 0.01;

/**
 * Wildcat credit conversion.
 *
 * Credits are a Wildcat unit, NOT a passthrough of Anthropic's price list. The
 * rates below are model blind and feature blind on purpose: the same conversion
 * applies whichever Claude model served the request and whichever surface made
 * it. That is what makes routing a workload to a cheaper model (or to a lower
 * effort level) accrue as margin rather than silently discounting the customer.
 *
 * Priced at Opus-equivalent, so realized markup rises as traffic moves down:
 * Opus 5 ~1.33x, Sonnet 5 ~2.2x, Haiku 4.5 ~6.7x.
 *
 * Do not re-derive these from vendor USD. See plans/orion-effort-router.md.
 */
export const INPUT_TOKENS_PER_CREDIT = 1_500;
export const OUTPUT_TOKENS_PER_CREDIT = 300;

/**
 * The one deliberate exception to model-blind pricing: the geology agent.
 *
 * Model blindness holds because the router's job is to move work DOWN the price
 * list, and every step down becomes margin. The geology harness inverts that —
 * it routes work UP, to Fable at 2x Opus, and it spends a second model (Sonnet,
 * five to eight calls a turn) assembling context before Fable ever runs. At the
 * blind rate that turn bills 0.67x its own vendor cost: the better the answer,
 * the more it loses.
 *
 * So this path prices per model, against the vendor rates below:
 *
 *   Sonnet 5  0.90x  ->  2.0x  ($6 / $30 per Mtok charged, $3 / $15 paid)
 *   Fable 5   2.25x  ->  1.5x  ($15 / $75 charged, $10 / $50 paid)
 *
 * Sonnet's multiplier is BELOW one because the blind rate already clears 2.2x
 * on Sonnet — this trims it to the target rather than raising it. Only the
 * geology call sites pass these; everything else stays blind, which is why the
 * digest summarizer (also Sonnet) is untouched.
 *
 * Revisit when either vendor price moves. Sonnet 5 is on introductory pricing
 * ($2 / $10) through 2026-08-31, so realized markup there is nearer 3x until
 * the list rate takes over — the target is stated against the list rate, which
 * is the one that will still be true in September.
 */
export const GEOLOGY_CREDIT_MULTIPLIER: Record<string, number> = {
  "claude-sonnet-5": 0.9,
  "claude-fable-5": 2.25,
};

/** The multiplier for `model` on the geology path; 1 (blind) for anything else. */
export function geologyCreditMultiplier(model: string | undefined): number {
  return (model && GEOLOGY_CREDIT_MULTIPLIER[model]) || 1;
}

/** Fixed rates for the non-token services. Same principle as the token rates. */
export const CREDITS_PER_WEB_SEARCH = 2;
export const TTS_CHARS_PER_CREDIT = 150;
export const CREDITS_PER_STT_CALL = 1;

/**
 * Vendor rates, USD. COST TRACKING ONLY — these no longer feed pricing. They
 * exist so `providerCostUsd` can record realized cost alongside credits charged,
 * which is the guard that tells us when a conversion rate needs revisiting.
 *
 * Verified against platform.claude.com/docs/en/about-claude/pricing and
 * elevenlabs.io/pricing/api (2026-08).
 */
const VENDOR_USD_PER_TOKEN: Record<string, { input: number; output: number }> = {
  // Fable is 2x Opus both ways, and the router sends geological work there while
  // `anthropicCredits` still charges the user model-blind. Without this row a
  // Fable turn would be recorded at Opus rates and the margin drift it causes
  // would be invisible — which is the one thing this table exists to catch.
  "claude-fable-5": { input: 10 / 1_000_000, output: 50 / 1_000_000 },
  "claude-opus-5": { input: 5 / 1_000_000, output: 25 / 1_000_000 },
  "claude-opus-4-8": { input: 5 / 1_000_000, output: 25 / 1_000_000 },
  "claude-sonnet-5": { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  "claude-haiku-4-5": { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  // OpenAI, for the `SCAN_PROVIDER=openai` scan experiment only. UNVERIFIED —
  // unlike the Claude rows above these were not checked against a vendor page;
  // confirm at openai.com/api/pricing before reading anything into the drift
  // guard. Without a row here an OpenAI scan records at Opus rates, which is
  // the one failure this table exists to prevent.
  "gpt-4.1": { input: 2 / 1_000_000, output: 8 / 1_000_000 },
};
const VENDOR_FALLBACK_USD = VENDOR_USD_PER_TOKEN["claude-opus-5"];

/** Cache reads bill at 0.1x input; 5m cache writes at 1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** ElevenLabs: Flash v2.5 at $0.05 / 1k chars, Scribe at $0.22 / hour. */
const ELEVENLABS_TTS_USD_PER_CHAR = 0.00005;
const ELEVENLABS_STT_USD_PER_SECOND = 0.22 / 3_600;

/** Anthropic web search: $10 per 1,000 search requests. */
const ANTHROPIC_WEB_SEARCH_USD_PER_REQUEST = 10 / 1_000;

/**
 * Credits for one Anthropic call.
 *
 * `inputTokens` must already include cache reads and cache writes: they are
 * input tokens that arrive in separate usage fields, and dropping them would
 * bill a cached turn at near zero. `meterAnthropic` folds them in.
 *
 * `multiplier` defaults to 1, which is the model-blind rate every surface but
 * the geology agent uses. It scales the raw token cost BEFORE the ≥1 floor, so
 * a multiplier can never take a real call to zero credits.
 */
export function anthropicCredits(
  inputTokens: number,
  outputTokens: number,
  multiplier = 1
): number {
  return Math.max(
    1,
    Math.ceil(
      (inputTokens / INPUT_TOKENS_PER_CREDIT + outputTokens / OUTPUT_TOKENS_PER_CREDIT) *
        multiplier
    )
  );
}

export function elevenLabsTtsCredits(chars: number): number {
  return Math.max(1, Math.ceil(chars / TTS_CHARS_PER_CREDIT));
}

/**
 * Flat per call, deliberately duration blind. Breakeven is ~2.7 minutes of
 * audio; typical voice input is a few seconds, where this runs 5-16x cost.
 */
export function elevenLabsSttCredits(): number {
  return CREDITS_PER_STT_CALL;
}

/** Credits for `requests` Anthropic web searches (0 → 0, never a ≥1 floor). */
export function anthropicWebSearchCredits(requests: number): number {
  if (requests <= 0) return 0;
  return requests * CREDITS_PER_WEB_SEARCH;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Realized vendor cost in USD for one Anthropic call. Never used for pricing —
 * recorded into the ledger's `meta` so drift between what we charge and what we
 * pay is visible without re-deriving credits from vendor rates.
 */
export function providerCostUsd(model: string, usage: ProviderUsage): number {
  const rate = VENDOR_USD_PER_TOKEN[model] ?? VENDOR_FALLBACK_USD;
  return (
    (usage.inputTokens ?? 0) * rate.input +
    (usage.outputTokens ?? 0) * rate.output +
    (usage.cacheReadTokens ?? 0) * rate.input * CACHE_READ_MULTIPLIER +
    (usage.cacheWriteTokens ?? 0) * rate.input * CACHE_WRITE_MULTIPLIER
  );
}

export function webSearchCostUsd(requests: number): number {
  return Math.max(0, requests) * ANTHROPIC_WEB_SEARCH_USD_PER_REQUEST;
}

export function ttsCostUsd(chars: number): number {
  return chars * ELEVENLABS_TTS_USD_PER_CHAR;
}

export function sttCostUsd(seconds: number): number {
  return seconds * ELEVENLABS_STT_USD_PER_SECOND;
}

/** USD a top-up purchase grants as credits (inverse of DOLLARS_PER_CREDIT). */
export function dollarsToTopUpCredits(usd: number): number {
  return Math.round(usd / DOLLARS_PER_CREDIT);
}
