import "server-only";
import { getAppUrl, getGoogleApp } from "@/lib/env";

/**
 * Google OAuth 2 for the admin side: authorization-code flow with the client
 * secret (the exchange runs server side) and offline access for a refresh
 * token. Each service is granted on its own click; `include_granted_scopes`
 * makes every new grant carry the earlier ones too, so one refresh token
 * covers whatever has been connected so far.
 */

export type GoogleService = "gmail" | "calendar" | "tasks" | "drive";

export const GOOGLE_SERVICES: readonly GoogleService[] = ["gmail", "calendar", "tasks", "drive"];

/**
 * Read and write for each, granted up front so later write features need no
 * reconnect. `gmail.modify` reads, sends and labels; it cannot permanently
 * delete. Drive carries `documents` too: Google Docs are read (and later
 * edited) through the Docs API. A service counts as connected only when ALL
 * of its scopes were granted.
 */
export const GOOGLE_SERVICE_SCOPES: Record<GoogleService, readonly string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  calendar: ["https://www.googleapis.com/auth/calendar"],
  tasks: ["https://www.googleapis.com/auth/tasks"],
  drive: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"],
};

/** Who connected: needed to refuse a second, different Google account. */
const IDENTITY_SCOPES = ["openid", "email"] as const;

export function isGoogleService(value: unknown): value is GoogleService {
  return typeof value === "string" && (GOOGLE_SERVICES as readonly string[]).includes(value);
}

/** The services a granted scope list covers. */
export function servicesIn(scopes: readonly string[]): GoogleService[] {
  return GOOGLE_SERVICES.filter((s) => hasServiceScopes(scopes, s));
}

/** Whether `scopes` carries every scope `service` needs. */
export function hasServiceScopes(scopes: readonly string[], service: GoogleService): boolean {
  return GOOGLE_SERVICE_SCOPES[service].every((scope) => scopes.includes(scope));
}

export const GOOGLE_CALLBACK_PATH = "/api/admin/google/callback";

export function googleRedirectUri(): string {
  return `${getAppUrl().replace(/\/$/, "")}${GOOGLE_CALLBACK_PATH}`;
}

function app(): { clientId: string; clientSecret: string } {
  const a = getGoogleApp();
  if (!a) throw new Error("Google is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  return a;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  /** Always present with prompt=consent + access_type=offline. */
  refresh_token?: string;
  /** Space-separated: every scope the grant now carries. */
  scope: string;
  token_type: string;
  id_token?: string;
}

/** A token-endpoint failure. `invalid_grant` on refresh means the grant was revoked. */
export class GoogleTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
    this.name = "GoogleTokenError";
  }
}

export function buildAuthorizeUrl(
  state: string,
  service: GoogleService,
  loginHint: string | null,
  redirectUri = googleRedirectUri()
): string {
  const params = new URLSearchParams({
    client_id: app().clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [...IDENTITY_SCOPES, ...GOOGLE_SERVICE_SCOPES[service]].join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    // Without it Google returns a refresh token only on the very first grant.
    prompt: "consent",
    state,
  });
  // Steers the account chooser to the account already connected.
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenCall(form: Record<string, string>, fetchImpl: typeof fetch): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = app();
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) {
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: string };
      code = typeof body.error === "string" ? body.error : null;
    } catch {
      // Non-JSON error body; the status is enough.
    }
    throw new GoogleTokenError(
      `Google token request failed (${res.status}${code ? `, ${code}` : ""}).`,
      res.status,
      code
    );
  }
  return (await res.json()) as GoogleTokenResponse;
}

/** Exchange the one-time authorization code from the callback. */
export function exchangeCode(
  code: string,
  redirectUri = googleRedirectUri(),
  fetchImpl: typeof fetch = fetch
): Promise<GoogleTokenResponse> {
  return tokenCall({ code, grant_type: "authorization_code", redirect_uri: redirectUri }, fetchImpl);
}

/** Mint a new short-lived access token. */
export function refreshAccessToken(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<GoogleTokenResponse> {
  return tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

/**
 * Revoke the whole grant (every service at once; Google has no per-scope
 * revoke). A 400 means the token is already dead, which is the outcome wanted.
 */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!res.ok && res.status !== 400) throw new Error(`Google revoke failed (${res.status}).`);
}

export interface GoogleUserInfo {
  sub: string;
  email?: string;
}

/** Who just connected. */
export async function fetchUserInfo(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<GoogleUserInfo> {
  const res = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google userinfo failed (${res.status}).`);
  return (await res.json()) as GoogleUserInfo;
}
