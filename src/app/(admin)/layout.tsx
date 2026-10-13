import { getPlatformAdminAccess, requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { CustomerPanelProvider } from "@/components/admin/customer-panel/customer-panel";
import { AdminShell } from "@/components/admin-shell";
import { getProfile } from "@/lib/settings/profile";
import { getSessionUser } from "@/lib/auth/session";
import { getCurrentPermissions } from "@/lib/auth/permissions";
import { getActiveOrgId, listMyOrgs } from "@/lib/auth/orgs";
import { getCreditBalance } from "@/lib/billing/credits";
import { getRecentNotifications } from "@/lib/notifications/recent";
import { scopedPage } from "@/lib/perf/page-scope";
import { cookies } from "next/headers";

/**
 * Every page but sign-in: Wildcat insiders only. The gate here covers the
 * whole subtree on a full load; each page repeats it because a client-side
 * navigation between sibling pages does not re-render this layout
 * (see `requirePlatformAdmin`).
 *
 * `CustomerPanelProvider` holds the one customer panel every admin table
 * opens by clicking a customer's name (`CustomerName`).
 */
export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requirePlatformAdmin();
  // Collapsed unless the viewer last left it expanded: the sidebar writes its
  // own `sidebar_state` cookie on every toggle.
  const sidebarOpen = (await cookies()).get("sidebar_state")?.value === "true";
  const [profile, user, balance, { permissions }, notifications, orgs, activeOrgId, access] =
    // Scoped so the session resolves once for the layout.
    await scopedPage("/(layout)", () =>
      Promise.all([
        getProfile(),
        getSessionUser(),
        getCreditBalance(),
        getCurrentPermissions(),
        getRecentNotifications(),
        listMyOrgs(),
        getActiveOrgId(),
        getPlatformAdminAccess(),
      ])
    );
  return (
    <AdminShell
      profile={profile}
      userEmail={user?.email ?? ""}
      userId={user?.id ?? ""}
      credits={balance?.total ?? 0}
      permissions={permissions}
      adminPages={access.pages}
      notifications={notifications}
      orgs={orgs}
      currentOrgId={activeOrgId}
      sidebarOpen={sidebarOpen}
    >
      <CustomerPanelProvider>{children}</CustomerPanelProvider>
    </AdminShell>
  );
}
