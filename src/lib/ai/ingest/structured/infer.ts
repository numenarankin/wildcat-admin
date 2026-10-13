import "server-only";

import { z } from "zod";
import { INGEST_ROW_SCHEMA } from "@/lib/ai/ingest/schemas";
import { INGEST_TYPE_META, type IngestType } from "@/lib/ai/ingest/types";
import { streamAgentJson, isolateJson, type AgentUsage } from "@/lib/ai/ingest/agent-call";
import { loadSkill } from "@/lib/ai/ingest/skills/load";
import { ilog } from "@/lib/ai/ingest/log";
import { largestSheet, type TableDoc } from "./table";
import { InterpretationSchema, type Interpretation } from "./spec";
import type { ApplyResult } from "./apply";

/**
 * The model calls of the structured path — a SMALL, fixed cost regardless of file
 * size. `inferInterpretation` writes (or repairs) the content-aware reading of the
 * file; `verifyInterpretation` audits the code's ACTUAL output against the source
 * and flags what's wrong. Between them, code does the per-row work for free. Both
 * prompts carry the domain: a RUN is a purchaser hauling oil, recording an OPENING
 * and a CLOSING level (two levels); a READING is a pumper recording ONE level. A
 * run can never have a single level — the rule that would have prevented the
 * "everything is a run" mistake.
 */

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 6_000;
const SAMPLE_ROWS = 120;
const SAMPLE_CHARS = 24_000;

/** The mappable fields of a type (schema keys minus provenance), with the
 * one-line description the schema carries, for the prompt. */
function fieldLines(type: IngestType): string {
  const shape = (INGEST_ROW_SCHEMA[type] as { shape?: Record<string, unknown> }).shape ?? {};
  const lines = Object.entries(shape)
    .filter(([k]) => k !== "sourceText")
    .map(([k, v]) => {
      const desc = (v as { description?: string }).description;
      return `    - ${k}${desc ? `: ${desc}` : ""}`;
    });
  return `  ${type} (${INGEST_TYPE_META[type].singular}):\n${lines.join("\n")}`;
}

function renderSample(table: TableDoc): { sheetName: string; text: string } {
  const sheet = largestSheet(table);
  const lines: string[] = [];
  let chars = 0;
  const n = Math.min(SAMPLE_ROWS, sheet.rows.length);
  for (let i = 0; i < n; i++) {
    const line = `${i}: ${sheet.rows[i].join("\t")}`;
    chars += line.length + 1;
    if (chars > SAMPLE_CHARS) break;
    lines.push(line);
  }
  const others = table.sheets.filter((s) => s.name !== sheet.name);
  const head =
    `Sheet "${sheet.name}" (${sheet.rows.length} rows)` +
    (others.length
      ? `; other sheets: ${others.map((s) => `"${s.name}" (${s.rows.length})`).join(", ")}`
      : "");
  return { sheetName: sheet.name, text: `${head}\n\n${lines.join("\n")}` };
}

/** Build (or repair) the content-aware interpretation from a sample. On a repair
 * pass, `feedback` (the verifier's issues) plus the prior interpretation are fed
 * back so the model fixes exactly what was wrong. */
export async function inferInterpretation(opts: {
  table: TableDoc;
  candidateTypes: IngestType[];
  wells: { id: string; name: string }[];
  feedback?: string[];
  prior?: Interpretation;
}): Promise<{ interp: Interpretation; usage: AgentUsage }> {
  const { table, candidateTypes, wells, feedback, prior } = opts;
  const system = loadSkill("structured-map", {
    FIELD_SPEC: candidateTypes.map(fieldLines).join("\n\n"),
    VALID_TYPES: candidateTypes.join(", "),
    WELLS: wells.length ? wells.map((w) => `  - ${w.name}`).join("\n") : "  (none)",
  });
  const { sheetName, text } = renderSample(table);

  const fixBlock =
    feedback && feedback.length
      ? [
          "",
          "A VERIFICATION pass checked your PREVIOUS interpretation against the",
          "actual rows and found these problems. Return a corrected interpretation",
          "that fixes every one — keep what was right, change only what was wrong:",
          "<issues>",
          ...feedback.map((f) => `- ${f}`),
          "</issues>",
          "<previous_interpretation>",
          JSON.stringify(prior ?? {}),
          "</previous_interpretation>",
        ].join("\n")
      : "";

  ilog("structured: infer begin", {
    sheet: sheetName,
    candidates: candidateTypes,
    fixPass: Boolean(feedback?.length),
  });
  const started = Date.now();
  const { text: reply, usage } = await streamAgentJson({
    label: "structured-map",
    // Column mapping is a judgement call, but a bounded one. Left unset it ran
    // at Opus 5's default `high`, which is the same silent-thinking tax the
    // transcription call was paying.
    effort: "medium",
    system,
    user: `<sample>\n${text}\n</sample>${fixBlock}`,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });

  let interp: Interpretation;
  try {
    interp = InterpretationSchema.parse(JSON.parse(isolateJson(reply)));
  } catch (err) {
    ilog("structured: infer produced no usable interpretation", {
      err: err instanceof z.ZodError ? err.issues : String(err),
      replyChars: reply.length,
    });
    interp = InterpretationSchema.parse({});
  }
  const allowed = new Set<string>([...candidateTypes, "skip"]);
  interp.classifier = interp.classifier.filter((r) => allowed.has(r.type));
  interp.types = interp.types.filter((t) => (candidateTypes as string[]).includes(t.type));

  ilog("structured: infer done", {
    ms: Date.now() - started,
    headerRow: interp.headerRow,
    rules: interp.classifier.map((r) => ({ when: r.when.kind, type: r.type })),
    types: interp.types.map((t) => ({ type: t.type, fields: t.fields.length })),
    outputTokens: usage.outputTokens,
  });
  return { interp, usage };
}

const VerifySchema = z.object({
  issues: z.array(z.string()).default([]),
});

/** Audit the code's ACTUAL classified output against the source rows. Returns a
 * list of concrete problems (misclassifications, mis-extractions) for a repair
 * pass; an empty list means the sample looks correct. Domain-aware, so it catches
 * a run with only one level or a reading treated as a run. */
export async function verifyInterpretation(opts: {
  result: ApplyResult;
  candidateTypes: IngestType[];
}): Promise<{ issues: string[]; usage: AgentUsage }> {
  const { result, candidateTypes } = opts;
  if (result.samples.length === 0) return { issues: [], usage: {} };

  const system = loadSkill("structured-verify", {
    VALID_TYPES: candidateTypes.join(", "),
  });
  const cases = result.samples
    .map(
      (s, i) =>
        `#${i} classified as "${s.type}"\n  source row: ${s.source.join(" | ")}\n  extracted: ${JSON.stringify(s.extracted)}`
    )
    .join("\n\n");
  const residualNote = result.residual.length
    ? `\n\nNote: ${result.residual.length} rows matched no rule and will be escalated separately.`
    : "";

  ilog("structured: verify begin", { samples: result.samples.length, residual: result.residual.length });
  const started = Date.now();
  const { text, usage } = await streamAgentJson({
    label: "structured-verify",
    // An audit of an already-made mapping: cheap, and the same `low` the other
    // validators use.
    effort: "low",
    system,
    user: `Header: ${result.header.join(" | ")}\n\n<classified>\n${cases}\n</classified>${residualNote}`,
    maxOutputTokens: 3_000,
    timeoutMs: TIMEOUT_MS,
  });

  let issues: string[] = [];
  try {
    issues = VerifySchema.parse(JSON.parse(isolateJson(text))).issues;
  } catch {
    issues = [];
  }
  ilog("structured: verify done", { ms: Date.now() - started, issues: issues.length, outputTokens: usage.outputTokens });
  return { issues, usage };
}
