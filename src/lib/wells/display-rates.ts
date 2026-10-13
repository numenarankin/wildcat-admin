import "server-only";

import { getWellProductionRates, rateWindowFrom } from "@/lib/wells/rate-cache";
import { fleetRrcRates } from "@/lib/rrc/well-history";
import { getAdjustedPrices, monthlyRevenueFrom } from "@/lib/leases/revenue";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { primeSeriesInputs } from "@/lib/cache/loaders";
import { wellProductionSeries, wellWaterSeries } from "@/lib/tanks/series-loaders";
import { wellGasSeriesMeasured } from "@/lib/meters/engine";
import { withoutPartialTail } from "@/lib/production/partial-day";
import { latestDailyEma } from "@/lib/wells/arps";
import type { Well } from "@/lib/wells/wells";

/**
 * The oil / gas / revenue figures a wells TABLE shows, for any page that lists
 * wells.
 *
 * `wells.oil_production` and its siblings are columns on the well row and are
 * not what the app derives production from; a page that renders them straight
 * off `getWells()` / `getLeaseWells()` prints zeros. What a well is actually
 * making comes from two existing sources, in this order:
 *
 *   1. `getWellProductionRates()` — the operator's own gauged rate, a 14-day EMA
 *      of the tank/meter-allocated series, cached per request scope.
 *   2. `fleetRrcRates()` — the same 14-day EMA over the state's filings, batched
 *      one read per RRC record rather than per well, for wells that have been
 *      gauged nothing yet.
 *
 * A measurement always beats an estimate; the estimate only fills a blank, and
 * a measured zero is not a blank. Both are read here, neither is re-derived, and revenue is `monthlyRevenueFrom` at
 * the /prices adjusted prices — the same formula and the same price base the
 * /leases row uses, so a lease's figure is the sum of its wells' rather than a
 * second opinion about them.
 *
 * SALTWATER comes from a third place, {@link fleetWaterRates}, because there is
 * no fourth column on `well_production_rates` to cache it in and no state filing
 * to fall back on. It is derived live from the same attribution the well's own
 * page draws.
 *
 * Injection wells are left alone: neither source rates them, and an injector is
 * not output.
 */
export async function withDisplayRates<T extends Well>(wells: T[]): Promise<T[]> {
  if (wells.length === 0) return wells;

  const producers = wells.filter((w) => w.type !== "injection");
  const [measured, water, prices] = await Promise.all([
    getWellProductionRates(),
    fleetWaterRates(producers.map((w) => w.id)),
    getAdjustedPrices(),
  ]);
  /*
   * The public record is the FALLBACK, used below only where NOTHING MEASURES
   * a stream for the well. A measured 0 is a measurement: a well allocated 0%
   * of a gauged battery, or shut in, made nothing, and the table must say so.
   * The cached rate alone cannot tell that 0 from "no readings yet", so the
   * wells whose rate is 0 for a stream are asked whether a measurement stands
   * behind it (`measuredThrough` is the day the battery's or meter's own series
   * runs out, null when there is none). Only those wells touch the mirror or
   * re-walk their series; a well gauged for both streams touches neither.
   */
  const sb = await getRequestSupabase();
  const from = rateWindowFrom();
  const zeroed = producers.filter((w) => {
    const r = measured.get(w.id);
    return !r || !r.oilPerDay || !r.gasPerDay;
  });
  const unmeasured = new Map(
    await Promise.all(
      zeroed.map(async (w) => {
        const r = measured.get(w.id);
        const [oil, gas] = await Promise.all([
          r?.oilPerDay
            ? null
            : wellProductionSeries(sb, w.id, { mode: "regularized", from }),
          r?.gasPerDay ? null : wellGasSeriesMeasured(sb, w.id, { from }),
        ]);
        return [
          w.id,
          {
            oil: oil !== null && oil.measuredThrough === null,
            gas: gas !== null && gas.measuredThrough === null,
          },
        ] as const;
      })
    )
  );
  const needsRecord = zeroed.filter((w) => {
    const u = unmeasured.get(w.id);
    return u?.oil || u?.gas;
  });
  const estimated = await fleetRrcRates(needsRecord.map((w) => w.id));

  return wells.map((well) => {
    const rate = measured.get(well.id);
    const estimate = estimated.get(well.id);
    const u = unmeasured.get(well.id);
    const bblPerDay =
      rate?.oilPerDay || (u?.oil ? estimate?.oilPerDay : 0) || 0;
    const mcfPerDay =
      rate?.gasPerDay || (u?.gas ? estimate?.gasPerDay : 0) || 0;
    return {
      ...well,
      oilProduction: bblPerDay,
      gasProduction: mcfPerDay,
      // Water is NOT priced: produced water is a disposal cost, not a sale.
      saltWater: water.get(well.id) ?? 0,
      // Priced through the well's LEASE: settlements land at lease grain and a
      // well belongs to exactly one lease, so there is nothing to allocate.
      revenue: monthlyRevenueFrom(
        { bblPerDay, mcfPerDay },
        prices.for(well.leaseId)
      ),
    };
  });
}

/**
 * Each well's current produced-water rate, in bbl/day.
 *
 * The same figure the well's own page shows, by construction: `wellWaterSeries`
 * is the attribution its chart draws, `withoutPartialTail` drops the same
 * part-day, and `latestDailyEma` is the same 14-day EMA the oil and gas columns
 * beside this one are. Before this, the table printed `wells.salt_water` — a
 * stored scalar nothing derives into — so a well reading real barrels on its own
 * page read 0 in the roster.
 *
 * Derived live rather than cached beside oil and gas. It costs one org-wide
 * attribution build per request (`waterAttribution` memoizes it) and a lookup
 * per well, not a pipeline per well; caching it would buy a column on
 * `well_production_rates` and a staleness class this figure does not need. If
 * /production ever slows on it, that is the change to make.
 *
 * No state fallback, unlike oil and gas: Texas publishes no produced-water
 * volumes, so a well nothing measures shows 0 and that is the whole truth
 * available.
 */
async function fleetWaterRates(wellIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (wellIds.length === 0) return out;
  /*
   * The request's shared client, not a private one.
   *
   * `getSupabaseServer()` builds a fresh client, and `memo` keys on the client
   * OBJECT, so every read below missed the store the rest of the page had
   * already filled: `tanks`, `meters`, `flow_connections`, `well_events` and
   * two tank-reading queries per water tank, all re-fetched for rows
   * `primeSeriesInputs` had loaded moments earlier.
   */
  const sb = await getRequestSupabase();
  /*
   * Priming is kicked off, NOT awaited. The per-entity reads it warms are
   * batched, so the water derivations below coalesce their own reads whether
   * the prime has landed or not; awaiting it first put the whole water path
   * behind the oil path's membership, tank and meter waves, and the waterfall
   * showed water's first query starting 2.2s into a 3.5s render.
   */
  const from = rateWindowFrom();
  void primeSeriesInputs(sb, wellIds, from).catch(() => {});

  /*
   * Derive in parallel. This was a sequential `for await`, so 40 wells meant 40
   * round-trip waves one after another even though nothing here depends on the
   * previous well's answer. The reads are batched, so the concurrency costs no
   * extra queries.
   */
  const entries = await Promise.all(
    wellIds.map(async (wellId) => {
      // Same 30-day window as oil and gas: this is a 14-day EMA too.
      const series = await wellWaterSeries(sb, wellId, { from });
      const rows = withoutPartialTail(series.rows, series.measuredThrough);
      if (rows.length === 0) return null;
      return [
        wellId,
        // `latestDailyEma` reads one of two named fields; water is barrels, so
        // it rides in the oil slot. The arithmetic is the EMA, not the label.
        latestDailyEma(
          rows.map((p) => ({
            date: p.date,
            oilProduction: p.bbls,
            gasProduction: 0,
          })),
          "oil"
        ),
      ] as const;
    })
  );

  // A well with no rows is absent from the map, exactly as `continue` left it
  // before: callers distinguish "no measurement" from "measured zero".
  for (const entry of entries) {
    if (entry) out.set(entry[0], entry[1]);
  }
  return out;
}
