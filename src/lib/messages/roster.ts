import "server-only";

import { hasSupabase } from "@/lib/env";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { getAvatarUrls } from "@/lib/settings/profile";
import { initialsOf, type ChatUser } from "@/lib/messages/types";

interface MemberRow {
  auth_user_id: string | null;
  name: string | null;
  email: string;
  avatar_url: string | null;
}

/**
 * Everyone in the org who can be messaged: active members with an auth account.
 *
 * Invited-but-unaccepted members are excluded because they have no
 * `auth_user_id` to key a membership row off, and removed members because
 * `status = 'removed'` is exactly what revokes org access everywhere else
 * (2026080904000_member_offboarding.sql).
 *
 * Names come from `profile` for the same reason `getOrgMembers` reads them
 * there: the invite-time name is often blank or a placeholder, and the owner's
 * member row carries none at all. Profiles are RLS-scoped to their owner, so
 * the lookup uses the admin client, limited to auth ids that RLS has already
 * confirmed are members of this org.
 */
export async function getOrgRoster(): Promise<ChatUser[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("org_members")
    .select("auth_user_id, name, email, avatar_url")
    .eq("status", "active");
  if (error) throw new Error(`getOrgRoster: ${error.message}`);

  const rows = ((data ?? []) as MemberRow[]).filter(
    (r): r is MemberRow & { auth_user_id: string } => Boolean(r.auth_user_id)
  );
  if (rows.length === 0) return [];

  const nameByUser = new Map<string, string>();
  // Avatars come from `profile` for the same reason names do, and additionally
  // because nothing ever writes `org_members.avatar_url` — saving a profile
  // picture updates `profile.avatar_url` alone, so the member column is null on
  // every real account and was rendering initials for everyone.
  const [{ data: profiles }, avatarByUser] = await Promise.all([
    getSupabaseAdmin()
      .from("profile")
      .select("user_id, name")
      .in(
        "user_id",
        rows.map((r) => r.auth_user_id)
      ),
    getAvatarUrls(rows.map((r) => r.auth_user_id)),
  ]);
  for (const p of (profiles ?? []) as { user_id: string; name: string | null }[]) {
    if (p.name?.trim()) nameByUser.set(p.user_id, p.name.trim());
  }

  return rows
    .map((r) => {
      // Last resort is the local part of the email: a person with no name
      // anywhere still has to be pickable in the roster, and "" is not.
      const name =
        nameByUser.get(r.auth_user_id) ??
        (r.name?.trim() || r.email.split("@")[0] || "Member");
      return {
        id: r.auth_user_id,
        name,
        initials: initialsOf(name),
        avatarUrl: avatarByUser.get(r.auth_user_id) ?? r.avatar_url,
      } satisfies ChatUser;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
