/**
 * Per-org referral codes.
 *
 * Each organization gets its own shareable code, generated server-side when the
 * admin account is created. The code is a 6-digit hexadecimal string. Codes are
 * unique: we check for a collision before use and the `organizations.referral_code`
 * unique constraint is the final backstop if two sign-ups race.
 *
 * Server-only: every function here uses the secret (service-role) client, which
 * is necessary at sign-up time because the new org row doesn't exist yet and the
 * request has no authenticated session to satisfy RLS.
 */

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_ATTEMPTS = 5;

/** A fresh 6-hex referral code (lowercase storage; display uppercase in UI). */
export function generateReferralCode(): string {
  return randomBytes(3).toString("hex");
}

/**
 * A referral code not currently held by any org. Retries on the (astronomically
 * unlikely) collision; throws after a few attempts rather than loop forever.
 */
export async function uniqueReferralCode(
  admin: SupabaseClient
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateReferralCode();
    const { data, error } = await admin
      .from("organizations")
      .select("id")
      .eq("referral_code", code)
      .maybeSingle();
    if (error) throw new Error(`uniqueReferralCode: ${error.message}`);
    if (!data) return code;
  }
  throw new Error("uniqueReferralCode: could not find a free code");
}

/**
 * Resolve a referral code submitted at admin sign-up to the org that owns it.
 * Returns null for an empty or unknown code — an invalid referral must never
 * fail the sign-up, it just means no referral is recorded.
 *
 * The org NAME comes back too so the sign-up form can say who referred you
 * ("Referred by Acme Oil") rather than echoing an opaque code. That matters
 * now that the code can be typed by hand: silently dropping a mistyped code
 * would leave someone believing they had claimed credit.
 */
export async function resolveReferral(
  admin: SupabaseClient,
  code: string | null | undefined
): Promise<{ orgId: string; orgName: string | null } | null> {
  const normalized = code?.trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await admin
    .from("organizations")
    .select("id, name")
    .eq("referral_code", normalized)
    .maybeSingle<{ id: string; name: string | null }>();
  if (error) {
    // Fail soft: a lookup error drops the referral, never blocks sign-up.
    console.error("resolveReferral lookup failed", error);
    return null;
  }
  return data ? { orgId: data.id, orgName: data.name } : null;
}

/**
 * Is this sign-up someone referring themselves?
 *
 * The attack is one person creating a second org with their own code, so the
 * test is membership, not org identity: the two org rows are always different.
 * docs/plans/billing.md §5 called for this guard ("no self-referral") and it was
 * never built; it matters more now that the reward is cash-like platform credit
 * rather than a trial extension.
 *
 * Fails OPEN (returns false) on a lookup error: a legitimate sign-up must never
 * be blocked by this check, and the payout still requires a paid invoice.
 */
export async function isSelfReferral(
  admin: SupabaseClient,
  referrerOrgId: string,
  email: string | null | undefined
): Promise<boolean> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !referrerOrgId) return false;
  try {
    const { data, error } = await admin
      .from("org_members")
      .select("id")
      .eq("org_id", referrerOrgId)
      .ilike("email", normalized)
      .limit(1);
    if (error) {
      console.error("isSelfReferral lookup failed", error.message);
      return false;
    }
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
