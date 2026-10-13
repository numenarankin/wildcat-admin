import type { SupabaseClient } from "@supabase/supabase-js";
import { activeAllocations, straightShares } from "@/lib/tanks/allocation";
import {
  cachedMeterAllocation,
  cachedMeterReadings,
  cachedMeters,
  cachedWellEvents,
  cachedWellMeters,
  cachedLeaseMeters,
} from "@/lib/cache/loaders";
import { memo } from "@/lib/cache/request-cache";
import {
  splitDailyByShares,
  sumDailySeries,
  type DailyPoint,
} from "@/lib/tanks/tank-series";
import { gasDailySeries, type GasReading } from "@/lib/meters/gas-series";
import { downtimeAdjustedShares } from "@/lib/wells/downtime-shares";
import { partialTailDate } from "@/lib/production/partial-day";

/**
 * Gas-meter production derivation, the gas analogue of the tank engine's daily
 * derivation.
 *
 * The derivation itself lives in `@/lib/meters/gas-series` and is pure; this file
 * loads a meter's readings, hands them over, and splits the result to wells. Read
 * that module for why a day gets the number it gets. In short: a reading carries
 * a SPOT rate and, optionally, the meter's CUMULATIVE counter. Where two counter
 * readings bracket a stretch, the difference between them is a measured volume
 * and the days inside share it out, shaped by whatever spot values were reported.
 * Where there is no counter, the last spot rate holds until someone observes it
 * change. Nothing is extrapolated before the first reading or after the last.
 *
 * The daily total is split to the meter's wells by its RESOLVED allocation
 * timeline: manual periods and gas-campaign-derived periods have already been
 * flattened to plain effective-dated STRAIGHT rows (`meterAllocationForWellSplit`),
 * so this is a straight split by the rows active on the day. (The old per-meter
 * `weighted` method and its downtime adjustment were retired; per-period gas
 * downtime is a follow-up.)
 */

type Sb = SupabaseClient;

/**
 * A well's daily GAS series (MCF/day) — the gas analogue of the oil
 * `wellProductionSeries`. For each meter the well is a member of, resample the
 * meter's daily MCF over its reading span (`meterDailyMcf`), split it to wells by
 * the meter's RESOLVED allocation timeline (manual ∪ gas-campaign periods, already
 * reduced to effective-dated straight %s), keep this well's slice, and sum across
 * meters. Identical shape to the oil path — allocation series × source series =
 * well series — just with the meter (and its subtractive well test) as the source.
 * A date with no active allocation drops out (`splitDailyByShares`).
 */
export async function wellGasSeries(
  sb: Sb,
  wellId: string,
  opts: GasSeriesOpts = {}
): Promise<DailyPoint[]> {
  return (await wellGasSeriesMeasured(sb, wellId, opts)).rows;
}

/**
 * `from`: an ISO day; read and derive only from there, plus the meter's last
 * reading before it (the counter baseline the first delta needs). The rate
 * derivations pass their 30-day window; charts and reports omit it and get
 * full history, from a separate cache family, so the two never mix.
 */
export interface GasSeriesOpts {
  from?: string;
}

/**
 * `wellGasSeries` plus the day the MEASUREMENT behind it runs out.
 *
 * A meter's series ends at the hour of its last reading, so its final day is a
 * partial one — the same shape as the oil tank's last gauge (`partial-day.ts`).
 * The boundary is taken from the meters' own daily series, never from this
 * well's slice, because the slice also ends when the well comes off the split
 * and that day is whole. Across several meters it is the latest, the day the
 * union runs out. Null when no gas meter covers the well.
 */
export async function wellGasSeriesMeasured(
  sb: Sb,
  wellId: string,
  opts: GasSeriesOpts = {}
): Promise<{ rows: DailyPoint[]; measuredThrough: string | null }> {
  const meterIds = await cachedWellMeters(sb, wellId);
  if (meterIds.length === 0) return { rows: [], measuredThrough: null };

  /*
   * GAS meters only.
   *
   * `cachedWellMeters` answers "which meters is this well allocated to", and a
   * well can be on a water meter as well as a gas one — a producer sending its
   * saltwater to disposal is exactly that. A water meter stores a CUMULATIVE
   * BARREL INDEX in the same `mcf` column, so folding it in here read an odometer
   * at 24,827 as a day's gas: Roy Corbett 2 and 4 reported 2,394 mcf/d each off a
   * meter measuring 14, and the number reached the /production table, the well
   * page headline and the facilities cards.
   */
  const gasMeterIds = new Set((await cachedMeters(sb, "gas")).map((m) => m.id));
  const mine = meterIds.filter((id) => gasMeterIds.has(id));
  if (mine.length === 0) return { rows: [], measuredThrough: null };

  const perMeter = await Promise.all(
    mine.map(async (meterId) => ({
      rows: (await meterWellSplit(sb, meterId, opts.from)).get(wellId) ?? [],
      measuredThrough: partialTailDate(await meterDailySeries(sb, meterId, opts.from)),
    }))
  );

  return {
    rows: sumDailySeries(perMeter.map((m) => m.rows)),
    measuredThrough: perMeter.reduce<string | null>(
      (acc, m) =>
        m.measuredThrough === null || (acc !== null && acc > m.measuredThrough)
          ? acc
          : m.measuredThrough,
      null
    ),
  };
}

/**
 * ONE gas meter's resampled daily MCF — the series everything downstream is a
 * share of.
 *
 * Exported because the meter's own card has to quote this and nothing else. A
 * card built from the raw readings instead ran its 14-day EMA over six reading
 * dates while the single well on that meter ran the same EMA over thirty
 * resampled days, and one well on one meter disagreed with it — which cannot be
 * true of one stream of gas.
 */
export function meterDailySeries(sb: Sb, meterId: string, from?: string): Promise<DailyPoint[]> {
  // Keyed on the window too: a windowed series and the full one are different
  // answers to different questions and must never be served for each other.
  return memo(sb, `meter-daily:${meterId}:${from ?? ""}`, async () => {
    const readings = await cachedMeterReadings(sb, meterId, from);
    return gasDailySeries(toGasReadings(readings));
  });
}

/** A stored reading as the pure derivation wants it. */
function toGasReadings(
  readings: {
    date: string;
    time: string;
    mcf: number | null;
    cumulativeMcf: number | null;
    yesterdayMcf?: number | null;
  }[]
): GasReading[] {
  return readings.map((r) => ({
    date: r.date,
    time: r.time,
    mcf: r.mcf,
    cumulativeMcf: r.cumulativeMcf,
    yesterdayMcf: r.yesterdayMcf ?? null,
  }));
}

/**
 * One meter's daily MCF split to ALL of its member wells, memoized per request.
 * The resample + split is identical for every member well, so the company-wide
 * roll-up derives each meter once instead of once per well on it.
 */
function meterWellSplit(
  sb: Sb,
  meterId: string,
  from?: string
): Promise<Map<string, DailyPoint[]>> {
  return memo(sb, `meter-well-split:${meterId}:${from ?? ""}`, async () => {
    const [daily, allocations] = await Promise.all([
      meterDailySeries(sb, meterId, from),
      cachedMeterAllocation(sb, meterId),
    ]);
    if (daily.length === 0) return new Map<string, DailyPoint[]>();
    // Downtime reweight: a member well down on a day drops to 0% and its
    // online siblings absorb its share.
    const eventsByWell = await cachedWellEvents(
      sb,
      allocations.map((a) => a.wellId)
    );
    const resolver = (date: string) =>
      downtimeAdjustedShares(
        straightShares(activeAllocations(allocations, date)),
        eventsByWell,
        date
      );
    return splitDailyByShares(daily, resolver);
  });
}

/**
 * A lease's total daily gas (MCF/day) over time — the sum of its meters' resampled
 * daily rates (`meterDailyMcf`) across the union of their reading dates. This is
 * the gas analogue of the oil `leaseProductionSeries`: a smoothed daily series the
 * lease page can drive a 14-day EMA off (for the monthly-revenue estimate) or plot.
 * Client-injected RLS idiom. Empty when the lease has no metered gas.
 */
export async function leaseGasDailySeries(
  sb: Sb,
  leaseId: string,
  /** `from` windows the read (see `RATE_WINDOW_DAYS`); unset reads whole. */
  opts: { from?: string } = {}
): Promise<{ date: string; mcf: number }[]> {
  const meters = (await cachedLeaseMeters(sb, leaseId, "gas")).filter((m) => m.active);
  return gasDailyForMeters(sb, meters, opts.from);
}

/**
 * The ORG's total daily gas (MCF/day) — every active gas meter, resampled and
 * summed. Not `Σ leases`: a gas meter only carries a lease when one was assigned,
 * so rolling up the lease series would drop the rest. Same math as
 * `leaseGasDailySeries` with the lease filter removed.
 */
export async function orgGasDailySeries(
  sb: Sb
): Promise<{ date: string; mcf: number }[]> {
  const meters = (await cachedMeters(sb, "gas")).filter((m) => m.active);
  return gasDailyForMeters(sb, meters);
}

/**
 * The shared body: sum each meter's derived daily series across a meter set.
 *
 * Every meter is derived by the same `meterDailySeries` the WELL path splits, so
 * a lease total is the sum of the same numbers its wells divide up. That was not
 * true before: this function used to resample onto the union of reading dates
 * while the well path resampled onto a filled calendar, so the two disagreed
 * across any gap and the meter page carried a comment measuring the spread at
 * about 0.5%. One derivation now feeds both.
 *
 * A date appears when some meter covered it, so a lease whose meters were read on
 * different days is the union of their coverage, not the intersection.
 */
async function gasDailyForMeters(
  sb: Sb,
  meters: { id: string }[],
  from?: string
): Promise<{ date: string; mcf: number }[]> {
  if (meters.length === 0) return [];
  const series = await Promise.all(meters.map((m) => meterDailySeries(sb, m.id, from)));

  const total = new Map<string, number>();
  for (const daily of series) {
    for (const p of daily) total.set(p.date, (total.get(p.date) ?? 0) + p.bbls);
  }
  return [...total.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, mcf]) => ({ date, mcf }));
}
