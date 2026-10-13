/** Accounting-page shared types. Pure module, safe on client and server. */

/** Money in vs money out. */
export type TransactionKind = "revenue" | "expense";

/** The three financial series tracked over time, derived from the ledger. */
export type FinancialMetric = "netRevenue" | "expenses" | "grossProfit";

/** Display metadata for a financial metric (chart label + line color). */
export interface FinancialMetricMeta {
  key: FinancialMetric;
  label: string;
  color: string;
}

export const FINANCIAL_METRICS: Record<FinancialMetric, FinancialMetricMeta> = {
  netRevenue: { key: "netRevenue", label: "Net Revenue", color: "#059669" },
  expenses: { key: "expenses", label: "Expenses", color: "#800000" },
  grossProfit: { key: "grossProfit", label: "Cash Flow", color: "#4169e1" },
};

/** Stable display / dropdown order for the metrics. */
export const FINANCIAL_METRIC_ORDER: FinancialMetric[] = [
  "netRevenue",
  "expenses",
  "grossProfit",
];

/**
 * One row of the accounting ledger. Revenue-only fields (volume, price,
 * prodTax, nri) are null for expense rows.
 */
export interface Transaction {
  id: string;
  kind: TransactionKind;
  /** Payer (revenue) or recipient (expense). */
  counterparty: string;
  /** Net dollar amount (USD), always positive. */
  amount: number;
  /** Transaction date, ISO `YYYY-MM-DD`. */
  date: string;
  category: string;
  categoryCode: string;
  invoiceNumber: string;
  wellId: string;
  wellName: string;
  /**
   * The lease this row is reported under. For revenue it is the settled lease;
   * for expenses it is derived from the well's lease. Empty when unassigned.
   */
  leaseId: string;
  leaseName: string;
  volume: number | null;
  /** Generic realized unit price (retained for existing consumers). */
  price: number | null;
  /** Realized unit price for the product settled; the other is null. */
  oilPrice: number | null;
  gasPrice: number | null;
  prodTax: number | null;
  nri: number | null;
  /** When the row was added to the ledger (ISO timestamp). */
  createdAt: string;
  /**
   * The source document this row is projected from — a settlement statement on
   * the revenue side, a vendor invoice on the expense side — null for a
   * hand-entered row. Rows group on it: one document is one payment, or one bill
   * (docs/plans/derived-payments.md).
   */
  documentId?: string | null;
  /** Which kind of document, so a delete knows what it is deleting. */
  documentKind?: "statement" | "invoice";
  /** The document line this row IS, null for a hand-entered or aggregate row. */
  lineId?: string | null;
  /**
   * Whether the row's own cells can be edited in place. False on a statement's
   * aggregate row, whose fields belong to the statement or to its children.
   * Absent means editable, which is what every stored row is.
   */
  editable?: boolean;
}

/**
 * A transaction before it is persisted — the editable shape used by the manual
 * entry form and the OCR draft editor. Held in memory until saved.
 */
export interface DraftTransaction {
  kind: TransactionKind;
  counterparty: string;
  amount: number;
  date: string;
  category: string;
  categoryCode: string;
  invoiceNumber: string;
  /** Expense attribution (a well). Revenue uses `leaseId` instead. */
  wellId: string;
  /** Revenue attribution (a lease). Empty for expenses. */
  leaseId?: string;
  volume: number | null;
  price: number | null;
  prodTax: number | null;
  nri: number | null;
}

/** One month of derived financials (ISO `YYYY-MM-DD`, first of month; USD). */
export interface FinancialPoint {
  month: string;
  netRevenue: number;
  expenses: number;
  grossProfit: number;
}

/** Per-well totals over the available period, for the overview table. */
export interface WellFinancialSummary {
  wellId: string;
  wellName: string;
  netRevenue: number;
  expenses: number;
  grossProfit: number;
}

/** Per-lease totals over the available period. Revenue is reported at this grain. */
export interface LeaseFinancialSummary {
  leaseId: string;
  leaseName: string;
  netRevenue: number;
  expenses: number;
  grossProfit: number;
}

/** Everything the accounting overview page renders. */
export interface AccountingOverview {
  /** Monthly totals summed across all wells, oldest month first. */
  series: FinancialPoint[];
  /** Per-well totals, sorted alphabetically by well name (each well's share). */
  wells: WellFinancialSummary[];
  /** Per-lease totals, sorted alphabetically by lease name (revenue grain). */
  leases: LeaseFinancialSummary[];
}

/** Company-wide financials for one month, behind a summary report. */
export interface MonthlySummary {
  /** First of the month, ISO `YYYY-MM-DD`. */
  month: string;
  /** Per-well totals for the month, sorted alphabetically. */
  perWell: WellFinancialSummary[];
  revenueTotal: number;
  expenseTotal: number;
  /** Revenue − expenses. */
  cashFlow: number;
}

/** A royalty / working interest owner's share for the monthly distribution. */
export interface OwnerDistribution {
  id: string;
  name: string;
  interestType: string;
  decimalInterest: number;
  amount: number;
}

/**
 * The data behind the read-only monthly report modal for one well + month.
 * Revenue and expense rows are the raw transactions; the rest is derived.
 */
export interface MonthlyReport {
  wellId: string;
  wellName: string;
  /** First of the reported month, ISO `YYYY-MM-DD`. */
  month: string;
  revenue: Transaction[];
  expenses: Transaction[];
  revenueTotal: number;
  expenseTotal: number;
  /** Gross revenue (Σ volume × price), used to size owner distributions. */
  grossRevenue: number;
  /** Revenue − expenses. */
  cashFlow: number;
  distributions: OwnerDistribution[];
}
