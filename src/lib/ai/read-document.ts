import "server-only";

import { streamText } from "ai";
import { PDFDocument } from "pdf-lib";
import type { ContentPart } from "@/lib/ai/document-part";
import { SCAN_MODEL_ID, scanModel, scanProviderOptions } from "@/lib/ai/scan-model";
import { errorInfo, ierr, ilog } from "@/lib/ai/ingest/log";

/**
 * Stage 1 of document understanding: turn ONE document into plain Markdown text,
 * with maximum information preserved and NO knowledge of what the text is for.
 * This is the single, skill-agnostic "reader" — its only job is faithful
 * transcription. Downstream steps (a skill's extraction, search indexing, chat)
 * consume the text; none of them re-read the raw document.
 *
 * The model reads PDFs/images natively (accuracy-first — see the note in
 * `@/lib/ai/pdf`, which OCR alone was dropping dense tables from). A `text` part
 * (csv/txt/xlsx-flattened/docx) is already plain text and is returned as-is with
 * no model call. Callers own fetching bytes + building the `ContentPart`, and any
 * caching / metering / logging.
 *
 * A multi-page PDF is SPLIT into page-range chunks that transcribe in PARALLEL,
 * then stitched back in page order. A single call to OCR a whole dense scan (14
 * pages / 11 MB) blows the timeout and the output-token ceiling; per-chunk calls
 * each return fast, fit the ceiling, and the fan-out keeps wall-clock down.
 */

/** The transcription instruction. Exported so callers can reference/extend it. */
export const TRANSCRIBE_PROMPT = [
  "Transcribe this document to Markdown in full, page by page, in order.",
  "Reproduce EVERY page, including the dense ones: scanned forms, tables, and",
  "numeric grids. Keep all numbers, labels, dates, and headings VERBATIM. Do not",
  "summarise, reorder, interpret, or omit anything.",
  "PRESERVE LAYOUT — it carries meaning. Render every table as a Markdown table:",
  "keep the column header row, keep EVERY column, and emit exactly one table row",
  "per source row (never merge, split, or drop cells; use an empty cell for a",
  "blank). When a value labels the rows beneath it — a section title, a lease or",
  "property header, a 'Purchaser:'/'Remit to' block, a subtotal — put it on its",
  "OWN line immediately above those rows, so the grouping stays visible. Keep",
  "header/footer text (company names, addresses, phone, email, statement/check",
  "numbers) even when it sits outside the main table.",
  "For a page that is purely an image/figure with no readable text, write",
  "'[Figure: <one-line description>]'.",
  "ILLEGIBLE TEXT. When a character or figure is genuinely unreadable, transcribe",
  "it as '[?]' rather than guessing. Downstream steps read text only and cannot",
  "see the page, so a guessed digit arrives looking exactly as certain as one you",
  "read cleanly — the marker is the only way that doubt survives. Mark ONLY what",
  "you cannot read: never use '[?]' for a value the page simply does not print.",
  "ONE PAGE PER IMAGE. A photographed document often catches more than the page",
  "it is meant to capture: a desk, a hand, or — most often — the ADJACENT page of",
  "an open notebook or binder. Transcribe ONLY the single dominant, fully-visible",
  "page. Never transcribe text from a page that is cut off at the frame edge —",
  "not its headings, not its column labels, not its values, not even a partial",
  "word. When a neighbouring page is partially visible, emit the single line",
  "'[adjacent page partially visible - not transcribed]' and nothing else from",
  "it. A heading you can read but whose rows are off-frame is exactly this case:",
  "it belongs to the other page, so leave it out.",
  "PAGE MARKERS. Begin each page's transcription with a line containing exactly",
  "'<!-- page N -->', where N is that page's position in THIS document starting",
  "at 1. Emit the marker for EVERY page including blank ones (a blank page is its",
  "marker followed by nothing). Never emit a marker anywhere else, and never emit",
  "more or fewer markers than the document has pages.",
  "Output only the transcription.",
].join(" ");

/**
 * The page-heading format `TRANSCRIBE_PROMPT` mandates. Callers slice a
 * transcript back into pages with this, so it is exported rather than
 * re-guessed: a second copy of the pattern is a second thing to drift.
 */
export const PAGE_HEADING = /^# Page (\d+)\s*$/gm;

/**
 * Number a chunk's pages as they sit in the WHOLE document.
 *
 * Chunks are separate one-off PDFs, so without this every chunk starts over at
 * "# Page 1" and a 23-page document claims to have eight page ones. That breaks
 * any consumer that cites a page or slices the transcript by page, and it is
 * wrong on its face in chat and search results.
 */
function pageRangeNote(startPage: number, count: number): string {
  const last = startPage + count - 1;
  return startPage === last
    ? ` This excerpt is page ${startPage} of a larger document; number it '# Page ${startPage}'.`
    : ` This excerpt is pages ${startPage} to ${last} of a larger document; number them '# Page ${startPage}' through '# Page ${last}', not from 1.`;
}

/** High ceiling: even one chunk's transcription can be long, and truncating it
 * would reintroduce the very information loss this step exists to prevent. */
const MAX_OUTPUT_TOKENS = 32000;

/** Hard ceiling on ONE chunk's read call so a stuck transcription aborts loudly. */
const READ_TIMEOUT_MS = 180_000;

/** How often to emit a throttled progress heartbeat while a read streams. */
const HEARTBEAT_MS = 4_000;

/** Pages per chunk. Small enough that a chunk transcribes fast and well under the
 * output-token ceiling; large enough to keep the number of calls modest. */
const CHUNK_PAGES = 3;

/** Max chunks transcribed at once — fan out, but never hammer the API on a huge
 * document (a 60-page doc is 20 chunks; this caps concurrent calls). */
const MAX_CONCURRENCY = 6;

export interface TranscriptionResult {
  /** The whole document as one string, markers stripped. Unchanged in shape
   *  from before page awareness, so every existing consumer is unaffected. */
  text: string;
  /**
   * Per-page text in document order. Absent when the source has no pages at all
   * (csv / xlsx / docx / plain text) — callers must treat `undefined` as
   * `[text]`, i.e. a single segment.
   */
  pages?: string[];
  /**
   * False when any chunk's page markers didn't reconcile against its real page
   * count. Segmentation still runs, but at chunk rather than page granularity,
   * so downstream can choose to fall back to the pre-segmentation route.
   */
  pagesTrusted: boolean;
  usage: TranscriptionUsage;
}

export interface TranscriptionUsage {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Which model produced these tokens. `meterAnthropic` prices usage by model
   * and falls back to Opus 5 when this is absent — which would record a Sonnet
   * read at Opus rates and hide the exact saving this reader is tuned for.
   * Undefined for a `text` part, which costs nothing because no call is made.
   */
  model?: string;
}

/**
 * One page-range chunk of a document, with the offset needed to rebase the
 * model's chunk-local page numbers onto the original document.
 */
export interface PdfChunk {
  part: ContentPart;
  /** 1-based page number of this chunk's first page in the ORIGINAL document. */
  startPage: number;
  pageCount: number;
}

/** One page-range slice of a document, plus where it sat in the original. */
export interface DocumentChunk {
  part: ContentPart;
  /** 1-based page number of this chunk's first page in the WHOLE document. */
  startPage: number;
  /** Pages in this chunk; 0 when the page count could not be determined. */
  pageCount: number;
}

/**
 * Split a PDF's bytes into page-range chunks of `pagesPerChunk`, each a
 * standalone PDF content part. Returns a single chunk (the original) when the
 * document has one page or fewer than a chunk's worth, and — defensively — the
 * original on any parse failure, so a malformed PDF still gets one transcription
 * attempt instead of dropping the document. Exported for unit testing.
 *
 * Each chunk carries its `startPage` because the model numbers pages WITHIN the
 * chunk it is handed: give it pages 4-6 as a standalone 3-page PDF and it emits
 * `page 1..3`. Rebasing is the caller's job and needs this offset.
 */
export async function splitPdfIntoChunks(
  bytes: Uint8Array,
  pagesPerChunk = CHUNK_PAGES
): Promise<PdfChunk[]> {
  const whole: ContentPart = {
    type: "file",
    data: bytes,
    mediaType: "application/pdf",
  };
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    // Page count is unknowable on a parse failure; claim one so the marker
    // reconciliation in `splitChunkPages` degrades to chunk granularity.
    return [{ part: whole, startPage: 1, pageCount: 1 }];
  }
  const total = src.getPageCount();
  if (total <= pagesPerChunk) {
    return [{ part: whole, startPage: 1, pageCount: Math.max(1, total) }];
  }

  const chunks: PdfChunk[] = [];
  for (let start = 0; start < total; start += pagesPerChunk) {
    const out = await PDFDocument.create();
    const indices = Array.from(
      { length: Math.min(pagesPerChunk, total - start) },
      (_, k) => start + k
    );
    const pages = await out.copyPages(src, indices);
    for (const p of pages) out.addPage(p);
    const data = await out.save();
    chunks.push({
      part: { type: "file", data, mediaType: "application/pdf" },
      startPage: start + 1,
      pageCount: indices.length,
    });
  }
  return chunks;
}

/** The marker the transcription prompt asks for at the head of every page. */
const PAGE_MARKER_RE = /^[ \t]*<!--[ \t]*page[ \t]+(\d+)[ \t]*-->[ \t]*$/gim;

/**
 * Split one chunk's transcription on its `<!-- page N -->` markers.
 *
 * Returns null when the marker count doesn't match `pageCount` — the model
 * merged two pages, skipped a blank one, or ignored the instruction — so the
 * caller can fall back to treating the whole chunk as one unit rather than
 * silently misattributing text to the wrong page. Text before the first marker
 * is prepended to page 1 (models occasionally emit a preamble). Marker lines are
 * stripped from the returned text. Exported for unit testing.
 */
export function splitChunkPages(
  text: string,
  pageCount: number
): string[] | null {
  const starts: number[] = [];
  PAGE_MARKER_RE.lastIndex = 0;
  for (let m = PAGE_MARKER_RE.exec(text); m; m = PAGE_MARKER_RE.exec(text)) {
    starts.push(m.index);
  }
  if (starts.length !== pageCount) return null;

  const preamble = text.slice(0, starts[0]).trim();
  const pages = starts.map((from, i) => {
    const to = i + 1 < starts.length ? starts[i + 1] : text.length;
    // Drop the marker line itself, keep everything up to the next marker.
    return text.slice(from, to).replace(PAGE_MARKER_RE, "").trim();
  });
  if (preamble) pages[0] = `${preamble}\n\n${pages[0]}`.trim();
  return pages;
}

/** Transcribe ONE content part (a page-chunk PDF, an image, or text passthrough)
 * with the model. `onChars` receives each streamed delta's length for progress. */
async function transcribeChunk(
  chunk: DocumentChunk,
  onChars: (n: number) => void
): Promise<{ text: string; usage: TranscriptionUsage }> {
  const { part } = chunk;
  if (part.type === "text") return { text: part.text, usage: {} };
  const prompt =
    chunk.pageCount > 0
      ? TRANSCRIBE_PROMPT + pageRangeNote(chunk.startPage, chunk.pageCount)
      : TRANSCRIBE_PROMPT;

  const result = streamText({
    model: scanModel(),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS),
    maxRetries: 1,
    providerOptions: scanProviderOptions(),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }, part],
      },
    ],
  });

  for await (const delta of result.textStream) onChars(delta.length);

  const text = await result.text;
  const usage = await result.totalUsage;
  return {
    text,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: SCAN_MODEL_ID,
    },
  };
}

/** Map over items with a concurrency cap, preserving input order in the result. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Transcribe one document content part to Markdown text. A `text` part passes
 * through untouched (no model call, no tokens). A multi-page PDF is split into
 * page-range chunks transcribed in parallel and stitched in page order; images
 * and small PDFs go in a single call. Returns the combined text plus summed
 * token usage so the caller can meter it.
 *
 * Streams internally so a long read is observable: pass `onProgress` to receive
 * throttled "chars so far" callbacks (aggregated across chunks) while it
 * generates (the ingest scan logs these; chat passes nothing and stays silent).
 */
/**
 * Below this, an OCR result is treated as a failed read rather than a short
 * document. Mistral returns "" or a near-empty page for a scan it cannot handle,
 * and `pdf.ts` documents the sharper failure: it can silently drop DENSE pages —
 * tables and numeric grids — which is precisely what an invoice is. A short
 * result is therefore not trusted; it falls through to the model.
 */
const OCR_MIN_CHARS = 200;

/** Roughly what one page of a real document yields; used to spot a partial read. */
const OCR_MIN_CHARS_PER_PAGE = 120;

export async function transcribeDocument(
  part: ContentPart,
  opts?: { onProgress?: (charsSoFar: number) => void }
): Promise<TranscriptionResult> {
  // Plain text has no pages at all — `pages` stays undefined, which callers
  // read as "one segment", so csv/xlsx/docx behave exactly as before.
  if (part.type === "text") {
    return { text: part.text, pagesTrusted: false, usage: {} };
  }

  const chunks: PdfChunk[] =
    part.type === "file" && part.mediaType === "application/pdf"
      ? await splitPdfIntoChunks(part.data)
      : // A single image is exactly one page; no model cooperation needed.
        [{ part, startPage: 1, pageCount: 1 }];

  // One throttled progress heartbeat shared across all chunk streams.
  let totalChars = 0;
  let lastBeat = Date.now();
  const onChars = (n: number) => {
    totalChars += n;
    if (opts?.onProgress && Date.now() - lastBeat > HEARTBEAT_MS) {
      opts.onProgress(totalChars);
      lastBeat = Date.now();
    }
  };

  // A chunk that throws must cost only its own pages. Before this, one stuck
  // call rejected the whole read and a 30-page document returned nothing.
  const parts = await mapWithLimit(chunks, MAX_CONCURRENCY, async (chunk) => {
    try {
      const res = await transcribeChunk(chunk, onChars);
      return { ...res, failed: false };
    } catch (err) {
      ierr("read: chunk FAILED", {
        startPage: chunk.startPage,
        pageCount: chunk.pageCount,
        ...errorInfo(err),
      });
      return { text: "", usage: {} as TranscriptionUsage, failed: true };
    }
  });

  if (parts.every((p) => p.failed)) {
    throw new Error("transcribeDocument: every chunk failed to transcribe");
  }

  // Rebase each chunk's local page numbers onto the document and flatten.
  const pages: string[] = [];
  let mismatched = 0;
  chunks.forEach((chunk, i) => {
    const split = parts[i].failed
      ? // A failed chunk still occupies its page slots, so later pages keep
        // their true numbers instead of shifting up.
        Array.from({ length: chunk.pageCount }, () => "")
      : splitChunkPages(parts[i].text, chunk.pageCount);
    if (split) {
      pages.push(...split);
      return;
    }
    mismatched++;
    pages.push(parts[i].text.trim());
  });

  const pagesTrusted = mismatched === 0;
  ilog("read: pages", {
    pages: pages.length,
    chunks: chunks.length,
    markersOk: pagesTrusted,
    mismatchedChunks: mismatched,
    failedChunks: parts.filter((p) => p.failed).length,
  });

  return {
    // Markers are a transport detail — stripped here so `pdf_native_content`,
    // `chunk.ts`, and Orion's chat context see the same shape as before.
    text: pages.filter(Boolean).join("\n\n"),
    pages,
    pagesTrusted,
    usage: {
      inputTokens: parts.reduce((s, p) => s + (p.usage.inputTokens ?? 0), 0),
      outputTokens: parts.reduce((s, p) => s + (p.usage.outputTokens ?? 0), 0),
      model: SCAN_MODEL_ID,
    },
  };
}

/**
 * Split a transcription into its pages, keyed by the page number the `# Page N`
 * heading STATES rather than by position — that is what an index call refers to.
 *
 * SHARED because two readers fan out over page ranges (the invoice packet
 * indexer and the statement packet indexer) and a second copy of this would
 * drift from `PAGE_HEADING` silently: a slicer that finds no pages simply
 * reports one big document, so the drift would look like "this packet holds one
 * invoice" rather than an error.
 */
export function splitTranscriptPages(markdown: string): Map<number, string> {
  const pages = new Map<number, string>();
  // `PAGE_HEADING` is a shared /g regex; matchAll on a fresh copy keeps this
  // free of lastIndex state carried over from another caller.
  const re = new RegExp(PAGE_HEADING.source, PAGE_HEADING.flags);
  const heads = [...markdown.matchAll(re)];
  for (let i = 0; i < heads.length; i++) {
    const n = Number(heads[i][1]);
    const from = heads[i].index ?? 0;
    const to =
      i + 1 < heads.length
        ? (heads[i + 1].index ?? markdown.length)
        : markdown.length;
    // A repeated page number must not drop a page, so append rather than
    // overwrite. This is what a chunked read used to produce before the reader
    // numbered pages globally.
    pages.set(n, (pages.get(n) ?? "") + markdown.slice(from, to));
  }
  return pages;
}

/** The text of pages `first..last`, in order. Missing pages are simply absent. */
export function transcriptPageRange(
  pages: Map<number, string>,
  first: number,
  last: number
): string {
  const out: string[] = [];
  for (let n = Math.min(first, last); n <= Math.max(first, last); n++) {
    const t = pages.get(n);
    if (t) out.push(t);
  }
  return out.join("\n\n");
}
