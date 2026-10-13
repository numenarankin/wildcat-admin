"use server";

/**
 * Server actions for SWD (water) meters — the disposal-side analogue of the gas
 * meter actions. A water meter is a `meters` row with `substance = 'water'`; its
 * readings reuse `meter_readings` (the `mcf` column holds the cumulative barrels
 * index) and its well split lives on `flow_connections` (the same store water
 * well tests write to — see `@/lib/flow/node-water-allocation`). Everything is
 * request-scoped RLS. Writes revalidate the `/disposal` surface.
 */

import { getRequestSupabase } from "@/lib/supabase/request-client";
import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { uploadFiles, type UploadResult } from "@/lib/files/actions";
import { getOrCreateWellFolderId } from "@/lib/wells/well-folder";
import {
  createMeter,
  getMeter,
  listMeterReadings,
  listMeters,
  addMeterReading,
  updateMeterReading,
  softDeleteMeterReading,
  updateMeter,
  deleteMeter,
  type Meter,
  type MeterReading,
  type MeterPatch,
} from "@/lib/meters/meters";
import { listMeterAllocations } from "@/lib/meters/allocations";
import { saveNodeManualWaterSplit } from "@/lib/flow/node-water-allocation";

function revalidateSwdMeter(meterId: string): void {
  revalidatePath("/disposal");
  revalidatePath("/disposal/meters", "layout");
}

// --- Meters ----------------------------------------------------------------

/** All water/SWD meters in the org. */
export async function getWaterMeters(): Promise<Meter[]> {
  const sb = await getRequestSupabase();
  return listMeters(sb, "water");
}

/** A single water meter by id, or null (also returns gas meters if id matches —
 * the page checks `substance` and 404s a gas meter). */
export async function getWaterMeterById(id: string): Promise<Meter | null> {
  const sb = await getSupabaseServer();
  return getMeter(sb, id);
}

/**
 * Create a water/SWD meter. When a well is chosen, seed a 100% manual water split
 * on `flow_connections` (a `well -> meter` edge) so the meter's allocation lands in
 * the same store as well tests. `substance` is forced to water regardless of input.
 */
export async function addWaterMeter(
  // No `gathererId`: a gatherer buys and hauls away gas, and disposed saltwater
  // is injected and sold to nobody. The column exists on `meters` for the gas
  // side; nothing on the water side reads or writes it.
  input: { meterNo?: string },
  wellId?: string | null
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await createMeter(sb, { ...input, substance: "water" });
  if (wellId) {
    await saveNodeManualWaterSplit(sb, { type: "meter", id: result.id }, [
      { wellId, straightPct: 100 },
    ]);
  }
  revalidatePath("/disposal");
  return result;
}

/** Update a water meter's fields. */
export async function editWaterMeter(id: string, patch: MeterPatch): Promise<void> {
  const sb = await getSupabaseServer();
  await updateMeter(sb, id, patch);
  revalidateSwdMeter(id);
}

/** Delete a water meter (cascades readings/allocations). */
export async function removeWaterMeter(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  await deleteMeter(sb, id);
  revalidatePath("/disposal");
}

// --- Readings --------------------------------------------------------------

/**
 * A water meter reading as the UI supplies it: the cumulative barrels index,
 * plus the injection/casing pressures the pumper read at the disposal well this
 * meter feeds. The pressures live on the meter reading because the meter is the
 * disposal well's measurement (`well-series.ts`) — a gas meter carries its
 * separator/differential context the same way. Not exported: a "use server"
 * module may only export async functions.
 */
interface SwdMeterReadingInput {
  date: string;
  time?: string;
  /**
   * The meter's cumulative barrels index, or null when the visit produced no
   * volume — a reading of the wellhead pressures alone. The read side already
   * expects it: a row that measures no volume anchors no interval and blanks
   * neither the one before it nor the one after (`buildDisposalSegments`).
   */
  cumulativeBbls: number | null;
  injectionPressure?: number | null;
  casingPressure?: number | null;
}

/** Map the SWD input onto the shared meter-reading shape (`mcf` = bbl index). */
function toMeterReadingInput(reading: SwdMeterReadingInput) {
  return {
    date: reading.date,
    time: reading.time,
    mcf: reading.cumulativeBbls,
    injectionPressure: reading.injectionPressure ?? null,
    casingPressure: reading.casingPressure ?? null,
  };
}

/** A water meter's readings, oldest first (the `mcf` field is cumulative bbls). */
export async function getSwdMeterReadings(meterId: string): Promise<MeterReading[]> {
  const sb = await getSupabaseServer();
  return listMeterReadings(sb, meterId);
}

/** Record a cumulative barrels reading on a water meter. */
export async function recordSwdMeterReading(
  meterId: string,
  reading: SwdMeterReadingInput
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await addMeterReading(sb, meterId, toMeterReadingInput(reading));
  revalidateSwdMeter(meterId);
  return result;
}

/**
 * "Add History" for a water meter — the exact analogue of `uploadMeterHistory`
 * (gas). Upload a document (scanned meter logs), let the shared ingest pipeline
 * parse it, and hand back proposals for the user to preview + approve in the
 * IngestApprovalModal. Scoped to THIS meter: every meterReadings row is pinned to
 * `meterId`, so the write lands here (into `meter_readings`, the same column the
 * manual cumulative-index reading uses) and never resolves by name or auto-creates
 * a meter. Nothing is written until the user approves.
 */
export async function uploadWaterMeterHistory(
  meterId: string,
  formData: FormData
): Promise<UploadResult> {
  const sb = await getSupabaseServer();
  const [meter, allocations] = await Promise.all([
    getMeter(sb, meterId),
    listMeterAllocations(sb, meterId),
  ]);
  const wellIds = [...new Set(allocations.map((a) => a.wellId).filter(Boolean))];
  const meterRef = meter?.meterNo || meter?.name || "";

  // File the document under the meter's well (the `Wells/<wellId>` folder the
  // Files page uses), not the Files root. A commingled meter files under its
  // first allocated well; an unallocated meter falls back to root.
  let folderId = "root";
  if (wellIds.length > 0) {
    try {
      folderId = await getOrCreateWellFolderId(sb, wellIds[0]);
    } catch (err) {
      console.error("uploadWaterMeterHistory: well folder unavailable, using root", err);
    }
  }

  return uploadFiles(folderId, formData, {
    // Pin every meterReadings row to THIS meter's id: the write lands here and
    // never resolves by name or auto-creates a meter. meterRef stays for display.
    meterId,
    meterRef: meterRef || null,
    defaultWellId: wellIds.length === 1 ? wellIds[0] : null,
  });
}

/** Correct a water meter reading (cumulative barrels index). */
export async function editSwdMeterReading(
  meterId: string,
  readingId: string,
  reading: SwdMeterReadingInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  await updateMeterReading(sb, meterId, readingId, {
    ...toMeterReadingInput(reading),
    updatedBy: user?.id ?? null,
  });
  revalidateSwdMeter(meterId);
}

/** Void a water meter reading (soft delete). */
export async function removeSwdMeterReading(
  meterId: string,
  readingId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  await softDeleteMeterReading(sb, meterId, readingId);
  revalidateSwdMeter(meterId);
}

// Well allocation for a water meter now lives on `flow_connections` (the same
// store water well tests write to), not `meter_well_allocations`. See
// `@/lib/flow/node-water-allocation` + `getNodeWaterAllocationAction` /
// `saveNodeManualWaterSplitAction` in `@/lib/flow/water-test-actions`.
