/**
 * Shared row shape for the derivable production reports (GBC-3).
 *
 * These reports aggregate the existing `production_readings` across the whole
 * company, so every reading is carried alongside the well it belongs to. This
 * is the single input all the pure derivations in `derive.ts` consume — no new
 * tables, no schema change.
 */

/** One production reading, denormalized with its well identity. */
export interface CompanyProductionRow {
  wellId: string;
  wellName: string;
  /** Production date as an ISO `YYYY-MM-DD` string. */
  date: string;
  oilProduction: number;
  /** Oil held in tanks (lease inventory), in barrels. */
  oilStock: number;
  /** Oil sold / hauled, in barrels. */
  oilSales: number;
  gasProduction: number;
  saltWater: number;
  /**
   * Which streams were actually MEASURED on this date, as opposed to defaulting
   * to 0 because the row exists for another stream's sake.
   *
   * A row is emitted for the union of the three series' dates, so a day the gas
   * meter was read but the tank was not carries `oilProduction: 0` — which is
   * indistinguishable from a well that made nothing. Every consumer that
   * averages or trends a stream has to be able to tell those apart; the exception
   * scan could not, and reported a well nobody had gauged for five days as "at
   * zero" while its gas meter was still reporting.
   *
   * Optional so a fixture or an older producer stays valid; absent means "assume
   * measured", which is the pre-existing behaviour.
   */
  measured?: { oil: boolean; gas: boolean; water: boolean };
}
