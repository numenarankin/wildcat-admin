import "server-only";

import { INGEST_ROW_SCHEMA, liftReadingTime } from "@/lib/ai/ingest/schemas";
import { type IngestType } from "@/lib/ai/ingest/types";
import { ilog } from "@/lib/ai/ingest/log";
// One implementation of stick-to-inches, shared with the GreaseBook readers.
import { countLevels, levelsInCell } from "@/lib/ai/ingest/stick";
import { largestSheet, type TableDoc, type TableSheet } from "./table";
import type { Condition, FieldSource, Interpretation } from "./spec";

/**
 * Execute an {@link Interpretation} against a parsed table — pure, deterministic
 * code, no model calls. Each row is CLASSIFIED by its content (not its column),
 * then its fields are mapped and validated against the SAME row schema the write
 * path uses. Rows no rule can classify, or that fail their schema, are returned as
 * `residual` so the caller can escalate them to direct model extraction — nothing
 * is silently dropped or force-fit into the wrong type.
 */

export interface ApplyResult {
  byType: Map<IngestType, unknown[]>;
  /** Source rows the interpretation could not confidently place (unmatched, or
   * classified but schema-invalid), for escalation to the model. */
  residual: string[][];
  /** The header row used, so an escalation pass can re-attach column meaning. */
  header: string[];
  /** A few classified examples per type, for the verification pass. */
  samples: ClassifiedSample[];
}

export interface ClassifiedSample {
  type: string;
  rowIndex: number;
  source: string[];
  extracted: Record<string, unknown>;
}

/** ---- column resolution ---------------------------------------------------- */

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildHeaderIndex(header: string[]): Map<string, number> {
  const ix = new Map<string, number>();
  header.forEach((h, i) => {
    const key = norm(h);
    if (key && !ix.has(key)) ix.set(key, i);
  });
  return ix;
}

function resolveColumn(
  ref: string | null,
  headerIndex: Map<string, number>,
  headerLen: number
): number {
  if (ref == null) return -1;
  const byName = headerIndex.get(norm(ref));
  if (byName != null) return byName;
  if (/^\d+$/.test(ref.trim())) {
    const i = Number(ref.trim());
    if (i >= 0 && i < headerLen) return i;
  }
  return -1;
}

function cellAt(row: string[], index: number): string {
  return index >= 0 && index < row.length ? (row[index] ?? "").trim() : "";
}

/** ---- classification ------------------------------------------------------- */

function conditionMatches(
  cond: Condition,
  row: string[],
  headerIndex: Map<string, number>,
  headerLen: number
): boolean {
  if (cond.kind === "always") return true;
  const cell = cellAt(row, resolveColumn(cond.column, headerIndex, headerLen));
  switch (cond.kind) {
    case "present":
      return cell !== "";
    case "empty":
      return cell === "";
    case "contains": {
      if (!cond.pattern) return false;
      try {
        return new RegExp(cond.pattern, "i").test(cell);
      } catch {
        return cell.toLowerCase().includes(cond.pattern.toLowerCase());
      }
    }
    case "levelCount":
      return countLevels(cell) === (cond.equals ?? -1);
    default:
      return false;
  }
}

/** ---- field extraction ----------------------------------------------------- */

function pickLevel(levels: number[], pick: FieldSource["pick"]): number | null {
  if (levels.length === 0) return null;
  switch (pick) {
    case "first":
      return levels[0];
    case "second":
      return levels[1] ?? null;
    case "max":
      return Math.max(...levels);
    case "min":
      return Math.min(...levels);
    case "only":
    default:
      return levels[0];
  }
}

function extractField(fm: FieldSource, cell: string): string {
  if (fm.transform === "constant") return fm.constant ?? "";
  if (fm.transform === "stickInches") {
    const level = pickLevel(levelsInCell(cell), fm.pick);
    return level == null ? "" : String(level);
  }
  // text / number / date / time — the row schema coerces these itself.
  return cell;
}

function rowSourceText(header: string[], row: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < Math.max(header.length, row.length); i++) {
    const v = (row[i] ?? "").trim();
    if (v !== "") parts.push(`${(header[i] ?? `col${i}`).trim()}=${v}`);
  }
  return parts.join(" | ");
}

function pickSheet(table: TableDoc, name: string | null): TableSheet {
  if (name) {
    const hit = table.sheets.find((s) => norm(s.name) === norm(name));
    if (hit) return hit;
  }
  return largestSheet(table);
}

/** The normalized header row, as a signature for "same layout" comparison. */
function headerSignature(sheet: TableSheet, headerRow: number): string {
  return (sheet.rows[headerRow] ?? []).map(norm).join("|");
}

/**
 * Every sheet the interpretation should run over: the mapped sheet plus any OTHER
 * sheet with the identical header layout. Operators routinely put one tank per
 * sheet in a workbook (all with the same columns); applying to only one sheet
 * silently loses whole tanks. A summary/notes sheet with different headers is
 * excluded (its rows would only become residual noise).
 */
function sheetsToApply(table: TableDoc, interp: Interpretation): TableSheet[] {
  const primary = pickSheet(table, interp.sheet);
  const sig = headerSignature(primary, interp.headerRow);
  const same = table.sheets.filter(
    (s) => headerSignature(s, interp.headerRow) === sig
  );
  return same.length > 0 ? same : [primary];
}

/** Normalized headers that identify WHICH TANK a row is for (not a level/gauge
 * column). Used to recover a row's tank when the mapping didn't map `tankRef`. */
const TANK_ID_HEADER_RE = /^(tank|battery)(\s*(#|no\.?|number|name|id))?$/;

/** Column index of a tank-identity header in this sheet, or -1. */
function findTankIdColumn(header: string[]): number {
  return header.findIndex((h) => TANK_ID_HEADER_RE.test(norm(h)));
}

const TANK_SCOPED_TYPES = new Set<IngestType>(["tankReadings", "runTickets"]);
const SAMPLES_PER_TYPE = 8;

export function applyInterpretation(
  table: TableDoc,
  interp: Interpretation
): ApplyResult {
  const sheets = sheetsToApply(table, interp);
  const multiSheet = table.sheets.length > 1;

  const byType = new Map<IngestType, unknown[]>();
  const fieldsByType = new Map<string, FieldSource[]>(
    interp.types.map((t) => [t.type, t.fields])
  );
  const residual: string[][] = [];
  const samples: ClassifiedSample[] = [];
  const sampleCount = new Map<string, number>();
  let header: string[] = [];
  let unmatched = 0;
  let invalid = 0;
  let skipped = 0;

  for (const sheet of sheets) {
    const sheetHeader = sheet.rows[interp.headerRow] ?? [];
    if (header.length === 0) header = sheetHeader;
    const headerIndex = buildHeaderIndex(sheetHeader);
    const tankIdCol = findTankIdColumn(sheetHeader);
    const dataRows = sheet.rows.slice(interp.headerRow + 1);

    dataRows.forEach((row, i) => {
      if (row.every((c) => (c ?? "").trim() === "")) return;

      // Classify by content: first matching rule wins.
      const rule = interp.classifier.find((r) =>
        conditionMatches(r.when, row, headerIndex, sheetHeader.length)
      );
      const type = rule?.type ?? null;
      if (type === "skip") {
        skipped++;
        return;
      }
      if (!type || !(type in INGEST_ROW_SCHEMA)) {
        unmatched++;
        residual.push(row);
        return;
      }

      const schema = INGEST_ROW_SCHEMA[type as IngestType];
      const fields = fieldsByType.get(type) ?? [];
      const draft: Record<string, unknown> = {};
      for (const fm of fields) {
        const src =
          fm.transform === "constant"
            ? ""
            : cellAt(row, resolveColumn(fm.column, headerIndex, sheetHeader.length));
        const value = extractField(fm, src);
        if (value !== "") draft[fm.field] = value;
      }
      draft.sourceText = rowSourceText(sheetHeader, row);

      // Make sure a tank row carries WHICH TANK it belongs to, so a tank-scoped
      // upload can keep only the target tank's rows (and multi-tank files route
      // each row to its own tank). Prefer the mapped `tankRef`; else a tank-id
      // column in the sheet; else, in a multi-sheet workbook, the sheet name
      // (often the tank's number/name). Single-sheet files with no tank column
      // stay blank and default to the pinned tank downstream.
      if (TANK_SCOPED_TYPES.has(type as IngestType)) {
        const current = typeof draft.tankRef === "string" ? draft.tankRef.trim() : "";
        if (!current) {
          const fromCol = tankIdCol >= 0 ? cellAt(row, tankIdCol) : "";
          const hint = fromCol || (multiSheet ? sheet.name : "");
          if (hint) draft.tankRef = hint;
        }
      }

      // A single timestamp column ("7/10/2026 6:20 PM") lands in `date`; split the
      // clock time into `time` before the schema strips it off the date, so
      // same-day readings keep their distinct (date, time) keys.
      const res = schema.safeParse(liftReadingTime(draft));
      if (!res.success) {
        invalid++;
        residual.push(row);
        return;
      }
      if (!byType.has(type as IngestType)) byType.set(type as IngestType, []);
      byType.get(type as IngestType)!.push(res.data);

      const n = sampleCount.get(type) ?? 0;
      if (n < SAMPLES_PER_TYPE) {
        sampleCount.set(type, n + 1);
        samples.push({ type, rowIndex: i, source: row, extracted: res.data as Record<string, unknown> });
      }
    });
  }

  ilog("structured: apply done", {
    sheets: sheets.map((s) => s.name),
    types: [...byType].map(([t, r]) => ({ type: t, rows: r.length })),
    residual: residual.length,
    unmatched,
    invalid,
    skipped,
  });
  return { byType, residual, header, samples };
}
