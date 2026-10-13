import "server-only";

import { canonical } from "@/lib/ai/ingest/normalize";
import type { ProposalDraft } from "@/lib/ai/ingest/scan";
import type { VendorInvoiceDraft } from "@/lib/ai/ingest/vendor-invoice";

/**
 * Invoices → facility and directory backfill: the well or lease an invoice is
 * charged to and the vendor that sent it, proposed as ordinary approval cards
 * when they aren't on file yet.
 *
 * The gap this closes: `writeInvoiceDrafts` resolves `propertyRef` against the
 * wells and leases that exist and, finding neither, files the invoice untagged
 * and says nothing. The property is real — a vendor billed work against it —
 * so the invoice lands on no facility's Invoices tab and the equipment card the
 * same document produced has no well to attach to.
 *
 * Proposed, never created outright. An OCR misread would otherwise mint a
 * permanent well called "Roy Corbet 2", and a facility is the thing every other
 * record hangs off. The card is the review step that a name lifted from a scan
 * needs.
 *
 * Free: no model call. The property text is already extracted, and whether it
 * is on file is a lookup. Duplicates are not this module's job — the shared
 * scan-time suppression (`suppress.ts`, `wells`/`leases`) drops a facility that
 * already exists, which keeps one definition of "already on file" rather than a
 * second copy here that could drift from it.
 */

/**
 * Labels a vendor puts in front of the property, which are not part of its name:
 * `LEASE: Corbett #4`, `Well - Brown #1`, `Property: Repass 2`.
 */
const PROPERTY_LABEL = /^\s*(lease|well|property|location|field)\s*[:\-]\s*/i;

/**
 * The facility's own name, with the operator stripped off the front.
 *
 * Vendors address the property the way they file it: `Sky Resources - Brown #1`
 * names the OPERATOR and then the well (see `skills/vendor-invoice.md:44`, where
 * that exact form is the example). `propertyRef` keeps it verbatim on purpose —
 * it is what the document printed — but the well being created is called
 * "Brown #1". Seeding the operator into the name gives the operator a well
 * named after itself, and every later match against that well fails.
 *
 * The LAST segment wins: separators nest outward from the facility (`Operator -
 * Lease - Well #1`), so the tail is the most specific thing named. Split on
 * spaced separators only, since `Smith-4H` and `A-1` are single names.
 */
export function facilityNameFrom(propertyRef: string): string {
  const withoutLabel = propertyRef.replace(PROPERTY_LABEL, "").trim();
  const segments = withoutLabel
    .split(/\s+[-–—/|]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : withoutLabel;
}

/**
 * A well number in the way this trade prints one: `#2`, `No. 2`, `Unit 3`, a
 * trailing `2`, or a trailing `-2`.
 */
const WELL_NUMBER = /(?:#\s*\d|\bno\.?\s*\d|\bunit\s+\d|[\s-]\d+[a-z]?$)/i;

/**
 * Well or lease, from how the vendor wrote the property.
 *
 * A charge printed against "Roy Corbett #2" names a WELL: the number is the
 * whole point of writing it. Without one, "Corbett Lease" or "Corbett A" is the
 * lease. Wrong guesses are cheap here and only here, because the card is
 * approved by a person who can see the document, and the far more common case
 * is a well: `wellEquipment`, `service` and `production` all attach to one.
 */
export function facilityKindFor(propertyRef: string): "wells" | "leases" {
  if (WELL_NUMBER.test(propertyRef.trim())) return "wells";
  if (/\blease\b/i.test(propertyRef)) return "leases";
  return "wells";
}

/**
 * One `wells` / `leases` draft per distinct property the invoices name.
 *
 * County rides along when the invoice printed one, since it is the field the
 * user would otherwise fill by hand on the card.
 */
export function facilityBackfillDrafts(
  drafts: VendorInvoiceDraft[]
): ProposalDraft[] {
  const wells: unknown[] = [];
  const leases: unknown[] = [];
  const seen = new Set<string>();

  for (const d of drafts) {
    const name = facilityNameFrom(d.propertyRef);
    if (!name) continue;
    const key = canonical(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (facilityKindFor(name) === "wells") {
      wells.push({
        name,
        county: d.county,
        sourceText: `Charged to "${d.propertyRef}" on the ${d.vendor || "vendor"} invoice`,
      });
    } else {
      leases.push({
        name,
        leaseNo: "",
        county: d.county,
        sourceText: `Charged to "${d.propertyRef}" on the ${d.vendor || "vendor"} invoice`,
      });
    }
  }

  const out: ProposalDraft[] = [];
  if (wells.length > 0) out.push({ type: "wells", wellId: null, rows: wells });
  if (leases.length > 0) out.push({ type: "leases", wellId: null, rows: leases });
  return out;
}

/**
 * The vendor that sent the invoice, proposed for the People directory.
 *
 * Same reasoning as the facility above, one table over: `writeInvoiceDrafts`
 * resolves the printed vendor against `service_providers` and, finding nothing,
 * files the invoice with a null `vendor_id`. The company is real — it billed
 * for work — so it belongs in the directory the rest of the app reads, and
 * until it is there the invoice cannot be grouped, filtered or totalled by
 * vendor.
 *
 * `service` is left blank rather than guessed from the charge lines: a pulling
 * unit on one ticket does not make a company a pulling-unit contractor, and the
 * card is faster to approve than to correct.
 */
export function vendorBackfillDrafts(
  drafts: VendorInvoiceDraft[]
): ProposalDraft[] {
  const rows: unknown[] = [];
  const seen = new Set<string>();

  for (const d of drafts) {
    const company = d.vendor.trim();
    if (!company) continue;
    const key = canonical(company);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      company,
      service: "",
      contact: "",
      phone: "",
      email: "",
      status: "Active",
      description: "",
      sourceText: `Billed ${d.documentKind === "field_ticket" ? "field ticket" : "invoice"}${d.invoiceNo && !d.invoiceNoDerived ? ` ${d.invoiceNo}` : ""}`,
    });
  }

  return rows.length > 0
    ? [{ type: "serviceProviders", wellId: null, rows }]
    : [];
}
