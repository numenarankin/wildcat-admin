import { describe, it, expect, vi } from "vitest";

/**
 * The prospecting catalog: the page's reads, and its four actions behind an
 * approval card. The names are pinned so a tool cannot be added quietly,
 * every write waits for approval, and nothing sends, schedules, drafts or
 * records a sequence step (those stay the user's buttons).
 */

const row = (operatorNo: number, name: string, activeWells: number) => ({
  operatorNo, name, city: null, state: null, activeWells, totalWells: activeWells, revenueUsd: activeWells * 1000,
  projectedUsd: null, projectedYearUsd: null, address: null, lng: null, lat: null, hqCountyCode: null, hqCounty: null,
  countyCodes: [], counties: [], createdAt: "2026-10-01T00:00:00Z",
});
vi.mock("@/lib/admin/targets", () => ({
  getTargetNumbers: vi.fn(async () => new Set([7])),
  getTargets: vi.fn(async () => [row(7, "ACME OIL CO", 5), row(8, "BIG CO", 30), row(9, "HUGE CO", 200)]),
  operatorPoints: vi.fn(async () => new Map([[7, { n: 7, nm: "ACME OIL CO", c: "MIDLAND", s: "TX", w: 12, wa: 10 }]])),
}));
const addTargets = vi.fn(async () => {});
vi.mock("@/lib/admin/target-actions", () => ({ addTargets: (...a: unknown[]) => addTargets(...(a as [])) }));
const queueTarget = vi.fn(async () => {});
vi.mock("@/lib/admin/outreach/research-actions", () => ({ queueTarget: (...a: unknown[]) => queueTarget(...(a as [])) }));
vi.mock("@/lib/admin/outreach/research", () => ({
  getEnrichQueue: vi.fn(async () => []),
  getTargetResearch: vi.fn(async () => null),
  getTargetContacts: vi.fn(async () => [{ id: "11111111-1111-4111-8111-111111111111", operatorNo: 7 }]),
}));
vi.mock("@/lib/admin/outreach/sequences", () => ({ getDefaultSequence: vi.fn(async () => null), getEnrollments: vi.fn(async () => []) }));
const enrollTarget = vi.fn(async () => ({ enrolled: 1 }));
vi.mock("@/lib/admin/outreach/sequence-actions", () => ({ enrollTarget: (...a: unknown[]) => enrollTarget(...(a as [])) }));
vi.mock("@/lib/admin/outreach/settings", () => ({ getProspectingSettings: vi.fn(), getScheduledEmails: vi.fn() }));
const runEnrichment = vi.fn(async () => ({ report: "done", steps: 3, toolsUsed: [] }));
vi.mock("@/lib/ai/admin/enrich-run", () => ({ currentPrices: vi.fn(async () => ({ oilPerBbl: 60, gasPerMcf: 3 })), runEnrichment: (...a: unknown[]) => runEnrichment(...(a as [])) }));
vi.mock("@/lib/scout/queries", () => ({ getOperatorProfile: vi.fn(), searchOperators: vi.fn(async () => []) }));
vi.mock("@/lib/scout/format", () => ({ fmtDate8: () => null, fmtPhone: () => null, partyName: (s: string) => s, titleCase: (s: string) => s }));

type Exec = (input: unknown, opts: unknown) => Promise<{ ok: boolean; error?: string }>;
const exec = (t: { execute?: unknown }) => t.execute as Exec;

describe("prospectingTools", () => {
  it("offers exactly the page's reads and its four approved actions", async () => {
    const { prospectingTools, PROSPECTING_TOOL_NAMES, PROSPECTING_WRITE_TOOL_NAMES } = await import("./prospecting-tools");
    const tools = prospectingTools() as Record<string, { needsApproval?: boolean }>;
    expect(Object.keys(tools).sort()).toEqual([...PROSPECTING_TOOL_NAMES].sort());
    for (const n of Object.keys(tools)) {
      expect(Boolean(tools[n].needsApproval), n).toBe((PROSPECTING_WRITE_TOOL_NAMES as readonly string[]).includes(n));
    }
    for (const n of PROSPECTING_WRITE_TOOL_NAMES) expect(n).not.toMatch(/send|schedule|draft|record_step|gmail/);
  });

  it("every approval card has a plain-English title", async () => {
    const { PROSPECTING_WRITE_TOOL_NAMES } = await import("./prospecting-tools");
    const { hasRegisteredApprovalTitle, describeApproval } = await import("@/lib/ai/approval-view");
    for (const n of PROSPECTING_WRITE_TOOL_NAMES) expect(hasRegisteredApprovalTitle(n), n).toBe(true);
    expect(describeApproval("queue_for_enrichment", { operators: [{ operatorNo: 7, name: "ACME OIL CO" }, { operatorNo: 8, name: "B" }] }).title).toBe(
      "Queue 2 targets for enrichment"
    );
    expect(describeApproval("add_to_sequence", { operatorNo: 7, name: "ACME OIL CO", contacts: [] })).toEqual({
      title: "Add a target to the sequence (calls to the P-5 phone)",
      fields: [{ label: "Operator #", value: "7" }, { label: "Name", value: "ACME OIL CO" }],
    });
  });

  it("refuses to queue, enrich or enroll an operator that is not a target", async () => {
    const { prospectingTools } = await import("./prospecting-tools");
    const t = prospectingTools();
    const ref = { operatorNo: 9, name: "NOBODY LLC" };
    expect((await exec(t.queue_for_enrichment)({ operators: [ref] }, {})).error).toMatch(/add_targets/);
    expect((await exec(t.enrich_target)(ref, {})).error).toMatch(/add_targets/);
    expect((await exec(t.add_to_sequence)({ ...ref, contacts: [] }, {})).error).toMatch(/add_targets/);
    expect(queueTarget).not.toHaveBeenCalled();
    expect(runEnrichment).not.toHaveBeenCalled();
    expect(enrollTarget).not.toHaveBeenCalled();
  });

  it("fills a target from the operator points and queues before researching", async () => {
    const { prospectingTools } = await import("./prospecting-tools");
    const t = prospectingTools();
    await exec(t.add_targets)({ operators: [{ operatorNo: 7, name: "whatever" }] }, {});
    expect(addTargets).toHaveBeenCalledWith([{ operatorNo: 7, name: "ACME OIL CO", city: "MIDLAND", state: "TX" }]);
    const out = await exec(t.enrich_target)({ operatorNo: 7, name: "ACME OIL CO" }, {});
    expect(queueTarget).toHaveBeenCalledWith(7);
    expect(runEnrichment).toHaveBeenCalledWith(7);
    expect(out.ok).toBe(true);
  });

  it("enrolls only contacts on the target's card", async () => {
    const { prospectingTools } = await import("./prospecting-tools");
    const t = prospectingTools();
    const bad = await exec(t.add_to_sequence)(
      { operatorNo: 7, name: "ACME OIL CO", contacts: [{ id: "22222222-2222-4222-8222-222222222222", name: null, email: null }] },
      {}
    );
    expect(bad.ok).toBe(false);
    expect(enrollTarget).not.toHaveBeenCalled();
    const good = await exec(t.add_to_sequence)(
      { operatorNo: 7, name: "ACME OIL CO", contacts: [{ id: "11111111-1111-4111-8111-111111111111", name: "Jo", email: "jo@acme.com" }] },
      {}
    );
    expect(good.ok).toBe(true);
    expect(enrollTarget).toHaveBeenCalledWith(7, ["11111111-1111-4111-8111-111111111111"]);
  });

  it("filters targets the way the tab's bar does and returns every match", async () => {
    const { prospectingTools } = await import("./prospecting-tools");
    const t = prospectingTools();
    type Out = { totalTargets: number; matching: number; targets: { operatorNo: number }[] };
    const all = (await exec(t.list_targets)({}, {})) as unknown as Out;
    expect(all.totalTargets).toBe(3);
    expect(all.targets.map((x) => x.operatorNo)).toEqual([7, 8, 9]);
    const tier1 = (await exec(t.list_targets)({ tiers: ["tier_1"] }, {})) as unknown as Out;
    expect(tier1.matching).toBe(1);
    expect(tier1.targets.map((x) => x.operatorNo)).toEqual([7]);
    const band = (await exec(t.list_targets)({ minWells: 25, maxWells: 99 }, {})) as unknown as Out;
    expect(band.targets.map((x) => x.operatorNo)).toEqual([8]);
    const unqueued = (await exec(t.list_targets)({ enrichStatus: ["none"] }, {})) as unknown as Out;
    expect(unqueued.matching).toBe(3);
  });
});
