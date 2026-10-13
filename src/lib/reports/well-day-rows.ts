import type { CompanyProductionRow } from "@/lib/reports/types";
import { isWholeDay } from "@/lib/production/partial-day";

/**
 * One well's daily rows for company production, assembled from series that are
 * ALREADY LOADED. Pure, so the rule that decides what a date carries — and which
 * of its streams count as measured — can be checked against a hand-computed
 * oracle rather than by eye on the dashboard.
 *
 * ## Which dates get a row
 *
 * The union of every date any stream covers, plus every date a hand-entered
 * reading exists for (its oil stock / sales are report figures whether or not a
 * tank gauged that day). Bounded below by `since` for a windowed caller.
 *
 * ## Each stream's tail is its own
 *
 * Every measured series ends at the hour of its last reading, so its final day is
 * a fraction of a day wearing a whole day's date (`partial-day.ts`). OIL takes
 * whole rows off at its boundary, as the well page's table does — a row keyed on
 * a day the tank did not finish is not a row. GAS and WATER end on their own
 * days, which need not be the oil day: a meter read at 08:00 on Monday with the
 * tank gauged Wednesday left Monday's gas at a third of a day, flagged measured,
 * and the dashboard averaged it into its newest bucket and carried it forward as
 * the well's rate. So on or after a stream's OWN boundary that stream is not
 * measured on the row; the row stays for whatever else measured that day, and
 * the hand-entered reading is the fallback exactly as on a day the meter never
 * covered. A date left with nothing measured and no reading is dropped: it was
 * only in the union because of a tail.
 *
 * ## A negative day is not a measurement
 *
 * The tank engine returns a gauge interval's net as-is, and it goes negative
 * when the level fell with no run ticket to explain it — the haul was not
 * entered. That is a reconciliation fault, not a production rate: nothing
 * produced minus barrels. Left on the row as "measured", the dashboard averaged
 * it into its newest bucket and, being the well's last measured day, carried it
 * forward as the fleet's current rate (three wells at -20 bbl/d for a week off
 * one missing ticket). Here the stream is unmeasured on that day instead, so the
 * chart carries the last rate that was actually measured; the tank pages and
 * the exception report still show the negative, which is where it is fixed.
 */
export function assembleWellDayRows(input: {
  wellId: string;
  wellName: string;
  oil: { rows: { date: string; bbls: number }[]; measuredThrough: string | null };
  /** MCF per day, carried in `bbls` as `wellGasSeriesMeasured` returns it. */
  gas: { rows: { date: string; bbls: number }[]; measuredThrough: string | null };
  water: { rows: { date: string; bbls: number }[]; measuredThrough: string | null };
  /** Hand-entered readings by date: the gas / water fallback, and stock / sales. */
  readings: Map<
    string,
    { gas: number | null; water: number | null; oilStock: number; oilSales: number }
  >;
  /** Inclusive lower bound, or undefined for all history. */
  since?: string;
}): CompanyProductionRow[] {
  const oilBy = new Map(input.oil.rows.map((p) => [p.date, p.bbls]));
  const gasBy = new Map(input.gas.rows.map((p) => [p.date, p.bbls]));
  const waterBy = new Map(input.water.rows.map((p) => [p.date, p.bbls]));
  const dates = new Set<string>([
    ...oilBy.keys(),
    ...gasBy.keys(),
    ...waterBy.keys(),
    ...input.readings.keys(),
  ]);

  const rows: CompanyProductionRow[] = [];
  for (const date of dates) {
    if (!isWholeDay(date, input.oil.measuredThrough)) continue;
    if (input.since && date < input.since) continue;
    const reading = input.readings.get(date);
    const oilMeasured = oilBy.has(date) && oilBy.get(date)! >= 0;
    const gasMeasured =
      gasBy.has(date) && isWholeDay(date, input.gas.measuredThrough) && gasBy.get(date)! >= 0;
    const waterMeasured =
      waterBy.has(date) &&
      isWholeDay(date, input.water.measuredThrough) &&
      waterBy.get(date)! >= 0;
    const measured = {
      oil: oilMeasured,
      gas: gasMeasured || reading?.gas != null,
      water: waterMeasured || reading?.water != null,
    };
    if (!measured.oil && !measured.gas && !measured.water && !reading) continue;
    rows.push({
      wellId: input.wellId,
      wellName: input.wellName,
      date,
      oilProduction: oilMeasured ? oilBy.get(date)! : 0,
      gasProduction: gasMeasured ? gasBy.get(date)! : (reading?.gas ?? 0),
      saltWater: waterMeasured ? waterBy.get(date)! : (reading?.water ?? 0),
      oilStock: reading?.oilStock ?? 0,
      oilSales: reading?.oilSales ?? 0,
      measured,
    });
  }
  return rows;
}
