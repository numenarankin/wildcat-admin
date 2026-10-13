"use server";

/**
 * Server actions for gas meters — the gas analogue of `@/lib/tanks/actions`.
 * Reads go through the request-scoped RLS client so every figure is org-scoped
 * (the `meters` / `meter_*` policies enforce it). Comment authorship and reading
 * audit stamps come from the signed-in user, mirroring the tank actions.
 */

import { revalidatePath } from "next/cache";
import { invalidateWellProductionRates } from "@/lib/wells/rate-cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { GasTestInput } from "@/lib/wells/well-test-cards";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { cachedMeters,
  cachedMeterReadings,
  cachedMeterAllocationRows,
  cachedMeterCampaigns,
} from "@/lib/cache/loaders";
import { uploadFiles, type UploadResult } from "@/lib/files/actions";
import { placeInOtherFacilities } from "@/lib/files/history-placement";
import { getOrCreateFacilityFolderId } from "@/lib/files/facility-folder";
import { getSessionUser } from "@/lib/auth/session";
import { getProfile } from "@/lib/settings/profile";
import {
  addMeterReading,
  createMeter,
  deleteMeter,
  getMeter,
  latestMcfByMeter,
  listMeterReadings,
  listMeters,
  listWellMeters,
  softDeleteMeterReading,
  updateMeter,
  updateMeterReading,
  type Meter,
  type MeterInput,
  type MeterPatch,
  type MeterReading,
  type MeterReadingInput,
} from "@/lib/meters/meters";
import {
  addMeterAllocationsForWells,
  deleteMeterAllocationForWell,
  listMeterAllocations,
  replaceMeterAllocations,
  resolveMeterTimeline,
  setMeterAllocationPct,
  type AllocationPeriod,
  type MeterAllocation,
  type MeterAllocationInput,
} from "@/lib/meters/allocations";
import {
  createGasCampaign,
  updateGasCampaign,
  publishGasCampaign,
  deleteGasCampaign,
  listMeterCampaigns,
  type GasCampaignInput,
  type GasTestCampaign,
} from "@/lib/meters/gas-campaigns";
import { gasWindowVolume } from "@/lib/meters/gas-series";
import {
  addMeterVolumeStatement,
  listMeterVolumeStatements,
  softDeleteMeterVolumeStatement,
  type VolumeStatement,
  type VolumeStatementInput,
} from "@/lib/meters/volume-statements";
import { bridgeAndDropConnections } from "@/lib/flow/connections";

function revalidateMeter(meterId: string): void {
  revalidatePath("/production");
  revalidatePath("/production/meters", "layout");
}

// --- Meters ----------------------------------------------------------------

/** All meters in the org. */
export async function getMeters(): Promise<Meter[]> {
  // `listMeters` defaults to gas; keep that and share the memo entry.
  return cachedMeters(await getRequestSupabase(), "gas");
}

/** Current MCF/day for every meter, keyed by meter id. */
export async function getMeterLevels(): Promise<Record<string, number>> {
  const sb = await getRequestSupabase();
  return latestMcfByMeter(sb);
}

/** A single meter by id, or null. */
export async function getMeterById(id: string): Promise<Meter | null> {
  const sb = await getRequestSupabase();
  return getMeter(sb, id);
}

/**
 * Create a meter. When a well is chosen (create form), seed a 100% allocation
 * row linking the meter to it — allocation rows are the sole source of a meter's
 * wells. Passing no well makes a shared/unassigned meter.
 */
export async function addMeter(
  input: MeterInput,
  /** The wells this meter measures, from the create form's own picker. One well
   *  owns it outright; several split it evenly, as a fleet import seeds it. */
  wellIds?: string[] | null
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await createMeter(sb, input);
  const ids = [...new Set((wellIds ?? []).filter(Boolean))];
  if (ids.length > 0) {
    await addMeterAllocationsForWells(
      sb,
      result.id,
      ids,
      Math.floor((100 / ids.length) * 100) / 100
    );
    await invalidateWellProductionRates(sb);
    for (const wellId of ids) revalidatePath(`/wells/${wellId}`);
  }
  revalidatePath("/production");
  return result;
}

/**
 * Put exactly these wells on a meter, and take off any other.
 *
 * The meter's own settings picker, so the connection can be made from either
 * end. Same share rule as a tank's: whole meter for the first well, 0% for one
 * joining wells already there.
 */
export async function setMeterWells(
  meterId: string,
  wellIds: string[]
): Promise<void> {
  const sb = await getSupabaseServer();
  const wanted = [...new Set(wellIds.filter(Boolean))];
  const existing = await listMeterAllocations(sb, meterId);
  const have = new Set(existing.map((a) => a.wellId));

  for (const wellId of existing.map((a) => a.wellId)) {
    if (!wanted.includes(wellId)) {
      await deleteMeterAllocationForWell(sb, meterId, wellId);
    }
  }
  const missing = wanted.filter((id) => !have.has(id));
  if (missing.length > 0) {
    const share =
      have.size === 0 ? Math.floor((100 / missing.length) * 100) / 100 : 0;
    await addMeterAllocationsForWells(sb, meterId, missing, share);
  }
  await invalidateWellProductionRates(sb);
  revalidatePath("/facilities");
  revalidateMeter(meterId);
}

/** Update a meter's fields. */
export async function editMeter(
  id: string,
  patch: MeterPatch,
  wellIds: string[] = []
): Promise<void> {
  const sb = await getSupabaseServer();
  await updateMeter(sb, id, patch);
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
  revalidateMeter(id);
}

/**
 * Delete a meter. Soft: it disappears from every page but its readings,
 * allocations, volume statements and comment thread stay behind it
 * (`deleteMeter`). Revalidates the Production page and every well the meter was
 * allocated to.
 */
export async function removeMeter(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const allocations = await listMeterAllocations(sb, id);
  await deleteMeter(sb, id);
  // A -> meter -> C leaves A -> C (`bridgeAndDropConnections`).
  await bridgeAndDropConnections(sb, { type: "meter", id });
  revalidatePath("/production");
  revalidatePath("/facilities");
  for (const wellId of new Set(allocations.map((a) => a.wellId))) {
    revalidatePath(`/wells/${wellId}`);
  }
}

// --- Readings --------------------------------------------------------------

/** List a meter's readings, oldest first. */
export async function getMeterReadings(
  meterId: string
): Promise<MeterReading[]> {
  const sb = await getRequestSupabase();
  // Through the batched loader: the meter page also derives the daily series
  // from these rows in the same request, and this shares that one read.
  return cachedMeterReadings(sb, meterId);
}

/**
 * A reading has to carry at least one of the meter's three numbers. All three
 * blank is an empty row: it pins a timestamp on the meter, contributes nothing to
 * the series, and silently ends whatever span it lands in the middle of.
 *
 * Enforced here rather than as a database constraint so the rows written before
 * `cumulative_mcf` and `yesterday_mcf` existed stay valid.
 */
function assertHasAReading(reading: MeterReadingInput): void {
  if (
    reading.mcf == null &&
    reading.cumulativeMcf == null &&
    reading.yesterdayMcf == null
  ) {
    throw new Error(
      "Enter at least one of the meter's three numbers: yesterday's volume, the current flow rate, or the cumulative counter."
    );
  }
}

/** Record a reading on a meter: any of the three numbers on the meter face. */
export async function recordMeterReading(
  meterId: string,
  reading: MeterReadingInput,
  wellIds: string[] = []
): Promise<{ id: string }> {
  assertHasAReading(reading);
  const sb = await getSupabaseServer();
  const result = await addMeterReading(sb, meterId, reading);
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
  revalidateMeter(meterId);
  return result;
}

/** Correct a reading (stamps the audit `updated_by`). */
export async function editMeterReading(
  meterId: string,
  id: string,
  reading: MeterReadingInput,
  wellIds: string[] = []
): Promise<void> {
  assertHasAReading(reading);
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  await updateMeterReading(sb, meterId, id, {
    ...reading,
    updatedBy: user?.id ?? null,
  });
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
  revalidateMeter(meterId);
}

/** Soft-delete a reading (stamps `deleted_by`). */
export async function removeMeterReading(
  meterId: string,
  id: string,
  wellIds: string[] = []
): Promise<void> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  await softDeleteMeterReading(sb, meterId, id, user?.id ?? null);
  for (const wellId of wellIds) revalidatePath(`/wells/${wellId}`);
  revalidateMeter(meterId);
}

/**
 * "Add History" for a meter — the gas analogue of `uploadTankHistory`. Upload a
 * document (scanned gas charts / daily MCF logs), let the shared ingest pipeline
 * parse it, and hand back proposals for the user to preview + approve. Scoped to
 * THIS meter: every meterReadings row is pinned to `meterId`, so the write lands
 * here and never resolves by name or auto-creates a meter. Nothing is written
 * until the user approves in the ingest modal.
 */
export async function uploadMeterHistory(
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

  // File the document in THIS METER's folder (`Meters / <meter>` on the Files
  // page and the meter's Files tab), not under its first allocated well: a
  // meter's chart history belongs to the meter.
  const folderId = await getOrCreateFacilityFolderId(sb, "meter", meterId);

  const result = await uploadFiles(folderId, formData, {
    // Pin every meterReadings row to THIS meter's id: the write lands here and
    // never resolves by name or auto-creates a meter. meterRef stays for the
    // approval grid's display.
    meterId,
    meterRef: meterRef || null,
    defaultWellId: wellIds.length === 1 ? wellIds[0] : null,
  });
  await placeInOtherFacilities(sb, result, "meter", meterId);
  return result;
}

// --- Allocation config -----------------------------------------------------

/**
 * A meter's RESOLVED allocation timeline (manual periods ∪ gas-campaign-derived
 * periods, chained) plus its raw manual split rows. The timeline drives the
 * Allocation panel; the raw rows drive the Wells tab (membership + inline %).
 */
export async function getMeterAllocationConfig(
  meterId: string
): Promise<{ periods: AllocationPeriod[]; allocations: MeterAllocation[] }> {
  const sb = await getRequestSupabase();
  // Rows and campaigns read ONCE (the cached loaders) and handed to the
  // timeline, which otherwise reads both again itself; the campaigns are the
  // same rows `getMeterCampaigns` returns for the page's other tab.
  const [allocations, campaigns] = await Promise.all([
    cachedMeterAllocationRows(sb, meterId),
    cachedMeterCampaigns(sb, meterId),
  ]);
  const periods = await resolveMeterTimeline(sb, meterId, { rows: allocations, campaigns });
  return { periods, allocations };
}

/**
 * Save the meter's MANUAL allocation periods (the Allocation panel's Save). Only
 * manual rows are written; well-test periods live as gas campaigns and are derived
 * on read. Membership is preserved: a member well absent from the manual payload
 * keeps a 0% row so its campaigns still resolve into the timeline (mirrors the
 * battery). Revalidates the meter page + each well.
 */
export async function saveMeterAllocationConfig(
  meterId: string,
  rows: MeterAllocationInput[]
): Promise<void> {
  const sb = await getSupabaseServer();
  const existing = await listMeterAllocations(sb, meterId);
  const inPayload = new Set(rows.filter((r) => r.wellId).map((r) => r.wellId));
  const orphans = [...new Set(existing.map((r) => r.wellId))].filter(
    (w) => !inPayload.has(w)
  );
  const membership: MeterAllocationInput[] = orphans.map((wellId) => ({
    wellId,
    straightPct: 0,
    effectiveTo: null,
  }));
  await replaceMeterAllocations(sb, meterId, [...rows, ...membership]);
  await invalidateWellProductionRates(sb);
  revalidateMeter(meterId);
  for (const wellId of new Set(
    [...rows.map((r) => r.wellId), ...orphans].filter(Boolean)
  )) {
    revalidatePath(`/wells/${wellId}`);
  }
}

// --- Gas well-test campaigns -----------------------------------------------

/**
 * What the meter measured over each of a campaign's windows, MCF/day, or null
 * where its counter does not bracket the window.
 *
 * The rate is no longer typed: a shut-in test is a window and the well that was
 * off, and the drop is read off the meter's own readings. The entry form asks
 * for this so it can preview the split it is about to derive, and so a window
 * the meter cannot measure is refused at entry rather than saved as a zero that
 * reads later as a meter making nothing.
 */
export async function getMeterWindowRates(
  meterId: string,
  windows: { startAt: string; endAt: string }[]
): Promise<(number | null)[]> {
  if (windows.length === 0) return [];
  const sb = await getRequestSupabase();
  const readings = await listMeterReadings(sb, meterId);
  const gas = readings.map((r) => ({
    date: r.date,
    time: r.time,
    mcf: r.mcf,
    cumulativeMcf: r.cumulativeMcf,
  }));
  return windows.map((w) => {
    const fromMs = Date.parse(w.startAt);
    const toMs = Date.parse(w.endAt);
    const days = (toMs - fromMs) / 86_400_000;
    if (!Number.isFinite(days) || days <= 0) return null;
    const mcf = gasWindowVolume(gas, fromMs, toMs);
    return mcf == null ? null : mcf / days;
  });
}

/** A meter's gas campaigns (with measurements), newest first — a plain array so
 * it serializes across the server-action boundary. */
export async function getMeterCampaigns(
  meterId: string
): Promise<GasTestCampaign[]> {
  const sb = await getRequestSupabase();
  return cachedMeterCampaigns(sb, meterId);
}

/**
 * Create a gas well-test campaign on a meter (baseline + shut-in measurements).
 * Its derived allocation period appears on the timeline on refresh. Revalidates
 * the meter page + each member well.
 */
export async function createMeterGasCampaign(
  meterId: string,
  input: GasCampaignInput
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await createGasCampaign(sb, meterId, input);
  revalidateMeter(meterId);
  for (const wellId of new Set(input.shutIns.map((s) => s.wellId).filter(Boolean))) {
    revalidatePath(`/wells/${wellId}`);
  }
  return result;
}

/** Replace a draft campaign's measurements/notes (editing a saved draft). Stays a
 * draft until published. */
export async function updateMeterGasCampaign(
  meterId: string,
  campaignId: string,
  input: GasCampaignInput
): Promise<void> {
  const sb = await getSupabaseServer();
  await updateGasCampaign(sb, campaignId, input);
  revalidateMeter(meterId);
  for (const wellId of new Set(input.shutIns.map((s) => s.wellId).filter(Boolean))) {
    revalidatePath(`/wells/${wellId}`);
  }
}

/** Publish a gas campaign — make its derived allocation period operative. */
export async function publishMeterGasCampaign(
  meterId: string,
  campaignId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  await publishGasCampaign(sb, campaignId);
  const allocations = await listMeterAllocations(sb, meterId);
  revalidateMeter(meterId);
  for (const wellId of new Set(allocations.map((a) => a.wellId).filter(Boolean))) {
    revalidatePath(`/wells/${wellId}`);
  }
}

/** Delete a gas campaign (its derived period drops on refresh). */
export async function deleteMeterGasCampaign(
  meterId: string,
  campaignId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  await deleteGasCampaign(sb, campaignId);
  revalidateMeter(meterId);
}

/**
 * Add one or more wells to a meter (the Wells tab "Add Well" action) — inserts a
 * split row per well at 0% (the operator balances the split in the Allocation
 * panel). Revalidates the meter page and each affected well.
 */
export async function addMeterWells(
  meterId: string,
  wellIds: string[]
): Promise<void> {
  const sb = await getSupabaseServer();
  await addMeterAllocationsForWells(sb, meterId, wellIds);
  await invalidateWellProductionRates(sb);
  revalidateMeter(meterId);
  for (const wellId of new Set(wellIds.filter(Boolean))) {
    revalidatePath(`/wells/${wellId}`);
  }
}

/**
 * Set a single well's allocation % on a meter — the Wells tab's inline edit.
 * Upserts just that well's split row (no sum-to-100 enforcement; the per-row
 * 0–100 bound holds). Revalidates the meter page and the affected well.
 */
export async function setMeterWellAllocation(
  meterId: string,
  wellId: string,
  straightPct: number
): Promise<void> {
  const sb = await getSupabaseServer();
  await setMeterAllocationPct(sb, meterId, wellId, straightPct);
  await invalidateWellProductionRates(sb);
  revalidateMeter(meterId);
  revalidatePath(`/wells/${wellId}`);
}

/**
 * Remove a well from a meter (the Wells tab action) — deletes the well's
 * allocation split row. The well itself is never deleted. Revalidates the meter
 * page and the affected well.
 */
export async function removeMeterWell(
  meterId: string,
  wellId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  // The meter's wells before the delete: the leaver and its siblings, whose
  // shares of the meter change. Clearing every well's rate (what this did)
  // made the next render of every page cold.
  const allocations = await listMeterAllocations(sb, meterId);
  const affected = [...new Set([wellId, ...allocations.map((a) => a.wellId)])];
  await deleteMeterAllocationForWell(sb, meterId, wellId);
  await invalidateWellProductionRates(sb, affected);
  revalidateMeter(meterId);
  revalidatePath("/facilities");
  revalidatePath(`/wells/${wellId}`);
}

// Meter comments are read with `getComments("meter", id)` and posted with
// `addComment("meter", id, body)` from `@/lib/comments/actions`.

// --- Volume statements (documentation only) --------------------------------

/** A meter's volume statements, newest first. */
export async function getMeterVolumeStatements(
  meterId: string
): Promise<VolumeStatement[]> {
  const sb = await getRequestSupabase();
  return listMeterVolumeStatements(sb, meterId);
}

/** Record a volume statement on a meter. */
export async function addMeterVolumeStatementAction(
  meterId: string,
  input: VolumeStatementInput
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await addMeterVolumeStatement(sb, meterId, input);
  revalidateMeter(meterId);
  return result;
}

/** Soft-delete a volume statement. */
export async function removeMeterVolumeStatement(
  meterId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  await softDeleteMeterVolumeStatement(sb, meterId, id, user?.id ?? null);
  revalidateMeter(meterId);
}

// --- Gas testing from the WELL page ----------------------------------------

/** A gas meter this well feeds, with the state of its open (draft) campaign. */
export interface WellGasTestTarget {
  meterId: string;
  meterName: string;
  /** The meter's newest UNPUBLISHED campaign, or null when none is open. */
  openCampaignId: string | null;
  /** That campaign's baseline rate (all wells online), MCF/day, or null. */
  baselineRate: number | null;
  /** Wells already shut in on that campaign — this well may be among them. */
  shutInWellIds: string[];
}

/**
 * This well's GAS tests, for the well page's card grid.
 *
 * A gas test is not a row of its own: it is this well's shut-in measurement
 * inside a meter's campaign, and it only means anything beside that campaign's
 * baseline (`baseline − shutIn` is the well's gas). So both travel together, and
 * a campaign with no baseline yet yields a card that says so rather than one
 * quoting the shut-in reading as production.
 */
export async function getWellGasTests(
  wellId: string
): Promise<GasTestInput[]> {
  const sb = await getRequestSupabase();
  const meters = await listWellMeters(sb, wellId, "gas");
  const out: GasTestInput[] = [];
  for (const m of meters) {
    for (const campaign of await listMeterCampaigns(sb, m.id)) {
      const baseline = campaign.measurements.find((x) => x.role === "baseline");
      for (const x of campaign.measurements) {
        if (x.role !== "shutin" || x.shutInWellId !== wellId) continue;
        out.push({
          id: x.id,
          startAt: x.startAt,
          endAt: x.endAt,
          meterName: m.name,
          shutInMcfPerDay: x.mcfPerDay,
          baselineMcfPerDay: baseline?.mcfPerDay ?? null,
          published: campaign.publishedAt != null,
        });
      }
    }
  }
  return out;
}

/**
 * The gas meters this well feeds and each one's open campaign — what the well
 * page's gas-test action needs.
 *
 * Gas testing is unchanged: a meter reads ONE commingled total, so a well's share
 * is inferred from the DROP when it alone is shut in, against a single all-wells-
 * online baseline. That baseline is a property of the meter, not of any one well,
 * so it (and Publish) stay on the meter page; the well page only contributes this
 * well's shut-in reading to the campaign that's already open.
 */
export async function getWellGasTestTargets(
  wellId: string
): Promise<WellGasTestTarget[]> {
  const sb = await getRequestSupabase();
  const meters = await listWellMeters(sb, wellId, "gas");
  return Promise.all(
    meters.map(async (m) => {
      const campaigns = await listMeterCampaigns(sb, m.id);
      const open = campaigns.find((c) => c.publishedAt == null) ?? null;
      const baseline = open?.measurements.find((x) => x.role === "baseline");
      return {
        meterId: m.id,
        meterName: m.name,
        openCampaignId: open?.id ?? null,
        baselineRate: baseline?.mcfPerDay ?? null,
        shutInWellIds: (open?.measurements ?? [])
          .filter((x) => x.role === "shutin" && x.shutInWellId)
          .map((x) => x.shutInWellId as string),
      };
    })
  );
}

/**
 * Record THIS well's shut-in reading on a meter's open gas campaign — the well
 * page's gas test. Replaces the well's existing shut-in on that campaign if it was
 * already tested, so a re-read corrects rather than duplicates. The campaign stays
 * a draft; publishing it (and the baseline) remain on the meter page.
 */
export async function recordWellGasShutIn(
  wellId: string,
  meterId: string,
  campaignId: string,
  measurement: { startAt: string; endAt: string; mcfPerDay: number },
  /**
   * The all-wells-online rate, when the pumper set or corrected it here.
   *
   * The baseline is a property of the METER and is normally recorded on the
   * meter's page over its own window, which is why it is not a field of this
   * measurement. But a well's drop is meaningless against a wrong baseline, and
   * the person standing at the meter is the one who knows — so it can be typed
   * from here. An existing baseline keeps its window and only its rate moves; a
   * campaign that has none takes this window, which is the only one we have.
   */
  baselineMcfPerDay?: number | null
): Promise<void> {
  const sb = await getSupabaseServer();
  const campaigns = await listMeterCampaigns(sb, meterId);
  const campaign = campaigns.find((c) => c.id === campaignId);
  if (!campaign) throw new Error("recordWellGasShutIn: campaign not found.");
  const existing = campaign.measurements.find((m) => m.role === "baseline");
  const baseline =
    baselineMcfPerDay != null && Number.isFinite(baselineMcfPerDay)
      ? {
          startAt: existing?.startAt ?? measurement.startAt,
          endAt: existing?.endAt ?? measurement.endAt,
          mcfPerDay: baselineMcfPerDay,
        }
      : existing;
  if (!baseline) {
    throw new Error(
      "This campaign has no baseline yet. Enter the all-wells-online rate, or record it on the meter page."
    );
  }

  const shutIns = campaign.measurements
    .filter((m) => m.role === "shutin" && m.shutInWellId && m.shutInWellId !== wellId)
    .map((m) => ({
      wellId: m.shutInWellId as string,
      startAt: m.startAt,
      endAt: m.endAt,
      mcfPerDay: m.mcfPerDay,
    }));
  shutIns.push({ wellId, ...measurement });

  await updateGasCampaign(sb, campaignId, {
    notes: campaign.notes,
    baseline: {
      startAt: baseline.startAt,
      endAt: baseline.endAt,
      mcfPerDay: baseline.mcfPerDay,
    },
    shutIns,
  });
  revalidateMeter(meterId);
  revalidatePath(`/wells/${wellId}`);
  revalidatePath(`/production/wells/${wellId}`);
}
