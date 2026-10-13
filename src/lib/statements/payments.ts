/**
 * Settlement statements projected into ledger rows (docs/plans/derived-payments.md).
 *
 * A payment is not stored twice. The statement and its line items ARE the record;
 * `/revenue` reads them through this module on every request, and the only rows
 * physically in `transactions` are the ones a human typed. That is why posting is
 * gone: there is nothing to copy, so there is nothing to drift.
 *
 * Pure and side-effect free. Every number here is checkable against a fixture
 * statement without a database, which is the point: the ledger's arithmetic is the
 * part that must not be taken on trust.
 */

import { resolveStatementLines } from "./production-resolve";
import type {
  FacilityTargets,
  RawStatement,
  RawStatementLine,
  ResolvedLine,
} from "./production-resolve";
import type { Category } from "@/lib/accounting/categories";
import type { Transaction } from "@/lib/accounting/types";

/** A settlement line with the money columns the ledger needs. */
export interface PaymentLine extends RawStatementLine {
  price: number | null;
  taxes: number;
  fees: number;
  netValue: number;
  /** The user's category choice. Null = derive it from `product`. */
  categoryCode: string | null;
  /** Display order within the statement, as extracted. */
  position: number;
  createdAt: string;
}

/** The parent statement, carrying the fields a payment shows. */
export interface PaymentStatement extends RawStatement {
  purchaser: string;
  statementNo: string;
}

/**
 * The org's revenue category for a product, from its chart of accounts. Matches by
 * code then label containing "oil"/"gas"; falls back to the standard REV-OIL /
 * REV-GAS codes so a payment always carries a proper category.
 *
 * Lifted verbatim from the retired posting path, so categories on old posted rows
 * and on projected ones are decided the same way.
 */
export function revenueCategory(
  categories: Category[],
  isGas: boolean
): { code: string; label: string } {
  const want = isGas ? "gas" : "oil";
  const revenue = categories.filter((c) => c.kind === "revenue");
  const match =
    revenue.find((c) => c.code.toLowerCase().includes(want)) ??
    revenue.find((c) => c.label.toLowerCase().includes(want));
  if (match) return { code: match.code, label: match.label };
  return isGas
    ? { code: "REV-GAS", label: "Gas Sales" }
    : { code: "REV-OIL", label: "Oil Sales" };
}

/** The ledger id of a projected line. Routes edits back to the line item. */
export function lineTransactionId(lineId: string): string {
  return `line:${lineId}`;
}

/** The line id inside a projected ledger id, or null for a stored row. */
export function lineIdFromTransactionId(id: string): string | null {
  return id.startsWith("line:") ? id.slice(5) : null;
}

/** The ledger id of a statement's aggregate row. */
export function statementTransactionId(statementId: string): string {
  return `stmt:${statementId}`;
}

/**
 * One resolved line as the ledger row it is.
 *
 * `wellId` stays empty: a settlement settles a tank or meter, and the split down to
 * wells is an allocation applied later on read (`statementRevenueByWell`), never a
 * number stored here.
 */
export function paymentTransaction(
  resolved: ResolvedLine<PaymentLine>,
  statement: PaymentStatement,
  categories: Category[],
  leaseNames: Map<string, string>
): Transaction {
  const { line, leaseId } = resolved;
  const isGas = line.product === "gas";
  const category = line.categoryCode
    ? {
        code: line.categoryCode,
        label:
          categories.find((c) => c.code === line.categoryCode)?.label ??
          line.categoryCode,
      }
    : revenueCategory(categories, isGas);
  return {
    id: lineTransactionId(line.id),
    kind: "revenue",
    counterparty: statement.purchaser,
    amount: line.netValue,
    date: statement.periodEnd,
    category: category.label,
    categoryCode: category.code,
    invoiceNumber: statement.statementNo,
    wellId: "",
    wellName: "",
    leaseId: leaseId ?? "",
    leaseName: leaseId ? leaseNames.get(leaseId) ?? "" : "",
    volume: line.volume,
    price: line.price,
    oilPrice: isGas ? null : line.price,
    gasPrice: isGas ? line.price : null,
    // Taxes and fees are both deducted before net value, so both belong in the
    // ledger's one severance column. Splitting them would make the column mean
    // something different for a projected row than for a hand-entered one.
    prodTax: line.taxes + line.fees,
    nri: null,
    createdAt: line.createdAt,
    documentId: statement.id,
    documentKind: "statement",
    lineId: line.id,
    editable: true,
  };
}

/**
 * Every live statement line in the org as a ledger row.
 *
 * De-duplication is OFF here on purpose. The production series sums overlapping
 * periods, so a re-upload there is silent double production and has to be collapsed;
 * a ledger that hides money because a heuristic guessed "re-upload" is worse than one
 * that shows it twice, because the user can see the second row and delete it.
 * Duplicate uploads are blocked at save instead.
 */
export function projectPayments(
  lines: PaymentLine[],
  statements: PaymentStatement[],
  targets: FacilityTargets,
  categories: Category[],
  leaseNames: Map<string, string>
): Transaction[] {
  const byId = new Map(statements.map((s) => [s.id, s]));
  const { lines: resolved } = resolveStatementLines(lines, statements, targets, {
    dedupe: false,
    keepUnresolved: true,
  });
  const out: Transaction[] = [];
  for (const r of resolved) {
    const statement = byId.get(r.line.statementId);
    if (!statement) continue;
    out.push(paymentTransaction(r, statement, categories, leaseNames));
  }
  return out;
}

/** A payment row: one statement with its lines, or one hand-entered transaction. */
export interface PaymentGroup {
  /** Stable row key: the statement id, or the transaction id for a manual row. */
  key: string;
  /** The row as displayed. For a statement this is an aggregate of `children`. */
  parent: Transaction;
  /** The statement's lines, in printed order. Empty for a manual row. */
  children: Transaction[];
}

/** Volume-weighted realized price over one product's lines, or null. */
function weightedPrice(rows: Transaction[], gas: boolean): number | null {
  let value = 0;
  let volume = 0;
  for (const r of rows) {
    const price = gas ? r.gasPrice : r.oilPrice;
    if (price == null || r.volume == null || r.volume <= 0) continue;
    value += price * r.volume;
    volume += r.volume;
  }
  return volume > 0 ? value / volume : null;
}

/**
 * "Baldwin" when the whole statement settled one lease and nothing was left
 * unattributed, "" when nothing resolved at all, else a count.
 *
 * A statement with one named lease AND an unmatched line reports the count, not
 * the name: the name would claim every payment on the row belongs to Baldwin, and
 * one of them is exactly the line the operator needs to go look at.
 */
function leaseLabel(rows: Transaction[]): { id: string; name: string } {
  const named = new Map<string, string>();
  let blanks = 0;
  for (const r of rows) {
    if (r.leaseId) named.set(r.leaseId, r.leaseName);
    else blanks++;
  }
  if (named.size === 0) return { id: "", name: "" };
  if (named.size === 1 && blanks === 0) {
    const [[id, name]] = [...named];
    return { id, name };
  }
  return {
    id: "",
    name: `${named.size} ${named.size === 1 ? "lease" : "leases"}`,
  };
}

/**
 * Collapse projected lines into one row per statement, leaving manual rows alone.
 *
 * A statement is one payment: one purchaser, one period, one check. Its lines are the
 * breakdown, and they stay lines rather than being folded per lease, because a lease
 * that settled both oil and gas has two volumes at two prices and one merged row would
 * have nothing editable in it.
 */
export function groupPayments(transactions: Transaction[]): PaymentGroup[] {
  const groups = new Map<string, Transaction[]>();
  const singles: Transaction[] = [];

  for (const t of transactions) {
    if (!t.documentId) {
      singles.push(t);
      continue;
    }
    const bucket = groups.get(t.documentId);
    if (bucket) bucket.push(t);
    else groups.set(t.documentId, [t]);
  }

  const out: PaymentGroup[] = singles.map((t) => ({
    key: t.id,
    parent: t,
    children: [],
  }));

  for (const [statementId, rows] of groups) {
    const first = rows[0];
    const categories = new Set(rows.map((r) => r.category));
    const lease = leaseLabel(rows);
    out.push({
      key: statementId,
      parent: {
        ...first,
        id: statementTransactionId(statementId),
        amount: rows.reduce((sum, r) => sum + r.amount, 0),
        category:
          categories.size === 1 ? first.category : "Oil & Gas Sales",
        categoryCode: categories.size === 1 ? first.categoryCode : "",
        leaseId: lease.id,
        leaseName: lease.name,
        // Barrels and MCF do not add up, and the aggregate row has no unit to
        // report one in. The volumes stay on the children, where they mean
        // something.
        volume: null,
        price: null,
        oilPrice: weightedPrice(rows, false),
        gasPrice: weightedPrice(rows, true),
        prodTax: rows.reduce((sum, r) => sum + (r.prodTax ?? 0), 0),
        // The statement's own fields are edited on the statement, where both ends
        // of the period are visible; a per-row edit here would move its siblings.
        editable: false,
        lineId: null,
        createdAt: rows.reduce(
          (earliest, r) => (r.createdAt < earliest ? r.createdAt : earliest),
          first.createdAt
        ),
      },
      // Printed order, which is the order the projection read them in.
      children: rows,
    });
  }

  return out;
}
