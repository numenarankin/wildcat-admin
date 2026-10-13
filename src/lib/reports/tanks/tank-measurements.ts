/**
 * Tank Measurements raw listing (GBC-10) — pure, no I/O.
 *
 * The GreaseBook `TankMeasurementsReport` analog: every gauge reading in the org
 * as a flat chronological log, grouped per tank, with the change in barrels from
 * each tank's previous reading. Unlike the Tank Measurement Audit (who edited
 * what), this is the plain field log of what was gauged and when.
 *
 * Ordering is battery, then tank name, then reading moment (date + time)
 * ascending, so each tank's readings read top-to-bottom in the order they were
 * taken and the per-tank `changeBbls` delta lines up with that order.
 */

import type {
  TankMeasurementInput,
  TankMeasurementRow,
  TankMeasurementsReport,
} from "@/lib/reports/tanks/types";

/** The moment of a reading as a sortable `YYYY-MM-DD HH:MM` key (blank time last-of-day). */
function momentKey(r: TankMeasurementInput): string {
  // A blank time sorts before any real clock time on the same date, which keeps
  // an untimed reading ahead of timed ones taken later that day — deterministic
  // either way; the delta simply chains in whatever order the moments imply.
  return `${r.readingDate} ${r.readingTime || "00:00"}`;
}

/**
 * Build the raw Tank Measurements report. Readings may arrive in any order; they
 * are grouped by tank and sorted by reading moment so `changeBbls` is the barrel
 * delta from the immediately-prior reading on the same tank (null for the first).
 */
export function summarizeTankMeasurements(
  readings: TankMeasurementInput[]
): TankMeasurementsReport {
  // Group by tank id, preserving each tank's first-seen display fields.
  const byTank = new Map<string, TankMeasurementInput[]>();
  for (const r of readings) {
    const list = byTank.get(r.tankId);
    if (list) list.push(r);
    else byTank.set(r.tankId, [r]);
  }

  const rows: TankMeasurementRow[] = [];
  for (const list of byTank.values()) {
    const sorted = [...list].sort((a, b) =>
      momentKey(a) < momentKey(b) ? -1 : momentKey(a) > momentKey(b) ? 1 : 0
    );
    let prev: number | null = null;
    for (const r of sorted) {
      rows.push({ ...r, changeBbls: prev == null ? null : r.bbls - prev });
      prev = r.bbls;
    }
  }

  // Global ordering for display: battery, then tank name, then moment.
  rows.sort(
    (a, b) =>
      a.battery.localeCompare(b.battery) ||
      a.tankName.localeCompare(b.tankName) ||
      (momentKey(a) < momentKey(b) ? -1 : momentKey(a) > momentKey(b) ? 1 : 0)
  );

  return {
    rows,
    totalReadings: rows.length,
    tankCount: byTank.size,
  };
}
