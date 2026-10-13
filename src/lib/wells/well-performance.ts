/**
 * Well Test Report aggregation (GBC-11) — pure, no I/O.
 *
 * Turns each well's tests + downtime into one performance row: the latest test's
 * per-day rates, derived GOR / %oil / %water, those rates extrapolated to a
 * month, and the well's online vs downtime days over a trailing window. The
 * test's freshness (`fresh` / `stale` / `none`) is exactly what the weighted
 * allocation engine keys off, so the report flags which wells weighted
 * allocation can actually weight and which fall back to their fixed split.
 *
 * Dependency-free (types + the well-test / well-event derivations) so it
 * unit-tests without a database; the report loader and export route both build
 * on it, keeping the on-screen table and the CSV/XLSX/PDF exports in lock-step.
 */

import {
  gor,
  latestTestAsOf,
  pctOil,
  pctWater,
  testGasRate,
  testRate,
  type WellTest,
} from "@/lib/wells/well-tests";
import {
  daysInclusive,
  onlineDays,
  type WellEvent,
} from "@/lib/wells/well-events";
import { DEFAULT_FRESHNESS_DAYS } from "@/lib/tanks/weighted";

/** A minimal well descriptor — just what the roll-up needs. */
export interface PerformanceWellRef {
  id: string;
  name: string;
}

/** Whether the latest test is usable by weighted allocation as of the window. */
export type TestFreshness = "fresh" | "stale" | "none";

/** One well's performance row. */
export interface WellPerformanceRow {
  wellId: string;
  wellName: string;
  /** Latest test date on/before the window end, or null. */
  testDate: string | null;
  /** Latest test's per-day oil / gas / water rates, or null when no test. */
  oilRate: number | null;
  gasRate: number | null;
  waterRate: number | null;
  /** Derived from the latest test (null when undefined). */
  gor: number | null;
  pctOil: number | null;
  pctWater: number | null;
  /** Latest rates extrapolated to `extrapolateDays` (a month by default). */
  extrapOilBbls: number | null;
  extrapGasMcf: number | null;
  extrapWaterBbls: number | null;
  /** Online / downtime days over the trailing window. */
  onlineDays: number;
  downtimeDays: number;
  /** Whether the latest test is fresh / stale / absent for weighted allocation. */
  freshness: TestFreshness;
}

/** The Well Test Report: per-well rows plus window metadata + totals. */
export interface WellPerformanceReport {
  rows: WellPerformanceRow[];
  /** Window end (as-of date), ISO `YYYY-MM-DD`. */
  asOf: string;
  /** Trailing window length in days (for online/downtime). */
  windowDays: number;
  /** Days a test's rate is extrapolated over (a month by default). */
  extrapolateDays: number;
  /** Company extrapolated totals (sum of the per-well extrapolations). */
  totalExtrapOilBbls: number;
  totalExtrapGasMcf: number;
}

/** Options for building the report (all defaulted). */
export interface WellPerformanceOptions {
  /** Window end; defaults handled by the caller (server passes today). */
  asOf: string;
  /** Trailing window for online/downtime days (default 30). */
  windowDays?: number;
  /** Test freshness window in days (default matches the engine's). */
  freshnessDays?: number;
  /** Days to extrapolate the daily rate over (default 30). */
  extrapolateDays?: number;
}

/** Shift an ISO date by `deltaDays` (may be negative), returning ISO. */
function shiftDate(iso: string, deltaDays: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function nullableProduct(rate: number | null, days: number): number | null {
  return rate == null ? null : rate * days;
}

/**
 * Build the Well Test Report. Every well appears (even with no test, so
 * the roster is complete). For each: the latest test on/before `asOf` supplies
 * the rates + GOR / %oil / %water; those rates extrapolate to `extrapolateDays`;
 * downtime/shut-in over the trailing `[asOf − windowDays + 1, asOf]` window
 * gives online vs downtime days. Rows are ordered by extrapolated oil desc, then
 * by name. Company totals sum the extrapolated volumes.
 */
export function summarizeWellPerformance(
  wells: PerformanceWellRef[],
  tests: WellTest[],
  events: WellEvent[],
  opts: WellPerformanceOptions
): WellPerformanceReport {
  const asOf = opts.asOf;
  const windowDays = opts.windowDays ?? 30;
  const freshnessDays = opts.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;
  const extrapolateDays = opts.extrapolateDays ?? 30;
  const from = shiftDate(asOf, -(windowDays - 1));

  const testsByWell = new Map<string, WellTest[]>();
  for (const t of tests)
    (testsByWell.get(t.wellId) ?? testsByWell.set(t.wellId, []).get(t.wellId)!)
      .push(t);
  const eventsByWell = new Map<string, WellEvent[]>();
  for (const e of events)
    (eventsByWell.get(e.wellId) ??
      eventsByWell.set(e.wellId, []).get(e.wellId)!).push(e);

  const rows: WellPerformanceRow[] = wells.map((w) => {
    const wellTests = testsByWell.get(w.id) ?? [];
    const wellEvents = eventsByWell.get(w.id) ?? [];
    const test = latestTestAsOf(wellTests, asOf);

    const online = onlineDays(wellEvents, from, asOf);
    // Share of the window the well was online, used to extrapolate below. Guards
    // a zero-length window (and a fleet with no events reads 1).
    const uptime = windowDays > 0 ? Math.min(1, online / windowDays) : 1;
    const windowLen = daysInclusive(from, asOf);

    let freshness: TestFreshness = "none";
    if (test) {
      const age = daysInclusive(test.testDate, asOf) - 1;
      freshness = age <= freshnessDays ? "fresh" : "stale";
    }

    const oilRate = test ? testRate(test, "oil") : null;
    const gasRate = test ? testGasRate(test) : null;
    const waterRate = test ? testRate(test, "water") : null;

    return {
      wellId: w.id,
      wellName: w.name,
      testDate: test?.testDate ?? null,
      oilRate,
      gasRate,
      waterRate,
      gor: test ? gor(test) : null,
      pctOil: test ? pctOil(test) : null,
      pctWater: test ? pctWater(test) : null,
      /*
       * Extrapolated over the days the well is actually expected to RUN.
       *
       * A test rate is a producing-day rate. Multiplying it by a whole month
       * gave a well that was down half the window the same monthly volume as one
       * that never stopped, and the company total below is the sum of these —
       * so it could not be reconciled against measured production. The window's
       * uptime is the best available estimate of how much of the next month the
       * well will be online; a well with no downtime recorded extrapolates
       * whole, exactly as before.
       */
      extrapOilBbls: nullableProduct(oilRate, extrapolateDays * uptime),
      extrapGasMcf: nullableProduct(gasRate, extrapolateDays * uptime),
      extrapWaterBbls: nullableProduct(waterRate, extrapolateDays * uptime),
      onlineDays: online,
      downtimeDays: Math.max(0, windowLen - online),
      freshness,
    };
  });

  rows.sort((a, b) => {
    const ao = a.extrapOilBbls ?? -1;
    const bo = b.extrapOilBbls ?? -1;
    return bo !== ao ? bo - ao : a.wellName.localeCompare(b.wellName);
  });

  return {
    rows,
    asOf,
    windowDays,
    extrapolateDays,
    totalExtrapOilBbls: rows.reduce((s, r) => s + (r.extrapOilBbls ?? 0), 0),
    totalExtrapGasMcf: rows.reduce((s, r) => s + (r.extrapGasMcf ?? 0), 0),
  };
}
