import { getRequestSupabase } from "@/lib/supabase/request-client";
import { cachedWells } from "@/lib/wells/wells";
import "server-only";

import { hasRrcDb } from "@/lib/scout/rrc-db";
import { hasSupabase } from "@/lib/env";
import {
  apiDigits,
  loadRecordSlices,
  mergeMonths,
  wellMonths,
  wellMonthsBatch,
} from "./record-split";
import {
  expandMonthlyToDaily,
  type LeaseHistorySeries,
  type RrcMonth,
} from "./lease-history-series";
import { EMPTY_HISTORY } from "./lease-history";
import { rrcProductionHorizon } from "./record-currency";
import { currentDailyEma } from "@/lib/wells/arps";

/**
 * One well's production history from the public record, as a daily series.
 *
 * Texas reports OIL per lease, so a well's own number has to be derived: take the
 * lease's reported monthly volumes and divide them in the ratio of its wells'
 * filed W-10 test rates, month by month, using the test in effect at the time.
 * The weighting rule and why the tests' 1.64x optimism cancels are in
 * `well-share.ts`; the record and district joins are in `record-split.ts`.
 *
 * Gas needs no dividing. Texas files gas at the WELL level, so a gas record is
 * one well and its reported volume already belongs to it. A well that is both on
 * an oil lease and on its own gas id gets casinghead gas from the first and
 * gas-lease gas from the second, summed.
 *
 * ## Strictly for display
 *
 * An estimate of a rate, not a measurement, exactly as at lease scope. Revenue
 * comes from settlement statements and produced volume from the operator's own
 * tanks; neither may read this. It draws the chart, and the decline fit on that
 * chart, and nothing else.
 *
 * Every "no" returns an empty series: mirror unconfigured, no API number on the
 * well, the API not on a current P-5 schedule, nothing reported. A missing
 * history is a chart that starts later, never an error on the page.
 */
const LOG = "[rrc-well-history]";

export async function wellRrcHistory(
  wellId: string,
  before: string | null
): Promise<LeaseHistorySeries> {
  if (!hasRrcDb() || !hasSupabase()) return EMPTY_HISTORY;
  try {
    // The roster the page already holds, not a private `wells` read.
    const sb = await getRequestSupabase();
    const well = (await cachedWells(sb)).find((w) => w.id === wellId);

    const api = apiDigits(well?.apiWellNo || null);
    if (!api) {
      console.warn(
        `${LOG} ${wellId}: no history — the well carries no API number, so it ` +
          `cannot be found in the public record`
      );
      return EMPTY_HISTORY;
    }

    // Months prefetched as the record is found (see `LoadSlicesOpts`), the
    // whole-history key `wellMonths` reads below.
    const slices = await loadRecordSlices([api], { months: {} });
    if (slices.length === 0) return EMPTY_HISTORY;

    const perSlice = await Promise.all(
      slices.map(async (slice) => {
        const wellNo = slice.wellNoByApi[api];
        if (!wellNo) return [];
        return wellMonths(slice, wellNo);
      })
    );
    const months = mergeMonths(perSlice);
    if (months.length === 0) {
      console.warn(`${LOG} ${wellId}: no history — nothing reported on its record(s)`);
      return EMPTY_HISTORY;
    }

    const series = expandMonthlyToDaily(months, before);
    const where = slices
      .map(
        (s) =>
          `${s.oilGasCode}/${s.district}/${s.leaseNo} (well ` +
          `${s.wellNoByApi[api]} of ${s.wells.length})`
      )
      .join(" + ");
    console.info(
      `${LOG} ${wellId} api ${api} on ${where}: ${months.length} months → ` +
        `${series.oil.length} oil / ${series.gas.length} gas daily points, ` +
        `cut before ${before ?? "(nothing measured yet — full history)"}`
    );
    return series;
  } catch (error) {
    console.error(`${LOG} ${wellId}: failed`, error);
    return EMPTY_HISTORY;
  }
}


/** A well's current rate as the public record implies it, bbl/d and MCF/d. */
export interface RrcWellRate {
  oilPerDay: number;
  gasPerDay: number;
}

/**
 * Current rates from the public record for a whole fleet, in one pass.
 *
 * The `/production` wells table states its own invariant: "a well's row in the
 * table equals its own page" (`rate-cache.ts`). The well page's headline reads
 * the series its chart draws, which now includes the state's record, so a fleet
 * with no gauge readings yet rendered a page full of production above a table of
 * zeros. This closes that.
 *
 * BATCHED BY RECORD, not by well. Wells on one lease share one RRC record, so
 * the volumes and the test history are read once per record and divided N ways,
 * rather than running the whole chain 32 times for a 32-well fleet.
 *
 * The rate is the same 14-day EMA the well page's headline uses, over the same
 * series, so the two agree by construction rather than by coincidence. Callers
 * use it only where their own measured rate is absent: a well with tank readings
 * is measured, and a measurement always beats an estimate.
 */
export async function fleetRrcRates(
  wellIds: string[]
): Promise<Map<string, RrcWellRate>> {
  const out = new Map<string, RrcWellRate>();
  if (wellIds.length === 0 || !hasRrcDb() || !hasSupabase()) return out;

  try {
    // How current the public record is, so a stream that stopped filing can be
    // told apart from one the state has not collected yet. One memoized round
    // trip for the whole fleet, issued alongside the roster read.
    const [sb, horizon] = await Promise.all([getRequestSupabase(), rrcProductionHorizon()]);
    // The roster the page already holds, not a third `wells` read. `apiWellNo`
    // is "" for a null column (`loadWells`), and `apiDigits("")` is falsy, so the
    // `.not("api_well_no", "is", null)` the old query carried is preserved by
    // the `continue` below.
    const wanted = new Set(wellIds);
    const data = (await cachedWells(sb))
      .filter((w) => wanted.has(w.id))
      .map((w) => ({ id: w.id, api_well_no: w.apiWellNo || null }));

    // Our well ids, keyed by the API the public record knows them as. Two of our
    // wells can carry the same API (a duplicate row), so this is a list.
    const idsByApi = new Map<string, string[]>();
    for (const row of data ?? []) {
      const api = apiDigits(row.api_well_no as string | null);
      if (!api) continue;
      const at = idsByApi.get(api);
      if (at) at.push(row.id as string);
      else idsByApi.set(api, [row.id as string]);
    }
    if (idsByApi.size === 0) return out;

    // The 24-cycle months are prefetched as each record is found, the same
    // key `wellMonthsBatch` reads below; see `LoadSlicesOpts`.
    const slices = await loadRecordSlices([...idsByApi.keys()], { months: { sinceMonths: 24 } });
    /*
     * Months per record, one read each, CONCURRENT. A single read for all
     * records was tried and is slower on the mirror: `lease_production` is a
     * compressed hypertable whose index leads on (district_no, oil_gas_code),
     * and a composite `IN (unnest(...))` plans as a per-chunk columnar scan
     * filtering on lease_no (EXPLAIN: 449-1125ms for 3 keys) where the
     * single-key form is an index lookup (37ms). R concurrent 37ms reads beat
     * one 1s read.
     */
    const monthsByApi = new Map<string, RrcMonth[][]>();
    const perSlice = await Promise.all(
      slices.map(async (slice) => {
        const mine = Object.entries(slice.wellNoByApi).filter(([api]) =>
          idsByApi.has(api)
        );
        const byWellNo = await wellMonthsBatch(
          slice,
          mine.map(([, wellNo]) => wellNo),
          // A 14-month EMA whose displayed value is the latest reported month;
          // 24 cycles bounds the head at ~3% and lets Timescale skip chunks.
          { sinceMonths: 24 }
        );
        return mine.map(([api, wellNo]) => ({
          api,
          months: byWellNo.get(wellNo) ?? [],
        }));
      })
    );
    for (const { api, months } of perSlice.flat()) {
      const at = monthsByApi.get(api);
      if (at) at.push(months);
      else monthsByApi.set(api, [months]);
    }

    for (const [api, sets] of monthsByApi) {
      const series = expandMonthlyToDaily(mergeMonths(sets), null);
      if (series.oil.length === 0 && series.gas.length === 0) continue;
      /*
       * Each stream folds its OWN days and is then carried to the record's
       * horizon, where the months it did not report count as months it made
       * nothing (`currentDailyEma`).
       *
       * Both halves matter. Folding the two streams together would feed the oil
       * EMA a zero for every gas-only DAY inside a month it did report, which
       * understates a producing well. Folding a stream alone and stopping where
       * it stops is worse in the other direction: Fannie Young 2A is a gas well
       * that filed 18 bbl of condensate in April 2002 and none since, and its
       * Oil column read 0.6 bbl/d for the next twenty-four years while its gas
       * filed every month. The horizon is what separates "not reported yet"
       * from "not produced".
       */
      const rate = {
        oilPerDay: currentDailyEma(
          series.oil.map((p) => ({
            date: p.date,
            oilProduction: p.value,
            gasProduction: 0,
          })),
          "oil",
          horizon
        ),
        gasPerDay: currentDailyEma(
          series.gas.map((p) => ({
            date: p.date,
            oilProduction: 0,
            gasProduction: p.value,
          })),
          "gas",
          horizon
        ),
      };
      for (const id of idsByApi.get(api) ?? []) out.set(id, rate);
    }
    console.info(
      `${LOG} fleet: ${out.size} of ${wellIds.length} wells have a public-record rate`
    );
    return out;
  } catch (error) {
    console.error(`${LOG} fleet rates failed`, error);
    return out;
  }
}

/**
 * Every well's public-record history, for the fleet decline, in one pass.
 *
 * `wellRrcHistory` above is one well: one slice lookup, one months read. The
 * dashboard's decline fits every well on the account, and wells on one lease
 * share one record, so this reads each RECORD once and divides it N ways
 * (`wellMonthsBatch`), the way `fleetRrcRates` does for the roster's rates. The
 * per-record reads run concurrently; see that function for why one composite
 * read is slower on the mirror than R single-key reads.
 *
 * Each well's series is cut before its own first reading (`before`), exactly
 * as the well page cuts it, so a well's row on the dashboard is fitted over the
 * same series as its page.
 *
 * @param beforeByWell well id → the date its own measurements start, or null
 *   for a well with none (whole record). Only these wells are looked up.
 */
export async function fleetWellRrcHistory(
  beforeByWell: ReadonlyMap<string, string | null>
): Promise<Map<string, LeaseHistorySeries>> {
  const out = new Map<string, LeaseHistorySeries>();
  if (beforeByWell.size === 0 || !hasRrcDb() || !hasSupabase()) return out;
  try {
    const sb = await getRequestSupabase();
    const roster = (await cachedWells(sb)).filter((w) => beforeByWell.has(w.id));
    const idsByApi = new Map<string, string[]>();
    for (const w of roster) {
      const api = apiDigits(w.apiWellNo || null);
      if (!api) continue;
      const at = idsByApi.get(api);
      if (at) at.push(w.id);
      else idsByApi.set(api, [w.id]);
    }
    if (idsByApi.size === 0) return out;

    const slices = await loadRecordSlices([...idsByApi.keys()], { months: {} });
    const perSlice = await Promise.all(
      slices.map(async (slice) => {
        const mine = Object.entries(slice.wellNoByApi).filter(([api]) => idsByApi.has(api));
        const byWellNo = await wellMonthsBatch(
          slice,
          mine.map(([, wellNo]) => wellNo)
        );
        return mine.map(([api, wellNo]) => ({ api, months: byWellNo.get(wellNo) ?? [] }));
      })
    );
    const monthsByApi = new Map<string, RrcMonth[][]>();
    for (const { api, months } of perSlice.flat()) {
      const at = monthsByApi.get(api);
      if (at) at.push(months);
      else monthsByApi.set(api, [months]);
    }
    for (const [api, sets] of monthsByApi) {
      const months = mergeMonths(sets);
      if (months.length === 0) continue;
      for (const id of idsByApi.get(api) ?? []) {
        out.set(id, expandMonthlyToDaily(months, beforeByWell.get(id) ?? null));
      }
    }
    console.info(
      `${LOG} fleet history: ${out.size} of ${beforeByWell.size} wells found on the record ` +
        `(${slices.length} record${slices.length === 1 ? "" : "s"})`
    );
    return out;
  } catch (error) {
    console.error(`${LOG} fleet history failed`, error);
    return out;
  }
}
