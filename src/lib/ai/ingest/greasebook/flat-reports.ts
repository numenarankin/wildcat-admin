/**
 * Readers for GreaseBook's FLAT layouts: one header row, one record per row.
 *
 *   Transport Tickets     → runTickets
 *   Abbreviated Production → production, sectioned per well
 *   A daily gas log        → meterReadings
 *
 * These need none of the column-group machinery the gauge tables do, but they
 * share its rules: a printed derived value is kept as evidence rather than
 * imported, an absent cell stays absent, and a column with nowhere to go is
 * reported rather than dropped quietly.
 *
 * Pure.
 */

import { levelsInCell } from "@/lib/ai/ingest/stick";
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
import type { GbReadResult, GbRow } from "./types";

/** Column index of the first header whose key is one of `names`. */
function columnOf(header: string[], ...names: string[]): number {
  const keys = header.map(headerKey);
  for (const name of names) {
    const i = keys.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

function at(row: string[], col: number): string {
  return col >= 0 ? normalize(row[col] ?? "") : "";
}

function numberAt(row: string[], col: number): number | null {
  return col >= 0 ? parseNumber(row[col] ?? "") : null;
}

/** A single level from a stick cell, or null when the cell is absent. */
function levelAt(row: string[], col: number): number | null {
  const raw = at(row, col);
  if (isAbsent(raw)) return null;
  const levels = levelsInCell(raw);
  return levels.length === 1 ? levels[0] : null;
}

function sourceText(row: string[]): string {
  return cells(row).join(" | ").slice(0, 300);
}

/* -------------------------------------------------------------------------- */

/**
 * Transport Tickets: one crude (or water) haul per row.
 *
 * `Gross` and `Corrected/Transferred` are BOTH printed, and in the real export
 * the corrected figure sometimes exceeds the gross one, so neither may be
 * derived from the other. Both are carried through as the schema's gross and
 * net.
 */
export function readTransportTickets(grid: Grid, headerAt: number): GbReadResult {
  const header = (grid[headerAt] ?? []).map(normalize);
  const col = {
    lease: columnOf(header, "lease name"),
    tank: columnOf(header, "tank #", "tank"),
    ticket: columnOf(header, "tickets #", "ticket #"),
    net: columnOf(header, "corrected/transferred"),
    gross: columnOf(header, "gross"),
    open: columnOf(header, "open", "opening"),
    close: columnOf(header, "closing", "close"),
    meter: columnOf(header, "ending meter reading"),
    type: columnOf(header, "ticket type"),
    transporter: columnOf(header, "transport company/transfer details"),
    date: columnOf(header, "date"),
  };

  const rows: GbRow[] = [];
  const residual: string[][] = [];
  const notes: string[] = [];
  let dataRows = 0;
  let skipped = 0;
  let sawMeter = false;

  for (let i = headerAt + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (isBlankRow(row)) continue;
    const when = parseDate(at(row, col.date));
    if (!when) {
      skipped++;
      continue;
    }
    dataRows++;
    const tankRef = at(row, col.tank);
    const section = at(row, col.lease);
    const printedType = at(row, col.type);
    const gross = numberAt(row, col.gross);
    if (gross == null) {
      // A ticket with no gross volume is not a ticket we can file.
      residual.push(row);
      continue;
    }
    if (!isAbsent(at(row, col.meter))) sawMeter = true;

    rows.push({
      type: "runTickets",
      stream: `${section}|${tankRef}`,
      section,
      at: i,
      source: row,
      derived: { volume: gross },
      row: {
        tankRef,
        date: when.date,
        departureTime: when.time ?? "",
        ticketNo: at(row, col.ticket),
        // The printed wording ("Run Tickets", "Transfer") decides; the schema
        // narrows anything unrecognized to a run.
        ticketType: printedType,
        grossBbls: gross,
        netBbls: numberAt(row, col.net),
        openingGauge: levelAt(row, col.open),
        closingGauge: levelAt(row, col.close),
        transporter: at(row, col.transporter),
        product: /water/i.test(`${printedType} ${section}`) ? "water" : "oil",
        sourceText: sourceText(row),
      },
    });
  }

  if (sawMeter) {
    notes.push(
      "The ending meter reading printed on these tickets was not imported: a run ticket in Wildcat records the tank levels and the volume, not a meter index."
    );
  }

  return {
    report: "transportTickets",
    rows,
    residual,
    header,
    stats: { dataRows, emitted: rows.length, skipped },
    notes,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Abbreviated Production: per-well daily oil, water, gas and sales.
 *
 * The well sits on a line of its own above each block, so this carries a section
 * the same way the gauge reader does. `Oil Stock` is GreaseBook's running
 * inventory, which this app derives from readings and hauls; it is kept as
 * evidence for the ledger identity rather than imported.
 */
export function readAbbrProduction(grid: Grid): GbReadResult {
  const rows: GbRow[] = [];
  const residual: string[][] = [];
  const notes: string[] = [];
  let dataRows = 0;
  let skipped = 0;
  let section = "";
  let header: string[] = [];
  let col: Record<string, number> = {};
  let sawTankFields = false;

  for (let i = 0; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (isBlankRow(row)) continue;
    const filled = cells(row);

    if (columnOf(row.map(normalize), "daily oil prod") >= 0) {
      header = row.map(normalize);
      col = {
        date: columnOf(header, "day", "date"),
        oil: columnOf(header, "daily oil prod"),
        stock: columnOf(header, "oil stock"),
        water: columnOf(header, "daily water"),
        gas: columnOf(header, "gas"),
        sales: columnOf(header, "oil sales"),
        hauled: columnOf(header, "h20 hauled", "h2o hauled", "water hauled"),
        pulled: columnOf(header, "pulled bottom"),
      };
      if (col.hauled >= 0 || col.pulled >= 0) sawTankFields = true;
      continue;
    }

    const when = header.length > 0 ? parseDate(at(row, col.date)) : null;
    if (!when || filled.length < 2) {
      // A section heading, the report totals, or a footer.
      if (filled.length === 1 && !parseDate(filled[0])) section = filled[0];
      skipped++;
      continue;
    }
    dataRows++;

    const produced = numberAt(row, col.oil);
    rows.push({
      type: "production",
      stream: `${section}|production`,
      section,
      at: i,
      source: row,
      derived: {
        stock: numberAt(row, col.stock),
        produced,
        sales: numberAt(row, col.sales),
      },
      // Absent stays absent: a blank water cell is a day nobody measured water,
      // not a day of no water.
      row: dropNulls({
        date: when.date,
        oilProduction: produced,
        saltWater: numberAt(row, col.water),
        gasProduction: numberAt(row, col.gas),
        oilSales: numberAt(row, col.sales),
        sourceText: sourceText(row),
      }),
    });
  }

  if (sawTankFields) {
    notes.push(
      "Water hauled and pulled bottom were not imported from this report: in Wildcat they belong to a tank's gauge readings, not to a well's daily production."
    );
  }

  return {
    report: "abbrProduction",
    rows,
    residual,
    header,
    stats: { dataRows, emitted: rows.length, skipped },
    notes,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * A flat daily gas log: a date and an MCF volume per row.
 *
 * There is no meter column, so every row belongs to the meter the upload is
 * pinned to. The orifice, differential and pressure columns some logs carry have
 * no home on a meter reading and are reported as dropped.
 */
export function readGasLog(grid: Grid, headerAt: number): GbReadResult {
  const header = (grid[headerAt] ?? []).map(normalize);
  const col = {
    date: columnOf(header, "date", "day"),
    mcf: columnOf(header, "mcf", "gas", "gas mcf"),
  };
  const extras = ["orf", "orifice", "dp", "sep", "ht", "tp", "cp"].filter(
    (k) => columnOf(header, k) >= 0
  );

  const rows: GbRow[] = [];
  const residual: string[][] = [];
  let dataRows = 0;
  let skipped = 0;

  for (let i = headerAt + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (isBlankRow(row)) continue;
    const when = parseDate(at(row, col.date));
    if (!when) {
      skipped++;
      continue;
    }
    dataRows++;
    const mcf = numberAt(row, col.mcf);
    // A day with no volume printed is a day nobody read the meter. Filing a zero
    // would be reporting the well down.
    if (mcf == null) {
      skipped++;
      continue;
    }
    rows.push({
      type: "meterReadings",
      stream: "|gas log",
      section: "",
      at: i,
      source: row,
      derived: {},
      row: {
        meterRef: "",
        date: when.date,
        time: when.time ?? "",
        mcf,
        sourceText: sourceText(row),
      },
    });
  }

  const notes =
    extras.length > 0
      ? [
          `These columns were not imported, because a meter reading in Wildcat carries a date and a volume: ${extras.join(", ")}.`,
        ]
      : [];

  return {
    report: "gasLog",
    rows,
    residual,
    header,
    stats: { dataRows, emitted: rows.length, skipped },
    notes,
  };
}

/** Drop the keys whose value is null, so an absent measurement is ABSENT on the
 * proposed row rather than present-and-null. */
function dropNulls(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v != null));
}
