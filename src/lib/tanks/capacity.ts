import type { TankReading } from "@/lib/tanks/tanks";

/**
 * Pure capacity / fill helpers for the Tanks UI (GBC-4).
 *
 * A tank's "current level" is the barrels of its most recent gauge reading;
 * "% full" is that level against the tank's shell capacity. Kept dependency-free
 * so the same math backs the list summary, the detail header, and unit tests —
 * mirroring how `strapping.ts` isolates the inch→bbl conversion.
 */

/** A reading's sortable timestamp (`YYYY-MM-DDTHH:MM`), for ordering. */
function stamp(r: TankReading): string {
  return `${r.date}T${r.time || "00:00"}`;
}

/**
 * The most recent reading in a list, or null when empty. Independent of input
 * order (`listTankReadings` returns oldest-first, but callers shouldn't rely on
 * it) — the max timestamp wins.
 */
export function latestReading(readings: TankReading[]): TankReading | null {
  let latest: TankReading | null = null;
  for (const r of readings) {
    if (!latest || stamp(r) >= stamp(latest)) latest = r;
  }
  return latest;
}

/** Current barrels in the tank — the latest reading's derived bbls, or 0. */
export function currentLevelBbls(readings: TankReading[]): number {
  const r = latestReading(readings);
  return r ? r.bbls : 0;
}

/**
 * Combined shell capacity of a battery's tanks of ONE product — the ceiling that
 * product's Level chart draws, against a stock series that sums those same tanks.
 *
 * Null unless every one of them is sized. A sum over only the tanks that carry
 * a capacity sits BELOW the real ceiling, so a battery holding a normal amount
 * of oil would plot above its own "max" line and read as an overfill that never
 * happened. The other product's tanks are excluded because its stock series
 * excludes them (`batteryLevelSeries` takes the same product); counting their
 * shells would inflate the ceiling.
 */
export function capacityTotal(
  tanks: { product: string; capacityBbls: number | null }[],
  product: "oil" | "water"
): number | null {
  const of = tanks.filter((t) => t.product === product);
  if (of.length === 0) return null;
  let total = 0;
  for (const t of of) {
    if (t.capacityBbls == null || !Number.isFinite(t.capacityBbls)) return null;
    total += t.capacityBbls;
  }
  return total > 0 ? total : null;
}

/** {@link capacityTotal} for oil — the battery Level chart's original ceiling. */
export function oilCapacityTotal(
  tanks: { product: string; capacityBbls: number | null }[]
): number | null {
  return capacityTotal(tanks, "oil");
}

/**
 * Percent full (0–100) of `bbls` against `capacity`, or null when the capacity
 * is unknown / non-positive (so the UI shows "—" rather than a bogus number).
 * Clamped to [0, 100]; a reading above capacity reads as 100%.
 */
export function fillPercent(
  bbls: number,
  capacity: number | null | undefined
): number | null {
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0) {
    return null;
  }
  if (!Number.isFinite(bbls) || bbls <= 0) return 0;
  return Math.min(100, (bbls / capacity) * 100);
}
