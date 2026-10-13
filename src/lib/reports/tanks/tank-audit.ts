/**
 * Tank Measurement Audit report aggregation (GBC-10) — pure, no I/O.
 *
 * From the `tank_readings` audit columns (created / updated / deleted by + at),
 * builds one audited row per gauge entry — who touched it and when — resolving
 * the auth user ids to display names via a caller-supplied lookup. Soft-deleted
 * readings are included (that's the point of the audit), so the caller loads
 * rows without the usual `deleted_at is null` filter.
 */

import { BLANK_CELL } from "@/lib/export/columns";
import type {
  AuditStatus,
  TankAuditReadingInput,
  TankAuditReport,
  TankAuditRow,
} from "@/lib/reports/tanks/types";

/**
 * A reading's lifecycle state from its audit columns. `updated_at` is stamped by
 * a trigger on every write (so it's non-null from insert on) — a real edit is
 * distinguished by `updated_by`, which only `updateTankReading` sets.
 */
function statusOf(r: TankAuditReadingInput): AuditStatus {
  if (r.deletedAt) return "deleted";
  if (r.updatedBy) return "edited";
  return "active";
}

/** Most-recent audit activity on a reading (delete > edit > create). */
function lastActivityAt(r: TankAuditReadingInput): string {
  if (r.deletedAt) return r.deletedAt;
  if (r.updatedBy && r.updatedAt) return r.updatedAt;
  return r.createdAt;
}

/**
 * Build the Tank Measurement Audit report. `nameByUserId` maps an auth user id
 * to a display name (name or email); unknown / null ids render as `BLANK_CELL`. Rows are
 * ordered by most-recent activity first so the latest edits and deletes lead.
 */
export function summarizeTankAudit(
  readings: TankAuditReadingInput[],
  nameByUserId: Record<string, string>
): TankAuditReport {
  const name = (id: string | null): string =>
    id ? (nameByUserId[id] ?? BLANK_CELL) : BLANK_CELL;

  // Pair each row with its sort key (last activity) so the comparator is O(1).
  const withKey = readings.map((r) => ({
    row: {
      readingId: r.readingId,
      battery: r.battery,
      tankName: r.tankName,
      readingDate: r.readingDate,
      gauge: r.gauge,
      bbls: r.bbls,
      status: statusOf(r),
      createdBy: name(r.createdBy),
      createdAt: r.createdAt,
      updatedBy: r.updatedBy ? name(r.updatedBy) : null,
      updatedAt: r.updatedBy ? r.updatedAt : null,
      deletedBy: r.deletedBy ? name(r.deletedBy) : null,
      deletedAt: r.deletedAt,
    } satisfies TankAuditRow,
    key: lastActivityAt(r),
  }));

  withKey.sort((a, b) =>
    a.key === b.key
      ? a.row.tankName.localeCompare(b.row.tankName)
      : a.key < b.key
        ? 1
        : -1
  );
  const rows: TankAuditRow[] = withKey.map((w) => w.row);

  return {
    rows,
    totalEntries: rows.length,
    editedEntries: rows.filter((r) => r.status === "edited").length,
    deletedEntries: rows.filter((r) => r.status === "deleted").length,
  };
}
