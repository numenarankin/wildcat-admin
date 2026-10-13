/**
 * Turning the state's monthly lease production into a daily series.
 *
 * Texas reports production per lease per MONTH. The app's charts are daily, so
 * to show anything before an operator's own records begin the two have to be
 * reconciled, and the only honest way to do it without inventing detail is to
 * spread each month's volume evenly across its days: 310 bbl in a 31-day month
 * is 10 bbl/d for all 31 days. That is a flat step per month, which is exactly
 * what the source supports and no more.
 *
 * ## What this is NOT
 *
 * It is not measured production. Nothing derived here may reach revenue, the
 * production table, or any headline volume — settlement statements are the one
 * source of truth for revenue, and the operator's tank readings are the one
 * source of truth for what was produced. This feeds the chart, and the decline
 * fit drawn on it, and nothing else. See `docs/plans/` and the lease page.
 *
 * Pure and side-effect free so the shape of the series can be checked against a
 * hand-computed oracle rather than against whatever the query returned.
 */

/** One month of the state's record for a lease. `cycle` is any parseable date. */
export interface RrcMonth {
  /** Production month. Only its year and month are read. */
  cycle: string;
  /** Barrels of oil reported for the whole month. */
  oilBbl: number;
  /** MCF of gas reported for the whole month. */
  gasMcf: number;
}

export interface HistoryPoint {
  date: string;
  /** Constant daily rate implied by the month's volume. */
  value: number;
}

export interface LeaseHistorySeries {
  /** Daily oil rate, bbl/d. Empty when the lease never reported oil. */
  oil: HistoryPoint[];
  /** Daily gas rate, MCF/d. Empty when the lease never reported gas. */
  gas: HistoryPoint[];
}

const EMPTY: LeaseHistorySeries = { oil: [], gas: [] };

/**
 * The span a stream was actually reported over: `[first, last]` month index with
 * a volume, or null if it never had one.
 *
 * A ZERO OUTSIDE THAT SPAN IS NOT A MEASUREMENT. Texas runs two to three months
 * behind, and the months it has not collected yet are filed as zero rather than
 * left out — `prod_report_filed = 'Y'` does not exclude them. Drawn as-is, every
 * lease and well falls off a cliff to nothing at the right-hand edge of the
 * chart: real case, gas record 7B/126318 reports 130 MCF in November 2025, 125
 * in December, then 0.0 for January through May 2026.
 *
 * The leading end matters just as much for a well, because a gas well's oil
 * column is zero for its whole life. Drawing that produces a flat zero line and
 * an axis in denormals (2e-323), which is what an all-zero series does to a
 * chart. A stream that was never reported should be absent, not flat.
 *
 * Zeros BETWEEN the two ends are kept: a well shut in for a season really did
 * make nothing, and that is a fact the chart should show.
 */
function reportedRange(
  months: RrcMonth[],
  volume: (m: RrcMonth) => number
): [number, number] | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < months.length; i++) {
    if (volume(months[i]) > 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : [first, last];
}

/** Days in the month `YYYY-MM` belongs to. */
function daysInMonth(year: number, month1to12: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function iso(year: number, month1to12: number, day: number): string {
  const mm = String(month1to12).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Expand monthly volumes into a daily series, stopping before `before`.
 *
 * `before` is the operator's earliest own production date. The state's record
 * covers every day STRICTLY before it and never overlaps, so the two halves can
 * be concatenated without double-counting a single barrel — one rule, one
 * boundary, no ambiguity about which source owns a given day. Pass null when the
 * operator has recorded nothing yet and the whole history should show.
 *
 * A stream with no reported volume anywhere is returned empty rather than as a
 * long line of zeros: an oil lease that never made gas should not draw a gas
 * history implying it was measured and found to be nothing. Each stream is also
 * cut to the span it was actually reported over, so the months Texas has not
 * collected yet do not draw a cliff to zero (see `reportedRange`).
 */
export function expandMonthlyToDaily(
  months: RrcMonth[],
  before: string | null
): LeaseHistorySeries {
  if (months.length === 0) return EMPTY;

  const oilRange = reportedRange(months, (m) => m.oilBbl);
  const gasRange = reportedRange(months, (m) => m.gasMcf);
  if (!oilRange && !gasRange) return EMPTY;

  const oil: HistoryPoint[] = [];
  const gas: HistoryPoint[] = [];

  for (const [index, month] of months.entries()) {
    const anyOil = oilRange != null && index >= oilRange[0] && index <= oilRange[1];
    const anyGas = gasRange != null && index >= gasRange[0] && index <= gasRange[1];
    if (!anyOil && !anyGas) continue;
    const parsed = /^(\d{4})-(\d{2})/.exec(month.cycle);
    if (!parsed) continue;
    const year = Number(parsed[1]);
    const mon = Number(parsed[2]);
    if (mon < 1 || mon > 12) continue;

    const days = daysInMonth(year, mon);
    const oilRate = month.oilBbl / days;
    const gasRate = month.gasMcf / days;

    for (let day = 1; day <= days; day++) {
      const date = iso(year, mon, day);
      // Strictly before: the first day the operator recorded belongs to them.
      if (before !== null && date >= before) continue;
      if (anyOil) oil.push({ date, value: oilRate });
      if (anyGas) gas.push({ date, value: gasRate });
    }
  }

  const byDate = (a: HistoryPoint, b: HistoryPoint) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  oil.sort(byDate);
  gas.sort(byDate);
  return { oil, gas };
}

/** One month of the state's record, as a rate, which is how a table shows it. */
export interface HistoryMonth {
  /** `YYYY-MM`. */
  month: string;
  /** Null when the state reported no oil for that month, which is not zero. */
  oilBblPerDay: number | null;
  /** Null when the state reported no gas for that month. */
  gasMcfPerDay: number | null;
}

/**
 * The daily series folded back to the months Texas actually files.
 *
 * The chart wants a daily rate so its line is continuous; a TABLE of 12,000
 * identical daily rows derived from 404 monthly filings would be unreadable and
 * would imply a precision the source does not have. Averaging a month's daily
 * rates returns exactly the flat rate they were expanded from, so this is the
 * state's own number rather than a second derivation of it.
 *
 * EACH STREAM COUNTS ITS OWN DAYS. The two no longer span the same months: a gas
 * well's oil column stops decades before its gas does, and dividing that month's
 * gas by the oil series' day count is a division by zero that renders as 0.0 for
 * both. A month a stream did not report is null, not zero, and the tables show it
 * as a dash for the same reason the chart draws no line there.
 *
 * Newest first, matching the measured rows a table puts above it.
 */
export function historyMonths(history: LeaseHistorySeries): HistoryMonth[] {
  const oil = ratesByMonth(history.oil);
  const gas = ratesByMonth(history.gas);
  const months = [...new Set([...oil.keys(), ...gas.keys()])];
  return months
    .map((month) => ({
      month,
      oilBblPerDay: oil.get(month) ?? null,
      gasMcfPerDay: gas.get(month) ?? null,
    }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}

/** One stream's mean daily rate per month, over the days it actually covers. */
function ratesByMonth(points: HistoryPoint[]): Map<string, number> {
  const totals = new Map<string, { sum: number; days: number }>();
  for (const p of points) {
    const month = p.date.slice(0, 7);
    const at = totals.get(month) ?? { sum: 0, days: 0 };
    at.sum += p.value;
    at.days += 1;
    totals.set(month, at);
  }
  return new Map(
    [...totals].map(([month, v]) => [month, v.days > 0 ? v.sum / v.days : 0])
  );
}

/**
 * The operator's own earliest production date across the streams they record,
 * or null when they have recorded nothing.
 *
 * This is the boundary. It is computed from the measured series rather than
 * configured, so it moves on its own as soon as the first tank reading lands and
 * the state's numbers retreat ahead of it.
 */
export function earliestMeasuredDate(
  ...series: { date: string }[][]
): string | null {
  let earliest: string | null = null;
  for (const points of series) {
    for (const p of points) {
      if (earliest === null || p.date < earliest) earliest = p.date;
    }
  }
  return earliest;
}
