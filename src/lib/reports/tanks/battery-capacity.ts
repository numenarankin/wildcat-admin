/**
 * Battery Capacity report aggregation (GBC-10) — pure, no I/O.
 *
 * Turns the tank roster + current barrels into per-tank capacity-vs-used rows
 * (inches and barrels, with % full), grouped into per-battery summaries plus a
 * company total. Reuses `fillPercent` so the report's fill math matches the
 * Tanks page. Dependency-free → unit-testable without a database.
 */

import { fillPercent } from "@/lib/tanks/capacity";
import type { TankProduct } from "@/lib/tanks/tanks";
import type {
  BatteryCapacityGroup,
  BatteryCapacityReport,
  BatteryCapacityTank,
} from "@/lib/reports/tanks/types";

/** Minimal tank shape the capacity report needs. */
export interface CapacityTankRef {
  id: string;
  name: string;
  product: TankProduct;
  /** Battery / facility grouping, "" for standalone. */
  battery: string;
  /** Linear strapping factor: barrels per inch of gauge. */
  bblPerInch: number;
  capacityBbls: number | null;
}

/** Inches for a barrel figure at a tank's strapping factor, or null. */
function toInches(bbls: number | null, bblPerInch: number): number | null {
  if (bbls == null) return null;
  if (!Number.isFinite(bblPerInch) || bblPerInch <= 0) return null;
  return bbls / bblPerInch;
}

/**
 * Build the Battery Capacity report from the tank roster and each tank's
 * current barrels (latest gauge; absent = 0).
 *
 * Every tank appears under its battery (standalone tanks group under "" — the
 * UI labels that). Per battery, capacity and used barrels are summed (tanks
 * with no recorded capacity contribute 0 to capacity but still show their used
 * volume). Batteries are ordered by name; tanks within a battery by name.
 */
export function summarizeBatteryCapacity(
  tanks: CapacityTankRef[],
  currentBblsByTank: Record<string, number>
): BatteryCapacityReport {
  const byBattery = new Map<string, BatteryCapacityTank[]>();

  for (const t of tanks) {
    const usedBbls = currentBblsByTank[t.id] ?? 0;
    const row: BatteryCapacityTank = {
      tankId: t.id,
      tankName: t.name,
      product: t.product,
      capacityBbls: t.capacityBbls,
      usedBbls,
      capacityInches: toInches(t.capacityBbls, t.bblPerInch),
      usedInches: toInches(usedBbls, t.bblPerInch) ?? 0,
      pctFull: fillPercent(usedBbls, t.capacityBbls),
    };
    const list = byBattery.get(t.battery);
    if (list) list.push(row);
    else byBattery.set(t.battery, [row]);
  }

  const batteries: BatteryCapacityGroup[] = [...byBattery.entries()]
    .map(([battery, rows]) => {
      rows.sort((a, b) => a.tankName.localeCompare(b.tankName));
      const capacityBbls = rows.reduce((s, r) => s + (r.capacityBbls ?? 0), 0);
      const usedBbls = rows.reduce((s, r) => s + r.usedBbls, 0);
      return {
        battery,
        tanks: rows,
        capacityBbls,
        usedBbls,
        pctFull: fillPercent(usedBbls, capacityBbls || null),
      };
    })
    .sort((a, b) => a.battery.localeCompare(b.battery));

  const totalCapacityBbls = batteries.reduce((s, b) => s + b.capacityBbls, 0);
  const totalUsedBbls = batteries.reduce((s, b) => s + b.usedBbls, 0);

  return {
    batteries,
    totalCapacityBbls,
    totalUsedBbls,
    pctFull: fillPercent(totalUsedBbls, totalCapacityBbls || null),
  };
}

/** Flatten the report to one row per tank (battery included) for exports. */
export function batteryCapacityRows(
  report: BatteryCapacityReport
): (BatteryCapacityTank & { battery: string })[] {
  return report.batteries.flatMap((b) =>
    b.tanks.map((t) => ({ ...t, battery: b.battery }))
  );
}
