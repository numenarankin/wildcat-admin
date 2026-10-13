import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The access-token cache: a page's burst of Google calls costs one pair of
 * database reads, not two per call, and the cache never outlives a minute or
 * a disconnect.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => fake }));
vi.mock("@/lib/cloud/crypto", () => ({ openToken: (s: string) => `open:${s}`, sealToken: (s: string) => `seal:${s}` }));

let reads = 0;
const GMAIL = "https://www.googleapis.com/auth/gmail.modify";
const fake = {
  from(table: string) {
    const row =
      table === "admin_google_connections"
        ? { user_id: "u1", google_sub: "g", account_email: null, scopes: [GMAIL], status: "active", last_error: null }
        : { refresh_token_enc: "r", access_token_enc: "a", access_expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const q = {
      select: () => q,
      eq: () => q,
      delete: () => q,
      maybeSingle: async () => {
        reads++;
        await Promise.resolve();
        return { data: row, error: null };
      },
      then: (ok: (v: { error: null }) => void) => ok({ error: null }),
    };
    return q;
  },
};

beforeEach(async () => {
  reads = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  const { forgetGoogleAccessToken } = await import("./connections");
  forgetGoogleAccessToken("u1");
});
afterEach(() => vi.useRealTimers());

describe("getGoogleAccessToken", () => {
  it("serves 26 parallel calls from one pair of reads", async () => {
    const { getGoogleAccessToken } = await import("./connections");
    const tokens = await Promise.all(Array.from({ length: 26 }, () => getGoogleAccessToken("u1", "gmail")));
    expect(new Set(tokens)).toEqual(new Set(["open:a"]));
    expect(reads).toBe(2);
  });

  it("reads again after a minute", async () => {
    const { getGoogleAccessToken } = await import("./connections");
    await getGoogleAccessToken("u1", "gmail");
    vi.setSystemTime(new Date("2026-10-08T12:00:59Z"));
    await getGoogleAccessToken("u1", "gmail");
    expect(reads).toBe(2);
    vi.setSystemTime(new Date("2026-10-08T12:01:01Z"));
    await getGoogleAccessToken("u1", "gmail");
    expect(reads).toBe(4);
  });

  it("still refuses a service that wasn't granted, from the cache too", async () => {
    const { getGoogleAccessToken } = await import("./connections");
    await getGoogleAccessToken("u1", "gmail");
    await expect(getGoogleAccessToken("u1", "drive")).rejects.toThrow("Google drive is not connected.");
    expect(reads).toBe(2);
  });

  it("forgets the token on disconnect", async () => {
    const { getGoogleAccessToken, deleteGoogleConnection } = await import("./connections");
    await getGoogleAccessToken("u1", "gmail");
    await deleteGoogleConnection("u1");
    await getGoogleAccessToken("u1", "gmail");
    expect(reads).toBe(4);
  });
});
