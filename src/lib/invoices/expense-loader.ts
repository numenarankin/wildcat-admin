import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memo } from "@/lib/cache/request-cache";
import { cachedInvoiceDocuments, cachedInvoiceFacilities, cachedVendorNames } from "./documents";
import type { ExpenseDocument, ExpenseLine } from "./expenses";
import type { InvoiceFacility } from "./facility-types";

type Sb = SupabaseClient;

const LINE_COLS =
  "id, document_id, line_no, description, charge_type, charge_subtype, " +
  "category_code, line_total, ft_number, created_at";
// `doc_number` / `doc_date` are the stored names; the vendor is a resolved id
// with the printed text as its fallback, exactly as `listInvoiceSummaries` reads it.
const DOC_COLS =
  "id, doc_type, doc_number, doc_date, created_at, vendor_id, vendor_text";

interface LineRow {
  id: string;
  document_id: string;
  line_no: string | null;
  description: string | null;
  charge_type: string | null;
  charge_subtype: string | null;
  category_code: string | null;
  line_total: number | string | null;
  ft_number: string | null;
  created_at: string;
}

interface DocRow {
  id: string;
  doc_type: string | null;
  doc_number: string | null;
  doc_date: string | null;
  created_at: string;
  vendor_id: string | null;
  vendor_text: string | null;
}


function num(v: number | string | null): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n !== null ? (n as number) : 0;
}

/**
 * The org's live charge lines and the invoices they sit on, read once per request.
 *
 * DELETED LINES NEVER LEAVE THIS FUNCTION, the same contract
 * `orgStatementLines` holds: a bill struck off the ledger is struck off
 * everywhere that reads these rows, not at each caller's discretion.
 *
 * A FIELD TICKET COUNTS UNLESS AN INVOICE BILLS IT. A ticket and the invoice that
 * bills it describe the same work, so counting both doubles the job — but a ticket
 * nobody has invoiced yet is the only record that the money was spent, and dropping
 * every ticket meant an operator whose vendor sends tickets saw no expenses at all.
 * The invoice names the ticket it bills (`pidx_lines.ft_number`), so the ones to
 * drop can be identified rather than guessed at by type.
 *
 * `orgId` is for service-role callers with no RLS org context (the digest cron),
 * and is in the memo key because one admin client loops organizations.
 */
export async function orgInvoiceLines(
  sb: Sb,
  orgId?: string
): Promise<{
  lines: ExpenseLine[];
  documents: ExpenseDocument[];
  facilities: Map<string, InvoiceFacility[]>;
}> {
  return memo(sb, `invoice-lines:${orgId ?? "rls"}`, async () => {
    // A deleted invoice takes its charges with it. `deleteInvoice` is a SOFT
    // delete on the document, so without this the bill stays in the ledger after
    // the invoice is gone from the list above it.
    const docRows: DocRow[] = await cachedInvoiceDocuments(sb, orgId);
    if (docRows.length === 0) {
      return { lines: [], documents: [], facilities: new Map() };
    }

    const vendors = await cachedVendorNames(
      sb,
      docRows.map((r) => r.vendor_id).filter((v): v is string => v != null)
    );
    const allDocuments: ExpenseDocument[] = docRows.map((r) => ({
      id: r.id,
      vendor:
        (r.vendor_id ? vendors.get(r.vendor_id) : null) ??
        r.vendor_text?.trim() ??
        "",
      invoiceNo: r.doc_number ?? "",
      // An invoice with no printed date still has to land somewhere on a
      // timeline, and the day it reached us is the only other date it has.
      date: (r.doc_date ?? r.created_at).slice(0, 10),
      createdAt: r.created_at,
    }));
    const allIds = allDocuments.map((d) => d.id);

    const [lineRes, facilities] = await Promise.all([
      sb
        .from("pidx_lines")
        .select(LINE_COLS)
        .in("document_id", allIds)
        .is("deleted_at", null)
        // A SubLineItem is a breakdown of the line above it, already counted in
        // its parent's total.
        .is("parent_line_id", null)
        .order("line_no", { ascending: true }),
      cachedInvoiceFacilities(sb, allIds),
    ]);
    if (lineRes.error) {
      throw new Error(`orgInvoiceLines (lines): ${lineRes.error.message}`);
    }

    const lineRows = (lineRes.data ?? []) as unknown as LineRow[];

    // Every field ticket an INVOICE bills for, by the number the invoice printed.
    // Those tickets are the same money as the invoice that references them.
    const byId = new Map(docRows.map((r) => [r.id, r]));
    const billedTickets = new Set(
      lineRows
        .filter((l) => byId.get(l.document_id)?.doc_type === "invoice")
        .map((l) => (l.ft_number ?? "").trim())
        .filter(Boolean)
    );
    const droppedIds = new Set(
      docRows
        .filter(
          (r) =>
            r.doc_type === "field_ticket" &&
            billedTickets.has((r.doc_number ?? "").trim())
        )
        .map((r) => r.id)
    );
    const documents = allDocuments.filter((d) => !droppedIds.has(d.id));

    const lines: ExpenseLine[] = lineRows.filter(
      (r) => !droppedIds.has(r.document_id)
    ).map(
      (r) => ({
        id: r.id,
        documentId: r.document_id,
        lineNo: r.line_no ?? "",
        description: r.description,
        chargeType: r.charge_type,
        chargeSubtype: r.charge_subtype,
        categoryCode: r.category_code,
        amount: num(r.line_total),
        createdAt: r.created_at,
      })
    );

    return { lines, documents, facilities };
  });
}
