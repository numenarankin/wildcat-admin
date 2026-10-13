import "server-only";

import { z } from "zod";
import { loadSkill } from "@/lib/ai/ingest/skills/load";
import { streamAgentJson, isolateJson, type AgentUsage } from "@/lib/ai/ingest/agent-call";
import { ilog, ierr, errorInfo } from "@/lib/ai/ingest/log";

/**
 * Agent 1 of the ingest flow: DOCUMENT CATEGORIZATION. A dedicated call driven by
 * the `categorize-document` skill (the catalog of upload types + what each tends
 * to contain) that decides which known category the transcribed document is. It
 * extracts NO records — it only routes: a recognized category hands the document
 * to its dedicated analyze→validate flow; `other` falls back to generic triage.
 *
 * Kept a separate agent (its own skill, its own model call) on purpose, so the
 * category decision is made in isolation from extraction.
 */

/** The document categories the operator can upload. `other` = none of the above. */
export const DOCUMENT_CATEGORIES = [
  "oilRunStatement",
  "revenueStatement",
  "gasSettlementStatement",
  "vendorInvoice",
  "other",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/** Hard ceiling on the categorize call (a short classification, not extraction). */
const CATEGORIZE_TIMEOUT_MS = 60_000;

const CategorizeSchema = z.object({
  reasoning: z.string().default(""),
  category: z.enum(DOCUMENT_CATEGORIES).default("other"),
  hasData: z.boolean().default(true),
  wellNames: z.array(z.string()).default([]),
});

export type CategorizeResult = z.infer<typeof CategorizeSchema>;

/** Parse the model's JSON reply; on any failure fall back to a safe `other`
 * with data (so a parse hiccup never silently drops the document — it just
 * routes to the generic path instead of a dedicated one). */
function parseCategory(raw: string): CategorizeResult {
  try {
    const parsed = CategorizeSchema.safeParse(JSON.parse(isolateJson(raw)));
    if (parsed.success) return parsed.data;
    ierr("categorize: reply failed schema, defaulting to other", {
      issues: parsed.error.issues.map((i) => i.message),
    });
  } catch (err) {
    ierr("categorize: reply not JSON, defaulting to other", errorInfo(err));
  }
  return { reasoning: "", category: "other", hasData: true, wellNames: [] };
}

/**
 * Categorize the already-transcribed document. Returns the chosen category plus
 * `hasData` (is there anything to add at all) and any verbatim well names, and
 * the token usage so the caller can meter it.
 */
export async function categorizeDocument(
  documentText: string
): Promise<{ result: CategorizeResult; usage: AgentUsage }> {
  const system = loadSkill("categorize-document", {
    CATEGORIES: DOCUMENT_CATEGORIES.join(", "),
  });
  ilog("categorize: model call begin", {
    systemChars: system.length,
    docChars: documentText.length,
  });
  const callStart = Date.now();

  const { text, usage } = await streamAgentJson({
    label: "categorize",
    system,
    user: `<document>\n${documentText}\n</document>`,
    // Opus 5 thinks by default, and this budget caps thinking + output
    // together. The category JSON is small; the headroom is for the reasoning.
    maxOutputTokens: 8_000,
    timeoutMs: CATEGORIZE_TIMEOUT_MS,
    // Picking one label from a fixed list off the first page of a document.
    effort: "low",
  });

  const result = parseCategory(text);
  ilog("categorize: model call done", {
    ms: Date.now() - callStart,
    category: result.category,
    hasData: result.hasData,
    wellNames: result.wellNames,
    outputTokens: usage.outputTokens,
  });
  return { result, usage };
}
