/**
 * Server-side resolver for the signed-in user's EFFECTIVE org permissions.
 *
 * This is the source of truth the UI reads to decide what to show. It mirrors
 * the database RLS rules (which remain the real enforcement boundary): the org
 * owner gets everything; a member gets their granted capabilities, expanded so
 * `admin` implies all and each `manage_*` implies its `view_*` counterpart.
 *
 * Server-only (request-scoped Supabase + `next/headers`). Client components read
 * the resolved list through the `PermissionsProvider` context instead.
 */

import { hasSupabase } from "@/lib/env";
import { memoRender } from "@/lib/cache/render-cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { getActiveOrgId } from "@/lib/auth/orgs";
import {
  ALL_PERMISSION_KEYS,
  cleanPermissions,
  expandPermissions,
  type PermissionKey,
} from "@/lib/settings/org";

export interface CurrentPermissions {
  isOwner: boolean;
  /** Fully expanded effective permission keys (catalog order). */
  permissions: PermissionKey[];
}

/**
 * Resolve the current user's effective permissions. Without Supabase configured
 * (local dev), grant everything so the app is fully usable. A signed-out user
 * gets nothing.
 */
export function getCurrentPermissions(): Promise<CurrentPermissions> {
  // Resolved twice per page render, once by the layout and once by the page's
  // `requirePermission`, each costing a session round trip plus two queries.
  // `memoRender` spans both, which `memoScope` alone could not.
  return currentPermissions();
}

const currentPermissions = memoRender("current-permissions", loadCurrentPermissions);

async function loadCurrentPermissions(): Promise<CurrentPermissions> {
  if (!hasSupabase()) {
    return { isOwner: true, permissions: [...ALL_PERMISSION_KEYS] };
  }

  try {
    /*
     * WHICH org, beside WHO. A user can be in several (see
     * `2026081700100_multi_org.sql`), and permissions are per org: an owner in
     * one workspace can be a read-only pumper in the next. Resolving the
     * membership without naming the org used to answer with whichever row came
     * back first, and with two of them the read errored into "no permissions"
     * at all. The org RPC needs only the request's token, not the user object,
     * so the two go out together; then the owner and member reads go out
     * together too, since both need only (org, user). Four serial round trips
     * became two on every gated page.
     */
    const [user, activeOrgId, sb] = await Promise.all([
      getSessionUser(),
      getActiveOrgId(),
      getSupabaseServer(),
    ]);
    if (!user) return { isOwner: false, permissions: [] };
    if (!activeOrgId) return { isOwner: false, permissions: [] };

    const [{ data: org }, { data: member }] = await Promise.all([
      // Owner of THIS org? Owners bypass capability checks entirely.
      sb
        .from("organizations")
        .select("id")
        .eq("id", activeOrgId)
        .eq("owner_uid", user.id)
        .maybeSingle(),
      // Otherwise their active membership row IN THIS ORG (RLS lets a member
      // read their own row via `auth_user_id = auth.uid()`).
      sb
        .from("org_members")
        .select("permissions, is_owner")
        .eq("org_id", activeOrgId)
        .eq("auth_user_id", user.id)
        .eq("status", "active")
        .maybeSingle(),
    ]);
    if (org) return { isOwner: true, permissions: [...ALL_PERMISSION_KEYS] };

    if (!member) return { isOwner: false, permissions: [] };
    if (member.is_owner) {
      return { isOwner: true, permissions: [...ALL_PERMISSION_KEYS] };
    }

    const granted = cleanPermissions((member.permissions ?? []) as string[]);
    return { isOwner: false, permissions: expandPermissions(granted) };
  } catch (error) {
    console.error("getCurrentPermissions failed", error);
    return { isOwner: false, permissions: [] };
  }
}

/** True if the user effectively holds any of the given permission(s). */
export async function userCan(
  permission: PermissionKey | PermissionKey[]
): Promise<boolean> {
  const { permissions } = await getCurrentPermissions();
  const wanted = Array.isArray(permission) ? permission : [permission];
  const held = new Set(permissions);
  return wanted.some((p) => held.has(p));
}

/**
 * Page guard: answer 404 if the user lacks ALL of the given permission(s). Pass
 * an array to mean "any of these grants access". No-op when Supabase is
 * unconfigured (dev gets full access via {@link getCurrentPermissions}).
 *
 * 404 rather than a redirect home, to match the sidebar: a page a member cannot
 * open is not listed for them, and typing its address finds nothing. A redirect
 * to `/` looked like the app had malfunctioned, and it made the front door's
 * own destination logic load-bearing for correctness (a mistake there and the
 * two routes volley).
 *
 * PAGES ONLY. A route handler must answer JSON, so it uses
 * {@link forbidUnlessPermitted}; a server action throws instead.
 */
export async function requirePermission(
  permission: PermissionKey | PermissionKey[]
): Promise<void> {
  if (await userCan(permission)) return;
  // Import lazily so merely importing this module doesn't eagerly pull in
  // `next/navigation` (its app-router context calls React.createContext, which
  // isn't available under the `react-server` condition our unit tests load with).
  const { notFound } = await import("next/navigation");
  notFound();
}

/**
 * Server-action guard for ORG SETTINGS: throws unless the caller is the org
 * owner or holds the `admin` capability. Organization settings (members,
 * billing, accounting config, AI/skills) are admin-only — everyone else can
 * edit only their own profile. No-op when Supabase is unconfigured (dev gets
 * full access). The thrown message surfaces to the client action caller.
 */
export async function requireAdmin(): Promise<void> {
  if (!hasSupabase()) return;
  const { isOwner, permissions } = await getCurrentPermissions();
  if (isOwner || permissions.includes("admin")) return;
  throw new Error("Only an admin can change organization settings.");
}

/**
 * API route guard. Returns a 403 Response when the caller lacks (all of) the
 * given permission(s), or `null` when allowed — so a route can do:
 *
 *   const denied = await forbidUnlessPermitted("use_ai");
 *   if (denied) return denied;
 *
 * This is the server-side enforcement that DB RLS can't cover for work that
 * isn't a database operation (e.g. calling the AI model, hitting a vendor API).
 * Pass an array to mean "any of these grants access".
 */
export async function forbidUnlessPermitted(
  permission: PermissionKey | PermissionKey[]
): Promise<Response | null> {
  if (await userCan(permission)) return null;
  return Response.json(
    { error: "forbidden", reason: "missing_permission" },
    { status: 403 }
  );
}
