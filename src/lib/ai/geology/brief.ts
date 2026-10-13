/**
 * The context brief — what the gatherer hands Fable.
 *
 * One rendered document, assembled deterministically from the state object and
 * the gather result. No model call builds this: it is the same discipline as the
 * gatherer's merge, one level up. Anything that reached Fable through a summary
 * would be an unattributable claim by the time it was used.
 *
 * ## Why the tool ledger is in here
 *
 * Fable is expected to SHOW ITS WORK in the answer — which number came from
 * where, which correlation, which assumption, which offset. It can only do that
 * if it is handed exactly what ran and exactly what came back, so the brief
 * enumerates every tool call: the automatic fan-out branches, the gatherer's own
 * requests, and who asked for each. Output is rendered as returned, not
 * paraphrased.
 *
 * That also makes the answer checkable. A figure in Fable's prose that does not
 * appear in this ledger did not come from a tool, which means the model produced
 * it — the one thing it is not allowed to do.
 */
import type { GatherResult } from "./gatherer";
import type { RequirementsReport } from "./requirements";
import type { ZoneEvaluation } from "./state";

export interface BriefInput {
  prompt: string;
  /**
   * `well` is the full evaluation. `question` is a geology question with no log
   * in scope — no parse, no datum, no computed values, just what the reference
   * library and any lookups the gatherer chose have to say.
   */
  mode?: "well" | "question";
  state: ZoneEvaluation;
  gathered: GatherResult | null;
  /** Fan-out branches that failed, so the brief can say what is missing. */
  failedBranches?: string[];
  /** What this question requires numerically, and what of it exists. */
  requirements?: RequirementsReport;
}

/** Keeps one enormous tool result from crowding out the passages. */
const MAX_OUTPUT_CHARS = 4_000;

export function renderBrief(input: BriefInput): string {
  const { prompt, state, gathered } = input;
  const out: string[] = [];

  const question = input.mode === "question";
  out.push(
    question ? "# Context for this question" : "# Context for this well",
    "", `## The question`, "", prompt, ""
  );

  if (!question) {
    out.push("## Well", "");
    out.push(`- API: ${state.well.api}`);
    if (state.well.name) out.push(`- Name: ${state.well.name}`);
    if (state.well.operator) out.push(`- Operator: ${state.well.operator}`);
    if (state.well.county) out.push(`- County: ${state.well.county}, district ${state.well.district ?? "?"}`);
    out.push(
      `- Datum: ${state.datum.resolved ? "RESOLVED" : "UNRESOLVED"}` +
        (state.datum.kbFt !== null ? `, KB ${state.datum.kbFt} ft` : "") +
        (state.datum.glFt !== null ? `, GL ${state.datum.glFt} ft` : "") +
        (state.datum.source ? ` (${state.datum.source})` : "")
    );
    out.push("");
  } else {
    out.push(
      "No well log is in scope for this turn. Answer from established " +
        "petrophysics and whatever was looked up below. Do not invent a well, " +
        "a depth, or a number for one.",
      ""
    );
  }

  if (gathered) {
    out.push("## What was searched for", "");
    for (const sq of gathered.subQuestions) out.push(`- ${sq}`);
    out.push("");
  }

  // Verbatim, with the segment ID Fable cites and a reader follows back.
  if (gathered && gathered.chunks.length > 0) {
    out.push("## Knowledge base passages", "");
    out.push(
      "Verbatim from the corpus. Cite the bracketed ID when you use one. " +
        "These are the source's words, not a summary — quote them where it matters.",
      ""
    );
    for (const chunk of gathered.chunks) {
      out.push(`### [${chunk.id}] ${chunk.heading}`, "", chunk.text.trim(), "");
    }
  }

  out.push(...renderRequirements(input.requirements));
  out.push(...renderToolLedger(state));

  if (state.computed.length > 0) {
    out.push("## Computed values", "");
    out.push("Every figure below came from a tool. Do not compute new ones.", "");
    for (const c of state.computed) {
      const value = typeof c.value === "object" ? `${c.value.low}–${c.value.high}` : String(c.value);
      const inputs = c.inputs.map((i) => `${i.name}=${String(i.value)}${i.source ? ` (${i.source})` : ""}`);
      out.push(`- **${c.field}** = ${value}${c.unit ? ` ${c.unit}` : ""} — ${c.method}; from ${inputs.join(", ")}`);
    }
    out.push("");
  }

  if (state.assumptions.length > 0) {
    out.push("## Assumptions in force", "");
    out.push("State these when a number depends on one. Any of them may be wrong.", "");
    for (const a of state.assumptions) {
      out.push(`- **${a.field}** = ${a.value} — ${a.basis} (${a.source}${a.overridable ? ", overridable" : ""})`);
    }
    out.push("");
  }

  if (state.offsets.length > 0) {
    out.push("## Offset wells", "");
    for (const o of state.offsets) {
      const picks = o.picks.map((p) => `${p.formation} ${p.depth.ft} ${p.depth.reference}`).join("; ");
      const dst = o.dst.map((d) => `${d.interval}: ${d.result}`).join("; ");
      out.push(
        `- **${o.api}** at ${o.distanceFt.toLocaleString()} ft` +
          `${o.datumResolved ? "" : " (datum UNRESOLVED — no structural comparison)"}` +
          (picks ? `\n  - picks: ${picks}` : "") +
          (dst ? `\n  - DSTs: ${dst}` : "")
      );
    }
    out.push("");
  }

  if (state.evidence.length > 0) {
    out.push("## Evidence", "");
    out.push(
      "`stated` is something a person said. It is evidence, not measurement, " +
        "and must not be reported as one.",
      ""
    );
    for (const e of state.evidence) out.push(`- [${e.kind}] ${e.claim} — ${e.sourceId}`);
    out.push("");
  }

  if (state.conflicts.length > 0) {
    out.push("## Conflicts", "");
    for (const c of state.conflicts) {
      out.push(`- ${c.description}`);
      for (const b of c.branches) out.push(`  - ${b}`);
      if (c.resolvingDocument) out.push(`  - resolved by: ${c.resolvingDocument}`);
    }
    out.push("");
  }

  if (state.refusals.length > 0) {
    out.push("## Gates that refused", "");
    out.push("A tool declined to produce these. Say so plainly and name the remedy.", "");
    for (const r of state.refusals) {
      out.push(`- **${r.gate}** (${r.tool}): ${r.reason} — remedy: ${r.remedy}`);
    }
    out.push("");
  }

  const gaps = [
    ...(input.failedBranches ?? []).map((b) => `the ${b} branch failed, so its context is missing`),
    ...state.open.map((o) => `${o.question}${o.blocking ? " (BLOCKING)" : ""}`),
    ...(gathered?.dropped.unknownSegments.length
      ? [`${gathered.dropped.unknownSegments.length} cited passages did not exist and were dropped`]
      : []),
  ];
  if (gaps.length > 0) {
    out.push("## Gaps and open items", "");
    out.push("Do not paper over these. If one bears on the answer, say it.", "");
    for (const g of gaps) out.push(`- ${g}`);
    out.push("");
  }

  return out.join("\n");
}

/**
 * What this question is incomplete without, and whether it exists.
 *
 * The satisfied half is as important as the missing half: it names the numbers
 * that MUST appear in the answer, so a rate question cannot be answered without
 * the rate. The missing half carries an internal reason — attempted and failed,
 * or never produced — which Fable uses to decide how to phrase the gap and must
 * never repeat to the operator as a machinery failure.
 */
function renderRequirements(report: RequirementsReport | undefined): string[] {
  if (!report || report.statuses.length === 0) return [];
  const out: string[] = ["## What this question requires", ""];
  out.push(
    `This reads as a question about: ${report.intents.join(", ")}. ` +
      "An answer that leaves these out is incomplete.",
    ""
  );
  for (const s of report.statuses) {
    out.push(
      s.satisfied
        ? `- **${s.label}** — available above. Use it; do not answer around it.`
        : `- **${s.label}** — NOT AVAILABLE (${s.reason}; internal, never repeat this to the operator). Say once, in geological terms, that this could not be pinned down, then answer the rest of the question in full. Do not estimate it. Do not shorten your answer because of it. Do not use the words failed, error, or unavailable.`
    );
  }
  out.push("");
  return out;
}

/**
 * Every tool that ran, who asked for it, and what it returned.
 *
 * Split by requester because the two carry different information: the automatic
 * branches ran regardless of the question, while a gatherer request is a
 * judgment that this question needed that lookup.
 */
function renderToolLedger(state: ZoneEvaluation): string[] {
  if (state.toolCalls.length === 0) return [];
  const out: string[] = ["## Tools that ran", ""];
  out.push(
    "Everything below is a real tool result. It is the whole basis for any number " +
      "in your answer — if a figure is not traceable to one of these, do not write it.",
    ""
  );

  const groups: [string, string][] = [
    ["harness", "Run automatically for every well"],
    ["gatherer", "Requested by the context gatherer for this question"],
    ["fable", "Requested during this turn"],
  ];

  for (const [requester, label] of groups) {
    const calls = state.toolCalls.filter((c) => c.requestedBy === requester);
    if (calls.length === 0) continue;
    out.push(`### ${label}`, "");
    for (const c of calls) {
      const args = compact(c.args);
      out.push(`**${c.tool}**${args === "{}" ? "" : `(${args})`} — ${c.method}`);
      if (!c.ok) {
        out.push("", `FAILED: ${c.error ?? "unknown error"}. Its context is missing from this brief.`, "");
        continue;
      }
      if (c.refused) {
        out.push("", `REFUSED by the ${c.refused.gate} gate: ${c.refused.reason}. Remedy: ${c.refused.remedy}`);
      }
      out.push("", "```json", truncate(compact(c.output, 2)), "```", "");
    }
  }
  return out;
}

function compact(value: unknown, indent = 0): string {
  try {
    return JSON.stringify(value, null, indent) ?? "null";
  } catch {
    return String(value);
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  // Say what was cut. A silently trimmed result reads as a complete one.
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated, ${text.length - MAX_OUTPUT_CHARS} more characters`;
}
