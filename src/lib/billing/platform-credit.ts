import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";

/**
 * Platform credit — a USD balance (in cents) an org holds on our platform,
 * spendable on AI credit top-ups and on subscription invoices.
 *
 * Granted as the referral reward to BOTH sides (see `maybeRewardReferrer`).
 * It is not cash: never refundable, never transferable, forfeited on org
 * deletion. It is also not AI credits — those are a usage unit at $0.01 each.
 * Platform credit BUYS AI credits; keeping the denominations separate is what
 * makes "how much do I owe" answerable.
 *
 * All arithmetic lives in the SECURITY DEFINER RPCs from
 * `2026080905000_platform_credit.sql`, never read-then-write in JS: two spend
 * paths (invoice application and a top-up) can run concurrently, and the RPC's
 * row lock is what stops them draining the same cents twice. The write helpers
 * therefore require the SERVICE-ROLE client — the RPCs are revoked from
 * `authenticated`, so a session client would just get a permission error.
 *
 * See docs/plans/referral-platform-credit.md.
 */

/** Ledger entry kinds, mirroring the SQL check constraint. */
export type PlatformCreditKind =
  | "referral_grant"
  | "adjustment"
  | "spend_topup"
  | "spend_invoice"
  | "reverse_topup"
  | "reverse_invoice"
  | "referral_clawback"
  | "forfeit_cancel";

export interface PlatformCreditEntry {
  id: string;
  deltaCents: number;
  kind: PlatformCreditKind;
  reason: string | null;
  invoiceId: string | null;
  createdAt: string;
}

export interface PlatformCreditSummary {
  balanceCents: number;
  entries: PlatformCreditEntry[];
}

interface LedgerRow {
  id: string;
  delta_cents: number | string | null;
  kind: PlatformCreditKind;
  reason: string | null;
  stripe_invoice_id: string | null;
  created_at: string;
}

/**
 * The caller's org balance in cents, read under RLS. Fails soft to 0: this
 * value is display-only and must never gate a spend — the RPC is the authority
 * on what can actually be spent, so a stale or failed read can only under-show
 * a balance, never overspend one.
 */
export async function getPlatformCreditBalance(): Promise<number> {
  try {
    // Inside the try on purpose: this read is display-only, so nothing it
    // touches — including a misconfigured environment — may throw into a
    // caller. `chargeTopUp` quotes a split with it and must never fail on it.
    if (!hasSupabase()) return 0;
    const sb = await getSupabaseServer();
    const { data, error } = await sb
      .from("org_credits")
      .select("platform_cents")
      .maybeSingle<{ platform_cents: number | string | null }>();
    if (error || !data) return 0;
    return Number(data.platform_cents ?? 0);
  } catch {
    return 0;
  }
}

/** Balance plus the most recent ledger entries, for the Referral settings tab. */
export async function getPlatformCredit(
  limit = 20
): Promise<PlatformCreditSummary> {
  try {
    if (!hasSupabase()) return { balanceCents: 0, entries: [] };
    const sb = await getSupabaseServer();
    const [balance, ledger] = await Promise.all([
      getPlatformCreditBalance(),
      sb
        .from("platform_credit_ledger")
        .select("id, delta_cents, kind, reason, stripe_invoice_id, created_at")
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);
    const rows = (ledger.data ?? []) as LedgerRow[];
    return {
      balanceCents: balance,
      entries: rows.map((r) => ({
        id: r.id,
        deltaCents: Number(r.delta_cents ?? 0),
        kind: r.kind,
        reason: r.reason,
        invoiceId: r.stripe_invoice_id,
        createdAt: r.created_at,
      })),
    };
  } catch {
    return { balanceCents: 0, entries: [] };
  }
}

/**
 * Grant credit to an org. Service-role only. Returns the new balance in cents,
 * or 0 if the grant could not be recorded.
 */
export async function addPlatformCredit(
  admin: SupabaseClient,
  orgId: string,
  cents: number,
  kind: Extract<
    PlatformCreditKind,
    "referral_grant" | "adjustment" | "reverse_topup"
  >,
  reason: string,
  meta?: Record<string, unknown>
): Promise<number> {
  if (!orgId || !Number.isFinite(cents) || cents <= 0) return 0;
  const { data, error } = await admin.rpc("platform_credit_add", {
    p_org: orgId,
    p_cents: Math.round(cents),
    p_kind: kind,
    p_reason: reason,
    p_meta: meta ?? null,
  });
  if (error) {
    console.error("addPlatformCredit failed", error.message);
    return 0;
  }
  return Number(data ?? 0);
}

/**
 * Spend up to `cents` of an org's balance. Returns the cents ACTUALLY spent,
 * which the caller must use rather than assuming the full amount: the RPC
 * clamps to the live balance, and returns 0 outright when `invoiceId` already
 * has a spend recorded (the Stripe webhook-retry guard).
 *
 * Returns 0 on error, which is the safe direction: the purchase or invoice then
 * falls back to charging the card in full rather than silently eating credit.
 */
export async function spendPlatformCredit(
  admin: SupabaseClient,
  orgId: string,
  cents: number,
  kind: Extract<PlatformCreditKind, "spend_topup" | "spend_invoice">,
  reason: string,
  invoiceId?: string | null
): Promise<number> {
  if (!orgId || !Number.isFinite(cents) || cents <= 0) return 0;
  const { data, error } = await admin.rpc("platform_credit_spend", {
    p_org: orgId,
    p_cents: Math.round(cents),
    p_kind: kind,
    p_reason: reason,
    p_invoice: invoiceId ?? null,
  });
  if (error) {
    console.error("spendPlatformCredit failed", error.message);
    return 0;
  }
  return Number(data ?? 0);
}

/**
 * Put back credit spent on an invoice that was voided or written off. Returns
 * the cents restored (0 if there was no spend, or it was already reversed).
 *
 * Stripe reinstates its own applied balance on void, so the caller must ALSO
 * drain that back to zero — see the webhook's void handler.
 */
export async function reversePlatformCredit(
  admin: SupabaseClient,
  orgId: string,
  invoiceId: string,
  reason = "invoice voided"
): Promise<number> {
  if (!orgId || !invoiceId) return 0;
  const { data, error } = await admin.rpc("platform_credit_reverse", {
    p_org: orgId,
    p_invoice: invoiceId,
    p_reason: reason,
  });
  if (error) {
    console.error("reversePlatformCredit failed", error.message);
    return 0;
  }
  return Number(data ?? 0);
}

/**
 * Take back up to `cents` of an org's balance, returning what was actually
 * removed. Used when a referred org leaves before its first billing month: the
 * referrer keeps every other referral, but loses this one.
 *
 * The amount recovered can be less than the grant. Credit is spendable the
 * moment it lands, so a referrer who already spent part of it is only clawed
 * back to zero — never into debt. That shortfall is the accepted cost of paying
 * at signup rather than at conversion.
 */
export async function clawbackPlatformCredit(
  admin: SupabaseClient,
  orgId: string,
  cents: number,
  reason: string,
  meta?: Record<string, unknown>
): Promise<number> {
  if (!orgId || !Number.isFinite(cents) || cents <= 0) return 0;
  const { data, error } = await admin.rpc("platform_credit_clawback", {
    p_org: orgId,
    p_cents: Math.round(cents),
    p_reason: reason,
    p_meta: meta ?? null,
  });
  if (error) {
    console.error("clawbackPlatformCredit failed", error.message);
    return 0;
  }
  return Number(data ?? 0);
}

/**
 * Zero an org's balance because it cancelled its subscription — platform credit
 * is only spendable on the platform, so it does not outlive membership.
 * Returns the cents removed (0 when there was nothing left, the common case).
 */
export async function forfeitPlatformCredit(
  admin: SupabaseClient,
  orgId: string,
  reason = "subscription cancelled"
): Promise<number> {
  if (!orgId) return 0;
  const { data, error } = await admin.rpc("platform_credit_forfeit", {
    p_org: orgId,
    p_reason: reason,
  });
  if (error) {
    console.error("forfeitPlatformCredit failed", error.message);
    return 0;
  }
  return Number(data ?? 0);
}
