import type { SupabaseClient } from "@supabase/supabase-js";
import { monthKey } from "@/lib/accounting/derive";
import type { Month } from "@/lib/rrc/rrc";

/**
 * Lease-Use Gas data-access (GBC-14).
 *
 * Lease-use gas is a MANUAL monthly per-lease figure (on-lease fuel gas burned
 * by engines / heater-treaters) — the balancing term in the gas balance the RRC
 * reconciliation report reads (Gas Produced = Gas Sales + Lease Use + shrinkage).
 * One row per (well, month) in `lease_use_gas`, keyed to a first-of-month date.
 *
 * Same client-injected idiom as `@/lib/tanks/*` and `@/lib/interest`: every
 * helper takes the caller's Supabase client first. Passing the request-scoped
 * RLS client (`getSupabaseServer()`) is what enforces org ownership — the
 * `lease_use_gas` policies scope reads/writes to `current_org_id()`. Never hand
 * these the service-role admin client (it bypasses RLS).
 */

/** One lease's lease-use gas figure for one month. */
export interface LeaseUseGasEntry {
  wellId: string;
  /** First-of-month, ISO `YYYY-MM-01`. */
  month: Month;
  leaseUseMcf: number;
}

type Sb = SupabaseClient;

interface LeaseUseGasRow {
  well_id: string;
  month: string;
  lease_use_mcf: number | null;
}

function mapEntry(r: LeaseUseGasRow): LeaseUseGasEntry {
  return {
    wellId: r.well_id,
    // Normalize whatever the DB returns (date or timestamp) to first-of-month.
    month: monthKey(r.month),
    leaseUseMcf: r.lease_use_mcf ?? 0,
  };
}

// --- Pure helpers ----------------------------------------------------------

/**
 * Index entries by `"wellId|month"` → MCF, for O(1) lookup while assembling the
 * reconciliation / gas-balance inputs. Pure, so it unit-tests without a DB.
 */
export function leaseUseGasIndex(
  entries: LeaseUseGasEntry[]
): Map<string, number> {
  const by = new Map<string, number>();
  for (const e of entries) by.set(`${e.wellId}|${e.month}`, e.leaseUseMcf);
  return by;
}

/** Lease-use MCF for a (well, month), or 0 when none was entered. */
export function leaseUseGasFor(
  index: Map<string, number>,
  wellId: string,
  month: Month
): number {
  return index.get(`${wellId}|${month}`) ?? 0;
}

// --- Reads -----------------------------------------------------------------

/** Every lease-use gas entry in the org (RLS-scoped), newest month first. */
export async function listLeaseUseGas(sb: Sb): Promise<LeaseUseGasEntry[]> {
  const { data, error } = await sb
    .from("lease_use_gas")
    .select("well_id, month, lease_use_mcf")
    .order("month", { ascending: false });
  if (error) throw new Error(`listLeaseUseGas: ${error.message}`);
  return ((data ?? []) as LeaseUseGasRow[]).map(mapEntry);
}

/** A single well's lease-use gas entries (RLS-scoped), newest month first. */
export async function listWellLeaseUseGas(
  sb: Sb,
  wellId: string
): Promise<LeaseUseGasEntry[]> {
  const { data, error } = await sb
    .from("lease_use_gas")
    .select("well_id, month, lease_use_mcf")
    .eq("well_id", wellId)
    .order("month", { ascending: false });
  if (error) throw new Error(`listWellLeaseUseGas: ${error.message}`);
  return ((data ?? []) as LeaseUseGasRow[]).map(mapEntry);
}

// --- Writes ----------------------------------------------------------------

/**
 * Set a well's lease-use gas for a month (upsert on `(well_id, month)`). The
 * month is pinned to the first of the month so the uniqueness key is stable.
 * `org_id`/`created_by` come from RLS defaults — never caller-supplied.
 */
export async function setLeaseUseGas(
  sb: Sb,
  wellId: string,
  month: Month,
  leaseUseMcf: number
): Promise<void> {
  const { error } = await sb.from("lease_use_gas").upsert(
    {
      well_id: wellId,
      month: monthKey(month),
      lease_use_mcf: Number.isFinite(leaseUseMcf) ? leaseUseMcf : 0,
    },
    { onConflict: "well_id,month" }
  );
  if (error) throw new Error(`setLeaseUseGas: ${error.message}`);
}
