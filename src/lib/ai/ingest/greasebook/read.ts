/**
 * The GreaseBook fast path, end to end: a grid in, validated ingest rows out,
 * with no model call anywhere.
 *
 *   detect -> read -> self-check -> validate against the write path's schemas
 *
 * The self-check is what earns the right to skip the model. Every GB report
 * prints derived columns beside the raw ones, this import discards them, and
 * `verify.ts` uses them to confirm we read the right rows and the right columns
 * (see that file). A stream whose arithmetic does not reconcile is REFUSED here
 * and handed back as residual, so the model gets those rows instead of us
 * importing a column we misread. Individual rows that disagree inside an
 * otherwise-clean stream are kept and marked, because that is GreaseBook's own
 * edited data rather than our mistake.
 *
 * Pure. Nothing here reads the database, resolves a well, or writes anything:
 * the caller pins the facility and the operator still approves every card.
 */

import { INGEST_ROW_SCHEMA, liftReadingTime } from "@/lib/ai/ingest/schemas";
import type { IngestType } from "@/lib/ai/ingest/types";
import { detectGreasebook } from "./detect";
import { readAbbrProduction, readGasLog, readTransportTickets } from "./flat-reports";
import { rejoinSpilledRows, type Grid } from "./grid";
import { readGaugeTable } from "./tank-measurements";
import type { GbReadResult, GbReportKind, GbRow } from "./types";
import { verifyGb, type StreamCheck } from "./verify";

/** Appended to a kept row that did not reconcile, so the operator sees it on the
 * approval card rather than being told after the fact. */
const FLAG = " [does not reconcile with the figures printed beside it]";

export interface GreasebookResult {
  report: GbReportKind;
  /** Validated rows, ready to become proposals, grouped by ingest type. */
  byType: Map<IngestType, unknown[]>;
  /** Well/battery headings seen, for the caller to match against real wells. */
  sections: string[];
  /** Rows we could not place, for the caller to escalate to the model. */
  residual: string[][];
  header: string[];
  checks: StreamCheck[];
  notes: string[];
  stats: {
    dataRows: number;
    emitted: number;
    skipped: number;
    /** Rows dropped because their stream did not reconcile. */
    refused: number;
    /** Rows kept but marked as not reconciling. */
    flagged: number;
    /** Rows that failed the write path's own schema. */
    invalid: number;
  };
}

/**
 * Read a grid as a GreaseBook report, or return null to leave it to the existing
 * pipeline. Null is not an error: it is the normal answer for every file that is
 * not one of these five layouts.
 */
export function readGreasebook(rawGrid: Grid): GreasebookResult | null {
  // A paste can break one printed row across several lines; a file never does,
  // and passes through unchanged.
  const grid = rejoinSpilledRows(rawGrid);
  const found = detectGreasebook(grid);
  if (!found) return null;

  const read = dispatch(found.kind, grid, found.headerAt);
  if (read.rows.length === 0 && read.residual.length === 0) return null;

  const { checks, systematic, flagged } = verifyGb(read.rows);

  const byType = new Map<IngestType, unknown[]>();
  const residual = [...read.residual];
  const sections = new Set<string>();
  let refused = 0;
  let invalid = 0;

  for (const row of read.rows) {
    if (systematic.has(row.stream)) {
      // The mapping for this device is not trustworthy. Better to pay for a
      // model call on its rows than to import a column we read wrong.
      residual.push(row.source);
      refused++;
      continue;
    }
    const parsed = validate(row, flagged.has(row.at));
    if (!parsed) {
      residual.push(row.source);
      invalid++;
      continue;
    }
    if (row.section) sections.add(row.section);
    const list = byType.get(row.type);
    if (list) list.push(parsed);
    else byType.set(row.type, [parsed]);
  }

  return {
    report: found.kind,
    byType,
    sections: [...sections],
    residual,
    header: read.header,
    checks,
    notes: read.notes,
    stats: {
      ...read.stats,
      refused,
      flagged: flagged.size,
      invalid,
    },
  };
}

function dispatch(kind: GbReportKind, grid: Grid, headerAt: number): GbReadResult {
  switch (kind) {
    case "tankMeasurements":
      return readGaugeTable(grid, { report: "tankMeasurements" });
    case "waterPage":
      return readGaugeTable(grid, { report: "waterPage" });
    case "transportTickets":
      return readTransportTickets(grid, headerAt);
    case "abbrProduction":
      return readAbbrProduction(grid);
    case "gasLog":
      return readGasLog(grid, headerAt);
  }
}

/**
 * Validate against the SAME row schema the write path uses, so a row that
 * reaches the approval card is a row that can be written. A row that fails goes
 * to the model rather than being dropped or force-fit.
 */
function validate(row: GbRow, flag: boolean): unknown | null {
  const schema = INGEST_ROW_SCHEMA[row.type];
  if (!schema) return null;
  const source = flag
    ? { ...row.row, sourceText: `${String(row.row.sourceText ?? "")}${FLAG}` }
    : row.row;
  const parsed = schema.safeParse(liftReadingTime(source));
  return parsed.success ? parsed.data : null;
}
