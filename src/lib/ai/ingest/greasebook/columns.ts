/**
 * GreaseBook's two-row header, read into COLUMN GROUPS.
 *
 * Every gauge-bearing GB layout prints one group of columns per device, side by
 * side, with the device's name in a merged cell above them:
 *
 *   Date | Oil Tank #486367 (Oil) x3      | Oil Tank #2 (Oil) x3
 *   Date | Gauge | Inches (+/-) | Produced | Gauge | Inches (+/-) | Produced
 *
 * SheetJS repeats a merged cell across its span, and a paste leaves it in the
 * first column of the span with blanks after, so the name is resolved by looking
 * back from the group's first column. The water page adds a meter group with
 * different fields and puts the meter's name on its own line above the header
 * entirely, which is why `standaloneLabels` exists.
 *
 * Pure.
 */

import { headerKey, normalize, type Grid } from "./grid";

export type GroupKind = "tank" | "meter";

/** Field keys a group can carry, normalized away from GB's printed labels. */
export type FieldKey = "gauge" | "deltaIn" | "volume" | "index" | "tp" | "cp";

export interface Group {
  /** The device as printed, with state suffixes like "(25% full)" removed. */
  label: string;
  kind: GroupKind;
  /** Oil or water when the header says so, else null (caller decides). */
  product: "oil" | "water" | null;
  /** Field key to its column index in the data row. */
  cols: Partial<Record<FieldKey, number>>;
}

/** Which field a printed header cell is, or null when it is not one we use. */
function fieldOf(cell: string): FieldKey | null {
  const k = headerKey(cell);
  if (k === "gauge" || k === "measurement") return "gauge";
  if (k === "inches +/-" || k === "+/- in" || k === "+/-in" || k === "inches") return "deltaIn";
  if (k === "produced bbls" || k === "bbls" || k === "water bbls" || k === "produced") return "volume";
  if (k === "meter reading" || k === "reading") return "index";
  if (k === "tp") return "tp";
  if (k === "cp") return "cp";
  return null;
}

/** A group starts at the field that identifies the device it measures. */
function startsGroup(f: FieldKey): boolean {
  return f === "gauge" || f === "index";
}

/**
 * Strip the state GreaseBook prints inside a device's name.
 *
 * `(25% full)` is how full the tank is right now, not part of its identity, and
 * `(Oil)` / `(Water)` is the product, which is returned separately. What is left
 * is the name the operator would recognize and the write path resolves against.
 */
export function readLabel(raw: string): { label: string; product: "oil" | "water" | null } {
  const text = normalize(raw);
  let product: "oil" | "water" | null = null;
  const label = text
    .replace(/\((?:oil|water)\)/gi, (m) => {
      product = m.toLowerCase().includes("water") ? "water" : "oil";
      return "";
    })
    .replace(/\(\s*[\d.]+\s*%\s*full\s*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  // A tank whose NAME says water, with no printed product suffix.
  if (!product && /\bwater\b/i.test(label)) product = "water";
  if (!product && /\boil\b/i.test(label)) product = "oil";
  return { label, product };
}

/**
 * Read the column groups out of a name row and the field row beneath it.
 *
 * `standaloneLabels` are single-cell lines found above the header (the water
 * page's `Water Meter #1`), used in order for any group the name row does not
 * label.
 */
export function readGroups(
  nameRow: string[] | undefined,
  fieldRow: string[],
  standaloneLabels: string[] = []
): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let floor = 0;
  const spare = [...standaloneLabels];

  for (let col = 0; col < fieldRow.length; col++) {
    const field = fieldOf(fieldRow[col] ?? "");
    if (!field) continue;
    if (startsGroup(field) || !current) {
      // Look back only as far as the PREVIOUS group's first column. A merged
      // header cell arrives in the first cell of its span, so a group's name can
      // sit several columns to its left; but it can never sit inside the group
      // before it. Without that floor, the water page's meter group inherits the
      // second tank's name.
      const { label, product } = labelFor(nameRow, col, floor);
      floor = col + 1;
      current = {
        label,
        kind: field === "index" ? "meter" : "tank",
        product,
        cols: {},
      };
      groups.push(current);
    }
    // A repeated field within one group (a malformed header) is ignored rather
    // than overwriting: the first column wins, and the arity check downstream
    // sees the group is wrong.
    if (current.cols[field] == null) current.cols[field] = col;
  }

  for (const g of groups) {
    if (g.label === "" && spare.length > 0) {
      const { label, product } = readLabel(spare.shift() ?? "");
      g.label = label;
      if (!g.product) g.product = product;
    }
  }
  return groups;
}

/** The device name governing a column: its own cell, else the nearest name to its
 * left (how a merged cell arrives in a paste). */
function labelFor(
  nameRow: string[] | undefined,
  col: number,
  floor = 0
): { label: string; product: "oil" | "water" | null } {
  if (!nameRow) return { label: "", product: null };
  for (let c = col; c >= floor; c--) {
    const cell = normalize(nameRow[c] ?? "");
    if (cell && headerKey(cell) !== "date") return readLabel(cell);
  }
  return { label: "", product: null };
}

/** Single-cell lines above `headerAt` — where the water page hides its meter
 * name. Returned newest-last, in reading order. */
export function standaloneLabelsAbove(grid: Grid, headerAt: number, backTo = 0): string[] {
  const out: string[] = [];
  for (let i = backTo; i < headerAt; i++) {
    const filled = (grid[i] ?? []).map(normalize).filter((c) => c !== "");
    if (filled.length === 1 && headerKey(filled[0]) !== "date") out.push(filled[0]);
  }
  return out;
}
