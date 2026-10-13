/**
 * GET /api/admin/google/connect?service=gmail|calendar|tasks[&popup=1]: start
 * granting one Google service to the caller's admin connection.
 *
 * Same binding as the Dropbox connect route: a random nonce goes to Google as
 * `state`, and the same nonce travels back in a signed, 10-minute, httpOnly
 * cookie with the session's user id and the service asked for. Outsiders get
 * a 404, like every other admin surface.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { hasGoogle } from "@/lib/env";
import { signState } from "@/lib/cloud/crypto";
import { getGoogleConnection } from "@/lib/admin/google/connections";
import { buildAuthorizeUrl, isGoogleService } from "@/lib/admin/google/oauth";
import { GOOGLE_SETTINGS_PATH, popupResponse, wantsPopup } from "@/lib/admin/google/popup";

// Same name in callback/route.ts. A route module may export only handlers.
const GOOGLE_OAUTH_COOKIE = "wc_admin_google_oauth";
const STATE_TTL_SECONDS = 600;

function fail(req: Request, code: "config" | "service"): Response {
  if (wantsPopup(new URL(req.url).searchParams.get("popup"))) return popupResponse(code);
  return NextResponse.redirect(new URL(`${GOOGLE_SETTINGS_PATH}&google_error=${code}`, req.url));
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user || !(await isPlatformAdmin())) return new Response("Not found", { status: 404 });
  if (!hasGoogle()) return fail(req, "config");

  const query = new URL(req.url).searchParams;
  const service = query.get("service");
  if (!isGoogleService(service)) return fail(req, "service");

  // Signed, not read off the callback's query, so nobody can tell the callback it is a popup.
  const popup = wantsPopup(query.get("popup"));
  const nonce = randomBytes(16).toString("base64url");
  let signed: string;
  let loginHint: string | null = null;
  try {
    signed = signState({ nonce, userId: user.id, service, popup }, STATE_TTL_SECONDS);
    loginHint = (await getGoogleConnection(user.id))?.accountEmail ?? null;
  } catch (error) {
    console.error("google connect: preparing the round trip failed", error);
    return fail(req, "config");
  }
  const res = NextResponse.redirect(buildAuthorizeUrl(nonce, service, loginHint));
  res.headers.set("Cache-Control", "no-store");
  res.cookies.set(GOOGLE_OAUTH_COOKIE, signed, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return res;
}
