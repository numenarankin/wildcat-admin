import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  batteryProductionSeries,
  leaseProductionSeries,
  leaseWaterSeries,
  orgProductionSeries,
  orgWaterSeries,
  tankProductionSeries,
  wellProductionSeries,
  wellWaterSeries,
} from "@/lib/tanks/series-loaders";
import {
  leaseGasDailySeries,
  orgGasDailySeries,
  wellGasSeries,
} from "@/lib/meters/engine";
import { cachedTanks } from "@/lib/cache/loaders";
import { partialTailDate, withoutPartialTail } from "@/lib/production/partial-day";
import type { EntityType, Handle } from "./handles";

/**
 * `measure`: the one canonical derivation of a quantity, callable.
 *
 * Barrels-by-well-by-day already has exactly one correct implementation and it
 * is `wellProductionSeries` — battery series split by the resolved allocation
 * timeline, downtime-reweighted. Gas is `wellGasSeries` and water is
 * `wellWaterSeries`, on the same shape. This module adds NO arithmetic to any of
 * them. It is a dispatcher, and its whole value is that every tool above it
 * reaches production through one door, so two answers cannot disagree the way
 * the pages once did.
 *
 * ## The unit trap
 *
 * The oil, gas and water loaders all return `DailyPoint`, whose field is named
 * `bbls`, and the gas one puts MCF in it. Anything summing those together, or
 * labelling a gas total in barrels, is wrong in a way that reads as plausible.
 * So the series are normalized to a neutral `{date, value}` here and the unit
 * travels on the result, named, for the whole life of the number.
 *
 * ## Basis is part of the answer
 *
 * A tank's series is measured; a well's is that series divided by an allocation.
 * They are not the same kind of number and a tool that returns them
 * interchangeably invites a confident claim about a well that only the tank ever
 * measured. Every result says which it is.
 */

type Sb = SupabaseClient;

export const METRICS = ["oil", "gas", "water"] as const;
export type Metric = (typeof METRICS)[number];

export const GRAINS = ["day", "month"] as const;
export type Grain = (typeof GRAINS)[number];

/** What a measure is counted in. Never inferred from the field name. */
export const UNITS: Record<Metric, string> = {
  oil: "bbl",
  gas: "mcf",
  water: "bbl",
};

/**
 * Which handle types each metric can be measured for.
 *
 * A gas figure for a tank is not a thin answer, it is a category error, and it
 * has to be refused by name rather than returned as an empty series that reads
 * as "no gas".
 */
export const MEASURABLE: Record<Metric, readonly EntityType[]> = {
  oil: ["well", "lease", "tank", "battery"],
  gas: ["well", "lease"],
  water: ["well", "lease"],
};

/** A normalized series point. `value` is in the result's `unit`. */
export interface Point {
  date: string;
  value: number;
}

/** One period of the rolled-up series. */
export interface MeasurePoint {
  period: string;
  value: number;
}

export type Basis = "measured" | "allocated";

export interface MeasureResult {
  handle: string;
  metric: Metric;
  unit: string;
  grain: Grain;
  basis: Basis;
  points: MeasurePoint[];
  total: number;
  /**
   * Total over the calendar span the DATA covers: the rate while the entity was
   * actually producing. Null on an empty series.
   */
  perDay: number | null;
  /**
   * Total over the REQUESTED window, when one was given.
   *
   * The two differ whenever the data is thinner than the window, and the
   * difference is large: a well with ten days of readings in a ninety-day window
   * reads 6 bbl/d on `perDay` and 0.67 on this. Both are true and they answer
   * different questions, so neither may stand in for the other. Anything
   * presenting "the last N days" wants THIS one; a like-for-like comparison
   * between wells wants `perDay`.
   */
  perWindowDay: number | null;
  firstDate: string | null;
  lastDate: string | null;
  /** Calendar days from first to last inclusive. Null on an empty series. */
  spanDays: number | null;
  /**
   * Set when the entity cannot carry this metric at all.
   *
   * Distinct from an empty series. `tankProductionSeries` does not filter by
   * product, so asking a WATER tank for oil would run the gauge series and hand
   * back barrels of water labelled as oil — arithmetically fine, materially a
   * lie. A refusal names that instead.
   */
  refused?: string;
  note?: string;
}

/* ------------------------------------------------------------------ *
 * Pure
 * ------------------------------------------------------------------ */

const MS_PER_DAY = 86_400_000;

/** ISO `YYYY-MM-DD` one day after `iso` (UTC). */
function dayAfter(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** Calendar days from `first` to `last` inclusive. UTC, so DST cannot shorten a day. */
export function spanDays(first: string, last: string): number {
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${last}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

/**
 * Sum a series into periods, oldest first.
 *
 * Duplicate dates are summed rather than overwritten. The loaders emit one point
 * per date today, but a silent overwrite is the kind of thing that would go
 * unnoticed for a year if that ever changed.
 */
export function rollUp(points: Point[], grain: Grain): MeasurePoint[] {
  const by = new Map<string, number>();
  for (const p of points) {
    if (!p?.date) continue;
    const period = grain === "month" ? p.date.slice(0, 7) : p.date;
    const value = Number.isFinite(p.value) ? p.value : 0;
    by.set(period, (by.get(period) ?? 0) + value);
  }
  return [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([period, value]) => ({ period, value }));
}

/**
 * Total, span and daily rate over a series.
 *
 * `perDay` is the total over the CALENDAR span, not over the days that carry a
 * reading. The oil and gas series are already regularized, so a gap is a day the
 * well produced at some rate nobody wrote down, not a day it made nothing.
 * Dividing by the days with data would inflate every intermittent well.
 */
export function summarize(points: Point[]): {
  total: number;
  firstDate: string | null;
  lastDate: string | null;
  spanDays: number | null;
  perDay: number | null;
} {
  let total = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  for (const p of points) {
    if (!p?.date) continue;
    total += Number.isFinite(p.value) ? p.value : 0;
    if (firstDate === null || p.date < firstDate) firstDate = p.date;
    if (lastDate === null || p.date > lastDate) lastDate = p.date;
  }
  if (firstDate === null || lastDate === null) {
    return { total: 0, firstDate: null, lastDate: null, spanDays: null, perDay: null };
  }
  const span = spanDays(firstDate, lastDate);
  return {
    total,
    firstDate,
    lastDate,
    spanDays: span,
    perDay: span > 0 ? total / span : null,
  };
}

/** Keep only the points inside an inclusive `YYYY-MM-DD` window. */
export function clampWindow(
  points: Point[],
  from?: string,
  to?: string
): Point[] {
  if (!from && !to) return points;
  return points.filter(
    (p) => (!from || p.date >= from) && (!to || p.date <= to)
  );
}

/**
 * Only a well's figure is allocated.
 *
 * A tank, a battery or a lease is the sum of what was gauged or metered on it. A
 * well's is that divided up, so it is the one grain where the number depends on
 * a split someone chose.
 */
export function basisFor(type: EntityType | null): Basis {
  return type === "well" ? "allocated" : "measured";
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

/** The raw loaders, normalized to `{date, value}`. */
async function loadSeries(
  sb: Sb,
  metric: Metric,
  handle: Handle | null,
  opts: { from?: string; to?: string }
): Promise<Point[] | { refused: string }> {
  /*
   * Gauge-derived rows, with the PARTIAL LAST DAY removed.
   *
   * An oil or water series' final day ends at that day's last gauge, not at
   * midnight, so its row holds a few hours of barrels under a whole day's date.
   * Every page that renders these cuts it (`withoutPartialTail`); this module
   * did not, so `get_measure` and everything built on it — rank, compare, trend,
   * the deviation scan — ended one partial day past `get_production` and could
   * quote a different total for the same well and window. Gas is NOT cut: a
   * meter's day is entered as a day's volume.
   */
  const bbls = (rows: { date: string; bbls: number }[]): Point[] =>
    cut(rows, partialTailDate(rows));

  /*
   * A WELL's rows are a slice of somebody else's measurement, so the boundary
   * comes with them (`AllocatedSeries.measuredThrough`) instead of being read
   * off the slice. A slice can end early because the well came off the split,
   * and that last day is a whole day it is owed -- cutting it deleted barrels
   * nobody was then allocated: 150 measured, 120 across the wells.
   */
  const allocated = (series: {
    rows: { date: string; bbls: number }[];
    measuredThrough: string | null;
  }): Point[] => cut(series.rows, series.measuredThrough);

  const cut = (
    rows: { date: string; bbls: number }[],
    boundary: string | null
  ): Point[] =>
    withoutPartialTail(rows, boundary).map((r) => ({
      date: r.date,
      value: r.bbls,
    }));

  /*
   * The oil loaders take the window NATIVELY, and the tail cut above reads "the
   * last day these rows cover" — so asking them for exactly the window made the
   * cut land on the window's own last day and silently drop it. A total for July
   * lost July 31 whenever August had already been gauged, which is a whole day
   * of a well's month, on every windowed figure `measure` serves: rank, compare,
   * trend, the deviation scan.
   *
   * The window has to stay (it is what keeps the per-day expansion from going
   * quadratic over years of readings), so ask for ONE DAY MORE than the caller
   * wants. If the series really does stop inside the window, that extra day is
   * empty and the boundary lands on the true last covered day, exactly as
   * before. If the series runs on past the window, the boundary lands on the
   * extra day and the window keeps every one of its own. `measure` clamps back
   * to the requested window straight after, so the extra day never escapes.
   */
  const probe: typeof opts = opts.to ? { ...opts, to: dayAfter(opts.to) } : opts;

  if (metric === "oil") {
    if (!handle) return bbls(await orgProductionSeries(sb, probe));
    switch (handle.type) {
      case "well":
        return allocated(await wellProductionSeries(sb, handle.id, probe));
      case "lease":
        return bbls(await leaseProductionSeries(sb, handle.id, probe));
      case "tank": {
        // The tank series builder runs on whatever readings the tank has. Only
        // an oil tank's gauge is oil.
        const tank = (await cachedTanks(sb)).find((t) => t.id === handle.id);
        if (!tank) return { refused: `No tank ${handle.id} is on file.` };
        if (tank.product !== "oil") {
          return {
            refused: `${tank.name} is a ${tank.product} tank, so it has no oil series. Its gauge readings measure ${tank.product}; reading them as oil would be wrong. Ask for the water metric on the wells it serves instead.`,
          };
        }
        return bbls(await tankProductionSeries(sb, handle.id, probe));
      }
      case "battery":
        return bbls(await batteryProductionSeries(sb, handle.id, probe));
      default:
        return [];
    }
  }

  if (metric === "gas") {
    // `wellGasSeries` returns DailyPoint, whose `bbls` field holds MCF; the
    // lease and org loaders return an explicit `mcf`. Same quantity, two shapes.
    if (!handle) {
      return (await orgGasDailySeries(sb)).map((r) => ({ date: r.date, value: r.mcf }));
    }
    switch (handle.type) {
      case "well": {
        // Not through `bbls`: that cuts the partial gauge day, which a meter
        // series does not have.
        const gas = await wellGasSeries(sb, handle.id);
        return gas.map((p) => ({ date: p.date, value: p.bbls }));
      }
      case "lease":
        return (await leaseGasDailySeries(sb, handle.id)).map((r) => ({
          date: r.date,
          value: r.mcf,
        }));
      default:
        return [];
    }
  }

  if (!handle) return bbls(await orgWaterSeries(sb));
  switch (handle.type) {
    case "well":
      return allocated(await wellWaterSeries(sb, handle.id));
    case "lease":
      return bbls(await leaseWaterSeries(sb, handle.id));
    default:
      return [];
  }
}

export interface MeasureOpts {
  from?: string;
  to?: string;
  grain?: Grain;
}

/**
 * One entity's series for one metric.
 *
 * `handle` is null for the whole company, which is the org-wide roll-up rather
 * than the sum of the leases: most tanks and meters carry no lease, so summing
 * leases would silently undercount. Only the oil loaders take the window
 * natively; the rest are clamped here, which is the same answer.
 */
export async function measure(
  sb: Sb,
  handle: Handle | null,
  metric: Metric,
  opts: MeasureOpts = {}
): Promise<MeasureResult> {
  const grain = opts.grain ?? "month";
  const loaded = await loadSeries(sb, metric, handle, {
    from: opts.from,
    to: opts.to,
  });

  if (!Array.isArray(loaded)) {
    return {
      handle: handle ? `${handle.type}:${handle.id}` : "org",
      metric,
      unit: UNITS[metric],
      grain,
      basis: basisFor(handle?.type ?? null),
      points: [],
      total: 0,
      perDay: null,
      perWindowDay: null,
      firstDate: null,
      lastDate: null,
      spanDays: null,
      refused: loaded.refused,
    };
  }

  const points = clampWindow(loaded, opts.from, opts.to);
  const stats = summarize(points);
  const window =
    opts.from && opts.to ? spanDays(opts.from, opts.to) : null;

  return {
    handle: handle ? `${handle.type}:${handle.id}` : "org",
    metric,
    unit: UNITS[metric],
    grain,
    basis: basisFor(handle?.type ?? null),
    points: rollUp(points, grain),
    ...stats,
    /*
     * Null when nothing was measured, NOT zero.
     *
     * Dividing an empty total by the window length gives 0, and 0 bbl/d is a
     * claim that the well produced nothing. It never reported. The `perDay`
     * above is already null in that case; this one has to agree, or `get_object`
     * hands the model a rate for a well nothing measures.
     */
    perWindowDay:
      stats.perDay === null
        ? null
        : window && window > 0
          ? stats.total / window
          : stats.perDay,
    ...(points.length === 0
      ? {
          note: `No ${metric} series reaches this entity. That means nothing upstream of it measures ${metric}, which is not the same as a measured zero.`,
        }
      : {}),
  };
}
