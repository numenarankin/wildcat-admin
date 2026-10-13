/**
 * A format-agnostic column model shared by the CSV, XLSX, and PDF exporters.
 *
 * Defining a table's columns once — header text, how to pull a cell value, and
 * whether it's numeric — keeps the three output formats in lock-step: the CSV
 * header, the styled spreadsheet header, and the PDF table header can never
 * drift apart because they all read the same `ColumnSpec[]`.
 *
 * Pure module (no DOM, no Node, no deps) so it is safe to import anywhere and
 * trivial to unit-test.
 */

/** One column of an exportable table over rows of type `T`. */
export interface ColumnSpec<T> {
  /** Header label, including units where relevant (e.g. "Oil Prod (bbl)"). */
  header: string;
  /**
   * Extract this column's raw cell value from a row. Return a `number` for
   * numeric cells (so XLSX stores a real number, not text), a `string` for
   * text, or `null`/`undefined` for a blank cell.
   */
  value: (row: T) => string | number | null | undefined;
  /** Numeric column: right-aligned in XLSX/PDF and stored as a number. */
  numeric?: boolean;
  /**
   * Money column: like numeric, but XLSX applies a currency number format and
   * PDF renders a "$#,##0" string. CSV still emits the raw number (machine-
   * readable). Implies right alignment.
   */
  money?: boolean;
  /** Preferred column width (XLSX character units). */
  width?: number;
}

/** Right-aligned in styled formats (numeric or money). */
export function isRightAligned<T>(col: ColumnSpec<T>): boolean {
  return Boolean(col.numeric || col.money);
}

/** The header labels for a column set, in order. */
export function headersOf<T>(columns: ColumnSpec<T>[]): string[] {
  return columns.map((c) => c.header);
}

/** A single row's cell values for a column set, in order. */
export function cellsOf<T>(
  columns: ColumnSpec<T>[],
  row: T
): (string | number | null | undefined)[] {
  return columns.map((c) => c.value(row));
}

const grouped = new Intl.NumberFormat("en-US");
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * Blank-cell marker in the human-readable formats (PDF, markdown).
 *
 * "n/a", not a dash. Em dashes are banned from report copy (owner preference),
 * and the obvious replacement, a plain hyphen, is worse than either: in a money
 * or volume column a hyphen reads as ZERO, and these reports deliberately
 * distinguish "nothing was measured" from "the measurement was zero" (an unwired
 * purchaser seam on the RRC reconciliation, a tank with no strapping factor, a
 * facility the pumper never visited). "n/a" cannot be misread as a figure.
 */
export const BLANK_CELL = "n/a";

/**
 * Format one cell for a human-readable format: thousands separators for
 * numerics, whole dollars for money, `BLANK_CELL` for empty. Lives here, in the
 * pure column module, so every rendered view of a table (PDF, markdown) shows a
 * value the same way — CSV/XLSX deliberately keep the raw number instead.
 */
export function formatCell<T>(
  value: string | number | null | undefined,
  col: ColumnSpec<T>
): string {
  if (value == null || value === "") return BLANK_CELL;
  if (typeof value === "number") {
    if (col.money) return currency.format(value);
    if (col.numeric) return grouped.format(value);
    return String(value);
  }
  return value;
}
