/**
 * How a purchase is split between platform credit and a card.
 *
 * Pure module (no server imports) so the buy-credits UI can preview the exact
 * split the server action will perform. See
 * docs/plans/referral-platform-credit.md.
 *
 * Platform credit is a USD balance in CENTS. AI credits are a usage unit worth
 * $0.01 each (`DOLLARS_PER_CREDIT` in tiers.ts). The two are deliberately
 * different denominations and must never be added together.
 */

export interface CreditSplit {
  /** Cents covered by the org's platform credit balance. */
  fromCreditCents: number;
  /** Cents left for the card. Zero means no PaymentIntent is created at all. */
  fromCardCents: number;
}

/**
 * Split a purchase across the balance and the card. Credit is applied first and
 * clamped to what is actually available, so `fromCreditCents` never exceeds
 * either the request or the balance, and neither leg is ever negative.
 *
 * This is a preview when called with a balance read from the DB; the server
 * action re-derives the real split from what `platform_credit_spend` actually
 * spent, because only the RPC is authoritative under concurrency.
 */
export function splitWithCredit(
  requestedCents: number,
  balanceCents: number
): CreditSplit {
  const requested = Math.max(0, Math.floor(requestedCents || 0));
  const balance = Math.max(0, Math.floor(balanceCents || 0));
  const fromCreditCents = Math.min(requested, balance);
  return { fromCreditCents, fromCardCents: requested - fromCreditCents };
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

/** Format a cents amount as USD, e.g. 60000 -> "$600.00". */
export function formatCents(cents: number): string {
  return USD.format((cents || 0) / 100);
}
