import type { SupabaseClient } from "@supabase/supabase-js";
import { memoScope } from "@/lib/cache/request-cache";
import { getCompanyProduction } from "@/lib/reports/production-data";
import { monthKey } from "@/lib/accounting/derive";

/**
 * Interest data-access (GBC-8).
 *
 * Interest is stored on the generalized join `royalty_owner_wells`: each holding
 * carries an `interest_type` (WI | RI | ORRI | NPRI), a `working_interest` and a
 * `net_revenue_interest` (kept DISTINCT — WI drives costs, NRI drives
 * revenue/volumes), and an `is_operator` flag so the operator itself can be a
 * holder with no `royalty_owners` row (royalty_owner_id is null on those rows).
 *
 * Every helper takes the caller's Supabase client first (same idiom as
 * `@/lib/tanks`). Handing it the request-scoped RLS client (`getSupabaseServer`)
 * is what enforces org ownership — the `royalty_owner_wells` / `royalty_owners`
 * RLS policies scope reads and writes, so a caller can't reach another org's
 * interest regardless of the ids passed. Never hand these the service-role admin
 * client — that bypasses RLS.
 */

export type InterestType = "WI" | "RI" | "ORRI" | "NPRI";

const INTEREST_TYPES: readonly InterestType[] = ["WI", "RI", "ORRI", "NPRI"];

function asInterestType(v: string | null | undefined): InterestType {
  return v && (INTEREST_TYPES as readonly string[]).includes(v)
    ? (v as InterestType)
    : "RI";
}

/** One holder's interest in one lease. */
export interface InterestHolding {
  /** Surrogate row id. */
  id: string;
  /** Royalty owner holding this interest, or null when it's one of the org's. */
  ownerId: string | null;
  ownerName: string;
  /**
   * The org's own company holding this interest (`org_wi_owners`), or null.
   *
   * Set on a holding recorded under one of the working-interest-owning
   * companies the operator splits its assets into. Together with `isOperator`
   * this marks a HOUSE holding: the fraction belongs to the user, so it counts
   * toward NRI and is never distributed. See `isHouseHolding`.
   */
  wiOwnerId: string | null;
  /** That company's name, for display. Null on every other holding. */
  wiOwnerName: string | null;
  /** The lease this interest is held in (every well on it shares the holding). */
  leaseId: string;
  interestType: InterestType;
  /** Working-interest fraction (share of costs); GWI when this is the operator. */
  workingInterest: number;
  /** Net-revenue-interest fraction (share of revenue / volumes). */
  netRevenueInterest: number;
  /** True when this row represents the OPERATING entity's own interest. */
  isOperator: boolean;
}

/** Editable fields of an interest holding. */
export interface InterestPatch {
  interestType?: InterestType;
  workingInterest?: number;
  netRevenueInterest?: number;
  isOperator?: boolean;
}

/** Gross monthly volumes for one well, before interest is applied. */
export interface MonthlyWellVolumes {
  wellId: string;
  /** First day of the month, ISO `YYYY-MM-01`. */
  month: string;
  oil: number;
  oilSales: number;
  gas: number;
  water: number;
}

type Sb = SupabaseClient;

const INTEREST_COLS =
  "id, royalty_owner_id, wi_owner_id, lease_id, interest_type, working_interest, " +
  "net_revenue_interest, is_operator, royalty_owners(name), org_wi_owners(name)";

interface InterestRow {
  id: string;
  royalty_owner_id: string | null;
  wi_owner_id: string | null;
  lease_id: string;
  interest_type: string | null;
  working_interest: number | null;
  net_revenue_interest: number | null;
  is_operator: boolean | null;
  // Supabase types an embedded to-one relation as an array or object.
  royalty_owners: { name: string | null } | { name: string | null }[] | null;
  org_wi_owners: { name: string | null } | { name: string | null }[] | null;
}

function relName(
  rel: InterestRow["royalty_owners"] | InterestRow["org_wi_owners"]
): string {
  if (!rel) return "";
  const one = Array.isArray(rel) ? rel[0] : rel;
  return one?.name ?? "";
}

function mapInterest(r: InterestRow): InterestHolding {
  // A holding under one of the org's own companies shows THAT company's name.
  // "Operator" is reserved for the operating entity's row: once the user has
  // several entities, a table that called them all "Operator" would say the
  // same thing about rows that are legally different companies.
  const wiName = relName(r.org_wi_owners);
  return {
    id: r.id,
    ownerId: r.royalty_owner_id,
    ownerName: r.wi_owner_id
      ? wiName
      : r.is_operator
        ? "Operator"
        : relName(r.royalty_owners),
    wiOwnerId: r.wi_owner_id,
    wiOwnerName: r.wi_owner_id ? wiName : null,
    leaseId: r.lease_id,
    interestType: asInterestType(r.interest_type),
    workingInterest: r.working_interest ?? 0,
    netRevenueInterest: r.net_revenue_interest ?? 0,
    isOperator: r.is_operator ?? false,
  };
}

// --- Interest: reads -------------------------------------------------------

/** The interest holdings for one lease (RLS-scoped). */
export async function listLeaseInterests(
  sb: Sb,
  leaseId: string
): Promise<InterestHolding[]> {
  const { data, error } = await sb
    .from("royalty_owner_wells")
    .select(INTEREST_COLS)
    .eq("lease_id", leaseId);
  if (error) throw new Error(`listLeaseInterests: ${error.message}`);
  return ((data ?? []) as unknown as InterestRow[]).map(mapInterest);
}

/** Every interest holding visible to the caller, across all leases. */
export async function listAllInterests(sb: Sb): Promise<InterestHolding[]> {
  // Once per request whichever client asks: the tank page's NRI resolver and
  // the accounting ledger (behind realized prices) each read the whole table
  // on their own client, which the per-client memo saw as two reads.
  return memoScope("interests-all", async () => {
    const { data, error } = await sb
      .from("royalty_owner_wells")
      .select(INTEREST_COLS);
    if (error) throw new Error(`listAllInterests: ${error.message}`);
    return ((data ?? []) as unknown as InterestRow[]).map(mapInterest);
  });
}

/** The operator's own interest in a lease (the `is_operator` row), or null. */
export async function getOperatorInterest(
  sb: Sb,
  leaseId: string
): Promise<InterestHolding | null> {
  const { data, error } = await sb
    .from("royalty_owner_wells")
    .select(INTEREST_COLS)
    .eq("lease_id", leaseId)
    .eq("is_operator", true)
    .maybeSingle();
  if (error) throw new Error(`getOperatorInterest: ${error.message}`);
  return data ? mapInterest(data as unknown as InterestRow) : null;
}

// --- Interest: writes ------------------------------------------------------

/**
 * Add a royalty owner's interest holding on a lease. One holding per
 * (owner, lease) — enforced by a partial unique index. `org_id`/`created_by`
 * come from RLS defaults. Returns the new row id.
 */
export async function addLeaseInterest(
  sb: Sb,
  leaseId: string,
  ownerId: string,
  values: {
    interestType: InterestType;
    workingInterest: number;
    netRevenueInterest: number;
  }
): Promise<{ id: string }> {
  const { data, error } = await sb
    .from("royalty_owner_wells")
    .insert({
      lease_id: leaseId,
      royalty_owner_id: ownerId,
      is_operator: false,
      interest_type: values.interestType,
      working_interest: values.workingInterest,
      net_revenue_interest: values.netRevenueInterest,
    })
    .select("id")
    .single();
  if (error) throw new Error(`addLeaseInterest: ${error.message}`);
  return { id: data.id };
}

/**
 * Add a holding under one of the ORG's own companies (`org_wi_owners`).
 *
 * Separate from {@link addLeaseInterest} because the row means something
 * different: this fraction belongs to the user, so it counts toward the org's
 * NRI and is never distributed. Its `interest_type` is the holder's own,
 * exactly as a third party's is: these companies buy overrides and royalty as
 * well as working interest, and one of them can hold both on a lease. The
 * database allows one row per (company, lease, TYPE) for that reason.
 *
 * `org_id`/`created_by` come from RLS defaults. Returns the new row id.
 */
export async function addWiOwnerInterest(
  sb: Sb,
  leaseId: string,
  wiOwnerId: string,
  values: {
    interestType: InterestType;
    workingInterest: number;
    netRevenueInterest: number;
  }
): Promise<{ id: string }> {
  const { data, error } = await sb
    .from("royalty_owner_wells")
    .insert({
      lease_id: leaseId,
      royalty_owner_id: null,
      wi_owner_id: wiOwnerId,
      is_operator: false,
      interest_type: values.interestType,
      working_interest: values.workingInterest,
      net_revenue_interest: values.netRevenueInterest,
    })
    .select("id")
    .single();
  if (error) throw new Error(`addWiOwnerInterest: ${error.message}`);
  return { id: data.id };
}

/**
 * Update the WI/NRI/type of one interest holding by its row id (scoped to the
 * lease). Only the keys present in `patch` change.
 */
export async function setLeaseInterest(
  sb: Sb,
  id: string,
  leaseId: string,
  patch: InterestPatch
): Promise<void> {
  const update = interestUpdate(patch);
  if (Object.keys(update).length === 0) return;

  const { error } = await sb
    .from("royalty_owner_wells")
    .update(update)
    .eq("id", id)
    .eq("lease_id", leaseId);
  if (error) throw new Error(`setLeaseInterest: ${error.message}`);
}

/** Remove an interest holding by its row id (scoped to the lease). */
export async function removeLeaseInterest(
  sb: Sb,
  id: string,
  leaseId: string
): Promise<void> {
  const { error } = await sb
    .from("royalty_owner_wells")
    .delete()
    .eq("id", id)
    .eq("lease_id", leaseId);
  if (error) throw new Error(`removeLeaseInterest: ${error.message}`);
}

/**
 * Upsert the operator's own WI/NRI for a lease. There is at most one operator
 * holding per lease (enforced by a partial unique index), so this updates the
 * existing operator row if present, else inserts one (with no royalty owner).
 * `org_id`/`created_by` come from RLS defaults — never caller-supplied.
 */
export async function upsertOperatorInterest(
  sb: Sb,
  leaseId: string,
  values: { workingInterest: number; netRevenueInterest: number }
): Promise<void> {
  const existing = await getOperatorInterest(sb, leaseId);
  if (existing) {
    const { error } = await sb
      .from("royalty_owner_wells")
      .update({
        working_interest: values.workingInterest,
        net_revenue_interest: values.netRevenueInterest,
      })
      .eq("id", existing.id);
    if (error) throw new Error(`upsertOperatorInterest (update): ${error.message}`);
    return;
  }
  const { error } = await sb.from("royalty_owner_wells").insert({
    lease_id: leaseId,
    royalty_owner_id: null,
    is_operator: true,
    interest_type: "WI",
    working_interest: values.workingInterest,
    net_revenue_interest: values.netRevenueInterest,
  });
  if (error) throw new Error(`upsertOperatorInterest (insert): ${error.message}`);
}

/** Build a snake_case update payload from a patch (empty keys omitted). */
function interestUpdate(patch: InterestPatch): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  if (patch.interestType !== undefined) update.interest_type = patch.interestType;
  if (patch.workingInterest !== undefined)
    update.working_interest = patch.workingInterest;
  if (patch.netRevenueInterest !== undefined)
    update.net_revenue_interest = patch.netRevenueInterest;
  if (patch.isOperator !== undefined) update.is_operator = patch.isOperator;
  return update;
}

// --- Production volumes (gross, for the Gross-vs-Net report) ----------------

interface ProductionRow {
  well_id: string;
  reading_date: string;
  oil_production: number | null;
  oil_sales: number | null;
  gas_production: number | null;
  salt_water: number | null;
}

/**
 * Gross monthly production volumes per well. One row per (well, month); these
 * are the GROSS figures the Gross-vs-Net report multiplies by GWI/NRI.
 *
 * Built from the DERIVED series (`getCompanyProduction`), not from
 * `production_readings`. That table holds hand-entered daily rows and is close
 * to empty on an operator whose oil comes from tank gauges and whose gas comes
 * from meters — this report printed near-nothing next to pages showing years of
 * production, and it is the number an owner takes their royalty conversation
 * from. The aggregation itself is unchanged; only the source is.
 */
export async function listMonthlyProductionVolumes(): Promise<
  MonthlyWellVolumes[]
> {
  const rows = await getCompanyProduction();
  return aggregateMonthlyVolumes(
    rows.map((r) => ({
      well_id: r.wellId,
      reading_date: r.date,
      oil_production: r.oilProduction,
      oil_sales: r.oilSales,
      gas_production: r.gasProduction,
      salt_water: r.saltWater,
    }))
  );
}

/** Pure aggregation of readings into per-(well, month) gross volumes. */
export function aggregateMonthlyVolumes(
  rows: ProductionRow[]
): MonthlyWellVolumes[] {
  const by = new Map<string, MonthlyWellVolumes>();
  for (const r of rows) {
    if (!r.well_id || !r.reading_date) continue;
    const month = monthKey(r.reading_date);
    const key = `${r.well_id}|${month}`;
    const agg =
      by.get(key) ??
      { wellId: r.well_id, month, oil: 0, oilSales: 0, gas: 0, water: 0 };
    agg.oil += r.oil_production ?? 0;
    agg.oilSales += r.oil_sales ?? 0;
    agg.gas += r.gas_production ?? 0;
    agg.water += r.salt_water ?? 0;
    by.set(key, agg);
  }
  return [...by.values()];
}
