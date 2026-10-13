import "server-only";

import { getSupabaseServer } from "@/lib/supabase/server";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { cachedInvoiceDocuments, cachedInvoiceFacilities, cachedVendorNames } from "./documents";
import {
  invoiceIdsForFacility,
  listInvoiceFacilities,
} from "@/lib/invoices/facilities";
import type {
  InvoiceFacility,
  InvoiceFacilityType,
} from "@/lib/invoices/facility-types";

/**
 * Read layer over the PIDX invoice tables (`pidx_documents` + `pidx_lines` and
 * their indicator-typed children).
 *
 * Two things shape this module.
 *
 * **It tolerates the tables not existing.** The storage migrations ship ahead of
 * being applied, and Orion's tools are loaded on every chat turn. A bare
 * `relation does not exist` (Postgres `42P01`) escaping from here would take down
 * an unrelated question about a tank. An unapplied migration reads as "no
 * invoices"; every other error still throws.
 *
 * **Rollups are computed here, not by the model.** Asking the model to add up a
 * hundred line amounts is slower, costs tokens, and is wrong often enough to
 * matter. It gets totals; it does arithmetic on nothing.
 */

/** Postgres: relation does not exist. The migration has not been applied. */
const UNDEFINED_TABLE = "42P01";

function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === UNDEFINED_TABLE;
}

/**
 * A stored `timestamptz` service date as the calendar day it represents.
 *
 * PIDX models `ServiceDateTime` as a dateTime, so the columns are timestamptz
 * and PostgREST returns `2026-03-12T00:00:00+00:00`. Every consumer — the table
 * cell, an Orion answer, a date filter — wants the DAY the work happened.
 * Slicing the ISO string keeps the stored UTC day; rendering through `Date`
 * would shift it west of Greenwich and silently report the work a day early.
 */
function toIsoDate(v: string | null): string | null {
  return v ? v.slice(0, 10) : null;
}

export interface InvoiceSummary {
  id: string;
  docType: "invoice" | "field_ticket";
  invoiceNo: string | null;
  /** True when no number was printed and the key was minted from date+property. */
  invoiceNoDerived: boolean;
  invoiceDate: string | null;
  dueDate: string | null;
  /** Earliest / latest service date across the lines; the period worked. */
  serviceStart: string | null;
  serviceEnd: string | null;
  vendor: string | null;
  /** What the document printed, verbatim. Present even when unresolved. */
  propertyText: string | null;
  /**
   * What the invoice is BILLED AGAINST — the maintained facility set
   * (`invoice_facilities`), seeded from the printed property at write time and
   * edited in the invoice modal. This, not `propertyText`, is the answer to
   * "whose cost is this": the text is the vendor's spelling, the set is ours.
   */
  facilities: InvoiceFacility[];
  wellIds: string[];
  leaseIds: string[];
  subtotal: number | null;
  taxPrinted: number | null;
  total: number | null;
  lineCount: number;
  status: string | null;
  /** Set when the vendor's tax label contradicts the work described. */
  taxLabelRaw: string | null;
  taxReconStatus: string | null;
  fileId: string | null;
}

export interface InvoiceLineDetail {
  /** The `pidx_lines` row, so an edit made in the viewer can be written back. */
  id: string;
  lineNo: string;
  description: string | null;
  chargeType: string | null;
  chargeSubtype: string | null;
  quantity: number | null;
  uom: string | null;
  unitPrice: number | null;
  noCharge: boolean;
  amount: number | null;
  serviceStart: string | null;
  serviceEnd: string | null;
  taxable: boolean | null;
  wellId: string | null;
  leaseId: string | null;
  propertyText: string | null;
  /** Indicator-typed references: AFENumber, CostCenter, JobNumber, ... */
  references: { indicator: string; value: string | null }[];
}

export interface InvoiceDetail extends InvoiceSummary {
  paymentTerms: string | null;
  lines: InvoiceLineDetail[];
  taxes: {
    taxType: string;
    labelRaw: string | null;
    rate: number | null;
    amount: number | null;
  }[];
}

export interface InvoiceFilter {
  /** Substring match on the vendor company name, case-insensitive. */
  vendor?: string;
  wellId?: string;
  leaseId?: string;
  /** Inclusive ISO bounds on the invoice date. */
  from?: string;
  to?: string;
  status?: string;
  /** Substring match against line descriptions, case-insensitive. */
  describes?: string;
  /**
   * Invoices billed against one facility — what a facility page's Invoices tab
   * asks for. Matches the document-level tag set AND, for wells and leases, the
   * extractor's own line-level resolution, so an invoice filed before anyone
   * tagged it still appears on the page it belongs to.
   */
  facility?: { type: InvoiceFacilityType; id: string };
  limit?: number;
}

/** Row shapes as they come back from PostgREST, before mapping. */
interface DocRow {
  id: string;
  doc_type: string;
  doc_number: string | null;
  doc_number_derived: boolean | null;
  doc_date: string | null;
  due_date: string | null;
  payment_terms: string | null;
  subtotal: number | null;
  tax_printed: number | null;
  doc_total: number | null;
  status: string | null;
  tax_recon_status: string | null;
  source_file_id: string | null;
  vendor_id: string | null;
  vendor_text: string | null;
}

interface LineRow {
  id: string;
  document_id: string;
  line_no: string;
  description: string | null;
  charge_type: string | null;
  charge_subtype: string | null;
  quantity: number | null;
  uom: string | null;
  unit_price: number | null;
  no_charge: boolean | null;
  line_total: number | null;
  service_start: string | null;
  service_end: string | null;
  taxable: boolean | null;
  well_id: string | null;
  lease_id: string | null;
  raw_property_text: string | null;
}

const DOC_COLS =
  "id, doc_type, doc_number, doc_number_derived, doc_date, due_date, payment_terms," +
  " subtotal, tax_printed, doc_total, status, tax_recon_status, source_file_id," +
  " vendor_id, vendor_text";
const LINE_COLS =
  "id, document_id, line_no, description, charge_type, charge_subtype, quantity," +
  " uom, unit_price, no_charge, line_total, service_start, service_end, taxable," +
  " well_id, lease_id, raw_property_text";

/**
 * The vendor to show: the directory's name when the document resolved to one,
 * otherwise the name printed on the document itself.
 *
 * An unresolved vendor is a gap in the People directory, not an unreadable
 * document, and showing "Unidentified" over a letterhead the reader can see
 * says the wrong thing about which one it is. The resolved name still WINS, so
 * a corrected spelling in the directory is what the list reflects.
 */
function vendorLabel(
  doc: { vendor_id: string | null; vendor_text: string | null },
  names: Map<string, string>
): string | null {
  const resolved = doc.vendor_id ? names.get(doc.vendor_id) : null;
  return resolved ?? doc.vendor_text?.trim() ?? null;
}

/** Vendor id → company name, for the whole batch in one read. */
async function vendorNames(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  ids: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data } = await sb
    .from("service_providers")
    .select("id, company")
    .in("id", unique);
  return new Map((data ?? []).map((v) => [v.id as string, v.company as string]));
}

/**
 * Every document billed against one facility, from BOTH sources.
 *
 * The tag set (`invoice_facilities`) is the maintained answer. The line columns
 * are the extractor's, and for wells and leases they are also the only record on
 * every invoice filed before tagging existed — so a well page that read the tag
 * table alone would show an empty tab over a pile of correctly-resolved
 * invoices. Unioned, not preferred: an invoice can be tagged to a battery and
 * line-resolved to a well, and both pages should show it.
 */
async function facilityDocumentIds(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  facility: { type: InvoiceFacilityType; id: string }
): Promise<string[]> {
  const ids = new Set(await invoiceIdsForFacility(sb, facility.type, facility.id));

  if (facility.type === "well" || facility.type === "lease") {
    const column = facility.type === "well" ? "well_id" : "lease_id";
    const { data, error } = await sb
      .from("pidx_lines")
      .select("document_id")
      .eq(column, facility.id)
      .limit(2000);
    if (error && !isMissingTable(error)) {
      throw new Error(`facilityDocumentIds lines: ${error.message}`);
    }
    for (const row of data ?? []) ids.add(row.document_id as string);
  }

  return [...ids];
}

/**
 * List invoices matching a filter, newest first.
 *
 * `describes` filters on LINE text but returns DOCUMENTS, because "what did we
 * pay Graham for perforating" is a question about invoices, not about rows.
 */
export async function listInvoiceSummaries(
  filter: InvoiceFilter = {}
): Promise<InvoiceSummary[]> {
  const sb = await getRequestSupabase();
  const limit = Math.min(filter.limit ?? 50, 200);

  // A line-level filter has to narrow the document set first, otherwise the
  // document query cannot express it.
  let docIdFilter: string[] | null = null;
  if (filter.describes || filter.wellId || filter.leaseId) {
    let q = sb.from("pidx_lines").select("document_id");
    if (filter.describes) q = q.ilike("description", `%${filter.describes}%`);
    if (filter.wellId) q = q.eq("well_id", filter.wellId);
    if (filter.leaseId) q = q.eq("lease_id", filter.leaseId);
    const { data, error } = await q.limit(2000);
    if (error) {
      if (isMissingTable(error)) return [];
      throw new Error(`listInvoiceSummaries lines: ${error.message}`);
    }
    docIdFilter = [...new Set((data ?? []).map((r) => r.document_id as string))];
    if (docIdFilter.length === 0) return [];
  }

  if (filter.facility) {
    const forFacility = await facilityDocumentIds(sb, filter.facility);
    // Intersect rather than replace: a facility filter combined with anything
    // else has to mean both, not the last one applied.
    docIdFilter = docIdFilter
      ? docIdFilter.filter((id) => forFacility.includes(id))
      : forFacility;
    if (docIdFilter.length === 0) return [];
  }

  let docs: DocRow[];
  if (!docIdFilter && !filter.from && !filter.to && !filter.status) {
    // The unfiltered list (the /invoices page) is the request's one document
    // read, already newest first, cut to the page's limit; the ledger's
    // expense projection reads the same rows in the same render.
    docs = (await cachedInvoiceDocuments(sb)).slice(0, limit);
  } else {
    let q = sb
      .from("pidx_documents")
      .select(DOC_COLS)
      .is("deleted_at", null)
      .order("doc_date", { ascending: false })
      .limit(limit);
    if (docIdFilter) q = q.in("id", docIdFilter);
    if (filter.from) q = q.gte("doc_date", filter.from);
    if (filter.to) q = q.lte("doc_date", filter.to);
    if (filter.status) q = q.eq("status", filter.status);

    const { data, error } = await q.overrideTypes<DocRow[]>();
    if (error) {
      if (isMissingTable(error)) return [];
      throw new Error(`listInvoiceSummaries: ${error.message}`);
    }
    docs = data ?? [];
  }
  if (docs.length === 0) return [];

  const names = await cachedVendorNames(
    sb,
    docs.map((d) => d.vendor_id).filter((v): v is string => v != null)
  );

  // Line facts the summary needs: the count, the property text, and which
  // wells/leases the invoice touches. The facility sets ride along in the same
  // round, batched for the page rather than one read per row.
  const [{ data: lines }, facilitiesByDoc] = await Promise.all([
    sb
      .from("pidx_lines")
      .select(
        "document_id, well_id, lease_id, raw_property_text, service_start, service_end"
      )
      .in(
        "document_id",
        docs.map((d) => d.id)
      ),
    cachedInvoiceFacilities(sb, docs.map((d) => d.id)),
  ]);

  const byDoc = new Map<
    string,
    {
      count: number;
      wells: Set<string>;
      leases: Set<string>;
      text: string | null;
      start: string | null;
      end: string | null;
    }
  >();
  for (const l of lines ?? []) {
    const id = l.document_id as string;
    const agg =
      byDoc.get(id) ??
      {
        count: 0,
        wells: new Set<string>(),
        leases: new Set<string>(),
        text: null,
        start: null,
        end: null,
      };
    agg.count += 1;
    if (l.well_id) agg.wells.add(l.well_id as string);
    if (l.lease_id) agg.leases.add(l.lease_id as string);
    if (!agg.text && l.raw_property_text) agg.text = l.raw_property_text as string;
    // The period the WORK covers, widened across the lines. Distinct from the
    // invoice date, and usually the one an operator is actually looking for.
    const start = toIsoDate(l.service_start as string | null);
    const end = toIsoDate(l.service_end as string | null) ?? start;
    if (start && (!agg.start || start < agg.start)) agg.start = start;
    if (end && (!agg.end || end > agg.end)) agg.end = end;
    byDoc.set(id, agg);
  }

  const vendorFilter = filter.vendor?.toLowerCase().trim();

  return docs
    .map((d): InvoiceSummary => {
      const agg = byDoc.get(d.id);
      return {
        id: d.id,
        docType: d.doc_type === "field_ticket" ? "field_ticket" : "invoice",
        invoiceNo: d.doc_number,
        invoiceNoDerived: Boolean(d.doc_number_derived),
        invoiceDate: d.doc_date,
        dueDate: d.due_date,
        serviceStart: agg?.start ?? null,
        serviceEnd: agg?.end ?? null,
        vendor: vendorLabel(d, names),
        propertyText: agg?.text ?? null,
        facilities: facilitiesByDoc.get(d.id) ?? [],
        wellIds: [...(agg?.wells ?? [])],
        leaseIds: [...(agg?.leases ?? [])],
        subtotal: d.subtotal,
        taxPrinted: d.tax_printed,
        total: d.doc_total,
        lineCount: agg?.count ?? 0,
        status: d.status,
        taxLabelRaw: null,
        taxReconStatus: d.tax_recon_status,
        fileId: d.source_file_id,
      };
    })
    .filter((s) => !vendorFilter || (s.vendor ?? "").toLowerCase().includes(vendorFilter));
}

/**
 * Charge types present on each document's lines, for a list view that shows one
 * category per invoice.
 *
 * One read for the whole page rather than one per row: the invoices table is a
 * list, and an N+1 here is the difference between one round trip and two hundred.
 */
export async function chargeTypesByDocument(
  documentIds: string[]
): Promise<Map<string, string[]>> {
  if (documentIds.length === 0) return new Map();
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("pidx_lines")
    .select("document_id, charge_type")
    .in("document_id", documentIds);
  if (error) {
    if (isMissingTable(error)) return new Map();
    throw new Error(`chargeTypesByDocument: ${error.message}`);
  }
  const out = new Map<string, string[]>();
  for (const r of data ?? []) {
    const id = r.document_id as string;
    const list = out.get(id) ?? [];
    if (r.charge_type) list.push(r.charge_type as string);
    out.set(id, list);
  }
  return out;
}

/** One invoice with every line, its references, and its tax rows. */
export async function getInvoiceDetail(id: string): Promise<InvoiceDetail | null> {
  const sb = await getSupabaseServer();

  const { data: doc, error } = await sb
    .from("pidx_documents")
    .select(DOC_COLS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle<DocRow>();
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(`getInvoiceDetail: ${error.message}`);
  }
  if (!doc) return null;

  const [{ data: lines }, { data: refs }, { data: taxes }] = await Promise.all([
    sb
      .from("pidx_lines")
      .select(LINE_COLS)
      .eq("document_id", id)
      .order("line_no")
      .overrideTypes<LineRow[]>(),
    sb
      .from("pidx_refs")
      .select("line_id, indicator, reference_number")
      .eq("owner_document_id", id),
    sb
      .from("pidx_taxes")
      .select("tax_type, label_raw, rate, amount")
      .eq("owner_document_id", id),
  ]);

  const refsByLine = new Map<string, { indicator: string; value: string | null }[]>();
  for (const r of refs ?? []) {
    const lineId = r.line_id as string | null;
    if (!lineId) continue;
    const list = refsByLine.get(lineId) ?? [];
    list.push({
      indicator: r.indicator as string,
      value: (r.reference_number as string | null) ?? null,
    });
    refsByLine.set(lineId, list);
  }

  const [names, facilities] = await Promise.all([
    vendorNames(sb, doc.vendor_id ? [doc.vendor_id] : []),
    listInvoiceFacilities(sb, [id]),
  ]);
  const rows = lines ?? [];

  return {
    id: doc.id,
    docType: doc.doc_type === "field_ticket" ? "field_ticket" : "invoice",
    invoiceNo: doc.doc_number,
    invoiceNoDerived: Boolean(doc.doc_number_derived),
    invoiceDate: doc.doc_date,
    dueDate: doc.due_date,
    serviceStart:
      rows.map((l) => toIsoDate(l.service_start)).filter(Boolean).sort()[0] ??
      null,
    serviceEnd:
      rows
        .map((l) => toIsoDate(l.service_end ?? l.service_start))
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
    paymentTerms: doc.payment_terms,
    vendor: vendorLabel(doc, names),
    propertyText: rows.find((l) => l.raw_property_text)?.raw_property_text ?? null,
    facilities: facilities.get(id) ?? [],
    wellIds: [...new Set(rows.map((l) => l.well_id).filter((v): v is string => !!v))],
    leaseIds: [...new Set(rows.map((l) => l.lease_id).filter((v): v is string => !!v))],
    subtotal: doc.subtotal,
    taxPrinted: doc.tax_printed,
    total: doc.doc_total,
    lineCount: rows.length,
    status: doc.status,
    taxLabelRaw: (taxes ?? [])[0]?.label_raw ?? null,
    taxReconStatus: doc.tax_recon_status,
    fileId: doc.source_file_id,
    lines: rows.map((l) => ({
      id: l.id,
      lineNo: l.line_no,
      description: l.description,
      chargeType: l.charge_type,
      chargeSubtype: l.charge_subtype,
      quantity: l.quantity,
      uom: l.uom,
      unitPrice: l.unit_price,
      noCharge: Boolean(l.no_charge),
      amount: l.line_total,
      serviceStart: toIsoDate(l.service_start),
      serviceEnd: toIsoDate(l.service_end),
      taxable: l.taxable,
      wellId: l.well_id,
      leaseId: l.lease_id,
      propertyText: l.raw_property_text,
      references: refsByLine.get(l.id) ?? [],
    })),
    taxes: (taxes ?? []).map((t) => ({
      taxType: t.tax_type as string,
      labelRaw: (t.label_raw as string | null) ?? null,
      rate: (t.rate as number | null) ?? null,
      amount: (t.amount as number | null) ?? null,
    })),
  };
}

export type SpendDimension = "vendor" | "well" | "lease" | "chargeType" | "afe";

export interface SpendBucket {
  key: string;
  label: string;
  amount: number;
  lineCount: number;
  invoiceCount: number;
}

/**
 * Roll invoice spend up along one dimension over a date window.
 *
 * Money comes from the LINE, not the document total, because a single invoice
 * legitimately splits across wells, AFEs, and charge types — that is the whole
 * reason the references are per line. Summing document totals would attribute
 * the entire invoice to whichever well happened to be listed first.
 *
 * Lines with no amount are counted but contribute nothing, so a hand-priced
 * invoice does not silently read as free.
 */
export async function summarizeSpend(opts: {
  by: SpendDimension;
  from?: string;
  to?: string;
  wellId?: string;
  leaseId?: string;
}): Promise<{ buckets: SpendBucket[]; total: number; unpricedLines: number }> {
  const sb = await getSupabaseServer();

  let q = sb
    .from("pidx_lines")
    .select(
      "id, document_id, line_total, charge_type, well_id, lease_id, service_start"
    );
  if (opts.wellId) q = q.eq("well_id", opts.wellId);
  if (opts.leaseId) q = q.eq("lease_id", opts.leaseId);

  const { data: lines, error } = await q.limit(5000);
  if (error) {
    if (isMissingTable(error)) return { buckets: [], total: 0, unpricedLines: 0 };
    throw new Error(`summarizeSpend: ${error.message}`);
  }
  if (!lines || lines.length === 0) {
    return { buckets: [], total: 0, unpricedLines: 0 };
  }

  const docIds = [...new Set(lines.map((l) => l.document_id as string))];
  const { data: docs } = await sb
    .from("pidx_documents")
    .select("id, doc_date, vendor_id, vendor_text")
    .in("id", docIds)
    .is("deleted_at", null);

  // The window is the invoice date, falling back to the line's service date so a
  // ticket with no invoice date still lands in the right period.
  const dateByDoc = new Map(
    (docs ?? []).map((d) => [d.id as string, (d.doc_date as string | null) ?? null])
  );
  const vendorByDoc = new Map(
    (docs ?? []).map((d) => [d.id as string, (d.vendor_id as string | null) ?? null])
  );
  // The printed name, so an unresolved vendor buckets under the company that
  // billed rather than collapsing every one of them into "(unresolved vendor)"
  // — which is both useless as a total and disagrees with the row the invoices
  // list shows for the same document.
  const vendorTextByDoc = new Map(
    (docs ?? []).map((d) => [
      d.id as string,
      ((d.vendor_text as string | null) ?? "").trim(),
    ])
  );
  const names = await vendorNames(
    sb,
    [...vendorByDoc.values()].filter((v): v is string => v != null)
  );

  // AFE lives in the reference table, one row per line, indicator-typed.
  let afeByLine = new Map<string, string>();
  if (opts.by === "afe") {
    const { data: refs } = await sb
      .from("pidx_refs")
      .select("line_id, reference_number")
      .eq("indicator", "AFENumber")
      .in(
        "line_id",
        lines.map((l) => l.id as string)
      );
    afeByLine = new Map(
      (refs ?? [])
        .filter((r) => r.line_id && r.reference_number)
        .map((r) => [r.line_id as string, r.reference_number as string])
    );
  }

  const buckets = new Map<string, SpendBucket & { docs: Set<string> }>();
  let total = 0;
  let unpricedLines = 0;

  for (const l of lines) {
    const docId = l.document_id as string;
    const when = dateByDoc.get(docId) ?? (l.service_start as string | null);
    if (opts.from && (!when || when < opts.from)) continue;
    if (opts.to && (!when || when > opts.to)) continue;

    const amount = (l.line_total as number | null) ?? null;
    if (amount == null) unpricedLines += 1;

    let key: string;
    let label: string;
    switch (opts.by) {
      case "vendor": {
        const vid = vendorByDoc.get(docId);
        const printed = vendorTextByDoc.get(docId) ?? "";
        key = vid ?? (printed ? `text:${printed.toLowerCase()}` : "(unresolved)");
        label = vid
          ? (names.get(vid) ?? "(unknown vendor)")
          : printed || "(unresolved vendor)";
        break;
      }
      case "well":
        key = (l.well_id as string | null) ?? "(unresolved)";
        label = key;
        break;
      case "lease":
        key = (l.lease_id as string | null) ?? "(unresolved)";
        label = key;
        break;
      case "chargeType":
        key = (l.charge_type as string | null) ?? "(none)";
        label = key;
        break;
      case "afe":
        key = afeByLine.get(l.id as string) ?? "(no AFE)";
        label = key;
        break;
    }

    const b =
      buckets.get(key) ??
      { key, label, amount: 0, lineCount: 0, invoiceCount: 0, docs: new Set<string>() };
    b.amount += amount ?? 0;
    b.lineCount += 1;
    b.docs.add(docId);
    buckets.set(key, b);
    total += amount ?? 0;
  }

  return {
    buckets: [...buckets.values()]
      .map(({ docs, ...b }) => ({ ...b, invoiceCount: docs.size }))
      .sort((a, b) => b.amount - a.amount),
    total,
    unpricedLines,
  };
}

/**
 * Source-document names for a page of invoices, in one read.
 *
 * The viewer uses this as the download filename; without it every scan
 * downloads as "invoice" and a folder of them is unnavigable.
 */
export async function fileNamesById(
  fileIds: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return new Map();
  const sb = await getSupabaseServer();
  const { data, error } = await sb.from("files").select("id, name").in("id", unique);
  if (error) {
    if (isMissingTable(error)) return new Map();
    throw new Error(`fileNamesById: ${error.message}`);
  }
  return new Map((data ?? []).map((f) => [f.id as string, f.name as string]));
}

/**
 * The AFE numbers charged on each document's lines, in one read.
 *
 * A list view wants one cost object per row, but an invoice legitimately splits
 * across AFEs — which is exactly why the reference is per line. Returning the
 * SET lets the caller show the single AFE when there is one and say "multiple"
 * when there is not, rather than picking one and misattributing the rest.
 */
export async function afesByDocument(
  documentIds: string[]
): Promise<Map<string, string[]>> {
  if (documentIds.length === 0) return new Map();
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("pidx_refs")
    .select("owner_document_id, reference_number")
    .eq("indicator", "AFENumber")
    .in("owner_document_id", documentIds);
  if (error) {
    if (isMissingTable(error)) return new Map();
    throw new Error(`afesByDocument: ${error.message}`);
  }
  const out = new Map<string, Set<string>>();
  for (const r of data ?? []) {
    const id = r.owner_document_id as string;
    const value = (r.reference_number as string | null)?.trim();
    if (!value) continue;
    const set = out.get(id) ?? new Set<string>();
    set.add(value);
    out.set(id, set);
  }
  return new Map([...out].map(([id, set]) => [id, [...set]]));
}
