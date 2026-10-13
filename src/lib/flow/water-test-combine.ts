/**
 * Combine WELL TESTS across a well group — the pure core of "water follows the
 * well, not the node it was measured at."
 *
 * A well test records one well's water production over a window; the ratio of
 * those rates is how water measured at any tank or meter splits back to the wells
 * feeding it. A node's split therefore pools EVERY test touching any of the node's
 * member wells and uses each well's LATEST measured rate (absolute bbls/day, most
 * recent test wins per well), then to-normalizes the member wells by those rates.
 * A member well no test has measured gets 0% — the operator can pin it with a
 * manual override in the allocation card (manual wins).
 *
 * The split is EFFECTIVE-DATED off the test record, mirroring the battery oil
 * timeline (`wellTestBatteryPeriods`): each distinct test date cuts a period, and
 * a period's shares are the rates known AS OF that date, so re-testing one well
 * re-cuts the timeline from that date forward and leaves earlier dates on the
 * rates that were actually measured then. The earliest period reaches back to
 * {@link WATER_MIN_DATE}: the first test is the best statement available about the
 * history before it.
 *
 * This is what lets one test drive a tank AND a meter the moment the same well
 * feeds them: every node resolves from the same records.
 *
 * Pure (no I/O) so it unit-tests without a database and can resolve live.
 */

import { dayBefore, wellTestShares } from "@/lib/tanks/allocation";

/** How far back the EARLIEST test period reaches (covers all prior history). */
export const WATER_MIN_DATE = "1900-01-01";

/** A resolved per-well share of a node's water (percent, summing to 100). */
export interface WaterTestShare {
  wellId: string;
  pct: number;
}

/** A test reduced to what combining needs: an operative date + per-well measurements. */
export interface CombinableTest {
  /** The date this test's rates become operative (its window's close), ISO `YYYY-MM-DD`. */
  date: string;
  /**
   * The window's close as a full ISO timestamp, used ONLY to order two tests that
   * land on the same day so the later one wins. Defaults to `date` when absent.
   */
  at?: string;
  measurements: {
    wellId: string;
    /** Water produced over the window, barrels. */
    waterBbls: number;
    /** Window length in days (the rate basis); must be > 0 to count. */
    intervalDays: number;
  }[];
}

/** One well's measured rate from one test, with both ordering keys. */
interface RateSample {
  wellId: string;
  /** Operative day, for the "as of" cutoff. */
  date: string;
  /** Full ordering key (timestamp when the test has one, else the day). */
  key: string;
  rate: number;
}

/**
 * Every test's measurements flattened to per-well rate samples, sorted OLDEST
 * first. Folding them in that order makes "last write wins" mean "newest wins"
 * without depending on the caller's ordering — the bug this replaces was a
 * same-day tie resolved against an input that arrived newest-first, which handed
 * the day to the older test.
 */
function rateSamples(tests: CombinableTest[]): RateSample[] {
  const out: RateSample[] = [];
  for (const t of tests) {
    for (const m of t.measurements) {
      out.push({
        wellId: m.wellId,
        date: t.date,
        key: t.at ?? t.date,
        rate:
          m.intervalDays > 0 && m.waterBbls > 0 ? m.waterBbls / m.intervalDays : 0,
      });
    }
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * Each well's latest measured water rate (bbls/day) across the given tests, as of
 * `onDate` when one is passed (a test closing that day counts). For a well
 * measured by several tests the most recent wins; a non-positive interval or
 * barrels yields a 0 rate.
 */
export function latestRatePerWell(
  tests: CombinableTest[],
  onDate?: string
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of rateSamples(tests)) {
    if (onDate && s.date > onDate) continue;
    out.set(s.wellId, s.rate); // oldest first, so the last write is the newest test
  }
  return out;
}

/**
 * Split a node's member wells by the pooled test rates, to-normalized to 100.
 * Untested / zero-rate member wells drop out (0%). The result is the test-derived
 * water split for the node — the same shape a single-node test produced before,
 * but sourced from the whole group's records.
 */
export function nodeTestShares(
  memberWellIds: string[],
  ratesByWell: Map<string, number>
): WaterTestShare[] {
  const rates = memberWellIds.map((wellId) => ({
    wellId,
    rate: Math.max(0, ratesByWell.get(wellId) ?? 0),
  }));
  return wellTestShares(rates);
}

/** Convenience: pooled tests + a node's member wells → the node's split TODAY. */
export function resolveGroupWaterShares(
  memberWellIds: string[],
  tests: CombinableTest[]
): WaterTestShare[] {
  return nodeTestShares(memberWellIds, latestRatePerWell(tests));
}

/** One dated slice of a node's test-derived water split. */
export interface WaterTestPeriod {
  effectiveFrom: string;
  /** Chained: the day before the next period starts; null on the latest. */
  effectiveTo: string | null;
  shares: WaterTestShare[];
}

/** True when two splits are the same to the sixth decimal (a re-test that moved nothing). */
function sameShares(a: WaterTestShare[], b: WaterTestShare[]): boolean {
  if (a.length !== b.length) return false;
  const key = (s: WaterTestShare[]) =>
    [...s]
      .sort((x, y) => (x.wellId < y.wellId ? -1 : x.wellId > y.wellId ? 1 : 0))
      .map((x) => `${x.wellId}:${x.pct.toFixed(6)}`)
      .join("|");
  return key(a) === key(b);
}

/**
 * A node's water split as a DATED TIMELINE built from its member wells' test
 * history: one period per distinct test date, each holding the shares implied by
 * the rates known as of that date and running until the day before the next.
 *
 * A date whose rates produce no split (nothing measured yet, or every rate zero)
 * is skipped, and a test that leaves the split unchanged does not cut a period —
 * the timeline records changes in attribution, not visits. The first period is
 * pulled back to {@link WATER_MIN_DATE} so pre-test history keeps the earliest
 * split rather than falling to nobody.
 */
export function waterTestPeriods(
  memberWellIds: string[],
  tests: CombinableTest[]
): WaterTestPeriod[] {
  const members = [...new Set(memberWellIds.filter(Boolean))];
  if (members.length === 0) return [];

  const relevant = tests.filter((t) =>
    t.measurements.some((m) => members.includes(m.wellId))
  );
  const dates = [...new Set(relevant.map((t) => t.date))].sort();

  const periods: WaterTestPeriod[] = [];
  for (const from of dates) {
    const shares = nodeTestShares(members, latestRatePerWell(relevant, from));
    if (shares.length === 0) continue;
    const prev = periods[periods.length - 1];
    if (prev && sameShares(prev.shares, shares)) continue;
    periods.push({ effectiveFrom: from, effectiveTo: null, shares });
  }
  if (periods.length === 0) return [];

  periods[0].effectiveFrom = WATER_MIN_DATE;
  for (let i = 0; i < periods.length - 1; i++) {
    periods[i].effectiveTo = dayBefore(periods[i + 1].effectiveFrom);
  }
  return periods;
}
