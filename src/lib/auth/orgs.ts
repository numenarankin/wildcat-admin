"use server";

/**
 * The signed-in user's organizations, and which one they are currently in.
 *
 * A user can belong to several orgs (a pumper works for three operators), and
 * the app shows exactly one at a time. Which one is a row in `user_active_org`
 * rather than a cookie or client state, because RLS is the boundary and every
 * policy resolves the org through `current_org_id()`, which sees only
 * `auth.uid()`. See `supabase/migrations/2026081700100_multi_org.sql`.
 *
 * Nothing here decides access. `set_active_org()` refuses an org the caller is
 * not an active member of, and `current_org_id()` re-verifies the membership on
 * every call, so an offboarding revokes a stale selection without this module
 * having to notice.
 */

import { hasSupabase } from "@/lib/env";
import { memoRender } from "@/lib/cache/render-cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { OrgOption } from "@/lib/auth/org-types";

interface MyOrgRow {
  org_id: string;
  name: string | null;
  is_owner: boolean | null;
}

/**
 * Every org the user may enter, by name.
 *
 * Empty without Supabase (local dev runs as a single implicit org) and empty for
 * a signed-out user, which is what makes "no orgs" mean "no workspace" rather
 * than "not configured" at the call sites.
 */
export async function listMyOrgs(): Promise<OrgOption[]> {
  if (!hasSupabase()) return [];
  return myOrgs();
}

const myOrgs = memoRender("my-orgs", loadMyOrgs);

async function loadMyOrgs(): Promise<OrgOption[]> {
  try {
    const sb = await getSupabaseServer();
    const { data, error } = await sb.rpc("my_orgs");
    if (error) throw new Error(error.message);
    return ((data ?? []) as MyOrgRow[]).map((row) => ({
      id: row.org_id,
      name: row.name ?? "Workspace",
      isOwner: Boolean(row.is_owner),
    }));
  } catch (error) {
    console.error("listMyOrgs failed", error);
    return [];
  }
}

/**
 * The org this request is scoped to, straight from the database function every
 * policy uses. Null when the user has none (signed out, or offboarded from all
 * of them).
 */
export async function getActiveOrgId(): Promise<string | null> {
  if (!hasSupabase()) return null;
  return activeOrgId();
}

const activeOrgId = memoRender("active-org-id", loadActiveOrgId);

async function loadActiveOrgId(): Promise<string | null> {
  try {
    const sb = await getSupabaseServer();
    const { data, error } = await sb.rpc("current_org_id");
    if (error) throw new Error(error.message);
    return (data as string | null) ?? null;
  } catch (error) {
    console.error("getActiveOrgId failed", error);
    return null;
  }
}

/** The active org as an option (for the account menu's label), or null. */
export async function getActiveOrg(): Promise<OrgOption | null> {
  const [orgId, orgs] = await Promise.all([getActiveOrgId(), listMyOrgs()]);
  if (!orgId) return null;
  return orgs.find((org) => org.id === orgId) ?? null;
}

/**
 * Enter a workspace.
 *
 * Throws if the user is not an active member of it (the check is in the database
 * function, not here). Callers reload the page rather than refresh it: a refresh
 * re-renders the server components but leaves every client cache keyed to the
 * previous org in place, and half a workspace from the org you just left is
 * worse than a second of white.
 */
export async function enterOrg(orgId: string): Promise<void> {
  if (!hasSupabase()) return;
  const sb = await getSupabaseServer();
  const { error } = await sb.rpc("set_active_org", { org: orgId });
  if (error) {
    console.error("enterOrg failed", error);
    throw new Error("You are not a member of that workspace.");
  }
}
