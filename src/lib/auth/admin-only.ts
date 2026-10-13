import type { User } from "@supabase/supabase-js";

/**
 * Admin-only accounts: Wildcat staff created from /admin/settings > Team, who
 * exist for the admin side and are not users of the app. They have no
 * workspace, and the proxy keeps them on /admin.
 *
 * The mark is `app_metadata.admin_only`, which only the service role can write
 * (a user can edit `user_metadata`, never `app_metadata`). It decides ROUTING
 * only: what anyone may see on /admin is still `platform_admins`, and an
 * account with no workspace has no rows to read in the app either way.
 */
export const ADMIN_ONLY_FLAG = "admin_only";

export function isAdminOnlyAccount(user: Pick<User, "app_metadata"> | null | undefined): boolean {
  return user?.app_metadata?.[ADMIN_ONLY_FLAG] === true;
}
