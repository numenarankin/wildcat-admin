import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/billing/stripe";
import { periodAmountCents, type PriceTier, type TiersMode } from "@/lib/billing/stripe-tiers";
import { pauseSpans, type Pause, type RecurringSubscription } from "@/lib/admin/metrics";

const MONTHS_PER_YEAR = 12;

/** Statuses that never billed: a checkout that was abandoned is not a customer. */
const NEVER_LIVE = new Set<Stripe.Subscription.Status>(["incomplete", "incomplete_expired"]);

/**
 * Every subscription Stripe has ever had for this account, valued per year
 * from its own price tiers, with the instants it started and (if it did)
 * stopped. This is the history the ARR series is rebuilt from: the database
 * keeps only each org's current row, Stripe keeps all of them.
 *
 * `excludeIds` drops the subscriptions of demo and test orgs.
 */
export async function listRecurringSubscriptions(
  excludeIds: ReadonlySet<string>
): Promise<RecurringSubscription[]> {
  const stripe = getStripe();
  const subs = await stripe.subscriptions
    .list({ status: "all", limit: 100 })
    .autoPagingToArray({ limit: 10_000 });
  const kept = subs.filter((s) => !NEVER_LIVE.has(s.status) && !excludeIds.has(s.id));

  // When each subscription was paused (`pauseSpans`). Only a subscription
  // with a voided invoice can have been, so the voids are listed account-wide
  // (few) and the full invoice history is read only for those subscriptions.
  const voided = new Set<string>();
  await stripe.invoices.list({ status: "void", limit: 100 }).autoPagingEach((inv) => {
    const sub = subscriptionOf(inv);
    if (sub) voided.add(sub);
  });
  const invoicesBySub = new Map<string, InvoiceMark[]>(
    await Promise.all(
      kept
        .filter((s) => voided.has(s.id) || s.pause_collection != null)
        .map(async (s) => {
          const marks: InvoiceMark[] = [];
          await stripe.invoices.list({ subscription: s.id, limit: 100 }).autoPagingEach((inv) => {
            marks.push({ created: inv.created * 1000, status: inv.status });
          });
          return [s.id, marks] as const;
        })
    )
  );
  const now = Date.now();

  // A tier table is not on the listed price (`tiers` is an expansion, and the
  // list can expand no deeper than the price itself), so each distinct price
  // is read once with its tiers.
  const priceIds = new Set(kept.flatMap((s) => s.items.data.map((i) => i.price.id)));
  const prices = new Map(
    await Promise.all(
      [...priceIds].map(async (id) => [id, await stripe.prices.retrieve(id, { expand: ["tiers"] })] as const)
    )
  );

  return kept.map((s) => ({
    id: s.id,
    startedAt: s.start_date * 1000,
    // `ended_at` is when it actually stopped; a scheduled cancel keeps it
    // live (and billing) until then.
    endedAt: s.ended_at ? s.ended_at * 1000 : null,
    annualUsd: annualUsdOf(s, prices),
    pauses: pausesOf(s, invoicesBySub.get(s.id) ?? [], now),
  }));
}

/** A subscription invoice, as `pauseSpans` reads it. */
type InvoiceMark = { created: number; status: string | null };

function subscriptionOf(inv: Stripe.Invoice): string | null {
  const sub = inv.parent?.subscription_details?.subscription;
  return typeof sub === "string" ? sub : sub?.id ?? null;
}

function pausesOf(sub: Stripe.Subscription, invoices: InvoiceMark[], now: number): Pause[] {
  return pauseSpans(invoices, sub.pause_collection != null, now);
}

/** Whether one subscription is paused right now: the dashboard counts it as not paying. */
export function isPausedNow(sub: Stripe.Subscription): boolean {
  return sub.pause_collection != null;
}

function annualUsdOf(sub: Stripe.Subscription, prices: Map<string, Stripe.Price>): number {
  let cents = 0;
  for (const item of sub.items.data) {
    const price = prices.get(item.price.id) ?? item.price;
    if (!price.recurring) continue;
    const period = periodAmountCents(
      {
        tiers_mode: (price.tiers_mode as TiersMode | null) ?? null,
        tiers: (price.tiers as PriceTier[] | undefined) ?? null,
        unit_amount: price.unit_amount,
      },
      item.quantity ?? 1
    );
    const perYear =
      price.recurring.interval === "year"
        ? period
        : price.recurring.interval === "month"
          ? period * MONTHS_PER_YEAR
          : price.recurring.interval === "week"
            ? period * 52
            : period * 365;
    cents += perYear / (price.recurring.interval_count || 1);
  }
  return cents / 100;
}

/**
 * One subscription valued per year exactly as {@link listRecurringSubscriptions}
 * values it, for the customer panel: its figure and the customer's row in the
 * Clients table come from the same arithmetic.
 */
export async function annualUsdOfSubscription(sub: Stripe.Subscription): Promise<number> {
  const stripe = getStripe();
  const ids = [...new Set(sub.items.data.map((i) => i.price.id))];
  const prices = new Map(
    await Promise.all(ids.map(async (id) => [id, await stripe.prices.retrieve(id, { expand: ["tiers"] })] as const))
  );
  return annualUsdOf(sub, prices);
}
