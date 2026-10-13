"use server";

import { revalidatePath } from "next/cache";
import { requireSlackAdminId } from "@/lib/admin/slack/guard";
import { deleteSlackConnection, getSlackToken } from "@/lib/admin/slack/connections";
import { revokeSlackToken } from "@/lib/admin/slack/oauth";
import { postSlackMessage, slackErrorMessage, slackHistory, slackReplies } from "@/lib/admin/slack/client";
import { escapeSlackText, type SlackMessage } from "@/lib/admin/slack/map";

/**
 * /admin/slack's server actions. Each resolves the SESSION's admin id first
 * (`requireSlackAdminId` throws "Not found." for anyone else) and never takes
 * a user id from input; the token used is that admin's own.
 */

export type SlackResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Slack's ids: C…, G…, D… for conversations; a message ts is digits.digits. */
const isConversationId = (v: unknown): v is string => typeof v === "string" && /^[CDG][A-Z0-9]{2,}$/.test(v);
const isTs = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+$/.test(v);
/** Slack truncates past 40,000 characters; refuse instead of losing the tail. */
const TEXT_MAX = 40_000;

export async function loadSlackHistory(
  channel: string,
  cursor?: string
): Promise<SlackResult<{ messages: SlackMessage[]; nextCursor: string | null }>> {
  const userId = await requireSlackAdminId();
  if (!isConversationId(channel)) return { ok: false, error: "Unknown conversation." };
  try {
    return { ok: true, data: await slackHistory(userId, channel, typeof cursor === "string" ? cursor : undefined) };
  } catch (error) {
    console.error("loadSlackHistory failed", error);
    return { ok: false, error: slackErrorMessage(error) };
  }
}

export async function loadSlackThread(channel: string, ts: string): Promise<SlackResult<SlackMessage[]>> {
  const userId = await requireSlackAdminId();
  if (!isConversationId(channel) || !isTs(ts)) return { ok: false, error: "Unknown thread." };
  try {
    return { ok: true, data: await slackReplies(userId, channel, ts) };
  } catch (error) {
    console.error("loadSlackThread failed", error);
    return { ok: false, error: slackErrorMessage(error) };
  }
}

/** Post as the admin: to the conversation, or into a thread with `threadTs`. */
export async function sendSlackMessage(
  channel: string,
  text: string,
  threadTs?: string
): Promise<SlackResult<SlackMessage>> {
  const userId = await requireSlackAdminId();
  if (!isConversationId(channel)) return { ok: false, error: "Unknown conversation." };
  if (threadTs !== undefined && !isTs(threadTs)) return { ok: false, error: "Unknown thread." };
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) return { ok: false, error: "Nothing to send." };
  if (body.length > TEXT_MAX) return { ok: false, error: "That message is too long for Slack." };
  try {
    return { ok: true, data: await postSlackMessage(userId, channel, escapeSlackText(body), threadTs) };
  } catch (error) {
    console.error("sendSlackMessage failed", error);
    return { ok: false, error: slackErrorMessage(error) };
  }
}

/** Disconnect the caller's Slack account: revoke the token at Slack, then drop the row. */
export async function disconnectSlack(): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireSlackAdminId().catch(() => null);
  if (!userId) return { ok: false, error: "Not found." };
  try {
    const token = await getSlackToken(userId);
    if (token) {
      // A failed revoke still disconnects here; the token is then removed by
      // hand from the Slack app's page.
      await revokeSlackToken(token).catch((e) => console.error("disconnectSlack: revoke failed", e));
    }
    await deleteSlackConnection(userId);
  } catch (error) {
    console.error("disconnectSlack failed", error);
    return { ok: false, error: "Couldn't disconnect Slack." };
  }
  revalidatePath("/settings");
  revalidatePath("/slack");
  return { ok: true };
}
