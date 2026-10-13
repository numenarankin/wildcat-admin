import { AdminOrionWorkspace } from "@/components/admin/admin-orion-workspace";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import { getAdminConversations } from "@/lib/ai/admin/conversations";
import { getProfile } from "@/lib/settings/profile";
import { getSessionUser } from "@/lib/auth/session";
import { displayFirstName } from "@/lib/user";

export const metadata = { title: "Orion" };

/** Orion for the people running Wildcat: the business, read-only, on its own route and history. */
export default async function AdminOrionPage() {
  await requireAdminPage("orion");
  const [conversations, profile, user] = await Promise.all([
    getAdminConversations(),
    getProfile(),
    getSessionUser(),
  ]);
  return (
    <AdminOrionWorkspace
      initialConversations={conversations}
      firstName={displayFirstName(profile.name, user?.email)}
    />
  );
}
