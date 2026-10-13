import "server-only";
import type { Commodity, PricePoint } from "@/lib/pricing/types";
import { getTransactions } from "@/lib/accounting/ledger";
import type { Transaction } from "@/lib/accounting/types";

/**
 * Posted prices the org actually received for its oil and gas, derived from the
 * revenue ledger — now statement-driven (GBC, since 2026071100200).
 *
 * Each revenue transaction carries the realized unit price of the product it
 * settled (`oil_price` / `gas_price`) and is dated by the settlement period it
 * came from: a May settlement statement posts in May and holds May's prices. So
 * — unlike the old accounting-statement model, where a June statement reported
 * May production and the price had to be shifted back a month — the
 * transaction's OWN month is the price month. No offset.
 *
 * Method: for each commodity, group that month's revenue rows and take the
 * production-weighted average price = Σ revenue ÷ Σ volume. Volume is the row's
 * recorded volume, or — when absent — derived from revenue ÷ unit price, so a
 * row only needs two of {revenue, price, volume}. The monthly price is assumed
 * flat across the month, emitted as one point per calendar day (the shape the
 * pricing page + Orion summary consume). Oil is $/bbl, gas is $/MCF.
 */

/**
 * Which commodity a revenue row is for. Prefers the typed `oilPrice`/`gasPrice`
 * columns (set at reconcile time); for legacy rows without them, falls back to
 * the category code + label (e.g. "REV-OIL", "Oil Sales"). Returns null when
 * neither or both appear (a combined "Oil & Gas" label is ambiguous, so we skip
 * it rather than double-count). Also used by analytics for row classification.
 */
export function commodityOf(t: Transaction): Commodity | null {
  const text = `${t.categoryCode ?? ""} ${t.category ?? ""}`.toLowerCase();
  const isOil = text.includes("oil");
  const isGas = text.includes("gas");
  if (isOil === isGas) return null;
  return isOil ? "oil" : "gas";
}

/**
 * The production month ("YYYY-MM") one month before a receipt month. Retained
 * for the analytics module, which still attributes some series by receipt − 1;
 * the posted-price series no longer uses it (statement rows are self-dated).
 */
export function priorMonth(receiptMonth: string): string {
  const [year, month] = receiptMonth.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, 1)); // 1st of the receipt month
  d.setUTCMonth(d.getUTCMonth() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** A flat daily price series spanning every calendar day of "YYYY-MM". */
function flatMonth(month: string, price: number): PricePoint[] {
  const [year, m] = month.split("-").map(Number);
  // Day 0 of the next month is the last day of this month.
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const points: PricePoint[] = [];
  for (let day = 1; day <= days; day++) {
    points.push({
      date: `${month}-${String(day).padStart(2, "0")}`,
      price,
    });
  }
  return points;
}

/**
 * Classify a revenue row to a commodity + its realized unit price. Prefers the
 * typed price columns; falls back to the generic `price` + category for legacy
 * rows that predate them. Null when the row isn't a classifiable commodity sale.
 */
function priceOf(
  t: Transaction
): { commodity: Commodity; price: number | null } | null {
  if (t.oilPrice != null) return { commodity: "oil", price: t.oilPrice };
  if (t.gasPrice != null) return { commodity: "gas", price: t.gasPrice };
  const c = commodityOf(t);
  return c ? { commodity: c, price: t.price } : null;
}

/** Running revenue + volume for one commodity-month. */
interface MonthAcc {
  revenue: number;
  volume: number;
}

/**
 * One settled month: the volume-weighted price and the volume behind it.
 *
 * The volume is not decoration. The realization fit weights each month by how
 * much product actually sold in it, so a 40-mcf month cannot carry the same
 * authority as a 4,000-mcf one, and the flat daily series below throws it away.
 */
export interface RealizedMonth {
  /** Settlement month, "YYYY-MM". */
  month: string;
  /** Volume-weighted realized price, USD per unit. */
  price: number;
  /** Units settled that month (bbl or MCF). */
  volume: number;
}

/**
 * Volume-weighted realized price per settled month, oldest first. The shared
 * root of both the flat daily series the pricing chart draws and the
 * observations the realization model is fitted on, so the two cannot drift.
 */
export function realizedMonthsFor(
  transactions: Transaction[],
  commodity: Commodity,
  weightOf: RowWeight = GROSS,
  dollarsOf: Dollars = AFTER_TAX
): RealizedMonth[] {
  return collapse(accumulate(transactions, commodity, () => "", weightOf, dollarsOf), "");
}

/**
 * How much of a revenue row counts: a multiplier on its dollars and its volume.
 *
 * `GROSS` (1 for every row) gives the price the FIELD got per unit. The company
 * realization fit uses {@link netWeight} instead, so that a lease the operator
 * keeps 80% of moves the company factor four times as much as one they keep
 * 20% of — the factor is applied to the operator's net revenue, so it should
 * be fitted on the operator's net revenue. A row's own price is unchanged by
 * the weight; only its say in the month's average and the month's say in the
 * fit are scaled.
 */
export type RowWeight = (t: Transaction) => number;

const GROSS: RowWeight = () => 1;

/**
 * Which dollars a revenue row's price is taken from.
 *
 * `AFTER_TAX` is the row's amount: the statement line's net value, what the
 * operator was actually paid per unit. It is what the realization fit and every
 * net-revenue estimate use. `PRE_TAX` adds severance taxes and fees back
 * (`prodTax`, the ledger's one deduction column), leaving the price before the
 * state's cut; /prices shows this so the gap to the benchmark reads as the
 * purchaser's differential and not the tax bill.
 */
export type Dollars = (t: Transaction) => number;

export const AFTER_TAX: Dollars = (t) => t.amount;
export const PRE_TAX: Dollars = (t) => t.amount + (t.prodTax ?? 0);

/**
 * Net weighting: the lease's recorded interest, else the interest printed on
 * the row itself (a statement line carries the decimal it was paid at), else
 * the whole of it — the same fallback the dashboard nets revenue by.
 */
export function netWeight(
  nriByLease: Record<string, number>,
  assumed: number
): RowWeight {
  return (t) => {
    const recorded = t.leaseId ? nriByLease[t.leaseId] : undefined;
    if (recorded != null && recorded > 0) return recorded;
    if (t.nri != null && t.nri > 0) return t.nri;
    return assumed;
  };
}

/**
 * The same, split by the lease the revenue was attributed to.
 *
 * The prices an operator receives differ enormously between leases - rich
 * casinghead gas carrying condensate against dry gas can be a 2.5x spread in one
 * month - so a single company-wide realization is wrong nearly everywhere it is
 * applied. Grouping costs one map key because revenue rows already carry
 * `leaseId` (`accounting/types.ts`, set from the statement resolution ladder).
 *
 * Rows with no lease are absent here. They still belong in the COMPANY fit,
 * which reads every row: unattributed revenue is real money at a real price, it
 * simply cannot inform any single lease, and dropping it would bias the
 * company-wide fallback toward whichever leases happen to resolve cleanly.
 */
export function realizedMonthsByLease(
  transactions: Transaction[],
  commodity: Commodity,
  dollarsOf: Dollars = AFTER_TAX
): Map<string, RealizedMonth[]> {
  const acc = accumulate(transactions, commodity, (t) => t.leaseId ?? "", GROSS, dollarsOf);
  const out = new Map<string, RealizedMonth[]>();
  for (const leaseId of new Set([...acc.keys()].map((k) => k.slice(0, k.indexOf("|"))))) {
    if (!leaseId) continue; // unattributed: company fit only
    out.set(leaseId, collapse(acc, leaseId));
  }
  return out;
}

/** One lease's settled months, named for a table. */
export interface LeaseRealizedMonths {
  leaseId: string;
  name: string;
  months: RealizedMonth[];
}

/**
 * {@link realizedMonthsByLease} with each lease's name off its own rows, for
 * the /prices table's month-by-lease breakdown. Rows with no lease are absent,
 * as there. Named from the ledger rather than the leases table because the
 * ledger already carries the name the revenue was settled under.
 */
export function realizedMonthsByLeaseNamed(
  transactions: Transaction[],
  commodity: Commodity,
  dollarsOf: Dollars = AFTER_TAX
): LeaseRealizedMonths[] {
  const names = new Map<string, string>();
  for (const t of transactions) {
    if (t.leaseId && !names.has(t.leaseId)) names.set(t.leaseId, t.leaseName || t.leaseId);
  }
  return [...realizedMonthsByLease(transactions, commodity, dollarsOf).entries()]
    .map(([leaseId, months]) => ({ leaseId, name: names.get(leaseId) ?? leaseId, months }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Running revenue + volume, keyed `${groupKey}|${month}`. */
function accumulate(
  transactions: Transaction[],
  commodity: Commodity,
  keyOf: (t: Transaction) => string,
  weightOf: RowWeight = GROSS,
  dollarsOf: Dollars = AFTER_TAX
): Map<string, MonthAcc> {
  const byKey = new Map<string, MonthAcc>();

  for (const t of transactions) {
    if (t.kind !== "revenue") continue;
    const cls = priceOf(t);
    if (!cls || cls.commodity !== commodity) continue;

    const revenue = dollarsOf(t);
    // Volume: the recorded figure, else derived from revenue ÷ unit price.
    let volume = t.volume != null && t.volume > 0 ? t.volume : null;
    if (volume == null && cls.price != null && cls.price > 0) {
      volume = revenue / cls.price;
    }
    // No volume and no price to derive it from: nothing to weight by.
    if (volume == null || volume <= 0) continue;

    // The transaction's own month is the price month.
    const key = `${keyOf(t)}|${t.date.slice(0, 7)}`;
    const at = byKey.get(key) ?? { revenue: 0, volume: 0 };
    // Dollars and volume scaled alike, so the row's price survives and only
    // its weight changes (`RowWeight`).
    const w = weightOf(t);
    at.revenue += revenue * w;
    at.volume += volume * w;
    byKey.set(key, at);
  }

  return byKey;
}

/** One group's months, oldest first. */
function collapse(
  acc: Map<string, MonthAcc>,
  groupKey: string
): RealizedMonth[] {
  const prefix = `${groupKey}|`;
  return [...acc.entries()]
    .filter(([key, { volume }]) => key.startsWith(prefix) && volume > 0)
    .map(([key, { revenue, volume }]) => ({
      month: key.slice(prefix.length),
      price: revenue / volume,
      volume,
    }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/**
 * Settled months as the flat daily series the pricing chart draws: every
 * calendar day of a month at that month's volume-weighted price. Pure, and the
 * shape a device rebuilds from the months its sync snapshot carries.
 */
export function postedSeriesFromMonths(months: RealizedMonth[]): PricePoint[] {
  const points: PricePoint[] = [];
  for (const m of months) {
    points.push(...flatMonth(m.month, m.price));
  }
  points.sort((a, b) => (a.date < b.date ? -1 : 1));
  return points;
}

/** Volume-weighted realized price per month, as a flat daily series. */
function seriesFor(
  transactions: Transaction[],
  commodity: Commodity,
  dollarsOf: Dollars
): PricePoint[] {
  return postedSeriesFromMonths(
    realizedMonthsFor(transactions, commodity, GROSS, dollarsOf)
  );
}

/**
 * Realized posted-price series from an already-loaded transaction list. Pure
 * (no DB) so a caller that already holds the org's transactions — e.g. the
 * org-scoped digest cron — reuses the exact same series derivation as
 * {@link getPostedPrices} without a second round-trip.
 */
export function postedPricesFrom(
  transactions: Transaction[],
  dollarsOf: Dollars = AFTER_TAX
): Record<Commodity, PricePoint[]> {
  return {
    oil: seriesFor(transactions, "oil", dollarsOf),
    gas: seriesFor(transactions, "gas", dollarsOf),
  };
}

/** {@link realizedMonthsFor} for both commodities, from a loaded ledger. */
export function realizedMonthsFrom(
  transactions: Transaction[],
  weightOf: RowWeight = GROSS
): Record<Commodity, RealizedMonth[]> {
  return {
    oil: realizedMonthsFor(transactions, "oil", weightOf),
    gas: realizedMonthsFor(transactions, "gas", weightOf),
  };
}

/**
 * {@link realizedMonthsFrom} straight from the ledger. Shares the ledger's
 * request-scoped memo with {@link getPostedPrices}, so a surface that reads
 * both pays for one scan.
 */
export async function getRealizedMonths(
  opts: { since?: string } = {},
  weightOf: RowWeight = GROSS
): Promise<Record<Commodity, RealizedMonth[]>> {
  // Revenue only: `accumulate` skips every other kind, so the vendor-invoice
  // projection in a full ledger read is loaded and dropped. Same key as the
  // realization fit's read, so the two are one scan.
  return realizedMonthsFrom(
    await getTransactions(undefined, { ...opts, revenueOnly: true }),
    weightOf
  );
}

/**
 * Realized (posted) prices from the revenue ledger.
 *
 * `since` bounds the ledger read. The realization fit only looks back a year,
 * so the pages that price a volume pass a window and skip a whole-table scan;
 * /prices omits it and gets the full history for its chart.
 */
export async function getPostedPrices(
  opts: { since?: string } = {}
): Promise<Record<Commodity, PricePoint[]>> {
  const transactions = await getTransactions(undefined, opts);
  return postedPricesFrom(transactions);
}
