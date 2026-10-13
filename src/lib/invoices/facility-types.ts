/**
 * What an invoice can be billed against, as shared shapes.
 *
 * Pure module (no `server-only`): the picker in the invoice modal and the server
 * data layer both import it — the same rule `@/lib/notes/types` follows, and for
 * the same reason.
 *
 * The five types mirror the check constraint on `invoice_facilities`
 * (2026081500200) and the facility half of `note_tags`. An SWD well is a `well`
 * and a water meter is a `meter`, because each is the same database row as its
 * production counterpart — the tag picker, facility comments and this all
 * collapse them the same way.
 */

export const INVOICE_FACILITY_TYPES = [
  "well",
  "tank",
  "meter",
  "battery",
  "lease",
] as const;

export type InvoiceFacilityType = (typeof INVOICE_FACILITY_TYPES)[number];

/** True for the five types `invoice_facilities` accepts. */
export function isInvoiceFacilityType(v: string): v is InvoiceFacilityType {
  return (INVOICE_FACILITY_TYPES as readonly string[]).includes(v);
}

/** One facility an invoice is against, as stored and as rendered in a chip. */
export interface InvoiceFacility {
  type: InvoiceFacilityType;
  /** A well slug or a uuid rendered as text. */
  id: string;
  /** Display name, snapshotted when tagged. */
  label: string;
}

/** Singular labels, for chip prefixes. */
export const INVOICE_FACILITY_LABEL: Record<InvoiceFacilityType, string> = {
  well: "Well",
  tank: "Tank",
  meter: "Meter",
  battery: "Battery",
  lease: "Lease",
};

/** Plural labels, for the per-type dropdown buttons. */
export const INVOICE_FACILITY_MENU_LABEL: Record<InvoiceFacilityType, string> = {
  well: "Wells",
  tank: "Tanks",
  meter: "Meters",
  battery: "Batteries",
  lease: "Leases",
};

/** Stable key for set membership and React keys. */
export function facilityKey(f: { type: string; id: string }): string {
  return `${f.type}:${f.id}`;
}
