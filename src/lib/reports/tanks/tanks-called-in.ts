/**
 * Tanks Called In report aggregation (GBC-10) — pure, no I/O.
 *
 * The pickup queue: every tank currently "called in" (a pumper phoned the
 * gatherer to schedule a crude pickup), with its stock, % fullness, gatherer,
 * and how many days it has waited. Days-since is computed against a caller-
 * supplied "today" so the function stays deterministic and testable.
 */

import { fillPercent } from "@/lib/tanks/capacity";
import type {
  CalledInTankInput,
  CalledInTankRow,
  TanksCalledInReport,
} from "@/lib/reports/tanks/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days between when a tank was called in and the report date. Both are
 * truncated to their UTC calendar day so a same-day call reads as 0 and the
 * count never depends on the time of day. Never negative (a future call-in
 * clamps to 0).
 */
export function daysSince(calledInAt: string, today: string): number {
  const then = Date.parse(calledInAt.slice(0, 10));
  const now = Date.parse(today.slice(0, 10));
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.round((now - then) / MS_PER_DAY));
}

/**
 * Build the Tanks Called In report. Input is only the tanks that are actually
 * in the queue (called_in_at set); the queue is ordered longest-waiting first
 * (then by tank name) so the most overdue pickup surfaces at the top.
 */
export function summarizeTanksCalledIn(
  tanks: CalledInTankInput[],
  today: string
): TanksCalledInReport {
  const rows: CalledInTankRow[] = tanks.map((t) => ({
    ...t,
    pctFull: fillPercent(t.stockBbls, t.capacityBbls),
    daysSinceCalledIn: daysSince(t.calledInAt, today),
  }));

  rows.sort((a, b) =>
    b.daysSinceCalledIn !== a.daysSinceCalledIn
      ? b.daysSinceCalledIn - a.daysSinceCalledIn
      : a.tankName.localeCompare(b.tankName)
  );

  return { tanks: rows, totalCalledIn: rows.length };
}
