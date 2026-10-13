"use server";

import { revalidatePath } from "next/cache";
import { invalidateWellProductionRates } from "@/lib/wells/rate-cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import {
  deleteBatteryAllocationForWell,
  listBatteryAllocations,
  ensureBatteryMembership,
} from "@/lib/batteries/allocations";
import { cachedTanks } from "@/lib/cache/loaders";
import { uploadFiles, type UploadResult } from "@/lib/files/actions";
import { placeInOtherFacilities } from "@/lib/files/history-placement";
import { getOrCreateFacilityFolderId } from "@/lib/files/facility-folder";
import { validateTankHistory } from "@/lib/ai/ingest/tank-history";
import { getSessionUser } from "@/lib/auth/session";
import {
  addTankReading,
  createTank,
  deleteTank,
  getTank,
  latestBblsByTank,
  listTankReadings,
  listTanks,
  listWellTanks,
  softDeleteTankReading,
  updateTank,
  updateTankReading,
  wellCountsByTank,
  type Tank,
  type TankInput,
  type TankPatch,
  type TankProduct,
  type TankReading,
  type TankReadingInput,
} from "@/lib/tanks/tanks";
import {
  addTankAllocationsForWells,
  deleteTankAllocationForWell,
  getTankAllocationMethod,
  listTankAllocations,
  replaceTankAllocations,
  setTankAllocationMethod,
  setTankAllocationPct,
  type AllocationMethod,
  type TankAllocation,
  type TankAllocationInput,
} from "@/lib/tanks/allocations";
import { currentLevelBbls } from "@/lib/tanks/capacity";
import { methodShares } from "@/lib/tanks/engine";
import { nodeEffectiveWaterSplit } from "@/lib/flow/effective-water";
import { bridgeAndDropConnections } from "@/lib/flow/connections";

/**
 * Server actions for tanks and their readings — thin wrappers over the
 * `@/lib/tanks/tanks` data-access layer that run through the request-scoped RLS
 * client (org ownership is enforced by RLS) and revalidate the affected well.
 * The tank UI (GBC-2/4/5) calls these; the data-access layer stays client-
 * injectable for tests.
 */

/** List all tanks in the org. */
export async function getTanks(): Promise<Tank[]> {
  // Through the memo, so this and the roll-ups' `cachedTanks` are one query.
  return cachedTanks(await getRequestSupabase());
}

/** List the tanks attached to a well. */
export async function getWellTanks(wellId: string): Promise<Tank[]> {
  const sb = await getRequestSupabase();
  return listWellTanks(sb, wellId);
}

/** Current barrels on hand per tank id (latest reading), for the % full column. */
export async function getTankLevels(): Promise<Record<string, number>> {
  const sb = await getRequestSupabase();
  return latestBblsByTank(sb);
}

/** Count of wells allocated to each tank id, for the Production Wells column. */
export async function getTankWellCounts(): Promise<Record<string, number>> {
  const sb = await getRequestSupabase();
  return wellCountsByTank(sb);
}

/** Fetch a single tank by id, or null if it isn't visible to the caller. */
export async function getTankById(id: string): Promise<Tank | null> {
  const sb = await getRequestSupabase();
  return getTank(sb, id);
}

/**
 * Create a tank. When a well is chosen (create form), seed a 100% allocation row
 * linking the tank to it — allocation rows are the sole source of a tank's wells.
 * Passing no well makes a shared/unassigned tank; add wells later via the
 * Allocation panel.
 */
export async function addTank(
  input: TankInput,
  /**
   * The wells whose oil lands in this tank, from the create form's own picker.
   * One well owns it outright; several split it evenly, which is the seed the
   * fleet import uses too and the only split that needs no further decision.
   */
  wellIds?: string[] | null
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await createTank(sb, input);
  const ids = [...new Set((wellIds ?? []).filter(Boolean))];
  if (ids.length > 0) {
    await addTankAllocationsForWells(
      sb,
      result.id,
      ids,
      Math.floor((100 / ids.length) * 100) / 100
    );
    await invalidateWellProductionRates(sb);
    for (const wellId of ids) revalidatePath(`/wells/${wellId}`);
  }
  return result;
}

/**
 * Put exactly these wells on a tank, and take off any other.
 *
 * The settings form's own picker, so a connection can be made from the facility
 * being looked at rather than only from the other end of it. Shares are shares
 * OF THIS TANK: a first well takes the whole of it, and one joining a tank that
 * already has wells starts at 0% for the operator to split — inventing a share
 * would take volume off the wells already there.
 */
export async function setTankWells(
  tankId: string,
  wellIds: string[]
): Promise<void> {
  const sb = await getSupabaseServer();
  const wanted = [...new Set(wellIds.filter(Boolean))];
  const existing = await listTankAllocations(sb, tankId);
  const have = new Set(existing.map((a) => a.wellId));

  for (const wellId of existing.map((a) => a.wellId)) {
    if (!wanted.includes(wellId)) await removeWellFromOilTank(tankId, wellId);
  }
  const missing = wanted.filter((id) => !have.has(id));
  if (missing.length === 0) return;
  const share = have.size === 0 ? Math.floor((100 / missing.length) * 100) / 100 : 0;
  await addTankAllocationsForWells(sb, tankId, missing, share);
  const battery = await tankBatteryId2(sb, tankId);
  if (battery) {
    for (const wellId of missing) await ensureBatteryMembership(sb, battery, wellId);
  }
  await invalidateWellProductionRates(sb);
  revalidatePath("/facilities");
  revalidatePath("/production/tanks", "layout");
}

/** The battery a tank sits on, or null. */
async function tankBatteryId2(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  tankId: string
): Promise<string | null> {
  const { data, error } = await sb
    .from("tanks")
    .select("battery_id")
    .eq("id", tankId)
    .maybeSingle();
  if (error) throw new Error(`setTankWells (battery): ${error.message}`);
  return (data as { battery_id: string | null } | null)?.battery_id ?? null;
}

/** Update a tank's fields. */
export async function editTank(
  id: string,
  patch: TankPatch,
  wellIds: string[] = []
): Promise<void> {
  const sb = await getSupabaseServer();
  await updateTank(sb, id, patch);
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
}

/**
 * Delete a tank. Soft: the tank disappears from every page but its readings,
 * run tickets, allocations and comment thread stay behind it (`deleteTank`).
 * Revalidates the Production page and every well the tank was allocated to.
 */
export async function removeTank(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const allocations = await listTankAllocations(sb, id);
  await deleteTank(sb, id);
  // A -> tank -> C leaves A -> C (`bridgeAndDropConnections`).
  await bridgeAndDropConnections(sb, { type: "tank", id });
  revalidatePath("/production");
  revalidatePath("/facilities");
  for (const wellId of new Set(allocations.map((a) => a.wellId))) {
    revalidatePath(`/wells/${wellId}`);
  }
}

/** List a tank's readings, oldest first. */
export async function getTankReadings(tankId: string): Promise<TankReading[]> {
  const sb = await getRequestSupabase();
  return listTankReadings(sb, tankId);
}

// Tank comments are read with `getComments("tank", id)` and posted with
// `addComment("tank", id, body)` from `@/lib/comments/actions`.

/** Record a gauge reading on a tank. */
export async function recordTankReading(
  tankId: string,
  reading: TankReadingInput,
  wellIds: string[] = []
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await addTankReading(sb, tankId, reading);
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
  return result;
}

/** Correct a gauge reading (stamps the audit `updated_by`). */
export async function editTankReading(
  tankId: string,
  id: string,
  reading: TankReadingInput,
  wellIds: string[] = []
): Promise<void> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  await updateTankReading(sb, tankId, id, {
    ...reading,
    updatedBy: user?.id ?? null,
  });
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
}

/** Soft-delete a gauge reading (keeps the audit trail intact). */
export async function removeTankReading(
  tankId: string,
  id: string,
  wellIds: string[] = []
): Promise<void> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  await softDeleteTankReading(sb, tankId, id, user?.id ?? null);
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
}

// --- Add history (AI document ingest, scoped to this tank) ------------------

/**
 * "Add History": upload a document (scanned gauge sheets, run tickets, etc.) for
 * THIS tank, have the AI parse it, and return proposed additions for the user to
 * preview + approve. Reuses the shared ingest pipeline (`uploadFiles`), scoped to
 * the tank so tank-scoped rows (readings / run tickets) land here without the
 * user re-picking a tank, and any well-scoped rows (well tests) default to the
 * tank's sole well when it has exactly one. Nothing is written until the user
 * approves each proposal in the approval modal; per-type write capability is
 * re-checked at approval time.
 */
export async function uploadTankHistory(
  tankId: string,
  formData: FormData
): Promise<UploadResult> {
  const sb = await getSupabaseServer();
  const [tank, allocations] = await Promise.all([
    getTank(sb, tankId),
    listTankAllocations(sb, tankId),
  ]);
  const wellIds = [...new Set(allocations.map((a) => a.wellId).filter(Boolean))];
  const tankName = tank?.name ?? "";
  // The scope ref must carry the tank's NUMBER, not just its name: source files
  // label a tank by its number (e.g. sheet "OilTank48630148.06full"), and the
  // pinned-tank matcher (`refDenotesPinned`) keys on that number first. A
  // name-only ref has no digits, so it can never match a numerically-labeled
  // file and every row is dropped as "another tank". Include `tankNo` so the
  // number match fires; falls back to the name when the tank has no number.
  const pinnedTankRef =
    [tankName, tank?.tankNo].map((s) => s?.trim()).filter(Boolean).join(" ") ||
    null;

  // File the document in THIS TANK's folder (`Tanks / <tank>` on the Files
  // page and the tank's Files tab). It used to go under the first allocated
  // well, which put a tank's gauge history on one of its wells and nowhere on
  // the tank; a commingled tank's history belongs to the tank.
  const folderId = await getOrCreateFacilityFolderId(sb, "tank", tankId);

  const result = await uploadFiles(
    folderId,
    formData,
    {
      // Default every readings/run-ticket row to THIS tank, but honor a row that
      // the source clearly ties to a DIFFERENT existing tank (one file can hold
      // several tanks' sections). Never auto-creates a tank on this path. tankRef
      // carries the printed tank for the approval grid + that routing.
      tankId,
      tankRef: pinnedTankRef,
      defaultWellId: wellIds.length === 1 ? wellIds[0] : null,
    },
    // Dedicated tank-history validation loop: check/repair the extracted
    // readings + runs against the source before they become approval cards.
    (drafts, documentText) =>
      validateTankHistory(drafts, documentText, tankName)
  );
  await placeInOtherFacilities(sb, result, "tank", tankId);
  return result;
}

// --- Allocation config -----------------------------------------------------

/** The tank's allocation method plus its per-well split rows. */
export async function getTankAllocationConfig(
  tankId: string
): Promise<{ method: AllocationMethod; allocations: TankAllocation[] }> {
  const sb = await getRequestSupabase();
  const [method, allocations] = await Promise.all([
    getTankAllocationMethod(sb, tankId),
    listTankAllocations(sb, tankId),
  ]);
  return { method, allocations };
}

/**
 * Save a tank's allocation config: its method and the full set of split rows
 * (replace-all). Revalidates the tank page and every well it references.
 */
export async function saveTankAllocationConfig(
  tankId: string,
  method: AllocationMethod,
  rows: TankAllocationInput[]
): Promise<void> {
  const sb = await getSupabaseServer();
  await setTankAllocationMethod(sb, tankId, method);
  await replaceTankAllocations(sb, tankId, rows);
  await invalidateWellProductionRates(sb);
  revalidatePath("/production/tanks", "layout");
  for (const wellId of new Set(rows.map((r) => r.wellId).filter(Boolean))) {
    revalidatePath(`/wells/${wellId}`);
  }
}

/**
 * Add one or more wells to a tank (the Wells tab "Add Well" action) — inserts a
 * split row per well at 0% (the operator balances the split in the Allocation
 * panel). Revalidates the tank page and each affected well.
 */
export async function addTankWells(
  tankId: string,
  wellIds: string[]
): Promise<void> {
  const sb = await getSupabaseServer();
  await addTankAllocationsForWells(sb, tankId, wellIds);
  await invalidateWellProductionRates(sb);
  revalidatePath("/production/tanks", "layout");
  for (const wellId of new Set(wellIds.filter(Boolean))) {
    revalidatePath(`/wells/${wellId}`);
  }
}

/**
 * Set a single well's allocation % on a tank — the Wells tab's inline edit.
 * Upserts just that well's split row (no sum-to-100 enforcement; the per-row
 * 0–100 bound holds). Revalidates the tank page and the affected well.
 */
export async function setTankWellAllocation(
  tankId: string,
  wellId: string,
  straightPct: number
): Promise<void> {
  const sb = await getSupabaseServer();
  await setTankAllocationPct(sb, tankId, wellId, straightPct);
  await invalidateWellProductionRates(sb);
  revalidatePath("/production/tanks", "layout");
  revalidatePath(`/wells/${wellId}`);
}

/**
 * Remove a well from a tank (the Wells tab action) — deletes the well's
 * allocation split row. The well itself is never deleted. Revalidates the tank
 * page and the affected well.
 */
export async function removeTankWell(
  tankId: string,
  wellId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  // The tank's wells BEFORE the delete: the leaver's rate changes and so do
  // its siblings' shares. Nobody else's does, and clearing the whole cache
  // (what this did) made the next render of every page cold.
  const affected = await allocatedWells(sb, tankId, wellId);
  await deleteTankAllocationForWell(sb, tankId, wellId);
  await invalidateWellProductionRates(sb, affected);
  revalidatePath("/production/tanks", "layout");
  revalidatePath("/facilities");
  revalidatePath(`/wells/${wellId}`);
}

/** A tank's allocated wells plus one, deduplicated: the set a change to that
 *  tank's split can move. */
async function allocatedWells(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  tankId: string,
  wellId: string
): Promise<string[]> {
  const allocations = await listTankAllocations(sb, tankId);
  return [...new Set([wellId, ...allocations.map((a) => a.wellId)])];
}

/**
 * Unwire a well from an OIL tank — what "remove connection" on an oil edge of the
 * flow map has to do.
 *
 * Two links hold a well to an oil tank and they are not interchangeable: the
 * `tank_well_allocations` row (the strapping link, which decides the well's
 * bbl-per-inch) and its share of the tank's BATTERY, which is the only one the
 * oil engine reads. Dropping the tank row alone left the well allocated and still
 * producing, so the edge simply came back on the next load. This drops both.
 */
export async function removeWellFromOilTank(
  tankId: string,
  wellId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const [tank, tankWells] = await Promise.all([
    getTank(sb, tankId),
    allocatedWells(sb, tankId, wellId),
  ]);
  const batteryWells = tank?.batteryId
    ? (await listBatteryAllocations(sb, tank.batteryId)).map((a) => a.wellId)
    : [];
  await deleteTankAllocationForWell(sb, tankId, wellId);
  if (tank?.batteryId) {
    await deleteBatteryAllocationForWell(sb, tank.batteryId, wellId);
    revalidatePath("/production/batteries", "layout");
  }
  await invalidateWellProductionRates(sb, [...tankWells, ...batteryWells]);
  revalidatePath("/facilities");
  revalidatePath("/production/tanks", "layout");
  revalidatePath(`/production/wells/${wellId}`);
  revalidatePath(`/wells/${wellId}`);
}

// --- Well production tab: read-only tank-derived production -----------------

/** One of a well's tanks with its current derived contribution to that well. */
export interface WellTankProduction {
  tankId: string;
  tankName: string;
  product: TankProduct;
  /** Current barrels on hand in the tank (latest reading). */
  currentBbls: number;
  capacityBbls: number | null;
  /** This well's share of the tank today, 0–100 (single-well tank = 100). */
  sharePct: number;
  /** Barrels currently attributable to this well (share × current level). */
  derivedBbls: number;
}

/**
 * The tank-derived production for a well, shown **read-only** on the well's
 * production tab. This is a **current-stock snapshot** (barrels on hand × the
 * well's share today), distinct from GBC-2's period derivation
 * (`deriveWellProductionForPeriod`, which reconstructs Δ stock + dispositions
 * over a date range).
 *
 * A WATER tank's share is its EFFECTIVE water split (manual override, else the
 * wells' well-test water rates) — the same seam the water series, the allocation
 * card and water revenue read, so this snapshot can't disagree with them. An OIL
 * tank splits by its straight rows; a single-well tank with no split rows draws
 * 100% to its well.
 */
export async function getWellTankProduction(
  wellId: string,
  onDate?: string
): Promise<WellTankProduction[]> {
  const sb = await getRequestSupabase();
  const tanks = await listWellTanks(sb, wellId);
  if (tanks.length === 0) return [];
  const today = onDate ?? new Date().toISOString().slice(0, 10);

  return Promise.all(
    tanks.map(async (t) => {
      const [readings, allocations] = await Promise.all([
        listTankReadings(sb, t.id),
        listTankAllocations(sb, t.id),
      ]);
      const currentBbls = currentLevelBbls(readings);
      const share =
        t.product === "water"
          ? (await nodeEffectiveWaterSplit(sb, { type: "tank", id: t.id })).find(
              (sh) => sh.wellId === wellId
            )?.pct ?? 0
          : (methodShares("straight", allocations, today).get(wellId) ?? 0) * 100;
      return {
        tankId: t.id,
        tankName: t.name,
        product: t.product,
        currentBbls,
        capacityBbls: t.capacityBbls,
        sharePct: share,
        derivedBbls: (currentBbls * share) / 100,
      };
    })
  );
}
