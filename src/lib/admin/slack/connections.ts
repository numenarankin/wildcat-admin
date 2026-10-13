import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { openToken, sealToken } from "@/lib/cloud/crypto";
import { refreshSlackToken, SlackRefreshError } from "@/lib/admin/slack/oauth";

/**
 * An admin's Slack connection: one row per admin in `admin_slack_connections`,
 * the token split off into `admin_slack_secrets` (service role only). Migration
 * 2026100100300 (+ 2026100100400 for rotation). The Google connection's shape
 * (`google/connections.ts`). With token rotation on, the access token lasts 12
 * hours and `getSlackToken` refreshes it; without, it never expires.
 *
 * EVERYTHING here uses the service role. `userId` MUST be the session's user,
 * and the caller must have passed `isPlatformAdmin()` first.
 */

export interface SlackConnection {
  userId: string;
  teamId: string;
  teamName: string | null;
  slackUserId: string;
  scopes: string[];
  status: "active" | "needs_reauth";
  lastError: string | null;
}

interface ConnectionRow {
  user_id: string;
  team_id: string;
  team_name: string | null;
  slack_user_id: string;
  scopes: string[] | null;
  status: "active" | "needs_reauth";
  last_error: string | null;
}

const COLUMNS = "user_id, team_id, team_name, slack_user_id, scopes, status, last_error";

function toConnection(r: ConnectionRow): SlackConnection {
  return {
    userId: r.user_id,
    teamId: r.team_id,
    teamName: r.team_name,
    slackUserId: r.slack_user_id,
    scopes: r.scopes ?? [],
    status: r.status,
    lastError: r.last_error,
  };
}

function admin(sb?: SupabaseClient): SupabaseClient {
  return sb ?? getSupabaseAdmin();
}

export async function getSlackConnection(userId: string, sb?: SupabaseClient): Promise<SlackConnection | null> {
  const { data, error } = await admin(sb)
    .from("admin_slack_connections")
    .select(COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getSlackConnection: ${error.message}`);
  return data ? toConnection(data as ConnectionRow) : null;
}

/** Create or replace after a successful callback; clears `needs_reauth`. */
export async function saveSlackConnection(
  input: {
    userId: string;
    teamId: string;
    teamName: string | null;
    slackUserId: string;
    scopes: string[];
    accessToken: string;
    /** Rotation only. */
    refreshToken?: string | null;
    accessExpiresAt?: Date | null;
  },
  sb?: SupabaseClient
): Promise<SlackConnection> {
  const db = admin(sb);
  const { data, error } = await db
    .from("admin_slack_connections")
    .upsert(
      {
        user_id: input.userId,
        team_id: input.teamId,
        team_name: input.teamName,
        slack_user_id: input.slackUserId,
        scopes: input.scopes,
        status: "active",
        last_error: null,
      },
      { onConflict: "user_id" }
    )
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(`saveSlackConnection: ${error?.message ?? "no row"}`);
  const { error: secretErr } = await db.from("admin_slack_secrets").upsert(
    {
      user_id: input.userId,
      access_token_enc: sealToken(input.accessToken),
      refresh_token_enc: input.refreshToken ? sealToken(input.refreshToken) : null,
      access_expires_at: input.accessExpiresAt ? input.accessExpiresAt.toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (secretErr) throw new Error(`saveSlackConnection secrets: ${secretErr.message}`);
  return toConnection(data as ConnectionRow);
}

/** Refresh this long before expiry so a token never dies mid-request. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

interface SecretRow {
  access_token_enc: string;
  refresh_token_enc: string | null;
  access_expires_at: string | null;
}

async function readSecrets(db: SupabaseClient, userId: string): Promise<SecretRow | null> {
  const { data, error } = await db
    .from("admin_slack_secrets")
    .select("access_token_enc, refresh_token_enc, access_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getSlackToken: ${error.message}`);
  return (data as SecretRow | null) ?? null;
}

const liveUntil = (r: SecretRow) => (r.access_expires_at ? new Date(r.access_expires_at).getTime() : Infinity);

/**
 * A live access token, or null when there is none. A rotating token close to
 * its 12-hour expiry is refreshed first, and the NEW refresh token Slack hands
 * back is stored (the old one is spent).
 */
export async function getSlackToken(userId: string, sb?: SupabaseClient): Promise<string | null> {
  const db = admin(sb);
  const row = await readSecrets(db, userId);
  if (!row) return null;
  if (!row.refresh_token_enc || liveUntil(row) - EXPIRY_MARGIN_MS > Date.now()) return openToken(row.access_token_enc);

  let fresh;
  try {
    fresh = await refreshSlackToken(openToken(row.refresh_token_enc));
  } catch (err) {
    // Another request may have refreshed first and spent this refresh token:
    // its newer pair is in the row now.
    const again = await readSecrets(db, userId);
    if (again && liveUntil(again) - EXPIRY_MARGIN_MS > Date.now()) return openToken(again.access_token_enc);
    if (err instanceof SlackRefreshError) {
      await markSlackNeedsReauth(userId, `Slack refresh failed (${err.code}).`, db);
    }
    throw err;
  }
  const { error } = await db
    .from("admin_slack_secrets")
    .update({
      access_token_enc: sealToken(fresh.accessToken),
      refresh_token_enc: sealToken(fresh.refreshToken),
      access_expires_at: new Date(Date.now() + fresh.expiresIn * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`getSlackToken save: ${error.message}`);
  return fresh.accessToken;
}

/** The stored refresh token, for revoking on disconnect. */
export async function getSlackRefreshToken(userId: string, sb?: SupabaseClient): Promise<string | null> {
  const row = await readSecrets(admin(sb), userId);
  return row?.refresh_token_enc ? openToken(row.refresh_token_enc) : null;
}

/** Slack said the token is dead: Settings then offers Reconnect. */
export async function markSlackNeedsReauth(userId: string, reason: string, sb?: SupabaseClient): Promise<void> {
  const { error } = await admin(sb)
    .from("admin_slack_connections")
    .update({ status: "needs_reauth", last_error: reason })
    .eq("user_id", userId);
  if (error) throw new Error(`markSlackNeedsReauth: ${error.message}`);
}

/** Delete the connection; the secrets row cascades. */
export async function deleteSlackConnection(userId: string, sb?: SupabaseClient): Promise<void> {
  const { error } = await admin(sb).from("admin_slack_connections").delete().eq("user_id", userId);
  if (error) throw new Error(`deleteSlackConnection: ${error.message}`);
}
