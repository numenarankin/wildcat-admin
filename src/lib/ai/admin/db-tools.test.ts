import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The database catalog: read-only tools only, the platform-admin gate before
 * any query, size limits that refuse rather than return a partial result, and
 * plan changes read off Stripe invoice lines.
 */

const isAdmin = vi.fn(async () => true);
vi.mock("@/lib/auth/platform-admin", () => ({ isPlatformAdmin: () => isAdmin() }));
const rpc = vi.fn(async (..._a: unknown[]): Promise<{ data: unknown; error: { message: string } | null }> => ({ data: null, error: null }));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/env", () => ({ hasStripe: () => false }));

beforeEach(() => {
  vi.clearAllMocks();
  isAdmin.mockResolvedValue(true);
});

describe("dbTools", () => {
  it("offers exactly the five read tools, none of them a write", async () => {
    const { dbTools, DB_TOOL_NAMES } = await import("./db-tools");
    const tools = dbTools() as Record<string, { needsApproval?: boolean }>;
    expect(Object.keys(tools).sort()).toEqual([...DB_TOOL_NAMES].sort());
    for (const t of Object.values(tools)) expect(t.needsApproval).toBeUndefined();
  });
});

describe("runReadQuery", () => {
  it("refuses a non-admin before calling the database", async () => {
    isAdmin.mockResolvedValue(false);
    const { runReadQuery } = await import("@/lib/admin/db-read");
    await expect(runReadQuery("select 1")).rejects.toThrow(/Platform admin/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes the SQL and the row limit to orion_read_query and returns the rows", async () => {
    rpc.mockResolvedValueOnce({ data: { rows: [{ n: 3 }], rowCount: 1 }, error: null });
    const { runReadQuery, MAX_ROWS } = await import("@/lib/admin/db-read");
    expect(await runReadQuery("select count(*) n from organizations")).toEqual({ ok: true, rows: [{ n: 3 }], rowCount: 1 });
    expect(rpc).toHaveBeenCalledWith("orion_read_query", { p_sql: "select count(*) n from organizations", p_max_rows: MAX_ROWS });
  });

  it("returns nothing, and says why, when the result is over the row limit", async () => {
    rpc.mockResolvedValueOnce({ data: { error: "too_many_rows", limit: 2000 }, error: null });
    const { runReadQuery } = await import("@/lib/admin/db-read");
    const r = await runReadQuery("select * from wells");
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("rows");
    expect(!r.ok && r.error).toMatch(/More than 2000 rows/);
  });

  it("returns nothing when the rows are over the character limit", async () => {
    const big = Array.from({ length: 100 }, () => ({ text: "x".repeat(3_000) }));
    rpc.mockResolvedValueOnce({ data: { rows: big, rowCount: 100 }, error: null });
    const { runReadQuery } = await import("@/lib/admin/db-read");
    const r = await runReadQuery("select text from notes");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/over the 200000 limit/);
  });

  it("hands back the database's refusal (a write, a secret column) as an error", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "permission denied for table owner_w9s" } });
    const { runReadQuery } = await import("@/lib/admin/db-read");
    expect(await runReadQuery("select tin from owner_w9s")).toEqual({ ok: false, error: "permission denied for table owner_w9s" });
  });
});

describe("planChanges", () => {
  const line = (o: Partial<import("@/lib/admin/billing-history").PlanLine>) => ({
    description: null, amountCents: 0, quantity: null, tier: null, priceId: null, interval: null, proration: false,
    periodStart: null, periodEnd: null, ...o,
  });

  it("lists the starting plan, then each tier or interval change, skipping repeats, unused-time credits and top-ups", async () => {
    const { planChanges } = await import("@/lib/admin/billing-history");
    const month = { priceId: "price_m", interval: "month" };
    const year = { priceId: "price_y", interval: "year" };
    const changes = planChanges([
      // newest first, as Stripe lists them
      { id: "in_6", lines: [line({ ...year, quantity: 30, tier: "Tier 2", amountCents: 900000, periodStart: "2026-12-15T00:00:00Z" })] },
      { id: "in_5", lines: [line({ ...month, quantity: 30, tier: "Tier 2", amountCents: 90000, periodStart: "2026-11-15T00:00:00Z" })] },
      { id: "in_4", lines: [line({ priceId: "price_topup", amountCents: 5000, quantity: 1, periodStart: "2026-11-01T00:00:00Z" })] },
      {
        id: "in_3",
        lines: [
          line({ ...month, quantity: 20, tier: "Tier 1", amountCents: -500, proration: true, periodStart: "2026-10-20T00:00:00Z" }),
          line({ ...month, quantity: 30, tier: "Tier 2", amountCents: 1500, proration: true, periodStart: "2026-10-20T00:00:00Z" }),
        ],
      },
      { id: "in_2", lines: [line({ ...month, quantity: 20, tier: "Tier 1", amountCents: 2000, periodStart: "2026-10-15T00:00:00Z" })] },
      { id: "in_1", lines: [line({ ...month, quantity: 20, tier: "Tier 1", amountCents: 2000, periodStart: "2026-09-15T00:00:00Z" })] },
    ]);
    expect(changes).toEqual([
      { at: "2026-09-15T00:00:00Z", invoice: "in_1", from: null, to: { tier: "Tier 1", quantity: 20, interval: "month" } },
      {
        at: "2026-10-20T00:00:00Z",
        invoice: "in_3",
        from: { tier: "Tier 1", quantity: 20, interval: "month" },
        to: { tier: "Tier 2", quantity: 30, interval: "month" },
      },
      {
        at: "2026-12-15T00:00:00Z",
        invoice: "in_6",
        from: { tier: "Tier 2", quantity: 30, interval: "month" },
        to: { tier: "Tier 2", quantity: 30, interval: "year" },
      },
    ]);
  });
});
