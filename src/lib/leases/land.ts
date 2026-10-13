/**
 * The land record on a lease (docs/plans/lease-records.md): who leased it, the
 * primary term, whether production holds it, acreage, the royalty burden, the
 * payments that keep it alive when nothing produces, recording and pooling.
 *
 * Pure types and the empty record. Client-safe: the Land dialog and the leases
 * table import this, and `obligations.ts` derives the dated obligations from it.
 * Dates are ISO `YYYY-MM-DD` strings; every field is nullable because a lease
 * saves with none of them.
 */

/** One lessor on the instrument. */
export interface LeaseLessor {
  name: string;
  /** The interest as the instrument words it ("an undivided 1/2 of 1/8"). */
  interestText: string;
  /** The same interest as a decimal (0 to 1), when known. */
  interest: number | null;
}

/** How often a minimum royalty falls due. */
export type MinimumRoyaltyPeriod = "month" | "quarter" | "year";

export const MINIMUM_ROYALTY_PERIODS: readonly MinimumRoyaltyPeriod[] = [
  "month",
  "quarter",
  "year",
];

export interface LeaseLand {
  lessors: LeaseLessor[];
  /** Primary term, in months. */
  primaryTermMonths: number | null;
  effectiveDate: string | null;
  /** Explicit expiration; null means derive from the term (see `leaseExpiration`). */
  expirationDate: string | null;
  heldByProduction: boolean;
  /** When production began holding the lease. */
  hbpSince: string | null;
  grossAcres: number | null;
  netAcres: number | null;
  /** The lessor royalty as a decimal: 0.1875 for three sixteenths. */
  royaltyRate: number | null;
  shutInRoyaltyAmount: number | null;
  shutInRoyaltyDue: string | null;
  minimumRoyaltyAmount: number | null;
  minimumRoyaltyPeriod: MinimumRoyaltyPeriod | null;
  delayRentalAmount: number | null;
  delayRentalDue: string | null;
  delayRentalPaidThrough: string | null;
  recordingCounty: string | null;
  recordingVolume: string | null;
  recordingPage: string | null;
  recordingInstrumentNo: string | null;
  unitName: string | null;
  /** This lease's share of the pooled unit, as a decimal. */
  unitTractFactor: number | null;
}

/** A lease with no land record entered yet. */
export const EMPTY_LEASE_LAND: LeaseLand = {
  lessors: [],
  primaryTermMonths: null,
  effectiveDate: null,
  expirationDate: null,
  heldByProduction: false,
  hbpSince: null,
  grossAcres: null,
  netAcres: null,
  royaltyRate: null,
  shutInRoyaltyAmount: null,
  shutInRoyaltyDue: null,
  minimumRoyaltyAmount: null,
  minimumRoyaltyPeriod: null,
  delayRentalAmount: null,
  delayRentalDue: null,
  delayRentalPaidThrough: null,
  recordingCounty: null,
  recordingVolume: null,
  recordingPage: null,
  recordingInstrumentNo: null,
  unitName: null,
  unitTractFactor: null,
};

/** A stored `lessors` element, however an older row spelled it. */
function readLessor(value: unknown): LeaseLessor | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const name = typeof v.name === "string" ? v.name : "";
  const interestText = typeof v.interestText === "string" ? v.interestText : "";
  const interest =
    typeof v.interest === "number" && Number.isFinite(v.interest) ? v.interest : null;
  if (!name && !interestText && interest == null) return null;
  return { name, interestText, interest };
}

/** The `lessors` jsonb column as lessors; anything malformed is dropped. */
export function readLessors(value: unknown): LeaseLessor[] {
  if (!Array.isArray(value)) return [];
  return value.map(readLessor).filter((l): l is LeaseLessor => l !== null);
}
