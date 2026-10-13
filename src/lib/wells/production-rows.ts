/**
 * The well's DISPLAYED production rows — the single source of truth behind the
 * Production table + chart on the well workspace. Oil comes from the tank-level
 * series (regularizable), gas from the meter-derived series, and salt water from
 * the flow_connections-attributed series; the three are unioned by date, with any
 * hand-entered gas / salt water used as the per-date fallback where no meter or
 * tank covers the well.
 *
 * The well page and the `/api/wells/[well]/export` route BOTH read this, so the
 * exported figures can never diverge from what the user sees on screen. (Before
 * this existed, the page derived these rows while the export dumped the raw
 * hand-entered `getWellProduction` rows — a different data source and row set.)
 *
 * Pure-ish server module: it only calls the same RLS-scoped series loaders the
 * page uses. Returns BOTH the regularized and raw oil variants in one pass so the
 * chart's Regularize toggle has both without a second round of queries.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductionPoint } from "@/lib/wells/wells";
import { wellGasSeries } from "@/lib/meters/engine";
import {
  wellProductionSeries,
  wellWaterSeries,
} from "@/lib/tanks/series-loaders";
import { withoutPartialTail } from "@/lib/production/partial-day";

/** A daily series point as the loaders return it (`bbls` carries MCF for gas). */
interface DailyPoint {
  date: string;
  bbls: number;
}

/**
 * The union-by-date merge itself, over series ALREADY LOADED.
 *
 * Split out so the mobile series route can build the same rows from the series
 * it has already fetched instead of loading them a second time. The merge is the
 * part that must not exist twice: the phone's Production table and the webapp's
 * are the same table, and a second implementation of "which dates get a row, and
 * what fills a date one stream didn't cover" is exactly how they would drift.
 */
export function mergeDisplayRows(input: {
  oil: DailyPoint[];
  /** MCF per day, carried in `bbls` as `wellGasSeries` returns it. */
  gas: DailyPoint[];
  water: DailyPoint[];
  /** Hand-entered rows, the per-date fallback where no meter / tank covers the
   *  well. */
  handEntered: ProductionPoint[];
}): ProductionPoint[] {
  const oilByDate = new Map(input.oil.map((p) => [p.date, p.bbls]));
  const gasByDate = new Map(input.gas.map((p) => [p.date, p.bbls]));
  const waterByDate = new Map(input.water.map((p) => [p.date, p.bbls]));
  const rawGasByDate = new Map(input.handEntered.map((p) => [p.date, p.gasProduction]));
  const rawWaterByDate = new Map(input.handEntered.map((p) => [p.date, p.saltWater]));

  // Rows span the union of oil-, gas-, and water-covered dates, so a well
  // measured for only one commodity still gets a row on every covered day.
  const dates = [
    ...new Set([...oilByDate.keys(), ...gasByDate.keys(), ...waterByDate.keys()]),
  ].sort();

  return dates.map((date) => ({
    date,
    time: "12:00",
    oilProduction: oilByDate.get(date) ?? 0,
    oilStock: 0,
    oilSales: 0,
    gasProduction: gasByDate.get(date) ?? rawGasByDate.get(date) ?? 0,
    saltWater: waterByDate.get(date) ?? rawWaterByDate.get(date) ?? 0,
  }));
}

export interface WellDisplayProduction {
  /** Regularized oil (what the Production table + chart show by default). */
  regularized: ProductionPoint[];
  /** Raw (un-regularized) oil counterpart, for the chart's Regularize toggle. */
  raw: ProductionPoint[];
}

export async function wellDisplayProductionRows(
  sb: SupabaseClient,
  wellId: string,
  /** Hand-entered production rows (`getWellProduction`) — used only as the
   *  per-date gas / salt-water fallback where no meter/tank covers the well. */
  handEntered: ProductionPoint[]
): Promise<WellDisplayProduction> {
  const [oilSeries, oilSeriesRaw, gasSeries, waterSeries] = await Promise.all([
    wellProductionSeries(sb, wellId, { mode: "regularized" }),
    wellProductionSeries(sb, wellId, { mode: "raw" }),
    wellGasSeries(sb, wellId),
    // Water is already a daily haul-aware series (no raw/regularized distinction).
    wellWaterSeries(sb, wellId),
  ]);

  const toRows = (series: DailyPoint[]): ProductionPoint[] =>
    mergeDisplayRows({
      oil: series,
      gas: gasSeries,
      water: waterSeries.rows,
      handEntered,
    });

  /*
   * The oil series' last day is only covered up to its last gauge, so its row is
   * a fraction of a day's barrels wearing a whole day's date. Both variants are
   * cut at the same boundary — they share the anchors, so they share the partial
   * day -- and gas and water go with them rather than leaving a row standing with
   * a zero in the oil column. See `withoutPartialTail`.
   *
   * The boundary is the BATTERY's last gauged day (`measuredThrough`), not the
   * last row of this well's slice: a slice also ends when the well comes off the
   * split, and that day is whole.
   */
  const boundary = oilSeries.measuredThrough;
  return {
    regularized: withoutPartialTail(toRows(oilSeries.rows), boundary),
    raw: withoutPartialTail(toRows(oilSeriesRaw.rows), boundary),
  };
}
