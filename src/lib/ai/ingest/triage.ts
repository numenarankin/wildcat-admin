import "server-only";

import { generateObject } from "ai";
import { TriageSchema, type TriageResult } from "@/lib/ai/ingest/schemas";
import {
  renderDestinationCatalog,
  type IngestType,
} from "@/lib/ai/ingest/types";
import { ilog } from "@/lib/ai/ingest/log";
import { SCAN_MODEL_ID, scanModel, scanProviderOptions } from "@/lib/ai/scan-model";

/** Hard ceiling on the triage model call (see extract.ts EXTRACT_TIMEOUT_MS). */
const TRIAGE_TIMEOUT_MS = 60_000;

/**
 * Phase 1: an Opus pass that decides whether the document is worth a detailed
 * extraction, of which record types, and which well names it prints verbatim. It
 * extracts NO rows — its whole job is to gate the modal and scope phase 2. Runs
 * on the already-transcribed document TEXT (Stage 1), not the raw file.
 */
export async function runTriage(
  documentText: string,
  enabledTypes: IngestType[]
): Promise<{
  result: TriageResult;
  usage: { inputTokens?: number; outputTokens?: number; model?: string };
}> {
  const menu = renderDestinationCatalog(enabledTypes);

  const system = [
    "You are triaging an uploaded document for an oil & gas operator. Decide",
    "whether it contains information that could be ADDED to the company's system,",
    "and of which kinds. Do NOT extract the records themselves — a separate",
    "detailed pass does that.",
    "",
    "Route to the right destination. Each type below lists what belongs and what",
    "does NOT (naming the sibling it is confused with). A financial SETTLEMENT (a",
    "purchaser statement or a gatherer gas-volume settlement) is never production:",
    "do not route its volumes to production or a device reading. Only consider",
    "these record types (ignore anything else):",
    menu,
    "",
    "Bias toward FINDING data. A field ticket, work order, run sheet, completion",
    "or workover report, invoice, spec sheet, tubing/pump test, or scanned form",
    "almost always holds addable records — do not dismiss it as a 'generic",
    "report'. It is far worse to miss data the user expects filed than to propose",
    "a type that turns out empty.",
    "",
    "Rules:",
    "- hasData: true whenever the document plausibly contains ANY of the types",
    "  above — even partially, even one row. Set false ONLY for documents with no",
    "  addable records at all (a bare logo, a photo, a cover letter, marketing).",
    "- types: EVERY type that is plausibly present. When you are unsure whether a",
    "  type is present, INCLUDE it — the detailed pass extracts only what genuinely",
    "  fits and drops the rest, so over-including costs little while under-including",
    "  silently loses data. Err toward more types, not fewer.",
    "- wellNames: any well names printed VERBATIM in the document, exactly as",
    "  written. Leave empty if none. Do not guess or normalize.",
    "- reasoning: one or two sentences naming the document type and what it holds.",
  ].join("\n");

  ilog("triage: model call begin", {
    enabledTypeCount: enabledTypes.length,
    systemChars: system.length,
    docChars: documentText.length,
    timeoutMs: TRIAGE_TIMEOUT_MS,
  });
  const callStart = Date.now();

  const { object, usage } = await generateObject({
    model: scanModel(),
    // The model thinks by default, and this budget caps thinking + output
    // together. The JSON verdict is small; the headroom is for the reasoning.
    maxOutputTokens: 8000,
    abortSignal: AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
    maxRetries: 1,
    providerOptions: scanProviderOptions(),
    schema: TriageSchema,
    system,
    messages: [
      {
        role: "user",
        content: `Triage this document.\n\n<document>\n${documentText}\n</document>`,
      },
    ],
  });

  ilog("triage: model call done", {
    model: SCAN_MODEL_ID,
    ms: Date.now() - callStart,
    hasData: object.hasData,
    types: object.types,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  return { result: object, usage: { ...usage, model: SCAN_MODEL_ID } };
}
