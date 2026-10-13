/**
 * GET /api/admin/slack/callback: Slack sends the admin back here.
 *
 * The Google callback's rules: the code is accepted only when `state` equals
 * the nonce in the signed cookie `connect` set AND the session's user is the
 * one it was issued for. Every outcome lands on Settings > Connections (or
 * answers the popup's opener) and clears the cookie. Failures carry
 * `slack_error=<code>`:
 *
 *  - `denied`:   declined on Slack's consent screen.
 *  - `state`:    no, expired or tampered cookie, or a nonce / user mismatch.
 *  - `exchange`: the code exchange failed, or no user token came back.
 *  - `scope`:    the grant is missing a scope the page needs.
 *  - `config`:   Slack is not configured on this server.
 *  - `account`:  a different Slack account or workspace than the one already
 *                connected; disconnect first.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { hasSlack } from "@/lib/env";
import { verifyState } from "@/lib/cloud/crypto";
import { getSlackConnection, saveSlackConnection } from "@/lib/admin/slack/connections";
import { exchangeSlackCode, hasSlackScopes, revokeSlackToken, type SlackAccessResponse } from "@/lib/admin/slack/oauth";
import { popupResponse, wantsPopup } from "@/lib/admin/google/popup";
import { SLACK_POPUP, SLACK_SETTINGS_PATH } from "@/lib/admin/slack/popup";

// Same name in connect/route.ts.
const SLACK_OAUTH_COOKIE = "wc_admin_slack_oauth";

type SlackError = "denied" | "state" | "exchange" | "scope" | "config" | "account";

interface StatePayload {
  nonce?: unknown;
  userId?: unknown;
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

const CLEAR_COOKIE = `${SLACK_OAUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
  process.env.NODE_ENV === "production" ? "; Secure" : ""
}`;

function land(req: Request, error: SlackError | null, popup = false): Response {
  if (popup) {
    const res = popupResponse(error, SLACK_POPUP);
    res.headers.append("Set-Cookie", CLEAR_COOKIE);
    return res;
  }
  const target = new URL(SLACK_SETTINGS_PATH, req.url);
  if (error) target.searchParams.set("slack_error", error);
  const res = NextResponse.redirect(target);
  res.headers.set("Cache-Control", "no-store");
  res.headers.append("Set-Cookie", CLEAR_COOKIE);
  return res;
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user || !(await isPlatformAdmin())) return new Response("Not found", { status: 404 });
  if (!hasSlack()) return land(req, "config");

  const query = new URL(req.url).searchParams;

  let payload: StatePayload | null;
  try {
    payload = verifyState<StatePayload>(readCookie(req, SLACK_OAUTH_COOKIE));
  } catch (error) {
    console.error("slack callback: state check failed", error);
    payload = null;
  }
  const popup = wantsPopup(payload?.popup);

  const slackError = query.get("error");
  if (slackError) {
    if (slackError !== "access_denied") console.error("slack callback: authorize error", slackError);
    return land(req, slackError === "access_denied" ? "denied" : "exchange", popup);
  }

  const state = query.get("state");
  if (!payload || typeof payload.nonce !== "string" || !state || state !== payload.nonce || payload.userId !== user.id) {
    return land(req, "state", popup);
  }

  const code = query.get("code");
  if (!code) return land(req, "exchange", popup);

  let grant: SlackAccessResponse;
  try {
    grant = await exchangeSlackCode(code);
  } catch (error) {
    console.error("slack callback: exchange failed", error);
    return land(req, "exchange", popup);
  }
  const authed = grant.authed_user;
  const token = authed?.access_token;
  if (!authed || !token || !grant.team?.id) {
    console.error("slack callback: no user token in the response");
    return land(req, "exchange", popup);
  }
  const scopes = (authed.scope ?? "").split(",").filter(Boolean);
  const revoke = () => revokeSlackToken(token).catch((e) => console.error("slack callback: revoking the refused token failed", e));

  // Fails closed: without knowing what is connected, saving could swap accounts.
  let refusal: SlackError | null = null;
  let sameAccount = false;
  try {
    const existing = await getSlackConnection(user.id);
    sameAccount = existing !== null && existing.teamId === grant.team.id && existing.slackUserId === authed.id;
    if (existing && !sameAccount) refusal = "account";
  } catch (error) {
    console.error("slack callback: reading the current connection failed", error);
    refusal = "exchange";
  }
  if (!refusal && !hasSlackScopes(scopes)) refusal = "scope";
  if (refusal) {
    // Slack can hand the same user token back on a re-grant, so a same-account
    // refusal keeps it: it may be the one the live connection holds.
    if (!sameAccount) await revoke();
    return land(req, refusal, popup);
  }

  try {
    await saveSlackConnection({
      userId: user.id,
      teamId: grant.team.id,
      teamName: grant.team.name ?? null,
      slackUserId: authed.id,
      scopes,
      accessToken: token,
      // Present only when the Slack app has token rotation on.
      refreshToken: authed.refresh_token ?? null,
      accessExpiresAt: authed.expires_in ? new Date(Date.now() + authed.expires_in * 1000) : null,
    });
  } catch (error) {
    console.error("slack callback: saving the connection failed", error);
    if (!sameAccount) await revoke();
    return land(req, "exchange", popup);
  }

  return land(req, null, popup);
}
