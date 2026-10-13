/**
 * GET /api/admin/google/callback: Google sends the admin back here.
 *
 * The code is accepted only when `state` equals the nonce in the signed cookie
 * `connect` set AND the session's user is the one it was issued for. Every
 * outcome lands on Settings > Connections (or answers the popup's opener) and
 * clears the cookie. Failures carry `google_error=<code>`:
 *
 *  - `denied`:   declined on Google's consent screen.
 *  - `state`:    no, expired or tampered cookie, or a nonce / user mismatch.
 *  - `exchange`: the code exchange or the identity lookup failed, or no refresh token.
 *  - `scope`:    consent was given but the service's box was left unticked.
 *  - `config`:   Google is not configured on this server.
 *  - `account`:  a different Google account than the one already connected;
 *                disconnect first.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { hasGoogle } from "@/lib/env";
import { verifyState } from "@/lib/cloud/crypto";
import { getGoogleConnection, saveGoogleConnection } from "@/lib/admin/google/connections";
import {
  exchangeCode,
  hasServiceScopes,
  fetchUserInfo,
  isGoogleService,
  revokeToken,
  type GoogleTokenResponse,
  type GoogleUserInfo,
} from "@/lib/admin/google/oauth";
import { GOOGLE_SETTINGS_PATH, popupResponse, wantsPopup } from "@/lib/admin/google/popup";

// Same name in connect/route.ts.
const GOOGLE_OAUTH_COOKIE = "wc_admin_google_oauth";

type GoogleError = "denied" | "state" | "exchange" | "scope" | "config" | "account";

interface StatePayload {
  nonce?: unknown;
  userId?: unknown;
  service?: unknown;
  popup?: unknown;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

const CLEAR_COOKIE = `${GOOGLE_OAUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
  process.env.NODE_ENV === "production" ? "; Secure" : ""
}`;

function land(req: Request, error: GoogleError | null, popup = false): Response {
  if (popup) {
    const res = popupResponse(error);
    res.headers.append("Set-Cookie", CLEAR_COOKIE);
    return res;
  }
  const target = new URL(GOOGLE_SETTINGS_PATH, req.url);
  if (error) target.searchParams.set("google_error", error);
  const res = NextResponse.redirect(target);
  res.headers.set("Cache-Control", "no-store");
  res.headers.append("Set-Cookie", CLEAR_COOKIE);
  return res;
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user || !(await isPlatformAdmin())) return new Response("Not found", { status: 404 });
  if (!hasGoogle()) return land(req, "config");

  const query = new URL(req.url).searchParams;

  let payload: StatePayload | null;
  try {
    payload = verifyState<StatePayload>(readCookie(req, GOOGLE_OAUTH_COOKIE));
  } catch (error) {
    console.error("google callback: state check failed", error);
    payload = null;
  }
  const popup = wantsPopup(payload?.popup);

  const googleError = query.get("error");
  if (googleError) {
    if (googleError !== "access_denied") console.error("google callback: authorize error", googleError);
    return land(req, googleError === "access_denied" ? "denied" : "exchange", popup);
  }

  const state = query.get("state");
  if (
    !payload ||
    typeof payload.nonce !== "string" ||
    !isGoogleService(payload.service) ||
    !state ||
    state !== payload.nonce ||
    payload.userId !== user.id
  ) {
    return land(req, "state", popup);
  }
  const service = payload.service;

  const code = query.get("code");
  if (!code) return land(req, "exchange", popup);

  let tokens: GoogleTokenResponse;
  let info: GoogleUserInfo;
  try {
    tokens = await exchangeCode(code);
    info = await fetchUserInfo(tokens.access_token);
  } catch (error) {
    console.error("google callback: exchange failed", error);
    return land(req, "exchange", popup);
  }

  const scopes = tokens.scope.split(" ").filter(Boolean);
  const revoke = () =>
    revokeToken(tokens.access_token).catch((e) => console.error("google callback: revoking the refused grant failed", e));

  // Fails closed: without knowing what is connected, saving could swap accounts.
  let existing: Awaited<ReturnType<typeof getGoogleConnection>> = null;
  let refusal: GoogleError | null = null;
  try {
    existing = await getGoogleConnection(user.id);
  } catch (error) {
    console.error("google callback: reading the current connection failed", error);
    refusal = "exchange";
  }
  if (!refusal && existing && existing.googleSub !== info.sub) {
    refusal = "account";
  } else if (!refusal && !tokens.refresh_token) {
    console.error("google callback: no refresh token in the token response");
    refusal = "exchange";
  } else if (!refusal && !hasServiceScopes(scopes, service)) {
    // Google's consent screen lets each scope be unticked.
    refusal = "scope";
  }
  if (refusal) {
    // Revoking kills the whole grant, so a same-account refusal keeps it when
    // it still backs the services already connected.
    const sameAccountGrant = existing && existing.googleSub === info.sub;
    if (!sameAccountGrant) await revoke();
    return land(req, refusal, popup);
  }

  try {
    await saveGoogleConnection({
      userId: user.id,
      googleSub: info.sub,
      accountEmail: info.email ?? null,
      scopes,
      refreshToken: tokens.refresh_token!,
      accessToken: tokens.access_token,
      accessExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    });
  } catch (error) {
    console.error("google callback: saving the connection failed", error);
    await revoke();
    return land(req, "exchange", popup);
  }

  return land(req, null, popup);
}
