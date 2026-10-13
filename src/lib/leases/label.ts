/**
 * How a lease is written in a picker.
 *
 * Two identifiers, one row: the lease NUMBER is what the state, the purchaser
 * and the operator's own paperwork call it, and the NAME is what everyone says
 * out loud. A selector that shows only one of them is unreadable to whoever
 * came in through the other, so most of them show both.
 *
 * The exception is a picker whose choice becomes part of a NAME — a meter is
 * "Dofflemeyer M1234", built from its lease's name — where the number in front
 * is a second identifier the reader has to look past to see what they are about
 * to call the thing.
 *
 * Both live here so the join and the strip cannot drift apart.
 */

/** What separates the number from the name. */
const SEPARATOR = " · ";

/** "123 · Roach", or just "Roach" when the lease has no number. */
export function leaseLabel(lease: {
  leaseNo?: string | null;
  name: string;
}): string {
  return lease.leaseNo ? `${lease.leaseNo}${SEPARATOR}${lease.name}` : lease.name;
}

/** The name half of a `leaseLabel`, for the pickers that want the name alone. */
export function leaseName(label: string): string {
  const at = label.indexOf(SEPARATOR);
  return at === -1 ? label : label.slice(at + SEPARATOR.length);
}
