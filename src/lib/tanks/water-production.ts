/**
 * Haul-aware saltwater production — disposal / SWD tanks ONLY.
 *
 * Water accumulates in the tank and leaves only via a haul, so the governing
 * assumption is that 100% of the water produced between two hauls is accounted
 * for by the LATER haul's barrels. Unlike the oil level series (`tank-series`),
 * where a haul is excluded from production, here a haul is a first-class producer:
 * it closes out and books the production of the interval that ends at it.
 *
 * The series is built from the tank's readings (gauge level, in barrels) and its
 * hauls (barrels removed + the post-haul closing level), sorted in time. Each
 * adjacent anchor pair yields one production segment, by kind:
 *
 *   reading → reading   L2 − L1                 (measured level rise)
 *   reading → haul      max(0, H − L)           (fill from the last reading to the
 *                                                haul: the haul's barrels minus the
 *                                                tank level at that reading)
 *   haul → reading      max(0, L − close)       (fill after the haul, measured off
 *                                                the haul's closing level, 0 if none)
 *   haul → haul         H                       (no readings between → the whole
 *                                                interval's production is the later
 *                                                haul's barrels)
 *
 * Each segment's rate is `bbls / hours × 24`. There is no segment after the last
 * anchor, so the period following the final haul (with no later reading) shows
 * nothing — production there is not yet accounted for by a haul. Negative gaps are
 * clamped to 0 (a reading exceeding the later haul shouldn't happen).
 *
 * Pure and dependency-light so the tank page re-derives live as readings/hauls are
 * edited, and it unit-tests without a database.
 */

import { anchorMs } from "@/lib/tanks/tank-series";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A haul missing a departure time sorts to this hour on its date (matches `tank-series`). */
const DEFAULT_HAUL_TIME = "23:59";

/** ISO `YYYY-MM-DD` (UTC) for an epoch ms. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A reading reduced to what the water series needs (structurally a `TankReading`). */
export interface WaterReading {
  date: string;
  time: string;
  /** Derived tank level in barrels at gauge time. */
  bbls: number;
}

/** A haul reduced to what the water series needs. */
export interface WaterHaul {
  date: string;
  /** `HH:MM`, or "" when unknown (falls back to {@link DEFAULT_HAUL_TIME}). */
  departureTime: string;
  /** Barrels removed by the haul (open − close × factor, or the manual gross). */
  hauledBbls: number;
  /** Tank level (barrels) LEFT after the haul (closing gauge × factor); 0 if none. */
  closeBbls: number;
}

export interface WaterProductionPoint {
  /** ISO `YYYY-MM-DD` (UTC) — one calendar day. */
  date: string;
  /** Barrels of saltwater attributed to the day (= the day's rate for a full day). */
  bbls: number;
  /** Production rate for the interval covering this day, `bbls / hours × 24`. */
  bblPerDay: number;
}

type AnchorKind = "reading" | "haul";

interface Anchor {
  tMs: number;
  kind: AnchorKind;
  /** Reading level (barrels); 0 for a haul. */
  level: number;
  /** Barrels hauled; 0 for a reading. */
  hauled: number;
  /** Post-haul level (barrels); 0 for a reading or a haul with no closing gauge. */
  close: number;
}

/**
 * Build the haul-aware production series as a DAILY series: one point for every
 * calendar day between the first and last event (readings + hauls), oldest first.
 * Each interval's rate is spread flat across every day it covers. A day where an
 * event lands mid-day is owned by the EARLIER interval (the one ending at that
 * event), via first-writer-wins, so the boundary day reflects the production
 * leading up to the event.
 */
export function waterTankProduction(
  readings: WaterReading[],
  hauls: WaterHaul[]
): WaterProductionPoint[] {
  const anchors: Anchor[] = [];
  for (const r of readings) {
    anchors.push({
      tMs: anchorMs(r.date, r.time),
      kind: "reading",
      level: r.bbls,
      hauled: 0,
      close: 0,
    });
  }
  for (const h of hauls) {
    anchors.push({
      tMs: anchorMs(h.date, h.departureTime || DEFAULT_HAUL_TIME),
      kind: "haul",
      level: 0,
      hauled: h.hauledBbls,
      close: h.closeBbls,
    });
  }

  // Sort in time; at one instant a reading is the PRE-haul level, so it precedes a
  // haul (matches the oil series' reading-before-run ordering).
  const order: Record<AnchorKind, number> = { reading: 0, haul: 1 };
  anchors.sort((a, b) => a.tMs - b.tMs || order[a.kind] - order[b.kind]);

  // Spread each interval's rate across every calendar day it spans. First-writer-
  // wins on a shared boundary day, so the earlier (ending) interval owns it.
  const rateByDay = new Map<string, number>();
  for (let i = 1; i < anchors.length; i++) {
    const from = anchors[i - 1];
    const to = anchors[i];

    let bbls: number;
    if (from.kind === "reading" && to.kind === "reading") {
      bbls = to.level - from.level;
    } else if (from.kind === "reading" && to.kind === "haul") {
      bbls = Math.max(0, to.hauled - from.level);
    } else if (from.kind === "haul" && to.kind === "reading") {
      bbls = Math.max(0, to.level - from.close);
    } else {
      // haul → haul: the later haul's barrels account for the whole interval.
      bbls = to.hauled;
    }

    const hours = (to.tMs - from.tMs) / HOUR_MS;
    const rate = hours > 0 ? (bbls / hours) * 24 : 0;

    const startMs = anchorMs(dayKey(from.tMs), "00:00");
    const endMs = anchorMs(dayKey(to.tMs), "00:00");
    for (let d = startMs; d <= endMs; d += DAY_MS) {
      const key = dayKey(d);
      if (!rateByDay.has(key)) rateByDay.set(key, rate);
    }
  }

  return [...rateByDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, rate]) => ({ date, bbls: rate, bblPerDay: rate }));
}
