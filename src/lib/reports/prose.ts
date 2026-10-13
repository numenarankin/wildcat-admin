/**
 * Report prose hygiene.
 *
 * Report copy carries NO em dashes or en dashes (owner preference, 2026-07-26).
 * The static copy is written that way by hand; model-written copy cannot be, so
 * this is the enforcement half. Every AI narrative that lands in a report is run
 * through {@link stripEmDashes} on the way out, because a prompt that says "do
 * not use em dashes" is a request and a function is a guarantee, and the model
 * reaches for them constantly.
 *
 * Pure, no I/O, unit-testable.
 */

/**
 * Replace em/en dashes with punctuation that reads the same way.
 *
 * A dash between figures is a RANGE ("5–10 bbl" becomes "5 to 10 bbl"); anywhere
 * else it is doing the job of a comma, so it becomes one. Doubled-up punctuation
 * from either substitution is collapsed, so the result never reads as though a
 * character was deleted from a sentence.
 */
export function stripEmDashes(text: string): string {
  return (
    text
      // "5–10" / "5 — 10": a range between numbers.
      .replace(/(\d)\s*[—–]\s*(\d)/g, "$1 to $2")
      // Any other dash is standing in for a comma.
      .replace(/\s*[—–]\s*/g, ", ")
      // "x, , y" (a dash that already followed a comma) and ", ." / ", ;"
      .replace(/,\s*,/g, ",")
      .replace(/,\s*([.;:!?])/g, "$1")
      // A dash that ended the text leaves a dangling comma.
      .replace(/,\s*$/, "")
      .trim()
  );
}

/** True when `text` is free of em and en dashes (for tests and assertions). */
export function hasNoDashes(text: string): boolean {
  return !/[—–]/.test(text);
}
