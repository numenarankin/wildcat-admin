"use server";

/**
 * Server actions for tank batteries — thin wrappers over the
 * `@/lib/batteries/batteries` data-access layer that run through the request-
 * scoped RLS client (org ownership is enforced by RLS) and revalidate the
 * Production page. Mirrors the tank/meter actions; the data-access layer stays
 * client-injectable for tests.
 */

import { cachedBatteries,
  cachedBatteryAllocationRows,
  cachedWellTestFracs,
  cachedWellTests,
} from "@/lib/cache/loaders";
import { revalidatePath } from "next/cache";
import { invalidateWellProductionRates } from "@/lib/wells/rate-cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { createBattery, deleteBattery, getBattery, setBatteryTanks, updateBattery, type BatteryInput, type BatteryPatch, type TankBattery } from "@/lib/batteries/batteries";
import {
  addBatteryAllocationsForWells,
  batteryHistoryStartDate,
  deleteBatteryAllocationForWell,
  ensureBatteryMembership,
  listBatteryAllocations,
  replaceBatteryAllocations,
  resolveBatteryTimeline,
  setBatteryAllocationPct,
  type AllocationPeriod,
  type BatteryAllocationInput,
} from "@/lib/batteries/allocations";
import { listWellTestsByWell, type WellTest } from "@/lib/wells/well-tests";
import { bridgeAndDropConnections } from "@/lib/flow/connections";

/** All batteries in the org. */
export async function getBatteries(): Promise<TankBattery[]> {
  const sb = await getRequestSupabase();
  // Memoized so the tab badge count (`production/tab-counts.ts`) and this roster
  // are one read instead of a roster plus a head count.
  return cachedBatteries(sb);
}

/** A single battery by id, or null if it isn't visible to the caller. */
export async function getBatteryById(id: string): Promise<TankBattery | null> {
  const sb = await getRequestSupabase();
  return getBattery(sb, id);
}

/** Create a battery; returns its id. Revalidates the Production page. */
export async function addBattery(input: BatteryInput): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await createBattery(sb, input);
  revalidatePath("/production");
  return result;
}

/**
 * Put exactly these wells on a battery, and take off any other.
 *
 * Oil allocates at the battery and nowhere else (`allocationForTank`), so this
 * is where a producing well is joined to the oil side. First well takes the
 * whole split; later ones start at 0% for the operator to divide.
 */
export async function setBatteryWells(
  batteryId: string,
  wellIds: string[]
): Promise<void> {
  const sb = await getSupabaseServer();
  const wanted = [...new Set(wellIds.filter(Boolean))];
  const existing = await listBatteryAllocations(sb, batteryId);

  for (const row of existing) {
    if (!wanted.includes(row.wellId)) {
      await deleteBatteryAllocationForWell(sb, batteryId, row.wellId);
    }
  }
  for (const wellId of wanted) {
    await ensureBatteryMembership(sb, batteryId, wellId);
  }
  revalidatePath("/facilities");
  revalidatePath("/production/batteries", "layout");
}

/** Update a battery's fields. */
export async function editBattery(
  id: string,
  patch: BatteryPatch
): Promise<void> {
  const sb = await getSupabaseServer();
  await updateBattery(sb, id, patch);
  revalidatePath("/production");
  // A battery holding water tanks lists on /disposal too, and its Mode-B link
  // changes what that page's totals are derived from.
  revalidatePath("/disposal");
  // The map draws that link as an edge, and unwiring it from the map is this
  // action with `injectionWellId: null`.
  revalidatePath("/facilities");
}

/** Delete a battery. Soft: its tanks keep their link, so a restore is whole. */
export async function removeBattery(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  await deleteBattery(sb, id);
  // A -> battery -> C leaves A -> C (`bridgeAndDropConnections`).
  await bridgeAndDropConnections(sb, { type: "battery", id });
  revalidatePath("/production");
  revalidatePath("/facilities");
}

/**
 * Set which tanks belong to a battery (the create/settings modal's tank picker).
 * Links the selected tanks and unlinks any deselected one still on the battery;
 * the DB trigger cascades the battery's lease to newly linked tanks.
 */
export async function saveBatteryTanks(
  batteryId: string,
  tankIds: string[]
): Promise<void> {
  const sb = await getSupabaseServer();
  await setBatteryTanks(sb, batteryId, tankIds);
  revalidatePath("/production");
  revalidatePath("/production/batteries", "layout");
}

// --- Allocation config -----------------------------------------------------

/**
 * The battery's RESOLVED allocation timeline (manual periods ∪ well-test-derived
 * periods, from-only and chained) plus its member wells, for the Allocation
 * panel. Well-test periods are computed on read, never stored.
 */
export async function getBatteryAllocationConfig(
  batteryId: string
): Promise<{ periods: AllocationPeriod[]; memberWellIds: string[] }> {
  const sb = await getRequestSupabase();
  // Split rows and the frac pool through the cached loaders, then handed to
  // the timeline: it otherwise reads both itself, and the battery page reads
  // the rows a third time for its tests tab and its series.
  const [rows, fracs] = await Promise.all([
    cachedBatteryAllocationRows(sb, batteryId),
    cachedWellTestFracs(sb),
  ]);
  const periods = await resolveBatteryTimeline(sb, batteryId, fracs, rows);
  return { periods, memberWellIds: [...new Set(rows.map((r) => r.wellId))] };
}

/**
 * Save the battery's MANUAL allocation periods (the Allocation panel's Save).
 * Only manual groups are written; well-test periods live as well tests and are
 * derived on read. Membership is preserved: a member well absent from the manual
 * payload keeps a 0% row (anchored at the battery's history start) so its well
 * tests still resolve into the timeline.
 */
export async function saveBatteryAllocationConfig(
  batteryId: string,
  rows: BatteryAllocationInput[]
): Promise<void> {
  const sb = await getSupabaseServer();
  const existing = await listBatteryAllocations(sb, batteryId);
  const inPayload = new Set(rows.filter((r) => r.wellId).map((r) => r.wellId));
  const orphans = [...new Set(existing.map((r) => r.wellId))].filter(
    (w) => !inPayload.has(w)
  );
  let membership: BatteryAllocationInput[] = [];
  if (orphans.length > 0) {
    const start = (await batteryHistoryStartDate(sb, batteryId)) ?? undefined;
    membership = orphans.map((wellId) => ({
      wellId,
      straightPct: 0,
      effectiveFrom: start,
      effectiveTo: null,
    }));
  }
  await replaceBatteryAllocations(sb, batteryId, [...rows, ...membership]);
  await invalidateWellProductionRates(sb);
  revalidateBatteryAllocation(batteryId, [
    ...rows.map((r) => r.wellId),
    ...orphans,
  ]);
}

/**
 * The member wells' WELL TESTS, newest first — the battery's read-only Well Tests
 * tab. Well tests are recorded on the WELL page (a test isolates one well and is a
 * record of that well, not of the battery); the battery only reads them, and its
 * allocation timeline pools their fracs. A plain array so it serializes across the
 * server-action boundary.
 */
export async function getBatteryWellTests(
  batteryId: string
): Promise<WellTest[]> {
  const sb = await getRequestSupabase();
  // The org's tests, read once per request and resolved through the batched
  // readers (`cachedWellTests`), cut to this battery's wells. The per-well
  // reader resolved volumes with its own reading and ticket queries, which
  // the series beside it had already issued.
  const [rows, all] = await Promise.all([
    cachedBatteryAllocationRows(sb, batteryId),
    cachedWellTests(sb),
  ]);
  const wellIds = new Set(rows.map((r) => r.wellId));
  return all
    .filter((t) => wellIds.has(t.wellId))
    .sort((a, b) => (a.startAt < b.startAt ? 1 : a.startAt > b.startAt ? -1 : 0));
}

/** Add one or more wells to a battery (0% split; the % is set afterward). */
export async function addBatteryWells(
  batteryId: string,
  wellIds: string[]
): Promise<void> {
  const sb = await getSupabaseServer();
  await addBatteryAllocationsForWells(sb, batteryId, wellIds);
  await invalidateWellProductionRates(sb);
  revalidateBatteryAllocation(batteryId, wellIds);
}

/** Set a single well's straight % on a battery (Wells tab inline edit). */
export async function setBatteryWellAllocation(
  batteryId: string,
  wellId: string,
  pct: number
): Promise<void> {
  const sb = await getSupabaseServer();
  await setBatteryAllocationPct(sb, batteryId, wellId, pct);
  await invalidateWellProductionRates(sb);
  revalidateBatteryAllocation(batteryId, [wellId]);
}

/** Remove a well from a battery (drop its split row; the well is untouched). */
export async function removeBatteryWell(
  batteryId: string,
  wellId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  await deleteBatteryAllocationForWell(sb, batteryId, wellId);
  await invalidateWellProductionRates(sb);
  revalidateBatteryAllocation(batteryId, [wellId]);
}

/** Revalidate the battery page + every affected well's production page. */
function revalidateBatteryAllocation(
  batteryId: string,
  wellIds: string[]
): void {
  revalidatePath("/production");
  revalidatePath("/production/batteries", "layout");
  for (const wellId of new Set(wellIds.filter(Boolean))) {
    revalidatePath(`/production/wells/${wellId}`);
  }
  // A battery's split decides which WELL every barrel of its oil belongs to, so
  // it moves every surface that reads per-well production — not just the ones
  // under /production. Leaving these out meant an operator fixed a split, saw
  // /production update, and read a stale dashboard beside it.
  revalidatePath("/dashboard");
  revalidatePath("/leases");
  revalidatePath("/facilities");
}
