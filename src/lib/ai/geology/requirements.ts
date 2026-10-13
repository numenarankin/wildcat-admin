/**
 * The must-compute rule, enforced in code.
 *
 * The largest scoring penalty in the graded runs was not bad arithmetic — it was
 * arithmetic that never happened. Coning critical rate, Turner, drawdown and IPR
 * were all computable from data on the page, and none got computed. The answers
 * read well and were capped in the 60s-80s for it.
 *
 * Prompting alone will not fix that, because the model has no way to know it
 * skipped something: an answer with no rate number does not feel incomplete from
 * the inside. So the harness decides what a question REQUIRES, checks whether it
 * is present in `computed[]`, and tells Fable exactly what is missing.
 *
 * ## A missing number never stops the turn
 *
 * If a calculation was attempted and failed, that is recorded here and in the
 * trajectory — INTERNALLY. It never becomes "a tool failed" in the operator's
 * answer. Fable is told what could not be determined and answers with what it
 * has, saying in domain terms which part of the question is unresolved. A turn
 * that quits because a prerequisite was lost is worse than one that answers
 * three quarters of the question and says which quarter is missing.
 */
import type { Origin, ZoneEvaluation, ZoneEvaluationStore } from "./state";

const ORIGIN: Origin = { stage: "stage1", branch: "requirements" };

export interface Requirement {
  /** Field name pattern that satisfies it. */
  field: RegExp;
  /** How to name it to Fable, in domain terms. */
  label: string;
  /** Which tool would produce it, for the internal record only. */
  from: string;
}

interface Intent {
  name: string;
  /** What in the user's question puts this intent in play. */
  triggers: RegExp;
  needs: Requirement[];
}

const CONING: Requirement = {
  field: /coning|critical.?rate/i,
  label: "coning critical rate (the rate above which water cones in)",
  from: "calculators",
};
const LIQUID_LOADING: Requirement = {
  field: /turner|coleman|liquid.?load|unload/i,
  label: "Turner/Coleman critical unloading rate",
  from: "calculators",
};
const DELIVERABILITY: Requirement = {
  field: /ipr|aof|deliverability|inflow/i,
  label: "inflow performance / deliverability",
  from: "calculators",
};
const DRAWDOWN: Requirement = {
  field: /drawdown|pwf|flowing.?pressure/i,
  label: "drawdown at the proposed rate",
  from: "calculators",
};
const POROSITY: Requirement = { field: /^phi|porosity/i, label: "porosity", from: "curve_suite" };
const SATURATION: Requirement = { field: /^sw\b|saturation/i, label: "water saturation", from: "archie_sw" };
const VSH: Requirement = { field: /^vsh|shale.?volume/i, label: "shale volume", from: "curve_suite" };
const NET_PAY: Requirement = { field: /net.?pay|net.?thickness/i, label: "net pay thickness", from: "zone detection" };
const STANDOFF: Requirement = { field: /standoff/i, label: "standoff to the contact", from: "standoff" };

/**
 * Question shapes and what an answer to each is incomplete without.
 *
 * Deliberately keyword-driven rather than a model call: this runs on every turn,
 * it must be cheap, and a rule that is occasionally over-inclusive is fine —
 * asking for a number that turns out not to matter costs one calculation.
 */
const INTENTS: Intent[] = [
  {
    name: "rate",
    triggers: /\brate\b|how much (will|would|can) it (make|produce|flow)|bopd|bbl\/d|mcf\/d|flow|choke|производ/i,
    needs: [CONING, LIQUID_LOADING, DELIVERABILITY, DRAWDOWN],
  },
  {
    name: "completion",
    triggers: /perforat|complet|recomplet|frac\b|stimulat|where (should|would) (i|we) shoot|shoot the/i,
    needs: [CONING, LIQUID_LOADING, STANDOFF, NET_PAY],
  },
  {
    name: "pay",
    triggers: /\bpay\b|productive|oil or water|is it wet|hydrocarbon|saturation|net feet/i,
    needs: [POROSITY, SATURATION, VSH, NET_PAY],
  },
  {
    name: "water",
    triggers: /\bwater\b|coning|cone\b|wet\b|contact\b|owc|gwc/i,
    needs: [SATURATION, CONING, STANDOFF],
  },
  {
    name: "structure",
    triggers: /structur|correlat|subsea|updip|downdip|dip\b|tops?\b|high to|low to|standoff/i,
    needs: [STANDOFF],
  },
];

export interface RequirementStatus {
  label: string;
  satisfied: boolean;
  /** Present only when unsatisfied. Internal wording; never shown verbatim. */
  reason: "attempted and failed" | "not produced";
  from: string;
}

export interface RequirementsReport {
  /** Which question shapes matched. Empty for a question with no numeric duty. */
  intents: string[];
  statuses: RequirementStatus[];
  missing: RequirementStatus[];
}

export function classifyIntents(prompt: string): string[] {
  return INTENTS.filter((i) => i.triggers.test(prompt)).map((i) => i.name);
}

/**
 * Work out what this question required and what actually got computed.
 *
 * Records the gaps as open items so they reach Fable through the brief and land
 * in the trajectory log. Not conflicts: a missing number is an absence, not a
 * contradiction, and it must not route the turn to the escalated path.
 */
export function checkRequirements(
  store: ZoneEvaluationStore,
  prompt: string
): RequirementsReport {
  const state = store.snapshot();
  const matched = INTENTS.filter((i) => i.triggers.test(prompt));
  if (matched.length === 0) return { intents: [], statuses: [], missing: [] };

  // Dedupe: "should I perforate and what will it make" matches three intents
  // that all want the coning rate.
  const needs = new Map<string, Requirement>();
  for (const i of matched) for (const n of i.needs) needs.set(n.label, n);

  const statuses: RequirementStatus[] = [];
  for (const need of needs.values()) {
    const satisfied = state.computed.some((c) => need.field.test(c.field));
    statuses.push({
      label: need.label,
      satisfied,
      reason: satisfied ? "not produced" : whyMissing(state, need),
      from: need.from,
    });
  }

  const missing = statuses.filter((s) => !s.satisfied);
  for (const m of missing) {
    store.addOpen(ORIGIN, {
      question:
        `This question needs ${m.label}, which was ${m.reason} ` +
        `(${m.from}). Answer with what is available and say which part is unresolved.`,
      // Never blocking. A lost prerequisite reduces the answer; it does not
      // cancel it.
      blocking: false,
    });
  }

  return { intents: matched.map((i) => i.name), statuses, missing };
}

/** Attempted-and-failed is a different fact from never-attempted; both are internal. */
function whyMissing(state: ZoneEvaluation, need: Requirement): RequirementStatus["reason"] {
  const failed = state.toolCalls.some((c) => !c.ok && c.tool === need.from);
  const refused = state.refusals.some((r) => r.tool === need.from);
  return failed || refused ? "attempted and failed" : "not produced";
}
