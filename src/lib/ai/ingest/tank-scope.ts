import { canonical } from "@/lib/ai/ingest/normalize";

/**
 * Tank-scoping for "Add History" uploads. A tank-scoped upload targets ONE tank,
 * but the file often holds several tanks' data (separate sheets/sections, or a
 * Tank column). Each extracted row carries its own `tankRef`; these helpers keep
 * only the rows that belong to the pinned workspace tank and drop the rest, so a
 * neighbor's data can never be mislabeled as this tank. Pure module (no server
 * deps) so it is unit-testable.
 */

/**
 * The tank number embedded in a ref ("Tank #486290 (52.39% full)" → "486290"),
 * leading zeros stripped; "" when the ref has no digits. This is the signal that
 * distinguishes tanks whose names differ only by number (486289 vs 486290).
 *
 * Takes the LONGEST digit run (ties → the first), NOT the last: a printed tank
 * label routinely carries trailing noise like a "(54.48% full)" fill percentage,
 * and the 6-digit tank number must win over those 2-digit fragments.
 */
export function refNumber(ref: string): string {
  const runs = ref.match(/\d+/g);
  if (!runs) return "";
  let best = "";
  for (const r of runs) if (r.length > best.length) best = r;
  const stripped = best.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

/**
 * Does a row's printed tank ref denote the SAME tank as the pinned workspace?
 * Matches on the embedded number first (robust across "Tank #486290" vs a tank
 * named "Roach Parrot 486290"), then on the canonical name as a fallback.
 */
export function refDenotesPinned(ref: string, pinnedRef: string): boolean {
  const a = refNumber(ref);
  const b = refNumber(pinnedRef);
  if (a !== "" && b !== "") return a === b;
  const c = canonical(ref);
  return c !== "" && c === canonical(pinnedRef);
}

/**
 * Keep only rows for the pinned tank, normalizing their `tankRef` to the pinned
 * tank's name for display:
 *   • a row with NO tank ref belongs to the pinned tank by default → keep;
 *   • a row whose ref denotes the pinned tank → keep;
 *   • a row whose ref denotes a DIFFERENT tank → DROP.
 */
export function scopeRowsToPinnedTank(rows: unknown[], pinnedRef: string): unknown[] {
  const kept: unknown[] = [];
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    const ref = typeof row.tankRef === "string" ? row.tankRef.trim() : "";
    if (!ref || refDenotesPinned(ref, pinnedRef)) {
      kept.push({ ...row, tankRef: pinnedRef });
    }
  }
  return kept;
}

/** The tank identity a row's ref denotes — its number, else its canonical name,
 * else "" for a ref-less row. Two labels for the same tank collapse to one key. */
function tankKey(ref: string): string {
  return refNumber(ref) || canonical(ref);
}

/**
 * How many DISTINCT tanks these rows name (by {@link tankKey}). Ref-less rows are
 * ignored. 0 or 1 means the data is unambiguously a single tank — the case where
 * the strict same-tank filter is too aggressive.
 */
export function distinctTankCount(rows: unknown[]): number {
  const keys = new Set<string>();
  for (const r of rows) {
    const ref =
      typeof (r as Record<string, unknown>).tankRef === "string"
        ? ((r as Record<string, unknown>).tankRef as string).trim()
        : "";
    if (ref) keys.add(tankKey(ref));
  }
  return keys.size;
}

/**
 * Keep EVERY row, normalizing its `tankRef` to the pinned tank. Used when the
 * upload is unambiguously one tank (a single file naming at most one tank): the
 * user explicitly pinned this file to a tank, so its rows belong here even when
 * the file's printed label differs from the tank's name. The multi-tank guard
 * ({@link scopeRowsToPinnedTank}) only needs to bite when a file really holds
 * several tanks.
 */
export function forceRowsToPinnedTank(
  rows: unknown[],
  pinnedRef: string
): unknown[] {
  return rows.map((r) => ({ ...(r as Record<string, unknown>), tankRef: pinnedRef }));
}
