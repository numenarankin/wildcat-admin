/**
 * Vendor invoices projected into ledger rows, the expense mirror of
 * `@/lib/statements/payments` (docs/plans/derived-payments.md).
 *
 * The same rule applies on this side: a bill is not stored twice. The invoice and
 * its charge lines ARE the record, and `/invoices` reads them through this module
 * on every request. Nothing is ever copied into `transactions`.
 *
 * WHERE IT DELIBERATELY DIFFERS FROM PAYMENTS. Revenue settles a lease and prices
 * a commodity; an expense does neither. It is billed against whatever facility the
 * work happened at — a well, a lease, a tank, a meter, a battery — so the Lease
 * column becomes Facility, and the two price columns are dropped rather than left
 * empty. What is left is what a bill actually is: when, who, how much, what for.
 *
 * Pure and side-effect free.
 */

import type { Category } from "@/lib/accounting/categories";
import type { Transaction } from "@/lib/accounting/types";
import type { InvoiceFacility } from "./facility-types";

/** A charge line with the columns the ledger needs. */
export interface ExpenseLine {
  id: string;
  documentId: string;
  lineNo: string;
  /** What the vendor called the work. The "what for", when nothing better exists. */
  description: string | null;
  /** PIDX SubTotalIndicator: Labor | Materials | Equipment | Other. */
  chargeType: string | null;
  chargeSubtype: string | null;
  /** The user's category choice. Null = derive it from the charge type. */
  categoryCode: string | null;
  amount: number;
  createdAt: string;
}

/** The parent invoice, carrying the fields an expense row shows. */
export interface ExpenseDocument {
  id: string;
  vendor: string;
  invoiceNo: string;
  /** Invoice date, ISO `YYYY-MM-DD`. The ledger date. */
  date: string;
  createdAt: string;
}

/**
 * The org's expense category for a charge type, from its chart of accounts.
 *
 * PIDX gives four buckets and the operator's chart gives a dozen, so this matches
 * by intent rather than by name: labor to the pumping/labor line, materials to
 * chemicals if that is all there is, equipment to rental. Anything unmatched lands
 * on lease operating expense, which is where a bill with no better home belongs —
 * never on nothing, because a category is what makes the row add up in a report.
 */
export function expenseCategory(
  categories: Category[],
  chargeType: string | null
): { code: string; label: string } {
  const expense = categories.filter((c) => c.kind === "expense");
  const wants: Record<string, string[]> = {
    Labor: ["labor", "pumping"],
    Materials: ["material", "chemical", "supplies"],
    Equipment: ["equipment", "rental"],
  };
  for (const want of wants[chargeType ?? ""] ?? []) {
    const hit =
      expense.find((c) => c.code.toLowerCase().includes(want)) ??
      expense.find((c) => c.label.toLowerCase().includes(want));
    if (hit) return { code: hit.code, label: hit.label };
  }
  const loe =
    expense.find((c) => c.code.toUpperCase() === "EXP-LOE") ??
    expense.find((c) => c.label.toLowerCase().includes("operating"));
  return loe
    ? { code: loe.code, label: loe.label }
    : { code: "EXP-LOE", label: "Lease Operating Expense" };
}

/** The ledger id of a projected charge line. Routes edits back to the line. */
export function expenseLineTransactionId(lineId: string): string {
  return `iline:${lineId}`;
}

/** The line id inside a projected expense id, or null for anything else. */
export function expenseLineIdFromTransactionId(id: string): string | null {
  return id.startsWith("iline:") ? id.slice(6) : null;
}

/** The ledger id of an invoice's aggregate row. */
export function expenseDocumentTransactionId(documentId: string): string {
  return `inv:${documentId}`;
}

/**
 * How a facility set reads in one cell.
 *
 * One facility is its own name — "Roach 7", "Roach", "Roach T123" — because the
 * name already says what kind of thing it is and a "Well ·" prefix in front of
 * every row would not earn its width. Several is a count, for the same reason a
 * multi-lease statement is: naming one of them would claim the whole bill was
 * against it.
 */
export function facilityLabel(facilities: InvoiceFacility[]): string {
  const named = facilities.filter((f) => f.label.trim());
  if (named.length === 0) return "";
  if (named.length === 1) return named[0].label;
  return `${named.length} facilities`;
}

/** One charge line as the ledger row it is. */
export function expenseTransaction(
  line: ExpenseLine,
  document: ExpenseDocument,
  categories: Category[],
  facilities: InvoiceFacility[]
): Transaction {
  const category = line.categoryCode
    ? {
        code: line.categoryCode,
        label:
          categories.find((c) => c.code === line.categoryCode)?.label ??
          line.categoryCode,
      }
    : expenseCategory(categories, line.chargeType);
  // A line inherits the invoice's facility only when the invoice names exactly
  // one. On a bill split across three, saying which line went where is a claim
  // this data cannot support, so the cell stays empty rather than guessing.
  const only = facilities.length === 1 ? facilities[0] : null;
  return {
    id: expenseLineTransactionId(line.id),
    kind: "expense",
    counterparty: document.vendor,
    // Expenses are positive magnitudes; the ledger's own sign convention.
    amount: Math.abs(line.amount),
    date: document.date,
    category: category.label,
    categoryCode: category.code,
    invoiceNumber: document.invoiceNo,
    wellId: only?.type === "well" ? only.id : "",
    wellName: only?.type === "well" ? only.label : "",
    leaseId: only?.type === "lease" ? only.id : "",
    // The Facility column reads this, whatever kind of facility it is.
    leaseName: only?.label ?? "",
    volume: null,
    price: null,
    oilPrice: null,
    gasPrice: null,
    prodTax: null,
    nri: null,
    createdAt: line.createdAt,
    documentId: document.id,
    documentKind: "invoice",
    lineId: line.id,
    editable: true,
  };
}

/** Every live charge line in the org as a ledger row. */
export function projectExpenses(
  lines: ExpenseLine[],
  documents: ExpenseDocument[],
  categories: Category[],
  facilitiesByDocument: Map<string, InvoiceFacility[]>
): Transaction[] {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const out: Transaction[] = [];
  for (const line of lines) {
    const document = byId.get(line.documentId);
    if (!document) continue;
    out.push(
      expenseTransaction(
        line,
        document,
        categories,
        facilitiesByDocument.get(document.id) ?? []
      )
    );
  }
  return out;
}
