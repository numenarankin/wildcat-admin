"use server";

import { createHash, randomBytes } from "node:crypto";
import { headers } from "next/headers";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getAppUrl } from "@/lib/env";
import { sendResetEmail } from "@/lib/email/reset-email";
import { sendPasswordChangedEmail } from "@/lib/email/password-changed-email";
import { getSessionUser } from "@/lib/auth/session";
import { maskEmail } from "@/lib/auth/mask-email";
import {
  RECOVERY_TOKEN_TTL_MS,
  RECOVERY_WINDOW_MS,
  hasUsableQuery,
  isThrottled,
  normalizeCompany,
  normalizePhone,
  type RecoveryKind,
  type RecoveryMatch,
  type RecoveryResult,
} from "@/lib/auth/recovery-core";

/**
 * Account recovery, server side.
 *
 * Two entry points, both reachable without a session (the whole point is that
 * the caller cannot get one):
 *
 *   `recoverEmail`   — company name or phone in, masked addresses out.
 *   `requestPasswordReset` / `sendRecoveredReset` — mail a reset link, either to
 *                      an address the caller typed or to one `recoverEmail`
 *                      found and handed back only as an opaque token.
 *
 * Both are public endpoints in practice — a server action is an HTTP POST anyone
 * can replay — so every one of them is IP-throttled, and none of them ever
 * reports whether an account exists. `requestPasswordReset` returns the same
 * success for a real address, a typo, and a stranger's address; the difference
 * shows up only in whether mail arrives.
 */

/** Cap on how many accounts one query can surface. */
const MAX_MATCHES = 3;

/**
 * Best guess at the caller's IP. `x-forwarded-for` is a comma-separated chain
 * appended to by each hop, so the first entry is the client. Falls back to a
 * constant, which throttles all unknown-IP traffic as one bucket — the safe
 * direction to fail, since the alternative is an unlimited bucket per request.
 */
async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Record an attempt and report whether this one is over the limit. Counts first,
 * then writes, so the request being judged is not included in its own count.
 *
 * Best-effort: if the attempts table cannot be read we let the request through
 * rather than locking every user out of recovery over a bookkeeping failure.
 */
async function spendAttempt(kind: RecoveryKind): Promise<boolean> {
  const ip = await clientIp();
  const admin = getSupabaseAdmin();
  const since = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();

  const { count, error } = await admin
    .from("account_recovery_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .eq("kind", kind)
    .gte("attempted_at", since);

  if (error) {
    console.error("[account-recovery] attempt count failed:", error.message);
    return false;
  }

  if (isThrottled(kind, count ?? 0)) return true;

  const { error: insertError } = await admin
    .from("account_recovery_attempts")
    .insert({ ip, kind });
  if (insertError) {
    console.error("[account-recovery] attempt insert failed:", insertError.message);
  }
  return false;
}

/** Drop attempt rows and handles that no longer bind anything. Best-effort. */
async function sweepExpired(): Promise<void> {
  const admin = getSupabaseAdmin();
  const staleAttempts = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  await Promise.allSettled([
    admin.from("account_recovery_attempts").delete().lt("attempted_at", staleAttempts),
    admin.from("account_recovery_tokens").delete().lt("expires_at", new Date().toISOString()),
  ]);
}

/** Hash a recovery handle for storage/lookup — only the hash is ever persisted. */
function hashToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

/**
 * Find the sign-in addresses behind a company name or a phone number, masked.
 *
 * The real addresses never leave this function: each match is paired with a
 * fresh single-use token, and `sendRecoveredReset` is the only thing that can
 * turn one back into an email — by sending to it, never by returning it.
 */
export async function recoverEmail(input: {
  company?: string;
  phone?: string;
}): Promise<RecoveryResult> {
  const company = normalizeCompany(input.company ?? "");
  const phone = normalizePhone(input.phone ?? "");

  // A blank form is not an attempt worth spending or a query worth running.
  if (!hasUsableQuery(input.company ?? "", input.phone ?? "")) {
    return { matches: [], throttled: false };
  }

  if (await spendAttempt("lookup")) return { matches: [], throttled: true };

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc("account_recovery_lookup", {
    p_company: company || null,
    p_phone: phone || null,
    p_limit: MAX_MATCHES,
  });

  if (error) {
    console.error("[account-recovery] lookup failed:", error.message);
    return { matches: [], throttled: false };
  }

  const rows = (data ?? []) as Array<{
    email: string;
    org_name: string | null;
    score: number;
  }>;
  if (rows.length === 0) return { matches: [], throttled: false };

  const expiresAt = new Date(Date.now() + RECOVERY_TOKEN_TTL_MS).toISOString();
  const matches: RecoveryMatch[] = [];

  for (const row of rows.slice(0, MAX_MATCHES)) {
    const token = randomBytes(32).toString("hex");
    const { error: tokenError } = await admin
      .from("account_recovery_tokens")
      .insert({ token_hash: hashToken(token), email: row.email, expires_at: expiresAt });
    if (tokenError) {
      // Without a handle the row is a dead end — showing it would offer a
      // "send the link here" button that cannot work.
      console.error("[account-recovery] token insert failed:", tokenError.message);
      continue;
    }
    matches.push({
      maskedEmail: maskEmail(row.email),
      company: row.org_name,
      token,
    });
  }

  void sweepExpired();
  return { matches, throttled: false };
}

/**
 * Mail a Supabase recovery link to `email`.
 *
 * Silent about everything: an unknown address, an unconfigured mailer, and a
 * Brevo outage all look identical to the caller, because the alternative is an
 * endpoint that answers "does this person have an account here?".
 */
async function mailResetLink(email: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: `${getAppUrl().replace(/\/$/, "")}/auth/reset` },
  });

  if (error || !data?.properties?.hashed_token) {
    // Overwhelmingly "user not found", which is not an error condition here.
    console.info("[account-recovery] no reset link issued for this address");
    return;
  }

  try {
    await sendResetEmail({ email, tokenHash: data.properties.hashed_token });
  } catch (err) {
    console.error("[account-recovery] reset email delivery failed:", err);
  }
}

/**
 * Start a password reset for a typed-in address.
 *
 * Always resolves the same way. `throttled` is the one honest signal, and it
 * describes the caller's IP rather than the account, so it discloses nothing.
 */
export async function requestPasswordReset(
  email: string
): Promise<{ throttled: boolean }> {
  const address = email.trim().toLowerCase();
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { throttled: false };
  }

  if (await spendAttempt("reset")) return { throttled: true };

  await mailResetLink(address);
  return { throttled: false };
}

/**
 * Start a password reset for an address the caller was only ever shown masked.
 *
 * Redeems the handle from `recoverEmail`: single use (deleted before the mail
 * goes out, so a replay cannot fan out into repeated sends) and short-lived.
 */
export async function sendRecoveredReset(
  token: string
): Promise<{ ok: boolean; throttled: boolean }> {
  if (!token.trim()) return { ok: false, throttled: false };
  if (await spendAttempt("reset")) return { ok: false, throttled: true };

  const admin = getSupabaseAdmin();
  // Delete-returning is the atomic form of "check it, then burn it": two
  // concurrent replays cannot both come back with a row.
  const { data, error } = await admin
    .from("account_recovery_tokens")
    .delete()
    .eq("token_hash", hashToken(token))
    .gte("expires_at", new Date().toISOString())
    .select("email")
    .maybeSingle<{ email: string }>();

  if (error) {
    console.error("[account-recovery] token redemption failed:", error.message);
    return { ok: false, throttled: false };
  }
  if (!data?.email) return { ok: false, throttled: false };

  await mailResetLink(data.email);
  return { ok: true, throttled: false };
}

/**
 * Tell the account holder their password was just reset.
 *
 * Called by `/auth/reset` once the new password is set. A reset is the one
 * password change that can be driven end to end by someone who is not the
 * account holder — they only need the inbox — so the notice matters more here
 * than in Settings, not less.
 *
 * Mails only the signed-in caller's own address (the recovery session minted by
 * `verifyOtp` seconds earlier), so it cannot be pointed at anyone else. Silent
 * on every failure: the password has already changed and the page must not
 * report otherwise.
 */
export async function notifyPasswordReset(): Promise<void> {
  try {
    const user = await getSessionUser();
    if (!user?.email) return;
    await sendPasswordChangedEmail({ email: user.email, via: "reset" });
  } catch (err) {
    console.error("[account-recovery] reset notice delivery failed:", err);
  }
}

/**
 * Does an account exist for this address?
 *
 * Sign-in failure is otherwise one message for two different problems, and
 * "invalid login credentials" sends someone with a typo in their address off to
 * reset a password that was never wrong. This is the deliberate exception to the
 * rule the rest of this file follows: it DOES report whether an account exists,
 * which is account enumeration by design, so it is throttled on the same bucket
 * as the lookup and is only ever consulted after a failed sign-in attempt (which
 * GoTrue rate-limits in its own right).
 *
 * Reads `org_members.email`, which the `auth_users_sync_member_email` trigger
 * keeps in step with `auth.users`. Answers `null` when it cannot tell, so the
 * caller falls back to the generic message rather than asserting something wrong.
 */
export async function accountExists(email: string): Promise<boolean | null> {
  const address = email.trim().toLowerCase();
  if (!address) return null;
  if (await spendAttempt("lookup")) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("org_members")
    .select("id")
    .eq("email", address)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    console.error("[account-recovery] account lookup failed:", error.message);
    return null;
  }
  return Boolean(data);
}
