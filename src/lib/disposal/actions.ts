"use server";

/**
 * Server actions for injection / SWD wells and their disposal readings (GBC-9).
 *
 * All writes go through the request-scoped RLS client, whose `disposal_readings`
 * / `wells` policies gate writes on `manage_well_production` and stamp `org_id`
 * from the session — so a caller can never write outside their org regardless of
 * the ids passed.
 */

import { revalidatePath } from "next/cache";
import { readingSlot, sameValue } from "@/lib/readings/merge";
import { getSupabaseServer } from "@/lib/supabase/server";
import { assertWellCapacity } from "@/lib/billing/subscription";
import { getInjectionWells } from "@/lib/disposal/disposal";
import {
  isWellMetered,
  loadDisposalSeriesByWell,
} from "@/lib/disposal/well-meters";
import { summarizeDisposal } from "@/lib/disposal/report";
import {
  inWindow,
  resolveWindow,
  type ReportWindowKind,
} from "@/lib/reports/windows";
import { uploadFiles, type UploadResult } from "@/lib/files/actions";
import { getOrCreateWellFolderId } from "@/lib/wells/well-folder";
import { ensureFacilityFolder } from "@/lib/files/facility-folder";
import type {
  DisposalReadingInput,
  WaterDisposedReport,
} from "@/lib/disposal/types";
import type { WellType } from "@/lib/wells/wells";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "injection-well"
  );
}

/** Flip a well between producer and injection/SWD. */
export async function setWellType(
  wellId: string,
  type: WellType
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("wells").update({ type }).eq("id", wellId);
  if (error) throw new Error(`setWellType: ${error.message}`);
  revalidatePath("/disposal");
  revalidatePath(`/wells/${wellId}`);
  revalidatePath("/production");
}

/**
 * Create a new injection/SWD well (a `wells` row with `type = 'injection'`).
 * Unlike `createWell`, this seeds no oil tank — an injection well doesn't gauge
 * produced oil. Enforces the subscription's well cap. Returns the new id.
 */
export async function createInjectionWell(
  name: string
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  await assertWellCapacity(sb);

  const base = slugify(name);
  const { data: existing, error: lookupError } = await sb
    .from("wells")
    .select("id")
    .like("id", `${base}%`);
  if (lookupError) throw new Error(`createInjectionWell: ${lookupError.message}`);

  const ids = new Set((existing ?? []).map((r) => r.id));
  let id = base;
  let n = 2;
  while (ids.has(id)) id = `${base}-${n++}`;

  const { error } = await sb
    .from("wells")
    .insert({ id, name: name.trim() || id, type: "injection" });
  if (error) throw new Error(`createInjectionWell: ${error.message}`);

  // Its folder in the file tree. Injection wells are `wells` rows written
  // directly here rather than through `createWell`, so the hook has to be
  // repeated; without it an SWD well would be the one facility with no folder.
  await ensureFacilityFolder(sb, "well", id, name.trim() || id, "injection");

  revalidatePath("/disposal");
  revalidatePath("/production");
  return { id };
}

/**
 * Refuse a new hand-entered reading on a well a water meter already measures.
 *
 * A metered disposal well's volume IS its meter's throughput (`well-series.ts`),
 * so a `disposal_readings` row entered now would be a second, conflicting
 * measurement of the same barrels — the pumper enters it on the meter instead.
 * Editing and deleting existing rows stays open: those are pre-meter history,
 * and it must remain correctable.
 */
async function assertUnmetered(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  wellId: string
): Promise<void> {
  if (await isWellMetered(sb, wellId)) {
    throw new Error(
      "This SWD well is measured by a meter — record the reading on the meter, not the well."
    );
  }
}

/** Map a UI reading input to its `disposal_readings` row shape. */
function readingRow(wellId: string, input: DisposalReadingInput) {
  return {
    injection_well_id: wellId,
    reading_date: input.date,
    // Pin a blank time to midnight so (well, date, time) uniqueness is stable.
    reading_time: input.time || "00:00",
    injected_bbls: input.injectedBbls ?? null,
    injection_pressure: input.injectionPressure ?? null,
    casing_pressure: input.casingPressure ?? null,
    meter_reading: input.meterReading ?? null,
    source_well_id: input.sourceWellId || null,
    notes: input.notes?.trim() || null,
  };
}

/** Record a disposal reading for an injection well; returns the new row id. */
export async function addDisposalReading(
  wellId: string,
  input: DisposalReadingInput
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  await assertUnmetered(sb, wellId);
  const { data, error } = await sb
    .from("disposal_readings")
    .insert(readingRow(wellId, input))
    .select("id")
    .single();
  if (error) throw new Error(`addDisposalReading: ${error.message}`);
  revalidatePath("/disposal");
  return { id: data.id };
}

/** The columns a disposal reading carries, for the last-wins merge. */
const DISPOSAL_COLUMNS = [
  "injected_bbls",
  "injection_pressure",
  "casing_pressure",
  "meter_reading",
  "source_well_id",
  "notes",
] as const;

/**
 * The columns a source actually REPORTED. A field left null/undefined is absent
 * from the patch, which is what keeps an injection log that prints barrels alone
 * from blanking the pressures already on file for that day.
 */
function disposalPatch(
  input: DisposalReadingInput
): Record<string, number | string> {
  const patch: Record<string, number | string> = {};
  const put = (column: string, value: number | null | undefined) => {
    if (value != null) patch[column] = value;
  };
  put("injected_bbls", input.injectedBbls);
  put("injection_pressure", input.injectionPressure);
  put("casing_pressure", input.casingPressure);
  put("meter_reading", input.meterReading);
  if (input.sourceWellId) patch.source_well_id = input.sourceWellId;
  const notes = input.notes?.trim();
  if (notes) patch.notes = notes;
  return patch;
}

/**
 * What is already on file for this well between two dates, keyed `date|slot`.
 *
 * Paged: PostgREST caps a response at 1,000 rows, and a history import covers
 * years — reading one page would make every row past the first thousand look
 * absent, and the upsert would collide with rows the merge never saw.
 */
async function priorDisposalRows(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  wellId: string,
  fromDate: string,
  toDate: string
): Promise<Map<string, Record<string, unknown>>> {
  const prior = new Map<string, Record<string, unknown>>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("disposal_readings")
      .select(`reading_date, reading_time, ${DISPOSAL_COLUMNS.join(", ")}`)
      .eq("injection_well_id", wellId)
      .gte("reading_date", fromDate)
      .lte("reading_date", toDate)
      .order("reading_date", { ascending: true })
      .order("reading_time", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`addDisposalReadings (existing): ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const row of page) {
      // A legacy NULL-time row can never be the upsert's conflict target
      // (NULL != NULL), so merging into one would leave the ghost in place and
      // insert a second row beside it.
      if (row.reading_time == null) continue;
      const slot = readingSlot(row.reading_time as string);
      prior.set(`${row.reading_date as string}|${slot}`, row);
    }
    if (page.length < PAGE) break;
  }
  return prior;
}

/**
 * Bulk-write many disposal readings in one round trip per chunk — the fast path
 * for an approval landing hundreds/thousands of rows. Returns the number of rows
 * written (inserted or corrected); the rest of the batch was already on file
 * saying the same thing.
 *
 * An UPSERT, not an insert. `(injection_well_id, reading_date, reading_time)` is
 * unique, so a re-approved proposal, a re-uploaded log, or a file that lists one
 * day twice used to fail the whole batch on that constraint and land nothing —
 * which is what a 1,033-row Fannie Young import did. Each slot is instead merged
 * over what is on file, field by field, so a later document corrects the fields
 * it reports and leaves the others alone.
 */
export async function addDisposalReadings(
  wellId: string,
  inputs: DisposalReadingInput[]
): Promise<number> {
  if (inputs.length === 0) return 0;
  const sb = await getSupabaseServer();
  await assertUnmetered(sb, wellId);

  const dates = inputs.map((i) => i.date).sort();
  const prior = await priorDisposalRows(sb, wellId, dates[0], dates[dates.length - 1]);

  // Every row of the batch carries the full column set — an upsert writes the
  // payload's columns to all of its rows, so a uniform shape is what lets one
  // statement mix inserts with per-row merges.
  const blank: Record<string, unknown> = {};
  for (const column of DISPOSAL_COLUMNS) blank[column] = null;

  const staged = new Map<string, Record<string, unknown>>();
  for (const input of inputs) {
    // A blank time is pinned to midnight so the uniqueness key is stable.
    const time = input.time || "00:00";
    const key = `${input.date}|${readingSlot(time)}`;
    const patch = disposalPatch(input);
    // A row already staged for this slot is the incumbent for the next line
    // naming it: two lines for one timestamp are a correction, not a collision.
    const incumbent = staged.get(key) ?? prior.get(key);

    const carried: Record<string, unknown> = {};
    if (incumbent) {
      const changes = Object.entries(patch).some(
        ([column, value]) => !sameValue(incumbent[column], value)
      );
      // Nothing new to say about this slot — leave the stored row untouched
      // rather than rewriting it with its own values.
      if (!changes) continue;
      for (const column of DISPOSAL_COLUMNS) carried[column] = incumbent[column];
    }

    staged.set(key, {
      injection_well_id: wellId,
      reading_date: input.date,
      reading_time: time,
      ...blank,
      ...carried,
      ...patch,
    });
  }

  const records = [...staged.values()];
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    const { error } = await sb
      .from("disposal_readings")
      .upsert(records.slice(i, i + CHUNK), {
        onConflict: "injection_well_id,reading_date,reading_time",
        // The merge above already folded the incumbent's unreported fields into
        // the payload, so updating in place corrects the row without blanking it.
        ignoreDuplicates: false,
      });
    if (error) throw new Error(`addDisposalReadings: ${error.message}`);
  }
  revalidatePath("/disposal");
  return records.length;
}

/** What a gauge reading records: when it was taken, and the two pressures. */
export interface DisposalGaugeReadingInput {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** `HH:mm`; blank is pinned to midnight, as everywhere else on this table. */
  time: string;
  injectionPressure: number | null;
  casingPressure: number | null;
}

/**
 * Record a GAUGE reading on an injection well — the wellhead pressures at a
 * moment, with no volume attached.
 *
 * Two things make this its own action rather than a call to
 * `addDisposalReading`.
 *
 * It is NOT gated on the well being unmetered. That gate exists because a
 * hand-entered VOLUME would double-count barrels the meter already measured
 * (`assertUnmetered`). A pressure is not a volume, no meter reports it, and a
 * metered well's pressures are exactly as worth recording as an unmetered one's.
 *
 * And it MERGES rather than inserts. `(well, date, time)` is unique, so gauging
 * at the same stamp as an existing reading would otherwise fail the whole write;
 * worse, a plain upsert would blank that row's barrels, because this form has no
 * field for them and would send null. It writes only the columns it reports, the
 * same rule the bulk importer follows (`disposalPatch`).
 */
export async function addDisposalGaugeReading(
  wellId: string,
  input: DisposalGaugeReadingInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const time = input.time || "00:00";
  const key = `${input.date}|${readingSlot(time)}`;
  const prior = await priorDisposalRows(sb, wellId, input.date, input.date);
  const incumbent = prior.get(key);

  const carried: Record<string, unknown> = {};
  for (const column of DISPOSAL_COLUMNS) {
    carried[column] = incumbent ? incumbent[column] : null;
  }

  const { error } = await sb.from("disposal_readings").upsert(
    {
      injection_well_id: wellId,
      reading_date: input.date,
      reading_time: time,
      ...carried,
      injection_pressure: input.injectionPressure,
      casing_pressure: input.casingPressure,
    },
    {
      onConflict: "injection_well_id,reading_date,reading_time",
      ignoreDuplicates: false,
    }
  );
  if (error) throw new Error(`addDisposalGaugeReading: ${error.message}`);
  revalidatePath("/disposal");
}

/**
 * "Add History" for a disposal / SWD well — the exact analogue of the gas
 * `uploadMeterHistory`. Upload a document (scanned injection logs), let the shared
 * ingest pipeline parse it, and hand back proposals for the user to preview +
 * approve in the IngestApprovalModal. `disposalReadings` is a well-scoped ingest
 * type, so the readings are pre-targeted at THIS well via `defaultWellId` (the
 * approval modal's Well picker is pre-seeded to it). Nothing is written until the
 * user approves.
 */
export async function uploadDisposalWellHistory(
  wellId: string,
  formData: FormData
): Promise<UploadResult> {
  const sb = await getSupabaseServer();

  // File the document under the injection well's folder (the same `Wells/<id>`
  // folder the Files page uses); fall back to the Files root if it can't be made.
  let folderId = "root";
  try {
    folderId = await getOrCreateWellFolderId(sb, wellId);
  } catch (err) {
    console.error("uploadDisposalWellHistory: well folder unavailable, using root", err);
  }

  return uploadFiles(folderId, formData, {
    // Pre-target every well-scoped row (disposalReadings) at THIS injection well.
    defaultWellId: wellId,
  });
}

/** Update a disposal reading, scoped to its well. */
export async function updateDisposalReading(
  wellId: string,
  id: string,
  input: DisposalReadingInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("disposal_readings")
    .update(readingRow(wellId, input))
    .eq("id", id)
    .eq("injection_well_id", wellId);
  if (error) throw new Error(`updateDisposalReading: ${error.message}`);
  revalidatePath("/disposal");
}

/** Delete a disposal reading, scoped to its well. */
export async function deleteDisposalReading(
  wellId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("disposal_readings")
    .delete()
    .eq("id", id)
    .eq("injection_well_id", wellId);
  if (error) throw new Error(`deleteDisposalReading: ${error.message}`);
  revalidatePath("/disposal");
}

/**
 * Load the company-wide Water Disposed report (totals + per-SWD-well detail) for
 * a trailing window. THE loader for this report — the hub's View modal, the
 * export route, and any digest all call this one function, so the same window can
 * never produce two different sets of numbers.
 *
 * Volume comes from each well's resolved series: its meters' throughput, falling
 * back to hand-entered readings only where no meter was wired in.
 */
export async function loadWaterDisposedReport(
  /** Trailing window; the report is meaningless without one (see `windows.ts`). */
  windowKind: ReportWindowKind = "30d"
): Promise<{
  report: WaterDisposedReport;
  windowLabel: string;
  windowSlug: string;
}> {
  const sb = await getSupabaseServer();
  const wells = await getInjectionWells();
  const seriesByWell = await loadDisposalSeriesByWell(
    sb,
    wells.map((w) => w.id)
  );
  const window = resolveWindow(
    windowKind,
    new Date().toISOString().slice(0, 10)
  );

  const rowsByWell = new Map(
    [...seriesByWell.entries()].map(([wellId, series]) => [
      wellId,
      series.rows.filter((r) => inWindow(r.date, window)),
    ])
  );

  return {
    report: summarizeDisposal(
      wells.map((w) => ({ id: w.id, name: w.name })),
      rowsByWell
    ),
    windowLabel: window.label,
    windowSlug: window.slug,
  };
}
