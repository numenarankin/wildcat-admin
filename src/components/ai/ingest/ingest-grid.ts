/**
 * Pure helpers for the ingest approval modal's editable grid. The grid is
 * generic over all seven ingest types: it derives its columns from the proposed
 * rows themselves, holds every cell as a string while editing (so blank vs 0 is
 * distinguishable), and coerces back to typed values on approve — numbers to
 * numbers, blanks to null. Kept side-effect-free so the coercion (the part most
 * likely to be wrong) is unit-tested without a DOM.
 */

export type CellType = "number" | "string";

/**
 * A per-row note from the proposing step, carried on the row itself.
 *
 * Reserved: it is never a column, never edited, and never written — the write
 * step's schema would strip it anyway. It exists so a check that can only be
 * made server-side (is there already a run on this tank that day?) can reach
 * the reviewer, who is the only one who can answer it.
 */
export const NOTICE_KEY = "_notice";

export interface GridColumn {
  key: string;
  type: CellType;
}

export type Draft = Record<string, string>;
export type Row = Record<string, unknown>;

/**
 * Derive the grid's columns from the proposed rows. Column ORDER is stable:
 * keys named in `preferredOrder` (the type's schema field order) come first, in
 * that order, so the header labels and their values always line up the same way
 * regardless of how the model happened to order its JSON keys or which fields a
 * given row left out. Any extra keys not in `preferredOrder` follow in first-seen
 * order (never dropped). A column's type is `number` when ANY non-null value seen
 * for that key across the rows is a number (so an all-null-until-later column
 * still right-aligns).
 */
export function deriveColumns(
  rows: Row[],
  preferredOrder: string[] = []
): GridColumn[] {
  const seen: string[] = [];
  const typeByKey = new Map<string, CellType>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      if (key === NOTICE_KEY) continue; // a note about the row, not a field of it
      if (!typeByKey.has(key)) {
        seen.push(key);
        typeByKey.set(key, "string"); // provisional until we see a value
      }
      // Lock to number the first time a non-null numeric value appears.
      if (typeByKey.get(key) === "string" && typeof row[key] === "number") {
        typeByKey.set(key, "number");
      }
    }
  }

  // Preferred (schema) order first — but only the keys actually present — then
  // any remaining keys in first-seen order.
  const present = new Set(seen);
  const ordered = [
    ...preferredOrder.filter((k) => present.has(k)),
    ...seen.filter((k) => !preferredOrder.includes(k)),
  ];
  return ordered.map((key) => ({ key, type: typeByKey.get(key) ?? "string" }));
}

/** Cell value → editable string. null / undefined become "". */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Proposed rows → string drafts, one per row, keyed by the derived columns. */
export function rowsToDrafts(rows: Row[], columns: GridColumn[]): Draft[] {
  return rows.map((row) => {
    const draft: Draft = {};
    for (const col of columns) {
      draft[col.key] = cellToString((row as Row)?.[col.key]);
    }
    // Rides along in the draft rather than being read from `rows[i]` later:
    // removing a row splices the drafts, so the two lists stop lining up.
    const notice = (row as Row)?.[NOTICE_KEY];
    if (typeof notice === "string" && notice) draft[NOTICE_KEY] = notice;
    return draft;
  });
}

/**
 * String drafts → typed rows for the write action. A `number` column coerces to
 * a number, or to null when blank or unparseable (so an emptied nullable field
 * round-trips as null, not 0). `string` columns pass through trimmed of nothing.
 */
export function draftsToRows(drafts: Draft[], columns: GridColumn[]): Row[] {
  return drafts.map((draft) => {
    const row: Row = {};
    for (const col of columns) {
      const raw = draft[col.key] ?? "";
      if (col.type === "number") {
        if (raw.trim() === "") {
          row[col.key] = null;
        } else {
          const n = Number(raw);
          row[col.key] = Number.isNaN(n) ? null : n;
        }
      } else {
        row[col.key] = raw;
      }
    }
    return row;
  });
}
