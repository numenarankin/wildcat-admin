"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { gateAI, meterAnthropic } from "@/lib/billing/credits";
import { SCAN_MODEL_ID, scanModel, scanProviderOptions } from "@/lib/ai/scan-model";
import { readingSlot, sameValue } from "@/lib/readings/merge";
import { revalidateFiles } from "@/lib/files/revalidate";
import { removeFileFromFolder } from "@/lib/files/actions";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { embedFile } from "@/lib/ai/retrieval";
import { deriveMainLog, isMainLogName } from "@/lib/kb/mainlog-derive";
import {
  FORMATION_COLS,
  getWellProduction,
  mapFormation,
  mapShotRow,
  mapPumpingRow,
  SHOT_COLS,
  PUMPING_COLS,
  wellUpdateRow,
} from "@/lib/wells/wells";
import {
  getWellOilRatio,
  setWellOilRatio,
  setWellTanks,
} from "@/lib/tanks/tanks";
import { setWellMeters } from "@/lib/meters/meters";
import { invalidateWellProductionRates } from "@/lib/wells/rate-cache";
import { getOrCreateWellFolderId } from "@/lib/wells/well-folder";
import {
  ensureFacilityFolder,
  moveFacilityFolder,
  renameFacilityFolder,
} from "@/lib/files/facility-folder";
import { resolveHygiene } from "@/lib/files/hygiene";
import { deleteCommentsFor } from "@/lib/comments/comments";
import { buildDocumentPart, UnsupportedFileError } from "@/lib/ai/document-part";
import { parseTable } from "@/lib/ai/ingest/structured/table";
import {
  computeIngestProposals,
  insertIngestProposals,
  type ProposalDraft,
} from "@/lib/ai/ingest/scan";
import {
  INGEST_TYPE_META,
  type IngestScanStatus,
} from "@/lib/ai/ingest/types";
import type { IngestProposal } from "@/lib/ai/ingest/actions";
import type { ExtractedInvoice } from "@/lib/invoices/extract";
import type { InvoiceReviewDocument } from "@/lib/invoices/review";
import { assertWellCapacity, syncWellQuantity } from "@/lib/billing/subscription";
import type {
  EquipmentField,
  ProductionPoint,
  ProductionWritePoint,
  PumpingField,
  ServiceField,
  ShotField,
  WellEquipment,
  WellFile,
  WellFormation,
  WellInput,
  WellPumping,
  WellService,
  WellShot,
} from "@/lib/wells/wells";
import type { KBFileType } from "@/lib/kb/types";
import { bridgeAndDropConnections } from "@/lib/flow/connections";

const FILES_BUCKET = "files";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"];

/** Map a filename's extension to one of the allowed file types. */
function fileType(name: string): KBFileType {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "md";
  if (IMAGE_EXTS.includes(ext)) return "image";
  return "doc";
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "well"
  );
}

// Well rows are shaped by `wellUpdateRow` (in wells.ts, unit-tested there). The
// oil strapping factor is not part of that row — it lives on the well's default
// tank and is routed through `setWellOilRatio` on create/update below.

/** Postgres `unique_violation` — here, always a `wells_pkey` slug collision. */
const UNIQUE_VIOLATION = "23505";

/** Give up rather than hammer the DB if a slug is pathologically contended. */
const MAX_SLUG_ATTEMPTS = 25;

/**
 * Create a well with a unique slug id; returns the new id.
 *
 * `wells.id` is a GLOBAL text primary key — it predates multi-tenancy
 * (`20260614000400_wells.sql` created the table one day before
 * `20260615001100_org_rls.sql` bolted `org_id` onto everything), so the slug
 * namespace is shared by every org while the rest of the row is org-scoped.
 *
 * That makes the duplicate lookup below advisory, never authoritative: it runs
 * through the RLS-scoped client, so it sees only wells this caller may read. A
 * well holding the same slug in ANOTHER org — or in this org but behind a
 * capability the caller lacks (`wells_write` needs `add_wells`, `wells_read`
 * needs production/lease access, so write-without-read is reachable) — is
 * invisible to the check yet still occupies the id. The pre-check therefore only
 * spares us doomed round-trips on the common case; the unique violation is what
 * actually decides, so we advance the suffix against it and retry. That also
 * closes the check-then-insert race between two concurrent creates, which could
 * previously fail the same way with no second org involved.
 *
 * Two orgs can hold wells of the same NAME either way — `wells.name` is not
 * constrained, and it is what the UI renders. Only the URL slug disambiguates.
 */
export async function createWell(input: WellInput): Promise<{ id: string }> {
  const sb = await getSupabaseServer();

  /*
   * Enforce the subscription's well cap before creating (throws on overage).
   *
   * Only for a well being created ACTIVE. `countBillableWells` bills wells that
   * are not switched off, so a well entered as inactive or plugged — an operator
   * recording a hole they already own, which the new-well form now offers — adds
   * nothing to the bill and cannot cross a band. Refusing it would refuse a row
   * we will never charge for. Switching it on later runs the same cap check in
   * `updateWell` (see its `active` guard), so nothing is billed unguarded.
   */
  if (input.active !== false) await assertWellCapacity(sb);

  const base = slugify(input.name);
  const { data: existing, error: lookupError } = await sb
    .from("wells")
    .select("id")
    .like("id", `${base}%`);
  if (lookupError) throw new Error(`createWell: ${lookupError.message}`);

  const taken = new Set((existing ?? []).map((r) => r.id));
  const row = wellUpdateRow(input);

  let id = "";
  for (let n = 1; n <= MAX_SLUG_ATTEMPTS; n++) {
    // Matches the historical numbering: `smith-1`, `smith-1-2`, `smith-1-3`, …
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (taken.has(candidate)) continue;

    const { error } = await sb.from("wells").insert({ id: candidate, ...row });
    if (!error) {
      id = candidate;
      break;
    }
    // Anything other than a slug collision is a real failure — surface it.
    if (error.code !== UNIQUE_VIOLATION) {
      throw new Error(`createWell: ${error.message}`);
    }
    // The slug is held by a row we cannot see, or a concurrent create just took
    // it. Either way it is spoken for; try the next suffix.
    taken.add(candidate);
  }

  if (!id) {
    throw new Error(
      `createWell: could not find a free id for "${input.name}" after ${MAX_SLUG_ATTEMPTS} attempts`
    );
  }

  /*
   * The tanks and meters the create form picked. These were only ever written by
   * `updateWell`, so a well created with tanks chosen came out attached to none
   * of them — and the facilities lab's sandbox DID wire them
   * (`facility-sandbox.ts#createWell`), so the harness and the real action
   * disagreed about the one thing the harness exists to show.
   *
   * Before the oil-ratio seed below, deliberately: that seed makes a placeholder
   * oil tank for a well that has none, and running it first would leave the
   * placeholder behind the moment a real tank was chosen.
   */
  const newWellDisposal = input.type === "injection";
  if (input.oilTankIds?.length) {
    await setWellTanks(sb, id, input.oilTankIds, newWellDisposal ? "water" : "oil");
  }
  if (!newWellDisposal && input.waterTankIds?.length) {
    await setWellTanks(sb, id, input.waterTankIds, "water");
  }
  if (input.meterIds?.length) {
    await setWellMeters(sb, id, input.meterIds, newWellDisposal ? "water" : "gas");
  }

  // Seed the well's default oil tank carrying its strapping factor (defaults to
  // 1). Every well gets one so oil readings convert at the tank level.
  await setWellOilRatio(sb, id, input.oilBblPerInch ?? 1);

  // The well's folder in the file tree, so its Files tab has somewhere to put
  // things before anyone uploads. Files under Wells / Production or
  // Wells / Disposal per its type.
  await ensureFacilityFolder(sb, "well", id, input.name, input.type ?? "producer");

  // Adding a well raises the billed quantity; sync it (best-effort, no-op unless
  // paid mode + a Stripe subscription exist). Never blocks the write.
  const { data: orgId } = await sb.rpc("current_org_id");
  if (orgId) await syncWellQuantity(orgId as string);

  revalidatePath("/production");
  return { id };
}

/** Update a well's editable info. */
export async function updateWell(id: string, input: WellInput): Promise<void> {
  const sb = await getSupabaseServer();
  // Restoring a retired well is a billable well appearing, so it passes the same
  // cap as a create (docs/plans/billing-test-suite.md §The rule). Only when the
  // well is actually coming back: a plain edit that resends `active: true` on a
  // well that is already active would otherwise count itself against the cap.
  if (input.active === true) {
    const { data: current } = await sb
      .from("wells")
      .select("active")
      .eq("id", id)
      .maybeSingle<{ active: boolean | null }>();
    if (current?.active === false) await assertWellCapacity(sb);
  }
  const { error } = await sb.from("wells").update(wellUpdateRow(input)).eq("id", id);
  if (error) throw new Error(`updateWell: ${error.message}`);
  await renameFacilityFolder(sb, "well", id, input.name);
  // Reclassifying producer ↔ injection moves the folder between Production and
  // Disposal. Guarded the same way `wellUpdateRow` guards the column itself, so
  // a plain edit never moves it.
  if (input.type !== undefined) {
    await moveFacilityFolder(sb, "well", id, input.type);
  }

  // Well settings now reassigns the well's oil tank (the dropdown) instead of
  // editing a raw ratio; the tank's own bbl/in drives conversion. Fall back to
  // the ratio path for callers that still send it (e.g. the AI update tool).
  // A disposal well's facilities are its saltwater tank and water meter; a
  // producer's are its oil tanks and gas sales meters. The form sends the ids;
  // which side they belong to follows from the well.
  const disposal = input.type === "injection";
  if (input.meterIds !== undefined) {
    await setWellMeters(sb, id, input.meterIds, disposal ? "water" : "gas");
  }
  // A producer's saltwater tanks are the other product on the same table, so
  // they are their own field: `oilTankIds` follows the well's type and on a
  // producer can only mean oil.
  if (!disposal && input.waterTankIds !== undefined) {
    await setWellTanks(sb, id, input.waterTankIds, "water");
  }
  if (input.oilTankIds !== undefined) {
    await setWellTanks(sb, id, input.oilTankIds, disposal ? "water" : "oil");
    // Reassigning the oil tank moves which series feeds this well, so its cached
    // rate (and its old tank-mates' shares) no longer describe anything.
    await invalidateWellProductionRates(sb);
  } else if (input.oilBblPerInch != null) {
    await setWellOilRatio(sb, id, input.oilBblPerInch);
    await invalidateWellProductionRates(sb);
  }

  // Retiring or restoring a well moves the billed quantity, so sync it the way
  // create and delete do. Guarded on `active` being SENT at all — the same guard
  // `wellUpdateRow` puts on the column — so an ordinary well edit costs no
  // Stripe round trip. Best-effort inside `syncWellQuantity`: never fails the
  // write that triggered it.
  if (input.active !== undefined) {
    const { data: orgId } = await sb.rpc("current_org_id");
    if (orgId) await syncWellQuantity(orgId as string);
  }

  revalidatePath(`/wells/${id}`);
  revalidatePath("/production");
}

/**
 * Delete a well — a SOFT delete (2026081800200_facility_soft_delete.sql): the
 * row is stamped `deleted_at` and the RLS policies stop returning it, taking
 * the well off every page without cascading away its production, tests, files,
 * equipment and ledger history. A deleted well is no longer counted, so the
 * subscription quantity is re-synced (best-effort).
 *
 * Its comment thread is left alone too — a polymorphic key that nothing
 * cascades, and the thread is part of what a restore would want back.
 */
export async function deleteWell(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  // Through the RPC, never a bare update: see `deleteTank`.
  const { error } = await sb.rpc("soft_delete_facility", {
    p_kind: "well",
    p_id: id,
  });
  if (error) throw new Error(`deleteWell: ${error.message}`);
  // The lines that ran through it are rejoined around it: A -> well -> C leaves
  // A -> C, because the stream did not stop, the facility did.
  await bridgeAndDropConnections(sb, { type: "well", id });

  const { data: orgId } = await sb.rpc("current_org_id");
  if (orgId) await syncWellQuantity(orgId as string);

  revalidatePath("/production");
  revalidatePath("/facilities");
}

/**
 * Barrels of oil per gauge inch for a well (defaults to 1 / no conversion).
 * Oil readings are entered as gauge inches and converted to barrels at write
 * time, so the stored value is barrels and reads need no further conversion.
 * The factor now lives on the well's default oil tank (`getWellOilRatio`).
 */
async function wellOilRatio(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  wellId: string
): Promise<number> {
  return getWellOilRatio(sb, wellId);
}

/**
 * Shared column mapping for a production reading. Oil fields arrive as gauge
 * inches and are converted to barrels here (× the well's bbl-per-inch ratio).
 */
function productionRow(point: ProductionPoint, ratio: number) {
  return {
    reading_date: point.date,
    reading_time: point.time || null,
    oil_production: point.oilProduction * ratio,
    oil_stock: point.oilStock * ratio,
    oil_sales: point.oilSales * ratio,
    gas_production: point.gasProduction,
    salt_water: point.saltWater,
    // Richer daily gas-measurement fields (GBC-7) — raw pass-through (no gauge
    // ratio): gas is metered. `?? null` keeps an unmeasured field null rather
    // than writing 0. (Field-ops volumes now live on the tank reading.)
    orifice: point.orifice ?? null,
    differential: point.differential ?? null,
    chm: point.chm ?? null,
    casing_pressure: point.casingPressure ?? null,
    tubing_pressure: point.tubingPressure ?? null,
    flow_pressure: point.flowPressure ?? null,
    choke: point.choke ?? null,
    remarks: point.remarks ?? null,
  };
}

/**
 * The measurement columns of a production reading — everything that is data
 * rather than identity (`well_id` / `reading_date` / `reading_time`). The
 * last-wins merge writes this exact set on every row of a batch, because an
 * upsert applies the payload's column list uniformly: a column left out of the
 * payload is not written at all, and one included is written to every row.
 */
const PRODUCTION_COLUMNS = [
  "oil_production",
  "oil_stock",
  "oil_sales",
  "gas_production",
  "salt_water",
  "orifice",
  "differential",
  "chm",
  "casing_pressure",
  "tubing_pressure",
  "flow_pressure",
  "choke",
  "remarks",
] as const;

/**
 * Canonical `HH:MM:SS` for a reading time, so matching a row in JS agrees with
 * the Postgres `time` comparison the upsert's conflict target performs. "8:34",
 * "08:34" and "08:34:00" are all the same slot; blank is midnight.
 */

/**
 * The columns a source actually REPORTED, for the last-wins merge. A field the
 * source left null/undefined is absent from the patch entirely — that is what
 * distinguishes "not measured" from a measured zero, and it is why a gas-only
 * document can update gas without zeroing the day's oil.
 *
 * Blank remarks count as unreported for the same reason (a document that prints
 * no pumper note is not asserting the note is empty). Clearing a field back to
 * blank is the grid's job — `updateProduction` writes the whole row.
 */
function productionPatch(
  point: ProductionWritePoint,
  ratio: number
): Record<string, number | string> {
  const patch: Record<string, number | string> = {};
  const put = (
    column: string,
    value: number | null | undefined,
    scale = 1
  ) => {
    if (value != null) patch[column] = value * scale;
  };
  // Oil arrives as gauge inches and is converted to barrels here (× the well's
  // strapping factor); gas and water are metered and pass through unconverted.
  put("oil_production", point.oilProduction, ratio);
  put("oil_stock", point.oilStock, ratio);
  put("oil_sales", point.oilSales, ratio);
  put("gas_production", point.gasProduction);
  put("salt_water", point.saltWater);
  put("orifice", point.orifice);
  put("differential", point.differential);
  put("chm", point.chm);
  put("casing_pressure", point.casingPressure);
  put("tubing_pressure", point.tubingPressure);
  put("flow_pressure", point.flowPressure);
  put("choke", point.choke);
  if (point.remarks) patch.remarks = point.remarks;
  return patch;
}

/** Record a daily production reading for a well; returns the new row id. */
export async function addProduction(
  wellId: string,
  point: ProductionPoint
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const ratio = await wellOilRatio(sb, wellId);
  const { data, error } = await sb
    .from("production_readings")
    .insert({ well_id: wellId, ...productionRow(point, ratio) })
    .select("id")
    .single();
  if (error) throw new Error(`addProduction: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
  return { id: data.id };
}

/** Update an existing production reading. */
export async function updateProduction(
  wellId: string,
  id: string,
  point: ProductionPoint
): Promise<void> {
  const sb = await getSupabaseServer();
  const ratio = await wellOilRatio(sb, wellId);
  const { error } = await sb
    .from("production_readings")
    .update(productionRow(point, ratio))
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`updateProduction: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
}

/** Delete a production reading. */
export async function deleteProduction(
  wellId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("production_readings")
    .delete()
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`deleteProduction: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
}

/**
 * Bulk-write production readings for a well. The single bulk writer for every
 * source: manual grid entry, Orion's `record_production`, the per-well document
 * upload, and the ingest auto-fill approver. Oil UNITS depend on the caller.
 * Manual, Orion, and the per-well upload pass gauge INCHES, converted to barrels
 * through `productionRow` (times the well's tank strapping factor). The
 * ingest/history approver passes oil already in BARRELS and sets `oilInBarrels`,
 * which bypasses that conversion (ratio 1) so document-reported barrels are
 * stored as-is. Gas (MCF) and salt water (bbl) always pass through unconverted.
 *
 * LAST-WINS, FIELD BY FIELD. A reading whose (well, date, time) slot is already
 * on file is UPDATED, not skipped: the incumbent can be stale, and a later
 * source correcting it is the normal case, not an error. The merge is per field,
 * though — only the columns this source actually reported are overwritten, and
 * anything it stayed silent about keeps its stored value. A gas-only report
 * therefore updates gas and leaves the day's oil, pressures and remarks intact.
 * (`ProductionWritePoint` is what carries "silent": null/undefined ≠ a reported
 * zero. Callers that measure everything pass a plain `ProductionPoint` and
 * overwrite the whole row, which is what the manual grid and Orion intend.)
 *
 * Re-running the same source is still a no-op — every reported value already
 * matches, so the row is counted `skipped` and never touched. Returns added vs
 * updated vs skipped counts plus the refreshed id-bearing list so a client can
 * replace its table state (the upsert alone returns only the rows it wrote).
 */
export async function writeProductionReadings(
  wellId: string,
  points: ProductionWritePoint[],
  options?: { oilInBarrels?: boolean }
): Promise<{
  added: number;
  updated: number;
  skipped: number;
  readings: ProductionPoint[];
}> {
  if (points.length === 0) {
    return {
      added: 0,
      updated: 0,
      skipped: 0,
      readings: await getWellProduction(wellId),
    };
  }
  const sb = await getSupabaseServer();
  // The ingest/history path reports oil in barrels; bypass the gauge-inch
  // strapping conversion by using ratio 1. Every other caller passes inches.
  const ratio = options?.oilInBarrels ? 1 : await wellOilRatio(sb, wellId);

  // Load what is already on file at the slots we are about to write, so a
  // reported value can be merged OVER the incumbent instead of replacing the
  // whole row. Only rows with a real `reading_time` are eligible: the write
  // below always pins a time, and a legacy NULL-time row can never be the
  // upsert's conflict target (NULL != NULL), so merging into one would leave the
  // ghost in place and insert a second row beside it.
  const dates = [...new Set(points.map((p) => p.date))];
  const { data: priorRows, error: priorErr } = await sb
    .from("production_readings")
    .select(
      "reading_date, reading_time, oil_production, oil_stock, oil_sales, gas_production, salt_water, orifice, differential, chm, casing_pressure, tubing_pressure, flow_pressure, choke, remarks"
    )
    .eq("well_id", wellId)
    .in("reading_date", dates);
  if (priorErr) {
    throw new Error(`writeProductionReadings (existing): ${priorErr.message}`);
  }
  const prior = new Map<string, Record<string, unknown>>();
  for (const row of (priorRows ?? []) as unknown as Record<string, unknown>[]) {
    if (row.reading_time == null) continue;
    const slot = readingSlot(row.reading_time as string);
    prior.set(`${row.reading_date as string}|${slot}`, row);
  }

  // Every row of the batch carries the full column set — an upsert writes the
  // payload's columns to all of its rows, so a uniform shape is what lets one
  // statement mix inserts with per-row merges.
  const blank: Record<string, unknown> = {};
  for (const column of PRODUCTION_COLUMNS) blank[column] = null;

  const rows: Record<string, unknown>[] = [];
  let updated = 0;
  let skipped = 0;
  for (const point of points) {
    // A daily report often has no clock time. Pin a blank time to midnight so
    // the (well, date, time) uniqueness key is stable — otherwise NULL != NULL
    // and re-importing the same report would insert duplicate rows.
    const time = point.time || "00:00";
    const patch = productionPatch(point, ratio);
    const incumbent = prior.get(`${point.date}|${readingSlot(time)}`);

    const carried: Record<string, unknown> = {};
    if (incumbent) {
      // Nothing new to say about this slot — leave the stored row untouched
      // rather than rewriting it with its own values.
      const changes = Object.entries(patch).some(
        ([column, value]) => !sameValue(incumbent[column], value)
      );
      if (!changes) {
        skipped++;
        continue;
      }
      updated++;
      for (const column of PRODUCTION_COLUMNS) carried[column] = incumbent[column];
    }

    rows.push({
      well_id: wellId,
      reading_date: point.date,
      reading_time: time,
      ...blank,
      ...carried,
      ...patch,
    });
  }

  if (rows.length > 0) {
    const { error } = await sb.from("production_readings").upsert(rows, {
      onConflict: "well_id,reading_date,reading_time",
      // The merge above already folded the incumbent's unreported fields into
      // the payload, so updating in place corrects the row without blanking it.
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`writeProductionReadings: ${error.message}`);
  }

  revalidatePath(`/wells/${wellId}`);
  const readings = await getWellProduction(wellId);
  return { added: rows.length - updated, updated, skipped, readings };
}

/** Shape a raw equipment row into a `WellEquipment`. */
function mapEquipment(r: {
  id: string;
  label: string | null;
  value: string | null;
  position: number | null;
  notes: string | null;
}): WellEquipment {
  return {
    id: r.id,
    label: r.label ?? "",
    value: r.value ?? "",
    position: r.position ?? 0,
    notes: r.notes ?? "",
  };
}

const EQUIPMENT_COLS = "id, label, value, position, notes";

/**
 * Re-read a well's equipment rows (sheet order). Used by the well page's live
 * realtime subscription to resync after an out-of-band write (e.g. Orion adding
 * equipment from a chat or an upload approval).
 */
export async function fetchWellEquipment(
  wellId: string
): Promise<WellEquipment[]> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_equipment")
    .select(EQUIPMENT_COLS)
    .eq("well_id", wellId)
    .order("position", { ascending: true });
  if (error) throw new Error(`fetchWellEquipment: ${error.message}`);
  return (data ?? []).map(mapEquipment);
}

/** Next free position for a well's equipment (so new rows append at the end). */
async function nextEquipmentPosition(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  wellId: string
): Promise<number> {
  const { data } = await sb
    .from("well_equipment")
    .select("position")
    .eq("well_id", wellId)
    .order("position", { ascending: false })
    .limit(1);
  return (data?.[0]?.position ?? -1) + 1;
}

/** Append a single blank equipment row to a well; returns it (for inline edit). */
export async function addWellEquipmentRow(
  wellId: string
): Promise<WellEquipment> {
  const sb = await getSupabaseServer();
  const position = await nextEquipmentPosition(sb, wellId);
  const { data, error } = await sb
    .from("well_equipment")
    .insert({ well_id: wellId, label: "", value: "", notes: "", position })
    .select(EQUIPMENT_COLS)
    .single();
  if (error) throw new Error(`addWellEquipmentRow: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
  return mapEquipment(data);
}

/** Update an equipment row's label, value, and/or notes (inline edit + detail modal). */
export async function updateWellEquipment(
  wellId: string,
  id: string,
  patch: { label?: string; value?: string; notes?: string }
): Promise<void> {
  const update: { label?: string; value?: string; notes?: string } = {};
  if (patch.label !== undefined) update.label = patch.label;
  if (patch.value !== undefined) update.value = patch.value;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (Object.keys(update).length === 0) return;

  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("well_equipment")
    .update(update)
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`updateWellEquipment: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
}

/** Delete an equipment row. */
export async function deleteWellEquipment(
  wellId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_equipment")
    .delete()
    .eq("id", id)
    .eq("well_id", wellId)
    .select("id");
  if (error) throw new Error(`deleteWellEquipment: ${error.message}`);
  // RLS returns success with zero rows when the caller lacks the
  // `manage_well_equipment` write capability. Surface that instead of letting
  // the delete silently no-op (row reappears on reload).
  if (!data || data.length === 0) {
    throw new Error(
      "deleteWellEquipment: nothing deleted. You may lack permission to manage equipment for this well."
    );
  }
  revalidatePath(`/wells/${wellId}`);
}

/**
 * Add equipment fields to a well in bulk (used by Orion's add_well_equipment
 * tool, e.g. filling a well file from an uploaded spec sheet). Blank fields (no
 * label) are dropped, and new rows are ordered after any existing ones.
 */
export async function addWellEquipment(
  wellId: string,
  fields: EquipmentField[],
  opts: {
    /**
     * The document the fields were read from (an invoice, a spec sheet), for
     * provenance — lands in `well_equipment.file_id`. Omitted for manual and
     * Orion-tool adds. Requires the 2026082100100 migration when set.
     */
    fileId?: string | null;
  } = {}
): Promise<void> {
  const cleaned = fields
    .map((f) => ({ label: f.label.trim(), value: f.value.trim() }))
    .filter((f) => f.label.length > 0);
  if (cleaned.length === 0) return;

  const sb = await getSupabaseServer();
  const start = await nextEquipmentPosition(sb, wellId);
  const rows = cleaned.map((f, index) => ({
    well_id: wellId,
    label: f.label,
    value: f.value,
    position: start + index,
    // Only present when a source document is known, so inserts stay valid
    // against a database that has not run the file_id migration yet.
    ...(opts.fileId ? { file_id: opts.fileId } : {}),
  }));
  const { error } = await sb.from("well_equipment").insert(rows);
  if (error) throw new Error(`addWellEquipment: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
}

// --- Service history (edited inline from a well's Service tab) ---------------
// Dated job/service events (repairs, workovers, acid jobs, tests, cleanouts,
// vendor calls). Distinct from equipment (physical config); mirrors the same
// inline-edit + batch-add pattern. Writes are gated by RLS on
// `manage_well_equipment`.

// The attached source document is embedded (not a second query) so a service row
// can render its paperclip + filename straight from the list read. The embed
// resolves under RLS: a caller without `manage_files` gets `file: null` while
// `file_id` stays set, which is exactly the "an attachment exists but you can't
// open it" state the UI renders.
const SERVICE_COLS =
  "id, date, job, vendor, cost, notes, position, file_id, file:files!file_id(id, name)";

/** A `well_service` row as selected by `SERVICE_COLS`. */
interface ServiceRowShape {
  id: string;
  date: string | null;
  job: string | null;
  vendor: string | null;
  cost: number | null;
  notes: string | null;
  position: number | null;
  file_id?: string | null;
  /** PostgREST returns a to-one embed as an object, but the client's type
   * inference widens it to an array — accept either and normalize. */
  file?:
    | { id: string; name: string | null }
    | { id: string; name: string | null }[]
    | null;
}

/** The embedded document, whichever shape the embed came back as. */
function embeddedFile(
  file: ServiceRowShape["file"]
): { id: string; name: string | null } | null {
  if (!file) return null;
  return Array.isArray(file) ? (file[0] ?? null) : file;
}

/** Shape a raw service row into a `WellService`. */
function mapService(r: ServiceRowShape): WellService {
  return {
    id: r.id,
    date: r.date ?? "",
    job: r.job ?? "",
    vendor: r.vendor ?? "",
    cost: r.cost,
    notes: r.notes ?? "",
    position: r.position ?? 0,
    fileId: r.file_id ?? null,
    fileName: embeddedFile(r.file)?.name ?? null,
  };
}

/**
 * Re-read a well's service rows (list order). Used by the well page's realtime
 * subscription to resync after an out-of-band write (e.g. Orion adding service
 * history from a chat or an upload approval).
 */
export async function fetchWellService(
  wellId: string
): Promise<WellService[]> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_service")
    .select(SERVICE_COLS)
    .eq("well_id", wellId)
    .order("position", { ascending: true });
  if (error) throw new Error(`fetchWellService: ${error.message}`);
  return ((data ?? []) as unknown as ServiceRowShape[]).map(mapService);
}

/** Next free position for a well's service rows (so new rows append at the end). */
async function nextServicePosition(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  wellId: string
): Promise<number> {
  const { data } = await sb
    .from("well_service")
    .select("position")
    .eq("well_id", wellId)
    .order("position", { ascending: false })
    .limit(1);
  return (data?.[0]?.position ?? -1) + 1;
}

/** Append a single blank service row to a well; returns it (for inline edit). */
export async function addWellServiceRow(wellId: string): Promise<WellService> {
  const sb = await getSupabaseServer();
  const position = await nextServicePosition(sb, wellId);
  const { data, error } = await sb
    .from("well_service")
    .insert({ well_id: wellId, job: "", vendor: "", notes: "", position })
    .select(SERVICE_COLS)
    .single();
  if (error) throw new Error(`addWellServiceRow: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
  return mapService(data as unknown as ServiceRowShape);
}

/** Update a service row's fields (inline edit). Only passed fields change. */
export async function updateWellService(
  wellId: string,
  id: string,
  patch: {
    date?: string;
    job?: string;
    vendor?: string;
    cost?: number | null;
    notes?: string;
    /** Attach (`files.id`) or detach (`null`) the entry's source document. */
    fileId?: string | null;
  }
): Promise<void> {
  const update: {
    date?: string | null;
    job?: string;
    vendor?: string;
    cost?: number | null;
    notes?: string;
    file_id?: string | null;
  } = {};
  // An empty date string clears the (nullable) date column.
  if (patch.date !== undefined) update.date = patch.date.trim() || null;
  if (patch.job !== undefined) update.job = patch.job;
  if (patch.vendor !== undefined) update.vendor = patch.vendor;
  if (patch.cost !== undefined) update.cost = patch.cost;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (patch.fileId !== undefined) update.file_id = patch.fileId;
  if (Object.keys(update).length === 0) return;

  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("well_service")
    .update(update)
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`updateWellService: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
}

/** Delete a service row. */
export async function deleteWellService(
  wellId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_service")
    .delete()
    .eq("id", id)
    .eq("well_id", wellId)
    .select("id");
  if (error) throw new Error(`deleteWellService: ${error.message}`);
  // RLS returns success with zero rows when the caller lacks the
  // `manage_well_equipment` write capability. Surface that instead of a silent
  // no-op (row reappears on reload).
  if (!data || data.length === 0) {
    throw new Error(
      "deleteWellService: nothing deleted. You may lack permission to manage this well's service history."
    );
  }
  revalidatePath(`/wells/${wellId}`);
}

/**
 * Add service-history rows to a well in bulk (used by Orion's add_well_service
 * tool, e.g. filing repairs/tests/vendor calls from an uploaded ticket). Rows
 * with no job label are dropped; new rows are ordered after any existing ones.
 *
 * `options.fileId` links every inserted row to the document they were read from,
 * so a service entry approved out of an uploaded ticket keeps its primary source
 * with no user action (russell-feedback-one.md:28). The ingest approval path
 * already knows that file id; it passes it here.
 */
export async function addWellService(
  wellId: string,
  rows: ServiceField[],
  options?: { fileId?: string | null }
): Promise<void> {
  const cleaned = rows
    .map((r) => ({
      date: (r.date ?? "").trim() || null,
      job: r.job.trim(),
      vendor: r.vendor.trim(),
      cost: r.cost ?? null,
      notes: r.notes.trim(),
    }))
    .filter((r) => r.job.length > 0);
  if (cleaned.length === 0) return;

  const sb = await getSupabaseServer();
  const start = await nextServicePosition(sb, wellId);
  const fileId = options?.fileId ?? null;
  const insert = cleaned.map((r, index) => ({
    well_id: wellId,
    date: r.date,
    job: r.job,
    vendor: r.vendor,
    cost: r.cost,
    notes: r.notes,
    position: start + index,
    file_id: fileId,
  }));
  const { error } = await sb.from("well_service").insert(insert);
  if (error) throw new Error(`addWellService: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
}

/**
 * Attach an existing document to a service entry as its primary source, and place
 * that document in the well's folder so it also shows on the well's Files tab.
 *
 * Reference, never copy: the bytes stay in the one `files` bucket (contrast the
 * statements path, which duplicates them into a second bucket). The placement is
 * best-effort — a caller who can manage service history but not files still gets
 * the link recorded, they just don't get the file filed under the well.
 */
export async function attachServiceDocument(
  wellId: string,
  serviceId: string,
  fileId: string
): Promise<void> {
  const sb = await getSupabaseServer();

  const { data, error } = await sb
    .from("well_service")
    .update({ file_id: fileId })
    .eq("id", serviceId)
    .eq("well_id", wellId)
    .select("id");
  if (error) throw new Error(`attachServiceDocument: ${error.message}`);
  // RLS returns success with zero rows when the caller lacks the write
  // capability; surface that rather than reporting a save that didn't happen.
  if (!data || data.length === 0) {
    throw new Error(
      "attachServiceDocument: nothing updated. You may lack permission to manage this well's service history."
    );
  }

  try {
    const folderId = await getOrCreateWellFolderId(sb, wellId);
    const { data: exists } = await sb
      .from("file_placements")
      .select("id")
      .eq("file_id", fileId)
      .eq("folder_id", folderId)
      .maybeSingle();
    if (!exists) {
      await sb
        .from("file_placements")
        .insert({ file_id: fileId, folder_id: folderId });
    }
  } catch (err) {
    console.error("attachServiceDocument: well-folder placement failed", err);
  }

  revalidatePath(`/wells/${wellId}`);
}

/**
 * Detach a service entry's source document. The `files` row is left alone — the
 * document stays in the well's folder and in `/files`; only the link is cleared.
 */
export async function detachServiceDocument(
  wellId: string,
  serviceId: string
): Promise<void> {
  await updateWellService(wellId, serviceId, { fileId: null });
}

// ── Fluid-level shots ───────────────────────────────────────────────────────
// A well's dated acoustic/sonolog shots (well_shots). Mirrors the service
// actions above — fetch for the realtime resync, plus add/update/delete for the
// panel. Unlike a service row, a shot is added from a modal with a required date
// (shot_date is NOT NULL), so addWellShotRow takes the captured fields rather
// than appending a blank row to edit in place.

/** A `well_shots` row as selected by `SHOT_COLS`. */
interface ShotRowShape {
  id: string;
  shot_date: string | null;
  shot_time: string | null;
  fluid_level_ft: number | null;
  notes: string | null;
}

/**
 * Re-read a well's shots (newest first). Used by the well page's realtime
 * subscription to resync after an out-of-band write (a second browser landing a
 * shot, or a future Orion tool). Order matches {@link getWellShots}.
 */
export async function fetchWellShots(wellId: string): Promise<WellShot[]> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_shots")
    .select(SHOT_COLS)
    .eq("well_id", wellId)
    .order("shot_date", { ascending: false })
    .order("shot_time", { ascending: false, nullsFirst: false });
  if (error) throw new Error(`fetchWellShots: ${error.message}`);
  return ((data ?? []) as ShotRowShape[]).map(mapShotRow);
}

/** Record a fluid-level shot on a well (from the Add-shot modal); returns it. */
export async function addWellShotRow(
  wellId: string,
  field: ShotField
): Promise<WellShot> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_shots")
    .insert({
      well_id: wellId,
      shot_date: field.date,
      shot_time: field.time.trim() || null,
      fluid_level_ft: field.fluidLevelFt,
      notes: field.notes.trim(),
    })
    .select(SHOT_COLS)
    .single();
  if (error) throw new Error(`addWellShotRow: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
  return mapShotRow(data as ShotRowShape);
}

/** Update a shot's fields (inline edit). Only passed fields change. */
export async function updateWellShot(
  wellId: string,
  id: string,
  patch: {
    date?: string;
    time?: string;
    fluidLevelFt?: number | null;
    notes?: string;
  }
): Promise<void> {
  const update: {
    shot_date?: string;
    shot_time?: string | null;
    fluid_level_ft?: number | null;
    notes?: string;
  } = {};
  // shot_date is NOT NULL: a cleared date is ignored rather than written null.
  if (patch.date !== undefined && patch.date.trim())
    update.shot_date = patch.date.trim();
  if (patch.time !== undefined) update.shot_time = patch.time.trim() || null;
  if (patch.fluidLevelFt !== undefined)
    update.fluid_level_ft = patch.fluidLevelFt;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (Object.keys(update).length === 0) return;

  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("well_shots")
    .update(update)
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`updateWellShot: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
}

/** Delete a shot. */
export async function deleteWellShot(
  wellId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_shots")
    .delete()
    .eq("id", id)
    .eq("well_id", wellId)
    .select("id");
  if (error) throw new Error(`deleteWellShot: ${error.message}`);
  // RLS returns success with zero rows when the caller lacks the
  // manage_well_equipment write capability. Surface that instead of a silent
  // no-op (the row reappears on reload).
  if (!data || data.length === 0) {
    throw new Error(
      "deleteWellShot: nothing deleted. You may lack permission to manage this well's shots."
    );
  }
  revalidatePath(`/wells/${wellId}`);
}

// ── Pumping setups ──────────────────────────────────────────────────────────
// A well's effective-dated pumping configuration (well_pumping): pump depth,
// pump size, stroke length, SPM and the timer, each in force from a date until a
// later record supersedes it. Same shape as the shot actions above.
//
// One setup per (well, date) — `well_pumping_well_date_key` — so recording the
// same day twice is a CORRECTION of the first, not a second setup the reader
// would have to choose between. The add therefore upserts.

/** A `well_pumping` row as selected by `PUMPING_COLS`. */
interface PumpingRowShape {
  id: string;
  effective_date: string | null;
  pump_depth_ft: number | null;
  pump_size_in: number | null;
  stroke_length_in: number | null;
  strokes_per_min: number | null;
  timer: string | null;
}

/** Re-read a well's pumping records (newest effective date first). */
export async function fetchWellPumping(
  wellId: string
): Promise<WellPumping[]> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_pumping")
    .select(PUMPING_COLS)
    .eq("well_id", wellId)
    .order("effective_date", { ascending: false });
  if (error) throw new Error(`fetchWellPumping: ${error.message}`);
  return ((data ?? []) as PumpingRowShape[]).map(mapPumpingRow);
}

/** Record (or correct) the pumping setup effective on a date; returns the row. */
export async function addWellPumpingRow(
  wellId: string,
  field: PumpingField
): Promise<WellPumping> {
  const effectiveDate = field.effectiveDate.trim();
  if (!effectiveDate) {
    throw new Error("addWellPumpingRow: an effective date is required.");
  }
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_pumping")
    .upsert(
      {
        well_id: wellId,
        effective_date: effectiveDate,
        pump_depth_ft: field.pumpDepthFt,
        pump_size_in: field.pumpSizeIn,
        stroke_length_in: field.strokeLengthIn,
        strokes_per_min: field.strokesPerMin,
        timer: field.timer.trim(),
      },
      { onConflict: "well_id,effective_date" }
    )
    .select(PUMPING_COLS)
    .single();
  if (error) throw new Error(`addWellPumpingRow: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
  return mapPumpingRow(data as PumpingRowShape);
}

/** Update a pumping record's fields (inline edit). Only passed fields change. */
export async function updateWellPumping(
  wellId: string,
  id: string,
  patch: Partial<PumpingField>
): Promise<void> {
  const update: {
    effective_date?: string;
    pump_depth_ft?: number | null;
    pump_size_in?: number | null;
    stroke_length_in?: number | null;
    strokes_per_min?: number | null;
    timer?: string;
  } = {};
  // effective_date is NOT NULL: a cleared date is ignored rather than written null.
  if (patch.effectiveDate !== undefined && patch.effectiveDate.trim())
    update.effective_date = patch.effectiveDate.trim();
  if (patch.pumpDepthFt !== undefined) update.pump_depth_ft = patch.pumpDepthFt;
  if (patch.pumpSizeIn !== undefined) update.pump_size_in = patch.pumpSizeIn;
  if (patch.strokeLengthIn !== undefined)
    update.stroke_length_in = patch.strokeLengthIn;
  if (patch.strokesPerMin !== undefined)
    update.strokes_per_min = patch.strokesPerMin;
  if (patch.timer !== undefined) update.timer = patch.timer;
  if (Object.keys(update).length === 0) return;

  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("well_pumping")
    .update(update)
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`updateWellPumping: ${error.message}`);
  revalidatePath(`/wells/${wellId}`);
}

/** Delete a pumping record. */
export async function deleteWellPumping(
  wellId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_pumping")
    .delete()
    .eq("id", id)
    .eq("well_id", wellId)
    .select("id");
  if (error) throw new Error(`deleteWellPumping: ${error.message}`);
  // RLS returns success with zero rows when the caller lacks the
  // manage_well_equipment write capability. Surface that instead of a silent
  // no-op (the row reappears on reload).
  if (!data || data.length === 0) {
    throw new Error(
      "deleteWellPumping: nothing deleted. You may lack permission to manage this well's configuration."
    );
  }
  revalidatePath(`/wells/${wellId}`);
}

// Posting a comment on a well now goes through the shared facility thread —
// `addComment("well", wellId, body)` in `@/lib/comments/actions`. Orion's
// `add_well_comment` tool calls that directly.

/**
 * Attach a single uploaded file to a well. Well files reuse the unified file
 * model — bytes → the shared `files` Storage bucket, metadata → `files`, and a
 * `file_placements` row into the well's subfolder under the `Wells` system root
 * (created on first use). Same de-duplicated storage as `/files` and
 * `/projects`; no per-well join table. The file is indexed for search so
 * Orion can read it. Returns the created file so the UI can render it without a
 * round-trip refresh. One file per call so the client can report per-file
 * status; the caller fans out across the selection.
 */
/**
 * Attach files that already live in the doc store to this well, by placing them
 * in the well's folder (many-to-many `file_placements`) — no storage copy, no
 * re-indexing. Skips files already placed there. Returns the attached files as
 * `WellFile` rows for the well's list.
 */
export async function attachExistingFilesToWell(
  wellId: string,
  fileIds: string[],
  /**
   * `scan: false` places the documents and stops. The default reads them, the
   * same way dropping the same file on this page would: a scan taken on the
   * phone lands in `Scans` deliberately unread (there is no approval UI on a
   * handset), and attaching it here is the moment somebody asks what is in it.
   */
  options?: { scan?: boolean; reviewInvoices?: boolean }
): Promise<{
  files: WellFile[];
  proposals: IngestProposal[];
  /**
   * The attached documents that held invoices, for the review modal. One entry
   * per document — several files can be attached at once, and each reviews
   * against its own scan. See `uploadWellFile`.
   */
  invoices: InvoiceReviewDocument[];
}> {
  if (fileIds.length === 0) return { files: [], proposals: [], invoices: [] };

  const wantScan = options?.scan ?? true;
  const sb = await getSupabaseServer();
  const folderId = await getOrCreateWellFolderId(sb, wellId);

  for (const fileId of fileIds) {
    const { data: exists } = await sb
      .from("file_placements")
      .select("id")
      .eq("file_id", fileId)
      .eq("folder_id", folderId)
      .maybeSingle();
    if (exists) continue;
    const { error } = await sb
      .from("file_placements")
      .insert({ file_id: fileId, folder_id: folderId });
    if (error) {
      throw new Error(`attachExistingFilesToWell (placement): ${error.message}`);
    }
  }

  const { data: rows, error: rowsErr } = await sb
    .from("files")
    .select("id, name, type, size, created_at, storage_key")
    .in("id", fileIds);
  if (rowsErr) {
    throw new Error(`attachExistingFilesToWell (files): ${rowsErr.message}`);
  }

  // Read each attached document the way an upload to this page reads one: the
  // well-page skills (`scope: "well"`), with the well stamped on so suppression
  // compares against THIS well's records. The bytes are already in the bucket,
  // so this is a download rather than an upload — one `files` row, one object,
  // two placements.
  const proposals: IngestProposal[] = [];
  const invoices: InvoiceReviewDocument[] = [];
  if (wantScan) {
    for (const r of (rows ?? []) as { id: string; name: string; storage_key: string | null }[]) {
      try {
        const { data: blob, error } = await getSupabaseAdmin()
          .storage.from(FILES_BUCKET)
          .download(r.storage_key ?? r.id);
        if (error || !blob) throw new Error(error?.message ?? "no bytes returned");
        const buf = Buffer.from(await blob.arrayBuffer());
        const part = await buildDocumentPart(r.name, buf);
        const scan = await computeIngestProposals(sb, part, {
          table: parseTable(r.name, buf),
          scope: "well",
          applyScope: (d) => stampWell(d, wellId),
          // Read here exactly as an upload to this page is read, invoice review
          // included when the caller can show one. See `uploadWellFile`.
          reviewInvoices: options?.reviewInvoices ?? false,
        });
        proposals.push(
          ...(await insertIngestProposals(
            sb,
            r.id,
            r.name,
            stampWell(scan.drafts, wellId)
          ))
        );
        if (scan.invoices.length > 0) {
          invoices.push({
            fileId: r.id,
            fileName: r.name,
            invoices: scan.invoices,
          });
        }
      } catch (err) {
        // One unreadable attachment must not undo the placements that worked.
        if (!(err instanceof UnsupportedFileError)) {
          console.error("attachExistingFilesToWell: analyse failed", err);
        }
      }
    }
  }

  revalidatePath(`/wells/${wellId}`);
  revalidateFiles();

  const today = new Date().toISOString().slice(0, 10);
  const files = (rows ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    type: String(r.type ?? "file").toUpperCase(),
    sizeKb: Math.max(1, Math.round(((r.size as number | null) ?? 0) / 1024)),
    uploadedAt:
      typeof r.created_at === "string" ? r.created_at.slice(0, 10) : today,
    scanStatus: null,
  }));

  return { files, proposals, invoices };
}

/** The service form's fields, read off a document. Mirrors `serviceRow`. */
export interface ServiceDraftFields {
  date: string;
  job: string;
  vendor: string;
  cost: number | null;
  notes: string;
}

/**
 * Read a ticket or invoice ONCE, and send it to both places it belongs.
 *
 * The Add Service form is filled FROM a piece of paper, so the paper is offered
 * first and this is what makes that mean something: the same well-scoped
 * extraction an upload runs, pointed at a document already in the store, with
 * the first service record it finds handed back as form values.
 *
 * The SERVICE record it finds comes back as form values and is deliberately
 * NOT persisted: the user is looking at the form those values land in and will
 * accept or correct them there, which is the approval. Raising a card as well
 * would ask them to agree twice to the same thing.
 *
 * Everything ELSE the document holds — the equipment it lists, downtime it
 * describes, tests it reports — goes through the full well pipeline, started at
 * the same moment and finished after the response, and lands as ordinary ingest
 * proposals. So a ticket attached to a service entry still updates the Info
 * sheet, through an approval card like everything else: nothing here writes a
 * record the user has not accepted.
 *
 * A null `service` is not an error: the document is attached either way and the
 * fields stay empty for typing.
 */
export async function readServiceDraftFromFile(
  wellId: string,
  fileId: string
): Promise<{ service: ServiceDraftFields | null; proposals: IngestProposal[] }> {
  const sb = await getSupabaseServer();
  const { data: row } = await sb
    .from("files")
    .select("id, name, storage_key")
    .eq("id", fileId)
    .maybeSingle();
  const file = row as { id: string; name: string; storage_key: string | null } | null;
  if (!file) return { service: null, proposals: [] };

  try {
    const { data: blob, error } = await getSupabaseAdmin()
      .storage.from(FILES_BUCKET)
      .download(file.storage_key ?? file.id);
    if (error || !blob) throw new Error(error?.message ?? "no bytes returned");
    const buf = Buffer.from(await blob.arrayBuffer());
    const part = await buildDocumentPart(file.name, buf);
    const table = parseTable(file.name, buf);

    // ONE call, straight at the fields — the run-ticket route's shape
    // (`api/tanks/run-tickets/extract`), for the same reason it has it.
    //
    // The ingest pipeline transcribes, classifies the pages, then runs
    // analyze ⇄ validate, and all of that machinery exists to decide WHICH
    // destinations a document holds. Standing in the Add Service modal there is
    // nothing to decide: the destination is `service` and its five fields are
    // fixed in code. So the vision model reads the page and fills them, and the
    // user waits for one round trip instead of four.
    //
    // The pipeline is not gone, it is just not in front of anybody: the full
    // read still runs after the response, below.
    const gate = await gateAI(sb);
    if (!gate.allowed) return { service: null, proposals: [] };

    // The full well read STARTS NOW, alongside the one-shot below rather than
    // after it. It is the slow half (transcribe, classify, analyze ⇄ validate)
    // and it is what fills the Info sheet, so every second it waits for the
    // form's read is a second the equipment cards arrive late. Nothing awaits
    // it here; `after` picks the promise up once the response is out.
    const fullRead = computeIngestProposals(sb, part, {
      table,
      scope: "well",
      applyScope: (d) => stampWell(d, wellId),
    });
    // A rejection with no handler attached yet would be an unhandled rejection
    // before `after` gets to it.
    fullRead.catch(() => {});
    const { object, usage } = await generateObject({
      model: scanModel(),
      providerOptions: scanProviderOptions(),
      maxOutputTokens: 4000,
      schema: z.object({
        date: z.string().describe('ISO YYYY-MM-DD, "" if the page does not say'),
        job: z.string().describe('what was done, e.g. "Pulled pump"'),
        vendor: z.string().describe("who performed it"),
        cost: z.number().nullable().describe("USD total, null if not priced"),
        notes: z
          .string()
          .describe("ticket or invoice number, the job narrative, results"),
      }),
      system: [
        "You are reading ONE service or workover job performed on an oil or gas",
        "well, off the vendor's ticket, field report or invoice.",
        "",
        "Copy the operator's own wording rather than paraphrasing it; a job",
        "narrative belongs in `notes` verbatim, including sizes and depths.",
        "Never invent a value: absent is \"\" or null. If the page describes",
        "several visits, report the FIRST and put the rest in `notes`.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this service ticket." },
            part,
          ],
        },
      ],
    });
    void meterAnthropic(
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: SCAN_MODEL_ID,
      },
      "wells:service-read",
      sb
    );
    const drafts: ProposalDraft[] = [
      { type: "service", rows: [object], wellId },
    ];
    const scoped = stampWell(drafts, wellId);
    const first = scoped.find((d) => d.type === "service")?.rows?.[0] as
      | { date?: unknown; job?: unknown; vendor?: unknown; cost?: unknown; notes?: unknown }
      | undefined;
    const text = (v: unknown) => (typeof v === "string" ? v : "");

    // Everything the document holds BESIDES its service record, read after the
    // response. The user is watching a disabled form, and equipment or downtime
    // cards are not what they are waiting for: those arrive over Realtime the
    // way a backgrounded upload's do. `after` keeps the invocation alive past
    // the response, so this runs on a server nobody is waiting on.
    after(async () => {
      try {
        const { drafts: rest } = await fullRead;
        const others = stampWell(rest, wellId).filter((d) => d.type !== "service");
        if (others.length > 0) {
          await insertIngestProposals(sb, file.id, file.name, others);
        }
      } catch (err) {
        console.error("readServiceDraftFromFile: background read failed", err);
      }
    });

    return {
      service: first
        ? {
            date: text(first.date),
            job: text(first.job),
            vendor: text(first.vendor),
            cost: typeof first.cost === "number" ? first.cost : null,
            notes: text(first.notes),
          }
        : null,
      proposals: [],
    };
  } catch (err) {
    if (!(err instanceof UnsupportedFileError)) {
      console.error("readServiceDraftFromFile failed", err);
    }
    return { service: null, proposals: [] };
  }
}

/**
 * Default the well on every well-scoped draft the document didn't name itself.
 * A file uploaded *to this well* is strongly tied to it, so the approval modal
 * never has to ask.
 *
 * Applied TWICE, and deliberately: once inside the scan via `applyScope` (so
 * suppression can compare the rows against this well's existing records and drop
 * the duplicates before they ever become cards), and again on the way out as a
 * safety net. It is idempotent — a draft that already carries a well is returned
 * untouched — so the second pass costs nothing.
 */
function stampWell(drafts: ProposalDraft[], wellId: string): ProposalDraft[] {
  return drafts.map((d) =>
    INGEST_TYPE_META[d.type].needsWell && !d.wellId ? { ...d, wellId } : d
  );
}

export async function uploadWellFile(
  wellId: string,
  formData: FormData,
  /**
   * `scan: false` files the document without proposing any records — the "just
   * upload" path, for a doc the user wants stored and searchable but does not
   * want turned into suggestions. It skips the AI analysis entirely (no model
   * calls, no wait), so the upload returns as fast as the bytes land. Indexing
   * for Orion search still happens either way.
   */
  options?: {
    scan?: boolean;
    /**
     * The caller will show the invoice REVIEW MODAL for whatever comes back in
     * `invoices`, so an invoice here is returned nested for that screen instead
     * of as a flat `vendorInvoice` approval card.
     *
     * Off by default: a caller that does not render the modal still gets the
     * card, so no upload path can lose an invoice by forgetting to opt in.
     */
    reviewInvoices?: boolean;
  }
): Promise<
  WellFile & {
    proposals: IngestProposal[];
    /**
     * Why the scan produced the proposals it did — `null` when `scan: false`.
     * Distinct from `WellFile.scanStatus`, which is the OCR/indexing state.
     * Needed so the surface can tell "nothing in this document" (`no_records`)
     * apart from "all of it is already recorded" (`all_on_file`); before
     * suppression ran on this route the second case could not arise, and both
     * collapsed into one misleading "No records found".
     */
    ingestStatus: IngestScanStatus | null;
    /**
     * Any invoice this document holds, read by the Invoices page's own reader
     * for its review modal — which the upload modal shows FIRST, ahead of the
     * approval cards. An invoice is a payable before it is a well record, and
     * `saveInvoices` is what files it. Empty when the document holds none.
     */
    invoices: ExtractedInvoice[];
  }
> {
  const scan = options?.scan ?? true;
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("uploadWellFile: no file provided");
  }

  const sb = await getSupabaseServer();
  const folderId = await getOrCreateWellFolderId(sb, wellId);
  const id = crypto.randomUUID();
  const buf = Buffer.from(await file.arrayBuffer());

  // Crop provenance from the browser's hygiene step, plus the pre-crop original.
  // Single-file surface, so the fields are unindexed. Null for non-images.
  const hygiene = await resolveHygiene(
    id,
    formData.get("hygiene"),
    formData.get("original")
  );

  // Analyse the document from the in-memory bytes IN PARALLEL with the Storage
  // write — the scan needs the bytes, not the persisted object. A file we can't
  // parse (or any analyse failure) degrades to no proposals rather than failing
  // the upload, carrying the reason so the surface can say which happened.
  const analyse = (async (): Promise<{
    drafts: ProposalDraft[];
    status: IngestScanStatus | null;
    invoices: ExtractedInvoice[];
  }> => {
    if (!scan) return { drafts: [], status: null, invoices: [] };
    try {
      const part = await buildDocumentPart(file.name, buf);
      const table = parseTable(file.name, buf);
      // `scope: "well"` routes this to the well-page skills instead of the
      // general categorize + triage flow — the well is already known from the
      // page the file was dropped on. `applyScope` hands that well to the scan
      // so suppression runs against it; without it every well-scoped handler
      // sees a null well, keeps every row, and the duplicates surface as cards
      // the write step then refuses.
      const { drafts, status, invoices } = await computeIngestProposals(sb, part, {
        table,
        scope: "well",
        applyScope: (d) => stampWell(d, wellId),
        // Nested for the review screen when the caller can show one; a flat
        // approval card when it cannot. See `ScanResult.invoices`.
        reviewInvoices: options?.reviewInvoices ?? false,
      });
      return { drafts, status, invoices };
    } catch (err) {
      if (err instanceof UnsupportedFileError) {
        return { drafts: [], status: "unreadable", invoices: [] };
      }
      console.error("uploadWellFile: ingest analyse failed", err);
      return { drafts: [], status: "error", invoices: [] };
    }
  })();

  // Bytes go to the private bucket via the admin client; the DB rows below go
  // through the request-scoped client so RLS assigns org_id and enforces
  // manage_files (well files are ordinary files in the unified model).
  const [, scanned] = await Promise.all([
    getSupabaseAdmin()
      .storage.from(FILES_BUCKET)
      // An explicit undefined overrides storage-js's default content type and
      // the request fails with "Invalid Content-Type header".
      .upload(id, buf, { contentType: file.type || "application/octet-stream", upsert: false })
      .then(({ error }) => {
        if (error) throw new Error(`uploadWellFile (storage): ${error.message}`);
      }),
    analyse,
  ]);

  // Extract text inline for text-like docs so Orion can search them right away;
  // binaries (PDF, images) are OCR'd later inside embedFile.
  const isText = /\.(md|markdown|txt|csv|tsv|json|las)$/i.test(file.name);
  const content = isText ? new TextDecoder().decode(buf) : null;

  const type = fileType(file.name);
  const { error: fileErr } = await sb.from("files").insert({
    id,
    name: file.name,
    type,
    mime: file.type || null,
    size: file.size,
    storage_key: id,
    content,
    // See uploadFiles: omitted when empty so a pre-migration environment is
    // unaffected for everything that didn't go through crop review.
    ...(hygiene ? { hygiene } : {}),
  });
  if (fileErr) throw new Error(`uploadWellFile (files): ${fileErr.message}`);

  const { error: placeErr } = await sb
    .from("file_placements")
    .insert({ file_id: id, folder_id: folderId });
  if (placeErr) throw new Error(`uploadWellFile (placement): ${placeErr.message}`);

  // A MainLog mud log is binary; its LAS rendition is the text embedFile reads.
  if (isMainLogName(file.name)) {
    try {
      await deriveMainLog(sb, { id, name: file.name }, buf);
    } catch (error) {
      console.error("deriveMainLog (uploadWellFile) failed", error);
    }
  }

  // Index it so it's immediately searchable; never fail the upload over this.
  try {
    await embedFile(id);
  } catch (error) {
    console.error("embedFile (uploadWellFile) failed", error);
  }

  // The scan already stamped the well (see `applyScope` above); re-running the
  // idempotent helper is the safety net for any future path that returns drafts
  // without going through it.
  const scoped = stampWell(scanned.drafts, wellId);

  // Persist proposals now the file row exists (FK) and return them so the
  // caller opens the approval modal directly (Realtime is only a fallback).
  const proposals = await insertIngestProposals(sb, id, file.name, scoped);

  revalidatePath(`/wells/${wellId}`);
  revalidateFiles();

  return {
    id,
    name: file.name,
    type: type.toUpperCase(),
    sizeKb: Math.max(1, Math.round(file.size / 1024)),
    uploadedAt: new Date().toISOString().slice(0, 10),
    scanStatus: null,
    proposals,
    ingestStatus: scanned.status,
    invoices: scanned.invoices,
  };
}

/**
 * Delete a well's file entirely: its bytes, its `files` row, and everything that
 * hangs off it.
 *
 * NOT wired to the well page any more — its X calls {@link removeWellFile},
 * because a file on a well is a placement and destroying the document from
 * there took it out of `Scans` and off every other facility too. Kept for a
 * caller that genuinely means "destroy this document", and the Files browser's
 * `deleteFile` is the one surface that says so plainly. Well files are ordinary files in the unified model, so removing
 * the `files` row cascades its placements, embeddings, and ingest proposals (all
 * FKs are `on delete cascade`); the Storage object is removed separately. The
 * `files` delete goes through the request-scoped client so RLS enforces
 * `manage_files` — a user without it gets a no-op delete rather than a silent
 * bypass. Storage removal uses the admin client against the private bucket.
 */
/**
 * Take a file off a well, leaving the document alone.
 *
 * What the well page's X means now that a well file can be a document attached
 * from elsewhere: remove THIS well's placement. The scan it came from stays in
 * `Scans`, and the copies on other facilities stay where they are.
 *
 * {@link deleteWellFile} still exists for destroying a document outright, and
 * the Files browser is where that belongs — there you can see every folder a
 * file sits in before you take it away from all of them.
 */
export async function removeWellFile(
  wellId: string,
  fileId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const folderId = await getOrCreateWellFolderId(sb, wellId);
  await removeFileFromFolder(fileId, folderId);
  revalidatePath(`/wells/${wellId}`);
}

export async function deleteWellFile(
  wellId: string,
  fileId: string
): Promise<void> {
  const sb = await getSupabaseServer();

  // Read the storage key first (RLS-scoped; also confirms the caller can see it).
  const { data: file, error: readErr } = await sb
    .from("files")
    .select("storage_key")
    .eq("id", fileId)
    .maybeSingle();
  if (readErr) throw new Error(`deleteWellFile (read): ${readErr.message}`);
  if (!file) return; // Already gone (or not visible) — nothing to do.

  // Delete the row (cascades placements/embeddings). RLS gates on manage_files.
  const { error: delErr } = await sb.from("files").delete().eq("id", fileId);
  if (delErr) throw new Error(`deleteWellFile (files): ${delErr.message}`);

  // Remove the bytes. Best-effort: the row is already gone, so a storage miss
  // shouldn't fail the action (it would only orphan bytes in the bucket).
  if (file.storage_key) {
    const { error: rmErr } = await getSupabaseAdmin()
      .storage.from(FILES_BUCKET)
      .remove([file.storage_key]);
    if (rmErr) console.error("deleteWellFile (storage) failed", rmErr);
  }

  revalidatePath(`/wells/${wellId}`);
  revalidateFiles();
}

// --------------------------------------------------------- formation tops

/** Re-read a well's formation tops, shallowest first (realtime resync). */
export async function fetchWellFormations(
  wellId: string
): Promise<WellFormation[]> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_formations")
    .select(FORMATION_COLS)
    .eq("well_id", wellId)
    .order("top_ft", { ascending: true, nullsFirst: false })
    .order("position", { ascending: true });
  if (error) throw new Error(`fetchWellFormations: ${error.message}`);
  return (data ?? []).map(mapFormation);
}

/** Next free position, so a row with no depth appends rather than jumping. */
async function nextFormationPosition(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  wellId: string
): Promise<number> {
  const { data } = await sb
    .from("well_formations")
    .select("position")
    .eq("well_id", wellId)
    .order("position", { ascending: false })
    .limit(1);
  return (data?.[0]?.position ?? -1) + 1;
}

/**
 * Add a formation top by hand.
 *
 * `source` is always `user` here: the operator typed it, and that is exactly the
 * distinction the column exists to keep. A re-import must never treat a row a
 * person entered as one of its own to overwrite.
 *
 * The unique index on (well_id, name) is the dedup, so re-adding a name that is
 * already there UPDATES it rather than failing the action — the user's intent
 * when they type an existing name with a new depth is to correct it.
 */
export async function addWellFormation(
  wellId: string,
  input: { name: string; topFt: number | null; tvdFt: number | null }
): Promise<WellFormation> {
  const name = input.name.trim();
  if (!name) throw new Error("addWellFormation: a formation name is required.");

  const sb = await getSupabaseServer();
  const position = await nextFormationPosition(sb, wellId);
  const { data, error } = await sb
    .from("well_formations")
    .upsert(
      {
        well_id: wellId,
        name,
        top_ft: input.topFt,
        tvd_ft: input.tvdFt,
        source: "user",
        position,
      },
      { onConflict: "well_id,name" }
    )
    .select(FORMATION_COLS)
    .single();
  if (error) throw new Error(`addWellFormation: ${error.message}`);
  revalidatePath(`/production/wells/${wellId}`);
  return mapFormation(data);
}

/**
 * Edit a formation top.
 *
 * Editing flips `source` to `user`, because once a person has changed the value
 * it is theirs and a later re-sync must leave it alone. That is the whole point
 * of the column: without the flip, a corrected depth is indistinguishable from
 * one we wrote and would be overwritten the next time the state record is read.
 */
export async function updateWellFormation(
  wellId: string,
  id: string,
  patch: { name?: string; topFt?: number | null; tvdFt?: number | null }
): Promise<void> {
  const update: Record<string, unknown> = { source: "user" };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("updateWellFormation: name cannot be blank.");
    update.name = name;
  }
  if (patch.topFt !== undefined) update.top_ft = patch.topFt;
  if (patch.tvdFt !== undefined) update.tvd_ft = patch.tvdFt;

  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_formations")
    .update(update)
    .eq("id", id)
    .eq("well_id", wellId)
    .select("id");
  if (error) throw new Error(`updateWellFormation: ${error.message}`);
  // RLS answers a forbidden write with success and zero rows. Say so, rather
  // than letting the value snap back on the next load with no explanation.
  if (!data || data.length === 0) {
    throw new Error(
      "updateWellFormation: nothing updated. You may lack permission to manage well equipment."
    );
  }
  revalidatePath(`/production/wells/${wellId}`);
}

/** Delete a formation top. */
export async function deleteWellFormation(
  wellId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("well_formations")
    .delete()
    .eq("id", id)
    .eq("well_id", wellId)
    .select("id");
  if (error) throw new Error(`deleteWellFormation: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(
      "deleteWellFormation: nothing deleted. You may lack permission to manage well equipment."
    );
  }
  revalidatePath(`/production/wells/${wellId}`);
}
