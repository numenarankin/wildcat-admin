/**
 * Which lease a tank lands on when its battery changes.
 *
 * A tank's name is its lease plus its number (`./tank-name`), and the lease it
 * shows is the BATTERY's when it has one, its own otherwise (`mapTank`). So the
 * two fields in the tank form are not independent: picking a battery that sits
 * on a lease decides the tank's lease, and leaving the Lease field empty
 * underneath it would store a tank with no lease while the page displayed one.
 *
 * Pure so the rule is one testable statement rather than a line buried in an
 * onChange handler.
 */

/** A battery as the tank form knows it — only its lease matters here. */
export interface BatteryLeaseRef {
  id: string;
  leaseId?: string | null;
}

/**
 * The tank's lease after the Battery picker moves to `batteryId`.
 *
 * - Battery on a lease → that lease. This is the cascade: the battery is
 *   authoritative, so the tank follows it.
 * - Battery with no lease → unchanged. There is nothing to cascade, and blanking
 *   the tank's own lease would lose a fact the operator entered by hand.
 * - Battery cleared ("" / standalone) → unchanged. The tank is still on the same
 *   lease; it just isn't in a battery any more.
 *
 * @param currentLeaseId the lease the form currently holds ("" = unassigned)
 * @param batteryId the newly-picked battery ("" = standalone)
 */
export function leaseForBattery(
  currentLeaseId: string,
  batteryId: string,
  batteries: BatteryLeaseRef[]
): string {
  const lease = batteries.find((b) => b.id === batteryId)?.leaseId;
  return lease ? lease : currentLeaseId;
}
