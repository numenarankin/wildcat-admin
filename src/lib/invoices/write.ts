import "server-only";

import { getSupabaseServer } from "@/lib/supabase/server";
import { canonical } from "@/lib/ai/ingest/normalize";
import { providerKey } from "@/lib/ai/ingest/dedup-keys";
import { ilog, ierr, errorInfo } from "@/lib/ai/ingest/log";
import { getServiceProviders } from "@/lib/people/people";
import { getWells } from "@/lib/wells/wells";
import { getLeases } from "@/lib/leases/actions";
import { addInvoiceFacilities } from "@/lib/invoices/facilities";
import { matchWell } from "@/lib/ai/ingest/context";
import { matchLease } from "@/lib/statements/matching";
import { facilityNameFrom } from "@/lib/invoices/facility-backfill";
import type { InvoiceFacility } from "@/lib/invoices/facility-types";
import { documentDate } from "@/lib/ai/ingest/vendor-invoice";
import type { VendorInvoiceDraft } from "@/lib/ai/ingest/vendor-invoice";

/** One document that could not be written, in words the uploader can act on. */
export type InvoiceWriteFailure = { label: string; reason: string };

export type InvoiceWriteResult = {
  added: number;
  /** Already on file. Nothing to do, and not an error. */
  skipped: number;
  /** Genuinely failed to write. Kept apart from `skipped` on purpose. */
  failures: InvoiceWriteFailure[];
};

/**
 * File vendor invoices into the PIDX storage tables.
 *
 * One drafted document becomes a `pidx_documents` row plus one `pidx_lines` row
 * per charge line, with the per-line references (AFE, cost center, GL code,
 * ticket, work order, PO) as `pidx_refs` rows and the service dates as
 * `pidx_dates` rows — because that is the shape PIDX actually is: those are
 * indicator-typed values, not columns. `service_start` / `service_end` are also
 * promoted onto the line for querying; the child rows stay the source.
 *
 * Two deliberate non-behaviours:
 *  - **No transaction is written.** An invoice is a payable that has not been
 *    paid. Filing a ledger entry here would double-count it when the payment
 *    lands.
 *  - **No tax is computed.** `tax_printed` and the vendor's own label are stored,
 *    `tax_computed` is left null, and the reconciliation status records whether
 *    the label contradicts the work described. Checking the arithmetic needs
 *    rates by jurisdiction and effective date that do not exist yet, and
 *    reporting "we could not check" as a discrepancy would be worse than silence.
 *
 * SHARED ON PURPOSE. Two paths file invoices — the generic ingest approval and
 * the Invoices page's own reader — and they must produce identical rows. A
 * second copy of this loop would drift, and the drift would be silent because
 * both paths would still "work".
 */
export async function writeInvoiceDrafts(
  drafts: VendorInvoiceDraft[],
  fileId: string | null,
  /** Provenance recorded on the document's `raw` payload. */
  source: Record<string, unknown> = {}
): Promise<InvoiceWriteResult> {
  if (drafts.length === 0) return { added: 0, skipped: 0, failures: [] };

  const sb = await getSupabaseServer();

  // Vendor and property lookups, loaded once for the batch. Resolution is
  // best-effort: an unmatched property keeps its raw text and resolves later
  // rather than blocking the invoice from being filed.
  const vendorByKey = new Map(
    (await getServiceProviders()).map((p) => [providerKey(p.company), p.id] as const)
  );
  const wells = await getWells();
  const leases = await getLeases();
  const wellByKey = new Map(wells.map((w) => [canonical(w.name), w.id] as const));
  const leaseByKey = new Map(
    leases.map((l) => [canonical(l.name), l.id] as const)
  );

  let added = 0;
  let skipped = 0;
  const failures: InvoiceWriteFailure[] = [];

  // Names for the facility tag seeded below, so a chip reads "Brown #1" rather
  // than a slug. Snapshotted at tag time, exactly as `note_tags.label` is.
  const wellNameById = new Map(wells.map((w) => [w.id, w.name] as const));
  const leaseNameById = new Map(leases.map((l) => [l.id, l.name] as const));
  // `matchLease` compares a printed ref against a number and a name; leases carry
  // both, and a vendor prints whichever it was given.
  const leaseTargets = leases.map((l) => ({
    id: l.id,
    name: l.name,
    number: l.leaseNo,
  }));

  for (const d of drafts) {
    const vendorId = vendorByKey.get(providerKey(d.vendor)) ?? null;
    const propertyKey = canonical(d.propertyRef);
    /*
     * The property, resolved the way the rest of ingest resolves one.
     *
     * The exact key is tried first and is the common case. It is not enough on
     * its own: a vendor heads the property with the operator it bills and drops
     * the well's first name — "Sky Resources - Corbett #2" for the well filed as
     * "Roy Corbett 2" — so a map keyed on the canonical name misses, the invoice
     * files untagged, and it never reaches the well's Invoices tab. `matchWell`
     * is the shared ladder that handles both (`@/lib/ai/ingest/context`);
     * `facilityNameFrom` strips a "LEASE:" style label it does not.
     */
    const exactWell = wellByKey.get(propertyKey) ?? null;
    const propertyName = facilityNameFrom(d.propertyRef);
    const wellId =
      exactWell ?? matchWell([d.propertyRef, propertyName], wells) ?? null;
    const exactLease = wellId ? null : (leaseByKey.get(propertyKey) ?? null);
    const leaseId = wellId
      ? null
      : (exactLease ?? matchLease(propertyName, leaseTargets) ?? null);

    // A repeat of an invoice already on file is skipped rather than duplicated.
    // Mirrors `pidx_documents_natural_key`: org + type + vendor + number +
    // revision, only for a number the vendor actually printed, and only among
    // LIVE documents — a deleted invoice can be filed again, and the index
    // (since 2026090900400) excludes deleted rows for the same reason.
    if (!d.invoiceNoDerived) {
      const { data: existing } = await sb
        .from("pidx_documents")
        .select("id")
        .eq("doc_type", "invoice")
        .eq("doc_number", d.invoiceNo)
        .is("deleted_at", null)
        .limit(1);
      if (existing && existing.length > 0) {
        skipped += 1;
        continue;
      }
    }

    // A ticket that prints no date of its own files under its latest service
    // date; see `documentDate`.
    const docDate = documentDate(d);

    // Logged before the insert, because the insert's own error names the column
    // and not the value that violated it — a blank date is otherwise invisible
    // from the log alone.
    ilog("write vendorInvoice: document insert", {
      vendor: d.vendor,
      invoiceNo: d.invoiceNo,
      invoiceNoDerived: d.invoiceNoDerived,
      invoiceDate: d.invoiceDate,
      docDate: docDate.date,
      docDateDerived: docDate.derived,
      dueDate: d.dueDate,
      documentKind: d.documentKind,
      lines: d.lines.length,
      vendorResolved: vendorId !== null,
    });

    const { data: doc, error: docErr } = await sb
      .from("pidx_documents")
      .insert({
        doc_type: d.documentKind === "field_ticket" ? "field_ticket" : "invoice",
        transaction_purpose: "Original",
        doc_number: d.invoiceNo || null,
        doc_number_derived: d.invoiceNoDerived,
        doc_date: docDate.date,
        doc_date_derived: docDate.derived,
        due_date: d.dueDate || null,
        payment_terms: d.paymentTerms || null,
        vendor_id: vendorId,
        // What the letterhead says, kept whether or not it resolved. An
        // unresolved vendor is a directory gap, not an unreadable document.
        vendor_text: d.vendor || null,
        source_file_id: fileId,
        source_channel: "pdf",
        subtotal: d.subtotal,
        tax_printed: d.taxPrinted,
        // Left null on purpose: see the header note. A vendor calling the
        // 2.42% well-service tax "Sales Tax" is a naming habit, not a
        // discrepancy in the money, so it is classified below (`tax_type`)
        // and never raised as a finding.
        tax_computed: null,
        tax_recon_status: "not_computable",
        doc_total: d.invoiceTotal,
        total_line_items: d.lines.length,
        status: "unpaid",
        raw: { draft: d, source },
      })
      .select("id")
      .single();

    if (docErr || !doc) {
      // NOT a skip. A skip means "already on file, nothing to do"; this is the
      // write failing, and counting the two together is what let a constraint
      // violation reach the user as "that invoice is already on file".
      ierr("write vendorInvoice: document insert failed", errorInfo(docErr));
      failures.push({ label: describeDraft(d), reason: writeFailureReason(docErr, d) });
      continue;
    }

    /*
     * Seed the document's facility set from whatever the property text
     * resolved to, so an ingested invoice appears on that facility's Invoices
     * tab without anyone tagging it by hand.
     *
     * ADD, never replace: a person's corrections are the better answer and must
     * survive a re-scan of the same document. An unresolved property seeds
     * nothing and the invoice waits in the untagged state, which is honest —
     * the alternative is guessing a facility off a name we could not match.
     */
    const seeded: InvoiceFacility[] = [];
    if (wellId) {
      seeded.push({
        type: "well",
        id: wellId,
        label: wellNameById.get(wellId) ?? d.propertyRef,
      });
    } else if (leaseId) {
      seeded.push({
        type: "lease",
        id: leaseId,
        label: leaseNameById.get(leaseId) ?? d.propertyRef,
      });
    }
    if (seeded.length > 0) {
      try {
        await addInvoiceFacilities(sb, doc.id, seeded);
      } catch (err) {
        // The invoice is filed; a missing tag is a correction away. Failing the
        // whole document over its tab placement would be the worse trade.
        ierr("write vendorInvoice: facility seed failed", errorInfo(err));
      }
    }

    // The vendor's own tax label, kept verbatim next to the amount so a
    // mislabel is a stored fact rather than a re-derivation.
    if (d.taxPrinted != null) {
      await sb.from("pidx_taxes").insert({
        owner_document_id: doc.id,
        document_id: doc.id,
        tax_type: d.taxLabelVerdict === "mislabeled" ? "WellServiceTax" : "Other",
        label_raw: d.taxLabelRaw || null,
        amount: d.taxPrinted,
      });
    }

    for (const [i, l] of d.lines.entries()) {
      const { data: lineRow, error: lineErr } = await sb
        .from("pidx_lines")
        .insert({
          document_id: doc.id,
          line_no: l.lineNo || String(i + 1),
          description: l.description || null,
          charge_type: l.chargeType,
          charge_subtype: l.chargeSubtype || null,
          quantity: l.quantity,
          uom: l.uom || null,
          unit_price: l.unitPrice,
          no_charge: l.noCharge,
          line_total: l.amount,
          service_start: l.serviceStart || null,
          service_end: l.serviceEnd || null,
          taxable: l.taxable,
          tax_flag_raw: l.taxFlagRaw || null,
          well_id: wellId,
          lease_id: leaseId,
          raw_property_text: d.propertyRef || null,
          resolution_method: wellId
            ? exactWell
              ? "name_exact"
              : "name_matched"
            : leaseId
              ? "lease_name"
              : null,
          resolution_confidence: wellId || leaseId ? 1 : null,
        })
        .select("id")
        .single();

      if (lineErr || !lineRow) {
        ierr("write vendorInvoice: line insert failed", errorInfo(lineErr));
        continue;
      }

      // References are indicator-typed rows, not columns — that is what PIDX
      // is, and it is why a reference type we never anticipated still lands.
      const refs: { indicator: string; value: string }[] = [
        { indicator: "AFENumber", value: l.afeNumber },
        { indicator: "CostCenter", value: l.costCenter },
        { indicator: "OperatorGeneralLedgerCode", value: l.glCode },
        { indicator: "JobNumber", value: l.workOrderNo },
        { indicator: "PurchaseOrderNumber", value: l.poNumber },
        { indicator: "DeliveryTicketNumber", value: l.ticketNo },
      ].filter((r) => r.value.trim() !== "");

      if (refs.length > 0) {
        await sb.from("pidx_refs").insert(
          refs.map((r) => ({
            owner_document_id: doc.id,
            line_id: lineRow.id,
            indicator: r.indicator,
            reference_number: r.value,
          }))
        );
      }

      const dates: { date_type: string; value: string }[] = [];
      if (l.serviceStart) {
        dates.push({ date_type: "ServicePeriodStart", value: l.serviceStart });
      }
      if (l.serviceEnd) {
        dates.push({ date_type: "ServicePeriodEnd", value: l.serviceEnd });
      }
      if (dates.length > 0) {
        await sb.from("pidx_dates").insert(
          dates.map((x) => ({
            owner_document_id: doc.id,
            line_id: lineRow.id,
            date_type: x.date_type,
            value: x.value,
          }))
        );
      }
    }

    added += 1;
  }

  ilog("write vendorInvoice: done", {
    added,
    skipped,
    failed: failures.length,
    reasons: failures.map((f) => f.reason),
  });
  return { added, skipped, failures };
}

/** How the document reads on screen: its number if it printed one, else its vendor. */
function describeDraft(d: VendorInvoiceDraft): string {
  const kind = d.documentKind === "field_ticket" ? "field ticket" : "invoice";
  if (d.invoiceNo && !d.invoiceNoDerived) return `${kind} ${d.invoiceNo}`;
  if (d.vendor) return `the ${d.vendor} ${kind}`;
  return `that ${kind}`;
}

/**
 * A sentence the person who uploaded the document can act on.
 *
 * The Postgres error is the diagnosis, not the message: "null value in column
 * doc_date violates not-null constraint" is true and useless to an operator
 * holding a field ticket with no date printed on it. Each code we can actually
 * explain gets its own sentence; anything unrecognised says plainly that
 * nothing was saved rather than inventing a cause.
 */
function writeFailureReason(err: unknown, d: VendorInvoiceDraft): string {
  const e = (err ?? {}) as { code?: string; message?: string };
  const kind = d.documentKind === "field_ticket" ? "field ticket" : "invoice";

  if (e.code === "23502") {
    const column = /column "([^"]+)"/.exec(e.message ?? "")?.[1];
    return `The ${kind} is missing something the file requires${column ? ` (${column})` : ""}, so nothing was saved.`;
  }
  if (e.code === "23505") {
    return "A document with that number is already on file.";
  }
  if (e.code === "23503") {
    return "It points at a vendor or property that no longer exists, so nothing was saved.";
  }
  if (e.code === "42501") {
    return "You do not have permission to file invoices in this organization.";
  }
  return "It could not be saved and nothing was written. Try again, and if it keeps failing the file needs a closer look.";
}
