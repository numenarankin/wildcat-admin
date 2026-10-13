import type { SupabaseClient } from "@supabase/supabase-js";
import { tankDisplayName } from "@/lib/tanks/tank-name";
import { meterDisplayName } from "@/lib/meters/meter-name";
// TYPE-ONLY on purpose: `files/hygiene` is `server-only`, and this module is
// pulled into the client bundle (`upload-statement-modal` imports
// `lineNetValue` at runtime). A value import here would break the build.
import type { StoredHygiene } from "@/lib/files/hygiene";
// Pure key builder, shared with the ingest pipeline's statement writer so both
// paths agree on what "the same statement" means. No I/O, safe in any bundle.
import { stmtKey } from "@/lib/ai/ingest/dedup-keys";
import { canonical } from "@/lib/ai/ingest/normalize";

/**
 * Purchaser-statement data-access + pure totals (GBC-13).
 *
 * A purchaser statement is the monthly settlement document a crude/gas buyer
 * sends the operator — the bridge entity that links field production to
 * revenue. It covers many leases in one document, carries per-lease/well line
 * items (oil/gas sold, price, value, deducts, taxes), and moves through a
 * lifecycle: received -> extracted -> reviewed -> posted (revenue posted to the
 * ledger). Posting is opt-in, per-line, and reversible, not an automatic step.
 *
 * Same idiom as `@/lib/tanks/*` and `@/lib/reports/*`: every DB helper takes the
 * caller's Supabase client first, and passing the request-scoped RLS client
 * (`getSupabaseServer()`) is what enforces org ownership — the `statements` /
 * `statement_line_items` policies scope reads/writes to `current_org_id()` on
 * the accounting capabilities. Never hand these the service-role admin client.
 *
 * The value math at the bottom is PURE (no DB / React / I/O) so it is
 * unit-testable on its own.
 */

type Sb = SupabaseClient;

/**
 * Lifecycle: uploaded -> the model read it -> the human saved the review. It ends
 * at `reviewed`, because saving the review is what puts the statement's payments
 * in the ledger; there is no posting step after it
 * (docs/plans/derived-payments.md).
 */
export type StatementStatus = "received" | "extracted" | "reviewed";

/** A statement's commodity coverage (line items carry their own product). */
export type StatementProduct = "oil" | "gas" | "mixed";

/** A single line's commodity — statements settle oil and gas separately. */
export type LineProduct = "oil" | "gas";

const STATEMENT_STATUSES: readonly StatementStatus[] = [
  "received",
  "extracted",
  "reviewed",
];

export function asStatus(v: string | null | undefined): StatementStatus {
  return STATEMENT_STATUSES.includes(v as StatementStatus)
    ? (v as StatementStatus)
    : "received";
}

function asStatementProduct(v: string | null | undefined): StatementProduct {
  return v === "gas" || v === "mixed" ? v : "oil";
}

export function asLineProduct(v: string | null | undefined): LineProduct {
  return v === "gas" ? "gas" : "oil";
}

/** The purchaser entity (GBC-13 owns the full record; GBC-5 seeded it). */
export interface Purchaser {
  id: string;
  name: string;
  /** What this purchaser buys (GBC-5's `oil`|`water` domain), or null. */
  product: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
}

/** One extracted/reviewed line of a statement. */
export interface StatementLineItem {
  id: string;
  statementId: string;
  /** Matched lease id, or null if unmapped. Interest/NRI is held per lease. */
  leaseId: string | null;
  /** Matched tank id (oil lines), or null. The measurement/allocation point. */
  tankId: string | null;
  /** Matched meter id (gas lines), or null. The measurement/allocation point. */
  meterId: string | null;
  /** Lease name/number exactly as printed on the statement. */
  leaseRef: string;
  /** Tank number as printed (oil). */
  tankRef: string;
  /** Meter number as printed (gas). */
  meterRef: string;
  /** Matched-entity display names (joined), "" when unmatched. */
  leaseName: string;
  tankName: string;
  meterName: string;
  product: LineProduct;
  /** Volume sold: bbls for oil, MCF for gas. */
  volume: number;
  price: number | null;
  grossValue: number;
  deducts: number;
  taxes: number;
  netValue: number;
  // Gas-only settlement fields (null on oil lines).
  mmbtu: number | null;
  allocatedQty: number | null;
  producerPct: number | null;
  settleQty: number | null;
  fees: number;
  /** Long-tail fields not promoted to typed columns. */
  raw: Record<string, unknown>;
  /** Revenue transaction this line reconciles to (deep-link), or null. */
  position: number;
}

/** A statement header row (index), totals denormalized. */
export interface Statement {
  id: string;
  purchaserId: string | null;
  /** Purchaser name (joined), or "" if none. */
  purchaser: string;
  periodStart: string;
  periodEnd: string;
  product: StatementProduct;
  status: StatementStatus;
  statementNo: string;
  /** The check / ACH number the statement was paid under, or "" if none. */
  checkNo: string;
  storageKey: string | null;
  fileName: string | null;
  mime: string | null;
  size: number | null;
  totalOilBbls: number;
  totalGasMcf: number;
  totalValue: number;
  totalDeducts: number;
  totalTaxes: number;
  notes: string;
  /** Header-level long-tail fields not promoted to typed columns. */
  raw: Record<string, unknown>;
  createdAt: string;
}

/** A statement with its line items (detail view). */
export interface StatementWithLines extends Statement {
  lineItems: StatementLineItem[];
}

/** Editable line-item shape held in the review step (no line id). */
export interface LineItemInput {
  /** The stored line to update. Absent means insert. See `replaceStatementLines`. */
  id?: string;
  leaseId: string | null;
  tankId: string | null;
  meterId: string | null;
  leaseRef: string;
  tankRef: string;
  meterRef: string;
  product: LineProduct;
  volume: number;
  price: number | null;
  grossValue: number;
  deducts: number;
  taxes: number;
  netValue: number;
  mmbtu: number | null;
  allocatedQty: number | null;
  producerPct: number | null;
  settleQty: number | null;
  fees: number;
  raw?: Record<string, unknown>;
}

/** Fields for creating a statement header. */
export interface StatementInput {
  purchaser?: string;
  periodStart: string;
  periodEnd: string;
  product?: StatementProduct;
  statementNo?: string;
  checkNo?: string;
  storageKey?: string | null;
  fileName?: string | null;
  mime?: string | null;
  size?: number | null;
  notes?: string;
  /**
   * Crop provenance when the statement was photographed rather than scanned or
   * exported. Null (and omitted from the insert) for everything else, so a
   * pre-migration environment is unaffected by uploads that never cropped.
   */
  hygiene?: StoredHygiene | null;
}

/** Partial patch of a statement header's editable fields. */
export interface StatementPatch {
  purchaser?: string;
  periodStart?: string;
  periodEnd?: string;
  product?: StatementProduct;
  statementNo?: string;
  checkNo?: string;
  status?: StatementStatus;
  notes?: string;
}

// --- Pure value math -------------------------------------------------------

/**
 * A line's net value: the printed `netValue` when it is set/nonzero, otherwise
 * derived as gross − deducts − taxes. Statements print net; this keeps the two
 * consistent when only the gross breakdown was captured.
 */
export function lineNetValue(line: {
  grossValue: number;
  deducts: number;
  taxes: number;
  netValue?: number | null;
}): number {
  const net = line.netValue;
  if (net != null && Number.isFinite(net) && net !== 0) return net;
  return (line.grossValue ?? 0) - (line.deducts ?? 0) - (line.taxes ?? 0);
}

export interface SettlementReconciliation {
  settledVol: number;
  runNetBbls: number;
  /** settledVol − runNetBbls (never a sum of the two). */
  variance: number;
  /** |variance| as a % of the hauled barrels, or null when nothing was hauled. */
  variancePct: number | null;
  /** Within tolerance (default 2%): the two agree. */
  reconciled: boolean;
}

/**
 * Reconcile a tank's settled volume against the barrels it hauled — the Phase-4
 * rule that Runs (volume) and Settlements (money) RECONCILE, never SUM. The two
 * are kept as separate sources of truth; this only measures their agreement.
 */
export function reconcileSettledVolume(
  settledVol: number,
  runNetBbls: number,
  tolerancePct = 2
): SettlementReconciliation {
  const variance = settledVol - runNetBbls;
  const variancePct =
    runNetBbls > 0 ? (Math.abs(variance) / runNetBbls) * 100 : null;
  const reconciled = variancePct == null || variancePct <= tolerancePct;
  return { settledVol, runNetBbls, variance, variancePct, reconciled };
}

export interface StatementTotals {
  oilBbls: number;
  gasMcf: number;
  value: number;
  deducts: number;
  taxes: number;
}

/**
 * Roll a statement's line items up to header totals: oil/gas volumes split by
 * product, and the value / deducts / taxes summed across all lines. These back
 * the denormalized `statements.total_*` columns and the index row.
 */
export function statementTotals(
  lines: Pick<
    StatementLineItem | LineItemInput,
    "product" | "volume" | "grossValue" | "deducts" | "taxes" | "netValue"
  >[]
): StatementTotals {
  return lines.reduce<StatementTotals>(
    (acc, l) => {
      const vol = l.volume ?? 0;
      if (l.product === "gas") acc.gasMcf += vol;
      else acc.oilBbls += vol;
      acc.value += lineNetValue(l);
      acc.deducts += l.deducts ?? 0;
      acc.taxes += l.taxes ?? 0;
      return acc;
    },
    { oilBbls: 0, gasMcf: 0, value: 0, deducts: 0, taxes: 0 }
  );
}

// --- Row mappers -----------------------------------------------------------

interface PurchaserRow {
  id: string;
  name: string | null;
  product: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  active: boolean | null;
}

function mapPurchaser(r: PurchaserRow): Purchaser {
  return {
    id: r.id,
    name: r.name ?? "",
    product: r.product ?? null,
    contactName: r.contact_name,
    email: r.email,
    phone: r.phone,
    active: r.active ?? true,
  };
}

const STATEMENT_COLS =
  "id, purchaser_id, period_start, period_end, product, status, statement_no, " +
  "check_no, storage_key, file_name, mime, size, total_oil_bbls, total_gas_mcf, " +
  "total_value, total_deducts, total_taxes, notes, raw, created_at, purchasers(name)";

export interface StatementRow {
  id: string;
  purchaser_id: string | null;
  period_start: string;
  period_end: string;
  product: string | null;
  status: string | null;
  statement_no: string | null;
  check_no: string | null;
  storage_key: string | null;
  file_name: string | null;
  mime: string | null;
  size: number | null;
  total_oil_bbls: number | null;
  total_gas_mcf: number | null;
  total_value: number | null;
  total_deducts: number | null;
  total_taxes: number | null;
  notes: string | null;
  raw: Record<string, unknown> | null;
  created_at: string;
  purchasers: { name: string | null } | null;
}

export function mapStatement(r: StatementRow): Statement {
  return {
    id: r.id,
    purchaserId: r.purchaser_id,
    purchaser: r.purchasers?.name ?? "",
    periodStart: r.period_start,
    periodEnd: r.period_end,
    product: asStatementProduct(r.product),
    status: asStatus(r.status),
    statementNo: r.statement_no ?? "",
    checkNo: r.check_no ?? "",
    storageKey: r.storage_key,
    fileName: r.file_name,
    mime: r.mime,
    size: r.size,
    totalOilBbls: r.total_oil_bbls ?? 0,
    totalGasMcf: r.total_gas_mcf ?? 0,
    totalValue: r.total_value ?? 0,
    totalDeducts: r.total_deducts ?? 0,
    totalTaxes: r.total_taxes ?? 0,
    notes: r.notes ?? "",
    raw: r.raw ?? {},
    createdAt: r.created_at,
  };
}

const LINE_COLS =
  "id, statement_id, lease_id, tank_id, meter_id, lease_ref, tank_ref, " +
  "meter_ref, lease_name, product, volume, price, gross_value, deducts, taxes, " +
  "net_value, mmbtu, allocated_qty, producer_pct, settle_qty, fees, raw, " +
  "position, leases(name), " +
  // A meter has no stored name either; the line shows its lease + number.
  "meters(meter_no, lease:leases!lease_id(name)), " +
  // A tank has no stored name; the line shows its lease + number.
  "tanks(tank_no, product, lease:leases!lease_id(name), " +
  "battery_rel:tank_batteries!battery_id(lease:leases!lease_id(name)))";

interface LineRow {
  id: string;
  statement_id: string;
  lease_id: string | null;
  tank_id: string | null;
  meter_id: string | null;
  lease_ref: string | null;
  tank_ref: string | null;
  meter_ref: string | null;
  lease_name: string | null;
  product: string | null;
  volume: number | null;
  price: number | null;
  gross_value: number | null;
  deducts: number | null;
  taxes: number | null;
  net_value: number | null;
  mmbtu: number | null;
  allocated_qty: number | null;
  producer_pct: number | null;
  settle_qty: number | null;
  fees: number | null;
  raw: Record<string, unknown> | null;
  position: number | null;
  leases: { name: string | null } | null;
  tanks: {
    tank_no: string | null;
    /** What the tank holds — the letter in its derived name (T / W). */
    product: string | null;
    lease: { name: string | null } | null;
    battery_rel: { lease: { name: string | null } | null } | null;
  } | null;
  meters: {
    meter_no: string | null;
    lease: { name: string | null } | null;
  } | null;
}

function mapLine(r: LineRow): StatementLineItem {
  return {
    id: r.id,
    statementId: r.statement_id,
    leaseId: r.lease_id,
    tankId: r.tank_id,
    meterId: r.meter_id,
    leaseRef: r.lease_ref || r.lease_name || "",
    tankRef: r.tank_ref ?? "",
    meterRef: r.meter_ref ?? "",
    leaseName: r.leases?.name ?? "",
    tankName: tankDisplayName(
      r.tanks?.battery_rel?.lease?.name ?? r.tanks?.lease?.name ?? "",
      r.tanks?.tank_no,
      r.tanks?.product === "water" ? "water" : "oil"
    ),
    meterName: meterDisplayName(r.meters?.lease?.name, r.meters?.meter_no),
    product: asLineProduct(r.product),
    volume: r.volume ?? 0,
    // Derived on the way out too, so a gas row written before this rule — or by
    // anything that bypassed `replaceStatementLines` — still reads as $/MCF.
    price: gasLinePrice({
      product: asLineProduct(r.product),
      volume: r.volume ?? 0,
      netValue: r.net_value ?? 0,
      price: r.price,
      grossValue: r.gross_value ?? 0,
      deducts: r.deducts ?? 0,
      taxes: r.taxes ?? 0,
    }),
    grossValue: r.gross_value ?? 0,
    deducts: r.deducts ?? 0,
    taxes: r.taxes ?? 0,
    netValue: r.net_value ?? 0,
    mmbtu: r.mmbtu,
    allocatedQty: r.allocated_qty,
    producerPct: r.producer_pct,
    settleQty: r.settle_qty,
    fees: r.fees ?? 0,
    raw: r.raw ?? {},
    position: r.position ?? 0,
  };
}

// --- Purchasers ------------------------------------------------------------

/** All purchasers in the org (RLS-scoped), ordered by name. */
export async function listPurchasers(sb: Sb): Promise<Purchaser[]> {
  const { data, error } = await sb
    .from("purchasers")
    .select("id, name, product, contact_name, email, phone, active")
    .order("name");
  if (error) throw new Error(`listPurchasers: ${error.message}`);
  return ((data ?? []) as PurchaserRow[]).map(mapPurchaser);
}

// --- Statements: reads -----------------------------------------------------

/** Every statement in the org, newest period first. */
export async function listStatements(sb: Sb): Promise<Statement[]> {
  return (await listStatementRows(sb)).map(mapStatement);
}

/**
 * The org's statement rows as stored, newest period first. Every column, so
 * the payments projection (which needs a handful) and the Statements tab
 * (which needs them all) can share ONE read of the table per request
 * (`cachedStatementRows`); /revenue read it twice.
 */
export async function listStatementRows(sb: Sb): Promise<StatementRow[]> {
  const { data, error } = await sb
    .from("statements")
    .select(STATEMENT_COLS)
    .order("period_start", { ascending: false });
  if (error) throw new Error(`listStatements: ${error.message}`);
  return (data ?? []) as unknown as StatementRow[];
}

/** An existing statement that looks like one just extracted. */
export interface DuplicateStatement {
  id: string;
  /** Human-readable, for the banner: "P66 · Mar 2026 · #4471182". */
  label: string;
}

/**
 * For each candidate, the existing statement it appears to duplicate — or null.
 * Aligned with `candidates`, so the caller can attach a result per draft.
 *
 * ADVISORY ONLY. This never blocks a save, mirroring `findDuplicateRevenue`'s
 * stance: a purchaser genuinely can reissue a corrected statement under the same
 * number, and refusing that save would make the correction unfileable. We badge
 * it and the user decides.
 *
 * Identity comes from `stmtKey` — the SAME key `writeOilRunStatements` uses when
 * the ingest pipeline files a statement (`ingest/actions.ts`). Two different
 * answers to "is this the same statement?" across the two paths would be worse
 * than having no check at all: one path would file a duplicate the other refuses.
 *
 * Scoped by period overlap in SQL so this stays a narrow read rather than
 * loading every statement the org has ever filed; RLS scopes it to the org.
 */
export async function findExistingStatements(
  sb: Sb,
  candidates: {
    purchaser: string;
    statementNo: string;
    periodStart: string;
    periodEnd: string;
  }[]
): Promise<(DuplicateStatement | null)[]> {
  if (candidates.length === 0) return [];

  // One query covering every candidate's window, then key-matched in code.
  const earliest = candidates.reduce(
    (a, c) => (c.periodStart < a ? c.periodStart : a),
    candidates[0].periodStart
  );
  const latest = candidates.reduce(
    (a, c) => (c.periodEnd > a ? c.periodEnd : a),
    candidates[0].periodEnd
  );

  const { data, error } = await sb
    .from("statements")
    .select(STATEMENT_COLS)
    .lte("period_start", latest)
    .gte("period_end", earliest);
  if (error) {
    // Advisory feature: a failed lookup must not fail the extraction it decorates.
    console.error("findExistingStatements:", error.message);
    return candidates.map(() => null);
  }

  const existing = ((data ?? []) as unknown as StatementRow[]).map(mapStatement);
  const byKey = new Map<string, Statement>();
  for (const s of existing) {
    // First wins: the oldest row is the one the user would consider the original.
    const k = stmtKey(s.purchaser, s.statementNo, s.periodStart, s.periodEnd);
    if (!byKey.has(k)) byKey.set(k, s);
  }

  return candidates.map((c) => {
    const hit = byKey.get(
      stmtKey(c.purchaser, c.statementNo, c.periodStart, c.periodEnd)
    );
    if (!hit) return null;
    const period = `${hit.periodStart} → ${hit.periodEnd}`;
    const no = hit.statementNo ? ` · #${hit.statementNo}` : "";
    return { id: hit.id, label: `${hit.purchaser || "Unknown"} · ${period}${no}` };
  });
}

/** A statement's line items, in display order. */
export async function listStatementLines(
  sb: Sb,
  statementId: string
): Promise<StatementLineItem[]> {
  // A deleted payment stays deleted here too: the statement shows what it settles
  // now, not what it once claimed (docs/plans/derived-payments.md §13).
  const { data, error } = await sb
    .from("statement_line_items")
    .select(LINE_COLS)
    .eq("statement_id", statementId)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  if (error) throw new Error(`listStatementLines: ${error.message}`);
  return ((data ?? []) as unknown as LineRow[]).map(mapLine);
}

/**
 * The statuses whose lines are trusted as a record of what the operator DECIDED.
 * An `extracted` statement is the model's unreviewed guess; learning from it
 * would teach the matcher its own mistakes.
 */
const REVIEWED_STATUSES = ["reviewed"] as const;

/**
 * Printed lease refs this org has already resolved to a real lease, from its
 * reviewed statement history (docs/plans/statement-lease-matching.md, phase 5).
 *
 * This is how recall grows without the name comparison getting looser: a ref
 * only a human could connect to a lease ("RP UNIT A" -> Roach Parrott) stays
 * connected the next time the same purchaser prints it. Every row is a decision
 * a person made in the review grid, so nothing here is inferred.
 *
 * No new table: the pair already sits on every line the operator reviewed.
 * `buildLeaseAliases` turns it into the lookup.
 */
export async function listLeaseAliases(
  sb: Sb
): Promise<{ leaseRef: string; leaseId: string }[]> {
  const { data, error } = await sb
    .from("statement_line_items")
    .select("lease_ref, lease_id, statements!inner(status)")
    .is("deleted_at", null)
    .not("lease_id", "is", null)
    .neq("lease_ref", "")
    .in("statements.status", REVIEWED_STATUSES as unknown as string[]);
  if (error) throw new Error(`listLeaseAliases: ${error.message}`);
  const rows = (data ?? []) as unknown as {
    lease_ref: string | null;
    lease_id: string | null;
  }[];
  return rows
    .filter((r) => r.lease_ref && r.lease_id)
    .map((r) => ({ leaseRef: r.lease_ref as string, leaseId: r.lease_id as string }));
}

/** A settlement line for a tank, with its statement header fields joined in. */
export interface TankStatementLine {
  id: string;
  statementId: string;
  statementNo: string;
  periodStart: string;
  periodEnd: string;
  purchaser: string;
  status: StatementStatus;
  product: LineProduct;
  /** Settled volume (bbls for oil). */
  volume: number;
  price: number | null;
  grossValue: number;
  deducts: number;
  taxes: number;
  netValue: number;
}

interface TankLineRow {
  id: string;
  statement_id: string;
  product: string | null;
  volume: number | null;
  price: number | null;
  gross_value: number | null;
  deducts: number | null;
  taxes: number | null;
  net_value: number | null;
  statements: {
    statement_no: string | null;
    period_start: string;
    period_end: string;
    status: string | null;
    purchasers: { name: string | null } | null;
  } | null;
}

const TANK_LINE_COLS =
  "id, statement_id, product, volume, price, gross_value, deducts, taxes, " +
  "net_value, statements(statement_no, period_start, period_end, status, " +
  "purchasers(name))";

/**
 * Every settlement line matched to a tank, newest statement period first — the
 * REVENUE source of truth for the tank's Settlements tab. These are the money
 * side of a haul; the barrels live on the Runs tab (run tickets). The two
 * reconcile, they never sum.
 */
export async function listTankStatementLines(
  sb: Sb,
  tankId: string
): Promise<TankStatementLine[]> {
  const { data, error } = await sb
    .from("statement_line_items")
    .select(TANK_LINE_COLS)
    .eq("tank_id", tankId)
    .is("deleted_at", null);
  if (error) throw new Error(`listTankStatementLines: ${error.message}`);
  const rows = (data ?? []) as unknown as TankLineRow[];
  return rows
    .map((r) => ({
      id: r.id,
      statementId: r.statement_id,
      statementNo: r.statements?.statement_no ?? "",
      periodStart: r.statements?.period_start ?? "",
      periodEnd: r.statements?.period_end ?? "",
      purchaser: r.statements?.purchasers?.name ?? "",
      status: asStatus(r.statements?.status),
      product: asLineProduct(r.product),
      volume: r.volume ?? 0,
      price: r.price,
      grossValue: r.gross_value ?? 0,
      deducts: r.deducts ?? 0,
      taxes: r.taxes ?? 0,
      netValue: lineNetValue({
        grossValue: r.gross_value ?? 0,
        deducts: r.deducts ?? 0,
        taxes: r.taxes ?? 0,
        netValue: r.net_value,
      }),
    }))
    .sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
}

/** A single statement with its line items, or null if not found. */
export async function getStatement(
  sb: Sb,
  id: string
): Promise<StatementWithLines | null> {
  const { data, error } = await sb
    .from("statements")
    .select(STATEMENT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getStatement: ${error.message}`);
  if (!data) return null;
  const header = mapStatement(data as unknown as StatementRow);
  const lineItems = await listStatementLines(sb, id);
  return { ...header, lineItems };
}

/**
 * Read-only purchaser-sales slice for a well: every statement line item matched
 * to `wellId`, newest statement first. Backs the well page's read-only panel.
 */
export interface WellPurchaserSale {
  statementId: string;
  purchaser: string;
  periodStart: string;
  periodEnd: string;
  status: StatementStatus;
  product: LineProduct;
  volume: number;
  /** Pre-tax unit price: the purchaser's printed price, else gross ÷ volume. */
  price: number | null;
  /** volume × price, as settled: the value before anything came off. */
  grossValue: number;
  /** Everything between gross and value: deducts, taxes and fees together. */
  deductions: number;
  /** What the line paid, gross − deductions. */
  netValue: number;
  /** The operator's recorded interest in the lease; null when none is entered. */
  nri: number | null;
  /** netValue × NRI (the whole of it when no interest is recorded). */
  netRevenue: number;
}

/** Distinct tank + meter ids that route (any) production to `wellId`. */
export async function pointsForWell(
  sb: Sb,
  wellId: string
): Promise<{ tankIds: string[]; meterIds: string[] }> {
  const [battAlloc, meterAlloc, ownTanks, ownMeters] = await Promise.all([
    // Oil allocation lives at the battery now: the well's oil tanks are the tanks
    // in the batteries that feed it.
    sb.from("battery_well_allocations").select("battery_id").eq("well_id", wellId),
    sb.from("meter_well_allocations").select("meter_id").eq("well_id", wellId),
    sb.from("tanks").select("id").eq("well_id", wellId),
    sb.from("meters").select("id").eq("well_id", wellId),
  ]);
  const tankIds = new Set<string>();
  const batteryIds = [
    ...new Set(
      ((battAlloc.data ?? []) as { battery_id: string }[]).map((r) => r.battery_id)
    ),
  ];
  if (batteryIds.length > 0) {
    const { data: battTanks } = await sb
      .from("tanks")
      .select("id")
      .in("battery_id", batteryIds);
    for (const r of (battTanks ?? []) as { id: string }[]) tankIds.add(r.id);
  }
  for (const r of (ownTanks.data ?? []) as { id: string }[]) tankIds.add(r.id);
  const meterIds = new Set<string>();
  for (const r of (meterAlloc.data ?? []) as { meter_id: string }[])
    meterIds.add(r.meter_id);
  for (const r of (ownMeters.data ?? []) as { id: string }[]) meterIds.add(r.id);
  return { tankIds: [...tankIds], meterIds: [...meterIds] };
}

// --- Statements: writes ----------------------------------------------------

/**
 * The realized unit price for a settlement line: net value over volume.
 *
 * DERIVED, never read off the page. A gas settlement does not print a price per
 * MCF — it prints a residue or index price per MMBtu, NGL prices per gallon,
 * and a stack of fees — so the figure that answers "what did this gas actually
 * pay per MCF" exists nowhere on the document and has to be computed from two
 * numbers that do. NET, not gross: the operator's realized price is what landed
 * after taxes and fees, which is the number worth comparing month to month.
 *
 * Null when there is no volume to divide by; the same shape as a price the
 * document never printed.
 */
export function realizedUnitPrice(line: {
  volume: number;
  netValue: number;
}): number | null {
  if (!line.volume) return null;
  return line.netValue / line.volume;
}

/**
 * The price to store and to show for one line: derived on gas, printed on oil.
 *
 * Applied on the way IN (`replaceStatementLines`) and on the way OUT (the row
 * mapper), so a gas line cannot carry a read price in either direction — not
 * from a model that filled the field anyway, not from a caller that forgot, and
 * not from a row written before the rule existed.
 */
export function gasLinePrice(line: {
  product: LineProduct;
  volume: number;
  netValue?: number | null;
  price?: number | null;
  grossValue?: number;
  deducts?: number;
  taxes?: number;
  fees?: number | null;
}): number | null {
  if (line.product !== "gas") return line.price ?? null;
  const netValue =
    line.netValue ??
    lineNetValue({
      grossValue: line.grossValue ?? 0,
      deducts: line.deducts ?? 0,
      taxes: line.taxes ?? 0,
    });
  return realizedUnitPrice({ volume: line.volume, netValue });
}

/**
 * The id of the purchaser a printed name refers to, or null when it is new.
 *
 * Exact match first so a hand-corrected spelling always wins; then the same
 * canonical key ingest dedups every other directory on, which collapses case,
 * punctuation and the "LLC"/"L.L.C." kind of difference that one company prints
 * inconsistently across its own statements.
 *
 * Pure, and exported for the test: the duplicate it prevents is invisible in
 * the UI until months of revenue have already split in two.
 */
export function matchPurchaserName(
  purchasers: { id: string; name: string | null }[],
  printed: string
): string | null {
  const clean = printed.trim();
  if (!clean) return null;
  const exact = purchasers.find((p) => (p.name ?? "") === clean);
  if (exact) return exact.id;
  const key = canonical(clean);
  if (!key) return null;
  return purchasers.find((p) => canonical(p.name ?? "") === key)?.id ?? null;
}

/**
 * Resolve a purchaser name to an id, creating a minimal record on first use.
 * Returns null for a blank name. Org scoping is by RLS; `org_id`/`created_by`
 * come from column defaults, never the caller.
 *
 * Matching is CANONICAL, not exact. A purchaser prints its own name differently
 * on different statements — "EXO ENERGY SERVICE, LLC" one month and "Exo Energy
 * Service LLC" the next — and an exact `=` comparison made a second purchaser
 * out of the second spelling, splitting one company's revenue across two
 * records that no report ever adds back together. Every sibling resolver
 * (vendors, gatherers, tanks, meters) already keys on `canonical`; this one was
 * the exception.
 *
 * The exact spelling still wins when one matches, so the row a person renamed
 * by hand is never passed over for a canonical near-match.
 */
export async function getOrCreatePurchaser(
  sb: Sb,
  name: string
): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;
  const { data: rows, error: findErr } = await sb
    .from("purchasers")
    .select("id, name");
  if (findErr) throw new Error(`getOrCreatePurchaser (find): ${findErr.message}`);
  const existing = matchPurchaserName(
    (rows ?? []) as { id: string; name: string | null }[],
    clean
  );
  if (existing) return existing;
  const { data, error } = await sb
    .from("purchasers")
    .insert({ name: clean })
    .select("id")
    .single();
  if (error) throw new Error(`getOrCreatePurchaser (create): ${error.message}`);
  return (data as { id: string }).id;
}

/**
 * Fill in a purchaser's contact details (phone / email / contact name) when the
 * record does not already have them. Non-destructive by design: it only writes a
 * field that is currently blank, so re-filing statements never clobbers a number
 * the team curated. No-op when nothing new is supplied.
 */
export async function upsertPurchaserContact(
  sb: Sb,
  purchaserId: string,
  contact: { phone?: string; email?: string; contactName?: string }
): Promise<void> {
  const { data, error: readErr } = await sb
    .from("purchasers")
    .select("phone, email, contact_name")
    .eq("id", purchaserId)
    .maybeSingle();
  if (readErr) throw new Error(`upsertPurchaserContact (read): ${readErr.message}`);
  const cur = (data ?? {}) as {
    phone: string | null;
    email: string | null;
    contact_name: string | null;
  };
  const update: Record<string, unknown> = {};
  if (contact.phone?.trim() && !cur.phone) update.phone = contact.phone.trim();
  if (contact.email?.trim() && !cur.email) update.email = contact.email.trim();
  if (contact.contactName?.trim() && !cur.contact_name)
    update.contact_name = contact.contactName.trim();
  if (Object.keys(update).length === 0) return;
  const { error } = await sb
    .from("purchasers")
    .update(update)
    .eq("id", purchaserId);
  if (error) throw new Error(`upsertPurchaserContact (write): ${error.message}`);
}

/** Create a statement header. Resolves the purchaser name to an id. */
export async function createStatement(
  sb: Sb,
  input: StatementInput
): Promise<{ id: string }> {
  const purchaserId = input.purchaser
    ? await getOrCreatePurchaser(sb, input.purchaser)
    : null;
  const payload = {
    purchaser_id: purchaserId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    product: input.product ?? "oil",
    statement_no: input.statementNo || null,
    check_no: input.checkNo || null,
    storage_key: input.storageKey ?? null,
    file_name: input.fileName ?? null,
    mime: input.mime ?? null,
    size: input.size ?? null,
    notes: input.notes || null,
    // Omitted when absent so an environment that has not applied
    // 2026081200100_statement_hygiene.sql is unaffected by every upload that
    // did not go through crop review — which is all of them until P1 ships.
    ...(input.hygiene ? { hygiene: input.hygiene } : {}),
  };
  const { data, error } = await sb
    .from("statements")
    .insert(payload)
    .select("id")
    .single();
  if (error) throw new Error(`createStatement: ${error.message}`);
  return { id: (data as { id: string }).id };
}

/** Patch a statement header. A `purchaser` name is re-resolved to an id. */
export async function updateStatement(
  sb: Sb,
  id: string,
  patch: StatementPatch & { updatedBy?: string | null }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.purchaser !== undefined) {
    update.purchaser_id = patch.purchaser
      ? await getOrCreatePurchaser(sb, patch.purchaser)
      : null;
  }
  if (patch.periodStart !== undefined) update.period_start = patch.periodStart;
  if (patch.periodEnd !== undefined) update.period_end = patch.periodEnd;
  if (patch.product !== undefined) update.product = patch.product;
  if (patch.statementNo !== undefined)
    update.statement_no = patch.statementNo || null;
  if (patch.checkNo !== undefined) update.check_no = patch.checkNo || null;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.notes !== undefined) update.notes = patch.notes || null;
  if (patch.updatedBy !== undefined) update.updated_by = patch.updatedBy;
  if (Object.keys(update).length === 0) return;
  const { error } = await sb.from("statements").update(update).eq("id", id);
  if (error) throw new Error(`updateStatement: ${error.message}`);
}

/** Update just the denormalized totals on a statement from its line items. */
export async function updateStatementTotals(
  sb: Sb,
  id: string,
  totals: StatementTotals
): Promise<void> {
  const { error } = await sb
    .from("statements")
    .update({
      total_oil_bbls: totals.oilBbls,
      total_gas_mcf: totals.gasMcf,
      total_value: totals.value,
      total_deducts: totals.deducts,
      total_taxes: totals.taxes,
    })
    .eq("id", id);
  if (error) throw new Error(`updateStatementTotals: ${error.message}`);
}

/**
 * Reconcile a statement's line items with the reviewed set, then recompute and
 * persist the header totals.
 *
 * NOT a delete-then-insert, which is what this used to be. A line now carries
 * state that only exists in the database: `deleted_at`, a pinned lease, a chosen
 * category (docs/plans/derived-payments.md). Wiping the rows on every save would
 * resurrect deleted payments and silently discard the user's corrections, so a
 * line the caller identifies by id is UPDATED in place. Lines with no id are new;
 * live lines the caller no longer lists were removed in the editor and are
 * deleted. Rows already soft-deleted are never touched: they are not in the
 * caller's list because they are not shown, and that is not the same as gone.
 */
export async function replaceStatementLines(
  sb: Sb,
  statementId: string,
  lines: LineItemInput[]
): Promise<void> {
  // The live rows on file, to decide insert vs update vs delete.
  const { data: existing, error: readErr } = await sb
    .from("statement_line_items")
    .select("id")
    .eq("statement_id", statementId)
    .is("deleted_at", null);
  if (readErr) throw new Error(`replaceStatementLines (read): ${readErr.message}`);
  const liveIds = new Set(
    ((existing ?? []) as { id: string }[]).map((r) => r.id)
  );

  const keptIds = new Set(
    lines
      .map((l) => l.id)
      .filter((id): id is string => Boolean(id) && liveIds.has(id as string))
  );
  const goneIds = [...liveIds].filter((id) => !keptIds.has(id));
  if (goneIds.length > 0) {
    const { error: delErr } = await sb
      .from("statement_line_items")
      .delete()
      .in("id", goneIds);
    if (delErr) throw new Error(`replaceStatementLines (delete): ${delErr.message}`);
  }

  if (lines.length > 0) {
    const rows = lines.map((l, i) => ({
      statement_id: statementId,
      lease_id: l.leaseId || null,
      tank_id: l.tankId || null,
      meter_id: l.meterId || null,
      lease_ref: l.leaseRef || "",
      tank_ref: l.tankRef || "",
      meter_ref: l.meterRef || "",
      lease_name: l.leaseRef || "",
      product: l.product,
      volume: l.volume ?? 0,
      // NOT the caller's price on a gas line — the derivation, computed here.
      // Every path that files a settlement line comes through this function, so
      // this is the one place that can make "the gas price is net over MCF" a
      // property of the data instead of a rule each caller is trusted to follow.
      // A price read off a gas page (a residue $/MMBtu, an NGL $/gal) cannot
      // reach the column no matter who passes it.
      price: gasLinePrice(l),
      gross_value: l.grossValue ?? 0,
      deducts: l.deducts ?? 0,
      taxes: l.taxes ?? 0,
      net_value: lineNetValue(l),
      mmbtu: l.mmbtu ?? null,
      allocated_qty: l.allocatedQty ?? null,
      producer_pct: l.producerPct ?? null,
      settle_qty: l.settleQty ?? null,
      fees: l.fees ?? 0,
      raw: l.raw ?? {},
      position: i,
    }));
    // An edited line keeps its id, so the ledger row it projects keeps its id too.
    for (const [i, row] of rows.entries()) {
      const id = lines[i].id;
      if (!id || !keptIds.has(id)) continue;
      const { error: updErr } = await sb
        .from("statement_line_items")
        .update(row)
        .eq("id", id);
      if (updErr) {
        throw new Error(`replaceStatementLines (update): ${updErr.message}`);
      }
    }

    const inserts = rows.filter((_, i) => {
      const id = lines[i].id;
      return !id || !keptIds.has(id);
    });
    if (inserts.length > 0) {
      const { error: insErr } = await sb
        .from("statement_line_items")
        .insert(inserts);
      if (insErr) {
        throw new Error(`replaceStatementLines (insert): ${insErr.message}`);
      }
    }
  }

  // The header totals describe the DOCUMENT the purchaser sent, so a payment the
  // operator deleted still counts toward them. Otherwise deleting one line would
  // rewrite the statement's own total and the printed-total check would start
  // failing against a document nobody changed.
  const { data: dead } = await sb
    .from("statement_line_items")
    .select("product, volume, gross_value, deducts, taxes, net_value")
    .eq("statement_id", statementId)
    .not("deleted_at", "is", null);
  const deletedLines = ((dead ?? []) as DeletedTotalsRow[]).map((r) => ({
    product: r.product === "gas" ? ("gas" as const) : ("oil" as const),
    volume: Number(r.volume ?? 0),
    grossValue: Number(r.gross_value ?? 0),
    deducts: Number(r.deducts ?? 0),
    taxes: Number(r.taxes ?? 0),
    netValue: Number(r.net_value ?? 0),
  }));

  await updateStatementTotals(
    sb,
    statementId,
    statementTotals([...lines, ...deletedLines])
  );
}

/** The columns `replaceStatementLines` needs off a soft-deleted line. */
interface DeletedTotalsRow {
  product: string | null;
  volume: number | string | null;
  gross_value: number | string | null;
  deducts: number | string | null;
  taxes: number | string | null;
  net_value: number | string | null;
}
