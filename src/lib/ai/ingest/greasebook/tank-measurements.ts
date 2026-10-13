/**
 * Reader: GreaseBook's gauge-table layouts → tank readings, the hauls printed
 * among them, and (on the water page) the meter readings beside them.
 *
 * The layout is stateful, which is exactly what the existing interpretation
 * executor cannot express (`structured/apply.ts` is row-local): the well sits on
 * a line of its own, the device names sit in a merged row above the field header,
 * and one well can have several devices side by side. So this pass carries the
 * section and its column groups down the grid.
 *
 * The HEADER BLOCK is read as a block rather than as "the row above", because the
 * two layouts arrange it differently:
 *
 *   tank report   section line -> device-name row -> field row
 *   water page    device-name row -> meter name on its own line -> field row
 *
 * The rule that covers both: the last row above the field row carrying two or
 * more labels is the device-name row; lone lines BEFORE it are the section, lone
 * lines AFTER it are device names the name row did not carry (the water page's
 * meter).
 *
 * What it deliberately does NOT import: the printed barrels. They are derived by
 * GreaseBook from the same gauge and the same strapping this app holds, and
 * importing them would put a second source of truth behind a number this app
 * computes. They are kept as `derived` purely so `verify.ts` can confirm we read
 * the right columns.
 *
 * Pure: a grid in, records out. Nothing resolves against the database.
 */

import { levelsInCell } from "@/lib/ai/ingest/stick";
import { readGroups, readLabel, type Group } from "./columns";
import {
  cells,
  headerKey,
  isAbsent,
  isBlankRow,
  normalize,
  parseDate,
  parseNumber,
  type Grid,
} from "./grid";
import type { GbReadResult, GbReportKind, GbRow } from "./types";

/** A ticket number as printed inside a haul cell ("Water Haul #40581"). */
const TICKET_NO = /#\s*([A-Za-z0-9-]+)/;

export function readGaugeTable(
  grid: Grid,
  opts: { report?: Extract<GbReportKind, "tankMeasurements" | "waterPage"> } = {}
): GbReadResult {
  const report = opts.report ?? "tankMeasurements";
  const rows: GbRow[] = [];
  const residual: string[][] = [];
  const notes: string[] = [];
  let dataRows = 0;
  let emitted = 0;
  let skipped = 0;

  let section = "";
  let groups: Group[] = [];
  let header: string[] = [];
  /** Non-data, non-field rows seen since the last field row: the header block. */
  let pending: { at: number; filled: string[]; row: string[] }[] = [];
  let droppedPressures = false;

  for (let i = 0; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (isBlankRow(row)) continue;

    if (isFieldRow(row)) {
      // A field row with NOTHING above it is the header repeating after a page
      // break, which GreaseBook does on a long report. Re-reading the groups
      // there would wipe the device names (they were printed once, pages ago)
      // and orphan every row below it.
      if (pending.length === 0 && groups.length > 0) {
        header = row.map(normalize);
        continue;
      }
      const block = readBlock(pending);
      if (block.section) section = block.section;
      groups = readGroups(block.nameRow, row, block.spare);
      header = row.map(normalize);
      pending = [];
      continue;
    }

    const filled = cells(row);
    if (!isDataRow(row, filled)) {
      // A title, a section heading, a totals line or a footer. Held rather than
      // dropped: the ones directly above a field row name the devices.
      pending.push({ at: i, filled, row });
      skipped++;
      continue;
    }

    const when = parseDate(row[0] ?? "")!;
    dataRows++;

    if (groups.length === 0) {
      // Data with no header above it: a paste that began mid-table. The rows are
      // real, so they go to the model rather than being dropped.
      residual.push(row);
      continue;
    }

    let emittedHere = 0;
    for (const group of groups) {
      const stream = `${section}|${group.label}`;
      const base = { stream, section, source: row, at: i };
      if (group.cols.tp != null || group.cols.cp != null) droppedPressures = true;

      if (group.kind === "meter") {
        // The water meter's cumulative barrel index, which is what this app
        // stores for a water meter. The printed per-day barrels beside it are the
        // difference between two of these, and are not imported.
        const index = numberAt(row, group.cols.index);
        if (index == null) continue;
        rows.push({
          ...base,
          type: "meterReadings",
          derived: { index, volume: numberAt(row, group.cols.volume) },
          row: {
            meterRef: group.label,
            date: when.date,
            time: when.time ?? "",
            mcf: index,
            sourceText: sourceText(row),
          },
        });
        emittedHere++;
        continue;
      }

      const gaugeCol = group.cols.gauge;
      if (gaugeCol == null) continue;
      const cell = row[gaugeCol] ?? "";
      // A dash or a blank is NO reading. Not a zero gauge: filing one would
      // report a full tank as empty on a day nobody visited it.
      if (isAbsent(cell)) continue;

      const levels = levelsInCell(cell);
      const derived = {
        deltaIn: numberAt(row, group.cols.deltaIn),
        volume: numberAt(row, group.cols.volume),
      };
      const product = group.product ?? (report === "waterPage" ? "water" : "oil");

      if (levels.length === 1) {
        rows.push({
          ...base,
          type: "tankReadings",
          derived,
          row: {
            tankRef: group.label,
            date: when.date,
            time: when.time ?? "",
            gauge: levels[0],
            sourceText: sourceText(row),
          },
        });
        emittedHere++;
      } else if (levels.length === 2) {
        // Two levels in one cell is a HAUL, not a reading: the tank was gauged
        // before and after liquid left it. This is the app's existing rule, and
        // it is why a haul must never be split into two readings.
        const opening = Math.max(...levels);
        const closing = Math.min(...levels);
        rows.push({
          ...base,
          type: "runTickets",
          derived,
          row: {
            tankRef: group.label,
            date: when.date,
            departureTime: when.time ?? "",
            ticketNo: TICKET_NO.exec(cell)?.[1] ?? "",
            ticketType: /transfer/i.test(cell) ? "transfer" : "run",
            /*
             * NO VOLUME. This report does not print one for a haul.
             *
             * The barrels beside a haul row are the tank's GAIN since the last
             * reading, not what left it: on 6/9 the real export prints "0.25 in
             * / 0.41 bbl" on a run whose levels fell 114.5 inches, about 190
             * barrels. Filing 0.41 as the gross would be filing a different
             * quantity under the wrong name, which is worse than filing none.
             *
             * Deriving it from the level drop is not the answer either: a run
             * ticket exists to measure that volume INDEPENDENTLY of the gauge,
             * and a computed one would look like a measurement without being
             * one. So the levels are imported, the volume is left at zero for
             * the operator to fill from the ticket, and the note below says so.
             */
            grossBbls: 0,
            openingGauge: opening,
            closingGauge: closing,
            product,
            sourceText: sourceText(row),
          },
        });
        emittedHere++;
      } else {
        residual.push(row);
      }
    }

    if (emittedHere === 0) skipped++;
    emitted += emittedHere;
  }

  if (rows.some((r) => r.type === "runTickets")) {
    notes.push(
      "Hauls in this report carry their levels but no volume: the barrels printed beside them are the tank's gain since the last reading, not what was hauled. Enter the volume from the run ticket, or import the Transport Tickets export, which carries it."
    );
  }
  if (droppedPressures) {
    notes.push(
      "Tubing and casing pressures were not imported: a reading in Wildcat carries a level or a volume, not pressures."
    );
  }

  return { report, rows, residual, header, stats: { dataRows, emitted, skipped }, notes };
}

/** Kept for the report this reader was originally written for. */
export const readTankMeasurements = (grid: Grid) => readGaugeTable(grid);

/**
 * Split the rows above a field row into the section, the device-name row, and any
 * device names on lines of their own.
 */
function readBlock(pending: { filled: string[]; row: string[] }[]): {
  section: string;
  nameRow: string[] | undefined;
  spare: string[];
} {
  let nameAt = -1;
  for (let i = 0; i < pending.length; i++) {
    const labels = pending[i].filled.filter((c) => headerKey(c) !== "date");
    if (labels.length >= 2) nameAt = i;
  }
  const before = nameAt >= 0 ? pending.slice(0, nameAt) : pending;
  const after = nameAt >= 0 ? pending.slice(nameAt + 1) : [];
  const lone = (list: typeof pending) => list.filter((p) => p.filled.length === 1);

  // The section is the LAST lone line above the name row: the report's own title
  // and date-range sit above it and are not sections.
  const sectionLines = lone(before).map((p) => p.filled[0]);
  const section = sectionLines.length > 0 ? sectionLines[sectionLines.length - 1] : "";
  // With no name row at all (a single-device table), the lone lines are the
  // device's name rather than a section.
  const spare =
    nameAt >= 0 ? lone(after).map((p) => p.filled[0]) : sectionLines.slice(-1);
  return {
    section: nameAt >= 0 ? cleanSection(section) : "",
    nameRow: nameAt >= 0 ? pending[nameAt].row : undefined,
    spare,
  };
}

/** A section heading is a well or battery; it carries no device state. */
function cleanSection(raw: string): string {
  return readLabel(raw).label;
}

/** The row whose cells name the fields ("Gauge", "Inches (+/-)", ...). */
function isFieldRow(row: string[]): boolean {
  const groups = readGroups(undefined, row);
  return groups.some((g) => g.cols.gauge != null || g.cols.index != null);
}

/**
 * A data row leads with a date AND carries something else.
 *
 * The second half matters: the report's own window line ("From 6/4/2026 to
 * 7/3/2026") leads with something that parses as a date, and without this it
 * would be read as a reading with no values.
 */
function isDataRow(row: string[], filled: string[]): boolean {
  if (filled.length < 2) return false;
  return parseDate(row[0] ?? "") != null;
}

function numberAt(row: string[], col: number | undefined): number | null {
  if (col == null) return null;
  return parseNumber(row[col] ?? "");
}

/** The row as printed, for the approval card's provenance column. */
function sourceText(row: string[]): string {
  return cells(row).join(" | ").slice(0, 300);
}
