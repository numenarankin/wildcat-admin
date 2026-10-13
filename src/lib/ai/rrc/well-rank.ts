import { sharesByMonth, type TestRow, type WellRef } from "@/lib/rrc/well-share";

/**
 * Turning a lease's filed volumes into per-well estimates, so wells can be
 * ranked against each other.
 *
 * ## Why this is the only way to answer "which wells are best"
 *
 * Texas reports oil per LEASE, never per well. Asked for an operator's most
 * productive wells, the record can only answer with leases, and an answer that
 * silently substitutes one for the other is wrong in a way the reader cannot
 * see: a 17,302 bbl lease with eleven wells on it is not an 17,302 bbl well.
 *
 * The only per-well measured rate the state publishes is the well test (Form
 * W-10), so the estimate is the lease's filed volume divided in the ratio of its
 * wells' filed test rates. `@/lib/rrc/well-share` is that split, and it is what
 * the operator-facing well pages and Scout both use, so a well reads the same
 * number in all three places. The reasoning behind the ratio, the moving
 * weights, the service-hole exclusion and the completion and shut-in windows all
 * live there; this module is only the summation on top.
 *
 * ## Gas records need no split at all
 *
 * Measured on the mirror: all 138,962 gas records on a current schedule carry
 * exactly ONE well. A gas record's filed volume already belongs to that hole, so
 * there is nothing to allocate and no G-10 weighting to do. What DOES get split
 * by test is an oil lease's casinghead gas, and it is weighted by the W-10's gas
 * rate rather than its oil rate, because a well can carry most of a lease's oil
 * and little of its gas.
 *
 * Pure and dependency-free below the share function, so the arithmetic can be
 * checked against a hand-computed oracle rather than against whatever the mirror
 * returned.
 */

/** One filed month of a lease: what the operator reported, both streams. */
export interface LeaseVolumeMonth {
  /** `YYYY-MM`. */
  month: string;
  oil: number;
  gas: number;
}

/** One well's estimated share of the window. */
export interface WellShareTotals {
  well_no: string;
  /** Estimated barrels over the window. Null when the lease filed no oil. */
  oil_bbl: number;
  /** Estimated MCF over the window. */
  gas_mcf: number;
  /**
   * The well's share of the LAST month in the window, which is the figure a
   * person quotes. Shares move month to month as wells are drilled and shut in.
   */
  oil_share_latest: number | null;
  gas_share_latest: number | null;
  /** Whether a filed test rate weighted this well, or a head count did. */
  weighted_by: "well-test" | "head-count";
}

/**
 * Each well's estimated production over a window of filed lease-months.
 *
 * The months must already be the ones that were REPORTED. An unfiled month sits
 * in the mirror as a zero, and averaging those in reads as a well that stopped.
 *
 * Every well on the record is returned, including a zero one, because "this hole
 * is on the lease and made nothing" is an answer and its absence is not.
 */
export function rankLeaseWells(
  wells: readonly WellRef[],
  tests: readonly TestRow[],
  months: readonly LeaseVolumeMonth[]
): WellShareTotals[] {
  if (wells.length === 0 || months.length === 0) return [];

  const keys = months.map((m) => m.month);
  const oilShares = sharesByMonth([...wells], [...tests], keys, "oil");
  const gasShares = sharesByMonth([...wells], [...tests], keys, "gas");
  const last = keys[keys.length - 1];

  // A well is test-weighted when any test in the history names a rate for it.
  // Checked over the whole history rather than the latest test, because the
  // split reaches a test backwards to months before it was filed.
  const testedOil = new Set<string>();
  const testedGas = new Set<string>();
  for (const t of tests) {
    if ((t.dailyOil ?? 0) > 0) testedOil.add(t.wellNo);
    if ((t.dailyGas ?? 0) > 0) testedGas.add(t.wellNo);
  }

  return wells.map((w) => {
    let oil = 0;
    let gas = 0;
    for (const m of months) {
      oil += m.oil * (oilShares.get(m.month)?.get(w.wellNo) ?? 0);
      gas += m.gas * (gasShares.get(m.month)?.get(w.wellNo) ?? 0);
    }
    return {
      well_no: w.wellNo,
      oil_bbl: oil,
      gas_mcf: gas,
      oil_share_latest: oilShares.get(last)?.get(w.wellNo) ?? null,
      gas_share_latest: gasShares.get(last)?.get(w.wellNo) ?? null,
      weighted_by:
        testedOil.has(w.wellNo) || testedGas.has(w.wellNo) ? "well-test" : "head-count",
    };
  });
}

/**
 * The caveats that ride on every allocated per-well number.
 *
 * Attached to the RESULT rather than left here as a comment, because a reader
 * who does not have them cannot catch the error, and the error this invites is
 * quoting an estimate as a filing.
 */
export const ALLOCATION_NOTES = [
  "EVERY per-well volume here is an ESTIMATE and must be said as one. Texas files oil per LEASE and publishes no measured per-well volume at all; this is the lease's filed volume divided in the ratio of its wells' filed W-10 test rates.",
  "Oil and gas take SEPARATE shares. A well can carry most of a lease's oil and little of its gas, so weighting casinghead gas by the oil test would hand it gas it does not make.",
  "Shares MOVE. Each month is weighted by the test in effect that month, and a well is weighted only between its completion and its shut-in, so a well drilled last year takes no share of the years before it.",
  "A test is one good day, filed to establish an allowable. Across the state the sum of a lease's latest tests runs about 1.6x its actual daily production, so a test rate is never what a well makes. Only the RATIO between wells is used, and normalising to the lease's filed total cancels that bias exactly.",
  "A well with no filed test takes a head-count share of the part of the lease the tested wells do not account for. That is the weakest number here; `weighted_by` says which wells it applies to.",
  "Gas records are not split: every gas record on a current schedule carries exactly one well, so its filed volume already belongs to that hole.",
];
