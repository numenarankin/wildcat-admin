import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { isAdminOnlyAccount } from "@/lib/auth/admin-only";
import { ALL_ADMIN_PAGES, cleanPages, type AdminPageKey } from "@/lib/admin/pages";

/**
 * The admin team for /settings > Team: the roster (`platform_admins`) and the
 * invites still pending (`platform_admin_invites`), as one list.
 *
 * Service-role reads behind an explicit platform-admin check, like every
 * service-role path. The write rules are the migrations' (2026091600100,
 * 2026101300100): the SEED admin invites, edits pages and removes, nobody
 * removes the seed. `team-actions.ts` enforces the same rule before writing
 * with the service key, so the app can never do what the SQL editor would
 * refuse.
 */

export interface TeamRow {
  /** `platform_admins.user_id` for a member, `platform_admin_invites.id` for an invite. */
  id: string;
  status: "active" | "invited";
  email: string;
  name: string;
  /** The pages they may open. Every page for the seed admin. */
  pages: AdminPageKey[];
  isSeed: boolean;
  /** When they were added, or when the invite was sent. */
  addedAt: string;
  /** The signed-in viewer's own row. */
  isMe: boolean;
  /** An account made by accepting an invite, not a user of the app. */
  adminOnly: boolean;
}

export async function listPlatformTeam(): Promise<TeamRow[]> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  const me = await getSessionUser();
  const admin = getSupabaseAdmin();
  const [members, invites] = await Promise.all([
    admin
      .from("platform_admins")
      .select("user_id, email, name, pages, is_seed, created_at")
      .order("is_seed", { ascending: false })
      .order("created_at", { ascending: true }),
    admin
      .from("platform_admin_invites")
      .select("id, email, name, pages, created_at")
      .order("created_at", { ascending: true }),
  ]);
  if (members.error) throw new Error(`platform_admins: ${members.error.message}`);
  if (invites.error) throw new Error(`platform_admin_invites: ${invites.error.message}`);

  const rows = members.data ?? [];
  // A handful of staff: one account read each, for the admin-only mark.
  const accounts = await Promise.all(rows.map((r) => admin.auth.admin.getUserById(r.user_id as string)));

  const active: TeamRow[] = rows.map((r, i) => {
    const isSeed = r.is_seed === true;
    return {
      id: r.user_id as string,
      status: "active",
      email: r.email as string,
      name: (r.name as string | null) ?? "",
      pages: isSeed ? [...ALL_ADMIN_PAGES] : cleanPages((r.pages as string[] | null) ?? []),
      isSeed,
      addedAt: r.created_at as string,
      isMe: r.user_id === me?.id,
      adminOnly: isAdminOnlyAccount(accounts[i].data.user),
    };
  });
  const pending: TeamRow[] = (invites.data ?? []).map((r) => ({
    id: r.id as string,
    status: "invited",
    email: r.email as string,
    name: (r.name as string | null) ?? "",
    pages: cleanPages((r.pages as string[] | null) ?? []),
    isSeed: false,
    addedAt: r.created_at as string,
    isMe: false,
    adminOnly: false,
  }));
  return [...active, ...pending];
}

/** Whether the signed-in user is the SEED admin, the only one who edits the roster. */
export async function isSeedPlatformAdmin(): Promise<boolean> {
  const me = await getSessionUser();
  if (!me) return false;
  const { data, error } = await getSupabaseAdmin()
    .from("platform_admins")
    .select("is_seed")
    .eq("user_id", me.id)
    .maybeSingle();
  if (error) throw new Error(`platform_admins: ${error.message}`);
  return data?.is_seed === true;
}

/**
 * The people on the list today, for the assignee pickers (tasks, sales,
 * projects): a pending invitee cannot yet be assigned anything.
 */
export async function listPlatformAdmins(): Promise<TeamRow[]> {
  return (await listPlatformTeam()).filter((row) => row.status === "active");
}
