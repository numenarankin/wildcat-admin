import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Orion can never write to Gmail. Inside an Orion call, the fetch layer
 * refuses any non-GET to the Gmail API before a token is read or a request
 * leaves; reads still work, and the user's own sends (outside an Orion call)
 * are untouched.
 */

vi.mock("server-only", () => ({}));
const getGoogleAccessToken = vi.fn(async () => "tok");
vi.mock("@/lib/admin/google/connections", () => ({ getGoogleAccessToken: () => getGoogleAccessToken() }));

const fetchSpy = vi.fn(async () => Response.json({ id: "m1", threadId: "t1" }));
beforeEach(() => {
  fetchSpy.mockClear();
  getGoogleAccessToken.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

const SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

describe("the Orion Gmail-write guard", () => {
  it("refuses a send inside an Orion call before anything leaves", async () => {
    const { googleFetch } = await import("./fetch");
    const { runAsOrion } = await import("./orion-guard");
    await expect(
      runAsOrion(() => googleFetch("u1", "gmail", SEND, { method: "POST", json: { raw: "x" } }))
    ).rejects.toThrow("Orion cannot write to Gmail");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
  });

  it("refuses every Gmail write method, drafts and labels included", async () => {
    const { googleFetch } = await import("./fetch");
    const { runAsOrion } = await import("./orion-guard");
    for (const [method, path] of [
      ["POST", "drafts"],
      ["POST", "drafts/send"],
      ["PUT", "drafts/d1"],
      ["POST", "threads/t1/modify"],
      ["DELETE", "messages/m1"],
      ["post", "messages/import"],
    ]) {
      await expect(
        runAsOrion(() => googleFetch("u1", "gmail", `https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { method }))
      ).rejects.toThrow("Orion cannot write to Gmail");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("holds through awaits deep inside the call", async () => {
    const { googleFetch } = await import("./fetch");
    const { runAsOrion } = await import("./orion-guard");
    const deep = async () => {
      await new Promise((r) => setTimeout(r, 1));
      await Promise.resolve();
      return googleFetch("u1", "gmail", SEND, { method: "POST" });
    };
    await expect(runAsOrion(deep)).rejects.toThrow("Orion cannot write to Gmail");
  });

  it("lets Orion read", async () => {
    const { googleFetch } = await import("./fetch");
    const { runAsOrion } = await import("./orion-guard");
    await runAsOrion(() => googleFetch("u1", "gmail", "https://gmail.googleapis.com/gmail/v1/users/me/threads"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves the user's own send alone", async () => {
    const { googleFetch } = await import("./fetch");
    await googleFetch("u1", "gmail", SEND, { method: "POST", json: { raw: "x" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
