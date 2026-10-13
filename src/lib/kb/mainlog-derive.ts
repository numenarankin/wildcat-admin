/**
 * MainLog mud logs (`.mlw`, `.ml_`, `.td_`) as text. See
 * docs/plans/mlw-mud-logs.md, Phase 3.
 *
 * A mud log is binary, so it has no `content`. At upload it is decoded once and
 * its LAS 2.0 rendition is written to `files.derived_content`, the column the
 * OCR path fills for PDFs. From there every reader that already handles LAS
 * works unchanged: `embedFile` indexes it as structured data, and
 * `read_las_full` and the geology harness read it through `loadText`.
 *
 * A file that will not decode is not an upload error. It stays an ordinary blob
 * with no text, and the reason is logged.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  isMainLog,
  mainLogToLasText,
  parseMainLog,
  readMainLog,
} from "@/lib/kb/parsers/mainlog";
import { MainLogFormatError } from "@/lib/kb/parsers/mainlog/types";

const BUCKET = "files";

/** The names a MainLog well arrives under: a log, a sendfile, a TD archive. */
export const MAINLOG_NAME = /\.(mlw|ml_|td_)$/i;

export function isMainLogName(name: string): boolean {
  return MAINLOG_NAME.test(name.trim());
}

/**
 * Decode a MainLog upload to LAS text. Null when the name is not a MainLog name
 * or the well cannot be read (`MainLogFormatError`, logged). A well that reads
 * but decodes no curves (the primary `.mlw` landed in `undecoded`, and no
 * `.las` or `.mlc` carries any) is a decode failure too: its rendition would be
 * a log with no data, so it is logged with the undecoded reasons and nothing is
 * returned. Anything else is a bug, not a bad file, so it is thrown for the
 * caller to log.
 *
 * Gated on the name, never on content alone: only `.mlw`, `.ml_` and `.td_`
 * uploads are read as MainLog.
 */
export async function mainLogLasText(
  name: string,
  bytes: Uint8Array
): Promise<string | null> {
  if (!isMainLogName(name) || !isMainLog(name, bytes)) return null;
  try {
    const log = parseMainLog(await readMainLog(name, bytes));
    if (!log.curves?.length && !log.eLogs?.length) {
      console.warn("[mainlog] nothing decoded, stored as a plain file", {
        name,
        undecoded: (log.undecoded ?? []).map((u) => `${u.member}: ${u.reason}`),
      });
      return null;
    }
    return mainLogToLasText(log);
  } catch (err) {
    if (!(err instanceof MainLogFormatError)) throw err;
    console.warn("[mainlog] decode failed, stored as a plain file", {
      name,
      member: err.member ?? null,
      error: err.message,
    });
    return null;
  }
}

/**
 * The backfill's guard: true only for a URL whose hostname is exactly
 * 127.0.0.1, localhost or ::1. A substring test would pass
 * `https://localhost.attacker.example` or `https://x.supabase.co/?127.0.0.1`.
 */
export function isLocalSupabaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/**
 * Decode a stored MainLog file and write its LAS text to `derived_content`.
 * Returns the text written, or null when nothing was.
 *
 * `bytes` is what the upload already holds; without it the object is read back
 * from Storage, and only for a MainLog name, so a caller can run this over
 * every file without downloading every file. `sb` does the write: the upload
 * paths pass the request-scoped client (RLS, as the OCR write in `embedFile`),
 * the backfill passes the service-role one.
 */
export async function deriveMainLog(
  sb: SupabaseClient,
  file: { id: string; name: string; storage_key?: string | null },
  bytes?: Uint8Array | null
): Promise<string | null> {
  if (!isMainLogName(file.name)) return null;
  let data = bytes ?? null;
  if (!data) {
    const { data: blob, error } = await getSupabaseAdmin()
      .storage.from(BUCKET)
      .download(file.storage_key ?? file.id);
    if (error || !blob) {
      throw new Error(`deriveMainLog (storage): ${error?.message ?? "no bytes returned"}`);
    }
    data = new Uint8Array(await blob.arrayBuffer());
  }

  const text = await mainLogLasText(file.name, data);
  if (!text) return null;

  const { error } = await sb
    .from("files")
    .update({ derived_content: text, derived_at: new Date().toISOString() })
    .eq("id", file.id);
  if (error) throw new Error(`deriveMainLog (files): ${error.message}`);
  return text;
}
