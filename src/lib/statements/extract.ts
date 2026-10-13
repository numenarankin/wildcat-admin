import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { meterAnthropic } from "@/lib/billing/credits";
import { SCAN_MODEL_ID, scanModel, scanProviderOptions } from "@/lib/ai/scan-model";
import { listTanks } from "@/lib/tanks/tanks";
import { listMeters } from "@/lib/meters/meters";
import { listLeases } from "@/lib/leases/leases";
import {
  buildLeaseAliases,
  matchByNumber,
  resolveLeaseId,
  type MatchTarget,
} from "@/lib/statements/matching";
import { gasLinePrice, listLeaseAliases } from "@/lib/statements/statements";
import type { ContentPart } from "@/lib/ai/document-part";
import {
  transcribeDocument,
  splitTranscriptPages,
  transcriptPageRange,
} from "@/lib/ai/read-document";
import { mapWithLimit } from "@/lib/ai/ingest/chunk";
import { describePart, errorInfo, ierr, ilog } from "@/lib/ai/ingest/log";
import {
  isolateJson,
  streamAgentJson,
  unwrapToolEnvelope,
} from "@/lib/ai/ingest/agent-call";
import { loadSkill } from "@/lib/ai/ingest/skills/load";
import type { IngestScanStatus } from "@/lib/ai/ingest/types";
import {
  checkStatements,
  NET_TOLERANCE_USD,
  PRICE_TOLERANCE_RATIO,
  TOTAL_TOLERANCE_USD,
  type StatementWarning,
} from "@/lib/statements/checks";

type Sb = SupabaseClient;

/**
 * Why an extraction produced the statements it did.
 *
 * The failure values are DERIVED from `IngestScanStatus` (via `Extract`) rather
 * than restated: the Revenue upload and the well-page scan read the same paper
 * and fail the same ways, so the vocabulary — and therefore the copy the user
 * sees (`scan-status-copy.ts`) — is shared by construction. Renaming a shared
 * member in one place now fails to compile here instead of silently forking.
 * Only three values are this route's own: `statements` (its success value,
 * "records" for a surface whose output is statements not cards), `no_statements`
 * (its `no_records` — the read worked, the paper just isn't a settlement), and
 * `not_permitted` (checked at the route, where the ingest pipeline has no
 * equivalent exit). Every exit from the extract route carries one of these, so
 * the client never has to infer meaning from an HTTP status code.
 */
export type StatementScanStatus =
  | "statements"
  | "no_statements"
  | "not_permitted"
  | Extract<
      IngestScanStatus,
      "unreadable" | "no_credits" | "ai_unavailable" | "scan_disabled" | "error"
    >;

/** One extracted settlement line — printed identifiers + economics + gas fields. */
const lineSchema = z.object({
  leaseRef: z.string(),
  tankRef: z.string(),
  meterRef: z.string(),
  product: z.enum(["oil", "gas"]),
  volume: z.number(),
  price: z.number().nullable(),
  grossValue: z.number(),
  deducts: z.number(),
  taxes: z.number(),
  netValue: z.number(),
  mmbtu: z.number().nullable(),
  allocatedQty: z.number().nullable(),
  producerPct: z.number().nullable(),
  settleQty: z.number().nullable(),
  // Nullable like every other gas-only field. The prompt tells the model to send
  // null for these on an oil statement (see the GAS ONLY line below), so a
  // non-nullable schema here rejected every oil statement it correctly extracted.
  fees: z.number().nullable(),
  raw: z.record(z.string(), z.unknown()),
});

/** One detected statement — a single purchaser × period × commodity document. */
const statementSchema = z.object({
  purchaser: z.string(),
  // The purchaser's own contact details, so filing a statement also files WHO
  // to call about it. Defaulted: plenty of statements print none, and an
  // extraction is not worth discarding over a missing phone number.
  purchaserPhone: z.string().default(""),
  purchaserEmail: z.string().default(""),
  purchaserContact: z.string().default(""),
  // Whatever identifier the document prints for ITSELF, under whichever name
  // the purchaser's portal uses for it (Statement No., Document ID, Voucher,
  // Remittance Advice No.). Described for the model in `revenue-statement.md`;
  // the label varies per purchaser and the field does not.
  statementNo: z.string(),
  // The payment's check / ACH number, which is a different thing from the
  // settlement document's number and is frequently printed alongside it.
  // Defaulted rather than required: it is genuinely absent on plenty of
  // statements, and an extraction is not worth discarding over a missing one.
  checkNo: z.string().default(""),
  periodStart: z.string(),
  periodEnd: z.string(),
  product: z.enum(["oil", "gas", "mixed"]),
  // The document's OWN printed net total, transcribed — never computed. Summing
  // the lines here would make the `total-mismatch` check in `checks.ts` compare
  // a number against itself, which is worse than not checking at all.
  printedNetTotal: z.number().nullable(),
  raw: z.record(z.string(), z.unknown()),
  lineItems: z.array(lineSchema),
});

/**
 * The full extraction result. Named and exported so a test can assert it against
 * the prompt's own contract — a schema/prompt mismatch here silently discards a
 * correct extraction.
 */
export const extractionSchemaForTest = z.object({
  extractionReasoning: z.string(),
  statements: z.array(statementSchema),
});

/** A settlement line with its printed refs resolved to real ids (null = unmatched). */
export type ExtractedLine = z.infer<typeof lineSchema> & {
  leaseId: string | null;
  /**
   * The printed lease name folds to two different leases on file, so no match
   * was made. The review grid says so instead of offering to create a third.
   */
  leaseAmbiguous?: boolean;
  tankId: string | null;
  meterId: string | null;
};

/** A drafted statement ready for the review step (nothing is persisted here). */
export interface ExtractedStatement {
  purchaser: string;
  /**
   * Remittance / owner-relations contact printed on the statement, or "".
   *
   * OPTIONAL on the type, not on the extraction: every caller that CHECKS or
   * REVIEWS a statement (`checkStatements`, the review editor) builds this
   * shape from what is on screen, and none of them carries a contact. Requiring
   * it there would mean three call sites inventing empty strings to satisfy a
   * field none of them uses.
   */
  purchaserPhone?: string;
  purchaserEmail?: string;
  purchaserContact?: string;
  statementNo: string;
  /** The check / ACH number the statement was paid under, or "" if not printed. */
  checkNo: string;
  periodStart: string;
  periodEnd: string;
  product: "oil" | "gas" | "mixed";
  /** The total the document itself printed, or null when it prints none. */
  printedNetTotal: number | null;
  raw: Record<string, unknown>;
  lineItems: ExtractedLine[];
}

/**
 * Two-stage read: transcribe the document to Markdown ONCE (chunked and run in
 * parallel for a multi-page PDF), then extract structured statements from that
 * text. `off` restores the pre-P2 behaviour — the raw document goes straight to
 * the extractor in a single call.
 *
 * Kept as a switch for one release so a regression found in production is a
 * restart rather than a revert. Both branches must produce the same
 * `ExtractedStatement[]`, so the fixture comparison is a config change and not a
 * code change. Delete the flag and the single-call branch once the comparison
 * has held in production — two live paths is how behaviour drifts.
 */
const TWO_STAGE = process.env.STATEMENT_TWO_STAGE !== "off";

/** How many analyze ⇄ validate rounds an extraction gets before we ship it.
 *
 * Two, not three (the ingest pipeline's `MAX_VALIDATION_PASSES`): here every
 * statement reaches a human review screen with an editable line-item table, so
 * the validator is a quality pass and not the last line of defence. A third
 * round buys less than it does on the ingest side, where a proposal can be
 * approved with one click. */
const MAX_STATEMENT_VALIDATION_PASSES = 2;

/** Rendered into the skill so the model knows a guessed figure will be caught. */
function tolerancesBlock(): string {
  return [
    `- Line net must equal gross − deducts − taxes (− fees on gas) within $${NET_TOLERANCE_USD.toFixed(2)}.`,
    `- Volume × price must reproduce gross within ${(PRICE_TOLERANCE_RATIO * 100).toFixed(0)}% of gross.`,
    `- The sum of line nets must reproduce \`printedNetTotal\` within $${TOTAL_TOLERANCE_USD.toFixed(2)}.`,
  ].join("\n");
}

/**
 * The extraction prompt. Lives in `skills/revenue-statement.md` rather than in
 * this file so it can be edited without a code change — and so it sits beside
 * `oil-run-statement.md` and `gas-settlement-statement.md`, which describe the
 * same paper for the ingest pipeline. Three prompts for one document type will
 * drift if they live in three different formats; keeping them in one directory
 * is the cheapest defence.
 *
 * `FIELD_SPEC` is deliberately NOT a token: the field list is prose in the skill
 * and the Zod schema is the contract, and `extract-schema.test.ts` asserts the
 * two agree.
 */
function buildSystemPrompt(overText: boolean): string {
  return loadSkill("revenue-statement", {
    SOURCE_NOTE: overText
      ? [
          "Below is a faithful Markdown transcription of a document's pages, in",
          "page order. Tables are reproduced with their column headers. A line",
          "reading `[adjacent page partially visible - not transcribed]` marks a",
          "neighbouring page that was deliberately excluded — never treat it as",
          "data, or as evidence that a statement exists. A value rendered `[?]`",
          "was not legible on the page: treat it as absent (blank or null), never",
          "guess at it, and never carry a neighbouring value into its place.",
        ].join(" ")
      : "The attached document is the source.",
    TOLERANCES: tolerancesBlock(),
  });
}

/**
 * Extract purchaser settlement statements from one already-loaded document, and
 * resolve each line's printed lease/tank/meter refs to real ids. Pure of I/O
 * beyond the model call + the RLS-scoped entity reads for matching — the caller
 * owns fetching the bytes and building `documentPart` (from the Statements-page
 * upload bucket, or from a company file for the chat tool) and any permission
 * gate. Nothing is persisted; the returned drafts feed the review step.
 *
 * Never throws for a document-level problem: every failure resolves to a
 * `status` the caller can turn into specific user copy. A thrown error here
 * means the process is broken, not the document.
 */
export async function extractStatementsFromDocument(
  sb: Sb,
  documentPart: ContentPart
): Promise<{
  statements: ExtractedStatement[];
  status: StatementScanStatus;
  warnings: StatementWarning[];
  /** The Stage-1 transcript ("" on failure) — reused by the cross-domain
   *  backfill pass so the document is never transcribed twice. */
  text: string;
}> {
  const startedAt = Date.now();
  ilog("statements: begin", describePart(documentPart));

  // Load the org's matchable entities so lines can be resolved to real ids,
  // plus the refs it has already resolved by hand (the alias rung).
  const [leases, tanks, meters, aliasRows] = await Promise.all([
    listLeases(sb),
    listTanks(sb),
    listMeters(sb),
    listLeaseAliases(sb).catch((err) => {
      // History is a bonus rung, never a reason an upload fails to read.
      ierr("statements: lease aliases unavailable", errorInfo(err));
      return [] as { leaseRef: string; leaseId: string }[];
    }),
  ]);
  const leaseTargets: MatchTarget[] = leases.map((l) => ({
    id: l.id,
    number: l.leaseNo,
    name: l.name,
  }));
  const tankTargets: MatchTarget[] = tanks.map((t) => ({
    id: t.id,
    number: t.tankNo,
    name: t.name,
  }));
  const meterTargets: MatchTarget[] = meters.map((m) => ({
    id: m.id,
    number: m.meterNo,
    name: m.name,
  }));
  /*
   * The device a line settles knows its own lease, and that beats anything the
   * lease column prints (docs/plans/statement-lease-matching.md, phase 1).
   *
   * A gas line naming meter 123 settles meter 123's lease even when the paper
   * spells it "JOHNSON #2" and the lease on file is "Johnson 2". Without this
   * rung the line saved unmatched and the upload proposed creating a lease the
   * org already had. `Tank.leaseId` resolves battery-first, which is the same
   * effective lease the production tier filters on, so both agree on which
   * lease a point is on.
   */
  const leaseByPoint = new Map<string, string>();
  for (const t of tanks) if (t.leaseId) leaseByPoint.set(t.id, t.leaseId);
  for (const m of meters) if (m.leaseId) leaseByPoint.set(m.id, m.leaseId);
  const aliases = buildLeaseAliases(aliasRows);
  const leaseCtx = { leases: leaseTargets, leaseByPoint, aliases };

  /**
   * One line's identity: its measurement point first, then its lease THROUGH
   * that point. `leaseAmbiguous` is carried for the review grid, which shows the
   * reviewer that the name names two leases rather than silently offering to
   * create a third.
   */
  const resolveLine = (l: {
    leaseRef: string;
    tankRef: string;
    meterRef: string;
    product: "oil" | "gas";
  }) => {
    const tankId =
      l.product === "gas" ? null : matchByNumber(l.tankRef, tankTargets);
    const meterId =
      l.product === "gas" ? matchByNumber(l.meterRef, meterTargets) : null;
    const lease = resolveLeaseId(
      { leaseId: null, leaseRef: l.leaseRef, pointId: tankId ?? meterId },
      leaseCtx
    );
    return {
      leaseId: lease.leaseId,
      leaseAmbiguous: lease.ambiguous,
      tankId,
      meterId,
    };
  };

  /** Resolve printed identifiers to real ids (blank stays unmatched). */
  const resolve = (raw: RawStatements): ExtractedStatement[] =>
    raw.map((s) => ({
      purchaser: s.purchaser,
      purchaserPhone: s.purchaserPhone,
      purchaserEmail: s.purchaserEmail,
      purchaserContact: s.purchaserContact,
      statementNo: s.statementNo,
      checkNo: s.checkNo,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      product: s.product,
      printedNetTotal: s.printedNetTotal,
      raw: s.raw,
      lineItems: s.lineItems.map((l) => ({
        ...l,
        // GAS: the price column is $/MCF, and no gas settlement prints one.
        // Whatever the model put there came off a page that was pricing
        // something else — residue gas per MMBtu, NGLs per gallon — so it is
        // moved to `raw` as evidence and the price is derived from this line's
        // own net and volume. Oil keeps the price the purchaser printed, which
        // is already per barrel.
        price: gasLinePrice(l),
        raw:
          l.product === "gas" && l.price != null
            ? { ...l.raw, printedPrice: l.price }
            : l.raw,
        ...resolveLine(l),
      })),
    }));

  // --- Stage 1 — READ ----------------------------------------------------
  // Transcribe to Markdown once. A multi-page PDF is split into 3-page chunks
  // transcribed in parallel, each with its own output ceiling and timeout, and a
  // chunk that fails costs only its own pages. That is what stops a long
  // purchaser packet from losing everything to one stuck call. A csv/xlsx/docx
  // part is already text and passes through with NO model call at all.
  let documentText = "";
  if (TWO_STAGE) {
    const readStart = Date.now();
    try {
      const read = await transcribeDocument(documentPart, {
        onProgress: (chars) =>
          ilog("statements: read streaming", {
            chars,
            ms: Date.now() - readStart,
          }),
      });
      // `TranscriptionUsage` carries `model`, so the read is priced at the
      // Sonnet rate instead of `meterAnthropic`'s Opus 5 fallback.
      void meterAnthropic(read.usage, "statements:read", sb);
      documentText = read.text;
      ilog("statements: read done", {
        ms: Date.now() - readStart,
        chars: documentText.length,
        pages: read.pages?.length ?? null,
        markersOk: read.pagesTrusted,
      });
    } catch (err) {
      // `transcribeDocument` throws only when EVERY chunk failed. That is "we
      // could not reach the model", not "the document is unreadable".
      ierr("statements: read FAILED", {
        ms: Date.now() - readStart,
        ...errorInfo(err),
      });
      return { statements: [], status: "error", warnings: [], text: "" };
    }
    if (!documentText.trim()) {
      ilog("statements: empty transcription -> unreadable");
      return { statements: [], status: "unreadable", warnings: [], text: "" };
    }
  }

  // --- Stage 2 — EXTRACT -------------------------------------------------
  const first = await extractInOnePassOrSplit(sb, documentPart, documentText);
  if (!first) {
    return { statements: [], status: "error", warnings: [], text: documentText };
  }

  let statements = resolve(first);
  let warnings = checkStatements(statements);
  logChecks(statements, warnings);

  // --- Stage 3 — VALIDATE ⇄ RE-EXTRACT -----------------------------------
  // Only pays for itself when there is something to correct. A clean extraction
  // with no deterministic findings skips the loop entirely, which is the common
  // case and keeps the median upload at two calls rather than four.
  if (TWO_STAGE && statements.length > 0) {
    for (let attempt = 1; attempt <= MAX_STATEMENT_VALIDATION_PASSES; attempt++) {
      const verdict = await validateStatements(
        sb,
        documentText,
        statements,
        warnings
      );
      ilog("statements: validate verdict", {
        attempt,
        ok: verdict.ok,
        issues: verdict.issues,
      });
      if (verdict.ok) break;
      if (attempt >= MAX_STATEMENT_VALIDATION_PASSES) {
        ierr("statements: validate unresolved after max passes, sending to review", {
          issues: verdict.issues,
        });
        break;
      }
      const fixed = await runExtraction(
        sb,
        documentPart,
        documentText,
        verdict.issues
      );
      // A failed correction round must never lose a good extraction — keep what
      // we already have and send it to review.
      if (!fixed) break;
      const merged = mergeCorrection(statements, resolve(fixed));
      statements = merged;
      warnings = checkStatements(statements);
      logChecks(statements, warnings);
    }
  }

  // The single best proxy for extraction quality on this document type, and it
  // costs nothing — the matching already ran. A rising unmatched rate means the
  // model is misreading printed refs, or the org's entities have drifted.
  const allLines = statements.flatMap((s) => s.lineItems);
  ilog("statements: matched", {
    lines: allLines.length,
    leaseMatched: allLines.filter((l) => l.leaseId).length,
    tankMatched: allLines.filter((l) => l.tankId).length,
    meterMatched: allLines.filter((l) => l.meterId).length,
  });

  const status: StatementScanStatus =
    statements.length > 0 ? "statements" : "no_statements";
  ilog("statements: done", {
    ms: Date.now() - startedAt,
    status,
    statements: statements.length,
    warnings: warnings.length,
  });
  return { statements, status, warnings, text: documentText };
}

/** The model's raw reply shape, before refs are resolved to ids. */
type RawStatements = z.infer<typeof extractionSchemaForTest>["statements"];

function logChecks(
  statements: ExtractedStatement[],
  warnings: StatementWarning[]
): void {
  if (warnings.length === 0) return;
  ilog("statements: arithmetic", {
    checked: statements.length,
    mismatches: warnings.length,
    codes: [...new Set(warnings.map((w) => w.code))],
  });
}

/**
 * Below this many pages, index-then-fan-out costs more than it saves.
 *
 * The index is a call of its own, so on a document holding ONE statement it is
 * pure overhead — and a monthly upload usually is one statement. A packet big
 * enough to hold several is big enough that the extraction dominates, which is
 * where splitting it pays. Page count is the only signal available before
 * spending anything.
 */
const INDEX_MIN_PAGES = 4;

/** Statements extracted at once. Their outputs are large; three keeps the fan-out
 *  from queueing behind one slow statement without flooding the provider. */
const STATEMENT_CONCURRENCY = 3;

const statementIndexSchema = z.object({
  statements: z
    .array(
      z.object({
        purchaser: z.string().default(""),
        statementNo: z.string().default(""),
        firstPage: z.number().int(),
        lastPage: z.number().int(),
      })
    )
    .default([]),
});

const INDEX_SYSTEM = [
  "You are indexing a packet of PURCHASER SETTLEMENT STATEMENTS sent to an oil &",
  "gas operator. The packet may hold SEVERAL separate statements — different",
  "purchasers, different periods, or oil and gas settled separately — each",
  "possibly spanning many pages.",
  "",
  "List every statement and the page range it occupies. Pages are marked '# Page N'.",
  "",
  "A new statement begins where a new PURCHASER, PERIOD or COMMODITY header block",
  "appears. A page that CONTINUES a statement — more property rows, a tax detail",
  "page, a remittance summary — belongs to the statement it follows, so include it",
  "in ITS range. Every page should fall inside exactly one range.",
  "",
  "ONE statement covering twenty properties is ONE statement, not twenty. The",
  "properties are its LINES. Split only where the document itself starts over.",
  "",
  "Extract NOTHING else: no volumes, no values, no line items. Page ranges only.",
].join("\n");

/**
 * Which statements this packet holds, and where each one is.
 *
 * One cheap call: whole document in, a few lines out. Returns an empty list on
 * any failure, which the caller reads as "extract it whole" — the fan-out is an
 * optimisation and must never be the reason a readable document comes back
 * empty.
 */
async function runStatementIndex(
  sb: Sb,
  markdown: string
): Promise<z.infer<typeof statementIndexSchema>["statements"]> {
  const at = Date.now();
  try {
    const { object, usage } = await generateObject({
      model: scanModel(),
      providerOptions: scanProviderOptions(),
      abortSignal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
      maxOutputTokens: 2000,
      maxRetries: 1,
      schema: statementIndexSchema,
      system: INDEX_SYSTEM,
      messages: [{ role: "user", content: markdown }],
    });
    void meterAnthropic(
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: SCAN_MODEL_ID,
      },
      "statements:index",
      sb
    );
    ilog("statements: indexed", {
      ms: Date.now() - at,
      statements: object.statements.length,
      found: object.statements.map(
        (x) => `${x.purchaser || x.statementNo || "?"}@${x.firstPage}-${x.lastPage}`
      ),
    });
    return object.statements;
  } catch (err) {
    ierr("statements: index FAILED, extracting whole", {
      ms: Date.now() - at,
      ...errorInfo(err),
    });
    return [];
  }
}

/** Hard ceiling on the index call — a page-range listing, not extraction. */
const INDEX_TIMEOUT_MS = 90_000;

/**
 * Stage 2, whole or split.
 *
 * A multi-statement packet is extracted one statement at a time, in parallel,
 * each call seeing only its own pages: the wall clock becomes the slowest single
 * statement instead of the sum of all of them, and every output is small enough
 * to finish rather than truncating at the ceiling. The same shape the invoice
 * reader uses on a packet of invoices, and for the same reason.
 *
 * Everything else — a short document, an index that found one statement or
 * none, a packet with no page markers — takes the single call it always did.
 */
async function extractInOnePassOrSplit(
  sb: Sb,
  documentPart: ContentPart,
  documentText: string
): Promise<RawStatements | null> {
  const pages = splitTranscriptPages(documentText);
  if (pages.size < INDEX_MIN_PAGES) {
    return runExtraction(sb, documentPart, documentText);
  }

  const index = await runStatementIndex(sb, documentText);
  if (index.length <= 1) return runExtraction(sb, documentPart, documentText);

  const slices = index
    .map((hit) => ({
      hit,
      text: transcriptPageRange(pages, hit.firstPage, hit.lastPage),
    }))
    // An index entry whose pages are missing would send an empty prompt and
    // come back as a hallucinated statement.
    .filter((s) => s.text.trim().length > 0);
  if (slices.length <= 1) return runExtraction(sb, documentPart, documentText);

  ilog("statements: extracting per statement", { slices: slices.length });
  const parts = await mapWithLimit(
    slices,
    STATEMENT_CONCURRENCY,
    (slice: { text: string }) => runExtraction(sb, documentPart, slice.text)
  );

  const statements = parts.flatMap((r) => r ?? []);
  if (statements.length === 0) {
    // Every slice failed. Falling back to the whole-document call is better
    // than reporting an empty read on a document we know holds statements.
    ierr("statements: every slice failed, extracting whole");
    return runExtraction(sb, documentPart, documentText);
  }
  return statements;
}

/**
 * One structured-extraction call, over the transcription when we have one and
 * over the raw document otherwise. Returns null on any failure — a timeout, an
 * output-ceiling truncation, or a schema mismatch are all document-level
 * problems the caller turns into a status rather than a throw.
 *
 * `feedback` is the validator's issue list on a correction round; passing it
 * shows the model what it got wrong rather than asking it to re-read blind.
 */
async function runExtraction(
  sb: Sb,
  documentPart: ContentPart,
  documentText: string,
  feedback?: string[]
): Promise<RawStatements | null> {
  const overText = documentText.length > 0;
  const started = Date.now();
  const instruction = feedback?.length
    ? [
        "Extract every purchaser settlement statement in this document.",
        "",
        "A reviewer audited your previous answer against the source and found",
        "these problems. Correct them. Keep everything else exactly as it was —",
        "do not drop a statement or a line that was not mentioned.",
        ...feedback.map((i) => `- ${i}`),
      ].join("\n")
    : "Extract every purchaser settlement statement in this document.";

  try {
    const result = await generateObject({
      model: scanModel(),
      providerOptions: scanProviderOptions(),
      // Generous ceiling: an upload can bundle several statements with many
      // lines; the default provider cap (~4096) truncates the JSON and throws.
      maxOutputTokens: 24000,
      // `extractionReasoning` is first so the model commits to how many
      // statements it found before emitting them — consumed for its effect.
      schema: extractionSchemaForTest,
      // A correct extraction wrapped in `{"parameters": {...}}` must not cost the
      // user the upload. Runs only after validation has already failed.
      experimental_repairText: async ({ text }) => {
        const unwrapped = unwrapToolEnvelope(text, [
          "extractionReasoning",
          "statements",
        ]);
        if (unwrapped) ilog("statements: repaired a tool-call envelope");
        return unwrapped;
      },
      system: buildSystemPrompt(overText),
      messages: [
        {
          role: "user",
          content: overText
            ? [{ type: "text" as const, text: `${instruction}\n\n${documentText}` }]
            : [{ type: "text" as const, text: instruction }, documentPart],
        },
      ],
    });
    void meterAnthropic(
      {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: SCAN_MODEL_ID,
      },
      "statements:extract",
      sb
    );
    ilog("statements: extract done", {
      ms: Date.now() - started,
      overText,
      correction: Boolean(feedback?.length),
      statements: result.object.statements.length,
      lines: result.object.statements.reduce((n, s) => n + s.lineItems.length, 0),
      outputTokens: result.usage.outputTokens,
    });
    return result.object.statements;
  } catch (err) {
    ierr("statements: extract FAILED", {
      ms: Date.now() - started,
      overText,
      correction: Boolean(feedback?.length),
      ...errorInfo(err),
    });
    return null;
  }
}

const verdictSchema = z.object({
  ok: z.boolean(),
  issues: z.array(z.string()).default([]),
});

export interface StatementVerdict {
  ok: boolean;
  issues: string[];
}

/**
 * Audit an extraction against the transcription it came from.
 *
 * FAILS OPEN, twice over: a call that throws and a reply that does not parse
 * both return `ok: true`. Analysis has already produced rows and the human
 * review step is the real gate here, so the right outcome when the auditor
 * itself breaks is to ship what we have — never to throw away a good extraction
 * and report nothing found. (`dedicated-flow.ts` learned this the same way.)
 */
async function validateStatements(
  sb: Sb,
  documentText: string,
  statements: ExtractedStatement[],
  warnings: StatementWarning[]
): Promise<StatementVerdict> {
  const started = Date.now();
  const known =
    warnings.length > 0
      ? warnings
          .map(
            (w) =>
              `- Statement ${w.statement + 1}${w.line === null ? "" : `, line ${w.line + 1}`}: ${w.message}`
          )
          .join("\n")
      : "(none — the arithmetic closes)";

  try {
    const { text, usage } = await streamAgentJson({
      label: "statements:validate",
      system: loadSkill("revenue-statement-validate", { WARNINGS: known }),
      user: [
        "SOURCE DOCUMENT",
        documentText,
        "",
        "EXTRACTION TO AUDIT",
        JSON.stringify({ statements }, null, 2),
      ].join("\n"),
      maxOutputTokens: 4000,
      timeoutMs: 90_000,
      // Auditing a structured reply against text it can see. The judgement is
      // comparison, not open-ended reasoning.
      effort: "low",
    });
    void meterAnthropic(usage, "statements:validate", sb);
    const parsed = verdictSchema.safeParse(JSON.parse(isolateJson(text)));
    if (!parsed.success) {
      ierr("statements: validate reply failed schema, treating as clean", {
        ms: Date.now() - started,
        issues: parsed.error.issues.map((i) => i.message).slice(0, 3),
      });
      return { ok: true, issues: [] };
    }
    return parsed.data;
  } catch (err) {
    ierr("statements: validate FAILED, shipping unvalidated", {
      ms: Date.now() - started,
      ...errorInfo(err),
    });
    return { ok: true, issues: [] };
  }
}

/**
 * Fold a correction round back into the prior extraction.
 *
 * Keyed on purchaser + statement number + period (the same identity
 * `stmtKey` uses for duplicate detection), so a correction REPLACES the
 * statement it corrects but can never silently delete one it did not mention.
 * A fix pass that returns three statements where the first pass found four must
 * not cost the user a statement.
 */
export function mergeCorrection(
  prior: ExtractedStatement[],
  fixed: ExtractedStatement[]
): ExtractedStatement[] {
  const key = (s: ExtractedStatement) =>
    `${s.purchaser.trim().toLowerCase()}|${s.statementNo.trim().toLowerCase()}|${s.periodStart}|${s.periodEnd}`;
  const byKey = new Map(fixed.map((s) => [key(s), s]));
  const out = prior.map((s) => byKey.get(key(s)) ?? s);
  const seen = new Set(prior.map(key));
  // A correction that found a statement the first pass missed is a real fix.
  for (const s of fixed) if (!seen.has(key(s))) out.push(s);
  return out;
}
