/**
 * Native PDF reading for Orion.
 *
 * The OCR pipeline (Mistral → `files.derived_content`) can silently drop dense
 * pages (scanned well logs, tables, numeric grids), leaving Orion blind to part
 * of a document with no signal that anything is missing. `readPdfNative` is the
 * fallback: it streams the stored PDF straight to the model, which reads PDFs
 * natively (the same capability the accounting extractor uses), and returns the
 * full transcription.
 *
 * The result is cached on `files.pdf_native_content`, kept ALONGSIDE the OCR
 * text in `derived_content` (never overwriting it), so a later pass can compare
 * the two and flag documents whose OCR came back short.
 *
 * That cache is REUSED: the second and later reads of a PDF return the stored
 * transcription without re-sending the bytes to the model. Reuse is safe because
 * a file's bytes are immutable — `storage_key` is written once at insert and
 * never updated, so a row's PDF cannot change under a cached read. Deleting the
 * file drops the row and the cache with it. The one-time cost of the first read
 * is still deliberate; paying it again for the same bytes was not.
 */

import { hasSupabase } from "@/lib/env";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { meterAnthropic } from "@/lib/billing/credits";
import { transcribeDocument } from "@/lib/ai/read-document";

const BUCKET = "files";

export interface PdfReadResult {
  name: string;
  text: string;
}

/**
 * Read a stored PDF natively and return its full text. Returns null when the
 * file is missing, isn't a PDF, or has no stored bytes.
 */
export async function readPdfNative(
  fileId: string
): Promise<PdfReadResult | null> {
  if (!hasSupabase()) return null;

  // RLS-scoped read: confirms the caller may access this file before we touch
  // its bytes (and update its row) with the admin client below.
  const sb = await getSupabaseServer();
  const { data: file } = await sb
    .from("files")
    .select("name, type, storage_key, pdf_native_content")
    .eq("id", fileId)
    .maybeSingle();
  if (!file || file.type !== "pdf" || !file.storage_key) return null;

  // Already transcribed this PDF: serve the cache. Same bytes, same text, no
  // download, no model call, no tokens billed.
  const cached = (file.pdf_native_content ?? "").trim();
  if (cached) return { name: file.name, text: cached };

  const { data: blob, error: dlErr } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .download(file.storage_key);
  if (dlErr || !blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // The `type === "pdf"` guard above means this is a PDF; force the media type
  // rather than trusting a stored mime (uploads often arrive as
  // application/octet-stream, which the provider rejects).
  const { text, usage } = await transcribeDocument({
    type: "file",
    data: bytes,
    mediaType: "application/pdf",
  });

  // Bill the org for the tokens this read cost.
  void meterAnthropic(
    { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    "chat:read_pdf",
    sb
  );

  // Cache the native read next to (not replacing) the OCR text so a later pass
  // can flag short/incomplete OCR. Best-effort: a failed write must not fail the
  // read. Admin client: the RLS-checked select above already authorised access.
  try {
    await getSupabaseAdmin()
      .from("files")
      .update({
        pdf_native_content: text,
        pdf_native_at: new Date().toISOString(),
      })
      .eq("id", fileId);
  } catch (error) {
    console.error("readPdfNative: caching native read failed", error);
  }

  return { name: file.name, text };
}
