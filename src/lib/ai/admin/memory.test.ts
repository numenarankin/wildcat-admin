import { describe, expect, it } from "vitest";
import { BODY_CHAR_CAP, normalizePlaybook, PlaybookRejected, renderAdminState } from "./memory";
import { capDocument, latestUserText, renderPlaybooksForReflection, unwrapEnvelope } from "./reflection";

const playbook = { id: "p1", name: "Weekly pipeline", trigger: "Monday review", body: "1. list_targets\n2. sequence_enrollments", version: 1, updatedAt: "2026-10-30T00:00:00Z" };

describe("normalizePlaybook", () => {
  it("trims and keeps a playbook inside the caps", () => {
    expect(normalizePlaybook({ name: " Weekly ", body: " 1. list_targets " })).toEqual({ name: "Weekly", trigger: "", body: "1. list_targets" });
  });
  it("refuses an over-long body whole rather than cutting a step", () => {
    expect(() => normalizePlaybook({ name: "x", body: "a".repeat(BODY_CHAR_CAP + 1) })).toThrow(PlaybookRejected);
  });
  it("refuses a playbook without a name or body", () => {
    expect(() => normalizePlaybook({ name: " ", body: "x" })).toThrow(PlaybookRejected);
    expect(() => normalizePlaybook({ name: "x", body: "" })).toThrow(PlaybookRejected);
  });
});

describe("renderAdminState", () => {
  it("renders nothing for an admin with no state yet", () => {
    expect(renderAdminState({ memory: "", persona: " " }, [])).toBe("");
  });
  it("fences memory, persona and playbooks as background", () => {
    const out = renderAdminState({ memory: "- Jim runs Sky Resources", persona: "- Be brief" }, [playbook]);
    expect(out).toContain("## How this admin wants you to work");
    expect(out).toContain("- Be brief");
    expect(out).toContain("- Jim runs Sky Resources");
    expect(out).toContain("look up any current number with a tool");
    expect(out).toContain("### Weekly pipeline\nWhen: Monday review\n1. list_targets");
  });
});

describe("reflection helpers", () => {
  it("states the playbook cap as a fact", () => {
    expect(renderPlaybooksForReflection([])).toContain("12 slots free");
    expect(renderPlaybooksForReflection([playbook])).toContain("1 of 12 slots used");
    expect(renderPlaybooksForReflection(Array(12).fill(playbook))).toContain("AT the 12-playbook cap");
  });
  it("cuts an overshooting document at a line break", () => {
    expect(capDocument("- one\n- two\n- three", 12)).toBe("- one\n- two");
    expect(capDocument("short", 12)).toBe("short");
  });
  it("peels a one-key envelope only", () => {
    expect(unwrapEnvelope({ jsonBody: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapEnvelope({ a: { b: 1 }, c: 2 })).toEqual({ a: { b: 1 }, c: 2 });
  });
  it("reads the newest user message's text", () => {
    expect(
      latestUserText([
        { id: "1", role: "user", parts: [{ type: "text", text: "first" }] },
        { id: "2", role: "assistant", parts: [{ type: "text", text: "reply" }] },
        { id: "3", role: "user", parts: [{ type: "text", text: "remember Jim" }, { type: "text", text: "owns Sky" }] },
      ]),
    ).toBe("remember Jim owns Sky");
  });
});
