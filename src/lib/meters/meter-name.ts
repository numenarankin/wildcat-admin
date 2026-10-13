/**
 * A meter's name, derived — never stored. The gas/water counterpart of
 * `@/lib/tanks/tank-name`, and the same reasoning: a meter is "the 1234 meter on
 * Dofflemeyer", which is its lease plus the number the gatherer's volume
 * statements carry. A separate free-text name was a third copy of that fact and
 * went stale the moment a lease was renamed.
 *
 * `meters.name` is no longer read or written. Every surface that shows a meter
 * shows this, computed from `lease_id` and `meter_no`.
 *
 * Pure module: no DB, no React, so the data layer, the reports, and their tests
 * all share one rule.
 */

/**
 * "Dofflemeyer M1234" — the lease and the meter number, `M`-prefixed.
 *
 * Both parts are optional in the data, and each gap has an answer:
 *  - no number (legacy rows; the meter form requires one now) → "Dofflemeyer meter"
 *  - no lease (an unassigned meter, as SWD meters often are) → "M1234"
 *  - neither → "Unnamed meter"
 *
 * A number the operator already typed with its own M ("M1234") is not doubled.
 */
export function meterDisplayName(
  leaseName: string | null | undefined,
  meterNo: string | null | undefined
): string {
  const lease = (leaseName ?? "").trim();
  const no = (meterNo ?? "").trim().replace(/^[Mm]\s*(?=\S)/, "");
  if (!no) return lease ? `${lease} meter` : "Unnamed meter";
  return lease ? `${lease} M${no}` : `M${no}`;
}
