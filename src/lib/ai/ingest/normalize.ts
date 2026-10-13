/**
 * Canonical-key normalization for ingest dedup. Shared by the write-layer dedup
 * in `dispatchWrite` and device resolution so "Tank No. 7", "Tank #7", and
 * "tank 7" all collapse to one key. Pure module (no imports) — safe to unit-test
 * and to import from anywhere.
 *
 * The whole leave-it-alone behavior rides on this: two records with equal
 * canonical keys are the SAME record (skip / enrich); a key that survives
 * canonicalization unchanged is genuinely different (insert in full). See
 * docs/plans/data-entry-write-coverage.md.
 */

/**
 * Reduce a value to a canonical form for equality: lowercased, "No."/"No"/
 * "Number"/"#" identifier tokens dropped, punctuation and symbols folded to
 * single spaces, surrounding/internal whitespace collapsed.
 */
export function canonical(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .toLowerCase()
    // Drop identifier words: "no", "no.", "number" (as whole words).
    .replace(/\b(?:no|number)\b\.?/g, " ")
    // Everything non-alphanumeric (incl. "#", punctuation) becomes a space.
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Canonical key for a pure-numeric identifier (a tank/meter number): after
 * `canonical`, if what remains is all digits, strip leading zeros so "07" and
 * "7" match. Non-numeric refs fall back to `canonical` unchanged.
 */
export function canonicalId(value: string | null | undefined): string {
  const c = canonical(value);
  const digits = c.replace(/\s+/g, "");
  return /^\d+$/.test(digits) ? String(Number(digits)) : c;
}

/** Compose a multi-part canonical key (e.g. name + phone), pipe-joined. */
export function canonicalKey(
  ...parts: (string | null | undefined)[]
): string {
  return parts.map((p) => canonical(p)).join("|");
}
