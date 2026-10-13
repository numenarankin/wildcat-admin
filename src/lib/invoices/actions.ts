"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userCan } from "@/lib/auth/permissions";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getInvoiceDetail, type InvoiceDetail } from "@/lib/invoices/query";
import {
  getInvoiceFacilities as loadInvoiceFacilities,
  setInvoiceFacilities,
} from "@/lib/invoices/facilities";
import { listFacilityInvoices, type Invoice } from "@/lib/invoices/invoices";
import { getServiceProviders } from "@/lib/people/people";
import { providerKey } from "@/lib/ai/ingest/dedup-keys";
import type {
  InvoiceFacility,
  InvoiceFacilityType,
} from "@/lib/invoices/facility-types";
import type { DraftTransaction } from "@/lib/accounting/types";

/**
 * Server actions for the invoices page and the facility Invoices tabs.
 *
 * The /invoices list loads on the server with the page; everything here is
 * fetched on demand. The DETAIL is one document's worth of lines, references and
 * tax rows, which no row in the table needs. The facility tab loads on open for
 * the same reason in reverse: seven facility workspaces carry the tab, most
 * visits never open it, and pre-loading it would put an invoice query on every
 * well, tank, meter, battery and lease page render.
 */

/** Every line, reference and tax row for one invoice, for the viewer panel. */
export async function loadInvoiceDetail(
  invoiceId: string
): Promise<InvoiceDetail | null> {
  if (!(await userCan(["view_invoices", "manage_invoices"]))) return null;
  return getInvoiceDetail(invoiceId);
}

/** The facilities one invoice is billed against. */
export async function getInvoiceFacilities(
  invoiceId: string
): Promise<InvoiceFacility[]> {
  if (!(await userCan(["view_invoices", "manage_invoices"]))) return [];
  const sb = await getSupabaseServer();
  return loadInvoiceFacilities(sb, invoiceId);
}

/**
 * Replace an invoice's facility set.
 *
 * Gated on `manage_invoices` in app code as well as by RLS: a viewer's picker is
 * read-only, and an action that silently no-ops is worse than one that says no.
 * Revalidates /invoices and every facility page, since a tag change moves the
 * invoice between two tabs at once.
 */
export async function saveInvoiceFacilities(
  invoiceId: string,
  facilities: InvoiceFacility[]
): Promise<void> {
  if (!(await userCan(["manage_invoices"]))) {
    throw new Error("You do not have permission to edit invoices.");
  }
  const sb = await getSupabaseServer();
  await setInvoiceFacilities(sb, invoiceId, facilities);

  revalidatePath("/invoices");
  // The tab loads client-side on open, so only the pages that render server-side
  // alongside it need busting; `layout` catches the facility routes as a group.
  for (const path of ["/wells", "/production", "/leases", "/disposal"]) {
    revalidatePath(path, "layout");
  }
}

/** The invoices billed against one facility, for its Invoices tab. */
export async function loadFacilityInvoices(
  type: InvoiceFacilityType,
  id: string
): Promise<Invoice[]> {
  if (!(await userCan(["view_invoices", "manage_invoices"]))) return [];
  return listFacilityInvoices(type, id);
}

/**
 * Remove an invoice from the list.
 *
 * A soft delete: `deleted_at` is stamped and every read already filters on it
 * (`query.ts`), so the document, its lines and its refs stay intact. An invoice
 * is evidence of money owed, and a mis-click on a hover button must not destroy
 * the record behind a scanned bill. It also keeps ingest's duplicate check
 * honest: a deleted invoice does not resurrect itself as "already on file",
 * because that check filters on `deleted_at` too (`write.ts`) — and so does the
 * unique index behind it (`pidx_documents_natural_key`, since 2026090900400).
 * Both layers have to agree: the check alone passed, and the index alone then
 * refused the insert, which read to the user as exactly that resurrection.
 */
export async function deleteInvoice(invoiceId: string): Promise<void> {
  if (!(await userCan(["manage_invoices"]))) {
    throw new Error("You do not have permission to delete invoices.");
  }
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("pidx_documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", invoiceId)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  revalidatePath("/invoices");
  for (const path of ["/wells", "/production", "/leases", "/disposal"]) {
    revalidatePath(path, "layout");
  }
}

/**
 * Apply an Expenses-table edit to the charge line it derives from.
 *
 * Only the LINE's own fields land here. The date, the vendor and the invoice
 * number belong to the invoice, and the facility is a tag on the invoice too
 * (`invoice_facilities`), edited in the invoice modal where the picker lives — a
 * charge line has no facility column of its own to write, and inventing one would
 * put two answers on file for the same question.
 */
export async function updateExpenseLine(
  lineId: string,
  draft: DraftTransaction
): Promise<void> {
  if (!(await userCan("manage_invoices"))) {
    throw new Error("Not permitted to manage invoices.");
  }
  z.string().uuid().parse(lineId);
  const sb = await getSupabaseServer();

  const { data: current, error: readError } = await sb
    .from("pidx_lines")
    .select("id, document_id")
    .eq("id", lineId)
    .maybeSingle();
  if (readError) throw new Error(`updateExpenseLine (read): ${readError.message}`);
  if (!current) throw new Error("updateExpenseLine: line not found");

  const { error } = await sb
    .from("pidx_lines")
    .update({
      // The ledger holds an expense as a positive magnitude; the invoice holds it
      // as the vendor printed it.
      line_total: Math.abs(draft.amount),
      category_code: draft.categoryCode || null,
    })
    .eq("id", lineId);
  if (error) throw new Error(`updateExpenseLine: ${error.message}`);

  revalidatePath("/invoices");
  revalidatePath("/accounting");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO_DATE, "expected YYYY-MM-DD");
/** A money or quantity field: a number, or null for "not stated". */
const numOrNull = z.number().finite().nullable();

/**
 * Header fields the viewer can edit, all optional: the action patches what it
 * is given and leaves the rest alone. `invoiceDate` is the one field that
 * cannot be cleared — `doc_date` is NOT NULL, and an invoice with no date
 * cannot be listed, aged or paid.
 */
const invoiceHeaderPatch = z
  .object({
    vendor: z.string().max(300),
    docType: z.enum(["invoice", "field_ticket"]),
    invoiceNo: z.string().max(100),
    invoiceDate: isoDate,
    dueDate: isoDate.or(z.literal("")),
    paymentTerms: z.string().max(100),
    subtotal: numOrNull,
    taxPrinted: numOrNull,
    taxLabel: z.string().max(200),
    total: numOrNull,
  })
  .partial();
export type InvoiceHeaderPatch = z.infer<typeof invoiceHeaderPatch>;

/**
 * Edit an invoice's header in place.
 *
 * The viewer is where a misread is noticed — the scan is on the left, the
 * extracted record on the right — so it is where the correction is made. Each
 * click-to-edit row commits on its own, which is why this takes a PATCH: one
 * field per round trip, and nothing else on the document is touched.
 *
 * The vendor is stored as the TEXT typed, and re-resolved against the People
 * directory the same way ingest resolves one (`providerKey`), so a corrected
 * spelling links the invoice to the directory entry it always meant. An
 * unmatched name keeps its text and drops the link rather than guessing.
 *
 * The invoice number is what the natural key is built on, so a correction that
 * collides with a live document is refused with the same words the write path
 * uses, not a constraint code.
 */
export async function updateInvoiceHeader(
  invoiceId: string,
  patch: InvoiceHeaderPatch
): Promise<void> {
  if (!(await userCan("manage_invoices"))) {
    throw new Error("Not permitted to manage invoices.");
  }
  z.string().uuid().parse(invoiceId);
  const p = invoiceHeaderPatch.parse(patch);
  const sb = await getSupabaseServer();

  const doc: Record<string, unknown> = {};
  if (p.vendor !== undefined) {
    const vendor = p.vendor.trim();
    const providers = await getServiceProviders();
    const hit = vendor
      ? providers.find((v) => providerKey(v.company) === providerKey(vendor))
      : undefined;
    doc.vendor_text = vendor || null;
    doc.vendor_id = hit?.id ?? null;
  }
  if (p.docType !== undefined) doc.doc_type = p.docType;
  if (p.invoiceNo !== undefined) {
    const no = p.invoiceNo.trim();
    doc.doc_number = no || null;
    // A number a person typed is a printed number, not a minted key.
    if (no) doc.doc_number_derived = false;
  }
  if (p.invoiceDate !== undefined) {
    doc.doc_date = p.invoiceDate;
    doc.doc_date_derived = false;
  }
  if (p.dueDate !== undefined) doc.due_date = p.dueDate || null;
  if (p.paymentTerms !== undefined) doc.payment_terms = p.paymentTerms.trim() || null;
  if (p.subtotal !== undefined) doc.subtotal = p.subtotal;
  if (p.taxPrinted !== undefined) doc.tax_printed = p.taxPrinted;
  if (p.total !== undefined) doc.doc_total = p.total;

  if (Object.keys(doc).length > 0) {
    const { error, data } = await sb
      .from("pidx_documents")
      .update(doc)
      .eq("id", invoiceId)
      .is("deleted_at", null)
      .select("id");
    if (error) {
      if (error.code === "23505") {
        throw new Error("A document with that number is already on file.");
      }
      throw new Error(`updateInvoiceHeader: ${error.message}`);
    }
    if (!data || data.length === 0) {
      throw new Error("That invoice is not on file any more.");
    }
  }

  // The tax label lives on the document-level tax row, verbatim. A document
  // that never had one gets one now, so the label has somewhere to be.
  if (p.taxLabel !== undefined) {
    const label = p.taxLabel.trim() || null;
    const { data: rows, error: readErr } = await sb
      .from("pidx_taxes")
      .select("id")
      .eq("owner_document_id", invoiceId)
      .is("line_id", null)
      .limit(1);
    if (readErr) throw new Error(`updateInvoiceHeader (tax read): ${readErr.message}`);
    const existing = rows?.[0]?.id as string | undefined;
    const { error } = existing
      ? await sb.from("pidx_taxes").update({ label_raw: label }).eq("id", existing)
      : await sb.from("pidx_taxes").insert({
          owner_document_id: invoiceId,
          document_id: invoiceId,
          tax_type: "Other",
          label_raw: label,
          amount: p.taxPrinted ?? null,
        });
    if (error) throw new Error(`updateInvoiceHeader (tax): ${error.message}`);
  }

  revalidateInvoiceSurfaces();
}

/** The six references the viewer shows per line, by PIDX indicator. */
const LINE_REF_INDICATORS = [
  "AFENumber",
  "CostCenter",
  "OperatorGeneralLedgerCode",
  "JobNumber",
  "PurchaseOrderNumber",
  "DeliveryTicketNumber",
] as const;

type LineRefIndicator = (typeof LINE_REF_INDICATORS)[number];

const invoiceLinePatch = z
  .object({
    description: z.string().max(2000),
    chargeType: z.enum(["Labor", "Materials", "Equipment", "Other"]).nullable(),
    chargeSubtype: z.string().max(100),
    quantity: numOrNull,
    uom: z.string().max(40),
    unitPrice: numOrNull,
    noCharge: z.boolean(),
    amount: numOrNull,
    serviceStart: isoDate.or(z.literal("")),
    serviceEnd: isoDate.or(z.literal("")),
    taxable: z.boolean().nullable(),
    /** Only the indicators present are replaced; the rest are left as stored. */
    references: z
      .object(
        Object.fromEntries(
          LINE_REF_INDICATORS.map((k) => [k, z.string().max(100)])
        ) as Record<LineRefIndicator, z.ZodString>
      )
      .partial(),
  })
  .partial();
export type InvoiceLinePatch = z.infer<typeof invoiceLinePatch>;

/**
 * Edit one charge line in place. Same contract as the header: a patch, one
 * field per commit, nothing else touched.
 *
 * The service dates and the references are stored twice by design — as
 * columns on the line for query sanity, and as indicator-typed child rows
 * (`pidx_dates`, `pidx_refs`) because that is what PIDX is. An edit writes
 * both, replacing the child rows for just the indicators it was given, so the
 * two never disagree about a line.
 */
export async function updateInvoiceLine(
  lineId: string,
  patch: InvoiceLinePatch
): Promise<void> {
  if (!(await userCan("manage_invoices"))) {
    throw new Error("Not permitted to manage invoices.");
  }
  z.string().uuid().parse(lineId);
  const p = invoiceLinePatch.parse(patch);
  const sb = await getSupabaseServer();

  const { data: current, error: readError } = await sb
    .from("pidx_lines")
    .select("id, document_id")
    .eq("id", lineId)
    .maybeSingle();
  if (readError) throw new Error(`updateInvoiceLine (read): ${readError.message}`);
  if (!current) throw new Error("updateInvoiceLine: line not found");
  const documentId = current.document_id as string;

  const line: Record<string, unknown> = {};
  if (p.description !== undefined) line.description = p.description.trim() || null;
  if (p.chargeType !== undefined) line.charge_type = p.chargeType;
  if (p.chargeSubtype !== undefined) line.charge_subtype = p.chargeSubtype.trim() || null;
  if (p.quantity !== undefined) line.quantity = p.quantity;
  if (p.uom !== undefined) line.uom = p.uom.trim() || null;
  if (p.unitPrice !== undefined) line.unit_price = p.unitPrice;
  if (p.noCharge !== undefined) {
    line.no_charge = p.noCharge;
    // A "No Charge" line has no price: the vendor declined to bill it, which
    // is not the same as billing zero.
    if (p.noCharge) {
      line.unit_price = null;
      line.line_total = null;
    }
  }
  if (p.amount !== undefined) {
    line.line_total = p.amount;
    // Typing an amount onto a no-charge line is saying it IS charged.
    if (p.amount != null) line.no_charge = false;
  }
  if (p.serviceStart !== undefined) line.service_start = p.serviceStart || null;
  if (p.serviceEnd !== undefined) line.service_end = p.serviceEnd || null;
  if (p.taxable !== undefined) line.taxable = p.taxable;

  if (Object.keys(line).length > 0) {
    const { error } = await sb.from("pidx_lines").update(line).eq("id", lineId);
    if (error) throw new Error(`updateInvoiceLine: ${error.message}`);
  }

  // Mirror the dates onto their child rows: replace the types that changed.
  const dates: { date_type: string; value: string | "" }[] = [];
  if (p.serviceStart !== undefined) {
    dates.push({ date_type: "ServicePeriodStart", value: p.serviceStart });
  }
  if (p.serviceEnd !== undefined) {
    dates.push({ date_type: "ServicePeriodEnd", value: p.serviceEnd });
  }
  for (const d of dates) {
    const del = await sb
      .from("pidx_dates")
      .delete()
      .eq("line_id", lineId)
      .eq("date_type", d.date_type);
    if (del.error) throw new Error(`updateInvoiceLine (dates): ${del.error.message}`);
    if (d.value) {
      const ins = await sb.from("pidx_dates").insert({
        owner_document_id: documentId,
        line_id: lineId,
        date_type: d.date_type,
        value: d.value,
      });
      if (ins.error) throw new Error(`updateInvoiceLine (dates): ${ins.error.message}`);
    }
  }

  // Same for the references: only the indicators in the patch are replaced.
  for (const [indicator, raw] of Object.entries(p.references ?? {})) {
    const value = raw.trim();
    const del = await sb
      .from("pidx_refs")
      .delete()
      .eq("line_id", lineId)
      .eq("indicator", indicator);
    if (del.error) throw new Error(`updateInvoiceLine (refs): ${del.error.message}`);
    if (value) {
      const ins = await sb.from("pidx_refs").insert({
        owner_document_id: documentId,
        line_id: lineId,
        indicator,
        reference_number: value,
      });
      if (ins.error) throw new Error(`updateInvoiceLine (refs): ${ins.error.message}`);
    }
  }

  revalidateInvoiceSurfaces();
}

/**
 * Every page that renders an invoice's fields: the list, the ledger the lines
 * feed, and the facility pages whose Invoices tabs show the same row.
 */
function revalidateInvoiceSurfaces(): void {
  revalidatePath("/invoices");
  revalidatePath("/accounting");
  for (const path of ["/wells", "/production", "/leases", "/disposal"]) {
    revalidatePath(path, "layout");
  }
}

/**
 * Delete one expense: a soft delete on the charge line it derives from.
 *
 * The line is the only row a projected expense has, so this is where the deletion
 * lands. The invoice keeps the line — the document says what the vendor billed,
 * and that is not ours to rewrite — but the ledger stops counting it.
 */
export async function deleteExpenseLine(lineId: string): Promise<void> {
  if (!(await userCan("manage_invoices"))) {
    throw new Error("Not permitted to manage invoices.");
  }
  z.string().uuid().parse(lineId);
  const sb = await getSupabaseServer();

  const { error } = await sb
    .from("pidx_lines")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", lineId);
  if (error) throw new Error(`deleteExpenseLine: ${error.message}`);

  revalidatePath("/invoices");
  revalidatePath("/accounting");
}
