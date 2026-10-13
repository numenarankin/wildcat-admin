import type { SupabaseClient } from "@supabase/supabase-js";
import type { AllocationValidation } from "@/lib/tanks/allocation";
import { validateStraightAllocationSet } from "@/lib/tanks/allocation";

/**
 * Tank → well allocation config data-access (GBC-4).
 *
 * Same client-injected idiom as `@/lib/tanks/tanks`: every helper takes the
 * caller's request-scoped RLS client (`getSupabaseServer()`) as its first
 * argument, and org ownership is enforced by the `tanks` /
 * `tank_well_allocations` RLS policies (never hand these the service-role
 * admin client). The straight-method derivation is a pure function
 * (`@/lib/tanks/allocation`) so it unit-tests without a database.
 *
 * This is the allocation *config* surface (method toggle + split rows). The
 * derivation that turns those splits into per-well production lives in the GBC-2
 * engine (`@/lib/tanks/engine.ts`), which reads this config through
 * `listTankAllocations`.
 */

export type AllocationMethod = "straight" | "weighted";

/** One tank→well split row (also defines commingled-tank membership). */
export interface TankAllocation {
  id: string;
  tankId: string;
  wellId: string;
  /** Fixed % of the tank's total going to this well (0–100), straight method. */
  straightPct: number;
  /** ISO `YYYY-MM-DD` the split takes effect. */
  effectiveFrom: string;
  /** ISO `YYYY-MM-DD` the split ends, or null when still active. */
  effectiveTo: string | null;
}

/** A split row as supplied by the config UI (no id for new rows). */
export interface TankAllocationInput {
  wellId: string;
  straightPct: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

type Sb = SupabaseClient;

const ALLOC_COLS =
  "id, tank_id, well_id, straight_pct, effective_from, effective_to";

interface AllocationRow {
  id: string;
  tank_id: string;
  well_id: string;
  straight_pct: number | null;
  effective_from: string;
  effective_to: string | null;
}

// --- Validation (pure) -----------------------------------------------------

export type { AllocationValidation };

/**
 * Validate a tank's straight-split set. Delegates to the shared per-period
 * validator: every % in [0, 100], each effective date range sums to 100, and no
 * two ranges overlap (which would double-allocate the overlap days). An empty or
 * all-zero set is valid (the tank simply derives nothing).
 */
export function validateStraightAllocations(
  rows: TankAllocationInput[]
): AllocationValidation {
  return validateStraightAllocationSet(rows);
}

function mapAllocation(r: AllocationRow): TankAllocation {
  return {
    id: r.id,
    tankId: r.tank_id,
    wellId: r.well_id,
    straightPct: r.straight_pct ?? 0,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

// --- Allocation method (on the tank) --------------------------------------

/** A tank's allocation method; defaults to `straight` when unset. */
export async function getTankAllocationMethod(
  sb: Sb,
  tankId: string
): Promise<AllocationMethod> {
  const { data, error } = await sb
    .from("tanks")
    .select("allocation_method")
    .eq("id", tankId)
    .maybeSingle();
  if (error) throw new Error(`getTankAllocationMethod: ${error.message}`);
  return data?.allocation_method === "weighted" ? "weighted" : "straight";
}

/** Set a tank's allocation method (straight | weighted). */
export async function setTankAllocationMethod(
  sb: Sb,
  tankId: string,
  method: AllocationMethod
): Promise<void> {
  const { error } = await sb
    .from("tanks")
    .update({ allocation_method: method })
    .eq("id", tankId);
  if (error) throw new Error(`setTankAllocationMethod: ${error.message}`);
}

// --- Allocation rows -------------------------------------------------------

/** A tank's split rows, oldest effective-date first. */
export async function listTankAllocations(
  sb: Sb,
  tankId: string
): Promise<TankAllocation[]> {
  const { data, error } = await sb
    .from("tank_well_allocations")
    .select(ALLOC_COLS)
    .eq("tank_id", tankId)
    .order("effective_from", { ascending: true });
  if (error) throw new Error(`listTankAllocations: ${error.message}`);
  return ((data ?? []) as AllocationRow[]).map(mapAllocation);
}

/**
 * The date a tank's history begins — the earliest of its first gauge reading and
 * first run ticket, ISO `YYYY-MM-DD`, or null when it has no history yet. Used as
 * the default `effective_from` when a well is linked to a tank, so the allocation
 * covers the tank's WHOLE history (its production is derived from that history)
 * rather than only from the day it happened to be linked — the DB column default
 * (`current_date`) would otherwise drop every earlier reading from the well.
 */
export async function tankHistoryStartDate(
  sb: Sb,
  tankId: string
): Promise<string | null> {
  const [reading, ticket] = await Promise.all([
    sb
      .from("tank_readings")
      .select("reading_date")
      .eq("tank_id", tankId)
      .is("deleted_at", null)
      .order("reading_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    sb
      .from("run_tickets")
      .select("ticket_date")
      .eq("tank_id", tankId)
      .is("deleted_at", null)
      .order("ticket_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  const dates = [
    (reading.data as { reading_date?: string } | null)?.reading_date,
    (ticket.data as { ticket_date?: string } | null)?.ticket_date,
  ].filter((d): d is string => Boolean(d));
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (d < min ? d : min));
}

/**
 * Replace a tank's split rows with the supplied set (delete-then-insert). The
 * config UI hands the full desired list; `org_id` comes from the RLS default so
 * a caller can't write into another org. A blank `wellId` row is skipped.
 *
 * A row without an explicit `effectiveFrom` defaults to the tank's history start
 * (so the split covers the tank's whole production), falling back to the DB's
 * `current_date` only when the tank has no history yet.
 */
export async function replaceTankAllocations(
  sb: Sb,
  tankId: string,
  rows: TankAllocationInput[]
): Promise<void> {
  const check = validateStraightAllocations(rows);
  if (!check.ok) throw new Error(`replaceTankAllocations: ${check.error}`);

  const del = await sb
    .from("tank_well_allocations")
    .delete()
    .eq("tank_id", tankId);
  if (del.error)
    throw new Error(`replaceTankAllocations (delete): ${del.error.message}`);

  const valid = rows.filter((r) => r.wellId);
  if (valid.length === 0) return;
  // Only resolve the tank's history start if a row actually needs a default.
  // Never `undefined`: supabase-js gives every object in an array insert the same
  // keys, filling the gaps with an explicit NULL, and an explicit NULL does not
  // fall back to the column's `default current_date` — it violates NOT NULL.
  const historyStart = valid.some((r) => !r.effectiveFrom)
    ? ((await tankHistoryStartDate(sb, tankId)) ??
      new Date().toISOString().slice(0, 10))
    : null;
  const payload = valid.map((r) => ({
    tank_id: tankId,
    well_id: r.wellId,
    straight_pct: Number.isFinite(r.straightPct) ? r.straightPct : 0,
    effective_from: r.effectiveFrom || historyStart,
    effective_to: r.effectiveTo ?? null,
  }));

  const { error } = await sb.from("tank_well_allocations").insert(payload);
  if (error) throw new Error(`replaceTankAllocations (insert): ${error.message}`);
}

/**
 * Add one or more wells to a tank as split rows — the targeted insert behind the
 * Wells tab's "Add Well" action. Each new well lands at 0% (the operator sets the
 * real split in the Allocation panel); wells already on the tank are skipped, so
 * the same set can be submitted twice without duplicating rows. `org_id` /
 * `effective_from` come from the RLS/column defaults.
 */
export async function addTankAllocationsForWells(
  sb: Sb,
  tankId: string,
  wellIds: string[],
  straightPct = 0
): Promise<void> {
  const ids = [...new Set(wellIds.filter(Boolean))];
  if (ids.length === 0) return;

  const { data: existing, error: exErr } = await sb
    .from("tank_well_allocations")
    .select("well_id")
    .eq("tank_id", tankId)
    .in("well_id", ids);
  if (exErr)
    throw new Error(`addTankAllocationsForWells (check): ${exErr.message}`);

  const have = new Set(
    ((existing ?? []) as { well_id: string }[]).map((r) => r.well_id)
  );
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length === 0) return;

  // Cover the tank's whole history, not just from today (see tankHistoryStartDate).
  // A tank with no readings/runs yet (e.g. one just created for a new well) has no
  // history start — fall back to today so `effective_from` is never null (the
  // column is NOT NULL) and the split simply starts now.
  const historyStart =
    (await tankHistoryStartDate(sb, tankId)) ||
    new Date().toISOString().slice(0, 10);
  const payload = missing.map((wellId) => ({
    tank_id: tankId,
    well_id: wellId,
    straight_pct: straightPct,
    effective_from: historyStart,
  }));

  const { error } = await sb.from("tank_well_allocations").insert(payload);
  if (error) throw new Error(`addTankAllocationsForWells: ${error.message}`);
}

/** Clamp a percentage to the DB's per-row [0, 100] bound. */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Set a single well's straight % on a tank — the Wells tab's inline edit.
 * Upserts just that well's row: updates it if present, else inserts one (so the
 * primary well of a single-well tank can be edited before it has a split row).
 * No sum-to-100 enforcement here — that stays a soft rule in the config panel;
 * the DB's per-row [0, 100] bound is respected.
 */
export async function setTankAllocationPct(
  sb: Sb,
  tankId: string,
  wellId: string,
  straightPct: number
): Promise<void> {
  const pct = clampPct(straightPct);
  const { data, error } = await sb
    .from("tank_well_allocations")
    .update({ straight_pct: pct })
    .eq("tank_id", tankId)
    .eq("well_id", wellId)
    .select("id");
  if (error) throw new Error(`setTankAllocationPct (update): ${error.message}`);
  if (data && data.length > 0) return;

  // New row: start it at the tank's history so the split covers all its production.
  const historyStart =
    (await tankHistoryStartDate(sb, tankId)) ??
    new Date().toISOString().slice(0, 10);
  const { error: insErr } = await sb.from("tank_well_allocations").insert({
    tank_id: tankId,
    well_id: wellId,
    straight_pct: pct,
    effective_from: historyStart,
  });
  if (insErr) throw new Error(`setTankAllocationPct (insert): ${insErr.message}`);
}

/**
 * Remove a single well's split row(s) from a tank — the targeted delete behind
 * the Wells tab's "remove well" action. Only the tank↔well allocation is
 * removed; the well itself is untouched.
 */
export async function deleteTankAllocationForWell(
  sb: Sb,
  tankId: string,
  wellId: string
): Promise<void> {
  const { error } = await sb
    .from("tank_well_allocations")
    .delete()
    .eq("tank_id", tankId)
    .eq("well_id", wellId);
  if (error) throw new Error(`deleteTankAllocationForWell: ${error.message}`);
}
