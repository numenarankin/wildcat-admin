import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { memoScope, memoScopePeek } from "@/lib/cache/request-cache";
import {
  aggregateMonthly,
  summarizeByLease,
  summarizeByWell,
  type InterestOwner,
} from "@/lib/accounting/derive";
import {
  listAllInterests,
  listLeaseInterests,
  type InterestHolding,
} from "@/lib/interest/interest";
import { isHouseHolding } from "@/lib/interest/gross-net";
import { loadRevenueWeighting } from "@/lib/statements/revenue";
import { revenueSharesFor, type RevenueTarget } from "@/lib/statements/lease-revenue-shares";
import { orgStatementLines } from "@/lib/statements/production-loaders";
import { paymentTransaction, projectPayments } from "@/lib/statements/payments";
import { resolveStatementLines } from "@/lib/statements/production-resolve";
import { getAccountingCategories } from "@/lib/accounting/org-categories";
import { orgInvoiceLines } from "@/lib/invoices/expense-loader";
import { projectExpenses } from "@/lib/invoices/expenses";
import type {
  AccountingOverview,
  Transaction,
  TransactionKind,
} from "@/lib/accounting/types";

export interface TransactionRow {
  id: string;
  kind: TransactionKind;
  counterparty: string | null;
  amount: number | null;
  txn_date: string;
  category: string | null;
  category_code: string | null;
  invoice_number: string | null;
  well_id: string | null;
  lease_id: string | null;
  volume: number | null;
  price: number | null;
  oil_price: number | null;
  gas_price: number | null;
  prod_tax: number | null;
  nri: number | null;
  created_at: string;
  /** Joined well name + the well's lease (for deriving an expense's lease). */
  wells: { name: string | null; lease_id: string | null; leases: { name: string | null } | null } | null;
  /** Joined name of the row's own lease (revenue). */
  leases: { name: string | null } | null;
}

export const TRANSACTION_SELECT =
  "id, kind, counterparty, amount, txn_date, category, category_code, " +
  "invoice_number, well_id, lease_id, volume, price, oil_price, gas_price, " +
  "prod_tax, nri, created_at, wells(name, lease_id, leases(name)), leases(name)";

const SELECT = TRANSACTION_SELECT;

export function mapTransaction(r: TransactionRow): Transaction {
  // Effective lease: the row's own lease (revenue) else the well's lease (expense).
  const leaseId = r.lease_id ?? r.wells?.lease_id ?? "";
  const leaseName = r.leases?.name ?? r.wells?.leases?.name ?? "";
  return {
    id: r.id,
    kind: r.kind,
    counterparty: r.counterparty ?? "",
    amount: r.amount ?? 0,
    date: r.txn_date,
    category: r.category ?? "",
    categoryCode: r.category_code ?? "",
    invoiceNumber: r.invoice_number ?? "",
    wellId: r.well_id ?? "",
    wellName: r.wells?.name ?? r.well_id ?? "",
    leaseId,
    leaseName: leaseName || leaseId,
    volume: r.volume,
    price: r.price,
    oilPrice: r.oil_price,
    gasPrice: r.gas_price,
    prodTax: r.prod_tax,
    nri: r.nri,
    createdAt: r.created_at,
  };
}

/**
 * Optional read scope. RLS callers omit it (scoped by policy). Background jobs
 * with no session (the digest cron) pass a service-role `client` + `orgId` so the
 * read filters to one org explicitly rather than relying on `current_org_id()`.
 */
export interface LedgerScope {
  client: SupabaseClient;
  orgId: string;
}

/**
 * Returns transactions from the ledger, oldest first (raw, unexpanded).
 *
 * Memoized per request scope: several surfaces read the ledger in one render
 * (the summary cards, posted prices, the analytics pass), and it is a whole-table
 * read. `since` bounds it for callers that only look at recent months, and is
 * part of the cache key so a windowed caller never receives a narrower cached
 * result than it asked for.
 */
export function getTransactions(
  scope?: LedgerScope,
  opts: {
    since?: string;
    /**
     * Revenue rows only. The realization fit reads the ledger and then ignores
     * every non-revenue row (`accumulate` in posted-prices.ts skips
     * `kind !== "revenue"`), so loading the vendor-invoice projection for it
     * was pure waste: on the real org that was `pidx_documents` 1.6s,
     * `pidx_lines`, `invoice_facilities` and `service_providers`, on every
     * render of a page that never shows an expense. Its own memo key, so a
     * caller that wants the whole ledger never receives the narrow one.
     */
    revenueOnly?: boolean;
  } = {}
): Promise<Transaction[]> {
  const org = scope?.orgId ?? "rls";
  const since = opts.since;
  if (opts.revenueOnly) {
    // A revenue-only slice of a full ledger already in hand (whole, or the
    // same window) is free; only read again when nothing wider is in flight.
    const wider =
      memoScopePeek<Transaction[]>(`transactions:${org}:all`) ??
      (since ? memoScopePeek<Transaction[]>(`transactions:${org}:${since}`) : undefined) ??
      // /prices reads the whole revenue ledger and then the realization fit
      // asks for its window of the same rows: a slice, not a second read.
      (since ? memoScopePeek<Transaction[]>(`transactions:${org}:all:revenue`) : undefined);
    if (wider) {
      return wider.then((rows) =>
        rows.filter((t) => t.kind === "revenue" && (!since || t.date >= since))
      );
    }
    return memoScope(`transactions:${org}:${since ?? "all"}:revenue`, () =>
      loadTransactions(scope, opts)
    );
  }
  // A windowed ledger is a SLICE of the unwindowed one, so when the request has
  // already asked for the whole thing there is nothing to fetch. The dashboard
  // does exactly that: `getCompanyAnalytics` reads the full ledger while
  // `getPostedPrices` asks for the realization window, and the two used to be
  // separate memo keys and therefore two scans of `transactions`.
  //
  // Keyed on the same scope, so a cron looping orgs can never narrow one org's
  // rows into another's answer. `date` is the ISO `txn_date` the query filters
  // on with `.gte`, so the comparison here is the same one Postgres applied.
  if (since) {
    const all = memoScopePeek<Transaction[]>(`transactions:${org}:all`);
    if (all) return all.then((rows) => rows.filter((t) => t.date >= since));
  }
  return memoScope(`transactions:${org}:${since ?? "all"}`, () =>
    loadTransactions(scope, opts)
  );
}

async function loadTransactions(
  scope?: LedgerScope,
  opts: { since?: string; revenueOnly?: boolean } = {}
): Promise<Transaction[]> {
  if (!scope && !hasSupabase()) return [];
  const sb = scope?.client ?? (await getRequestSupabase());
  const [storedAll, payments, expenses] = await Promise.all([
    loadStoredTransactions(sb, scope, opts),
    loadProjectedPayments(sb, scope, opts),
    opts.revenueOnly ? Promise.resolve([] as Transaction[]) : loadProjectedExpenses(sb, scope, opts),
  ]);
  const stored = opts.revenueOnly ? storedAll.filter((t) => t.kind === "revenue") : storedAll;
  const projected = [...payments, ...expenses];
  // One ledger, oldest first, however a row got here. Ties break on when the row
  // was created, which is the order the panel already displays.
  return [...stored, ...projected].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)
  );
}

/**
 * The rows that are physically in `transactions`: everything a human entered.
 *
 * `source <> 'statement'` is a fence, not a filter. Posting is retired and the
 * migration deleted the rows it left behind, so a statement-sourced row can only
 * be one that arrived after this code did. Counting it would double the payment
 * that now projects itself.
 */
async function loadStoredTransactions(
  sb: SupabaseClient,
  scope?: LedgerScope,
  opts: { since?: string } = {}
): Promise<Transaction[]> {
  let query = sb
    .from("transactions")
    .select(SELECT)
    .neq("source", "statement")
    .order("txn_date", { ascending: true });
  if (scope) query = query.eq("org_id", scope.orgId);
  if (opts.since) query = query.gte("txn_date", opts.since);
  const { data, error } = await query;
  if (error) throw new Error(`getTransactions: ${error.message}`);
  return ((data ?? []) as unknown as TransactionRow[]).map(mapTransaction);
}

/**
 * Settlement statements as ledger rows, computed on read
 * (docs/plans/derived-payments.md).
 *
 * Deleted lines never reach here: `orgStatementLines` drops them at the query, so
 * a payment deleted in `/revenue` is gone from every consumer of this function and
 * from the production series too.
 */
async function loadProjectedPayments(
  sb: SupabaseClient,
  scope?: LedgerScope,
  opts: { since?: string } = {}
): Promise<Transaction[]> {
  const [{ lines, statements, targets }, categories] = await Promise.all([
    orgStatementLines(sb, scope?.orgId),
    getAccountingCategories(scope),
  ]);
  if (lines.length === 0) return [];
  const leaseNames = new Map(
    targets.leases.map((l) => [l.id, l.name ?? ""] as const)
  );
  const rows = projectPayments(
    lines,
    statements,
    targets,
    categories,
    leaseNames
  );
  return opts.since ? rows.filter((t) => t.date >= opts.since!) : rows;
}

/**
 * Vendor invoices as ledger rows, the expense mirror of the above.
 *
 * Same contract: nothing is copied into `transactions`, deleted charge lines are
 * dropped at the query, and the ledger is one list however a row got into it.
 */
async function loadProjectedExpenses(
  sb: SupabaseClient,
  scope?: LedgerScope,
  opts: { since?: string } = {}
): Promise<Transaction[]> {
  const [{ lines, documents, facilities }, categories] = await Promise.all([
    orgInvoiceLines(sb, scope?.orgId),
    getAccountingCategories(scope),
  ]);
  if (lines.length === 0) return [];
  const rows = projectExpenses(lines, documents, categories, facilities);
  return opts.since ? rows.filter((t) => t.date >= opts.since!) : rows;
}

/**
 * Statement revenue settles a tank or meter, never a well. For well-level reads it
 * has to be exploded across the wells behind that point by their allocation over
 * the statement period, applied on READ so a later downtime or well-test change
 * re-splits money that was never split in storage.
 *
 * Projected from the statement lines themselves, so a deleted line disappears from
 * per-well revenue the same moment it disappears from the ledger. Returns virtual
 * per-well transactions (amount, volume and taxes scaled by share); optionally
 * filtered to one well.
 */
export async function statementRevenueByWell(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  wellNames: Map<string, string>,
  onlyWellId?: string,
  /** Background jobs (the digest cron) pass an org so the service-role reads
   *  filter explicitly instead of relying on `current_org_id()`. */
  orgId?: string
): Promise<Transaction[]> {
  const [{ lines, statements, targets }, categories] = await Promise.all([
    orgStatementLines(sb, orgId),
    getAccountingCategories(orgId ? { client: sb, orgId } : undefined),
  ]);
  if (lines.length === 0) return [];

  const leaseNames = new Map(
    targets.leases.map((l) => [l.id, l.name ?? ""] as const)
  );
  const byStatement = new Map(statements.map((st) => [st.id, st]));
  const { lines: resolved } = resolveStatementLines(
    lines,
    statements,
    targets,
    { dedupe: false }
  );

  const weighting = await loadRevenueWeighting(sb);
  const out: Transaction[] = [];
  for (const r of resolved) {
    // A line keyed to a tank or meter splits at that point. One keyed only to
    // a lease - the usual shape, since the purchaser settles the lease - splits
    // across the lease's wells through the same allocation. A line that names
    // neither is real money the ledger shows, but there is nothing to split by.
    const target: RevenueTarget | null =
      r.point ??
      (r.leaseId ? { type: "lease", id: r.leaseId, product: r.line.product } : null);
    if (!target) continue;
    const statement = byStatement.get(r.line.statementId);
    if (!statement) continue;
    const base = paymentTransaction(r, statement, categories, leaseNames);
    const period = { from: statement.periodStart, to: statement.periodEnd };
    const shares = await revenueSharesFor(sb, target, period, weighting);
    for (const [wellId, share] of shares) {
      if (onlyWellId && wellId !== onlyWellId) continue;
      if (share <= 0) continue;
      out.push({
        ...base,
        id: `${base.id}:${wellId}`,
        wellId,
        wellName: wellNames.get(wellId) ?? wellId,
        amount: base.amount * share,
        volume: base.volume == null ? null : base.volume * share,
        // Prices are per-unit, so they pass through unscaled by the share.
        prodTax: base.prodTax == null ? null : base.prodTax * share,
        // A share of a payment is not the payment, and nothing may edit or delete
        // one: the row it came from is the one that exists.
        lineId: null,
        editable: false,
      });
    }
  }
  return out;
}

/** well id → name for the whole org (for labeling virtual per-well rows). */
export async function wellNameMap(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  orgId?: string
): Promise<Map<string, string>> {
  let q = sb.from("wells").select("id, name");
  if (orgId) q = q.eq("org_id", orgId);
  const { data } = await q;
  const map = new Map<string, string>();
  for (const r of (data ?? []) as { id: string; name: string | null }[]) {
    map.set(r.id, r.name ?? r.id);
  }
  return map;
}

/**
 * Returns the accounting overview: monthly totals across all wells (aggregate
 * chart) and per-well totals (sortable table). Statement revenue posted at
 * tank/meter grain is exploded to wells so per-well totals attribute correctly;
 * the raw tank/meter rows are excluded to avoid double-counting.
 */
export async function getAccountingOverview(): Promise<AccountingOverview> {
  if (!hasSupabase()) return { series: [], wells: [], leases: [] };
  const sb = await getSupabaseServer();
  const raw = await getTransactions();
  const wellNames = await wellNameMap(sb);
  const virtual = await statementRevenueByWell(sb, wellNames);
  // Monthly totals use the raw ledger (full amounts, so revenue that can't be
  // attributed to a well still counts). Per-well totals use the exploded rows
  // (direct well transactions + virtual per-well statement revenue); the
  // un-exploded tank/meter rows carry no wellId and are skipped there anyway.
  const direct = raw.filter((t) => t.wellId);
  // Per-lease totals: statement revenue is already lease-anchored on the raw
  // rows, so summarize the raw ledger directly (expenses fold in via each
  // expense's derived lease). No explosion needed for the lease grain.
  return {
    series: aggregateMonthly(raw),
    wells: summarizeByWell([...direct, ...virtual]),
    leases: summarizeByLease(raw),
  };
}

/**
 * Returns one well's full transaction history (oldest first) and its name, or
 * `null` when the well does not exist. The per-well page derives the monthly
 * chart, table, and reports from these rows.
 */
export async function getWellLedger(
  wellId: string
): Promise<{ wellName: string; transactions: Transaction[] } | null> {
  if (!hasSupabase()) return null;
  const sb = await getRequestSupabase();

  const { data: well, error: wellError } = await sb
    .from("wells")
    .select("name")
    .eq("id", wellId)
    .maybeSingle();
  if (wellError) throw new Error(`getWellLedger: ${wellError.message}`);
  if (!well) return null;

  const { data, error } = await sb
    .from("transactions")
    .select(SELECT)
    .eq("well_id", wellId)
    .order("txn_date", { ascending: true });
  if (error) throw new Error(`getWellLedger: ${error.message}`);

  const direct = ((data ?? []) as unknown as TransactionRow[]).map(
    mapTransaction
  );
  // Fold in statement revenue posted at tank/meter grain, exploded to this well.
  const wellNames = new Map([[wellId, well.name ?? wellId]]);
  const virtual = await statementRevenueByWell(sb, wellNames, wellId);
  const transactions = [...direct, ...virtual].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  return { wellName: well.name ?? wellId, transactions };
}

// --- Interest owners for accounting distributions --------------------------
//
// Interest is entered per LEASE (the lease's Interest tab); every well on the
// lease inherits it. Accounting stays per-well, so each well's owner
// distributions are its lease's royalty holders, carrying that owner's per-lease
// net-revenue-interest as `decimalInterest`. The operator's own holding is
// excluded — it keeps the remainder, it isn't a payout row.

/** Map a non-operator lease holding to the accounting `InterestOwner` shape. */
function toInterestOwner(h: InterestHolding): InterestOwner {
  return {
    id: h.ownerId ?? h.id,
    name: h.ownerName,
    interestType: h.interestType,
    decimalInterest: h.netRevenueInterest,
  };
}

/**
 * Every well's royalty-owner distributions, keyed by well id — resolved from
 * each well's lease interest holdings. Wells with no lease (or a lease with no
 * royalty holders) are absent from the map. Used by the accounting overview and
 * the reports hub.
 */
export async function getOwnerDistributionsByWell(): Promise<
  Record<string, InterestOwner[]>
> {
  if (!hasSupabase()) return {};
  const sb = await getSupabaseServer();
  const [holdings, wellsRes] = await Promise.all([
    listAllInterests(sb),
    sb.from("wells").select("id, lease_id"),
  ]);
  if (wellsRes.error) {
    throw new Error(`getOwnerDistributionsByWell: ${wellsRes.error.message}`);
  }

  const byLease = new Map<string, InterestOwner[]>();
  for (const h of holdings) {
    // Every holding of the ORG's own, not just the operating entity's: a
    // company the user owns holding an override on their own lease is not
    // someone the monthly distribution mails a cheque to.
    if (isHouseHolding(h)) continue;
    const list = byLease.get(h.leaseId) ?? [];
    list.push(toInterestOwner(h));
    byLease.set(h.leaseId, list);
  }

  const out: Record<string, InterestOwner[]> = {};
  const wells = (wellsRes.data ?? []) as { id: string; lease_id: string | null }[];
  for (const w of wells) {
    const owners = w.lease_id ? byLease.get(w.lease_id) : undefined;
    if (owners) out[w.id] = owners;
  }
  return out;
}

/** One well's royalty-owner distributions, from its lease's interest holdings. */
export async function getWellInterestOwners(
  wellId: string
): Promise<InterestOwner[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data: well, error } = await sb
    .from("wells")
    .select("lease_id")
    .eq("id", wellId)
    .maybeSingle();
  if (error) throw new Error(`getWellInterestOwners: ${error.message}`);
  const leaseId = (well as { lease_id: string | null } | null)?.lease_id;
  if (!leaseId) return [];
  const holdings = await listLeaseInterests(sb, leaseId);
  return holdings.filter((h) => !isHouseHolding(h)).map(toInterestOwner);
}
