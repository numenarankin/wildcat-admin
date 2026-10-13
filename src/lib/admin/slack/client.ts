import "server-only";
import { getSlackToken, markSlackNeedsReauth } from "@/lib/admin/slack/connections";
import { SlackRefreshError } from "@/lib/admin/slack/oauth";
import {
  toSlackConversation,
  toSlackMessage,
  toSlackPerson,
  type RawSlackConversation,
  type RawSlackMessage,
  type RawSlackUser,
  type SlackConversation,
  type SlackMessage,
  type SlackPerson,
} from "@/lib/admin/slack/map";

/**
 * Every Slack Web API call on the admin side goes through `slackCall`: the
 * admin's own user token, a wait-and-retry on 429 (Slack sends Retry-After),
 * and a typed error on `ok: false`. A dead token marks the connection
 * `needs_reauth` so Settings offers Reconnect. `userId` MUST be the session's
 * user after the platform-admin check (`slackAdminId`).
 */

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    /** Slack's `error`, e.g. "missing_scope", "channel_not_found". */
    readonly code: string
  ) {
    super(`Slack ${method} failed (${code}).`);
    this.name = "SlackApiError";
  }
}

/** Slack's answers for a token that no longer works. */
const DEAD_TOKEN = new Set(["invalid_auth", "token_revoked", "token_expired", "account_inactive", "not_authed"]);
const RETRIES = 3;
/** Never hold a request longer than this for a rate limit. */
const MAX_WAIT_MS = 10_000;

/** Seam for tests: no real waiting. */
export const slackBackoff = {
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

type Params = Record<string, string | number | boolean | undefined>;

export async function slackCall<T extends { ok: boolean; error?: string }>(
  userId: string,
  method: string,
  params: Params = {}
): Promise<T> {
  const token = await getSlackToken(userId);
  if (!token) throw new Error("Slack is not connected.");
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
    if (res.status === 429 && attempt < RETRIES - 1) {
      const after = Number(res.headers.get("retry-after") ?? "1");
      await slackBackoff.wait(Math.min(MAX_WAIT_MS, Math.max(1, after) * 1000));
      continue;
    }
    if (!res.ok) throw new SlackApiError(method, `http_${res.status}`);
    const json = (await res.json()) as T;
    if (json.ok) return json;
    const code = json.error ?? "unknown";
    if (DEAD_TOKEN.has(code)) {
      await markSlackNeedsReauth(userId, `Slack said ${code}.`).catch((e) =>
        console.error("slackCall: marking needs_reauth failed", e)
      );
    }
    throw new SlackApiError(method, code);
  }
}

interface Paged {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

/** Every page of a cursor-paged list method. */
async function slackAll<T>(userId: string, method: string, key: string, params: Params): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await slackCall<Paged & Record<string, unknown>>(userId, method, { ...params, cursor });
    out.push(...((page[key] as T[] | undefined) ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/** Every channel, private channel, DM and group DM the admin is in, archived left out. */
export async function listSlackConversations(userId: string): Promise<SlackConversation[]> {
  const raw = await slackAll<RawSlackConversation>(userId, "users.conversations", "channels", {
    types: "public_channel,private_channel,mpim,im",
    exclude_archived: true,
    limit: 200,
  });
  return raw.map(toSlackConversation);
}

/** Everyone in the workspace, deactivated included (their old messages still need a name). */
export async function listSlackPeople(userId: string): Promise<SlackPerson[]> {
  const raw = await slackAll<RawSlackUser>(userId, "users.list", "members", { limit: 200 });
  return raw.map(toSlackPerson);
}

export const HISTORY_PAGE = 50;

/** The newest page of a conversation (or the page before `cursor`), oldest first. */
export async function slackHistory(
  userId: string,
  channel: string,
  cursor?: string
): Promise<{ messages: SlackMessage[]; nextCursor: string | null }> {
  const res = await slackCall<Paged & { messages?: RawSlackMessage[]; has_more?: boolean }>(
    userId,
    "conversations.history",
    { channel, limit: HISTORY_PAGE, cursor }
  );
  return {
    // Slack sends newest first.
    messages: (res.messages ?? []).map(toSlackMessage).reverse(),
    nextCursor: res.has_more ? res.response_metadata?.next_cursor || null : null,
  };
}

/** A whole thread, parent first. */
export async function slackReplies(userId: string, channel: string, ts: string): Promise<SlackMessage[]> {
  const raw = await slackAll<RawSlackMessage>(userId, "conversations.replies", "messages", { channel, ts, limit: 200 });
  return raw.map(toSlackMessage);
}

/** Post as the admin. `text` is already escaped for Slack (`escapeSlackText`). */
export async function postSlackMessage(
  userId: string,
  channel: string,
  text: string,
  threadTs?: string
): Promise<SlackMessage> {
  const res = await slackCall<{ ok: boolean; error?: string; ts: string; message?: RawSlackMessage }>(
    userId,
    "chat.postMessage",
    { channel, text, thread_ts: threadTs }
  );
  return toSlackMessage(res.message ? { ...res.message, ts: res.ts } : { ts: res.ts, text, thread_ts: threadTs });
}

/** What a page shows when a call fails: the reconnect message for a dead token, never an empty list. */
export function slackErrorMessage(error: unknown): string {
  if (error instanceof SlackRefreshError) return "Slack needs to be reconnected in Settings > Connections.";
  if (error instanceof SlackApiError) {
    if (DEAD_TOKEN.has(error.code)) return "Slack needs to be reconnected in Settings > Connections.";
    if (error.code === "missing_scope") return "Slack is missing a permission. Reconnect it in Settings > Connections.";
    return error.message;
  }
  if (error instanceof Error) {
    if (/is not connected/.test(error.message)) return "Slack isn't connected. Connect it in Settings > Connections.";
    return error.message;
  }
  return "Couldn't reach Slack.";
}
