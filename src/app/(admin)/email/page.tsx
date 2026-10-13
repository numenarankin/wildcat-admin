import { requireAdminPage } from "@/lib/auth/platform-admin";
import { googleAdminId } from "@/lib/admin/google/guard";
import { getGoogleSettings } from "@/lib/admin/google/settings";
import { googleErrorMessage } from "@/lib/admin/google/fetch";
import { GOOGLE_SETTINGS_PATH } from "@/lib/admin/google/popup";
import { listThreads } from "@/lib/admin/google/gmail/client";
import { getEmailSettings } from "@/lib/admin/google/gmail/email-settings";
import { readEmailIndex } from "@/lib/admin/google/gmail/index-read";
import { EmailError, EmailWorkspace } from "@/components/admin/email/email-workspace";
import type { GmailThreadPage } from "@/lib/admin/google/gmail/types";

export const metadata = { title: "Email" };

/** The admin's own Gmail, read only (plan section 7.1, phase 4). */
export default async function AdminEmailPage() {
  await requireAdminPage("email");
  const settings = await getGoogleSettings();
  const userId = await googleAdminId();

  let blocked: string | null = null;
  if (!settings || !userId) blocked = "Couldn't read the Google connection.";
  else if (settings.needsReauth) blocked = "Google needs to be reconnected in Settings > Connections.";
  else if (!settings.services.includes("gmail")) blocked = "Email isn't connected. Connect it in Settings > Connections.";

  if (blocked || !userId) {
    return (
      <div className="light flex min-h-0 flex-1 items-center justify-center bg-background-surface px-4 text-center text-sm text-muted-foreground">
        <p>
          <EmailError message={blocked ?? ""} connectionsHref={GOOGLE_SETTINGS_PATH} />
        </p>
      </div>
    );
  }

  const emailSettings = getEmailSettings();
  const emailIndex = readEmailIndex(userId);
  let initialPage: GmailThreadPage | null = null;
  let initialError: string | null = null;
  try {
    initialPage = await listThreads(userId, { filter: "inbox" });
  } catch (error) {
    console.error("admin email: listing threads failed", error);
    initialError = googleErrorMessage(error, "Email");
  }

  return (
    <EmailWorkspace
      initialPage={initialPage}
      initialError={initialError}
      connectionsHref={GOOGLE_SETTINGS_PATH}
      initialSettings={await emailSettings}
      accountEmail={settings?.accountEmail ?? null}
      initialIndex={await emailIndex}
    />
  );
}
