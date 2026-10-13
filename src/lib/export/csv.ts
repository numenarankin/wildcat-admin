/**
 * RFC-4180 CSV serialization, deterministic and dependency-free.
 *
 * Every export's CSV path runs through here so quoting, formula-injection
 * neutralization, and line endings are decided in exactly one place. The
 * serializers below are pure — same input, same bytes — which is the whole
 * point of a data export (see the "No AI" note in the design doc).
 */

import { cellsOf, headersOf, type ColumnSpec } from "@/lib/export/columns";

/** Excel-friendly line terminator (documented: exports use CRLF). */
export const CSV_EOL = "\r\n";

/**
 * UTF-8 BOM. Prepended at the delivery boundary (not by the serializers) so
 * Excel reads accented text correctly. Kept out of the pure serializer output
 * so tests can assert on clean CSV and client/server can wrap identically.
 */
export const CSV_BOM = "﻿";

// A cell needs quoting if it contains a comma, quote, or newline (RFC-4180).
const NEEDS_QUOTING = /[",\r\n]/;
// Spreadsheet formula-injection triggers: a leading =, +, -, @, or tab.
const FORMULA_LEADING = /^[=+\-@\t]/;

/**
 * Escape one value into a CSV field. Numbers are emitted verbatim (no locale
 * grouping — machine-readable). Strings that begin with a formula trigger are
 * prefixed with a single quote so spreadsheets treat them as text, never as a
 * formula. `null`/`undefined` become an empty field.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  let cell = value;
  // Neutralize CSV injection before quoting (the guard char becomes content).
  if (FORMULA_LEADING.test(cell)) cell = `'${cell}`;
  if (NEEDS_QUOTING.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/** Join a row of raw values into an escaped CSV line. */
export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * Serialize a header row plus data rows into a CSV string (CRLF-terminated,
 * trailing newline, no BOM). Empty `rows` yields a header-only document.
 */
export function toCsv(
  header: string[],
  rows: (string | number | null | undefined)[][]
): string {
  const lines = [csvRow(header), ...rows.map(csvRow)];
  return lines.join(CSV_EOL) + CSV_EOL;
}

/** Serialize typed rows through a {@link ColumnSpec} set into CSV. */
export function columnsToCsv<T>(columns: ColumnSpec<T>[], rows: T[]): string {
  return toCsv(
    headersOf(columns),
    rows.map((row) => cellsOf(columns, row))
  );
}
