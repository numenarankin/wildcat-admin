import "server-only";

import type { IngestType } from "@/lib/ai/ingest/types";
import type { IngestContext } from "@/lib/ai/ingest/context";
import {
  extractSuggestions,
  mergeReviewedGroups,
  type SuggestionGroup,
} from "@/lib/ai/ingest/extract";
import { validateSuggestions, type ValidationResult } from "@/lib/ai/ingest/validate";
import type { AgentUsage } from "@/lib/ai/ingest/agent-call";
import { ilog, ierr, errorInfo } from "@/lib/ai/ingest/log";

/**
 * The dedicated-document agent LOOP: ANALYZE (agent 2) ⇄ VALIDATE (agent 3).
 *
 *   analyze → validate → (if issues) analyze-with-feedback → validate → …
 *
 * The analysis agent proposes every destination the document supports; the
 * validation agent audits that against the operator's requirements and returns
 * actionable feedback only when something is wrong; the loop feeds that feedback
 * back to analysis and re-validates until it passes or the pass cap is hit. On
 * the cap it returns the best set anyway (the user's review step is the final
 * gate — the pipeline never hard-blocks on the validator).
 *
 * Extracted so BOTH the upload path (`scan.ts`) and the end-to-end test drive
 * the exact same loop; `onUsage` lets the caller meter each agent call.
 */

/**
 * How many analyze⇄validate cycles a dedicated document gets. Pass 1 is the
 * first analysis; each subsequent pass validates and, on issues, re-analyzes
 * with the feedback. Bounded so a validator that never agrees can't loop forever.
 */
export const MAX_VALIDATION_PASSES = 3;

export interface DedicatedFlowResult {
  groups: SuggestionGroup[];
  /** The final validator verdict (the loop's exit state). */
  verdict: ValidationResult;
  /** How many analysis passes ran (1 = first analysis only, no fixes needed). */
  analyzePasses: number;
  /** How many validation passes ran. */
  validatePasses: number;
}

export async function analyzeAndValidate(
  documentText: string,
  targets: IngestType[],
  ctx: IngestContext,
  opts?: {
    /** The analyze + validate skill files for this document category. Defaults
     * to the oil pair. */
    skills?: { analyze: string; validate: string };
    /**
     * Override the correction-round cap. A small single-purpose segment needs
     * fewer rounds than a whole mixed document, and a per-segment fan-out
     * multiplies every extra pass by the segment count.
     */
    maxValidationPasses?: number;
    onUsage?: (usage: AgentUsage, stage: "analyze" | "validate") => void;
  }
): Promise<DedicatedFlowResult> {
  const skills = opts?.skills ?? { analyze: "oil-run-statement", validate: "validate" };
  const maxPasses = Math.max(1, opts?.maxValidationPasses ?? MAX_VALIDATION_PASSES);
  const meter = (u: AgentUsage, stage: "analyze" | "validate") =>
    opts?.onUsage?.(u, stage);

  // Agent 2 — ANALYZE (first pass).
  const first = await extractSuggestions(documentText, targets, ctx, {
    skill: skills.analyze,
  });
  meter(first.usage, "analyze");
  let groups = first.groups;
  let analyzePasses = 1;
  let validatePasses = 0;
  let verdict: ValidationResult = { ok: true, issues: [] };

  // Agent 3 — VALIDATE, looping until it passes or the cap.
  for (let attempt = 1; attempt <= maxPasses; attempt++) {
    // A validator failure must NOT take the extraction down with it. Analysis
    // has already produced rows; the validator is a quality pass over them, so
    // if the call itself dies (provider error, empty stream, timeout) the right
    // outcome is to ship what we have for the user to review, not to throw away
    // a good extraction and report "no records". `parseVerdict` already fails
    // open on a malformed reply — this covers the call never returning one.
    let v: Awaited<ReturnType<typeof validateSuggestions>>;
    try {
      v = await validateSuggestions(
        documentText,
        groups,
        targets,
        ctx,
        skills.validate
      );
    } catch (err) {
      ierr("validate: call FAILED, shipping unvalidated records", errorInfo(err));
      verdict = { ok: true, issues: [] };
      validatePasses = attempt;
      break;
    }
    meter(v.usage, "validate");
    verdict = v.result;
    validatePasses = attempt;
    ilog("validate: verdict", {
      attempt,
      ok: verdict.ok,
      issues: verdict.issues,
    });
    if (verdict.ok) break;
    if (attempt >= maxPasses) {
      ierr("validate: unresolved after max passes, sending to review anyway", {
        issues: verdict.issues,
      });
      break;
    }
    // Loop back to ANALYZE with the validator's feedback; merge so a fix pass
    // corrects rows but never drops a whole destination it produced.
    const fix = await extractSuggestions(documentText, targets, ctx, {
      skill: skills.analyze,
      feedback: verdict.issues,
      priorGroups: groups,
    });
    meter(fix.usage, "analyze");
    analyzePasses++;
    groups = mergeReviewedGroups(groups, fix.groups);
  }

  return { groups, verdict, analyzePasses, validatePasses };
}
