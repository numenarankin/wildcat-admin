import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quota: Gmail charges 10 units for threads.list and 40 per threads.get,
 * against 6,000 a minute. A refresh must re-fetch only threads whose
 * historyId changed; opening a listed thread at its historyId must not call
 * Gmail at all after the first time.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/google/connections", () => ({ getGoogleAccessToken: async () => "tok" }));

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
let history: Record<string, string> = {};
const calls: string[] = [];

const thread = (id: string, format: string) => ({
  id,
  historyId: history[id],
  messages: [
    {
      id: `m-${id}`,
      internalDate: "1759920000000",
      labelIds: ["INBOX"],
      snippet: "hi",
      payload: {
        partId: "",
        mimeType: format === "full" ? "text/plain" : "text/plain",
        headers: [
          { name: "From", value: "A <a@x.co>" },
          { name: "Subject", value: `S ${id}` },
        ],
        body: { size: 2, data: "aGk" },
      },
    },
  ],
});

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname.replace("/gmail/v1/users/me/", "") + (url.searchParams.get("format") ? `?${url.searchParams.get("format")}` : ""));
      if (url.pathname.endsWith("/threads")) {
        return Response.json({ threads: Object.keys(history).map((id) => ({ id, historyId: history[id] })) });
      }
      const id = url.pathname.split("/").pop()!;
      return Response.json(thread(id, url.searchParams.get("format") ?? ""));
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Gmail cache", () => {
  it("re-fetches only threads that changed, and opens unchanged ones without Gmail", async () => {
    const { listThreads, getThread } = await import("./client");
    void BASE;
    history = { t1: "100", t2: "200", t3: "300" };

    await listThreads("u-cache", { filter: "inbox" });
    expect(calls.sort()).toEqual(["threads", "threads/t1?metadata", "threads/t2?metadata", "threads/t3?metadata"]);

    calls.length = 0;
    const again = await listThreads("u-cache", { filter: "inbox" });
    expect(calls).toEqual(["threads"]); // 10 units, not 130
    expect(again.threads.map((t) => t.historyId)).toEqual(["100", "200", "300"]);

    calls.length = 0;
    history.t2 = "201"; // a new message, or marked read
    await listThreads("u-cache", { filter: "inbox" });
    expect(calls.sort()).toEqual(["threads", "threads/t2?metadata"]);

    calls.length = 0;
    await getThread("u-cache", "t1", "100");
    expect(calls).toEqual(["threads/t1?full"]);
    calls.length = 0;
    await getThread("u-cache", "t1", "100");
    expect(calls).toEqual([]); // second open: free

    calls.length = 0;
    history.t1 = "101";
    await getThread("u-cache", "t1", "101");
    expect(calls).toEqual(["threads/t1?full"]); // changed: fetched again
  });

  it("never serves one user's cache to another", async () => {
    const { listThreads } = await import("./client");
    history = { t9: "900" };
    await listThreads("u-a", { filter: "inbox" });
    calls.length = 0;
    await listThreads("u-b", { filter: "inbox" });
    expect(calls.sort()).toEqual(["threads", "threads/t9?metadata"]);
  });
});
