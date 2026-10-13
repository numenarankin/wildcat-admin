import "server-only";

/**
 * Loader for the per-well rates behind {@link sumWellRates} — the one read both
 * the Facilities cards and the analytics headline take their production from.
 *
 * Oil and gas come from `getWellProductionRates` (the cached 14-day EMA of each
 * well's regularized tank series + meter gas). Water has no cache yet, so it is
 * derived here from the same attribution the well page charts, through the same
 * EMA. Injection wells are excluded: an SWD well takes water, it does not make
 * any, and its throughput is on its own card as a disposal rate.
 *
 * Request-scoped, because the Facilities page asks for the graph and the summary
 * in one render and neither should pay for the other's copy.
 */

import { memoScope, withRequestScope } from "@/lib/cache/request-cache";
import { hasSupabase } from "@/lib/env";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { cachedWells } from "@/lib/wells/wells";
import { getWellProductionRates } from "@/lib/wells/rate-cache";
import { wellWaterSeries } from "@/lib/tanks/series-loaders";
import { latestDailyEma } from "@/lib/wells/arps";
import { withoutPartialTail } from "@/lib/production/partial-day";
import { sumWellRates, type WellRates } from "@/lib/analytics/well-rates";

export interface CompanyRates {
  /** Rate per producing well id — exactly what that well's card shows. */
  perWell: Map<string, WellRates>;
  /**
   * The lease behind each of those wells, so a caller can price a well's volume
   * at its LEASE's realized price. Carried here rather than re-read, so the
   * rates and their attribution come from one pass over one population.
   */
  leaseByWell: Map<string, string | null>;
  /** Their sum, per stream. */
  totals: WellRates;
}

const EMPTY: CompanyRates = {
  perWell: new Map(),
  leaseByWell: new Map(),
  totals: { oil: 0, gas: 0, water: 0 },
};

export function getCompanyRates(): Promise<CompanyRates> {
  return withRequestScope(() => memoScope("company-rates", loadCompanyRates));
}

async function loadCompanyRates(): Promise<CompanyRates> {
  if (!hasSupabase()) return EMPTY;
  const sb = await getRequestSupabase();

  /*
   * ACTIVE producers, and only those — the same population the Facilities map
   * draws (`getFacilityGraph` filters on `active`). A P&A'd well still has a
   * series behind it, and counting it in the company total while its card is
   * off the map is exactly the mismatch this module exists to remove.
   */
  const wells = (await cachedWells(sb)).filter(
    (w) => w.active && w.type !== "injection"
  );
  if (wells.length === 0) return EMPTY;

  const oilGas = await getWellProductionRates();
  const perWell = new Map<string, WellRates>();
  await Promise.all(
    wells.map(async (w) => {
      // The water nodes' last day ends at their last gauge/haul, same as oil --
      // the battery page strips it for exactly this reason. Left in, it is the
      // heaviest sample in the EMA. The boundary is the NODES' last measured day
      // (`measuredThrough`), so a well whose share ended earlier keeps its final
      // whole day instead of having it read as a part day.
      const raw = await wellWaterSeries(sb, w.id);
      const series = withoutPartialTail(raw.rows, raw.measuredThrough);
      const water =
        series.length === 0
          ? 0
          : latestDailyEma(
              series.map((p) => ({
                date: p.date,
                oilProduction: p.bbls,
                gasProduction: 0,
              })),
              "oil"
            );
      perWell.set(w.id, {
        oil: oilGas.get(w.id)?.oilPerDay ?? 0,
        gas: oilGas.get(w.id)?.gasPerDay ?? 0,
        water: water > 0 ? water : 0,
      });
    })
  );

  return {
    perWell,
    leaseByWell: new Map(wells.map((w) => [w.id, w.leaseId])),
    totals: sumWellRates(perWell.values()),
  };
}
