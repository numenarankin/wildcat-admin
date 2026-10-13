import "server-only";
import { getAppUrl, getSlackApp } from "@/lib/env";

/**
 * Slack OAuth v2 for the admin side: a USER token (`user_scope`, returned as
 * `authed_user`), so the page reads what the admin can read and posts as them.
 * No bot scopes. Slack requires the redirect URL to be HTTPS. Works with token
 * rotation on or off: a rotating grant carries a refresh token, kept and used
 * by `connections.ts`.
 * https://docs.slack.dev/authentication/installing-with-oauth
 */

/**
 * Read every kind of conversation the admin is in, read the member list for
 * names and faces, and post. `*:read` lists conversations (users.conversations),
 * `*:history` reads them (conversations.history / .replies), `users:read`
 * names people (users.list), `chat:write` posts (chat.postMessage).
 */
export const SLACK_USER_SCOPES = [
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "users:read",
  "chat:write",
] as const;

/** Whether `scopes` carries every scope the page needs. */
export function hasSlackScopes(scopes: readonly string[]): boolean {
  return SLACK_USER_SCOPES.every((s) => scopes.includes(s));
}

export const SLACK_CALLBACK_PATH = "/api/admin/slack/callback";

export function slackRedirectUri(): string {
  return `${getAppUrl().replace(/\/$/, "")}${SLACK_CALLBACK_PATH}`;
}

function app(): { clientId: string; clientSecret: string } {
  const a = getSlackApp();
  if (!a) throw new Error("Slack is not configured: set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.");
  return a;
}

export function buildSlackAuthorizeUrl(state: string, teamId: string | null, redirectUri = slackRedirectUri()): string {
  const params = new URLSearchParams({
    client_id: app().clientId,
    user_scope: SLACK_USER_SCOPES.join(","),
    redirect_uri: redirectUri,
    state,
  });
  // Steers a reconnect to the workspace already connected.
  if (teamId) params.set("team", teamId);
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

/** The parts of `oauth.v2.access` read here. */
export interface SlackAccessResponse {
  ok: boolean;
  error?: string;
  team?: { id: string; name?: string };
  authed_user?: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
    /** Only with token rotation on: the access token then lasts `expires_in` seconds. */
    refresh_token?: string;
    expires_in?: number;
  };
}

/** A rotated token pair (`grant_type=refresh_token`): Slack returns it top level. */
export interface SlackRefreshResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** A refresh Slack refused; `invalid_refresh_token` means the grant is gone. */
export class SlackRefreshError extends Error {
  constructor(readonly code: string) {
    super(`Slack token refresh failed (${code}).`);
    this.name = "SlackRefreshError";
  }
}

/**
 * Trade a refresh token for a new access token AND a new refresh token (the
 * old one stops working). https://docs.slack.dev/authentication/using-token-rotation
 */
export async function refreshSlackToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const { clientId, clientSecret } = app();
  const res = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new SlackRefreshError(`http_${res.status}`);
  const body = (await res.json()) as SlackRefreshResponse;
  if (!body.ok || !body.access_token || !body.refresh_token || !body.expires_in) {
    throw new SlackRefreshError(body.error ?? "incomplete_response");
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
}

/** Exchange the one-time code from the callback. Throws on `ok: false`. */
export async function exchangeSlackCode(
  code: string,
  redirectUri = slackRedirectUri(),
  fetchImpl: typeof fetch = fetch
): Promise<SlackAccessResponse> {
  const { clientId, clientSecret } = app();
  const res = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`Slack token request failed (${res.status}).`);
  const body = (await res.json()) as SlackAccessResponse;
  if (!body.ok) throw new Error(`Slack token request failed (${body.error ?? "unknown"}).`);
  return body;
}

/** Revoke the token. An already-dead token is the outcome wanted. */
export async function revokeSlackToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl("https://slack.com/api/auth.revoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Slack revoke failed (${res.status}).`);
  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!body.ok && body.error !== "invalid_auth" && body.error !== "token_revoked") {
    throw new Error(`Slack revoke failed (${body.error}).`);
  }
}
