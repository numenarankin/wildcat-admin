import { describe, it, expect, vi, beforeEach } from "vitest";

/** The cron route: the secret is the gate; the sender runs only behind it. */

const send = vi.fn(async () => ({ sent: ["a"], failed: [] }));
vi.mock("@/lib/admin/outreach/send-scheduled", () => ({ sendDueScheduledEmails: () => send() }));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => ({}) }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
});

describe("GET /api/cron/send-scheduled-emails", () => {
  it("refuses without the secret, and sends nothing", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/cron/send-scheduled-emails"));
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses the wrong secret", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/", { headers: { authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
  });

  it("sends what is due with the right secret", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/", { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
