/**
 * Which GreaseBook report is this, if any?
 *
 * Fingerprints on STRUCTURE, never on the filename: the same content arrives as
 * an xlsx, as a csv, or pasted out of the web page with no name at all, and it
 * has to be recognized identically in each case. What is stable across all three
 * is the header text GreaseBook prints.
 *
 * Returns null the moment a layout is not clearly one of ours. Null is not a
 * failure: the caller falls back to the existing structured/AI path, which is
 * what runs today. Guessing, on the other hand, would import a column we misread,
 * so every rule here demands more than one matching header.
 */

import { headerKey, isBlankRow, type Grid } from "./grid";
import type { GbReportKind } from "./types";

export interface GbDetection {
  kind: GbReportKind;
  /**
   * Row index of the field header (the row whose cells name the columns), which
   * is where a flat reader starts.
   *
   * The gauge layouts do NOT take a device-name row from here: they read the
   * whole block above their header themselves, because the two arrange it
   * differently (see `tank-measurements.ts`). Reporting a name row here as well
   * would be a second, quieter answer to the same question.
   */
  headerAt: number;
}

/** Header keys present in a row, as a set. */
function keysOf(row: string[] | undefined): Set<string> {
  return new Set((row ?? []).map(headerKey).filter((k) => k !== ""));
}

const has = (keys: Set<string>, ...any: string[]) => any.some((k) => keys.has(k));

/**
 * Columns that mean a table is a production ledger rather than one meter's log.
 *
 * Their presence disqualifies the gas-log match: a file that reports oil, water,
 * stock, sales or a well name alongside its gas is not a gas meter's readings,
 * and treating it as one would keep the gas and throw the rest away.
 */
const OTHER_STREAM = /^(oil|water|well|lease|battery|tank|boe|revenue|.*\b(stock|sales)\b)/;

/**
 * Detect the report. Scans a bounded window of leading rows, because every GB
 * layout puts its header within the first handful, and a paste may drop the
 * title rows above it.
 */
export function detectGreasebook(grid: Grid): GbDetection | null {
  const limit = Math.min(grid.length, 40);
  for (let i = 0; i < limit; i++) {
    const row = grid[i];
    if (isBlankRow(row)) continue;
    const keys = keysOf(row);

    // --- Transport tickets: flat, one header row, unmistakable column names.
    if (keys.has("tickets #") && keys.has("corrected/transferred") && keys.has("ticket type")) {
      return { kind: "transportTickets", headerAt: i };
    }

    // --- Abbreviated production: per-well daily columns.
    if (keys.has("day") && keys.has("daily oil prod")) {
      return { kind: "abbrProduction", headerAt: i };
    }

    // --- The water page: "Measurement" where the tank report says "Gauge", and
    // usually a meter group beside the tanks.
    if (has(keys, "measurement") && has(keys, "+/- in", "inches +/-")) {
      return { kind: "waterPage", headerAt: i };
    }

    // --- Tank measurements: the field row, with the device-name row above it.
    if (keys.has("gauge") && has(keys, "inches +/-", "+/- in")) {
      return { kind: "tankMeasurements", headerAt: i };
    }

    // --- A flat daily gas log: a date column, a gas volume, and NOTHING ELSE
    // from the production ledger.
    //
    // The negative half is what makes this safe. "Date" plus "Gas" also
    // describes this app's OWN production exports (`Date, Oil (bbl), Oil Stock,
    // Oil Sales, Water (bbl), Gas (mcf)`), and reading one of those as a gas log
    // would file its gas column as meter readings and silently drop the oil and
    // the water beside it. A real gas log measures one meter and carries only
    // that meter's own columns.
    if (
      has(keys, "date", "day") &&
      has(keys, "mcf", "gas", "gas mcf") &&
      ![...keys].some((k) => OTHER_STREAM.test(k))
    ) {
      return { kind: "gasLog", headerAt: i };
    }
  }
  return null;
}
