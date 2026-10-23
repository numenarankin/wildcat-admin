import * as XLSX from "xlsx";
import { MEDIA_TYPES, type FileFormat } from "@/lib/ai/file-spec";
import { buildPdf } from "@/lib/admin/orion-pdf";

/**
 * Bytes for a file Orion writes. Pure, so the formats test without storage.
 * Tables (csv, xlsx) come as columns + rows; text formats as one string, and a
 * PDF as Markdown laid out by `orion-pdf.ts`.
 */

export type Cell = string | number | boolean | null;
export interface Sheet {
  name?: string;
  columns: string[];
  rows: Cell[][];
}

/** A safe file name ending in the format's extension. */
export function fileName(name: string, format: FileFormat): string {
  const base =
    name
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .replace(/[^\w\- .()]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "orion-file";
  return `${base}.${format}`;
}

const csvCell = (v: Cell) => {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** UTF-8 with a BOM, so Excel reads accents and symbols correctly. */
export function buildCsv(sheet: Sheet): string {
  return "﻿" + [sheet.columns, ...sheet.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Excel's sheet-name rules: 31 characters, none of []:*?/\, unique. */
function sheetName(name: string | undefined, i: number, used: Set<string>): string {
  let n = (name ?? "").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`;
  while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)} ${i + 1}`;
  used.add(n.toLowerCase());
  return n;
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const book = XLSX.utils.book_new();
  const used = new Set<string>();
  sheets.forEach((s, i) => {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([s.columns, ...s.rows]), sheetName(s.name, i, used));
  });
  return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export type FileInput =
  | { format: "csv"; sheets: Sheet[] }
  | { format: "xlsx"; sheets: Sheet[] }
  | { format: "md" | "txt" | "json" | "html"; content: string }
  | { format: "pdf"; content: string; title?: string };

export async function buildFile(input: FileInput): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const mediaType = MEDIA_TYPES[input.format];
  const enc = (s: string) => new TextEncoder().encode(s);
  switch (input.format) {
    case "csv":
      if (input.sheets.length !== 1) throw new Error("A CSV holds one table; use xlsx for several sheets.");
      return { bytes: enc(buildCsv(input.sheets[0])), mediaType };
    case "xlsx":
      return { bytes: buildXlsx(input.sheets), mediaType };
    case "pdf":
      return { bytes: await buildPdf(input.content, input.title), mediaType };
    case "json": {
      // Pretty-printed when it parses; written as given when it does not, so
      // nothing the model wrote is lost.
      let text = input.content;
      try {
        text = JSON.stringify(JSON.parse(input.content), null, 2);
      } catch {}
      return { bytes: enc(text), mediaType };
    }
    default:
      return { bytes: enc(input.content), mediaType };
  }
}
