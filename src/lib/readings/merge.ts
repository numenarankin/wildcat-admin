/**
 * Shared pieces of the LAST-WINS reading merge, used wherever a document can
 * re-report a slot that is already on file (well production readings, disposal
 * readings). Pure: no I/O, no Supabase, so it tests on its own.
 *
 * The rule both writers follow: a source that is SILENT about a field is not
 * asserting zero, so only the fields it actually reported may overwrite what is
 * stored. That is why a merge exists at all instead of a plain insert.
 */

/**
 * A reading's uniqueness slot: `HH:MM:SS`, however the time was written.
 *
 * Postgres hands back `08:00:00` where the app wrote `08:00`, and a blank time
 * is pinned to midnight because the (entity, date, time) unique key cannot match
 * on NULL. Without one spelling on both sides an incumbent row is invisible to
 * the merge, and the upsert collides with it instead of updating it.
 */
export function readingSlot(time: string | null | undefined): string {
  const [h = "", m = "", s = ""] = String(time ?? "").split(":");
  if (!h.trim()) return "00:00:00";
  const pad = (v: string, fallback: string) =>
    (v.trim() || fallback).padStart(2, "0");
  return `${pad(h, "00")}:${pad(m, "00")}:${pad(s, "00")}`;
}

/** Whether a stored column value already equals the one a source reported. */
export function sameValue(stored: unknown, reported: number | string): boolean {
  if (stored == null) return false;
  return typeof reported === "number"
    ? Number(stored) === reported
    : String(stored) === reported;
}
