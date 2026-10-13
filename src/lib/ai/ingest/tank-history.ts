import "server-only";

import { tankReadingRow, runTicketRow } from "@/lib/ai/ingest/schemas";
import { streamAgentJson, isolateJson } from "@/lib/ai/ingest/agent-call";
import { loadSkill } from "@/lib/ai/ingest/skills/load";
import { ilog, ierr } from "@/lib/ai/ingest/log";
import type { ProposalDraft } from "@/lib/ai/ingest/scan";

/**
 * The dedicated "tank history" validation loop. A tank-scoped Add-History upload
 * is for ONE tank, but the file often holds several tanks' data. After the
 * generic extractor proposes candidate readings + run tickets, this pass re-reads
 * the FULL source and returns only the target tank's records: it locates the
 * tank's section in the document, confirms each row belongs to it (not a neighbor
 * with a near-identical number), re-classifies single-level rows as readings and
 * open/close rows as runs, fixes inverted gauges, and drops undated junk. This is
 * a common workflow, so the extra model call is deliberate.
 *
 * It only touches the `tankReadings` / `runTickets` drafts; any other draft is
 * passed through untouched. On a SUCCESSFUL pass the validator is AUTHORITATIVE —
 * its lists are trusted verbatim, including an intentional empty (the file held no
 * data for this tank). We do NOT fall back to the raw extractor rows on success:
 * that is how another tank's data used to get relabeled as this one. Only a hard
 * failure (parse error / timeout) degrades to the original drafts.
 */

const TIMEOUT_MS = 120_000;
// One tank's multi-year history can be thousands of rows; keep the ceiling high
// so the confirmed output isn't truncated (a truncation throws -> degrades to the
// raw, unconfirmed drafts, which may be another tank's data).
const MAX_OUTPUT_TOKENS = 32_000;

/** Force the opening (pre-haul) gauge to be >= the closing (post-haul) gauge. */
function orderGauges(row: Record<string, unknown>): Record<string, unknown> {
  const open = row.openingGauge;
  const close = row.closingGauge;
  if (
    typeof open === "number" &&
    typeof close === "number" &&
    open < close
  ) {
    return { ...row, openingGauge: close, closingGauge: open };
  }
  return row;
}

/** Validate a list of raw rows against a schema, dropping (and logging) failures. */
function validateRows(
  raw: unknown[],
  schema: typeof tankReadingRow | typeof runTicketRow,
  label: string
): unknown[] {
  const out: unknown[] = [];
  let dropped = 0;
  for (const r of raw) {
    const res = schema.safeParse(r);
    if (res.success) out.push(res.data);
    else dropped++;
  }
  if (dropped > 0) ilog("tank-history: validation dropped rows", { label, dropped, kept: out.length });
  return out;
}

interface ValidatedHistory {
  reasoning?: string;
  readings?: unknown[];
  runs?: unknown[];
}

export async function validateTankHistory(
  drafts: ProposalDraft[],
  documentText: string,
  tankName: string
): Promise<ProposalDraft[]> {
  const readings = drafts.find((d) => d.type === "tankReadings")?.rows ?? [];
  const runs = drafts.find((d) => d.type === "runTickets")?.rows ?? [];
  // Nothing tank-scoped to validate — leave the drafts as they are.
  if (readings.length === 0 && runs.length === 0) return drafts;

  try {
    const system = loadSkill("tank-history-validate", { TANK: tankName || "this tank" });
    const user = [
      "<document>",
      documentText,
      "</document>",
      "",
      "<extracted_readings>",
      JSON.stringify(readings),
      "</extracted_readings>",
      "",
      "<extracted_runs>",
      JSON.stringify(runs),
      "</extracted_runs>",
    ].join("\n");

    const started = Date.now();
    const { text } = await streamAgentJson({
      label: "tank-history-validate",
      system,
      user,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: TIMEOUT_MS,
      // Same rubric-checking shape as the generic validator.
      effort: "low",
      });
    const parsed = JSON.parse(isolateJson(text)) as ValidatedHistory;

    const fixedReadings = validateRows(
      Array.isArray(parsed.readings) ? parsed.readings : [],
      tankReadingRow,
      "readings"
    );
    const fixedRuns = validateRows(
      (Array.isArray(parsed.runs) ? parsed.runs : []).map((r) =>
        orderGauges(r as Record<string, unknown>)
      ),
      runTicketRow,
      "runs"
    );
    ilog("tank-history: validated", {
      ms: Date.now() - started,
      reasoning: parsed.reasoning,
      readings: `${readings.length}->${fixedReadings.length}`,
      runs: `${runs.length}->${fixedRuns.length}`,
    });

    // The validator is authoritative for this tank: it read the full document and
    // returns only rows it confirmed belong to the target tank. Trust its lists
    // verbatim — an empty list means the file held no data for THIS tank, which is
    // a correct, honest result. We must NOT restore the raw extractor rows here:
    // those may be a different tank's data, and refiling them under this tank is
    // exactly the corruption this pass exists to prevent. (Hard failures still
    // degrade to the raw drafts via the catch below.)
    const rest = drafts.filter(
      (d) => d.type !== "tankReadings" && d.type !== "runTickets"
    );
    const rebuilt = [...rest];
    if (fixedReadings.length > 0)
      rebuilt.push({ type: "tankReadings", wellId: null, rows: fixedReadings });
    if (fixedRuns.length > 0)
      rebuilt.push({ type: "runTickets", wellId: null, rows: fixedRuns });
    return rebuilt;
  } catch (err) {
    ierr("tank-history: validation failed, keeping raw drafts", { err: String(err) });
    return drafts;
  }
}
