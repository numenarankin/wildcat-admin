import "server-only";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { hasSlack } from "@/lib/env";
import { getSlackConnection } from "@/lib/admin/slack/connections";
import { hasSlackScopes } from "@/lib/admin/slack/oauth";

/** What Settings > Connections and /admin/slack show: the caller's own Slack connection. */
export interface SlackSettings {
  configured: boolean;
  connected: boolean;
  teamName: string | null;
  needsReauth: boolean;
  /** False when the grant lacks a scope the page needs (an older grant): Reconnect. */
  hasScopes: boolean;
}

/** Null when the connection could not be read. */
export async function getSlackSettings(): Promise<SlackSettings | null> {
  const user = await getSessionUser();
  if (!user || !(await isPlatformAdmin())) return null;
  try {
    const conn = await getSlackConnection(user.id);
    return {
      configured: hasSlack(),
      connected: conn !== null,
      teamName: conn?.teamName ?? null,
      needsReauth: conn?.status === "needs_reauth",
      hasScopes: conn ? hasSlackScopes(conn.scopes) : false,
    };
  } catch (error) {
    console.error("getSlackSettings failed", error);
    return null;
  }
}
