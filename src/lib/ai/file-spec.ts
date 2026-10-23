/**
 * The file contract between the admin Orion's `create_file` tool and the chat.
 * The tool builds the file on the server, stores it in the private
 * `admin-files` bucket under `orion/`, and returns an `OrionFile`; both chat
 * surfaces render it as a card with View and Download (`orion-file.tsx`). The
 * tool result is saved with the conversation, so the card comes back when the
 * chat is reopened; links are signed on each click, so none goes stale.
 */

export const FILE_FORMATS = ["csv", "xlsx", "pdf", "md", "txt", "json", "html"] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export const MEDIA_TYPES: Record<FileFormat, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  html: "text/html",
};

export interface OrionFile {
  /** Storage path in `admin-files`, always under `orion/`. */
  path: string;
  filename: string;
  format: FileFormat;
  sizeBytes: number;
}

/** A completed `create_file` result, or null. */
export function orionFileOf(part: unknown): OrionFile | null {
  const p = part as { type?: string; output?: unknown; result?: unknown } | null;
  if (p?.type !== "tool-create_file") return null;
  const out = (p.output ?? p.result) as { ok?: boolean; file?: OrionFile } | undefined;
  if (!out?.ok || !out.file?.path) return null;
  return out.file;
}

/** RFC 4180 CSV parse, for the viewer: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
