import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opening an email: one Google call for the whole thread, inline images
 * pointed at the attachment route (not fetched), and a 404 for anyone who
 * isn't an admin before any Google call.
 */

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
const session = { user: { id: "u1" } as { id: string } | null, admin: true };
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn(async () => session.user) }));
vi.mock("@/lib/auth/platform-admin", () => ({ isPlatformAdmin: vi.fn(async () => session.admin) }));
vi.mock("@/lib/admin/google/connections", () => ({ getGoogleAccessToken: async (id: string) => `token-for-${id}` }));

const calls: string[] = [];
// "<p><img src=\"cid:logo@x\"></p>" in base64url.
const HTML = Buffer.from('<p><img src="cid:logo@x"></p>').toString("base64url");

beforeEach(() => {
  session.user = { id: "u1" };
  session.admin = true;
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url !== `${BASE}threads/t1?format=full`) return Response.json({}, { status: 404 });
      return Response.json({
        id: "t1",
        messages: [
          {
            id: "m1",
            internalDate: "1759920000000",
            labelIds: ["INBOX"],
            payload: {
              partId: "",
              mimeType: "multipart/related",
              headers: [
                { name: "From", value: "Dropbox <no-reply@dropbox.test>" },
                { name: "To", value: "rankin@wildcat.test" },
                { name: "Subject", value: "Trial ends" },
              ],
              parts: [
                { partId: "0", mimeType: "text/html", body: { size: 30, data: HTML } },
                {
                  partId: "1",
                  mimeType: "image/png",
                  filename: "logo.png",
                  headers: [{ name: "Content-ID", value: "<logo@x>" }, { name: "Content-Disposition", value: "inline" }],
                  body: { size: 9000, attachmentId: "A1" },
                },
              ],
            },
          },
        ],
      });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const get = async (q: string) => {
  const { GET } = await import("./route");
  return GET(new Request(`https://app.test/api/admin/google/gmail/thread?${q}`));
};

describe("GET /api/admin/google/gmail/thread", () => {
  it("404s a non-admin before any Google call", async () => {
    session.admin = false;
    expect((await get("id=t1")).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("makes one Google call and points inline images at the attachment route", async () => {
    const res = await get("id=t1");
    const body = await res.json();
    expect(calls).toEqual([`${BASE}threads/t1?format=full`]);
    expect(body.ok).toBe(true);
    expect(body.data.subject).toBe("Trial ends");
    expect(body.data.messages[0].fromEmail).toBe("no-reply@dropbox.test");
    expect(body.data.messages[0].html).toBe('<p><img src="/api/admin/google/gmail/attachment?m=m1&amp;p=1"></p>');
  });
});
