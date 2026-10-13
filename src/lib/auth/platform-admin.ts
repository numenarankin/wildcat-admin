/**
 * Server-side resolver + guard for the PLATFORM ADMIN list (`platform_admins`,
 * see supabase/migrations/2026091600100_platform_admins.sql).
 *
 * Intent: `/*` is the Wildcat insiders' side of the app. It exists only
 * for accounts the seed admin (rankin@wildcatiq.ai) has put on the list. For
 * anyone else it does not exist, so the guard answers with a 404, never a 403
 * or a redirect: an outsider must not be able to tell the side is there.
 *
 * Orthogonal to org permissions and to early access: those describe a member
 * inside their own workspace, this describes Wildcat staff over all of them.
 *
 * Within the side, access is PAGE-LEVEL (`platform_admins.pages`, migration
 * 2026101300100, catalog in `@/lib/admin/pages`): a member opens only the pages
 * on their list, the seed admin every page. {@link requireAdminPage} is the
 * per-page guard; the proxy and the sidebar read the same list.
 *
 * Server-only (request-scoped Supabase + `next/headers`). Client components
 * read the resolved boolean through `PlatformAdminProvider` and the page list
 * through `AdminPagesProvider`, for UI selection only; every /admin page calls
 * {@link requireAdminPage} itself.
 */

import { memoRender } from "@/lib/cache/render-cache";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { ALL_ADMIN_PAGES, type AdminPageKey } from "@/lib/admin/pages";
import { accessFromRows, isMissingFunction, NO_ACCESS, type PlatformAdminAccess } from "@/lib/auth/platform-admin-access";

export type { PlatformAdminAccess } from "@/lib/auth/platform-admin-access";

/**
 * Whether the signed-in user is on the platform admin list. Signed out => false.
 *
 * Without Supabase configured (local dev with no backend) this returns true,
 * matching `hasEarlyAccess()` and `getCurrentPermissions()` in that mode: there
 * is no identity to resolve, so gating would only make dev unusable.
 */
export function isPlatformAdmin(): Promise<boolean> {
  // Memoized across layout and page like the session itself, so the shell's
  // sidebar selection and the page's guard cost one round trip together.
  return platformAdmin();
}

const platformAdmin = memoRender("platform-admin", resolvePlatformAdmin);

async function resolvePlatformAdmin(): Promise<boolean> {
  if (!hasSupabase()) return true;
  try {
    const user = await getSessionUser();
    if (!user) return false;
    const sb = await getSupabaseServer();
    // SECURITY DEFINER on the database side: answers for the caller's uid
    // whatever the table's own read policy says.
    const { data, error } = await sb.rpc("is_platform_admin");
    if (error) throw error;
    return data === true;
  } catch (error) {
    console.error("isPlatformAdmin failed", error);
    return false;
  }
}

/**
 * Page/layout guard: renders the app's 404 unless the user is a platform
 * admin. Every page under /admin calls this, not only the segment layout: a
 * layout is not re-rendered on a client-side navigation between its pages, so
 * a page that trusted it alone would stay open to someone removed from the
 * list mid-session until their next full load.
 */
export async function requirePlatformAdmin(): Promise<void> {
  if (await isPlatformAdmin()) return;
  // Lazy import for the same reason as `requireUser`: importing
  // `next/navigation` eagerly breaks the `react-server` test condition.
  const { notFound } = await import("next/navigation");
  notFound();
}

/**
 * Route-handler guard: a 404 response unless the caller is a platform admin,
 * else null. Same answer as {@link requirePlatformAdmin}, for handlers that
 * return a `Response` instead of rendering.
 */
export async function notFoundUnlessPlatformAdmin(): Promise<Response | null> {
  if (await isPlatformAdmin()) return null;
  return new Response("Not found", { status: 404 });
}

/**
 * Server-action guard: throws unless the caller is a platform admin. A server
 * action must not render a 404 (its caller is a fetch), so it raises instead.
 */
export async function assertPlatformAdmin(): Promise<void> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
}

// --- Page-level access -------------------------------------------------------

/**
 * The signed-in user's admin access: whether they are on the list and which
 * pages it opens. Signed out, or not on the list, => no access. Without
 * Supabase configured, everything, like {@link isPlatformAdmin}.
 *
 * Fails CLOSED: a database error (the migration not yet applied, say) answers
 * no pages, so a page is never opened on a guess.
 */
export function getPlatformAdminAccess(): Promise<PlatformAdminAccess> {
  return platformAdminAccess();
}

const platformAdminAccess = memoRender("platform-admin-access", resolvePlatformAdminAccess);

async function resolvePlatformAdminAccess(): Promise<PlatformAdminAccess> {
  if (!hasSupabase()) return { isAdmin: true, isSeed: true, pages: [...ALL_ADMIN_PAGES] };
  try {
    const user = await getSessionUser();
    if (!user) return NO_ACCESS;
    const sb = await getSupabaseServer();
    const { data, error } = await sb.rpc("platform_admin_access");
    if (error) {
      if (!isMissingFunction(error)) throw error;
      // The database predates page-level access (wildcat migration
      // 2026101300100 not applied): the side behaves as it did before it,
      // every admin opens every page. Said in the log so it is not forgotten.
      console.warn("platform_admin_access() is missing: apply wildcat migration 2026101300100. Every admin gets every page until then.");
      const { data: admin, error: adminErr } = await sb.rpc("is_platform_admin");
      if (adminErr) throw adminErr;
      return admin === true ? { isAdmin: true, isSeed: false, pages: [...ALL_ADMIN_PAGES] } : NO_ACCESS;
    }
    return accessFromRows(data);
  } catch (error) {
    console.error("getPlatformAdminAccess failed", error);
    return NO_ACCESS;
  }
}

/**
 * Page guard: the app's 404 unless the user is a platform admin AND `page` is
 * on their list. Every page under /admin calls this with its own key, for the
 * reason {@link requirePlatformAdmin} gives: a layout does not re-run on a
 * client-side navigation.
 */
export async function requireAdminPage(page: AdminPageKey): Promise<void> {
  const access = await getPlatformAdminAccess();
  if (access.isAdmin && access.pages.includes(page)) return;
  const { notFound } = await import("next/navigation");
  notFound();
}
