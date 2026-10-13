import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signState } from "@/lib/cloud/crypto";

/**
 * Oracle tests for the admin Slack OAuth round trip (the Google callback's
 * tests, for Slack's v2 user-token grant).
 *
 * Intent: an admin connects ONE Slack account; the user token is saved for the
 * session's user only when the signed cookie's nonce and user match, every
 * scope the Slack page needs was granted, and the account is the one already
 * connected (if any). Outsiders get a 404. Slack responses are hand-written
 * from its documented `oauth.v2.access` shape.
 */

const COOKIE = "wc_admin_slack_oauth";
const APP_URL = "https://app.test";
const ALL_SCOPES =
  "channels:read,groups:read,im:read,mpim:read,channels:history,groups:history,im:history,mpim:history,users:read,chat:write";

const session = { user: null as { id: string } | null, admin: true };

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => session.user),
}));
vi.mock("@/lib/auth/platform-admin", () => ({
  isPlatformAdmin: vi.fn(async () => session.admin),
}));

const saveSlackConnection = vi.fn(async (input: Record<string, unknown>) => input);
const existing = vi.fn(async (): Promise<{ teamId: string; slackUserId: string } | null> => null);
vi.mock("@/lib/admin/slack/connections", () => ({
  saveSlackConnection: (input: Record<string, unknown>) => saveSlackConnection(input),
  getSlackConnection: () => existing(),
}));

const calls: { url: string; body: string; auth: string | null }[] = [];
let grantScope = ALL_SCOPES;
let accessOk = true;
let rotation = false;

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  calls.push({ url, body: init?.body ? String(init.body) : "", auth: new Headers(init?.headers).get("authorization") });
  if (url === "https://slack.com/api/oauth.v2.access") {
    if (!accessOk) return Promise.resolve(Response.json({ ok: false, error: "invalid_code" }));
    return Promise.resolve(
      Response.json({
        ok: true,
        app_id: "A1",
        team: { id: "T1", name: "WildcatIQ" },
        authed_user: {
          id: "U1",
          scope: grantScope,
          access_token: rotation ? "xoxe.xoxp-user" : "xoxp-user",
          token_type: "user",
          ...(rotation ? { refresh_token: "xoxe-1-refresh", expires_in: 43200 } : {}),
        },
      })
    );
  }
  if (url === "https://slack.com/api/auth.revoke") return Promise.resolve(Response.json({ ok: true, revoked: true }));
  return Promise.resolve(new Response("unexpected", { status: 500 }));
}

function callbackRequest(query: Record<string, string>, cookie?: string): Request {
  const url = new URL("/api/admin/slack/callback", APP_URL);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers: cookie ? { cookie: `${COOKIE}=${cookie}` } : {} });
}

function state(over: Record<string, unknown> = {}): string {
  return signState({ nonce: "n1", userId: "u1", popup: false, ...over }, 600);
}

function errorOf(res: Response): string | null {
  return new URL(res.headers.get("location")!).searchParams.get("slack_error");
}

const revoked = () => calls.filter((c) => c.url === "https://slack.com/api/auth.revoke");

beforeEach(() => {
  process.env.CLOUD_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SLACK_CLIENT_ID = "111.222";
  process.env.SLACK_CLIENT_SECRET = "slack-secret";
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  session.user = { id: "u1" };
  session.admin = true;
  grantScope = ALL_SCOPES;
  accessOk = true;
  rotation = false;
  calls.length = 0;
  saveSlackConnection.mockClear();
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

describe("GET /api/admin/slack/callback", () => {
  it("404s an outsider before anything else", async () => {
    session.admin = false;
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("saves the user token for the session's user, with the workspace and the admin's Slack id", async () => {
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(res.headers.get("location")).toBe(`${APP_URL}/settings?section=connections`);
    expect(saveSlackConnection).toHaveBeenCalledTimes(1);
    expect(saveSlackConnection.mock.calls[0][0]).toEqual({
      userId: "u1",
      teamId: "T1",
      teamName: "WildcatIQ",
      slackUserId: "U1",
      scopes: ALL_SCOPES.split(","),
      accessToken: "xoxp-user",
      // Rotation off: the token never expires.
      refreshToken: null,
      accessExpiresAt: null,
    });
    // The exchange used the registered redirect URI and the client secret.
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("redirect_uri")).toBe(`${APP_URL}/api/admin/slack/callback`);
    expect(form.get("client_secret")).toBe("slack-secret");
    expect(form.get("code")).toBe("c");
    expect(res.headers.get("set-cookie")).toContain(`${COOKIE}=; Path=/; Max-Age=0`);
  });

  it("an app with token rotation on: keeps the refresh token and the 12-hour expiry", async () => {
    rotation = true;
    const before = Date.now();
    await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    const saved = saveSlackConnection.mock.calls[0][0] as { accessToken: string; refreshToken: string; accessExpiresAt: Date };
    expect(saved.accessToken).toBe("xoxe.xoxp-user");
    expect(saved.refreshToken).toBe("xoxe-1-refresh");
    const ms = saved.accessExpiresAt.getTime() - before;
    expect(ms).toBeGreaterThanOrEqual(43_200_000);
    expect(ms).toBeLessThan(43_200_000 + 5_000);
  });

  it("refuses a nonce that does not match the cookie", async () => {
    const res = await callback(callbackRequest({ state: "other", code: "c" }, state()));
    expect(errorOf(res)).toBe("state");
    expect(calls).toHaveLength(0);
  });

  it("refuses a cookie issued to another admin", async () => {
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state({ userId: "u2" })));
    expect(errorOf(res)).toBe("state");
    expect(saveSlackConnection).not.toHaveBeenCalled();
  });

  it("reports a declined consent as denied", async () => {
    const res = await callback(callbackRequest({ state: "n1", error: "access_denied" }, state()));
    expect(errorOf(res)).toBe("denied");
  });

  it("reports Slack's ok:false exchange as exchange", async () => {
    accessOk = false;
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(errorOf(res)).toBe("exchange");
    expect(saveSlackConnection).not.toHaveBeenCalled();
  });

  it("refuses a grant missing chat:write, and revokes it on a first connection", async () => {
    grantScope = ALL_SCOPES.replace(",chat:write", "");
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(errorOf(res)).toBe("scope");
    expect(saveSlackConnection).not.toHaveBeenCalled();
    expect(revoked()).toHaveLength(1);
    expect(revoked()[0].auth).toBe("Bearer xoxp-user");
  });

  it("keeps the token when a short grant comes from the account already connected (Slack may reuse it)", async () => {
    existing.mockResolvedValue({ teamId: "T1", slackUserId: "U1" });
    grantScope = "channels:read";
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(errorOf(res)).toBe("scope");
    expect(revoked()).toHaveLength(0);
  });

  it("refuses a different Slack user than the one connected, and revokes the new token", async () => {
    existing.mockResolvedValue({ teamId: "T1", slackUserId: "U-OTHER" });
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(errorOf(res)).toBe("account");
    expect(saveSlackConnection).not.toHaveBeenCalled();
    expect(revoked()).toHaveLength(1);
  });

  it("refuses a different workspace than the one connected", async () => {
    existing.mockResolvedValue({ teamId: "T-OTHER", slackUserId: "U1" });
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state()));
    expect(errorOf(res)).toBe("account");
  });

  it("answers a popup's opener instead of redirecting", async () => {
    const res = await callback(callbackRequest({ state: "n1", code: "c" }, state({ popup: true })));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"source":"wildcat-admin-slack-oauth","error":null');
    expect(html).toContain(JSON.stringify(APP_URL));
  });

  it("a popup's failure names Slack's own error parameter in its full-page fallback", async () => {
    const res = await callback(callbackRequest({ state: "n1", error: "access_denied" }, state({ popup: true })));
    const html = await res.text();
    expect(html).toContain('"source":"wildcat-admin-slack-oauth","error":"denied"');
    expect(html).toContain("/settings?section=connections&slack_error=denied");
    expect(html).toContain("<title>Slack</title>");
  });
});

describe("GET /api/admin/slack/connect", () => {
  it("asks for the user scopes only, with the HTTPS callback and a state bound to a cookie", async () => {
    const { GET } = await import("../connect/route");
    const res = await GET(new Request(`${APP_URL}/api/admin/slack/connect`));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(loc.searchParams.get("user_scope")).toBe(ALL_SCOPES);
    expect(loc.searchParams.get("scope")).toBeNull();
    expect(loc.searchParams.get("client_id")).toBe("111.222");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${APP_URL}/api/admin/slack/callback`);
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(res.headers.get("set-cookie")).toContain(`${COOKIE}=`);
  });

  it("404s an outsider", async () => {
    session.admin = false;
    const { GET } = await import("../connect/route");
    const res = await GET(new Request(`${APP_URL}/api/admin/slack/connect`));
    expect(res.status).toBe(404);
  });
});
