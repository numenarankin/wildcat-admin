/**
 * Splitting a lease's reported production among its wells, by well test.
 *
 * Texas reports OIL production per lease, never per well. The only per-well
 * measured rate in the public record is the well test (Form W-10), so the only
 * honest way to say what one well made is to divide the lease's reported volume
 * in the ratio of its wells' filed test rates.
 *
 * ## Why the ratio and not the rate
 *
 * A test is one day's rate on the day the well was tested, filed to establish an
 * allowable. Across 14,663 leases the sum of a lease's latest tests runs a median
 * 1.64x its actual daily production, because a test is a good day and the reported
 * series averages in downtime (`src/lib/scout/rrc-queries.ts`, "A TEST IS NOT A
 * MONTH"). A test rate is therefore never shown as what a well makes.
 *
 * The RATIO survives that bias intact: two wells' tests stay comparable to each
 * other even when both read high, and normalising to the lease's reported total
 * cancels the bias exactly. Doubling every test in a lease changes nothing here.
 * The alternative, an even split, asserts that every well on a lease is identical.
 *
 * ## The denominator is the RECORD's wells, not ours
 *
 * The W-10 file covers every operator, so shares are computed over every well on
 * the RRC lease record even when another operator owns some of them. That is what
 * makes our wells' shares true. The wells we hold then sum to whatever fraction of
 * the lease they actually made, which is the answer and not a shortfall. Narrowing
 * the denominator to our own wells would inflate every one of them.
 *
 * Pure and side-effect free, so the split can be checked against a hand-computed
 * oracle rather than against whatever the mirror returned.
 */

import type { RrcMonth } from "./lease-history-series";

/** One filed test, as much of it as weighting needs. */
export interface TestRow {
  /** The RRC's well number on the lease record. */
  wellNo: string;
  /** ISO `YYYY-MM-DD`. Rows without one cannot be placed in time and are dropped. */
  testDate: string | null;
  /** Tested oil rate, bbl/d. */
  dailyOil: number | null;
  /** Tested gas rate, MCF/d. On an oil lease this is the casinghead gas. */
  dailyGas: number | null;
}

/** A well on the record, and the window over which it could produce. */
export interface WellRef {
  /** The RRC's well number on the lease record. */
  wellNo: string;
  /**
   * Whether this hole can produce oil or gas to the lease at all.
   *
   * FALSE FOR SERVICE HOLES: injection, water supply, observation, storage,
   * brine mining. They are on the lease's schedule and would otherwise be
   * counted as untested producers and handed a head-count share of the oil they
   * physically cannot make. RRC lease 33913 has 18 wells on schedule of which 5
   * are injection or water supply, so the producers were losing 28% of the lease
   * to holes that inject. Measured mirror-wide: of ~202,000 producing W-10 tests,
   * 49 are filed by a hole typed INJECTION.
   */
  produces: boolean;
  /**
   * `YYYY-MM` of completion, or null when the record does not say.
   *
   * A well is not weighted in months before it was completed: it made nothing
   * then because it did not exist, and giving it a share would take barrels off
   * the wells that did. Real case, RRC lease 01/01077: its eight wells were
   * completed in 1987, 1988, 2003, 2014, 2015, 2021 and 2023, and the record
   * has production back to 1993.
   *
   * Null means eligible in every month. 38,221 of 440,050 wellbores on a current
   * schedule carry a blank completion date, and "we do not know when this well
   * was drilled" is not evidence that it did not exist.
   */
  completedMonth: string | null;
  /**
   * `YYYY-MM` the hole was shut in, or null while it is still running.
   *
   * A well is not weighted in months AFTER it stopped, for the same reason it is
   * not weighted before it was drilled: it made nothing then, and giving it a
   * share takes barrels off the wells that were actually running. Real case, API
   * 50336281 (RILEY E. E. 3): shut in 2022-12, yet the split was still handing
   * it 2.7 bbl/d of its lease's current production — and its own page, reading
   * the same series, said "Shut In".
   *
   * The mirror carries this for all 90,687 shut-in wells on a current schedule
   * (`wl_shut_in_date`, with `wb_shut_in_date` agreeing on 81,920 of them).
   */
  shutInMonth: string | null;
}

/** `YYYY-MM` -> well number -> that well's share of the month, summing to 1. */
export type ShareByMonth = Map<string, Map<string, number>>;

/** Which stream's tested rate does the weighting. */
export type Stream = "oil" | "gas";

function rateOf(t: TestRow, stream: Stream): number {
  const v = stream === "oil" ? t.dailyOil : t.dailyGas;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Each well's share of each month, from the lease's whole test history.
 *
 * SHARES MOVE. Wells are drilled, water out and are recompleted, so a month is
 * weighted by the test in effect THEN: each well's most recent test on or before
 * that month. Applying today's split to 1994 would be a different kind of wrong
 * from having no estimate at all.
 *
 * Months earlier than a well's first test use that first test, as the earliest
 * known statement of the well's character. A well with no test anywhere in the
 * history is unweightable in every month and takes the untested residual below.
 *
 * That reach-backwards is bounded at BOTH ends: a well is not weighted before it
 * was completed or after it was shut in, so the wells actually running in a given
 * month share the whole of it. It matters more than it sounds, because the
 * mirror's W-10 window only runs back to 2022 while `lease_production` runs back
 * decades, so almost every old month is weighted by a test filed long after it.
 *
 * A well is UNWEIGHTABLE, not zero, when its governing test reports no rate for
 * the stream. Zero would say the well made nothing; unweightable says we cannot
 * weight it, which is the difference between an estimate and an assertion.
 * Unweightable wells split the part of the lease their head-count implies:
 *
 *     weighted   = testedCount / wellCount
 *     tested w   = rate(w) / sum(rates) * weighted
 *     untested w = (1 - weighted) / untestedCount
 *
 * With no tested well at all the split is even, which is the only thing left to
 * say. Every branch sums to exactly 1, which is what lets the wells re-sum to the
 * lease.
 */
export function sharesByMonth(
  wellRefs: WellRef[],
  tests: TestRow[],
  months: string[],
  stream: Stream
): ShareByMonth {
  const out: ShareByMonth = new Map();
  const byWellNo = new Map(wellRefs.map((w) => [w.wellNo, w]));
  const allWells = [...byWellNo.keys()];
  if (allWells.length === 0) return out;

  // Each well's tests, oldest first, so the governing one is a scan backwards.
  const byWell = new Map<string, TestRow[]>();
  for (const t of tests) {
    if (!t.testDate) continue;
    if (!byWellNo.has(t.wellNo)) continue;
    const at = byWell.get(t.wellNo);
    if (at) at.push(t);
    else byWell.set(t.wellNo, [t]);
  }
  for (const rows of byWell.values()) {
    rows.sort((a, b) => (a.testDate! < b.testDate! ? -1 : 1));
  }

  for (const month of [...new Set(months)]) {
    // Only the wells that could produce, had been drilled, and had not yet been
    // shut in. If that is none of them, weight them all rather than dropping the
    // month: a record whose production predates every completion date on it is
    // telling us its dates
    // are wrong, not that the barrels were never produced, and a month that
    // shares out to nobody would silently delete them.
    const drilled = allWells.filter((w) => {
      const ref = byWellNo.get(w);
      if (ref && !ref.produces) return false;
      if (ref?.completedMonth && ref.completedMonth > month) return false;
      if (ref?.shutInMonth && ref.shutInMonth < month) return false;
      return true;
    });
    const wells = drilled.length > 0 ? drilled : allWells;

    // A test on any day of the month governs that month; comparing the test's
    // `YYYY-MM` to the month's is the same rule without date arithmetic.
    const rates = new Map<string, number>();
    for (const well of wells) {
      const rows = byWell.get(well);
      if (!rows || rows.length === 0) {
        rates.set(well, 0);
        continue;
      }
      let governing = rows[0]; // earliest, for months before the first test
      for (const row of rows) {
        if (row.testDate!.slice(0, 7) <= month) governing = row;
        else break;
      }
      rates.set(well, rateOf(governing, stream));
    }

    const tested = wells.filter((w) => (rates.get(w) ?? 0) > 0);
    const shares = new Map<string, number>();

    if (tested.length === 0) {
      const even = 1 / wells.length;
      for (const w of wells) shares.set(w, even);
    } else {
      const total = tested.reduce((s, w) => s + (rates.get(w) ?? 0), 0);
      const weighted = tested.length / wells.length;
      const untestedCount = wells.length - tested.length;
      const perUntested =
        untestedCount > 0 ? (1 - weighted) / untestedCount : 0;
      for (const w of wells) {
        const rate = rates.get(w) ?? 0;
        shares.set(w, rate > 0 ? (rate / total) * weighted : perUntested);
      }
    }
    out.set(month, shares);
  }
  return out;
}

/** One well's share of a month. Zero when the month or the well is unknown. */
export function shareOf(
  shares: ShareByMonth,
  month: string,
  wellNo: string
): number {
  return shares.get(month)?.get(wellNo) ?? 0;
}

/**
 * The share of a month held by a SUBSET of the record's wells: ours.
 *
 * This is what scales the lease page down to the operator's own wells so it
 * agrees with the sum of their well pages. It is 1 for a fully-owned lease, which
 * is the common case and leaves that lease's chart exactly as it was.
 */
export function ownedShareByMonth(
  shares: ShareByMonth,
  ownedWellNos: Iterable<string>
): Map<string, number> {
  const owned = new Set(ownedWellNos);
  const out = new Map<string, number>();
  for (const [month, byWell] of shares) {
    let sum = 0;
    for (const [well, share] of byWell) if (owned.has(well)) sum += share;
    out.set(month, sum);
  }
  return out;
}

/**
 * Scale monthly lease volumes by a per-month share of each stream.
 *
 * Applied to the MONTHLY volumes rather than to the expanded daily series, so a
 * month is multiplied once and `expandMonthlyToDaily` still owns the one rule
 * about how a month becomes days. Oil and gas are scaled by different shares: a
 * well's oil share and its casinghead gas share are separate numbers.
 *
 * A month with no share entry scales to zero, not to the full volume. The share
 * maps are built from the same month list as the volumes, so a gap means the well
 * is not on the record for that month, and passing the lease's whole volume
 * through would be the one failure mode that inflates rather than understates.
 */
export function applyShares(
  months: RrcMonth[],
  oilShare: Map<string, number>,
  gasShare: Map<string, number>
): RrcMonth[] {
  return months.map((m) => {
    const key = m.cycle.slice(0, 7);
    return {
      cycle: m.cycle,
      oilBbl: m.oilBbl * (oilShare.get(key) ?? 0),
      gasMcf: m.gasMcf * (gasShare.get(key) ?? 0),
    };
  });
}

/** One well's monthly volumes, from the lease's and the two share tables. */
export function monthsForWell(
  months: RrcMonth[],
  oilShares: ShareByMonth,
  gasShares: ShareByMonth,
  wellNo: string
): RrcMonth[] {
  const oil = new Map<string, number>();
  const gas = new Map<string, number>();
  for (const [month, byWell] of oilShares) oil.set(month, byWell.get(wellNo) ?? 0);
  for (const [month, byWell] of gasShares) gas.set(month, byWell.get(wellNo) ?? 0);
  return applyShares(months, oil, gas);
}
