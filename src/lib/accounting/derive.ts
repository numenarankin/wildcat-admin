/**
 * Pure derivation helpers — every figure on the accounting page is computed from
 * the flat transaction ledger here. No server or DB imports, so these run on the
 * client too (the per-well page derives monthly rows and reports in the browser).
 */
import type {
  DraftTransaction,
  FinancialPoint,
  LeaseFinancialSummary,
  MonthlyReport,
  OwnerDistribution,
  Transaction,
  WellFinancialSummary,
} from "@/lib/accounting/types";

/** A blank expense draft dated `date` (ISO `YYYY-MM-DD`). */
export function emptyDraft(date: string): DraftTransaction {
  return {
    kind: "expense",
    counterparty: "",
    amount: 0,
    date,
    category: "",
    categoryCode: "",
    invoiceNumber: "",
    wellId: "",
    leaseId: "",
    volume: null,
    price: null,
    prodTax: null,
    nri: null,
  };
}

/** The owner fields needed to compute a distribution. */
export interface InterestOwner {
  id: string;
  name: string;
  interestType: string;
  decimalInterest: number;
}

/** Normalizes any ISO date to the first day of its month (`YYYY-MM-01`). */
export function monthKey(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Gross dollar value of a revenue row: volume × price, falling back to amount. */
function grossOf(t: Transaction): number {
  if (t.volume != null && t.price != null) return t.volume * t.price;
  return t.amount;
}

/** Aggregates transactions into monthly net revenue / expenses / gross profit. */
export function aggregateMonthly(txns: Transaction[]): FinancialPoint[] {
  const byMonth = new Map<string, FinancialPoint>();
  for (const t of txns) {
    const key = monthKey(t.date);
    const point = byMonth.get(key) ?? {
      month: key,
      netRevenue: 0,
      expenses: 0,
      grossProfit: 0,
    };
    if (t.kind === "revenue") point.netRevenue += t.amount;
    else point.expenses += t.amount;
    byMonth.set(key, point);
  }
  return [...byMonth.values()]
    .map((p) => ({ ...p, grossProfit: p.netRevenue - p.expenses }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** Totals transactions per well, sorted alphabetically by well name. */
export function summarizeByWell(txns: Transaction[]): WellFinancialSummary[] {
  const byWell = new Map<string, WellFinancialSummary>();
  for (const t of txns) {
    if (!t.wellId) continue;
    const w = byWell.get(t.wellId) ?? {
      wellId: t.wellId,
      wellName: t.wellName || t.wellId,
      netRevenue: 0,
      expenses: 0,
      grossProfit: 0,
    };
    if (t.kind === "revenue") w.netRevenue += t.amount;
    else w.expenses += t.amount;
    byWell.set(t.wellId, w);
  }
  return [...byWell.values()]
    .map((w) => ({ ...w, grossProfit: w.netRevenue - w.expenses }))
    .sort((a, b) => a.wellName.localeCompare(b.wellName));
}

/**
 * Totals transactions per lease, sorted alphabetically by lease name. Revenue is
 * reported at this grain; expenses fold in via each expense's derived lease. Rows
 * with no lease (unassigned well/device) are skipped.
 */
export function summarizeByLease(txns: Transaction[]): LeaseFinancialSummary[] {
  const byLease = new Map<string, LeaseFinancialSummary>();
  for (const t of txns) {
    if (!t.leaseId) continue;
    const l = byLease.get(t.leaseId) ?? {
      leaseId: t.leaseId,
      leaseName: t.leaseName || t.leaseId,
      netRevenue: 0,
      expenses: 0,
      grossProfit: 0,
    };
    if (t.kind === "revenue") l.netRevenue += t.amount;
    else l.expenses += t.amount;
    byLease.set(t.leaseId, l);
  }
  return [...byLease.values()]
    .map((l) => ({ ...l, grossProfit: l.netRevenue - l.expenses }))
    .sort((a, b) => a.leaseName.localeCompare(b.leaseName));
}

/**
 * Builds the monthly report for one well + month from that well's transactions
 * and its interest owners. Distributions are each owner's decimal interest
 * applied to the month's gross revenue.
 */
export function buildMonthlyReport(
  wellId: string,
  wellName: string,
  month: string,
  wellTxns: Transaction[],
  owners: InterestOwner[]
): MonthlyReport {
  const key = monthKey(month);
  const inMonth = wellTxns.filter((t) => monthKey(t.date) === key);
  const revenue = inMonth.filter((t) => t.kind === "revenue");
  const expenses = inMonth.filter((t) => t.kind === "expense");

  const revenueTotal = revenue.reduce((sum, t) => sum + t.amount, 0);
  const expenseTotal = expenses.reduce((sum, t) => sum + t.amount, 0);
  const grossRevenue = revenue.reduce((sum, t) => sum + grossOf(t), 0);

  const distributions: OwnerDistribution[] = owners.map((o) => ({
    id: o.id,
    name: o.name,
    interestType: o.interestType,
    decimalInterest: o.decimalInterest,
    amount: o.decimalInterest * grossRevenue,
  }));

  return {
    wellId,
    wellName,
    month: key,
    revenue,
    expenses,
    revenueTotal,
    expenseTotal,
    grossRevenue,
    cashFlow: revenueTotal - expenseTotal,
    distributions,
  };
}
