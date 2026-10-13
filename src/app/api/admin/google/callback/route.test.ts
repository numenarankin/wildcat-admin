import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signState } from "@/lib/cloud/crypto";

/**
 * Oracle tests for the admin Google OAuth round trip.
 *
 * Intent: an admin grants Gmail, Calendar or Tasks one at a time to ONE Google
 * account; the grant is saved for the session's user only when the signed
 * cookie's nonce and user match, the service's scope was actually granted, and
 * the Google account is the one already connected (if any). Outsiders get a
 * 404. Google responses are hand-written from its documented shapes.
 */

const GMAIL = "https://www.googleapis.com/auth/gmail.modify";
const CALENDAR = "https://www.googleapis.com/auth/calendar";
const COOKIE = "wc_admin_google_oauth";
const APP_URL = "https://app.test";

const session = { user: null as { id: string } | null, admin: true };

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => session.user),
}));
vi.mock("@/lib/auth/platform-admin", () => ({
  isPlatformAdmin: vi.fn(async () => session.admin),
}));

const saveGoogleConnection = vi.fn(async (input: Record<string, unknown>) => input);
const existing = vi.fn(async (): Promise<{ googleSub: string; accountEmail: string } | null> => null);
vi.mock("@/lib/admin/google/connections", () => ({
  saveGoogleConnection: (input: Record<string, unknown>) => saveGoogleConnection(input),
  getGoogleConnection: () => existing(),
}));

const calls: { url: string; body: string }[] = [];
let tokenScope = `openid email ${GMAIL}`;
let refreshToken: string | undefined = "1//refresh";

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  calls.push({ url, body: init?.body ? String(init.body) : "" });
  if (url === "https://oauth2.googleapis.com/token") {
    return Promise.resolve(
      Response.json({
        access_token: "ya29.access",
        expires_in: 3599,
        refresh_token: refreshToken,
        scope: tokenScope,
        token_type: "Bearer",
      })
    );
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    return Promise.resolve(Response.json({ sub: "sub-1", email: "rankin@wildcatiq.ai" }));
  }
  if (url === "https://oauth2.googleapis.com/revoke") return Promise.resolve(new Response("", { status: 200 }));
  return Promise.resolve(new Response("unexpected", { status: 500 }));
}

function callbackRequest(query: Record<string, string>, cookie?: string): Request {
  const url = new URL("/api/admin/google/callback", APP_URL);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers: cookie ? { cookie: `${COOKIE}=${cookie}` } : {} });
}

function state(over: Record<string, unknown> = {}): string {
  return signState({ nonce: "n1", userId: "u1", service: "gmail", popup: false, ...over }, 600);
}

function errorOf(res: Response): string | null {
  return new URL(res.headers.get("location")!).searchParams.get("google_error");
}

beforeEach(() => {
  process.env.CLOUD_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.GOOGLE_CLIENT_ID = "client.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  session.user = { id: "u1" };
  session.admin = true;
  tokenScope = `openid email ${GMAIL}`;
  refreshToken = "1//refresh";
  calls.length = 0;
  saveGoogleConnection.mockClear();
  existing.mockReset().mockResolvedValue(null);
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function callback(req: Request): Promise<Response> {
  const { GET } = await import("./route");
  return GET(req);
}

describe("GET /api/admin/google/callback", () => {
  it("404s an outsider before anything else", async () => {
    session.admin = false;
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("saves the grant for the session's user with every scope Google reported", async () => {
    tokenScope = `openid email ${CALENDAR} ${GMAIL}`;
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(res.headers.get("location")).toBe(`${APP_URL}/settings?section=connections`);
    expect(saveGoogleConnection).toHaveBeenCalledTimes(1);
    const saved = saveGoogleConnection.mock.calls[0][0];
    expect(saved).toMatchObject({
      userId: "u1",
      googleSub: "sub-1",
      accountEmail: "rankin@wildcatiq.ai",
      refreshToken: "1//refresh",
      accessToken: "ya29.access",
      scopes: ["openid", "email", CALENDAR, GMAIL],
    });
    // The exchange used the registered redirect URI and the client secret.
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("redirect_uri")).toBe(`${APP_URL}/api/admin/google/callback`);
    expect(form.get("client_secret")).toBe("secret");
    expect(res.headers.get("set-cookie")).toContain(`${COOKIE}=; Path=/; Max-Age=0`);
  });

  it("refuses a nonce that does not match the cookie", async () => {
    const res = await callback(callbackRequest({ state: "other", code: "c" }, state()));
    expect(errorOf(res)).toBe("state");
    expect(calls).toHaveLength(0);
  });

  it("refuses a cookie issued to another admin", async () => {
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state({ userId: "u2" })));
    expect(errorOf(res)).toBe("state");
    expect(saveGoogleConnection).not.toHaveBeenCalled();
  });

  it("reports a declined consent as denied", async () => {
    const res = await callback(callbackRequest({ state: "n1", error: "access_denied" }, state()));
    expect(errorOf(res)).toBe("denied");
  });

  it("refuses when the service's box was unticked, and revokes a first grant", async () => {
    tokenScope = "openid email";
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(errorOf(res)).toBe("scope");
    expect(saveGoogleConnection).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === "https://oauth2.googleapis.com/revoke")).toBe(true);
  });

  it("keeps the existing grant when an unticked box comes from the same account", async () => {
    existing.mockResolvedValue({ googleSub: "sub-1", accountEmail: "rankin@wildcatiq.ai" });
    tokenScope = `openid email ${GMAIL}`;
    const res = await callback(
      callbackRequest({ state: "n1", code: "c" }, state({ service: "calendar" }))
    );
    expect(errorOf(res)).toBe("scope");
    expect(calls.some((c) => c.url === "https://oauth2.googleapis.com/revoke")).toBe(false);
  });

  it("refuses a different Google account than the one connected, and revokes the new grant", async () => {
    existing.mockResolvedValue({ googleSub: "sub-OTHER", accountEmail: "x@example.com" });
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(errorOf(res)).toBe("account");
    expect(saveGoogleConnection).not.toHaveBeenCalled();
    const revoke = calls.find((c) => c.url === "https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(revoke!.body).get("token")).toBe("ya29.access");
  });

  it("refuses Drive when only one of its two scopes was granted", async () => {
    tokenScope = "openid email https://www.googleapis.com/auth/drive";
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state({ service: "drive" })));
    expect(errorOf(res)).toBe("scope");
    expect(saveGoogleConnection).not.toHaveBeenCalled();
  });

  it("refuses a grant with no refresh token", async () => {
    refreshToken = undefined;
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(errorOf(res)).toBe("exchange");
    expect(saveGoogleConnection).not.toHaveBeenCalled();
  });

  it("answers a popup's opener instead of redirecting", async () => {
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state({ popup: true })));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"source":"wildcat-admin-google-oauth","error":null');
    expect(html).toContain(JSON.stringify(APP_URL));
  });
});

describe("GET /api/admin/google/connect", () => {
  it("sends one service's scope with incremental auth and offline access", async () => {
    const { GET } = await import("../connect/route");
    const res = await GET(new Request(`${APP_URL}/api/admin/google/connect?service=tasks`));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/tasks");
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("include_granted_scopes")).toBe("true");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(res.headers.get("set-cookie")).toContain(`${COOKIE}=`);
  });

  it("asks for Drive and Docs together", async () => {
    const { GET } = await import("../connect/route");
    const res = await GET(new Request(`${APP_URL}/api/admin/google/connect?service=drive`));
    expect(new URL(res.headers.get("location")!).searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents"
    );
  });

  it("404s an outsider", async () => {
    session.admin = false;
    const { GET } = await import("../connect/route");
    const res = await GET(new Request(`${APP_URL}/api/admin/google/connect?service=tasks`));
    expect(res.status).toBe(404);
  });

  it("rejects an unknown service", async () => {
    const { GET } = await import("../connect/route");
    const res = await GET(new Request(`${APP_URL}/api/admin/google/connect?service=photos`));
    expect(new URL(res.headers.get("location")!).searchParams.get("google_error")).toBe("service");
  });
});
