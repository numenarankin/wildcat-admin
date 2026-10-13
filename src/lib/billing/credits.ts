import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { getBearerToken } from "@/lib/supabase/from-request";
import { getStripe } from "@/lib/billing/stripe";
import { hasStripe, hasSupabase, isPaidMode } from "@/lib/env";
import {
  DOLLARS_PER_CREDIT,
  anthropicCredits,
  anthropicWebSearchCredits,
  elevenLabsTtsCredits,
  elevenLabsSttCredits,
  providerCostUsd,
} from "@/lib/billing/tiers";

/**
 * The AI-credit gate and meter.
 *
 * Every AI entry point calls `gateAI()` BEFORE doing work, then meters the
 * actual usage AFTER the call completes (drains free credits first, then paid;
 * the last call may land the balance negative — that's intended). All balance
 * math lives in atomic SECURITY DEFINER RPCs (see the billing migration), never
 * read-then-write in JS.
 *
 * Fail policy depends on PAID_MODE:
 *   - PAID_MODE off, or Supabase not configured → fail OPEN (allow), so the app
 *     works in dev before billing is wired up.
 *   - PAID_MODE on → the balance is authoritative, so ANY failure to confirm it
 *     (RPC error/exception, missing migration, timeout) fails CLOSED (deny).
 *     Failing open here would hand out free AI on any DB hiccup.
 */

export interface GateResult {
  allowed: boolean;
  reason: string;
  orgId?: string;
  freeRemaining?: number;
  paidBalance?: number;
  balance?: number;
}

interface GateRow {
  allowed: boolean;
  reason: string;
  org_id?: string;
  free_remaining?: number;
  paid_balance?: number;
  balance?: number;
}

/**
 * The header an AI route sets when it let a request through on a negative
 * balance, and the value it carries.
 *
 * The phone cannot learn this from its own balance read: nothing invalidates it
 * when an AI call spends, so someone could work inside Orion all day and never
 * see the number move. The response that spent the credit is the one thing that
 * always arrives, so it is what carries the news.
 *
 * Absent when the balance is positive, which costs a positive-balance response
 * nothing at all.
 */
export const CREDIT_STATUS_HEADER = "x-wildcat-credits";
export const CREDIT_STATUS_OVERDRAWN = "overdrawn";

/** Spread into an AI route's response init. Empty unless the org is in debt. */
export function creditStatusHeaders(gate: GateResult): Record<string, string> {
  return gate.reason === CREDIT_STATUS_OVERDRAWN
    ? { [CREDIT_STATUS_HEADER]: CREDIT_STATUS_OVERDRAWN }
    : {};
}

/**
 * Whether THIS request is allowed to spend past zero.
 *
 * True for the phone, false for the browser, and the test is the one every
 * route already uses to tell them apart: the web app authenticates with session
 * cookies, the mobile app holds the session itself and sends
 * `Authorization: Bearer` on every call (`lib/supabase/from-request`).
 *
 * Taking a card payment inside a phone app is the thing this exists to avoid: a
 * phone that hits zero keeps working and the org is billed for what it owes,
 * while the browser, which has a top-up flow two clicks away, still stops.
 *
 * It is a request SHAPE, not a security boundary. Someone can replay their own
 * bearer token from a terminal and get the same overdraft. What they get by
 * doing so is a larger bill for their own org, and every credit of it is in
 * `credit_ledger`, so the exposure is a customer owing money rather than taking
 * anything. Background jobs and server components have no ambient request, read
 * as `false`, and keep the browser's behaviour.
 */
async function requestMayOverdraw(): Promise<boolean> {
  return (await getBearerToken()) !== null;
}

/**
 * Decide whether the current user's org may make an AI call. Resolves the org,
 * ensures the monthly grant is current, checks subscription status + a positive
 * balance — all server-side in one atomic RPC.
 *
 * A mobile request is allowed through on a zero or negative balance and comes
 * back `allowed` with `reason: "overdrawn"`, which is the caller's cue to tell
 * the user (a header the app reads; see the AI routes). An inactive
 * subscription still denies, on both clients: this is about credits, not about
 * being a customer.
 */
export async function gateAI(client?: SupabaseClient): Promise<GateResult> {
  // Master switch off → never gate (free-for-all mode).
  if (!isPaidMode()) {
    return { allowed: true, reason: "paid_mode_off" };
  }
  if (!hasSupabase()) {
    return { allowed: true, reason: "billing_disabled" };
  }
  try {
    const sb = client ?? (await getSupabaseServer());
    const { data, error } = await sb.rpc("billing_gate", {
      p_allow_overdraft: await requestMayOverdraw(),
    });
    if (error) {
      // Paid mode is ON (checked above) and Supabase is configured, so the
      // balance is authoritative and MUST be consulted. An error here (missing
      // function, RLS/permission, timeout, network) means we can't confirm the
      // org has credits — fail CLOSED. Failing open would hand out free AI on
      // any DB hiccup, e.g. before the billing migration is applied.
      console.error("gateAI: billing_gate failed, denying", error.message);
      return { allowed: false, reason: "gate_error" };
    }
    const row = data as GateRow;
    return {
      allowed: Boolean(row?.allowed),
      reason: row?.reason ?? "unknown",
      orgId: row?.org_id,
      freeRemaining: row?.free_remaining,
      paidBalance: row?.paid_balance,
      balance: row?.balance,
    };
  } catch (err) {
    // Same rationale as the error branch: paid mode is on, so an exception we
    // can't attribute to a positive balance must deny, not allow.
    console.error("gateAI: unexpected error, denying", err);
    return { allowed: false, reason: "gate_exception" };
  }
}

/**
 * Spend `amount` credits for the current user's org. Safe to call from a
 * route's `onFinish` — reuses the same request-scoped (cookie-bound) client so
 * the RPC resolves the same org. Never throws; logs and returns on failure.
 */
async function spend(
  amount: number,
  reason: string,
  meta?: Record<string, unknown>,
  client?: SupabaseClient,
  orgId?: string
): Promise<void> {
  // Don't meter when paid mode is off — no point driving balances negative.
  if (!isPaidMode() || !hasSupabase() || amount <= 0) return;
  try {
    const sb = client ?? (await getSupabaseServer());
    // With no session to resolve an org from (the background jobs), name the
    // org explicitly through the service-role-only RPC.
    const { error } = orgId
      ? await sb.rpc("billing_spend_for_org", {
          p_org: orgId,
          p_amount: amount,
          p_reason: reason,
          p_meta: meta ?? null,
        })
      : await sb.rpc("billing_spend", {
          p_amount: amount,
          p_reason: reason,
          p_meta: meta ?? null,
        });
    if (error) console.error("spend: billing_spend failed", error.message);
  } catch (err) {
    console.error("spend: unexpected error", err);
  }
}

/**
 * One Anthropic call, as the meter needs to see it.
 *
 * `creditMultiplier` is the one field that changes what the user pays; the rest
 * are token counts and cost-tracking metadata. It exists for the geology agent,
 * which prices per model — see `GEOLOGY_CREDIT_MULTIPLIER`. Omit it everywhere
 * else and the call bills at the model-blind rate.
 */
export interface AnthropicMeterUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  creditMultiplier?: number;
}

/**
 * Meter an Anthropic call from its token usage (from streamText `onFinish`).
 *
 * `inputTokens` is expected to be the TOTAL input including cache reads and
 * cache writes; the AI SDK's Anthropic provider already sums them that way
 * (`inputTokens.total = input + cache_creation + cache_read`). Cache tokens are
 * therefore billed as ordinary input, which is deliberate: a cache read costs us
 * 0.1x but bills at 1x, so caching lands as margin instead of a self-funded
 * discount. See plans/orion-effort-router.md.
 *
 * `cacheReadTokens` / `cacheWriteTokens` / `model` are optional and used only to
 * record realized vendor cost in the ledger meta (the drift guard), never to
 * price the call.
 */
export async function meterAnthropic(
  usage: AnthropicMeterUsage,
  reason: string,
  client?: SupabaseClient
): Promise<void> {
  await meterAnthropicUsage(usage, reason, client);
}

/**
 * {@link meterAnthropic} for work done with NO signed-in user: the digest
 * pre-compile cron and anything else running on the service-role client. The
 * org cannot be resolved from a session there, so it is named explicitly and
 * the spend goes through the service-role-only `billing_spend_for_org`.
 *
 * Pass the service-role client — `anon`/`authenticated` cannot execute that RPC.
 */
export async function meterAnthropicForOrg(
  orgId: string,
  usage: AnthropicMeterUsage,
  reason: string,
  client: SupabaseClient
): Promise<void> {
  await meterAnthropicUsage(usage, reason, client, orgId);
}

/** The shared body of the two meters above: price the call, then spend. */
async function meterAnthropicUsage(
  usage: AnthropicMeterUsage,
  reason: string,
  client?: SupabaseClient,
  orgId?: string
): Promise<void> {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const multiplier = usage.creditMultiplier ?? 1;
  const credits = anthropicCredits(input, output, multiplier);
  // Realized cost uses the uncached remainder plus the cache tiers at their own
  // multipliers, so it stays honest even though pricing treats them uniformly.
  const costUsd = providerCostUsd(usage.model ?? "claude-opus-5", {
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  });
  await spend(
    credits,
    reason,
    {
      provider: "anthropic",
      input,
      output,
      ...(cacheRead ? { cacheRead } : {}),
      ...(cacheWrite ? { cacheWrite } : {}),
      ...(usage.model ? { model: usage.model } : {}),
      // Recorded whenever it is not the blind rate, so a ledger row can be
      // reconciled against the token counts without knowing which call site
      // wrote it.
      ...(multiplier !== 1 ? { creditMultiplier: multiplier } : {}),
      costUsd: Number(costUsd.toFixed(6)),
    },
    client,
    orgId
  );
}

/** Compute is billed at five times its dollar cost. */
const COMPUTE_CREDIT_MARKUP = 5;

/**
 * Credits for `costUsd` of compute (docs/plans/seismic.md, "### Callback" >
 * Billing): `ceil(costUsd × 5 / DOLLARS_PER_CREDIT)`, so one compute dollar is
 * 500 credits. Zero, negative or non-finite cost is 0.
 *
 * The quotient is rounded to 6 decimals before the ceiling. In binary floating
 * point `0.17 × 5 / 0.01` is 85.00000000000001, and a bare `Math.ceil` bills
 * 86; about 6% of whole-cent costs would be overcharged a credit that way.
 */
export function computeCreditsForUsd(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  const exact = (costUsd * COMPUTE_CREDIT_MARKUP) / DOLLARS_PER_CREDIT;
  return Math.ceil(Math.round(exact * 1e6) / 1e6);
}

/**
 * Meter non-model compute (the seismic worker's GPU time) for an org, with no
 * signed-in user: the worker callback runs on the service-role client, so the
 * org is named and the spend goes through `billing_spend_for_org`, the same way
 * {@link meterAnthropicForOrg} does it.
 *
 * Pass the service-role client. Charges nothing for a zero or negative cost.
 * Never throws (see `spend`).
 */
export async function meterComputeForOrg(
  orgId: string,
  costUsd: number,
  reason: string,
  serviceClient: SupabaseClient,
  meta?: Record<string, unknown>
): Promise<void> {
  const credits = computeCreditsForUsd(costUsd);
  if (credits <= 0) return;
  await spend(
    credits,
    reason,
    { provider: "compute", costUsd: Number(costUsd.toFixed(6)), ...(meta ?? {}) },
    serviceClient,
    orgId
  );
}

/**
 * Sum Anthropic web-search requests across a streamText run's steps. Each step's
 * `providerMetadata.anthropic.usage` carries the raw Anthropic usage, including
 * `server_tool_use.web_search_requests`. Traversed defensively (shape is the
 * provider's, not ours).
 */
export function countWebSearchRequests(
  steps: ReadonlyArray<{ providerMetadata?: unknown }> | undefined
): number {
  let total = 0;
  for (const step of steps ?? []) {
    const usage = (
      step.providerMetadata as
        | {
            anthropic?: {
              usage?: { server_tool_use?: { web_search_requests?: unknown } };
            };
          }
        | undefined
    )?.anthropic?.usage?.server_tool_use?.web_search_requests;
    if (typeof usage === "number") total += usage;
  }
  return total;
}

/**
 * Sum cache-WRITE tokens across a streamText run's steps.
 *
 * The AI SDK surfaces cache reads as `usage.cachedInputTokens` but leaves writes
 * only in the provider's raw usage. Both are already inside `usage.inputTokens`
 * (the Anthropic provider sums input + cache_creation + cache_read), so this is
 * for the cost guard's breakdown, not for pricing. Traversed defensively.
 */
export function cacheWriteTokens(
  steps: ReadonlyArray<{ providerMetadata?: unknown }> | undefined
): number {
  let total = 0;
  for (const step of steps ?? []) {
    const written = (
      step.providerMetadata as
        | {
            anthropic?: {
              usage?: { cache_creation_input_tokens?: unknown };
            };
          }
        | undefined
    )?.anthropic?.usage?.cache_creation_input_tokens;
    if (typeof written === "number") total += written;
  }
  return total;
}

/** Meter Anthropic web searches (provider-executed, billed separately by token). */
export async function meterAnthropicWebSearch(
  requests: number,
  reason: string,
  client?: SupabaseClient
): Promise<void> {
  if (requests <= 0) return;
  await spend(
    anthropicWebSearchCredits(requests),
    reason,
    { provider: "anthropic", kind: "web_search", requests },
    client
  );
}

/** Meter an ElevenLabs text-to-speech call by character count. */
export async function meterElevenLabsTts(
  chars: number,
  reason: string,
  client?: SupabaseClient
): Promise<void> {
  await spend(elevenLabsTtsCredits(chars), reason, {
    provider: "elevenlabs",
    kind: "tts",
    chars,
  }, client);
}

/** Meter an ElevenLabs speech-to-text (transcription) call. */
export async function meterElevenLabsStt(
  reason: string,
  client?: SupabaseClient
): Promise<void> {
  await spend(elevenLabsSttCredits(), reason, {
    provider: "elevenlabs",
    kind: "stt",
  }, client);
}

export interface CreditBalance {
  freeRemaining: number;
  paidBalance: number;
  total: number;
}

/**
 * Grant the org's monthly free credits, anchored to its signup anniversary
 * (organizations.created_at). Runs on every authenticated page load via
 * getCreditBalance, but the cheap `billing_reset_due` check short-circuits on
 * all but the ~once-a-month load when a grant is actually owed; only then do we
 * read Stripe to confirm the subscription is still active/trialing before
 * applying it. Best-effort: never throws into the layout.
 */
async function ensureMonthlyCredits(sb: SupabaseClient): Promise<void> {
  if (!isPaidMode() || !hasStripe()) return;
  try {
    const { data, error } = await sb.rpc("billing_reset_due");
    if (error) {
      console.error("[monthly-credits] billing_reset_due failed:", error.message);
      return;
    }
    const due = data as {
      due: boolean;
      reason?: string;
      org_id?: string;
      subscription_id?: string | null;
      sub_status?: string;
      period_start?: string;
      credits_period_start?: string | null;
    };
    if (!due?.due) return;
    // No subscription to check against — nothing to grant. Silent: this fires on
    // every page load for an unsubscribed org, and logging it floods the console.
    if (!due.org_id || !due.subscription_id) return;

    // Due this period — confirm they're still subscribed + paying before granting.
    const sub = await getStripe().subscriptions.retrieve(due.subscription_id);
    if (sub.status !== "active" && sub.status !== "trialing") return;

    // Service-role: the grant fn is locked to service_role so the Stripe check
    // above can't be skipped by a client calling it directly.
    const { error: applyErr } = await getSupabaseAdmin().rpc("billing_apply_reset", {
      p_org: due.org_id,
    });
    if (applyErr) {
      console.error("[monthly-credits] billing_apply_reset failed:", applyErr.message);
      return;
    }
    console.info("[monthly-credits] granted monthly credits to org", due.org_id);
  } catch (err) {
    console.error("[monthly-credits] unexpected error", err);
  }
}

/** Read the current org's credit balance for display (RLS-scoped). */
export async function getCreditBalance(): Promise<CreditBalance | null> {
  if (!hasSupabase()) return null;
  try {
    const sb = await getSupabaseServer();
    await ensureMonthlyCredits(sb);
    const { data, error } = await sb
      .from("org_credits")
      .select("free_remaining, paid_balance")
      .maybeSingle();
    if (error || !data) return null;
    const free = Number(data.free_remaining ?? 0);
    const paid = Number(data.paid_balance ?? 0);
    return { freeRemaining: free, paidBalance: paid, total: free + paid };
  } catch {
    return null;
  }
}
