import "server-only";

import { z } from "zod";
import type { IngestType } from "@/lib/ai/ingest/types";
import type { IngestContext } from "@/lib/ai/ingest/context";
import type { SuggestionGroup } from "@/lib/ai/ingest/extract";
import { fieldSpecFor, bullets } from "@/lib/ai/ingest/extract";
import { loadSkill } from "@/lib/ai/ingest/skills/load";
import { streamAgentJson, isolateJson, type AgentUsage } from "@/lib/ai/ingest/agent-call";
import { ilog, ierr, errorInfo } from "@/lib/ai/ingest/log";

/**
 * Agent 3 of the ingest flow: VALIDATION. A dedicated call driven by the
 * `validate` skill that audits the analysis agent's proposed records against the
 * operator's hard requirements (tank→lease, full economics, one transaction per
 * lease, purchaser contact, formatting) and returns actionable feedback ONLY
 * when something is wrong. The scan loop feeds that feedback back to the analysis
 * agent to fix, and re-validates, until it passes (or a pass cap is hit).
 *
 * It is a separate agent from analysis on purpose: a fresh, stateless call framed
 * as checking ANOTHER system's work, so it audits instead of rubber-stamping.
 */

/** Hard ceiling on a validation call (see extract.ts EXTRACT_TIMEOUT_MS). */
const VALIDATE_TIMEOUT_MS = 180_000;

/** A validator verdict: `ok` with no issues, or not-ok with concrete feedback. */
export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

const VerdictSchema = z.object({
  ok: z.boolean(),
  issues: z.array(z.string()).default([]),
});

function buildValidatePrompt(
  skill: string,
  targetTypes: IngestType[],
  ctx: IngestContext
): string {
  // Superset of tokens; each validate skill uses the ones it references and
  // loadSkill leaves the rest untouched.
  return loadSkill(skill, {
    EXISTING_LEASES: bullets(ctx.existing.leases),
    EXISTING_TANKS: bullets(ctx.existing.tanks),
    EXISTING_METERS: bullets(ctx.existing.meters),
    EXISTING_GATHERERS: bullets(ctx.existing.gatherers),
    EXISTING_VENDORS: bullets(ctx.existing.serviceProviders),
    EXISTING_WELLS: ctx.wells.length
      ? ctx.wells.map((w) => `  - ${w.name}`).join("\n")
      : "  (none)",
    FIELD_SPEC: fieldSpecFor(targetTypes),
    VALID_TYPES: targetTypes.join(", "),
  });
}

/** Parse the validator's JSON verdict. On a parse/shape failure, PASS (ok:true)
 * so a flaky validator can never loop the analysis forever or block the upload —
 * the failure is logged, and the unvalidated records still reach the user's
 * review step. A verdict that says not-ok but lists no issues is treated as a
 * pass (nothing actionable to send back). */
function parseVerdict(raw: string): ValidationResult {
  try {
    const parsed = VerdictSchema.safeParse(JSON.parse(isolateJson(raw)));
    if (parsed.success) {
      const issues = parsed.data.issues.map((s) => s.trim()).filter(Boolean);
      return { ok: parsed.data.ok || issues.length === 0, issues };
    }
    ierr("validate: reply failed schema, passing", {
      issues: parsed.error.issues.map((i) => i.message),
    });
  } catch (err) {
    ierr("validate: reply not JSON, passing", errorInfo(err));
  }
  return { ok: true, issues: [] };
}

/**
 * Validate the proposed records against the operator's requirements. Returns the
 * verdict (pass, or fail with actionable issues) plus token usage to meter.
 */
export async function validateSuggestions(
  documentText: string,
  groups: SuggestionGroup[],
  targetTypes: IngestType[],
  ctx: IngestContext,
  /** Which validate skill audits the records (default the oil validator). */
  skill = "validate"
): Promise<{ result: ValidationResult; usage: AgentUsage }> {
  const system = buildValidatePrompt(skill, targetTypes, ctx);
  const proposed = JSON.stringify({
    suggestions: groups.map((g) => ({ type: g.type, rows: g.rows })),
  });
  ilog("validate: model call begin", {
    targetTypes,
    groups: groups.map((g) => ({ type: g.type, rows: g.rows.length })),
    docChars: documentText.length,
  });
  const callStart = Date.now();

  const { text, usage } = await streamAgentJson({
    label: "validate",
    system,
    user: `Document:\n<document>\n${documentText}\n</document>\n\nProposed records to validate:\n${proposed}`,
    maxOutputTokens: 8_000,
    timeoutMs: VALIDATE_TIMEOUT_MS,
    // Checking rows against an explicit, enumerated rubric is recall work, not
    // deliberation — the requirements are written out in the skill file. This
    // was the slowest call in the pipeline, purely on thinking time.
    effort: "low",
  });

  const result = parseVerdict(text);
  ilog("validate: model call done", {
    ms: Date.now() - callStart,
    ok: result.ok,
    issues: result.issues,
    outputTokens: usage.outputTokens,
  });
  return { result, usage };
}
