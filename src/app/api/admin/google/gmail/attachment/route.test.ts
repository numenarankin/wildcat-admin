import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Oracle tests for the Gmail attachment download. Intent (plan 7.1, 12): an
 * admin downloads an attachment of their own mail through the server, never
 * stored; anyone else gets a 404 before any Google call.
 */

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
const session = { user: null as { id: string } | null, admin: true };

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => session.user),
}));
vi.mock("@/lib/auth/platform-admin", () => ({
  isPlatformAdmin: vi.fn(async () => session.admin),
}));
const getGoogleAccessToken = vi.fn(async (userId: string) => `token-for-${userId}`);
vi.mock("@/lib/admin/google/connections", () => ({
  getGoogleAccessToken: (userId: string) => getGoogleAccessToken(userId),
}));

const calls: { url: string; auth: string | null }[] = [];
let routes: Record<string, () => Response> = {};

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
  const handler = routes[url];
  return Promise.resolve(handler ? handler() : Response.json({ error: { message: "Not Found" } }, { status: 404 }));
}

function request(query: string): Request {
  return new Request(`https://app.test/api/admin/google/gmail/attachment?${query}`);
}

async function get(req: Request): Promise<Response> {
  const { GET } = await import("./route");
  return GET(req);
}

beforeEach(() => {
  session.user = { id: "u1" };
  session.admin = true;
  calls.length = 0;
  routes = {
    [`${BASE}messages/m1?format=full`]: () =>
      Response.json({
        id: "m1",
        threadId: "t1",
        payload: {
          partId: "",
          mimeType: "multipart/mixed",
          parts: [
            { partId: "0", mimeType: "text/plain", body: { size: 2, data: "aGk" } },
            {
              partId: "1",
              mimeType: "application/pdf",
              filename: "café.pdf",
              body: { size: 3, attachmentId: "A1" },
            },
            // "PGI-" -> "<b>"
            { partId: "2", mimeType: "text/html", filename: "page.html", body: { size: 3, data: "PGI-" } },
          ],
        },
      }),
    // "AQID" -> 01 02 03
    [`${BASE}messages/m1/attachments/A1`]: () => Response.json({ size: 3, data: "AQID" }),
  };
  getGoogleAccessToken.mockClear();
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/admin/google/gmail/attachment", () => {
  it("404s a signed-in non-admin before any Google call", async () => {
    session.admin = false;
    const res = await get(request("m=m1&p=1"));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
  });

  it("404s a signed-out visitor before any Google call", async () => {
    session.user = null;
    const res = await get(request("m=m1&p=1"));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("404s malformed ids without calling Google", async () => {
    for (const q of ["m=..%2Fx&p=1", "m=m1&p=1%2F..", "m=m1", "p=1"]) {
      expect((await get(request(q))).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("sends the bytes as a download, with the session's own token", async () => {
    const res = await get(request("m=m1&p=1"));
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { url: `${BASE}messages/m1?format=full`, auth: "Bearer token-for-u1" },
      { url: `${BASE}messages/m1/attachments/A1`, auth: "Bearer token-for-u1" },
    ]);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="caf_.pdf"; filename*=UTF-8''caf%C3%A9.pdf`
    );
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("404s a part the message doesn't have", async () => {
    expect((await get(request("m=m1&p=5"))).status).toBe(404);
  });

  it("404s a message Google doesn't have", async () => {
    expect((await get(request("m=zz&p=1"))).status).toBe(404);
  });

  it("shows a PDF in the browser when asked to view it", async () => {
    const res = await get(request("m=m1&p=1&view=1"));
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="caf_.pdf"; filename*=UTF-8''caf%C3%A9.pdf`);
  });

  it("never shows HTML on our origin, even when asked", async () => {
    const res = await get(request("m=m1&p=2&view=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="page.html"; filename*=UTF-8''page.html`);
  });
});
