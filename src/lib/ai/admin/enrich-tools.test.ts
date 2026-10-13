import { describe, it, expect, vi } from "vitest";

/**
 * The Enrich catalog: research and the card's save tools, nothing that
 * sends, enrolls or schedules. The names are pinned so a tool cannot be
 * added quietly, and the one status a tool may not set is refused by its
 * own schema.
 */

vi.mock("@/lib/admin/outreach/research-actions", () => ({
  saveWebsite: vi.fn(async () => {}),
  saveResearchNotes: vi.fn(async () => {}),
  setResearchStatus: vi.fn(async () => {}),
  upsertContacts: vi.fn(async () => []),
}));
vi.mock("@/lib/admin/exa", () => ({ hasExa: () => false, exaSearch: vi.fn(), exaContents: vi.fn() }));
vi.mock("@/lib/admin/hunter", () => ({
  hasHunter: () => false,
  hunterDomainSearch: vi.fn(),
  hunterEmailFinder: vi.fn(),
  hunterVerify: vi.fn(),
}));

describe("enrichTools", () => {
  it("offers exactly the research and card tools", async () => {
    const { enrichTools, ENRICH_TOOL_NAMES } = await import("./enrich-tools");
    const names = Object.keys(enrichTools(1)).sort();
    expect(names).toEqual([...ENRICH_TOOL_NAMES].sort());
    for (const n of names) expect(n).not.toMatch(/send|enroll|schedule|sequence|gmail|draft/);
  });

  it("cannot set the status to enrolled", async () => {
    const { enrichTools } = await import("./enrich-tools");
    const schema = enrichTools(1).set_status.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ status: "reviewed" }).success).toBe(true);
    expect(schema.safeParse({ status: "enrolled" }).success).toBe(false);
  });

  it("says a provider is missing instead of guessing", async () => {
    const { enrichTools } = await import("./enrich-tools");
    const tools = enrichTools(1);
    const search = tools.search_web.execute as (input: { query: string }, opts: unknown) => Promise<{ ok: boolean; error?: string }>;
    const out = await search({ query: "acme oil midland tx" }, {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain("EXA_API_KEY");
    const verify = tools.hunter_verify_email.execute as (input: { email: string }, opts: unknown) => Promise<{ ok: boolean; error?: string }>;
    expect((await verify({ email: "a@b.com" }, {})).error).toContain("HUNTER_API_KEY");
  });
});
