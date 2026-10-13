/**
 * Server-only data access for org members. Kept separate from `./org` (pure
 * types + the permission catalog) so the client components that import the
 * catalog don't drag the request-scoped Supabase client — and `next/headers` —
 * into the browser bundle.
 */

import { hasSupabase } from "@/lib/env";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import {
  cleanPermissions,
  type MemberStatus,
  type OrgMember,
} from "@/lib/settings/org";

interface OrgMemberRow {
  id: string;
  name: string | null;
  email: string;
  is_owner: boolean;
  permissions: string[] | null;
  status: string;
  removed_at: string | null;
  avatar_url: string | null;
  auth_user_id: string | null;
  early_access: boolean | null;
}

function mapMember(r: OrgMemberRow, profileName?: string): OrgMember {
  return {
    id: r.id,
    // Prefer the member's actual profile name (full name) over the name typed
    // at invite time; fall back to that, then to the email in the UI.
    name: profileName ?? r.name ?? "",
    email: r.email,
    isOwner: r.is_owner,
    // Drop unknown/legacy keys so the UI only ever sees valid ones.
    permissions: cleanPermissions(r.permissions ?? []),
    status: r.status as MemberStatus,
    removedAt: r.removed_at ?? null,
    avatarUrl: r.avatar_url ?? null,
    earlyAccess: r.early_access === true,
  };
}

/** List org members: the owner first, then most-recently-added. */
export async function getOrgMembers(): Promise<OrgMember[]> {
  if (!hasSupabase()) return [];
  try {
    const sb = await getSupabaseServer();
    const { data, error } = await sb
      .from("org_members")
      .select(
        "id, name, email, is_owner, permissions, status, removed_at, avatar_url, auth_user_id, early_access"
      )
      .order("created_at", { ascending: true });
    if (error) throw error;
    const rows = (data ?? []) as OrgMemberRow[];

    // Resolve each joined member's full name from their profile. Profiles are
    // RLS-scoped to their owner, so we read with the admin client, limited to
    // the auth users already confirmed as members of this (RLS-scoped) org.
    // The owner's member row in particular carries no invite name at all.
    const userIds = rows
      .map((r) => r.auth_user_id)
      .filter((id): id is string => Boolean(id));
    const nameByUser = new Map<string, string>();
    if (userIds.length) {
      const { data: profiles } = await getSupabaseAdmin()
        .from("profile")
        .select("user_id, name")
        .in("user_id", userIds);
      for (const p of (profiles ?? []) as {
        user_id: string;
        name: string | null;
      }[]) {
        if (p.name?.trim()) nameByUser.set(p.user_id, p.name.trim());
      }
    }

    const members = rows.map((r) =>
      mapMember(r, r.auth_user_id ? nameByUser.get(r.auth_user_id) : undefined)
    );
    // Owner(s) pinned to the top regardless of insertion order.
    return members.sort((a, b) => {
      if (a.isOwner && !b.isOwner) return -1;
      if (b.isOwner && !a.isOwner) return 1;
      return 0;
    });
  } catch (error) {
    console.error("getOrgMembers failed", error);
    return [];
  }
}
