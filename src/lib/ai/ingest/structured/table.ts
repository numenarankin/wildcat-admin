import "server-only";

import * as XLSX from "xlsx";

/**
 * Structured-import reader: turn a CLEAN tabular upload (xlsx / xls / csv / tsv)
 * into per-sheet rows of string cells, so the code-heavy import path can map and
 * transform it deterministically instead of paying an LLM to read every row.
 * Anything that is NOT a spreadsheet/delimited file (PDF, image, docx, ...)
 * returns null, and the caller falls back to the AI extraction path.
 */

export interface TableSheet {
  name: string;
  /** All cells as strings (dates rendered ISO, numbers full-precision). rows[0]
   * is usually the header, but a title row above it is possible — the mapping
   * spec names the real header row. */
  rows: string[][];
}

export interface TableDoc {
  sheets: TableSheet[];
}

const SPREADSHEET_EXTS = new Set(["xlsx", "xls", "xlsm", "xlsb", "ods"]);
const DELIMITED_EXTS = new Set(["csv", "tsv"]);

/** Is this filename a tabular type the structured path can parse? */
export function isTabularFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return SPREADSHEET_EXTS.has(ext) || DELIMITED_EXTS.has(ext);
}

/**
 * Parse a spreadsheet/CSV into per-sheet arrays of string cells, or null if the
 * file is not tabular. Uses the same SheetJS reader as the flattened-CSV path, so
 * dates come out ISO (`yyyy-mm-dd`) and numbers keep precision; every cell is a
 * string, which makes the downstream schema coercion uniform. Empty sheets are
 * dropped; null means "not a table — use the AI path".
 */
export function parseTable(name: string, buf: Buffer): TableDoc | null {
  if (!isTabularFile(name)) return null;
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  } catch {
    return null;
  }
  const sheets: TableSheet[] = wb.SheetNames.map((sheetName) => {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1, // array-of-arrays, keep the raw grid
      raw: false, // format values to display strings (dates → ISO via dateNF)
      dateNF: "yyyy-mm-dd",
      defval: "", // empty cells become "" so column positions stay aligned
      blankrows: false,
    });
    return {
      name: sheetName,
      rows: rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : [])),
    };
  }).filter((s) => s.rows.length > 0);
  return sheets.length > 0 ? { sheets } : null;
}

/** The sheet with the most rows — the one that holds the bulk data in a workbook
 * that also has a summary/notes sheet. */
export function largestSheet(table: TableDoc): TableSheet {
  return table.sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
}
