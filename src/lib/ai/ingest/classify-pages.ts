import "server-only";

import { z } from "zod";
import { loadSkill } from "@/lib/ai/ingest/skills/load";
import {
  streamAgentJson,
  isolateJson,
  type AgentUsage,
} from "@/lib/ai/ingest/agent-call";
import type { IngestType } from "@/lib/ai/ingest/types";
import { ilog, ierr, errorInfo } from "@/lib/ai/ingest/log";

/**
 * Page classification: ONE cheap call that says what kind of form each page of a
 * document is, so the rest of the pipeline can route page-by-page instead of
 * guessing once for the whole file.
 *
 * The category vocabulary IS the routing table. That is the load-bearing design
 * choice: because every category maps statically to a set of ingest types
 * ({@link CATEGORY_TARGETS}), a classified page goes straight to extraction with
 * no triage call behind it. A design where each segment paid for its own triage
 * would multiply the pipeline's dominant cost — per-call thinking overhead, not
 * input tokens — by the segment count and be slower than the whole-file flow it
 * replaced. Only `other` still falls through to `runTriage`.
 */

export const PAGE_CATEGORIES = [
  // Dedicated whole-document flows. These strings deliberately match the keys
  // of DEDICATED_DOCUMENT_SKILLS / _TARGETS / _PROMPTS in `types.ts`, so routing
  // is a lookup rather than a translation.
  "oilRunStatement",
  "revenueStatement",
  "gasSettlementStatement",
  "vendorInvoice",
  // Well-page taxonomy.
  "wellTest",
  "service",
  "downtime",
  "wellEquipment",
  "production",
  "shot",
  "gasTest",
  "wellNote",
  // Other operational forms that already have destinations.
  "runTicket",
  "tankGauge",
  "meterReading",
  // Structural.
  "continuation",
  "blank",
  "other",
] as const;

export type PageCategory = (typeof PAGE_CATEGORIES)[number];

/**
 * The ingest types a segment of each category is extracted for.
 *
 * An empty list means "no direct extraction": the two dedicated categories run
 * their own analyze⇄validate flow instead, the structural ones never form a
 * segment of their own, and `other` is the single category that still pays for
 * a triage call to work out what it holds.
 */
export const CATEGORY_TARGETS: Record<PageCategory, readonly IngestType[]> = {
  wellTest: ["wellTests"],
  service: ["service"],
  downtime: ["downtime"],
  wellEquipment: ["wellEquipment"],
  production: ["production"],
  shot: ["shots"],
  gasTest: ["gasTests"],
  wellNote: ["wellNotes"],
  runTicket: ["runTickets"],
  tankGauge: ["tankReadings"],
  meterReading: ["meterReadings"],
  oilRunStatement: [],
  revenueStatement: [],
  gasSettlementStatement: [],
  vendorInvoice: [],
  continuation: [],
  blank: [],
  other: [],
};

/** Categories the model is never asked to choose — code assigns them. */
const MODEL_EXCLUDED: readonly PageCategory[] = ["blank"];

export interface PageVerdict {
  /** 1-based page number in the original document. */
  page: number;
  category: PageCategory;
  /** 0–1. Below `MIN_SPLIT_CONFIDENCE` the grouper will not start a segment. */
  confidence: number;
  why: string;
}

/** Hard ceiling on the classify call — a short labelling job, not extraction. */
const CLASSIFY_TIMEOUT_MS = 90_000;

/** Chars of each page's head and tail sent to the model. Head alone is not
 * enough: printed letterhead is identical across a company's form types, and
 * the discriminator is often a totals or signature block at the foot. */
const HEAD_CHARS = 300;
const TAIL_CHARS = 150;

/** Pages per model call. ~450 chars/page means 60 pages is one comfortable
 * request; beyond that we window with one page of overlap so `continuation`
 * still resolves across the seam. */
const WINDOW_PAGES = 60;
const WINDOW_OVERLAP = 1;

/** Markers the reader emits for a page with nothing on it. Matched in code so
 * these never cost a model decision. */
const EMPTY_MARKERS = [
  /^\[adjacent page partially visible[^\]]*\]$/i,
  /^\[figure:[^\]]*\]$/i,
];

/** Is this page empty enough to label `blank` without asking the model? */
export function isBlankPage(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  return EMPTY_MARKERS.some((re) => re.test(t));
}

const VerdictSchema = z.object({
  page: z.coerce.number().int(),
  category: z.string(),
  confidence: z.coerce.number().min(0).max(1).catch(0),
  why: z.string().default(""),
});
const ReplySchema = z.object({ pages: z.array(VerdictSchema).default([]) });

/** Render one page's sample for the prompt. */
function renderPage(pageNo: number, text: string): string {
  const t = text.trim();
  const lines = t ? t.split("\n").length : 0;
  const head = t.slice(0, HEAD_CHARS);
  // Only send a tail when it isn't already inside the head.
  const tail = t.length > HEAD_CHARS + TAIL_CHARS ? t.slice(-TAIL_CHARS) : "";
  return [
    `<page n="${pageNo}" lines="${lines}" chars="${t.length}">`,
    `<head>${head}</head>`,
    tail ? `<tail>${tail}</tail>` : "",
    `</page>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Split page indices into overlapping windows so one call stays a sane size. */
function windows(count: number): number[][] {
  if (count <= WINDOW_PAGES) {
    return [Array.from({ length: count }, (_, i) => i)];
  }
  const out: number[][] = [];
  for (let start = 0; start < count; start += WINDOW_PAGES - WINDOW_OVERLAP) {
    const end = Math.min(count, start + WINDOW_PAGES);
    out.push(Array.from({ length: end - start }, (_, k) => start + k));
    if (end === count) break;
  }
  return out;
}

/**
 * Classify every page of a transcribed document.
 *
 * Fails OPEN in every direction: an unparseable reply, a missing page, or an
 * unknown category all yield `{ category: "other", confidence: 0 }`, which the
 * grouper turns into a single whole-document segment routed through triage —
 * i.e. exactly the pre-segmentation behaviour. A classifier outage degrades the
 * pipeline, it never breaks it.
 *
 * `allowed` restricts the vocabulary offered to the model. The well route passes
 * the well taxonomy so a tank gauge photographed on a well page classifies
 * `other` and falls through, rather than proposing a type that route cannot
 * write.
 */
export async function classifyPages(
  pages: string[],
  opts: { allowed?: readonly PageCategory[]; scopeNote?: string } = {}
): Promise<{ verdicts: PageVerdict[]; usage: AgentUsage }> {
  const fallback = (i: number): PageVerdict => ({
    page: i + 1,
    category: "other",
    confidence: 0,
    why: "",
  });

  const verdicts: PageVerdict[] = pages.map((text, i) =>
    isBlankPage(text)
      ? { page: i + 1, category: "blank", confidence: 1, why: "empty page" }
      : fallback(i)
  );

  // Only non-blank pages are worth a model decision.
  const askable = pages
    .map((_, i) => i)
    .filter((i) => verdicts[i].category !== "blank");
  if (askable.length === 0) return { verdicts, usage: {} };

  const vocabulary = (opts.allowed ?? PAGE_CATEGORIES).filter(
    (c) => !MODEL_EXCLUDED.includes(c)
  );
  const allowedSet = new Set<string>(vocabulary);
  const system = loadSkill("classify-pages", {
    CATEGORIES: vocabulary.join(", "),
    SCOPE_NOTE: opts.scopeNote ?? "",
  });

  let inputTokens = 0;
  let outputTokens = 0;
  const callStart = Date.now();

  for (const window of windows(askable.length)) {
    const indices = window.map((w) => askable[w]);
    const user = indices.map((i) => renderPage(i + 1, pages[i])).join("\n");
    try {
      const { text, usage } = await streamAgentJson({
        label: "classify",
        system,
        user,
        maxOutputTokens: 8_000,
        timeoutMs: CLASSIFY_TIMEOUT_MS,
        // Labelling pages from a short sample against a fixed list.
        effort: "low",
      });
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;

      const parsed = ReplySchema.safeParse(JSON.parse(isolateJson(text)));
      if (!parsed.success) {
        ierr("classify: reply failed schema — pages default to other", {
          issues: parsed.error.issues.map((i) => i.message).slice(0, 3),
        });
        continue;
      }
      for (const v of parsed.data.pages) {
        const idx = v.page - 1;
        // Ignore a page number the model invented or that isn't in this window.
        if (!indices.includes(idx)) continue;
        // A later window's verdict wins on the overlap page: it saw the pages
        // that follow, which is what decides `continuation`.
        verdicts[idx] = {
          page: v.page,
          category: allowedSet.has(v.category)
            ? (v.category as PageCategory)
            : "other",
          confidence: allowedSet.has(v.category) ? v.confidence : 0,
          why: v.why,
        };
      }
    } catch (err) {
      ierr("classify: call FAILED — window defaults to other", {
        pages: indices.map((i) => i + 1),
        ...errorInfo(err),
      });
    }
  }

  const counts: Record<string, number> = {};
  let minConfidence = 1;
  for (const v of verdicts) {
    counts[v.category] = (counts[v.category] ?? 0) + 1;
    if (v.category !== "blank") minConfidence = Math.min(minConfidence, v.confidence);
  }
  ilog("classify: done", {
    ms: Date.now() - callStart,
    pages: pages.length,
    windows: windows(askable.length).length,
    categories: counts,
    minConfidence,
    outputTokens,
  });

  return { verdicts, usage: { inputTokens, outputTokens } };
}
