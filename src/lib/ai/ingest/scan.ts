import "server-only";

import { getSupabaseServer } from "@/lib/supabase/server";
import { gateAI, meterAnthropic } from "@/lib/billing/credits";
import { getAllSkills } from "@/lib/orion/skills-store";
import type { ContentPart } from "@/lib/ai/document-part";
import {
  INGEST_TYPES,
  INGEST_TYPE_META,
  DEDICATED_DOCUMENT_SKILLS,
  DEDICATED_DOCUMENT_TARGETS,
  DEDICATED_DOCUMENT_PROMPTS,
  type IngestType,
  type IngestScanStatus,
  type IngestScanTrace,
} from "@/lib/ai/ingest/types";
import { runTriage } from "@/lib/ai/ingest/triage";
import { categorizeDocument } from "@/lib/ai/ingest/categorize";
import {
  classifyPages,
  CATEGORY_TARGETS,
  type PageCategory,
} from "@/lib/ai/ingest/classify-pages";
import {
  capSegments,
  groupSegments,
  wholeDocumentSegment,
  type Segment,
} from "@/lib/ai/ingest/segments";
import {
  mergeSegmentResults,
  type SegmentResult,
} from "@/lib/ai/ingest/merge-segments";
import { analyzeAndValidate } from "@/lib/ai/ingest/dedicated-flow";
import { extractType } from "@/lib/ai/ingest/extract";
import { chunkDocument, mapWithLimit } from "@/lib/ai/ingest/chunk";
import { largestSheet, type TableDoc } from "@/lib/ai/ingest/structured/table";
import { inferInterpretation, verifyInterpretation } from "@/lib/ai/ingest/structured/infer";
import { applyInterpretation, type ApplyResult } from "@/lib/ai/ingest/structured/apply";
import { transcribeDocument } from "@/lib/ai/read-document";
import {
  loadIngestContext,
  matchWell,
  type IngestContext,
} from "@/lib/ai/ingest/context";
import { readGreasebook } from "@/lib/ai/ingest/greasebook/read";
import { suppressExistingRows } from "@/lib/ai/ingest/suppress";
import {
  readInvoicesFromMarkdown,
  type ExtractedInvoice,
} from "@/lib/invoices/extract";
import type { IngestProposal } from "@/lib/ai/ingest/actions";
import { ilog, ierr, errorInfo, describePart } from "@/lib/ai/ingest/log";

type SupabaseServer = Awaited<ReturnType<typeof getSupabaseServer>>;

/** Ceiling on simultaneous extract model calls across ALL (type, chunk) pairs, so
 * a many-chunk document fans out fast without opening unbounded provider calls. */
const EXTRACT_CONCURRENCY = 6;

/**
 * Record types the CODE-HEAVY structured path handles: high-volume, genuinely
 * tabular data where a spreadsheet is the normal input. For these, a clean
 * xlsx/csv is mapped by ONE cheap model call and applied by code, instead of
 * paying an LLM to read every row. A file whose data is none of these (or isn't
 * tabular at all) falls back to the AI extraction path.
 */
const STRUCTURED_TYPES: readonly IngestType[] = [
  "tankReadings",
  "runTickets",
  "meterReadings",
  "meterVolumes",
  "production",
  "wellTests",
  "disposalReadings",
  "transactions",
  "inventory",
];

/** A proposed set of rows for one type, before it is written to `ingest_proposals`. */
export interface ProposalDraft {
  type: IngestType;
  wellId: string | null;
  /** Pinned tank id for entity-scoped uploads (tank Add History); null otherwise. */
  tankId?: string | null;
  /** Pinned meter id for entity-scoped uploads (meter Add History); null otherwise. */
  meterId?: string | null;
  rows: unknown[];
  /**
   * 1-based source pages these rows were read from, ascending. Null when the
   * source had no page structure (xlsx/csv) or its page markers didn't
   * reconcile. Row-LEVEL provenance is a separate, later step; for the common
   * single-page segment this range already pins the page exactly.
   */
  sourcePages?: number[] | null;
}

/**
 * The outcome of analysing one document: the drafts it holds, plus WHY there are
 * none when it comes back empty. Callers surface `status` to the user so a
 * closed gate (no credits, scanning off, no skills) is never mistaken for a
 * clean "nothing to add". `status` is `"records"` iff `drafts` is non-empty.
 */
export interface ScanResult {
  status: IngestScanStatus;
  drafts: ProposalDraft[];
  /**
   * Invoices read out of this document by the Invoices page's OWN reader,
   * for a caller that asked for `reviewInvoices` and can show its review modal.
   *
   * An invoice is a nested document — one header, N charge lines — and the
   * approval card renders a flat row grid, so the two are not interchangeable.
   * A caller that can put the real review screen in front of the user gets the
   * nested shape here and NO `vendorInvoice` draft; one that cannot (a
   * backgrounded upload with nobody watching) leaves this empty and keeps the
   * flat card, which is better than nothing.
   */
  invoices: ExtractedInvoice[];
  /** What the scan did, for the browser console. See `IngestScanTrace`. */
  trace?: IngestScanTrace;
}

/**
 * Collects per-stage timings and the routing decision as the scan runs.
 *
 * Mutable and passed down rather than returned, because the stages are spread
 * across three functions and two early-return paths; threading a return value
 * through all of them would mean every `noDrafts` call site had to remember to
 * carry it, which is exactly the kind of thing that gets forgotten and leaves a
 * blank trace on the failure you most wanted to see.
 */
class ScanTrace {
  private readonly startedAt = Date.now();
  private readonly stages: { stage: string; ms: number }[] = [];
  route: IngestScanTrace["route"] = "none";
  category?: string;
  targets?: string[];

  constructor(readonly fileName: string) {}

  /** Time one stage. Records the elapsed ms even when the stage throws. */
  async time<T>(stage: string, run: () => Promise<T>): Promise<T> {
    const at = Date.now();
    try {
      return await run();
    } finally {
      this.stages.push({ stage, ms: Date.now() - at });
    }
  }

  finish(status: IngestScanStatus, drafts: ProposalDraft[]): IngestScanTrace {
    return {
      fileName: this.fileName,
      ms: Date.now() - this.startedAt,
      route: this.route,
      category: this.category,
      targets: this.targets,
      stages: this.stages,
      groups: drafts.map((d) => ({ type: d.type, rows: d.rows.length })),
      status,
    };
  }
}

/** Which ingest types are on, per the write-skill toggles (built-ins are on). */
async function enabledIngestTypes(): Promise<IngestType[]> {
  const skills = await getAllSkills();
  const on = new Set(
    skills.filter((s) => s.builtIn || s.enabledByDefault).map((s) => s.id)
  );
  return INGEST_TYPES.filter((t) => on.has(INGEST_TYPE_META[t].skillId));
}

/**
 * No drafts, with the reason why — the shared shape for every gated-off path.
 *
 * `trace` is optional so the handful of gates that fire before a scan begins
 * (no credits, scanning off) stay one-liners; everything after the read passes
 * one so the browser can see where it stopped.
 */
function noDrafts(status: IngestScanStatus, trace?: ScanTrace): ScanResult {
  return { status, drafts: [], invoices: [], trace: trace?.finish(status, []) };
}

/**
 * The destinations a document uploaded onto a WELL's page can propose. This is
 * now the well Add menu's taxonomy in full: Well test, Note, Gas test,
 * Downtime, Shot, Info, Service. `Info` needs no entry of its own — that menu
 * item opens the equipment detail modal and writes a label/value row, so
 * `wellEquipment` already is it. Daily volumes are here too, since a production
 * sheet is one of the commonest things photographed onto a well page.
 *
 * Still deliberately narrow: tank gauges, run tickets and settlement money are
 * NOT here. Those are tank- and meter-scoped and reach the system through their
 * own surfaces; letting the well page propose them would file a neighbouring
 * device's data against this well. `gasTests` is the one apparent exception and
 * is not really one: the reading is taken off a meter but is filed AS this
 * well's share, and its writer only ever touches a campaign the well already
 * belongs to.
 *
 * `wellTests` and `production` were previously excluded on the grounds that
 * each had "its own surface". `wellTests` never did, and production's
 * (`UploadProductionModal`) is not mounted anywhere — so a well test or
 * production sheet photographed onto a well page had no destination at all and
 * its data was silently dropped. Filtered to the enabled types at scan time,
 * exactly like `DEDICATED_DOCUMENT_TARGETS`.
 */
const WELL_SCOPE_TARGETS: readonly IngestType[] = [
  "wellEquipment",
  "service",
  "downtime",
  "wellTests",
  "production",
  "shots",
  "wellNotes",
  "gasTests",
];

/** The analyze + validate skill pair driving the well-page route. */
const WELL_SCOPE_PROMPTS = {
  analyze: "well-document",
  validate: "well-document-validate",
};

/**
 * Final step before returning proposals: drop rows that already exist so the
 * approval modal only ever suggests genuinely-new records (see `suppress.ts`).
 * If suppression empties the set, distinguish "everything was already on file"
 * (`all_on_file`) from a genuine "found nothing" so the user gets an accurate,
 * reassuring message instead of a misleading blank. Best-effort: a suppression
 * failure degrades to the un-suppressed drafts rather than losing the scan.
 */
async function finalizeDrafts(
  sb: SupabaseServer,
  drafts: ProposalDraft[],
  trace: ScanTrace,
  /**
   * Invoices the reader pulled out of the same document, which are a RESULT in
   * their own right even when the drafts are empty. Without them here, a
   * document that is nothing but an invoice comes back "no records found" while
   * the invoice it holds is sitting in the return value.
   */
  invoices: ExtractedInvoice[] = []
): Promise<ScanResult> {
  if (drafts.length === 0) {
    return invoices.length > 0
      ? { status: "records", drafts: [], invoices, trace: trace.finish("records", []) }
      : noDrafts("no_records", trace);
  }
  let kept = drafts;
  let suppressed = 0;
  try {
    const res = await suppressExistingRows(sb, drafts);
    kept = res.drafts;
    suppressed = res.suppressed;
  } catch (err) {
    ierr("suppress: pass FAILED — keeping all drafts", errorInfo(err));
  }
  if (kept.length > 0 || invoices.length > 0) {
    return {
      status: "records",
      drafts: kept,
      invoices,
      trace: trace.finish("records", kept),
    };
  }
  // Every proposed row was already on file (as opposed to nothing being found).
  ilog("suppress: all rows already on file", { suppressed });
  return noDrafts(suppressed > 0 ? "all_on_file" : "no_records", trace);
}

/**
 * Analyse an uploaded document and return the record drafts it holds — WITHOUT
 * touching the DB — alongside a `status` explaining an empty result. Runs all
 * gates (org toggle -> credits -> enabled skills), then phase-1 triage and
 * phase-2 per-type extraction in parallel. Takes the document part built from
 * the upload's in-memory bytes, so nothing is re-downloaded from Storage.
 *
 * Every early return carries a distinct status ("scan_disabled", "no_credits",
 * "ai_unavailable", "no_skills", "no_records") so the caller can tell the user
 * exactly why nothing was proposed instead of a silent no-op. `status` is
 * "records" iff `drafts` is non-empty.
 *
 * This is the compute half of the ingest job; the upload path runs it *in
 * parallel with the Storage write* and only persists the results (see
 * `insertIngestProposals`) once the `files` row exists.
 */
/**
 * Optional post-extraction refinement: given the freshly extracted drafts and
 * the document text, return a corrected draft set. Used by entity-scoped uploads
 * (e.g. the tank-history validation loop) to check additions before they become
 * approval cards. Runs only for server callers that pass it.
 */
export type RefineDrafts = (
  drafts: ProposalDraft[],
  documentText: string
) => Promise<ProposalDraft[]>;

/** How many times to re-verify + repair the interpretation before accepting it. */
const STRUCTURED_REPAIR_PASSES = 2;

/**
 * The code-heavy import for a clean tabular file, as an adaptive loop:
 *   infer (content-aware interpretation) -> apply (code, every row) ->
 *   verify (model audits the ACTUAL output vs the source) -> repair -> escalate.
 * The model provides the intelligence (how to read this file's variation, and an
 * audit of the result); code does the per-row work for free. Rows the rules can't
 * confidently place are escalated to direct model extraction, so cost tracks
 * irregularity, not row count, and a misread can never silently ship. Returns the
 * drafts it read, or `null` to fall back to the full AI path. Gates already checked.
 */
/**
 * THE GREASEBOOK FAST PATH: a layout we already know, read in code.
 *
 * An operator migrating off GreaseBook arrives with a pile of its exports, and
 * those exports are machine-generated and fixed. Recognizing them by shape costs
 * nothing and skips BOTH model calls the structured path would spend inferring
 * and verifying a mapping it can work out for free — so a decade of history
 * imports instantly instead of one file at a time.
 *
 * It can only ever be a shortcut. Every way it can fail returns null, and the
 * caller then runs the pipeline that runs today: an unrecognized layout, a reader
 * that throws, and a file whose rows all fail their schema are the same answer
 * here. Rows it reads but cannot place, or whose arithmetic does not reconcile
 * (see `greasebook/verify`), are escalated to the model like any other residual,
 * so a partly-recognized file still imports completely.
 *
 * Which branch was taken is logged on every scan. A silent fallback is how
 * "instant and free" would stop being true without anyone noticing.
 */
async function greasebookScan(
  sb: SupabaseServer,
  table: TableDoc,
  enabled: IngestType[],
  scanStart: number
): Promise<{ drafts: ProposalDraft[] } | null> {
  let result: ReturnType<typeof readGreasebook>;
  try {
    result = readGreasebook(largestSheet(table).rows);
  } catch (err) {
    ierr("greasebook: reader FAILED — falling back", errorInfo(err));
    return null;
  }
  if (!result) return null;

  const allowed = [...result.byType].filter(([type]) => enabled.includes(type));
  if (allowed.length === 0 && result.residual.length === 0) {
    ilog("greasebook: recognized but nothing enabled to write — falling back", {
      report: result.report,
    });
    return null;
  }
  const skippedTypes = [...result.byType.keys()].filter((t) => !enabled.includes(t));

  const candidates = STRUCTURED_TYPES.filter((t) => enabled.includes(t));
  const ctx = await loadIngestContext(candidates);
  const wellId = matchWell(result.sections, ctx.wells);

  // The rows this reader could not place go to the model, exactly as the
  // structured path's residual does. Only the residual, so it stays cheap.
  const byType = new Map<IngestType, unknown[]>(allowed);
  if (result.residual.length > 0 && candidates.length > 0) {
    await escalateResidual(
      sb,
      { byType, residual: result.residual, header: result.header, samples: [] },
      candidates,
      ctx
    );
  }

  const drafts: ProposalDraft[] = [];
  for (const [type, rows] of byType) {
    if (rows.length === 0) continue;
    drafts.push({
      type,
      wellId: INGEST_TYPE_META[type].needsWell ? wellId : null,
      rows,
    });
  }

  ilog("greasebook: done", {
    report: result.report,
    ms: Date.now() - scanStart,
    drafts: drafts.map((d) => ({ type: d.type, rows: d.rows.length })),
    stats: result.stats,
    escalated: result.residual.length,
    checks: result.checks.filter((c) => c.verdict !== "ok"),
    skippedTypes,
    notes: result.notes,
  });
  return drafts.length > 0 ? { drafts } : null;
}

async function structuredScan(
  sb: SupabaseServer,
  table: TableDoc,
  enabled: IngestType[],
  scanStart: number
): Promise<{ drafts: ProposalDraft[] } | null> {
  const candidates = STRUCTURED_TYPES.filter((t) => enabled.includes(t));
  if (candidates.length === 0) return null;

  // Wells (+ existing records) so the interpretation can name a well for
  // well-scoped types; the same context loader the AI path uses.
  const ctx = await loadIngestContext(candidates);

  let interp;
  try {
    const first = await inferInterpretation({ table, candidateTypes: candidates, wells: ctx.wells });
    void meterAnthropic(first.usage, "ingest:structured-map", sb);
    interp = first.interp;
  } catch (err) {
    ierr("structured: infer FAILED", errorInfo(err));
    return null; // fall back to the AI path
  }
  if (interp.classifier.length === 0 || interp.types.length === 0) return null;

  // Apply -> verify -> repair, until the verifier is satisfied or passes run out.
  let result: ApplyResult = applyInterpretation(table, interp);
  for (let pass = 0; pass < STRUCTURED_REPAIR_PASSES; pass++) {
    let issues: string[] = [];
    try {
      const v = await verifyInterpretation({ result, candidateTypes: candidates });
      void meterAnthropic(v.usage, "ingest:structured-verify", sb);
      issues = v.issues;
    } catch (err) {
      ierr("structured: verify FAILED", errorInfo(err));
      break; // accept what we have rather than lose it
    }
    if (issues.length === 0) break;
    ilog("structured: repairing", { pass: pass + 1, issues });
    try {
      const repaired = await inferInterpretation({
        table,
        candidateTypes: candidates,
        wells: ctx.wells,
        feedback: issues,
        prior: interp,
      });
      void meterAnthropic(repaired.usage, "ingest:structured-map", sb);
      interp = repaired.interp;
      result = applyInterpretation(table, interp);
    } catch (err) {
      ierr("structured: repair FAILED", errorInfo(err));
      break;
    }
  }

  if (result.byType.size === 0) return null; // nothing placed — let the AI path try

  // Escalate the rows the rules could not confidently place to direct model
  // extraction — the intelligence backstop. Only the residual, so it stays cheap.
  if (result.residual.length > 0) {
    await escalateResidual(sb, result, candidates, ctx);
  }

  const wellId = matchWell(interp.wellNames, ctx.wells);
  const drafts: ProposalDraft[] = [];
  for (const [type, rows] of result.byType) {
    if (rows.length === 0) continue;
    drafts.push({
      type,
      wellId: INGEST_TYPE_META[type].needsWell ? wellId : null,
      rows,
    });
  }
  ilog("structured: done", {
    status: drafts.length > 0 ? "records" : "no_records",
    ms: Date.now() - scanStart,
    drafts: drafts.map((d) => ({ type: d.type, rows: d.rows.length })),
  });
  return drafts.length > 0 ? { drafts } : null;
}

/**
 * Send the residual rows (those no rule placed) through the AI extractor and merge
 * whatever it finds back into `result.byType`. The residual is rendered as its own
 * small CSV (header + rows) and chunked so a large-but-irregular tail still can't
 * truncate. Mutates `result.byType`. Best-effort: a failure just leaves those rows
 * out rather than failing the whole import.
 */
async function escalateResidual(
  sb: SupabaseServer,
  result: ApplyResult,
  candidates: IngestType[],
  ctx: Awaited<ReturnType<typeof loadIngestContext>>
): Promise<void> {
  const csv = [result.header, ...result.residual]
    .map((r) => r.map((c) => (c.includes(",") ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\n");
  const tasks = candidates.flatMap((type) =>
    chunkDocument(csv).map((text) => ({ type, text }))
  );
  ilog("structured: escalating residual", { rows: result.residual.length, tasks: tasks.length });
  await mapWithLimit(tasks, EXTRACT_CONCURRENCY, async (task) => {
    try {
      const { rows, usage } = await extractType(task.type, task.text, ctx);
      void meterAnthropic(usage, "ingest:extract", sb);
      if (rows.length === 0) return;
      if (!result.byType.has(task.type)) result.byType.set(task.type, []);
      result.byType.get(task.type)!.push(...rows);
    } catch (err) {
      ierr("structured: escalate chunk FAILED", { type: task.type, ...errorInfo(err) });
    }
  });
}

/**
 * How many segments one document may route. A classifier that alternates
 * categories page-by-page across a 40-page file must not spawn 40 routing
 * decisions; `capSegments` merges the cheapest adjacent pairs until it fits.
 */
const MAX_SEGMENTS = 12;

/** Dedicated segments run their own multi-pass loop, so they fan out narrowly. */
const DEDICATED_CONCURRENCY = 3;

/** The page categories the WELL route offers the classifier. A tank gauge
 * photographed on a well page should fall through as `other`, not be forced
 * into a well category this route has no writer for. */
const WELL_SCOPE_CATEGORIES: readonly PageCategory[] = [
  "vendorInvoice",
  "wellTest",
  "service",
  "downtime",
  "wellEquipment",
  "production",
  "shot",
  "gasTest",
  "wellNote",
  "oilRunStatement",
  "gasSettlementStatement",
  "continuation",
  "other",
];

/**
 * Stage 1b: classify pages and group them into segments.
 *
 * Every failure path collapses to one whole-document segment, which routes
 * exactly as the pipeline behaved before segmentation — so a classifier outage,
 * a page-marker mismatch, or a source with no pages at all (xlsx/csv) all
 * degrade rather than break.
 */
async function segmentDocument(
  sb: SupabaseServer,
  documentText: string,
  pages: string[] | undefined,
  opts: {
    pagesTrusted: boolean;
    allowed?: readonly PageCategory[];
    scopeNote?: string;
    /** Whole-document fallback only: categorize so a single-page dedicated
     * document still reaches its dedicated flow. Skipped on the well route,
     * which never used categorize. */
    categorizeFallback?: boolean;
  }
): Promise<Segment[]> {
  if (!pages || pages.length <= 1 || !opts.pagesTrusted) {
    const whole = wholeDocumentSegment(documentText);
    if (!opts.categorizeFallback) return [whole];

    // With no page structure the classifier has nothing to work on, so the
    // pre-segmentation agent still earns its call: without it a one-page oil
    // run statement would fall through to generic triage instead of its
    // dedicated analyze ⇄ validate flow.
    try {
      const { result, usage } = await categorizeDocument(documentText);
      void meterAnthropic(usage, "ingest:categorize", sb);
      ilog("categorize: done", {
        category: result.category,
        hasData: result.hasData,
        wellNames: result.wellNames,
      });
      if (!result.hasData) return [];
      if (DEDICATED_DOCUMENT_SKILLS[result.category]) {
        whole.category = result.category as PageCategory;
        whole.confidence = 1;
      }
    } catch (err) {
      ierr("categorize: FAILED — routing document generically", errorInfo(err));
    }
    return [whole];
  }

  let verdicts;
  try {
    const res = await classifyPages(pages, {
      allowed: opts.allowed,
      scopeNote: opts.scopeNote,
    });
    void meterAnthropic(res.usage, "ingest:classify", sb);
    verdicts = res.verdicts;
  } catch (err) {
    ierr("classify: FAILED — falling back to one segment", errorInfo(err));
    return [wholeDocumentSegment(documentText)];
  }

  const grouped = groupSegments(pages, verdicts);
  if (grouped.length === 0) return [wholeDocumentSegment(documentText)];

  const capped = capSegments(grouped, MAX_SEGMENTS);
  if (capped.length !== grouped.length) {
    ilog("segment: capped", { from: grouped.length, to: capped.length });
  }
  ilog("segment: grouped", {
    segments: capped.map((s) => ({
      category: s.category,
      pages: s.pages,
      confidence: s.confidence,
    })),
  });
  return capped;
}

/**
 * Run the segments whose category has a dedicated whole-document flow (oil run
 * statement, gas settlement statement, vendor invoice) through that flow.
 *
 * SHARED ON PURPOSE by the two routes that can meet one of these documents: the
 * generic route, where a dedicated category is one outcome of classification,
 * and the WELL route, where an invoice photographed onto a well's page is
 * routed here as well as through the well's own extraction. A second copy of
 * this loop would drift on the things that are easy to get subtly wrong — the
 * target fan-out and the tanks/meters context — and the drift would be silent
 * because both copies would still return rows.
 *
 * Segments with no dedicated category are ignored, so the caller can hand over
 * everything it has.
 */
async function runDedicatedSegments(
  sb: SupabaseServer,
  segments: Segment[],
  enabled: IngestType[]
): Promise<SegmentResult[]> {
  const results: SegmentResult[] = [];
  const dedicatedSegments = segments.filter(
    (s) => DEDICATED_DOCUMENT_SKILLS[s.category] !== undefined
  );
  if (dedicatedSegments.length === 0) return results;

  await mapWithLimit(
    dedicatedSegments,
    DEDICATED_CONCURRENCY,
    async (segment) => {
      const headline = DEDICATED_DOCUMENT_SKILLS[segment.category];
      if (!headline || !enabled.includes(headline)) return;
      const targets = (
        DEDICATED_DOCUMENT_TARGETS[segment.category] ?? [headline]
      ).filter((t) => enabled.includes(t));
      // Existing leases + tanks + meters so the model reuses them by name and
      // only proposes creating what's missing.
      const ctx = await loadIngestContext(
        Array.from(new Set<IngestType>([...targets, "tanks", "meters"]))
      );
      try {
        const { groups } = await analyzeAndValidate(segment.text, targets, ctx, {
          skills: DEDICATED_DOCUMENT_PROMPTS[segment.category],
          onUsage: (usage, stage) =>
            void meterAnthropic(usage, `ingest:${stage}`, sb),
        });
        for (const g of groups) results.push({ segment, type: g.type, rows: g.rows });
      } catch (err) {
        ierr("segment: dedicated FAILED", {
          category: segment.category,
          pages: segment.pages,
          ...errorInfo(err),
        });
      }
    }
  );
  return results;
}

/**
 * Route every segment to the engine its category names, then merge the results
 * into one draft per destination.
 *
 * Three engines:
 *  - a dedicated category (oil run / gas settlement statement) runs its own
 *    analyze ⇄ validate loop over just that segment;
 *  - a mapped category goes STRAIGHT to per-type extraction with NO triage call
 *    — the classifier already answered the question triage exists to answer,
 *    and paying for a triage call per segment is what would make segmentation
 *    cost more than the whole-file flow it replaces;
 *  - `other` is the only category that still pays for triage.
 */
async function routeSegments(
  sb: SupabaseServer,
  segments: Segment[],
  enabled: IngestType[],
  pagesTrusted: boolean
): Promise<ProposalDraft[]> {
  const results: SegmentResult[] = [];
  const wellIdByType = new Map<IngestType, string | null>();

  // --- Dedicated segments: each is a multi-pass loop, so they run separately
  // from the flat extract fan-out and under their own, narrower cap.
  const dedicated = await runDedicatedSegments(sb, segments, enabled);
  for (const r of dedicated) {
    results.push(r);
    if (!wellIdByType.has(r.type)) wellIdByType.set(r.type, null);
  }

  // --- Everything else: work out each segment's target types, triaging only
  // the `other` ones, then extract every (segment, type, chunk) under ONE cap.
  interface ExtractTask {
    segment: Segment;
    type: IngestType;
    text: string;
    chunkIndex: number;
    chunkCount: number;
    ctx: IngestContext;
  }
  const tasks: ExtractTask[] = [];

  for (const segment of segments) {
    if (DEDICATED_DOCUMENT_SKILLS[segment.category]) continue;

    let targets = CATEGORY_TARGETS[segment.category].filter((t) =>
      enabled.includes(t)
    );
    let wellNames: string[] = [];

    if (segment.category === "other") {
      // The one category the classifier could not place — triage still earns
      // its call here.
      try {
        const { result, usage } = await runTriage(segment.text, enabled);
        void meterAnthropic(usage, "ingest:triage", sb);
        ilog("triage: done", {
          pages: segment.pages,
          hasData: result.hasData,
          types: result.types,
        });
        if (!result.hasData) continue;
        targets = result.types.filter((t) => enabled.includes(t));
        wellNames = result.wellNames;
      } catch (err) {
        ierr("segment: triage FAILED", {
          pages: segment.pages,
          ...errorInfo(err),
        });
        continue;
      }
    }
    if (targets.length === 0) continue;

    const ctx = await loadIngestContext([...targets]);
    const matched = wellNames.length ? matchWell(wellNames, ctx.wells) : null;
    for (const type of targets) {
      if (INGEST_TYPE_META[type].needsWell && !wellIdByType.get(type)) {
        wellIdByType.set(type, matched);
      }
      // Chunking still applies WITHIN a segment: a single form can hold more
      // rows than one extract call's output ceiling can emit. It is now a
      // no-op for most segments, and its header-preamble heuristic samples a
      // real form instead of the first lines of an unrelated page.
      const parts = chunkDocument(segment.text);
      parts.forEach((text, chunkIndex) => {
        tasks.push({
          segment,
          type,
          text,
          chunkIndex,
          chunkCount: parts.length,
          ctx,
        });
      });
    }
  }

  ilog("extract: begin", {
    tasks: tasks.length,
    segments: segments.length,
    bySegment: tasks.map((t) => ({
      type: t.type,
      segment: t.segment.category,
      sourcePages: t.segment.pages,
    })),
  });

  // ONE flat fan-out. Nesting per-segment and per-chunk maps would put
  // segments × EXTRACT_CONCURRENCY calls in flight on a long document.
  const extracted = await mapWithLimit(tasks, EXTRACT_CONCURRENCY, async (task) => {
    const taskStart = Date.now();
    const label = {
      type: task.type,
      segment: task.segment.category,
      sourcePages: task.segment.pages,
      chunk: `${task.chunkIndex + 1}/${task.chunkCount}`,
    };
    try {
      const { rows, usage } = await extractType(task.type, task.text, task.ctx);
      void meterAnthropic(usage, "ingest:extract", sb);
      ilog("extract: chunk done", {
        ...label,
        rows: rows.length,
        ms: Date.now() - taskStart,
      });
      return { segment: task.segment, type: task.type, rows };
    } catch (err) {
      // One chunk failing drops only THIS slice — the other chunks of the same
      // type still contribute. `cause` holds the real provider error.
      ierr("extract: chunk FAILED", {
        ...label,
        ms: Date.now() - taskStart,
        ...errorInfo(err),
      });
      return null;
    }
  });
  for (const r of extracted) if (r && r.rows.length > 0) results.push(r);

  return mergeSegmentResults(results, {
    wellIdFor: (type) =>
      INGEST_TYPE_META[type].needsWell ? (wellIdByType.get(type) ?? null) : null,
  }).map((d) =>
    // Without page structure there is nothing meaningful to record.
    pagesTrusted ? d : { ...d, sourcePages: null }
  );
}

/**
 * The WELL route: one analyze ⇄ validate pass over the whole document, or a
 * per-segment fan-out when the document is genuinely a mixed batch.
 *
 * Fanning out unconditionally would be a large regression here. Unlike the
 * generic path, each well segment costs one analyze call PLUS up to
 * `MAX_VALIDATION_PASSES` validate/re-analyze rounds — a 5-page upload could
 * reach thirty model calls. So the whole document goes through one loop unless
 * it is both long and genuinely mixed, which is the only case where the
 * per-page precision is worth the extra passes.
 */
async function runWellRoute(
  sb: SupabaseServer,
  segments: Segment[],
  targets: IngestType[],
  ctx: IngestContext
): Promise<ProposalDraft[]> {
  const distinct = new Set(
    segments.filter((s) => s.category !== "other").map((s) => s.category)
  );
  const totalPages = segments.reduce((n, s) => n + s.pages.length, 0);
  const fanOut = totalPages > 3 && distinct.size >= 2;

  ilog("well: analyze route", {
    targets,
    segments: segments.length,
    pages: totalPages,
    fanOut,
  });

  const analyze = async (segment: Segment, passes?: number) => {
    const { groups } = await analyzeAndValidate(segment.text, targets, ctx, {
      skills: WELL_SCOPE_PROMPTS,
      maxValidationPasses: passes,
      onUsage: (usage, stage) =>
        void meterAnthropic(usage, `ingest:${stage}`, sb),
    });
    return groups.map((g) => ({ segment, type: g.type, rows: g.rows }));
  };

  if (!fanOut) {
    // One pass over the page-delimited text. The skill tells the model to treat
    // each page as its own form, which captures most of the segmentation
    // benefit here for zero extra calls.
    const whole: Segment = {
      category: segments[0]?.category ?? "other",
      pages: segments.flatMap((s) => s.pages),
      text: segments.map((s) => s.text).join("\n\n"),
      confidence: 0,
    };
    return mergeSegmentResults(await analyze(whole));
  }

  const perSegment = await mapWithLimit(
    segments,
    DEDICATED_CONCURRENCY + 1,
    async (segment) => {
      try {
        // A fanned-out segment is small and single-purpose, so it needs fewer
        // correction rounds than a whole mixed document does.
        return await analyze(segment, 2);
      } catch (err) {
        ierr("well: segment analyze FAILED", {
          pages: segment.pages,
          ...errorInfo(err),
        });
        return [];
      }
    }
  );
  return mergeSegmentResults(perSegment.flat());
}

/**
 * THE SECOND READING OF AN INVOICE: what it says about the WELL.
 *
 * An invoice is two documents at once. It is a payable — the vendor, the charge
 * lines, the total — and it is the field record of a job: the pump that went
 * in, the workover on the 4th, the days the well was down for it. Only one of
 * those was ever being read. Dropped onto a well's page the document went
 * through the well skills and gave up both halves; uploaded anywhere else
 * (Invoices, Data Entry, a facility's Files tab) it was read as money only, and
 * the service history it carried was discarded. Same document, same operator,
 * different suggestions purely by where it was dropped.
 *
 * So this runs the well-page extraction over an invoice WHEREVER it arrives,
 * alongside the invoice reading rather than instead of it. It is the same
 * `runWellRoute` the well page uses — not a second, similar pass — so the two
 * surfaces cannot drift.
 *
 * THE WELL comes from the property the vendor printed, resolved with the same
 * `matchWell` the equipment backfill uses (exact, then canonical-with-
 * uniqueness, then the tail after the operator's name — never a guess). An
 * unresolved property leaves `wellId` null and the approval card asks, which is
 * the right question to put to a human. A caller that already knows the well
 * (the well page) passes it and skips the lookup entirely.
 *
 * Best-effort throughout: this is a bonus reading of a document that was
 * already understood, so a failure here logs and yields nothing rather than
 * taking the invoice down with it.
 */
async function wellReadingOfInvoice(
  sb: SupabaseServer,
  segments: Segment[],
  enabled: IngestType[]
): Promise<{ drafts: ProposalDraft[]; wells: { id: string; name: string }[] }> {
  const targets = WELL_SCOPE_TARGETS.filter((t) => enabled.includes(t));
  if (targets.length === 0 || segments.length === 0) {
    return { drafts: [], wells: [] };
  }
  const at = Date.now();
  try {
    const ctx = await loadIngestContext(targets);
    const drafts = await runWellRoute(sb, segments, targets, ctx);
    ilog("invoice: well reading done", {
      ms: Date.now() - at,
      segments: segments.length,
      drafts: drafts.map((d) => ({ type: d.type, rows: d.rows.length })),
    });
    // The wells ride back with the drafts so the caller can resolve the invoice's
    // property against them without a second read of the same list. The lookup
    // is deliberately NOT done here: the property comes off the invoice half,
    // which runs in parallel with this and has not landed yet.
    return { drafts, wells: ctx.wells };
  } catch (err) {
    ierr("invoice: well reading FAILED", errorInfo(err));
    return { drafts: [], wells: [] };
  }
}

/**
 * Point an invoice's well reading at the well the vendor billed.
 *
 * Only fills a gap: a draft that named its own well keeps it, and a type that
 * needs no well is untouched. An unresolved property leaves `wellId` null and
 * the approval card asks, which is the right question to put to a human.
 */
function stampInvoiceWell(
  drafts: ProposalDraft[],
  wellId: string | null
): ProposalDraft[] {
  if (!wellId) return drafts;
  return drafts.map((d) =>
    INGEST_TYPE_META[d.type].needsWell && !d.wellId ? { ...d, wellId } : d
  );
}

/**
 * The well reading of an invoice for a caller that already has the transcript
 * and did its own invoice extraction — the Invoices page.
 *
 * That page deliberately bypasses this whole pipeline (see
 * `invoices/read-actions.ts`), so it has no segments and no enabled-type list;
 * it has the markdown its reader transcribed and the properties the invoices
 * named. This is the door for it, so the page gets the same second reading as
 * every other invoice surface without re-transcribing the document.
 *
 * The caller has already passed the org scan toggle and the credit gate — this
 * runs inside its read — so those are not re-checked here.
 */
export async function wellReadingOfInvoiceTranscript(
  sb: SupabaseServer,
  markdown: string,
  /**
   * The properties the invoices named, which decide the well these drafts land
   * on. Accepted as a PROMISE so this pass can run concurrently with the invoice
   * extraction that produces them: the property is not needed until the last
   * line, long after the expensive part is done.
   */
  propertyRefs: string[] | Promise<string[]>
): Promise<ProposalDraft[]> {
  if (!markdown.trim()) return [];
  const enabled = await enabledIngestTypes();
  const { drafts, wells } = await wellReadingOfInvoice(
    sb,
    [{ ...wholeDocumentSegment(markdown), category: "vendorInvoice" }],
    enabled
  );
  if (drafts.length === 0) return drafts;
  return stampInvoiceWell(drafts, matchWell(await propertyRefs, wells));
}

export async function computeIngestProposals(
  sb: SupabaseServer,
  part: ContentPart,
  opts: {
    refine?: RefineDrafts;
    table?: TableDoc | null;
    /**
     * Opt-in route for a file uploaded onto a WELL's page. The well is already
     * known from the surface, so instead of categorize/triage guessing the
     * document's kind, the three well-scoped destinations are extracted directly
     * by the analyze ⇄ validate loop. Only `uploadWellFile` passes this; every
     * other caller leaves it undefined and gets the unchanged flow below.
     */
    scope?: "well";
    /**
     * Stamp the upload's entity scope (its well / tank / meter) onto the drafts.
     *
     * Runs BEFORE suppression, and that ordering is the whole point. Every
     * well-scoped handler in `suppress.ts` opens with
     * `if (!d.wellId) return d.rows` — correct, since without a well there is
     * nothing to compare against, but it meant an entity-scoped upload was never
     * suppressed at all: the caller stamped the well onto the drafts this
     * function had already returned, so the scan compared `null` against the
     * database, kept every row, and the duplicate surfaced as an approval card
     * that the write step then refused ("0 added, 1 duplicate").
     *
     * Must be idempotent: callers also apply it to the returned drafts, so a
     * surface can never lose its scope by forgetting to pass this.
     */
    applyScope?: (drafts: ProposalDraft[]) => ProposalDraft[];
    /**
     * Restrict the WELL route to these destinations.
     *
     * The analyze ⇄ validate loop is one call over every well-scoped target at
     * once, so the prompt it builds — and the correction rounds it needs —
     * grow with the number of destinations in play. A surface that is waiting
     * on ONE of them (the service form, which holds its fields closed until the
     * answer lands) can ask for that one and get it back in a fraction of the
     * time, then run the rest where nobody is watching.
     *
     * Ignored by every other route: only the well route has a fixed target
     * list to narrow.
     */
    only?: readonly IngestType[];
    /**
     * The caller can put the Invoices page's REVIEW MODAL in front of the user,
     * so hand any invoice back as `ScanResult.invoices` (nested: one header, N
     * charge lines, beside the scan of it) instead of a flat `vendorInvoice`
     * approval card.
     *
     * Every upload surface whose user is standing there waiting passes this —
     * a well page, a facility's Files tab, Add History. A BACKGROUNDED upload
     * does not: nothing is on screen to review with, so it keeps the flat card,
     * which still files the invoice and is better than dropping it.
     *
     * Independent of the well reading — an invoice gets that either way.
     */
    reviewInvoices?: boolean;
  } = {}
): Promise<ScanResult> {
  const scanStart = Date.now();
  // The file NAME lives with the caller (`uploadFiles`), which stamps it onto
  // the returned trace; the scan itself only ever sees bytes.
  const trace = new ScanTrace("");
  ilog("scan: begin", describePart(part));
  /**
   * The single exit for every route: scope the drafts, then suppress. There are
   * three paths out of this function (structured, well, generic) and routing
   * them all through one closure is what keeps a future fourth from silently
   * skipping the scope step.
   */
  const finish = (
    drafts: ProposalDraft[],
    invoices: ExtractedInvoice[] = []
  ): Promise<ScanResult> =>
    finalizeDrafts(
      sb,
      opts.applyScope ? opts.applyScope(drafts) : drafts,
      trace,
      invoices
    );
  // Org master toggle: "Use AI to scan uploaded documents".
  const { data: orgId } = await sb.rpc("current_org_id");
  if (!orgId) {
    ierr("scan: gated (no current org id) -> ai_unavailable");
    return noDrafts("ai_unavailable");
  }
  const { data: org } = await sb
    .from("organizations")
    .select("ai_scan_uploads")
    .eq("id", orgId)
    .maybeSingle();
  if (org && org.ai_scan_uploads === false) {
    ilog("scan: gated (ai_scan_uploads off) -> scan_disabled");
    return noDrafts("scan_disabled");
  }

  const gate = await gateAI(sb);
  if (!gate.allowed) {
    // Distinguish an empty balance (the user can fix it by topping up) from any
    // other closed gate (billing misconfig, RPC error), which is not on them.
    const status = gate.reason === "no_credits" ? "no_credits" : "ai_unavailable";
    ierr("scan: gated by credits/billing", { reason: gate.reason, status });
    return noDrafts(status);
  }

  const enabled = await enabledIngestTypes();
  if (enabled.length === 0) {
    ilog("scan: gated (no enabled skills) -> no_skills");
    return noDrafts("no_skills", trace);
  }
  ilog("scan: gates passed", { enabledTypeCount: enabled.length });

  // CODE-HEAVY structured path: a clean tabular upload (xlsx/csv) is mapped by ONE
  // cheap model call and applied by code across every row — no per-row LLM cost,
  // and deterministic (the same mapping runs over the whole file). Falls through
  // to the AI path when the file isn't tabular or holds no structured-type data.
  // The well route always goes through analyze ⇄ validate (below), so the
  // structured mapper is skipped for it — its three destinations are narrative,
  // not tabular, and the validation loop is what keeps them honest.
  if (opts.table && opts.scope !== "well") {
    // A GreaseBook export is a layout we already know: read it in code and skip
    // the mapping calls entirely. Null means "not one of ours", and the
    // structured path below then runs exactly as it does today.
    const gb = await trace.time("greasebook", () =>
      greasebookScan(sb, opts.table!, enabled, scanStart)
    );
    if (gb) {
      trace.route = "greasebook";
      return finish(gb.drafts);
    }
    ilog("greasebook: not a recognized export — trying the structured mapper");

    const structured = await structuredScan(sb, opts.table, enabled, scanStart);
    if (structured) return finish(structured.drafts);
    ilog("structured: no mapping — falling back to AI extraction");
  }

  // Stage 1 — read: transcribe the document to plain text ONCE, skill-agnostic.
  // Triage and every extractor then work on this text; the raw file is never
  // re-sent to the model (that PDF-per-call load, plus the structured-output
  // grammar, is what stalled). A text part passes through with no model call.
  const readStart = Date.now();
  let documentText: string;
  let documentPages: string[] | undefined;
  let pagesTrusted = false;
  try {
    const read = await trace.time("read", () =>
      transcribeDocument(part, {
        onProgress: (chars) =>
          ilog("read: streaming", { chars, ms: Date.now() - readStart }),
      })
    );
    void meterAnthropic(read.usage, "ingest:read", sb);
    documentText = read.text;
    documentPages = read.pages;
    pagesTrusted = read.pagesTrusted;
  } catch (err) {
    ierr("read: FAILED", errorInfo(err));
    return noDrafts("error", trace);
  }
  ilog("read: done", { ms: Date.now() - readStart, chars: documentText.length });
  if (!documentText.trim()) {
    ilog("read: empty transcription -> unreadable");
    return noDrafts("unreadable", trace);
  }

  // Stage 1b — SEGMENT: classify each page and group contiguous pages of the
  // same kind into logical documents, so routing and extraction happen per form
  // instead of once for the whole file. Degrades to a single whole-document
  // segment (i.e. exactly the pre-segmentation behaviour) whenever there is no
  // page structure to work with or the classifier can't decide.
  const segments = await segmentDocument(sb, documentText, documentPages, {
    pagesTrusted,
    // A well upload is usually ONE photographed sheet, which has no page
    // structure for the classifier to work on. Without this fallback the most
    // common well upload of all could never be recognised as an invoice, since
    // recognising it is precisely what this call does.
    categorizeFallback: true,
    allowed: opts.scope === "well" ? WELL_SCOPE_CATEGORIES : undefined,
    scopeNote:
      opts.scope === "well"
        ? "This file was uploaded onto a SPECIFIC WELL's page, so it is almost always well paperwork. A page holding tank gauges, run tickets, meter volumes, or settlement money is NOT a well record here — classify it `other` rather than forcing it into a well category. A vendor's INVOICE or priced field ticket IS routable here: classify it `vendorInvoice`, because the operator owes that money whichever page it was dropped on."
        : undefined,
  });

  // WELL-PAGE route. The surface already tells us the well, so there is nothing
  // for categorize/triage to decide: go straight to the analyze ⇄ validate loop
  // with the well-scoped destinations. `wellId` is left null here and stamped by
  // the caller (`uploadWellFile`), which knows the well the file was dropped on.
  if (opts.scope === "well") {
    const wanted = (t: IngestType) => !opts.only || opts.only.includes(t);
    const targets = WELL_SCOPE_TARGETS.filter(
      (t) => enabled.includes(t) && wanted(t)
    );
    const invoiceSegments = segments.filter(
      (seg) => seg.category === "vendorInvoice"
    );
    const invoiceHere =
      invoiceSegments.length > 0 &&
      enabled.includes("vendorInvoice") &&
      wanted("vendorInvoice");
    if (targets.length === 0 && !invoiceHere) {
      ilog("well: no well-scoped types enabled -> no_skills");
      return noDrafts("no_skills", trace);
    }
    let drafts: ProposalDraft[] = [];
    if (targets.length > 0) {
      const ctx = await loadIngestContext(targets);
      try {
        drafts = await runWellRoute(sb, segments, targets, ctx);
      } catch (err) {
        ierr("well: analyze/validate FAILED", errorInfo(err));
        return noDrafts("error", trace);
      }
    }

    /*
     * A vendor invoice dropped on a well's page is BOTH things, and it is
     * offered as both.
     *
     * The well route above already read it for what it says about the well —
     * the job, the equipment that went in — and that is why this runs ALONGSIDE
     * it rather than instead of it. What the well route has no destination for
     * is the money: without this the charge lines, the vendor and the total
     * were read, discarded, and never reached /invoices at all.
     *
     * WHICH SHAPE the money comes back in is the caller's to say. Given
     * `reviewInvoices` it is read by the Invoices page's own reader and returned
     * nested, for that page's review modal — the screen an invoice deserves,
     * with the charge lines beside the scan of them. That review is the FIRST
     * thing the user sees on the way out of the upload, ahead of the approval
     * cards, because filing the payable is the primary act and the well records
     * are the by-product. Without `reviewInvoices` (a backgrounded upload, with
     * nobody watching) it stays a flat `vendorInvoice` card, which files the
     * same invoice through the same writer.
     */
    let invoices: ExtractedInvoice[] = [];
    if (invoiceHere) {
      try {
        if (opts.reviewInvoices) {
          invoices = await readInvoicesFromMarkdown(
            invoiceSegments.map((s) => s.text).join("\n\n"),
            sb
          );
          ilog("well: invoice read for review", { invoices: invoices.length });
        }
        // The dedicated flow runs when nobody asked for the review shape — and
        // as the FALLBACK when the reader came back empty on a document the
        // classifier called an invoice. Two model passes disagreeing is not a
        // reason to drop the operator's bill on the floor.
        if (invoices.length === 0) {
          const dedicated = await runDedicatedSegments(sb, invoiceSegments, enabled);
          const invoiceDrafts = mergeSegmentResults(dedicated, {
            wellIdFor: () => null,
          });
          ilog("well: invoice segments routed", {
            segments: invoiceSegments.length,
            fallback: Boolean(opts.reviewInvoices),
            drafts: invoiceDrafts.map((d) => ({
              type: d.type,
              rows: d.rows.length,
            })),
          });
          drafts = [...drafts, ...invoiceDrafts];
        }
      } catch (err) {
        // The well's own records are already extracted; losing the invoice half
        // must not lose them too.
        ierr("well: invoice route FAILED", errorInfo(err));
      }
    }

    ilog("scan: done", {
      route: "well",
      status: drafts.length > 0 || invoices.length > 0 ? "records" : "no_records",
      ms: Date.now() - scanStart,
      drafts: drafts.map((d) => ({ type: d.type, rows: d.rows.length })),
      invoices: invoices.length,
    });
    return finish(drafts, invoices);
  }

  // GENERIC route — dispatch each segment to the engine its category names.
  //
  // An INVOICE among those segments is the one document that gets read twice
  // (see `wellReadingOfInvoice`): once as the payable it is, and once as the
  // field record of the job it billed for. The two passes have nothing to say
  // to each other, so they run together and the wall clock is the slower of
  // them rather than the sum.
  const invoiceSegments = segments.filter((s) => s.category === "vendorInvoice");
  const reviewHere = Boolean(opts.reviewInvoices) && invoiceSegments.length > 0;
  // With a review screen waiting for it, the invoice is read by the Invoices
  // page's reader instead of the dedicated flow — so its segments are withheld
  // from the router rather than extracted twice into two different shapes.
  const routed = reviewHere
    ? segments.filter((s) => s.category !== "vendorInvoice")
    : segments;

  let drafts: ProposalDraft[];
  let invoices: ExtractedInvoice[] = [];
  let wellReading: { drafts: ProposalDraft[]; wells: { id: string; name: string }[] } = {
    drafts: [],
    wells: [],
  };
  try {
    [drafts, invoices, wellReading] = await Promise.all([
      routed.length > 0
        ? routeSegments(sb, routed, enabled, pagesTrusted)
        : Promise.resolve([]),
      reviewHere
        ? readInvoicesFromMarkdown(
            invoiceSegments.map((s) => s.text).join("\n\n"),
            sb
          ).catch((err) => {
            // The well reading of the same document is still worth having.
            ierr("invoice: read for review FAILED", errorInfo(err));
            return [] as ExtractedInvoice[];
          })
        : Promise.resolve([] as ExtractedInvoice[]),
      invoiceSegments.length > 0
        ? wellReadingOfInvoice(sb, invoiceSegments, enabled)
        : Promise.resolve({ drafts: [], wells: [] }),
    ]);
  } catch (err) {
    ierr("segment: routing FAILED", errorInfo(err));
    return noDrafts("error");
  }

  // FALLBACK: the reader came back empty on a document the classifier called an
  // invoice, so the dedicated flow gets its turn. Two model passes disagreeing
  // is not a reason to drop the operator's bill on the floor.
  if (reviewHere && invoices.length === 0) {
    try {
      const dedicated = await runDedicatedSegments(sb, invoiceSegments, enabled);
      const invoiceDrafts = mergeSegmentResults(dedicated, {
        wellIdFor: () => null,
      });
      ilog("invoice: review read empty — fell back to the dedicated flow", {
        drafts: invoiceDrafts.map((d) => ({ type: d.type, rows: d.rows.length })),
      });
      drafts = [...drafts, ...invoiceDrafts];
    } catch (err) {
      ierr("invoice: dedicated fallback FAILED", errorInfo(err));
    }
  }

  // Point the well reading at the well the vendor billed. The property is taken
  // from BOTH invoice shapes, because either can be the one this route produced
  // — the nested read, or the flat draft the fallback above fell back to.
  if (wellReading.drafts.length > 0) {
    const refs = [
      ...invoices.map((i) => i.propertyRef),
      ...drafts
        .filter((d) => d.type === "vendorInvoice")
        .flatMap((d) => d.rows)
        .map((r) => String((r as { propertyRef?: unknown }).propertyRef ?? "")),
    ];
    drafts = [
      ...drafts,
      ...stampInvoiceWell(wellReading.drafts, matchWell(refs, wellReading.wells)),
    ];
  }

  if (drafts.length === 0 && invoices.length === 0) return noDrafts("no_records");

  // Entity-scoped refinement (e.g. the tank-history validation loop): correct the
  // drafts against the source before they are returned. Best-effort — the refiner
  // itself degrades to the raw drafts on failure.
  if (opts.refine && drafts.length > 0) {
    drafts = await opts.refine(drafts, documentText);
  }

  ilog("scan: done", {
    status: drafts.length > 0 || invoices.length > 0 ? "records" : "no_records",
    ms: Date.now() - scanStart,
    drafts: drafts.map((d) => ({ type: d.type, rows: d.rows.length })),
    invoices: invoices.length,
  });
  return finish(drafts, invoices);
}

/**
 * Persist proposal drafts as `pending` rows for a file and return them in the
 * client shape, so the awaited upload can hand them straight to the approval
 * modal (Realtime is only a fallback). Requires the `files` row to exist (FK).
 * Best-effort: an insert failure is logged and yields []. never surfaced to the
 * upload.
 */
const PROPOSAL_COLS =
  "id, type, file_name, well_id, tank_id, meter_id, rows, status, created_at, source_pages";

/** The `ingest_proposals` insert payload for one draft. */
function proposalPayload(
  fileId: string | null,
  fileName: string,
  d: ProposalDraft
): Record<string, unknown> {
  return {
    file_id: fileId,
    file_name: fileName,
    type: d.type,
    well_id: d.wellId,
    tank_id: d.tankId ?? null,
    meter_id: d.meterId ?? null,
    status: "pending",
    rows: d.rows,
    source_pages: d.sourcePages?.length ? d.sourcePages : null,
  };
}

/** Serialized byte length of a draft's rows JSONB (the insert's real weight). */
function rowsBytes(d: ProposalDraft): number {
  try {
    return JSON.stringify(d.rows).length;
  } catch {
    return -1;
  }
}

/** Flatten a Supabase/Postgres error into a fully-loggable object. Falls back to
 * enumerating keys + a raw stringify so nothing is lost when the error isn't the
 * expected `PostgrestError` shape (e.g. a network/timeout/abort error). */
function insertErrorInfo(error: unknown): Record<string, unknown> {
  const e = error as {
    message?: unknown;
    code?: unknown;
    details?: unknown;
    hint?: unknown;
  } | null;
  let raw = "";
  try {
    raw = JSON.stringify(error);
  } catch {
    raw = String(error);
  }
  return {
    message: e?.message ?? null,
    code: e?.code ?? null,
    details: e?.details ?? null,
    hint: e?.hint ?? null,
    keys: error && typeof error === "object" ? Object.keys(error) : [],
    raw: raw && raw !== "{}" ? raw : String(error),
  };
}

function mapProposalRow(r: Record<string, unknown>): IngestProposal {
  return {
    id: r.id as string,
    type: r.type as IngestProposal["type"],
    fileName: (r.file_name as string | null) ?? "",
    wellId: r.well_id as string | null,
    tankId: (r.tank_id as string | null) ?? null,
    meterId: (r.meter_id as string | null) ?? null,
    rows: Array.isArray(r.rows) ? (r.rows as unknown[]) : [],
    status: r.status as string,
    createdAt: r.created_at as string,
    sourcePages: Array.isArray(r.source_pages)
      ? (r.source_pages as number[])
      : null,
  };
}

export async function insertIngestProposals(
  sb: SupabaseServer,
  // Null for uploads with no `files` row (statement uploads live in their own
  // bucket); the proposal then carries only the file NAME for display.
  fileId: string | null,
  fileName: string,
  drafts: ProposalDraft[]
): Promise<IngestProposal[]> {
  if (drafts.length === 0) return [];
  const attempted = drafts.map((d) => ({
    type: d.type,
    rows: d.rows.length,
    bytes: rowsBytes(d),
  }));
  const totalBytes = attempted.reduce((s, a) => s + Math.max(0, a.bytes), 0);
  ilog("insert: begin", { fileName, drafts: attempted.length, totalBytes, attempted });

  // Try the whole set in one insert first (cheapest). On ANY failure, fall back
  // to inserting each draft on its own — so the log pinpoints WHICH draft/type/
  // size fails, and the healthy drafts still persist instead of the entire batch
  // being lost. The batch insert is one statement, so a failure rolls it fully
  // back (no partial rows) and the per-draft retry can't duplicate.
  const batch = await sb
    .from("ingest_proposals")
    .insert(drafts.map((d) => proposalPayload(fileId, fileName, d)))
    .select(PROPOSAL_COLS);
  if (!batch.error) {
    ilog("insert: done", { fileName, persisted: batch.data?.length ?? 0 });
    return (batch.data ?? []).map(mapProposalRow);
  }

  ierr("insert: batch FAILED — retrying per-draft to isolate", {
    fileName,
    totalBytes,
    attempted,
    error: insertErrorInfo(batch.error),
  });

  const persisted: IngestProposal[] = [];
  for (const d of drafts) {
    const info = { type: d.type, rows: d.rows.length, bytes: rowsBytes(d) };
    const one = await sb
      .from("ingest_proposals")
      .insert(proposalPayload(fileId, fileName, d))
      .select(PROPOSAL_COLS);
    if (one.error) {
      // A `..._type_check` violation (code 23514) means the type isn't allowed by
      // the CHECK constraint — the migration is behind the code. A 57014 is a
      // statement timeout (rows too large); 54000 / 08P01 point at payload size.
      ierr("insert: draft FAILED", {
        fileName,
        draft: info,
        error: insertErrorInfo(one.error),
      });
    } else {
      ilog("insert: draft ok", { fileName, draft: info, persisted: one.data?.length ?? 0 });
      persisted.push(...(one.data ?? []).map(mapProposalRow));
    }
  }
  if (persisted.length === 0) {
    ierr("insert: ALL drafts FAILED — no proposals persisted", { fileName, attempted });
  } else if (persisted.length < drafts.length) {
    ilog("insert: PARTIAL — some drafts persisted", {
      fileName,
      persisted: persisted.length,
      of: drafts.length,
    });
  }
  return persisted;
}
