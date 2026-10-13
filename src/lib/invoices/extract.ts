import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { meterAnthropic } from "@/lib/billing/credits";
import {
  transcribeDocument,
  splitTranscriptPages,
  transcriptPageRange,
} from "@/lib/ai/read-document";
import { buildDocumentPart } from "@/lib/ai/document-part";
import { SCAN_MODEL_ID, scanModel } from "@/lib/ai/scan-model";
import { ilog } from "@/lib/ai/ingest/log";
import {
  classifyTaxLabel,
  type VendorInvoiceDraft,
  type VendorInvoiceLine,
} from "@/lib/ai/ingest/vendor-invoice";

/**
 * Read vendor invoices out of a document. Three steps, and no more:
 *
 *   1. PDF -> markdown (`transcribeDocument`).
 *   2. markdown -> JSON, via structured-output calls.
 *   3. hand the JSON back for review.
 *
 * WHY THIS EXISTS SEPARATELY from the generic ingest pipeline. That pipeline is
 * built for documents whose destinations are unknown, so it categorizes, fans
 * out to several record types, and runs an analyze/validate loop. Routing
 * invoices through it meant a FLAT row grid that a nested document had to be
 * flattened into and folded back out of by hand, a free-text JSON envelope the
 * model had to guess at, a categorize call to decide something the user already
 * told us by uploading on the Invoices page, and up to three analyze+validate
 * rounds that timed out at 180s. `generateObject` removes that whole class: the
 * SDK constrains the reply to the schema, so there is no envelope to miss and
 * the nested structure the document has is the structure the model emits.
 *
 * WHY STEP 2 IS TWO PASSES AND NOT ONE. A real packet is not one invoice. The
 * first one tested here was 23 scanned pages holding TEN invoices, and asking
 * for all of them in a single call fails for a reason no amount of prompting
 * fixes: the answer does not fit. That call died at exactly 4096 output tokens
 * with `finishReason: "length"`, and the SDK's repair turned the truncated JSON
 * into `{}` — a total loss dressed up as "nothing found".
 *
 * Raising the ceiling alone does not fix it either, because ~20k tokens of JSON
 * generated serially is minutes of wall clock. So:
 *
 *   pass A — INDEX. One cheap call: which invoices are in here, and on which
 *            pages. Whole document in, a few lines out, seconds.
 *   pass B — EXTRACT. One call PER INVOICE, in parallel, each seeing only its
 *            own pages. Every output is small enough to finish, and wall clock
 *            is the slowest single invoice instead of the sum of all of them.
 *
 * This is the same shape the reader already uses to transcribe pages, and it
 * means no invoice is ever assembled from fragments: pass B extracts each one
 * whole, so there is no merge step to get wrong.
 */

const lineSchema = z.object({
  description: z
    .string()
    .describe(
      "the charge description VERBATIM, including sizes, depths and intervals"
    ),
  chargeType: z
    .enum(["Labor", "Materials", "Equipment", "Other"])
    .describe(
      "which of the four buckets this is. Use Other for mileage, surcharges, standby, disposal — anything that is not plainly labor, materials or equipment"
    ),
  chargeSubtype: z
    .string()
    .describe(
      "the vendor's own word for the charge when it is more specific than chargeType (mileage, standby, rental, disposal); else \"\""
    ),
  quantity: z.number().nullable(),
  uom: z.string().describe("unit of measure as printed (hr, ea, bbl, mi); else \"\""),
  unitPrice: z.number().nullable().describe("rate per unit; null if not printed"),
  noCharge: z
    .boolean()
    .describe("true only when the line reads 'No Charge' or 'N/C' where a price belongs"),
  amount: z.number().nullable().describe("extended amount for the line"),
  serviceStart: z.string().describe("ISO YYYY-MM-DD the work was done; else \"\""),
  serviceEnd: z.string().describe("ISO YYYY-MM-DD if a range; else \"\""),
  taxable: z
    .enum(["yes", "no", "unknown"])
    .describe(
      "'yes' only when the line carries a printed taxable marker (a trailing T, an X in a tax column). Never inferred from the kind of service"
    ),
  afeNumber: z.string(),
  costCenter: z.string(),
  glCode: z.string(),
  ticketNo: z.string(),
  poNumber: z.string(),
});

const invoiceSchema = z.object({
  vendor: z.string().describe("the company that SENT the invoice"),
  invoiceNo: z
    .string()
    .describe("the vendor's invoice number as printed; \"\" if the document has none"),
  invoiceDate: z.string().describe("ISO YYYY-MM-DD"),
  dueDate: z.string().describe("ISO YYYY-MM-DD; else \"\""),
  paymentTerms: z.string().describe("e.g. 'Net 30'; else \"\""),
  documentKind: z
    .enum(["invoice", "field_ticket"])
    .describe("field_ticket only when the document IS a signed field/service ticket"),
  propertyRef: z
    .string()
    .describe(
      "the lease / well / facility the work was done on, VERBATIM as printed (e.g. 'Repass #2'). Do not normalize it"
    ),
  county: z.string(),
  rrcDistrict: z.string().describe("Texas RRC district as printed (e.g. '7B'); else \"\""),
  subtotal: z.number().nullable().describe("pre-tax subtotal as printed"),
  taxPrinted: z.number().nullable().describe("the single tax total as printed"),
  taxLabelRaw: z
    .string()
    .describe(
      "the tax line's label copied VERBATIM, e.g. 'Sales Tax (2.42%)'. Copy it even when it looks wrong — vendors mislabel the Texas well-servicing tax and recording the label is how that is found"
    ),
  invoiceTotal: z.number().nullable(),
  lines: z.array(lineSchema).describe("one entry per priced charge line, in printed order"),
});

/** One invoice as read off the page. Nested, exactly as the document is. */
export type ExtractedInvoice = z.infer<typeof invoiceSchema>;
export type ExtractedLine = z.infer<typeof lineSchema>;

/** Pass A's answer: where each invoice lives, so pass B can be handed just it. */
const indexSchema = z.object({
  invoices: z
    .array(
      z.object({
        invoiceNo: z
          .string()
          .describe("the invoice or ticket number as printed; \"\" if it has none"),
        vendor: z.string().describe("the company that SENT it"),
        kind: z
          .enum(["invoice", "supporting"])
          .describe(
            "'invoice' when this document is itself a bill that must be PAID. 'supporting' when it is backup for the invoice above it — a job ticket, work order, pump chart, scale ticket or signed field ticket whose charges are ALREADY included in that invoice's total"
          ),
        firstPage: z.number().int().describe("the '# Page N' the invoice starts on"),
        lastPage: z
          .number()
          .int()
          .describe(
            "the '# Page N' it ends on, INCLUDING its continuation, job-detail and signature pages"
          ),
      })
    )
    .describe("every distinct invoice or field ticket in the document, in page order"),
});

const INDEX_SYSTEM = [
  "You are indexing a packet of VENDOR INVOICES: service companies billing an",
  "oil & gas operator. The packet holds SEVERAL separate invoices, each with its",
  "own invoice number, and each possibly spanning several pages.",
  "",
  "List every invoice and the page range it occupies. Pages are marked '# Page N'.",
  "",
  "A new invoice begins where a new invoice NUMBER and header block appear. Pages",
  "that CONTINUE an invoice — job logs, daily descriptions, pump charts, signature",
  "pages, attachments — belong to the invoice they follow, so include them in ITS",
  "range. Every page of the document should fall inside exactly one range.",
  "",
  "CRITICAL — TELL A BILL FROM ITS BACKUP. Operators staple the field tickets",
  "behind the invoice that bills them. A ticket has its own number and its own",
  "total, so it LOOKS like a separate document, but its charges are already on",
  "the invoice and marking it 'invoice' bills the operator twice for the same",
  "work. Before you call something an invoice, check whether the invoice above it",
  "already covers the same vendor, dates and amounts; if it does, it is",
  "'supporting'. A ticket that no invoice in this packet covers IS payable, so",
  "when nothing above it accounts for the charges, call it an invoice.",
  "",
  "Do not extract charge lines here. Only the number, the vendor, and the pages.",
].join("\n");

const EXTRACT_SYSTEM = [
  "You are reading ONE VENDOR INVOICE or signed FIELD TICKET: a service company",
  "billing an oil & gas operator for work on a well, lease or facility. Money",
  "going OUT. Convert it to the JSON structure you have been given.",
  "",
  "The text you are given is the pages of a SINGLE invoice, which may include its",
  "job-detail or signature pages. Everything you emit describes that one invoice.",
  "",
  "Copy descriptions VERBATIM, including sizes, depths and intervals — the",
  "wording decides how a line is taxed in Texas, so a paraphrase destroys it.",
  "Copy the property reference verbatim too; do not tidy or expand it.",
  "",
  "Do not emit a line for a subtotal, a tax line, or the grand total: those are",
  "invoice-level fields. A 'No Charge' line IS a line — set noCharge and leave",
  "the price and amount null. A narrative job log is not a charge line.",
  "",
  "The charge lines are the ones ON THE INVOICE. Its backup pages — job tickets,",
  "work orders, scale tickets — RESTATE those same charges in their own table.",
  "Emitting them again would bill the same work twice, so read them for detail",
  "and take the charge lines only from the invoice itself. Use them to fill in a",
  "line's service date, ticket number or well when the invoice omits it.",
  "",
  "Transcribe tax, never compute it. taxPrinted is the figure on the page and",
  "taxLabelRaw is its label copied exactly. Never allocate tax across lines.",
  "",
  "A value the document does not state is \"\" for text and null for numbers.",
  "Never invent a number, a date, or an invoice number.",
].join("\n");

/** Hard ceiling per model call. Each call handles one invoice, not a packet. */
const TIMEOUT_MS = 120_000;

/**
 * Provider settings both passes share.
 *
 * The model itself comes from `scanModel()` — the same control point every
 * other scan surface uses — so a `SCAN_PROVIDER` / `SCAN_MODEL_ID` switch
 * reaches invoices too. These options are keyed to the anthropic provider and
 * are simply ignored when another provider is selected. The `effort` here is
 * per-stage on purpose (copying fields out of markdown is bounded work) and is
 * NOT taken from the global `SCAN_EFFORT`.
 *
 * `structuredOutputMode: "outputFormat"` is NOT a preference — it is a
 * workaround for a real defect, and removing it brings back a bug that only
 * shows up on some documents.
 *
 * `@ai-sdk/anthropic@3` has a hardcoded capability table that predates the
 * Claude 5 family, so `claude-sonnet-5` matches nothing and falls through to
 * its unknown-model branch: `supportsStructuredOutput: false` and
 * `maxOutputTokens: 4096`. That single miss caused BOTH failures seen here.
 *
 *  - Without native structured output the provider instead exposes a tool
 *    literally named `json` and asks the model to call it. The model
 *    intermittently nests its answer one level deeper, under a "json" key, and
 *    the reply then fails schema validation. Observed on the same invoice
 *    twice running, and on another invoice one run in two — so a retry looks
 *    like a fix and is not. Forcing `outputFormat` sends the schema as a real
 *    `output_config.format`, where decoding is constrained and the shape cannot
 *    drift.
 *  - The 4096 default is why `maxOutputTokens` is set explicitly on every call
 *    below. It is not clamped for an unknown model, so an explicit value wins.
 *
 * The durable fix is upgrading the provider (4.x knows these models); until
 * then this keeps the behaviour correct without a major-version bump.
 */
const PROVIDER_OPTIONS = {
  anthropic: {
    // Copying fields out of markdown into a schema is bounded work. Unset would
    // deliberate at `high` and dominate the latency.
    effort: "low",
    structuredOutputMode: "outputFormat",
  },
} as const;

/** Output ceilings. Explicit because the provider's default here is 4096. */
const INDEX_MAX_TOKENS = 8_000;
const EXTRACT_MAX_TOKENS = 16_000;

/** Invoices extracted at once. Matches the reader's page fan-out. */
const MAX_CONCURRENCY = 6;

export interface InvoiceReadResult {
  invoices: ExtractedInvoice[];
  /** The transcript, kept so a bad read can be inspected without re-running. */
  markdown: string;
  msOcr: number;
  msExtract: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO date, or "" — a half-parsed date is worse than no date. */
function isoDate(v: string): string {
  const t = (v ?? "").trim();
  return ISO.test(t) ? t : "";
}

/** Map with a concurrency cap, preserving input order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return out;
}

/**
 * Split a transcript into its `# Page N` sections.
 *
 * Keyed by the page number the heading STATES rather than by position, because
 * that is what the index refers to. Exported for testing.
 */
export function splitPages(markdown: string): Map<number, string> {
  return splitTranscriptPages(markdown);
}

/** The text of pages `first..last`, in order. Missing pages are simply absent. */
function pageRange(pages: Map<number, string>, first: number, last: number): string {
  return transcriptPageRange(pages, first, last);
}

/** One invoice's JSON, from just its pages. */
async function extractOne(
  text: string,
  sb: SupabaseClient | undefined,
  label: string
): Promise<ExtractedInvoice | null> {
  const { object, usage, finishReason } = await generateObject({
    model: scanModel(),
    providerOptions: PROVIDER_OPTIONS,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    maxOutputTokens: EXTRACT_MAX_TOKENS,
    maxRetries: 1,
    schema: invoiceSchema,
    system: EXTRACT_SYSTEM,
    messages: [{ role: "user", content: text }],
  });
  if (sb)
    void meterAnthropic(
      { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: SCAN_MODEL_ID },
      "invoice:extract",
      sb
    );
  // Loud, not silent. A truncated invoice is a WRONG invoice — some of its
  // lines are simply gone — and it must never reach the review screen looking
  // complete. This is the failure that returned `{}` before the ceiling existed.
  if (finishReason === "length") {
    ilog("invoice: extract truncated — dropping", {
      label,
      outputTokens: usage.outputTokens,
    });
    return null;
  }
  return object;
}

/** Pass A: which invoices are in this transcript, and on which pages. */
async function runIndex(
  markdown: string,
  sb: SupabaseClient | undefined
): Promise<IndexEntry[]> {
  const at = Date.now();
  const { object, usage } = await generateObject({
    model: scanModel(),
    providerOptions: PROVIDER_OPTIONS,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    maxOutputTokens: INDEX_MAX_TOKENS,
    maxRetries: 1,
    schema: indexSchema,
    system: INDEX_SYSTEM,
    messages: [{ role: "user", content: markdown }],
  });
  if (sb)
    void meterAnthropic(
      { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: SCAN_MODEL_ID },
      "invoice:index",
      sb
    );
  ilog("invoice: indexed", {
    ms: Date.now() - at,
    invoices: object.invoices.length,
    found: object.invoices.map(
      (i) => `${i.invoiceNo}${i.kind === "supporting" ? "(sup)" : ""}@${i.firstPage}-${i.lastPage}`
    ),
  });
  return object.invoices;
}

/** One entry from the index pass. */
export interface IndexEntry {
  invoiceNo: string;
  vendor: string;
  kind: "invoice" | "supporting";
  firstPage: number;
  lastPage: number;
}

/**
 * Absorb each supporting document into the invoice it backs, so the packet
 * yields one payable per bill.
 *
 * THIS PREVENTS A DOUBLE PAYMENT. Operators staple field tickets behind the
 * invoice that bills them, and a ticket carries its own number and its own
 * total — J&F invoice 10020 in the sample packet totals $4,300 and is followed
 * by tickets 220 ($2,400) and 221 ($1,900), the very same work. Treated as three
 * documents that packet asks for $8,600 against $4,300 of actual charges.
 *
 * The ticket's pages are kept, folded into the invoice's range, because they
 * carry detail the invoice summarises (well number, job type, times on site).
 * Nothing is discarded; it is attributed.
 *
 * A supporting document with no invoice ahead of it is NOT dropped: a field
 * ticket that arrives on its own is a real payable, and silently swallowing it
 * would be the opposite error.
 *
 * Pure and exported so this is tested without a model call.
 */
export function foldSupporting(entries: IndexEntry[]): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (e.kind === "supporting" && prev) {
      prev.lastPage = Math.max(prev.lastPage, e.lastPage);
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

/**
 * Step 2 on its own: a transcript in, invoices out.
 *
 * Separated from the read so extraction can be tested and iterated against a
 * cached transcript rather than re-paying ~40s of reading for every attempt.
 */
export async function readInvoicesFromMarkdown(
  markdown: string,
  sb?: SupabaseClient
): Promise<ExtractedInvoice[]> {
  const pages = splitPages(markdown);

  // No page headings — a CSV, a text file, or a one-page read. Nothing to index
  // and nothing to fan out over, so extract it as a single invoice.
  if (pages.size === 0) {
    const one = await extractOne(markdown, sb, "whole document");
    return one ? [one] : [];
  }

  const index = { invoices: await runIndex(markdown, sb) };

  if (index.invoices.length === 0) return [];

  const billable = foldSupporting(index.invoices);
  if (billable.length !== index.invoices.length) {
    ilog("invoice: folded supporting tickets into their invoice", {
      from: index.invoices.length,
      to: billable.length,
    });
  }

  const results = await mapWithLimit(billable, MAX_CONCURRENCY, (hit) => {
    const text = pageRange(pages, hit.firstPage, hit.lastPage);
    // An index entry whose pages are missing would otherwise send an empty
    // prompt and come back as a hallucinated invoice.
    if (!text.trim()) return Promise.resolve(null);
    return extractOne(text, sb, hit.invoiceNo || hit.vendor);
  });

  return results.filter((r): r is ExtractedInvoice => r !== null);
}

/**
 * The document's bytes could not be turned into usable text. A TYPED error, so
 * the action layer can report `unreadable` — "try a clearer scan" — instead of
 * the generic failure line, which tells the user nothing about what to do.
 */
export class UnreadableDocumentError extends Error {}

/**
 * Read invoices out of a document's bytes.
 *
 * Throws with a specific message rather than returning empty when the READ
 * fails: "the document could not be turned into text" and "the text held no
 * invoice" are different problems, and only the first is worth re-uploading for.
 */
export async function readInvoices<T = never>(
  bytes: ArrayBuffer,
  fileName: string,
  sb?: SupabaseClient,
  opts?: {
    /**
     * A SECOND reading of the same document, started the moment the transcript
     * exists and awaited together with the invoice extraction.
     *
     * An invoice is two documents at once — a payable, and the field record of
     * the job it billed for — and both readings begin from this one transcript
     * (see `wellReadingOfInvoiceTranscript`). Run one after the other they cost
     * the sum; run from here they cost the slower of the two, and the review
     * screen the user is waiting for arrives no later than it does today.
     *
     * The transcription is the part that must not be repeated, which is why the
     * hook lives here rather than in the caller: there is exactly one read of
     * the bytes, whatever is done with the text.
     *
     * Its failures are its own. This function's contract is invoices, and a
     * bonus pass that throws must not turn a good read into a failed one.
     *
     * The in-flight extraction is handed over as a PROMISE, because a second
     * reading usually wants one thing out of it (which property was billed) and
     * only at the very end. Awaiting it there costs nothing; waiting for it
     * before starting would give back the serial cost this hook exists to avoid.
     */
    alongside?: (
      markdown: string,
      invoices: Promise<ExtractedInvoice[]>
    ) => Promise<T>;
  }
): Promise<InvoiceReadResult & { alongside: T | null }> {
  const ocrAt = Date.now();
  const part = await buildDocumentPart(fileName, Buffer.from(bytes));
  const read = await transcribeDocument(part);
  const markdown = read.text;
  const msOcr = Date.now() - ocrAt;
  if (markdown.trim().length < 40) {
    throw new UnreadableDocumentError(
      `readInvoices: the document read as ${markdown.length} characters — it could not be turned into text.`
    );
  }
  if (sb) void meterAnthropic(read.usage, "invoice:read", sb);

  const extractAt = Date.now();
  const extraction = readInvoicesFromMarkdown(markdown, sb);
  const [invoices, alongside] = await Promise.all([
    extraction,
    opts?.alongside
      ? opts.alongside(markdown, extraction).catch((err) => {
          ilog("invoice: alongside pass FAILED", { error: String(err) });
          return null;
        })
      : Promise.resolve(null),
  ]);
  const msExtract = Date.now() - extractAt;
  ilog("invoice: read done", {
    msOcr,
    msExtract,
    chars: markdown.length,
    invoices: invoices.length,
  });

  return { invoices, markdown, msOcr, msExtract, alongside };
}

/**
 * An extracted invoice as the storage layer wants it.
 *
 * `ExtractedInvoice` is what the DOCUMENT says; `VendorInvoiceDraft` adds the
 * few things we derive from that — whether the invoice number had to be minted,
 * and whether the vendor's tax label contradicts the work described. Converting
 * here rather than teaching the writer a second input shape keeps one write
 * path, so the reader and the ingest-approval flow cannot drift apart.
 */
export function toDraft(inv: ExtractedInvoice): VendorInvoiceDraft {
  const lines: VendorInvoiceLine[] = inv.lines.map((l, i) => ({
    lineNo: String(i + 1),
    description: l.description.trim(),
    chargeType: l.chargeType,
    chargeSubtype: l.chargeSubtype.trim(),
    quantity: l.quantity,
    uom: l.uom.trim(),
    // A "No Charge" line has no price, and 0 would read as a free line that was
    // priced rather than one the vendor declined to bill.
    unitPrice: l.noCharge ? null : l.unitPrice,
    noCharge: l.noCharge,
    amount: l.amount,
    serviceStart: isoDate(l.serviceStart),
    serviceEnd: isoDate(l.serviceEnd),
    // "unknown" must stay null: the invoice not saying is not the same as the
    // invoice saying no, and only one of those is safe to report as untaxed.
    taxable: l.taxable === "yes" ? true : l.taxable === "no" ? false : null,
    taxFlagRaw: "",
    afeNumber: l.afeNumber.trim(),
    costCenter: l.costCenter.trim(),
    glCode: l.glCode.trim(),
    ticketNo: l.ticketNo.trim(),
    workOrderNo: "",
    poNumber: l.poNumber.trim(),
    sourceText: "",
  }));

  const invoiceNo = inv.invoiceNo.trim();
  return {
    vendor: inv.vendor.trim(),
    invoiceNo,
    invoiceNoDerived: invoiceNo === "",
    invoiceDate: isoDate(inv.invoiceDate),
    dueDate: isoDate(inv.dueDate),
    paymentTerms: inv.paymentTerms.trim(),
    documentKind: inv.documentKind,
    propertyRef: inv.propertyRef.trim(),
    county: inv.county.trim(),
    rrcDistrict: inv.rrcDistrict.trim(),
    subtotal: inv.subtotal,
    taxPrinted: inv.taxPrinted,
    taxLabelRaw: inv.taxLabelRaw.trim(),
    taxLabelVerdict: classifyTaxLabel(inv.taxPrinted, inv.taxLabelRaw, lines),
    invoiceTotal: inv.invoiceTotal,
    lines,
  };
}
