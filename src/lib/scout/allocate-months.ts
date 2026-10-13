import type { LeaseMonth } from "./rrc-types";

/**
 * Scaling a lease-month to one wellbore, and summing the records a hole is on.
 *
 * Pure and side-effect free, split out of `rrc-queries` so the arithmetic can be
 * checked against a hand-computed oracle rather than against whatever the mirror
 * returned. The weights themselves come from `@/lib/rrc/well-share`, which the
 * operator-facing pages use too, so a well reads the same number in Scout as it
 * does on its own page.
 */

/**
 * Lease-month measures that are LIQUID, and move with the oil test weight.
 *
 * Allowables and ending balances move with the volume they cap. Leaving them at
 * lease scale would put a well's share under the WHOLE lease's allowable and
 * read as chronic underproduction; scaling both leaves the curve's shape
 * untouched and moves only the axis.
 */
export const LIQUID_MEASURES = [
  "oil_prod_vol",
  "oil_allow",
  "oil_ending_bal",
  "oil_tot_disp",
  "cond_prod_vol",
  "cond_limit",
  "cond_ending_bal",
  "cond_tot_disp",
] as const;

/** Lease-month measures that are GAS, and move with the gas test weight. */
export const GAS_MEASURES = [
  "gas_prod_vol",
  "gas_allow",
  "gas_lift_inj_vol",
  "gas_tot_disp",
  "csgd_prod_vol",
  "csgd_limit",
  "csgd_gas_lift",
  "csgd_tot_disp",
] as const;

/**
 * One month of a record, scaled to a wellbore's share of it.
 *
 * The two streams take DIFFERENT shares. A well can carry most of a lease's oil
 * and little of its gas, and weighting casinghead by the oil test would hand it
 * gas it does not make. Listing the measures explicitly rather than walking the
 * object is deliberate: `cycle` is a string and `reported` a boolean today, but
 * a future numeric field (a well count, a price) would be silently scaled.
 */
export function scaleMonth(
  month: LeaseMonth,
  oilShare: number,
  gasShare: number
): LeaseMonth {
  const out: LeaseMonth = { ...month };
  for (const k of LIQUID_MEASURES) {
    const v = month[k];
    if (typeof v === "number") out[k] = v * oilShare;
  }
  for (const k of GAS_MEASURES) {
    const v = month[k];
    if (typeof v === "number") out[k] = v * gasShare;
  }
  return out;
}

/**
 * Sum the records a hole sits on into one series, oldest first.
 *
 * Texas files oil at the lease level and gas at the WELL level, so a hole is
 * routinely on two records at once: an oil lease for its oil and its own
 * six-digit gas id for its gas. Showing one shows one stream.
 *
 * SUMMING DOUBLE-COUNTS NOTHING, because the two records populate different
 * columns for the same physical stream: an oil record carries its gas as
 * `csgd_prod_vol` (casinghead) and its liquid as `oil_prod_vol`, while a gas
 * record carries gas as `gas_prod_vol` and liquid as `cond_prod_vol`
 * (condensate). No column is ever filled by both.
 *
 * A month only one record reports keeps that record's reporting flags. Filed on
 * either is filed: a hole whose gas lease has reported and whose oil lease has
 * not is not an unreported month, and treating it as one would draw the cliff to
 * zero the reporting lag already causes.
 */
export function mergeRecordMonths(perRecord: LeaseMonth[][]): LeaseMonth[] {
  const byCycle = new Map<string, LeaseMonth>();
  for (const months of perRecord) {
    for (const m of months) {
      const at = byCycle.get(m.cycle);
      if (!at) {
        byCycle.set(m.cycle, { ...m });
        continue;
      }
      for (const k of [...LIQUID_MEASURES, ...GAS_MEASURES]) {
        const a = at[k];
        const b = m[k];
        if (typeof b === "number") at[k] = (typeof a === "number" ? a : 0) + b;
      }
      if (m.prod_report_filed === "Y") at.prod_report_filed = "Y";
      at.reported = at.reported || m.reported;
    }
  }
  return [...byCycle.values()].sort((a, b) => (a.cycle < b.cycle ? -1 : 1));
}

/**
 * A stream is the SUM of the two columns that can carry it.
 *
 *   oil record   liquid in `oil_prod_vol`,  gas in `csgd_prod_vol` (casinghead)
 *   gas record   gas in `gas_prod_vol`,     liquid in `cond_prod_vol` (condensate)
 *
 * Reading only `oil_prod_vol`/`gas_prod_vol` drops every oil lease's gas and
 * every gas lease's liquid. Only one column of each pair is ever populated on a
 * given row, so summing never double-counts.
 */
export const OIL_KEYS = ["oil_prod_vol", "cond_prod_vol"] as const;
export const GAS_KEYS = ["gas_prod_vol", "csgd_prod_vol"] as const;

/** One month's volume for a stream. */
export function streamOf(
  m: LeaseMonth,
  keys: readonly (keyof LeaseMonth)[]
): number {
  return keys.reduce((a, k) => a + (Number(m[k]) || 0), 0);
}

/**
 * The trailing-12 volume for a stream, over REPORTED months only.
 *
 * The one definition of "last 12 months" for this data. The map's hover and the
 * dossier's headline both read it, so the two cannot disagree — which they did:
 * hover took the latest month with any volume and multiplied by a share, while
 * the headline summed a year, and the same well read 0.8 bbl/d in one place and
 * 217 bbl in the other with no way to reconcile them.
 */
export function trailingVolume(
  monthly: LeaseMonth[],
  keys: readonly (keyof LeaseMonth)[],
  months = 12
): number {
  return monthly
    .filter((m) => m.reported)
    .slice(-months)
    .reduce((a, m) => a + streamOf(m, keys), 0);
}

/**
 * That volume as an average MONTHLY rate — the unit every single-value figure
 * on Scout reads in, so a hover, a stat tile and a list row all say the same
 * thing about the same well.
 *
 * The denominator is the number of months actually summed, NOT the window
 * width. `trailingVolume` keeps only reported months, and an unreported month
 * is one the RRC has not published — unknown, not zero. Dividing a new well's
 * three filed months by twelve would report a quarter of the rate it is
 * actually making. A month that was published with no report filed is a real
 * zero and stays in the denominator.
 */
export function monthlyRate(
  monthly: LeaseMonth[],
  keys: readonly (keyof LeaseMonth)[],
  months = 12
): number {
  const window = monthly.filter((m) => m.reported).slice(-months);
  if (window.length === 0) return 0;
  return window.reduce((a, m) => a + streamOf(m, keys), 0) / window.length;
}
