import { requireAdminPage } from "@/lib/auth/platform-admin";
import { slackAdminId } from "@/lib/admin/slack/guard";
import { getSlackSettings } from "@/lib/admin/slack/settings";
import { getSlackConnection } from "@/lib/admin/slack/connections";
import { listSlackConversations, listSlackPeople, slackErrorMessage } from "@/lib/admin/slack/client";
import { SLACK_SETTINGS_PATH } from "@/lib/admin/slack/popup";
import { EmailError } from "@/components/admin/email/email-workspace";
import { SlackWorkspace } from "@/components/admin/slack/slack-workspace";
import type { SlackConversation, SlackPerson } from "@/lib/admin/slack/map";

export const metadata = { title: "Slack" };

/**
 * The admin's own Slack, read and write, through their own user token
 * (Settings > Connections). The Email page's gate: a line pointing at
 * Settings until the connection is there and whole.
 */
export default async function AdminSlackPage() {
  await requireAdminPage("slack");
  const [settings, userId] = await Promise.all([getSlackSettings(), slackAdminId()]);

  let blocked: string | null = null;
  if (!settings || !userId) blocked = "Couldn't read the Slack connection.";
  else if (!settings.configured) blocked = "Slack isn't configured on this server.";
  else if (!settings.connected) blocked = "Slack isn't connected. Connect it in Settings > Connections.";
  else if (settings.needsReauth) blocked = "Slack needs to be reconnected in Settings > Connections.";
  else if (!settings.hasScopes) blocked = "Slack is missing a permission. Reconnect it in Settings > Connections.";

  let data: { selfId: string; conversations: SlackConversation[]; people: SlackPerson[] } | null = null;
  if (!blocked && userId) {
    try {
      const [conn, conversations, people] = await Promise.all([
        getSlackConnection(userId),
        listSlackConversations(userId),
        listSlackPeople(userId),
      ]);
      data = conn ? { selfId: conn.slackUserId, conversations, people } : null;
      if (!data) blocked = "Slack isn't connected. Connect it in Settings > Connections.";
    } catch (error) {
      console.error("admin slack: loading conversations failed", error);
      blocked = slackErrorMessage(error);
    }
  }

  if (blocked || !data) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background-surface px-4 text-center text-sm text-muted-foreground">
        <p>
          <EmailError message={blocked ?? ""} connectionsHref={SLACK_SETTINGS_PATH} />
        </p>
      </div>
    );
  }

  return (
    <SlackWorkspace
      teamName={settings?.teamName ?? null}
      selfId={data.selfId}
      conversations={data.conversations}
      people={data.people}
    />
  );
}
