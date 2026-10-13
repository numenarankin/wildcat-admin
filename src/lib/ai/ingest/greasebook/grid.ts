/**
 * Grid plumbing shared by every GreaseBook reader: cell normalization, date and
 * number reading, and turning a PASTE into the same `string[][]` a spreadsheet
 * parses to.
 *
 * The readers work on a grid and nothing else, so a file and a paste are the same
 * input by the time they reach one. Everything here is pure.
 */

/** A parsed grid: rows of raw cell strings, exactly as `parseTable` produces. */
export type Grid = string[][];

/** Cells that mean "no reading", as against a measured zero. GreaseBook prints a
 * dash on a day the tank was not gauged; the distinction is the whole ballgame,
 * so it is decided in one place. */
const ABSENT = new Set(["", "-", "--", "—", "–", "n/a", "na", "none", "null"]);

/** Is this cell empty of data? A `0` is NOT absent. */
export function isAbsent(raw: string | undefined | null): boolean {
  return ABSENT.has(normalize(raw).toLowerCase());
}

/**
 * A cell reduced to comparable text: non-breaking spaces to spaces, newlines
 * (which is how a merged or wrapped cell arrives) to spaces, runs of whitespace
 * collapsed, trimmed. Casing is preserved; `headerKey` lowercases separately.
 */
export function normalize(raw: string | undefined | null): string {
  return String(raw ?? "")
    .replace(/ /g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A header cell reduced to a match key: normalized, lowercased, punctuation and
 * parenthetical units dropped. `"Inches\n(+/-)"`, `" inches (+/-) "` and
 * `"INCHES +/-"` are the same key, which is what keeps a merged-cell line break
 * or a stray leading space from defeating detection. */
export function headerKey(raw: string | undefined | null): string {
  return normalize(raw)
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9+/#.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every non-empty cell of a row, normalized. */
export function cells(row: Grid[number]): string[] {
  return (row ?? []).map(normalize).filter((c) => c !== "");
}

/** A row with nothing in it (the separator between GreaseBook sections). */
export function isBlankRow(row: Grid[number] | undefined): boolean {
  return !row || row.every((c) => normalize(c) === "");
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export interface ParsedDate {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM` (24h) when the cell carried a clock time, else null. */
  time: string | null;
}

/**
 * Read whatever date GreaseBook printed. Handles `6/4/2026 10:32 AM`,
 * `06/04/2026`, `Aug 21, 2026`, `2026-06-04`, two-digit years, and an Excel
 * serial number (what a date column becomes when the sheet is re-saved).
 *
 * US order (`M/D/Y`) is assumed for slash dates because these are US operator
 * reports, EXCEPT where the first field is unambiguously a year. A day > 12 in
 * the first position is read as `D/M/Y` rather than rejected, since that is the
 * only reading that can be true.
 */
export function parseDate(raw: string): ParsedDate | null {
  const s = normalize(raw);
  if (!s) return null;

  const time = readTime(s);

  // ISO first: unambiguous, and the format `parseTable` renders dates in.
  const iso = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return iso3(iso[1], iso[2], iso[3], time);

  // "Aug 21, 2026" / "August 21 2026" / "21 Aug 2026"
  const named = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (named) {
    const m = MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (m) return iso3(named[3], String(m), named[2], time);
  }
  const namedRev = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (namedRev) {
    const m = MONTHS[namedRev[2].slice(0, 3).toLowerCase()];
    if (m) return iso3(namedRev[3], String(m), namedRev[1], time);
  }

  // Slash / dot / dash numeric: M/D/Y, with D/M/Y when the first field cannot be
  // a month.
  const num = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (num) {
    let a = Number(num[1]);
    let b = Number(num[2]);
    if (a > 12 && b <= 12) [a, b] = [b, a];
    const year = num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3]);
    return iso3(String(year), String(a), String(b), time);
  }

  // A bare Excel serial (days since 1899-12-30), which is what a date column
  // becomes when a sheet is re-saved. Bounded to 2000-01-01..2100-01-01: a water
  // meter's cumulative index is also a bare five-digit number, and the sample's
  // 25820.00 would otherwise read as September 1970. The window cannot separate
  // an index above 36,526 bbl from a date, so this is only ever applied to the
  // first cell of a row, which in every GreaseBook layout is the date column.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial >= 36526 && serial <= 73051) {
      const ms = Math.round((serial - 25569) * 86_400_000);
      return { date: new Date(ms).toISOString().slice(0, 10), time };
    }
  }
  return null;
}

/** True when a cell leads with something that reads as a date — how a data row is
 * told from a header, a section title or a footer. */
export function looksLikeDate(raw: string): boolean {
  return parseDate(raw) != null;
}

function iso3(y: string, m: string, d: string, time: string | null): ParsedDate | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!(year >= 1900 && year <= 2200)) return null;
  if (!(month >= 1 && month <= 12)) return null;
  if (!(day >= 1 && day <= 31)) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Reject a day the month does not have (2/30) rather than letting Date roll it
  // forward into a reading filed on the wrong day.
  const probe = new Date(`${iso}T00:00:00Z`);
  if (probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return null;
  return { date: iso, time };
}

/** `10:32 AM`, `22:32`, `10:32:00` → `HH:MM`. Null when the cell has no clock. */
function readTime(s: string): string | null {
  const m = s.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|AM|PM)?\b/);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = Number(m[2]);
  const mer = m[3]?.toLowerCase();
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * A printed number, or null when the cell is absent.
 *
 * Handles what spreadsheets and web tables do to numbers: thousands separators,
 * a currency symbol, a trailing unit, and accounting parentheses for negatives
 * (`(3.50)` = −3.5). Returns null rather than 0 for an absent cell, because a
 * blank and a zero are different measurements everywhere in this app.
 */
export function parseNumber(raw: string): number | null {
  if (isAbsent(raw)) return null;
  const s = normalize(raw);
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()]/g, "").replace(/[$,\s]/g, "").replace(/[a-zA-Z%]+$/, "");
  if (!/^[+-]?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Turn pasted text into a grid.
 *
 * Delimiter is sniffed rather than assumed: Excel and every HTML table put TABS
 * on the clipboard, but a user who saved the same selection as CSV first gets
 * commas, and one of those two is always dominant. Ties go to tab, which is by
 * far the more common paste.
 *
 * Rows are NOT trimmed to their last non-empty cell: a trailing empty column is
 * load-bearing here, because GreaseBook's water page separates its column groups
 * with blank spacer columns.
 */
export function gridFromPaste(text: string): Grid {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^﻿/, "")
    .split("\n");
  const tabs = lines.reduce((n, l) => n + (l.match(/\t/g)?.length ?? 0), 0);
  const commas = lines.reduce((n, l) => n + (l.match(/,/g)?.length ?? 0), 0);
  const delimiter = commas > tabs ? "," : "\t";
  return lines.map((line) => splitLine(line, delimiter)).filter((r) => r.length > 0);
}

/** One line into cells, honouring the quoting a CSV paste may carry. */
function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === "\t") return line.split("\t");
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Rejoin rows that a paste spilled across several lines.
 *
 * GreaseBook's water page puts a line break inside a cell, and pasting that as
 * text breaks one row into three: the date, then the stick value, then the rest
 * of the numbers. A row therefore STARTS at a line whose first cell is a date,
 * and every following line that does not start with one belongs to it.
 *
 * Continuation cells append in order, which is what preserves the printed column
 * meaning: the spilled fragments are the same cells, just wrapped.
 *
 * A grid that does not spill passes through unchanged, so this is safe to run
 * over every paste. Lines before the first date row (titles, headers) are left
 * exactly as they are.
 */
export function rejoinSpilledRows(grid: Grid): Grid {
  const out: Grid = [];
  let open: string[] | null = null;
  /** Fragments of ONE wrapped cell, waiting to be joined. */
  let fragment: string[] = [];
  /**
   * Whether the open row is still waiting for cells.
   *
   * Only a row that arrived INCOMPLETE can spill: the web page puts the date on
   * its own line and wraps the rest below it. A row that already arrived with
   * its cells is finished, and the next lone line after it is something else
   * entirely, usually the next section's heading. Absorbing that as a
   * continuation silently merges two sections, and every row of the second one
   * is then filed against the first one's tanks.
   */
  let spilling = false;

  const flush = () => {
    if (open && fragment.length > 0) open.push(fragment.join(" "));
    fragment = [];
  };
  const close = () => {
    flush();
    if (open) out.push(open);
    open = null;
    spilling = false;
  };

  for (const row of grid) {
    const first = normalize(row[0] ?? "");
    if (first !== "" && looksLikeDate(first)) {
      close();
      open = [...row];
      // A trailing tab leaves an empty cell the printed row never had; the
      // wrapped content belongs in the next column along.
      while (open.length > 1 && normalize(open[open.length - 1]) === "") open.pop();
      spilling = open.filter((c) => normalize(c) !== "").length <= 1;
      continue;
    }
    if (open && spilling && !isBlankRow(row)) {
      const filled = row.map(normalize).filter((c) => c !== "");
      if (filled.length === 1) {
        // A line with no delimiter is the REST OF ONE CELL, not a new cell. This
        // is what a haul looks like when pasted: its opening level, its closing
        // level and its ticket marker arrive as three lines of one cell, and
        // splitting them into three cells would lose the pair.
        fragment.push(filled[0]);
      } else {
        flush();
        open.push(...filled);
        // The row now has its cells; anything after it is a new row.
        spilling = false;
      }
      continue;
    }
    close();
    out.push(row);
  }
  close();
  return out;
}
