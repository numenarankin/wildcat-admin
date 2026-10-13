import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { openToken, sealToken } from "@/lib/cloud/crypto";
import { GoogleTokenError, refreshAccessToken, servicesIn, type GoogleService } from "@/lib/admin/google/oauth";

/**
 * An admin's Google connection: one row per admin in `admin_google_connections`,
 * tokens split off into `admin_google_secrets` (service role only). Migration
 * 2026100100200.
 *
 * EVERYTHING here uses the service role. `userId` MUST be the session's user,
 * and the caller must have passed `isPlatformAdmin()` first.
 */

export interface GoogleConnection {
  userId: string;
  googleSub: string;
  accountEmail: string | null;
  scopes: string[];
  services: GoogleService[];
  status: "active" | "needs_reauth";
  lastError: string | null;
}

interface ConnectionRow {
  user_id: string;
  google_sub: string;
  account_email: string | null;
  scopes: string[] | null;
  status: "active" | "needs_reauth";
  last_error: string | null;
}

const COLUMNS = "user_id, google_sub, account_email, scopes, status, last_error";

function toConnection(r: ConnectionRow): GoogleConnection {
  const scopes = r.scopes ?? [];
  return {
    userId: r.user_id,
    googleSub: r.google_sub,
    accountEmail: r.account_email,
    scopes,
    services: servicesIn(scopes),
    status: r.status,
    lastError: r.last_error,
  };
}

function admin(sb?: SupabaseClient): SupabaseClient {
  return sb ?? getSupabaseAdmin();
}

export async function getGoogleConnection(userId: string, sb?: SupabaseClient): Promise<GoogleConnection | null> {
  const { data, error } = await admin(sb)
    .from("admin_google_connections")
    .select(COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getGoogleConnection: ${error.message}`);
  return data ? toConnection(data as ConnectionRow) : null;
}

/** Create or replace after a successful callback; clears `needs_reauth`. */
export async function saveGoogleConnection(
  input: {
    userId: string;
    googleSub: string;
    accountEmail: string | null;
    scopes: string[];
    refreshToken: string;
    accessToken: string;
    accessExpiresAt: Date;
  },
  sb?: SupabaseClient
): Promise<GoogleConnection> {
  forgetGoogleAccessToken(input.userId);
  const db = admin(sb);
  const { data, error } = await db
    .from("admin_google_connections")
    .upsert(
      {
        user_id: input.userId,
        google_sub: input.googleSub,
        account_email: input.accountEmail,
        scopes: input.scopes,
        status: "active",
        last_error: null,
      },
      { onConflict: "user_id" }
    )
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(`saveGoogleConnection: ${error?.message ?? "no row"}`);
  const { error: secretErr } = await db.from("admin_google_secrets").upsert(
    {
      user_id: input.userId,
      refresh_token_enc: sealToken(input.refreshToken),
      access_token_enc: sealToken(input.accessToken),
      access_expires_at: input.accessExpiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (secretErr) throw new Error(`saveGoogleConnection secrets: ${secretErr.message}`);
  return toConnection(data as ConnectionRow);
}

/** The stored refresh token, for revoking on disconnect. Null when there is none. */
export async function getGoogleRefreshToken(userId: string, sb?: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin(sb)
    .from("admin_google_secrets")
    .select("refresh_token_enc")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getGoogleRefreshToken: ${error.message}`);
  return data ? openToken(data.refresh_token_enc) : null;
}

/** Delete the connection; the secrets row cascades. */
export async function deleteGoogleConnection(userId: string, sb?: SupabaseClient): Promise<void> {
  forgetGoogleAccessToken(userId);
  const { error } = await admin(sb).from("admin_google_connections").delete().eq("user_id", userId);
  if (error) throw new Error(`deleteGoogleConnection: ${error.message}`);
}

/** Refresh this long before expiry so a token never dies mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Tokens this server process already read, so a page that makes 26 Google
 * calls doesn't make 52 database reads first. An entry lives at most
 * TOKEN_CACHE_MS, so a disconnect or revoke made on another instance takes
 * effect within that; a token Google rejects is refreshed from the database
 * anyway (`forceRefresh`, on 401).
 */
const TOKEN_CACHE_MS = 60_000;
const tokenCache = new Map<string, { token: string; services: GoogleService[]; expiresAt: number; cachedAt: number }>();
/** One database read per user at a time: parallel callers share it. */
const tokenLoads = new Map<string, Promise<{ token: string; services: GoogleService[]; expiresAt: number }>>();

/** Drop a user's cached token (connect, disconnect, revoke). */
export function forgetGoogleAccessToken(userId: string): void {
  tokenCache.delete(userId);
}

/**
 * A live access token for `service`, refreshed when it is about to expire.
 * Throws when the service was never granted or the grant was revoked (the row
 * is then marked `needs_reauth` so Settings offers Reconnect).
 */
export async function getGoogleAccessToken(
  userId: string,
  service: GoogleService,
  options: { forceRefresh?: boolean } = {},
  sb?: SupabaseClient
): Promise<string> {
  const now = Date.now();
  if (!options.forceRefresh) {
    const hit = tokenCache.get(userId);
    if (hit && now - hit.cachedAt < TOKEN_CACHE_MS && hit.expiresAt - EXPIRY_MARGIN_MS > now) {
      if (!hit.services.includes(service)) throw new Error(`Google ${service} is not connected.`);
      return hit.token;
    }
  }
  const key = `${userId}:${options.forceRefresh ? "force" : "read"}`;
  let load = tokenLoads.get(key);
  if (!load) {
    load = loadAccessToken(userId, options, sb).finally(() => tokenLoads.delete(key));
    tokenLoads.set(key, load);
  }
  try {
    const loaded = await load;
    tokenCache.set(userId, { ...loaded, cachedAt: Date.now() });
    if (!loaded.services.includes(service)) throw new Error(`Google ${service} is not connected.`);
    return loaded.token;
  } catch (error) {
    tokenCache.delete(userId);
    throw error;
  }
}

async function loadAccessToken(
  userId: string,
  options: { forceRefresh?: boolean },
  sb?: SupabaseClient
): Promise<{ token: string; services: GoogleService[]; expiresAt: number }> {
  const db = admin(sb);
  const conn = await getGoogleConnection(userId, db);
  if (!conn) throw new Error("Google is not connected.");
  if (conn.status === "needs_reauth") throw new Error("Google needs to be reconnected.");

  const { data, error } = await db
    .from("admin_google_secrets")
    .select("refresh_token_enc, access_token_enc, access_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getGoogleAccessToken: ${error.message}`);
  if (!data) throw new Error("This Google connection has no stored tokens.");

  const expiresAt = data.access_expires_at ? new Date(data.access_expires_at).getTime() : 0;
  // `forceRefresh`: Google answered 401 to a token we thought was live.
  if (!options.forceRefresh && data.access_token_enc && expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return { token: openToken(data.access_token_enc), services: conn.services, expiresAt };
  }

  let tokens;
  try {
    tokens = await refreshAccessToken(openToken(data.refresh_token_enc));
  } catch (err) {
    if (err instanceof GoogleTokenError && err.code === "invalid_grant") {
      await db
        .from("admin_google_connections")
        .update({ status: "needs_reauth", last_error: "Google access was revoked." })
        .eq("user_id", userId);
    }
    throw err;
  }
  const { error: saveErr } = await db
    .from("admin_google_secrets")
    .update({
      access_token_enc: sealToken(tokens.access_token),
      access_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (saveErr) throw new Error(`getGoogleAccessToken save: ${saveErr.message}`);
  return { token: tokens.access_token, services: conn.services, expiresAt: Date.now() + tokens.expires_in * 1000 };
}
