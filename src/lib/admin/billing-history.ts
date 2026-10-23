import "server-only";
import type Stripe from "stripe";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { getStripe } from "@/lib/billing/stripe";
import { hasStripe } from "@/lib/env";
import { recommendTier } from "@/lib/billing/tiers";

/**
 * One org's whole billing history as Stripe has it: every subscription it has
 * had, every invoice with its lines and refunds, and the plan changes read off
 * those lines. Plan history lives only in Stripe (our `subscriptions` row holds
 * the current state), so this is the source for "when did they change tier".
 *
 * The price is volume-tiered and the quantity is clamped to the subscribed band
 * (`billableQuantity`), so a line's quantity names the tier it billed.
 */

const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);
const id = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : (x?.id ?? null));

export interface PlanLine {
  description: string | null;
  amountCents: number;
  quantity: number | null;
  tier: string | null;
  priceId: string | null;
  interval: string | null;
  proration: boolean;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface PlanChange {
  at: string;
  invoice: string | null;
  from: { tier: string | null; quantity: number | null; interval: string | null } | null;
  to: { tier: string | null; quantity: number | null; interval: string | null };
}

/**
 * Where the billed plan changed, in time order: each line on a recurring price
 * (top-ups are one-off) that is not a proration credit for unused time,
 * compared with the one before it. The first entry has
 * `from: null` (the plan they started on).
 */
export function planChanges(
  invoices: { id: string | null; lines: PlanLine[] }[]
): PlanChange[] {
  const charged = invoices
    .flatMap((inv) => inv.lines.filter((l) => l.interval && l.amountCents >= 0).map((l) => ({ ...l, invoice: inv.id })))
    .filter((l) => l.periodStart)
    .sort((a, b) => (a.periodStart! < b.periodStart! ? -1 : a.periodStart! > b.periodStart! ? 1 : 0));
  const out: PlanChange[] = [];
  let prev: (typeof charged)[number] | null = null;
  for (const l of charged) {
    const same = prev && prev.quantity === l.quantity && prev.interval === l.interval && prev.priceId === l.priceId;
    if (!same) {
      out.push({
        at: l.periodStart!,
        invoice: l.invoice,
        from: prev ? { tier: prev.tier, quantity: prev.quantity, interval: prev.interval } : null,
        to: { tier: l.tier, quantity: l.quantity, interval: l.interval },
      });
    }
    prev = l;
  }
  return out;
}

export async function loadBillingHistory(orgId: string) {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  if (!hasStripe()) return { ok: false as const, error: "Stripe is not configured." };

  const { data: row, error } = await getSupabaseAdmin()
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("org_id", orgId)
    .maybeSingle<{ stripe_customer_id: string | null }>();
  if (error) throw new Error(`subscriptions: ${error.message}`);
  const customerId = row?.stripe_customer_id;
  if (!customerId) return { ok: false as const, error: "This org has no Stripe customer, so no billing history." };

  const stripe = getStripe();
  const [subs, invoices, charges, prices] = await Promise.all([
    stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 }).autoPagingToArray({ limit: 10_000 }),
    stripe.invoices
      .list({ customer: customerId, limit: 100, expand: ["data.payments"] })
      .autoPagingToArray({ limit: 10_000 }),
    stripe.charges.list({ customer: customerId, limit: 100 }).autoPagingToArray({ limit: 10_000 }),
    stripe.prices.list({ limit: 100 }).autoPagingToArray({ limit: 10_000 }),
  ]);
  const intervalOf = new Map(prices.map((p) => [p.id, p.recurring?.interval ?? null]));

  const refundedByIntent = new Map<string, number>();
  for (const c of charges) {
    const pi = id(c.payment_intent);
    if (pi) refundedByIntent.set(pi, (refundedByIntent.get(pi) ?? 0) + c.amount_refunded);
  }

  // An invoice carries its first lines; the rest are a separate list.
  const allLines = await Promise.all(
    invoices.map(async (inv) =>
      inv.lines.has_more && inv.id
        ? stripe.invoices.listLineItems(inv.id, { limit: 100 }).autoPagingToArray({ limit: 10_000 })
        : inv.lines.data
    )
  );

  const toLine = (l: Stripe.InvoiceLineItem): PlanLine => {
    const priceId = id(l.pricing?.price_details?.price);
    return {
      description: l.description,
      amountCents: l.amount,
      quantity: l.quantity,
      tier: priceId && l.quantity != null ? recommendTier(l.quantity).label : null,
      priceId,
      interval: priceId ? (intervalOf.get(priceId) ?? null) : null,
      proration: l.parent?.subscription_item_details?.proration ?? false,
      periodStart: iso(l.period?.start),
      periodEnd: iso(l.period?.end),
    };
  };

  const history = invoices.map((inv, i) => {
    let refunded = 0;
    for (const p of inv.payments?.data ?? []) {
      const pi = id(p.payment.payment_intent);
      if (pi) refunded += refundedByIntent.get(pi) ?? 0;
    }
    return {
      id: inv.id ?? null,
      number: inv.number,
      createdAt: iso(inv.created),
      status: inv.status,
      billingReason: inv.billing_reason,
      kind: inv.metadata?.kind === "topup" ? "ai_topup" : "subscription",
      totalCents: inv.total,
      amountPaidCents: inv.amount_paid,
      amountRefundedCents: refunded,
      startingBalanceCents: inv.starting_balance,
      hostedUrl: inv.hosted_invoice_url ?? null,
      lines: allLines[i].map(toLine),
    };
  });

  return {
    ok: true as const,
    stripeCustomerId: customerId,
    subscriptions: subs.map((s) => ({
      id: s.id,
      status: s.status,
      createdAt: iso(s.created),
      startDate: iso(s.start_date),
      trialEnd: iso(s.trial_end),
      canceledAt: iso(s.canceled_at),
      endedAt: iso(s.ended_at),
      cancelAtPeriodEnd: s.cancel_at_period_end,
      pausedUntil: iso(s.pause_collection?.resumes_at),
      cancellationReason: s.cancellation_details?.reason ?? null,
      items: s.items.data.map((it) => ({
        priceId: it.price.id,
        interval: it.price.recurring?.interval ?? null,
        quantity: it.quantity ?? null,
        tier: it.quantity != null ? recommendTier(it.quantity).label : null,
      })),
    })),
    planChanges: planChanges(history),
    invoices: history,
  };
}
