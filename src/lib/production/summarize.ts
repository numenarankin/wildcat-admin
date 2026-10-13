import type { ProductionPoint } from "@/lib/wells/wells";

/**
 * Server-side rollup for production series handed to the AI.
 *
 * `get_production` used to return every daily row uncapped. On a well with five
 * years of history that is ~1,844 rows of up to 16 fields each — well over 100k
 * tokens in a single tool result, most of a turn's latency, and the model then
 * has to hand-aggregate it (and hand-scan it for bad gauge days, which it gets
 * approximately right at best).
 *
 * The model cannot know a well's row count before it calls, so it cannot be
 * asked to pick the right mode: the TOOL has to default safely. Short spans keep
 * full daily fidelity (pressures, choke, remarks and all), long spans roll up to
 * months, and every call carries a summary that answers the common question
 * outright without reading a single row.
 *
 * Pure and DB-free so it can be tested against a hand-computed oracle.
 */

export type Granularity = "auto" | "daily" | "monthly";
export type ResolvedGranularity = "daily" | "monthly";

/**
 * Spans at or under this many days stay daily. A quarter of dailies is ~92 rows,
 * which is a comfortable tool result; beyond that the row count is what hurts.
 */
export const DAILY_SPAN_LIMIT_DAYS = 92;

/** Cap the flagged-date list so a pathological series can't undo the savings. */
const MAX_FLAGGED_DATES = 40;

export interface ProductionSummary {
  from: string | null;
  to: string | null;
  /** Number of daily readings on file (not calendar days in the range). */
  days: number;
  /**
   * Days carrying a reading for each stream, which is what its average divides
   * by. Lower than `days` whenever the streams were measured on different days.
   */
  measuredDays: { oil: number; gas: number; water: number };
  oilTotal: number;
  gasTotal: number;
  waterTotal: number;
  oilAvgPerDay: number;
  gasAvgPerDay: number;
  oilMax: { date: string; value: number } | null;
  /**
   * Dates carrying a negative oil, gas or water volume. These are gauge or
   * allocation artifacts, never real production. Computed here so the model
   * gets an exact list instead of eyeballing thousands of rows.
   */
  negativeDays: string[];
  negativeDayCount: number;
  /** Readings where oil, gas and water are all zero (shut in, or not gauged). */
  zeroDays: number;
}

export interface MonthlyBucket {
  /** `YYYY-MM`. */
  month: string;
  days: number;
  /** Days in the month carrying an oil reading — what `oilAvgPerDay` divides by. */
  oilDays: number;
  oil: number;
  gas: number;
  water: number;
  oilAvgPerDay: number;
}

/** Volumes to 2dp, rates to 3dp: float noise is pure token waste in a payload. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function oil(p: ProductionPoint): number {
  return p.oilProduction ?? 0;
}
function gas(p: ProductionPoint): number {
  return p.gasProduction ?? 0;
}
function water(p: ProductionPoint): number {
  return p.saltWater ?? 0;
}

/**
 * Whether a row carries a measurement for a stream.
 *
 * Derived rows span the UNION of the well's oil, gas and water series, so a day
 * the gas meter was read and no tank gauged carries `oilProduction: 0`. Dividing
 * an oil total by every such row reported a well below its own rate for every
 * gas-only day in the window. Hand-entered rows have no flags: the row IS the
 * reading, so every field on it was entered together and counts.
 */
function measured(p: ProductionPoint, stream: "oil" | "gas" | "water"): boolean {
  return p.measured?.[stream] ?? true;
}

export function summarizeProduction(rows: ProductionPoint[]): ProductionSummary {
  if (rows.length === 0) {
    return {
      from: null,
      to: null,
      days: 0,
      measuredDays: { oil: 0, gas: 0, water: 0 },
      oilTotal: 0,
      gasTotal: 0,
      waterTotal: 0,
      oilAvgPerDay: 0,
      gasAvgPerDay: 0,
      oilMax: null,
      negativeDays: [],
      negativeDayCount: 0,
      zeroDays: 0,
    };
  }

  const dates = rows.map((p) => p.date).sort();
  let oilTotal = 0;
  let gasTotal = 0;
  let waterTotal = 0;
  let zeroDays = 0;
  let oilMax: { date: string; value: number } | null = null;
  const negativeDays: string[] = [];
  const measuredDays = { oil: 0, gas: 0, water: 0 };

  for (const p of rows) {
    const o = oil(p);
    const g = gas(p);
    const w = water(p);
    oilTotal += o;
    gasTotal += g;
    waterTotal += w;
    if (measured(p, "oil")) measuredDays.oil++;
    if (measured(p, "gas")) measuredDays.gas++;
    if (measured(p, "water")) measuredDays.water++;
    // A day every stream reads zero. Only counted where the day was actually
    // measured: a row that exists for one stream alone is not a shut-in day.
    if (o === 0 && g === 0 && w === 0 && measured(p, "oil")) zeroDays++;
    if (o < 0 || g < 0 || w < 0) negativeDays.push(p.date);
    // The peak is a measured day's oil, never a gas-only row's zero.
    if (measured(p, "oil") && (!oilMax || o > oilMax.value)) {
      oilMax = { date: p.date, value: o };
    }
  }

  return {
    from: dates[0],
    to: dates[dates.length - 1],
    days: rows.length,
    measuredDays,
    oilTotal: r2(oilTotal),
    gasTotal: r2(gasTotal),
    waterTotal: r2(waterTotal),
    // Each stream over the days IT was measured on, never over every row.
    oilAvgPerDay: measuredDays.oil > 0 ? r3(oilTotal / measuredDays.oil) : 0,
    gasAvgPerDay: measuredDays.gas > 0 ? r3(gasTotal / measuredDays.gas) : 0,
    oilMax: oilMax ? { date: oilMax.date, value: r2(oilMax.value) } : null,
    // Sorted so the list is stable and reads chronologically.
    negativeDays: [...negativeDays].sort().slice(0, MAX_FLAGGED_DATES),
    negativeDayCount: negativeDays.length,
    zeroDays,
  };
}

export function rollUpMonthly(rows: ProductionPoint[]): MonthlyBucket[] {
  const byMonth = new Map<string, ProductionPoint[]>();
  for (const p of rows) {
    const month = p.date.slice(0, 7);
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(p);
    else byMonth.set(month, [p]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, points]) => {
      const o = points.reduce((n, p) => n + oil(p), 0);
      // Same rule as the summary: divide by the days the tank was gauged.
      const oilDays = points.filter((p) => measured(p, "oil")).length;
      return {
        month,
        days: points.length,
        oilDays,
        oil: r2(o),
        gas: r2(points.reduce((n, p) => n + gas(p), 0)),
        water: r2(points.reduce((n, p) => n + water(p), 0)),
        oilAvgPerDay: oilDays > 0 ? r3(o / oilDays) : 0,
      };
    });
}

/** Inclusive day span between the first and last reading. */
export function spanDays(rows: ProductionPoint[]): number {
  if (rows.length === 0) return 0;
  const dates = rows.map((p) => p.date).sort();
  const first = Date.parse(`${dates[0]}T00:00:00Z`);
  const last = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`);
  if (Number.isNaN(first) || Number.isNaN(last)) return rows.length;
  return Math.round((last - first) / 86_400_000) + 1;
}

/**
 * Resolve `auto`. An explicit choice is always honoured: asking for `daily` on a
 * five-year span is a legitimate request, it just costs what it costs.
 */
export function resolveGranularity(
  rows: ProductionPoint[],
  requested: Granularity = "auto"
): ResolvedGranularity {
  if (requested !== "auto") return requested;
  return spanDays(rows) > DAILY_SPAN_LIMIT_DAYS ? "monthly" : "daily";
}
