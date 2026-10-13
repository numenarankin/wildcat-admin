/**
 * Server-only validation of an admin invite token for rendering the accept
 * page. The customer app's `lib/auth/invite-data.ts` over `platform_admin_invites`.
 *
 * Mirrors the checks the accept route enforces (hash match, not expired) but
 * read-only: it tells the page whether to show the form (and for which email)
 * or an error. The authoritative re-check happens in the accept route; never
 * trust a page-load validation alone.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { hashInviteToken } from "@/lib/auth/invite";

export type InviteLookup =
  | {
      ok: true;
      email: string;
      name: string;
      /**
       * This address already has a WildcatIQ account (a customer, or staff who
       * also use the app). They join the admin team with the account they have
       * instead of setting a password for a new one.
       */
      hasAccount: boolean;
    }
  | { ok: false; reason: "invalid" | "expired" | "unavailable" };

/** Validate a raw invite token; returns the invited email when usable. */
export async function lookupInvite(token: string): Promise<InviteLookup> {
  if (!hasSupabase()) return { ok: false, reason: "unavailable" };
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("platform_admin_invites")
      .select("email, name, invite_expires_at")
      .eq("invite_token_hash", hashInviteToken(token))
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, reason: "invalid" };

    const row = data as { email: string; name: string; invite_expires_at: string };
    if (Date.parse(row.invite_expires_at) < Date.now()) {
      return { ok: false, reason: "expired" };
    }
    const { data: existingId } = await admin.rpc("auth_user_id_by_email", { addr: row.email });
    return { ok: true, email: row.email, name: row.name, hasAccount: Boolean(existingId) };
  } catch (err) {
    console.error("lookupInvite failed", err);
    return { ok: false, reason: "unavailable" };
  }
}
