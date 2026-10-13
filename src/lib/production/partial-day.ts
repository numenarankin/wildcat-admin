/**
 * The last day a tank series covers is never a whole day, so the production
 * table and chart stop before it.
 *
 * A gauge is read at a time, not at midnight. The regularized series spreads
 * each interval across the days it covers, so the final day gets only the hours
 * between its 00:00 and that last reading — and the row reads like the battery
 * quit. Measured on this operator's own data:
 *
 *   Roach Parrot  gauged 07:52 today   16.37 bbl against ~50 the days before
 *                                       (7.87/24 = 0.328 of a day, and
 *                                        16.37/49.80 = 0.329)
 *   Roy Corbett   gauged 12:04 the 16th  2.04 bbl against ~4.06
 *                                       (12.07/24 = 0.503, and 2.04/4.06 = 0.502)
 *
 * Both are the same defect, which is why the cut CANNOT be "drop today". Roy
 * Corbett's partial row is dated yesterday — it is the last row on the table, and
 * dropping only today would leave it sitting there at half a day. The final day
 * is partial by construction (coverage ends at the last reading, which is never
 * 24:00), so the final day is what comes off, whatever date it carries.
 *
 * Nothing is lost. The next gauge closes that day's interval and the row returns
 * with a full day behind it.
 *
 * Applied to whole ROWS, not to the oil series alone: oil, gas and water share
 * the table's date column, so cutting one and not the others would leave the row
 * standing with a zero in it — a low number traded for a wrong one.
 *
 * ## The boundary belongs to the MEASURED series
 *
 * `partialTailDate(rows)` answers "when do these rows stop", and that is only the
 * same question as "when does the measurement stop" for a series that IS the
 * measurement: a tank, a battery, a lease. A well's series is a slice cut out of
 * one, and a slice also stops when the WELL stops — its split ended, or its share
 * went to 0 and `straightShares` drops it. That last day was gauged like any
 * other: 24 hours, all of it the well's. Cutting it deleted barrels that were
 * then allocated to nobody (a battery measuring 150 handing 120 to its wells).
 *
 * So a well's boundary comes from the loader that cut the slice
 * (`AllocatedSeries.measuredThrough`, src/lib/tanks/series-loaders.ts), never
 * from the slice. Do not call `partialTailDate` on a well series.
 *
 * Pure, so the boundary can be checked against a date rather than against
 * whatever the clock says while a test runs.
 */

/**
 * Whether a stream's series covers `date` as a WHOLE day: strictly before its
 * partial tail, or any date at all when there is no boundary (nothing measured,
 * nothing to trim).
 *
 * ## Gas and water have tails too
 *
 * The oil cut above takes whole rows, because oil is the only stream a well
 * page's table keys its dates on. But the gas series ends at the hour of the
 * meter's last reading exactly as the oil series ends at the last gauge
 * (`gas-series.ts`: "a span covers a partial day at each end"), and the water
 * series ends at its last measured node-day. Where those fall BEFORE the oil
 * boundary they survived the row cut: a meter read at 08:00 on Monday left a
 * third of a day's gas on Monday's row, flagged as measured, and the dashboard
 * averaged it into the newest bucket and carried it forward as the well's rate.
 * A per-stream day is unmeasured on or after its own stream's boundary — the
 * `measured` flags say so, and the rate maths already knows what to do with an
 * unmeasured day.
 */
export function isWholeDay(date: string, boundary: string | null): boolean {
  return boundary === null || date < boundary;
}

/**
 * The first date to EXCLUDE: the last day the series covers.
 *
 * Null for an empty series — nothing measured means nothing to trim, not "cut
 * everything".
 */
export function partialTailDate(
  series: readonly { date: string }[]
): string | null {
  let last: string | null = null;
  for (const p of series) {
    if (last === null || p.date > last) last = p.date;
  }
  return last;
}

/**
 * Drop every row on or after `boundary` (from {@link partialTailDate}).
 *
 * A null boundary leaves the rows alone: a well with no oil series has no
 * gauge-interval problem to correct, and its meter gas is entered as a whole
 * day's volume rather than derived from a reading time.
 *
 * "On or after", not "equal to", so a date fat-fingered into next month takes
 * the trailing rows with it instead of pinning a partial row to the end of the
 * table until the calendar catches up.
 */
export function withoutPartialTail<T extends { date: string }>(
  rows: T[],
  boundary: string | null
): T[] {
  return rows.filter((r) => isWholeDay(r.date, boundary));
}
