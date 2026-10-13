import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { cachedMeters, cachedWellBatteries, cachedWellMeters } from "@/lib/cache/loaders";
import { formatHandle, type Handle } from "./handles";
import { MEASURABLE, measure, type Metric } from "./measure";

/**
 * `coverage`: where the data is thin for the question being asked.
 *
 * The failure this exists to prevent is confident arithmetic over a hole. A well
 * with three months of readings in a twelve-month window will produce a trailing
 * average, a decline fit and a percentile rank, all of them arithmetically
 * correct and all of them describing a quarter of the year.
 *
 * Two different absences, kept apart because the remedy differs:
 *
 *   NOT WIRED     nothing upstream measures this metric for this entity. No
 *                 amount of data entry fixes it; somebody has to link the well
 *                 to a battery or a meter.
 *   NOT RECORDED  the path exists and the days are missing. Somebody has to
 *                 enter readings, or they were never taken.
 *
 * Reporting both as "no data" is what lets an answer say a well stopped
 * producing when in truth it was never connected to anything.
 */

type Sb = SupabaseClient;

export interface MetricCoverage {
  metric: Metric;
  /** Days in the window carrying a point. */
  daysWithData: number;
  /** Days in the requested window. */
  windowDays: number;
  fraction: number;
  firstDate: string | null;
  lastDate: string | null;
  /** `YYYY-MM` months inside the window with no data at all. */
  emptyMonths: string[];
  status: "good" | "partial" | "not recorded" | "not wired";
}

export interface CoverageResult {
  handle: string;
  from: string;
  to: string;
  metrics: MetricCoverage[];
  wiring?: { batteries: number; gasMeters: number; meters: number };
  note?: string;
}

const MS_PER_DAY = 86_400_000;

/** Every `YYYY-MM` touched by an inclusive day window. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(endYear)) return out;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    if (out.length > 1200) break; // a century, as a runaway guard
  }
  return out;
}

/** Inclusive day count. */
export function windowDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

/**
 * Grade one metric's coverage.
 *
 * `wired` is passed in rather than inferred from emptiness, because that is the
 * whole distinction the caller needs and an empty series cannot tell you which
 * of the two it is.
 */
export function gradeCoverage(
  metric: Metric,
  days: string[],
  from: string,
  to: string,
  wired: boolean
): MetricCoverage {
  const span = windowDays(from, to);
  const unique = [...new Set(days)].sort();
  const withData = unique.length;
  const seen = new Set(unique.map((d) => d.slice(0, 7)));
  const emptyMonths = monthsBetween(from, to).filter((m) => !seen.has(m));
  const fraction = span > 0 ? withData / span : 0;

  const status: MetricCoverage["status"] = !wired
    ? "not wired"
    : withData === 0
      ? "not recorded"
      : fraction >= 0.9
        ? "good"
        : "partial";

  return {
    metric,
    daysWithData: withData,
    windowDays: span,
    fraction: Number(fraction.toFixed(3)),
    firstDate: unique[0] ?? null,
    lastDate: unique[unique.length - 1] ?? null,
    emptyMonths,
    status,
  };
}

export async function coverage(
  sb: Sb,
  handle: Handle,
  from: string,
  to: string
): Promise<CoverageResult> {
  const metrics = (Object.keys(MEASURABLE) as Metric[]).filter((m) =>
    MEASURABLE[m].includes(handle.type)
  );

  // For a well, "wired" is a fact about its membership and is knowable without
  // reading a single measurement.
  //
  // Meter membership is NOT substance-filtered — `listWellMeters` returns every
  // meter the well is allocated on — so the gas count has to be narrowed to gas
  // meters here. Counting a water meter as gas wiring would report a well as
  // merely unread when in truth nothing measures its gas at all.
  let wiring: { batteries: number; gasMeters: number; meters: number } | undefined;
  if (handle.type === "well") {
    const [batteries, meterIds, allMeters] = await Promise.all([
      cachedWellBatteries(sb, handle.id),
      cachedWellMeters(sb, handle.id),
      cachedMeters(sb, "all"),
    ]);
    const substanceById = new Map(allMeters.map((m) => [m.id, m.substance]));
    wiring = {
      batteries: batteries.length,
      gasMeters: meterIds.filter((id) => substanceById.get(id) === "gas").length,
      meters: meterIds.length,
    };
  }

  const graded = await Promise.all(
    metrics.map(async (metric) => {
      const result = await measure(sb, handle, metric, { from, to, grain: "day" });
      /*
       * What counts as wired differs per metric, because each reaches a well by
       * a different path:
       *
       *   oil    through the battery, where allocation lives
       *   gas    through a gas meter the well is allocated on
       *   water  through `flow_connections` from any measured node upstream,
       *          which has no cheap membership check — so the series arriving at
       *          all is the only honest evidence the path exists
       */
      const wired =
        wiring === undefined
          ? result.points.length > 0
          : metric === "oil"
            ? wiring.batteries > 0
            : metric === "gas"
              ? wiring.gasMeters > 0
              : result.points.length > 0;
      return gradeCoverage(
        metric,
        result.points.map((p) => p.period),
        from,
        to,
        wired
      );
    })
  );

  const unwired = graded.filter((g) => g.status === "not wired").map((g) => g.metric);

  return {
    handle: formatHandle(handle.type, handle.id),
    from,
    to,
    metrics: graded,
    ...(wiring ? { wiring } : {}),
    ...(unwired.length > 0
      ? {
          note: `Nothing measures ${unwired.join(" or ")} for this entity. That is a wiring gap, not a measured zero, and no amount of data entry closes it.`,
        }
      : {}),
  };
}
