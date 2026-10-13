/**
 * Vendor invoices — money going out, the payables mirror of a settlement
 * statement.
 *
 * The row shape the /invoices TABLE renders, projected from the PIDX storage
 * tables via `./query`. Deliberately flatter than what is stored: the table has
 * one line per invoice, while `pidx_documents` has N charge lines each with
 * their own charge type, property and references. The flattening rules are
 * stated at `toInvoiceRow`, and the detail is a `get_invoice` / drill-in away
 * rather than crammed into a column.
 *
 * Live in every environment. There is no sample branch: a fabricated invoice and
 * a broken read look identical on screen, and the first person to hit one files
 * the wrong bug.
 */
import { getDownloadUrl } from "@/lib/files/actions";
import {
  afesByDocument,
  fileNamesById,
  listInvoiceSummaries,
  type InvoiceFilter,
  type InvoiceSummary,
} from "@/lib/invoices/query";
import type {
  InvoiceFacility,
  InvoiceFacilityType,
} from "@/lib/invoices/facility-types";

export interface Invoice {
  id: string;
  /** Invoice or field ticket. Both live in one table and read differently. */
  docType: "invoice" | "field_ticket";
  /** Who sent it. */
  vendor: string;
  /** The vendor's own invoice number, as printed. */
  invoiceNo: string;
  /** Invoice date, ISO `YYYY-MM-DD`. */
  date: string;
  /** Payment due date, ISO `YYYY-MM-DD`. Empty when the invoice states none. */
  dueDate: string;
  /** The period the WORK covers, widened across the lines. */
  serviceStart: string;
  serviceEnd: string;
  /**
   * What the charge is against, as ONE cell: the facilities the invoice is
   * billed against, or, for an invoice nobody has tagged yet, the property the
   * vendor printed. `facilities` says which of the two it is.
   */
  chargedTo: string;
  /** The maintained facility set. Empty means `chargedTo` is the printed text. */
  facilities: InvoiceFacility[];
  /**
   * The cost object. One AFE when the whole invoice is coded to one, "Multiple"
   * when its lines split across several, empty when none is coded.
   */
  afe: string;
  /** How many charge lines the invoice carries. */
  lineCount: number;
  /** Invoice total in US dollars. */
  amount: number;
  /**
   * Signed URL of the source document, when one is attached. Null renders the
   * viewer's "no document" branch rather than an empty frame.
   */
  fileUrl: string | null;
  /** Original file name, shown as the viewer's title. */
  fileName: string | null;
}

/**
 * The table's single cost-object cell.
 *
 * An invoice legitimately codes its lines to different AFEs — that is why the
 * reference is per line — so naming one of several would misattribute the rest.
 * One AFE prints; several say so; none reads blank.
 */
function afeCell(afes: string[]): string {
  if (afes.length === 0) return "";
  if (afes.length === 1) return afes[0];
  return "Multiple";
}

/**
 * Project one stored document onto the flat row the table renders.
 *
 * `chargedTo` is what the invoice is BILLED AGAINST — the facility set the
 * modal's picker edits — because that is the one place a person can correct
 * it. The printed property text stands in only until someone tags the invoice;
 * it is the vendor's spelling of a facility we could not resolve, and it stays
 * on the lines (`raw_property_text`) as the record of what was printed.
 */
function toInvoiceRow(
  s: InvoiceSummary,
  fileUrl: string | null,
  afe: string,
  fileName: string | null
): Invoice {
  return {
    id: s.id,
    docType: s.docType,
    vendor: s.vendor ?? "",
    // A ticket with no printed number shows a dash rather than a minted key the
    // user has never seen on paper.
    invoiceNo: s.invoiceNoDerived || !s.invoiceNo ? "—" : s.invoiceNo,
    date: s.invoiceDate ?? "",
    dueDate: s.dueDate ?? "",
    serviceStart: s.serviceStart ?? "",
    serviceEnd: s.serviceEnd ?? "",
    chargedTo:
      s.facilities.length > 0
        ? s.facilities.map((f) => f.label || f.id).join(", ")
        : (s.propertyText ?? ""),
    facilities: s.facilities,
    afe,
    lineCount: s.lineCount,
    amount: s.total ?? 0,
    fileUrl,
    fileName,
  };
}

/**
 * The invoices, newest first.
 *
 * Signed URLs are minted here, one per invoice that has a source document, so
 * the viewer can open the scan without a second round trip. They are short-lived
 * by design (see `getDownloadUrl`), which is why they are not cached.
 */
export async function listInvoices(
  filter: InvoiceFilter = {}
): Promise<Invoice[]> {
  const summaries = await listInvoiceSummaries({ limit: 200, ...filter });
  if (summaries.length === 0) return [];

  // Charge types come from the lines, so they need one extra read. Batched
  // rather than per-invoice: this is a list page, and N+1 here is felt.
  const [afes, fileNames] = await Promise.all([
    afesByDocument(summaries.map((s) => s.id)),
    fileNamesById(
      summaries.map((s) => s.fileId).filter((id): id is string => id != null)
    ),
  ]);

  const rows = await Promise.all(
    summaries.map(async (s) => {
      // A missing or expired document must not take the whole page down; the
      // row still renders and the viewer shows its "no document" branch.
      let fileUrl: string | null = null;
      if (s.fileId) {
        try {
          fileUrl = await getDownloadUrl(s.fileId);
        } catch (err) {
          console.error("listInvoices: signed url failed", { id: s.id, err });
        }
      }
      return toInvoiceRow(
        s,
        fileUrl,
        afeCell(afes.get(s.id) ?? []),
        s.fileId ? (fileNames.get(s.fileId) ?? null) : null
      );
    })
  );

  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * The invoices billed against one facility, in the same row shape the /invoices
 * table renders.
 *
 * Same projection on purpose: a tank's Invoices tab and the invoices list are
 * showing the same document, and two projections would eventually disagree
 * about what an invoice is worth or which AFE it carries.
 */
export async function listFacilityInvoices(
  type: InvoiceFacilityType,
  id: string
): Promise<Invoice[]> {
  return listInvoices({ facility: { type, id } });
}
