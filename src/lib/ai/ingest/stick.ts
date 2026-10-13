/**
 * Tank LEVELS, parsed from however a field sheet prints them.
 *
 * A pumper's stick reading is feet-inches-quarters (`9ft 8in 2/4`, `9' 8"`,
 * `9-08-2`), and every extraction path in this app has to land on the same
 * decimal inches for the same stick, so the parsing lives here rather than in
 * whichever reader happened to need it first. `apply.ts` (the interpretation
 * executor) and the GreaseBook readers both import it.
 *
 * Pure and free of `server-only` on purpose: the GreaseBook readers are pure
 * functions over a grid, and nothing here touches a request.
 */

const STICK_RE =
  /(\d+(?:\.\d+)?)\s*(?:ft|feet|f|['’])\s*(\d+(?:\.\d+)?)\s*(?:in|inch(?:es)?|i|["”])?\s*(?:(\d+)\s*\/\s*(\d+))?/gi;

/**
 * Feet-inches-quarters written with dashes and no unit letters: `9-08-2`.
 *
 * Anchored to the WHOLE cell, and bounded to two digits of feet, two of inches
 * and one quarter, because loosening any of those makes it match a date
 * (`6-4-2026`) and file a reading against a stick that is really a calendar.
 */
const DASHED_STICK_RE = /^(\d{1,2})-(\d{1,2})-([0-3])$/;

/** A plausible tank level as a bare decimal (inches), 0-400, not part of a date. */
const DECIMAL_LEVEL_RE = /(?<![\d/-])(\d{1,3}(?:\.\d+)?)(?![\d/-])/g;

function stickMatchToInches(m: RegExpMatchArray): number {
  const feet = parseFloat(m[1]);
  const inches = parseFloat(m[2]);
  const quarters = m[3] && m[4] ? parseFloat(m[3]) / parseFloat(m[4]) : 0;
  return Number((feet * 12 + inches + quarters).toFixed(4));
}

/** Every tank-level value in a cell, in order. Prefers stick notation; falls back
 * to bare decimals only when no stick value is present (so "Run #482" digits or a
 * date don't count as levels). */
export function levelsInCell(raw: string): number[] {
  const s = raw ?? "";
  const dashed = DASHED_STICK_RE.exec(s.trim());
  if (dashed) {
    const inches = Number(dashed[2]);
    // 9-13-0 is not a stick; it is something else that happens to have dashes.
    if (inches < 12) {
      return [Number((Number(dashed[1]) * 12 + inches + Number(dashed[3]) / 4).toFixed(4))];
    }
  }
  const sticks = [...s.matchAll(STICK_RE)];
  if (sticks.length > 0) return sticks.map(stickMatchToInches);
  const decimals = [...s.matchAll(DECIMAL_LEVEL_RE)].map((m) => parseFloat(m[1]));
  return decimals.filter((n) => Number.isFinite(n));
}

/** Count of tank-level values in a cell — the domain signal for reading (1) vs
 * run (2). */
export function countLevels(raw: string): number {
  return levelsInCell(raw).length;
}

/** Convert a single stick reading to inches, or pass a plain decimal through. */
export function stickToInches(raw: string): string {
  const levels = levelsInCell(raw);
  if (levels.length === 1) return String(levels[0]);
  return raw.trim();
}
