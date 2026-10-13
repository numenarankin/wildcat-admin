"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertSignedIn } from "@/lib/auth/session";
import { isSeedPlatformAdmin } from "@/lib/admin/team";
import { isAdminOnlyAccount } from "@/lib/auth/admin-only";
import { generateInviteToken, hashInviteToken, inviteExpiry } from "@/lib/auth/invite";
import { sendAdminInviteEmail } from "@/lib/email/admin-invite-email";
import { cleanPages, type AdminPageKey } from "@/lib/admin/pages";

/**
 * Writes to the admin team. Seed admin only, every one of them: the roster's
 * database rule (migrations 2026091600100 and 2026101300100), repeated here
 * because these write with the service key.
 *
 * Joining is the customer app's invite flow (`lib/settings/actions.ts`
 * `inviteMember`): a pending row with a hashed single-use token, a link mailed
 * to the invitee, and the roster row created when they accept
 * (`/api/auth/accept-invite`). Nobody is put on the list without accepting.
 */

const ADMIN_SETTINGS_PATH = "/settings";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function requireSeedAdmin() {
  const me = await assertSignedIn();
  if (!(await isSeedPlatformAdmin())) {
    throw new Error("Only the seed admin can change the admin team.");
  }
  return me;
}

export interface InviteResult {
  /** Email the invite link was delivered to. */
  email: string;
}

/**
 * Invite someone onto the admin team by name + email, with the pages they may
 * open. Records a pending invite and a secure, single-use, 7-day token; only
 * the token's SHA-256 is stored, the raw token lives solely in the emailed
 * link. The link is delivered by email only, so if the email fails to send the
 * pending row is deleted rather than leave an invitee who can't be reached.
 */
export async function invitePlatformAdmin(
  name: string,
  email: string,
  pages: AdminPageKey[]
): Promise<InviteResult> {
  const me = await requireSeedAdmin();
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) throw new Error("Enter a valid email address.");
  const granted = cleanPages(pages);
  if (granted.length === 0) throw new Error("Grant at least one page before inviting.");
  const admin = getSupabaseAdmin();

  const { data: member, error: memberErr } = await admin
    .from("platform_admins")
    .select("user_id")
    .ilike("email", normalized)
    .maybeSingle();
  if (memberErr) throw new Error(`platform_admins: ${memberErr.message}`);
  if (member) throw new Error(`${normalized} is already on the admin team.`);

  const token = generateInviteToken();
  const { data: inserted, error } = await admin
    .from("platform_admin_invites")
    .insert({
      email: normalized,
      name: name.trim(),
      pages: granted,
      invite_token_hash: hashInviteToken(token),
      invite_expires_at: inviteExpiry(Date.now()),
      invited_by: me.id,
    })
    .select("id")
    .single();
  if (error) {
    // 23505 = unique_violation: the address already holds a pending invite.
    if (error.code === "23505") throw new Error(`${normalized} already has a pending invite. Resend it instead.`);
    throw new Error(`platform_admin_invites: ${error.message}`);
  }

  try {
    await sendAdminInviteEmail({ name: name.trim(), email: normalized, token });
  } catch (sendErr) {
    await admin.from("platform_admin_invites").delete().eq("id", inserted.id);
    const reason = sendErr instanceof Error ? sendErr.message : "unknown error";
    throw new Error(`Couldn't email the invite: ${reason}`);
  }

  revalidatePath(ADMIN_SETTINGS_PATH);
  return { email: normalized };
}

/** A fresh token and a fresh email for a pending invite. Seed admin only. */
export async function resendPlatformInvite(inviteId: string): Promise<InviteResult> {
  await requireSeedAdmin();
  const admin = getSupabaseAdmin();
  const { data: invite, error: readErr } = await admin
    .from("platform_admin_invites")
    .select("email, name")
    .eq("id", inviteId)
    .maybeSingle();
  if (readErr) throw new Error(`platform_admin_invites: ${readErr.message}`);
  if (!invite) throw new Error("That invite no longer exists.");

  const token = generateInviteToken();
  const { error } = await admin
    .from("platform_admin_invites")
    .update({ invite_token_hash: hashInviteToken(token), invite_expires_at: inviteExpiry(Date.now()) })
    .eq("id", inviteId);
  if (error) throw new Error(`platform_admin_invites: ${error.message}`);

  try {
    await sendAdminInviteEmail({ name: invite.name ?? "", email: invite.email, token });
  } catch (sendErr) {
    const reason = sendErr instanceof Error ? sendErr.message : "unknown error";
    throw new Error(`Couldn't email the invite: ${reason}`);
  }
  revalidatePath(ADMIN_SETTINGS_PATH);
  return { email: invite.email };
}

/** Withdraw a pending invite; its link stops working. Seed admin only. */
export async function cancelPlatformInvite(inviteId: string): Promise<void> {
  await requireSeedAdmin();
  const { error } = await getSupabaseAdmin().from("platform_admin_invites").delete().eq("id", inviteId);
  if (error) throw new Error(`platform_admin_invites: ${error.message}`);
  revalidatePath(ADMIN_SETTINGS_PATH);
}

/**
 * Replace the pages a member may open. Seed admin only; the seed row is never
 * edited (it has every page regardless). A pending invite's pages are changed
 * the same way, keyed by the invite id.
 */
export async function setPlatformAdminPages(id: string, pages: AdminPageKey[]): Promise<void> {
  await requireSeedAdmin();
  const granted = cleanPages(pages);
  const admin = getSupabaseAdmin();
  const { data: member, error } = await admin
    .from("platform_admins")
    .update({ pages: granted })
    .eq("user_id", id)
    .eq("is_seed", false)
    .select("user_id");
  if (error) throw new Error(`platform_admins: ${error.message}`);
  if (member?.length) {
    revalidatePath(ADMIN_SETTINGS_PATH);
    return;
  }
  const { data: invite, error: inviteErr } = await admin
    .from("platform_admin_invites")
    .update({ pages: granted })
    .eq("id", id)
    .select("id");
  if (inviteErr) throw new Error(`platform_admin_invites: ${inviteErr.message}`);
  if (!invite?.length) throw new Error("That member's pages cannot be changed.");
  revalidatePath(ADMIN_SETTINGS_PATH);
}

/** Take an account off the list. Seed admin only; the seed row is immutable. */
export async function removePlatformAdmin(userId: string): Promise<void> {
  await requireSeedAdmin();
  const { data, error } = await getSupabaseAdmin()
    .from("platform_admins")
    .delete()
    .eq("user_id", userId)
    .eq("is_seed", false)
    .select("user_id");
  if (error) throw new Error(`platform_admins: ${error.message}`);
  if (!data?.length) throw new Error("That admin cannot be removed.");
  // An admin-only account exists for the admin side alone, so it goes with
  // its place on the list. Any other account is left as it was.
  const { data: account } = await getSupabaseAdmin().auth.admin.getUserById(userId);
  if (isAdminOnlyAccount(account.user)) {
    const { error: deleteError } = await getSupabaseAdmin().auth.admin.deleteUser(userId);
    if (deleteError) throw new Error(`Removed from the list, but the account remains: ${deleteError.message}`);
  }
  revalidatePath(ADMIN_SETTINGS_PATH);
}
