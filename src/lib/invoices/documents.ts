import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memo } from "@/lib/cache/request-cache";
import { listInvoiceFacilities } from "./facilities";
import type { InvoiceFacility } from "./facility-types";

type Sb = SupabaseClient;

/**
 * One `pidx_documents` read per request, shared by the two projections that
 * used to each read it: the invoices list (`listInvoiceSummaries`) and the
 * ledger's expense rows (`orgInvoiceLines`). Every column either needs, live
 * (not soft-deleted), newest document date first, the order the list shows.
 * On the real org this table was the slowest read on /invoices, and the page
 * paid it twice.
 */
export interface InvoiceDocumentRow {
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
  created_at: string;
}

export const INVOICE_DOC_COLS =
  "id, doc_type, doc_number, doc_number_derived, doc_date, due_date, payment_terms," +
  " subtotal, tax_printed, doc_total, status, tax_recon_status, source_file_id," +
  " vendor_id, vendor_text, created_at";

/** Postgres error code for a table that does not exist (migration not pushed). */
const isMissingTable = (e: { code?: string }) => e.code === "42P01";

export function cachedInvoiceDocuments(sb: Sb, orgId?: string): Promise<InvoiceDocumentRow[]> {
  return memo(sb, `pidx-documents:${orgId ?? "rls"}`, async () => {
    let q = sb
      .from("pidx_documents")
      .select(INVOICE_DOC_COLS)
      .is("deleted_at", null)
      .order("doc_date", { ascending: false });
    if (orgId) q = q.eq("org_id", orgId);
    const { data, error } = await q;
    if (error) {
      if (isMissingTable(error)) return [];
      throw new Error(`cachedInvoiceDocuments: ${error.message}`);
    }
    return (data ?? []) as unknown as InvoiceDocumentRow[];
  });
}

/** Vendor company names by id, once per distinct id set per request. */
export function cachedVendorNames(sb: Sb, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return Promise.resolve(new Map());
  return memo(sb, `vendor-names:${unique.join(",")}`, async () => {
    const { data } = await sb.from("service_providers").select("id, company").in("id", unique);
    return new Map(
      ((data ?? []) as { id: string; company: string | null }[]).map((v) => [v.id, v.company ?? ""])
    );
  });
}

/** `listInvoiceFacilities`, once per distinct document set per request. */
export function cachedInvoiceFacilities(
  sb: Sb,
  documentIds: string[]
): Promise<Map<string, InvoiceFacility[]>> {
  const unique = [...new Set(documentIds)].sort();
  if (unique.length === 0) return Promise.resolve(new Map());
  return memo(sb, `invoice-facilities:${unique.join(",")}`, () => listInvoiceFacilities(sb, unique));
}
