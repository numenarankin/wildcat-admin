/**
 * GET /api/admin/slack/connect[?popup=1]: start connecting the caller's Slack
 * account.
 *
 * The Google connect route's binding: a random nonce goes to Slack as `state`,
 * and the same nonce travels back in a signed, 10-minute, httpOnly cookie with
 * the session's user id. Outsiders get a 404, like every other admin surface.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { hasSlack } from "@/lib/env";
import { signState } from "@/lib/cloud/crypto";
import { getSlackConnection } from "@/lib/admin/slack/connections";
import { buildSlackAuthorizeUrl } from "@/lib/admin/slack/oauth";
import { popupResponse, wantsPopup } from "@/lib/admin/google/popup";
import { SLACK_POPUP, SLACK_SETTINGS_PATH } from "@/lib/admin/slack/popup";

// Same name in callback/route.ts. A route module may export only handlers.
const SLACK_OAUTH_COOKIE = "wc_admin_slack_oauth";
const STATE_TTL_SECONDS = 600;

function fail(req: Request): Response {
  if (wantsPopup(new URL(req.url).searchParams.get("popup"))) return popupResponse("config", SLACK_POPUP);
  return NextResponse.redirect(new URL(`${SLACK_SETTINGS_PATH}&slack_error=config`, req.url));
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user || !(await isPlatformAdmin())) return new Response("Not found", { status: 404 });
  if (!hasSlack()) return fail(req);

  // Signed, not read off the callback's query, so nobody can tell the callback it is a popup.
  const popup = wantsPopup(new URL(req.url).searchParams.get("popup"));
  const nonce = randomBytes(16).toString("base64url");
  let signed: string;
  let teamId: string | null = null;
  try {
    signed = signState({ nonce, userId: user.id, popup }, STATE_TTL_SECONDS);
    teamId = (await getSlackConnection(user.id))?.teamId ?? null;
  } catch (error) {
    console.error("slack connect: preparing the round trip failed", error);
    return fail(req);
  }
  const res = NextResponse.redirect(buildSlackAuthorizeUrl(nonce, teamId));
  res.headers.set("Cache-Control", "no-store");
  res.cookies.set(SLACK_OAUTH_COOKIE, signed, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return res;
}
