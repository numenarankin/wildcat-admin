import { requireAdminPage } from "@/lib/auth/platform-admin";
import { getEnrollments } from "@/lib/admin/outreach/sequences";
import { getProspectingSettings, getScheduledEmails } from "@/lib/admin/outreach/settings";
import { readEmailIndex } from "@/lib/admin/google/gmail/index-read";
import { getEmailSettings } from "@/lib/admin/google/gmail/email-settings";
import { googleAdminId } from "@/lib/admin/google/guard";
import { OutboundWorkspace } from "@/components/admin/outbound/outbound-workspace";

export const metadata = { title: "Outbound" };

/** Outbound: the pipeline after a target is enrolled. Reads what the Sequence tab of /prospecting reads. */
export default async function AdminOutboundPage() {
  await requireAdminPage("outbound");
  const [enrollments, scheduled, settings, emailSettings, googleId] = await Promise.all([
    getEnrollments(),
    getScheduledEmails(),
    getProspectingSettings(),
    getEmailSettings(),
    googleAdminId(),
  ]);
  // The compose card's autofill; empty without a connected Google account.
  const emailIndex = googleId
    ? await readEmailIndex(googleId).catch(() => ({ contacts: [], subjects: [] }))
    : { contacts: [], subjects: [] };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OutboundWorkspace
        enrollments={enrollments}
        scheduled={scheduled}
        settings={settings}
        emailIndex={emailIndex}
        emailSettings={emailSettings}
      />
    </div>
  );
}
