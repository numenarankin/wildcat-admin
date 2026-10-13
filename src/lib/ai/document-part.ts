import "server-only";

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";

/**
 * Turns an uploaded document's bytes into a model content part the Anthropic
 * provider can read. Layered so a user is very unlikely to hit an unsupported
 * type:
 *   1. PDFs / images  → native file/image parts (Claude reads them directly).
 *   1b. heic/heif      → transcoded to JPEG (iPhone default; Claude can't read it).
 *   2. text families   → UTF-8.
 *   3. xlsx/xls        → flattened to CSV text.
 *   4. docx            → text via `mammoth`.
 *   5. anything else   → converted to PDF with LibreOffice headless (`soffice`)
 *                        and read as a PDF part.
 * Only if every path fails do we raise `UnsupportedFileError`, which callers
 * treat as "couldn't parse" — never a silent skip. Shared by the ingest scan and
 * the accounting / well-production extractors.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "file"; data: Uint8Array; mediaType: string }
  | { type: "image"; image: Uint8Array };

/** Raised when no parser (native, docx, or LibreOffice conversion) could read a file. */
export class UnsupportedFileError extends Error {
  constructor(ext: string, cause?: unknown) {
    super(`Could not parse file type: .${ext}`);
    this.name = "UnsupportedFileError";
    if (cause) this.cause = cause;
  }
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Apple's HEIC/HEIF — what an iPhone camera produces by default, so most field
 * photos arrive as one. Claude's API accepts only png/jpeg/gif/webp, so these are
 * transcoded to JPEG rather than passed through.
 */
const HEIC_EXTS = new Set(["heic", "heif"]);

/** Plain-text families read straight through as UTF-8 (incl. LAS well logs). */
const TEXT_EXTS = new Set([
  "csv",
  "tsv",
  "txt",
  "md",
  "markdown",
  "json",
  "las",
  "log",
]);

function pdfPart(buf: Buffer): ContentPart {
  return { type: "file", data: new Uint8Array(buf), mediaType: "application/pdf" };
}

/**
 * HEIC/HEIF → JPEG bytes via `heic-convert` (pure JS + libheif wasm, so it needs
 * no native binary and runs on serverless, unlike the `soffice` fallback).
 *
 * Quality 0.92: an OCR target, so visible compression artifacts around small
 * digits are the failure mode to avoid — a run ticket's net-barrels figure has to
 * survive the transcode. Loaded lazily to keep it off the cold-start path for the
 * uploads that aren't HEIC.
 */
async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const spec = "heic-convert";
  const mod = (await import(spec as string)) as {
    default: (opts: {
      buffer: Buffer;
      format: "JPEG" | "PNG";
      quality?: number;
    }) => Promise<ArrayBuffer>;
  };
  const out = await mod.default({ buffer: buf, format: "JPEG", quality: 0.92 });
  return Buffer.from(out);
}

/** docx → plain text via `mammoth`. Loaded lazily so a missing dep degrades to
 * the LibreOffice fallback rather than breaking the build/runtime. */
async function docxToText(buf: Buffer): Promise<string> {
  const spec = "mammoth";
  const mod = (await import(spec as string)) as {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  const { value } = await mod.extractRawText({ buffer: buf });
  return value;
}

/**
 * Convert an arbitrary office/rich document to PDF via a headless LibreOffice
 * (`soffice`) subprocess. Requires the `soffice` binary on PATH — absent on
 * serverless (e.g. Vercel), where this must run in a worker. Throws if soffice
 * is missing or the conversion fails; the caller falls back to
 * `UnsupportedFileError`.
 */
async function convertToPdf(buf: Buffer, name: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "wc-doc-"));
  try {
    const safe = name.replace(/[^\w.\-]+/g, "_") || "input";
    const inPath = join(dir, safe);
    await writeFile(inPath, buf);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "soffice",
        ["--headless", "--convert-to", "pdf", "--outdir", dir, inPath],
        { stdio: "ignore" }
      );
      proc.on("error", reject);
      proc.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`soffice exited ${code}`))
      );
    });

    const outPath = join(dir, safe.replace(/\.[^.]+$/, "") + ".pdf");
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Builds the model content part for an uploaded file by extension. Async because
 * the fallback paths (docx text, LibreOffice→PDF) may spawn work. */
export async function buildDocumentPart(
  name: string,
  buf: Buffer
): Promise<ContentPart> {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "pdf") return pdfPart(buf);
  if (ext in IMAGE_TYPES) return { type: "image", image: new Uint8Array(buf) };
  if (HEIC_EXTS.has(ext)) {
    try {
      return { type: "image", image: new Uint8Array(await heicToJpeg(buf)) };
    } catch (err) {
      // Don't fall through to LibreOffice: soffice can't read HEIC either, so it
      // would burn a subprocess to reach the same error with a worse message.
      throw new UnsupportedFileError(ext, err);
    }
  }
  if (TEXT_EXTS.has(ext)) return { type: "text", text: buf.toString("utf-8") };

  if (ext === "xlsx" || ext === "xls") {
    // `cellDates` parses date cells into real Dates (not raw Excel serials), and
    // `dateNF` renders them ISO in the flattened CSV — so the model sees
    // "2026-07-11", never 46184. Numeric cells keep full precision. Non-numeric
    // cells (e.g. a "9ft 8in 0/4" stick reading) pass through as their text; the
    // model normalizes those per its prompt.
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    const text = wb.SheetNames.map(
      (sheet) =>
        `# Sheet: ${sheet}\n${XLSX.utils.sheet_to_csv(wb.Sheets[sheet], {
          dateNF: "yyyy-mm-dd",
        })}`
    ).join("\n\n");
    return { type: "text", text };
  }

  if (ext === "docx") {
    try {
      return { type: "text", text: await docxToText(buf) };
    } catch (err) {
      console.warn("document-part: mammoth failed, trying LibreOffice", err);
      // fall through to conversion
    }
  }

  // Last resort: convert anything else (ppt/pptx, odt, rtf, doc, pages, …) to PDF.
  try {
    return pdfPart(await convertToPdf(buf, name));
  } catch (err) {
    throw new UnsupportedFileError(ext, err);
  }
}
