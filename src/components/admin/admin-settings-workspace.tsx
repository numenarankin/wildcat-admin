"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { TeamSection } from "@/components/admin/team-section";
import { UsersSection } from "@/components/admin/users-section";
import { GoogleSection } from "@/components/admin/google-section";
import { SlackSection } from "@/components/admin/slack-section";
import type { TeamRow } from "@/lib/admin/team";
import type { AccountRow } from "@/lib/admin/accounts";
import type { GoogleSettings } from "@/lib/admin/google/settings";
import type { SlackSettings } from "@/lib/admin/slack/settings";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { tabSlice } from "@/lib/ai/admin/page-slices";

type Section = "team" | "users" | "connections";

const NAV: ReadonlyArray<{ id: Section; label: string }> = [
  { id: "team", label: "Team" },
  { id: "users", label: "Users" },
  { id: "connections", label: "Connections" },
];

/**
 * /admin/settings: the customer Settings page's shape (header-styled tabs,
 * a panel per tab) over the admin side's concerns: who is on the admin team
 * and which pages each of them may open, which accounts are demo or test and
 * so kept out of the numbers, and the caller's own Google and Slack
 * connections.
 */
export function AdminSettingsWorkspace({
  admins,
  canEditTeam,
  accounts,
  google,
  googleError,
  slack,
  slackError,
  initialSection,
}: {
  admins: TeamRow[];
  /** Seed admin only: the roster's write rule lives in the database. */
  canEditTeam: boolean;
  accounts: AccountRow[];
  /** Null when the connection could not be read. */
  google: GoogleSettings | null;
  /** `google_error` from the OAuth round trip. */
  googleError?: string;
  /** Null when the connection could not be read. */
  slack: SlackSettings | null;
  /** `slack_error` from the OAuth round trip. */
  slackError?: string;
  /** Tab to open initially (`?section=users`), like the customer Settings. */
  initialSection?: string;
}) {
  const [section, setSection] = useState<Section>(
    initialSection === "users" || initialSection === "connections" ? initialSection : "team"
  );
  usePageContextSlice("admin-settings", tabSlice("Settings", NAV.find((n) => n.id === section)?.label ?? section));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-10">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-1">
        {NAV.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={section === id}
            onClick={() => setSection(id)}
            className={cn(
              "cursor-pointer font-heading text-2xl font-semibold tracking-tight transition-colors",
              section === id
                ? "text-foreground"
                : "text-muted-foreground/50 hover:text-muted-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-1 pb-2">
        {section === "team" && <TeamSection initialRows={admins} canEdit={canEditTeam} />}
        {section === "users" && <UsersSection initialAccounts={accounts} />}
        {section === "connections" && (
          <div className="flex flex-col gap-10">
            <GoogleSection settings={google} googleError={googleError} />
            <SlackSection settings={slack} slackError={slackError} />
          </div>
        )}
      </div>
    </div>
  );
}
