import { AdminSettingsWorkspace } from "@/components/admin/admin-settings-workspace";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import { isSeedPlatformAdmin, listPlatformTeam } from "@/lib/admin/team";
import { listAccounts } from "@/lib/admin/accounts";
import { getGoogleSettings } from "@/lib/admin/google/settings";
import { getSlackSettings } from "@/lib/admin/slack/settings";

export const metadata = { title: "Settings" };

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; google_error?: string; slack_error?: string }>;
}) {
  await requireAdminPage("settings");
  const { section, google_error, slack_error } = await searchParams;
  const [admins, canEditTeam, accounts, google, slack] = await Promise.all([
    listPlatformTeam(),
    isSeedPlatformAdmin(),
    listAccounts(),
    getGoogleSettings(),
    getSlackSettings(),
  ]);
  return (
    <AdminSettingsWorkspace
      admins={admins}
      canEditTeam={canEditTeam}
      accounts={accounts}
      google={google}
      googleError={google_error}
      slack={slack}
      slackError={slack_error}
      initialSection={section}
    />
  );
}
