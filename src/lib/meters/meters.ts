import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcAllRows } from "@/lib/supabase/paged-rpc";
import { withFacilitySlugs } from "@/lib/facilities/slug-route";
import { serviceOrgFor } from "@/lib/supabase/service-org";
import type { AllocationMethod } from "@/lib/tanks/tanks";
import { ensureFacilityFolder, renameFacilityFolder } from "@/lib/files/facility-folder";
import { meterDisplayName } from "@/lib/meters/meter-name";
import { isMissingFunction } from "@/lib/supabase/errors";
import { addMeterAllocationsForWells } from "@/lib/meters/allocations";

/**
 * Gas meter data-access — the gas analogue of `@/lib/tanks/tanks`. A meter
 * measures a well's (or a commingled group's) gas production in MCF.
 *
 * Same client-injected idiom as tanks: every helper takes the caller's
 * request-scoped RLS client (`getSupabaseServer()`) first; the `meters` /
 * `meter_readings` RLS policies scope reads and writes to the
 * caller's org (never hand these the service-role admin client).
 *
 * Simpler than a tank: the pumper enters DAILY MCF directly — no cumulative
 * index, no strapping, no multiplier, no conversion. A reading *is* that day's
 * MCF (the orifice/differential/separator/heater fields are context/QA, never
 * inputs to a volume formula). Allocation mirrors tanks — `straight` (fixed %)
 * or `weighted` (well-test gas rate × uptime) per meter; the split lives in
 * `@/lib/meters/allocations` and the downtime-adjusted derivation in
 * `@/lib/meters/engine`. See docs/plans/gas-meters.md.
 */

/** What a meter measures. Gas reads direct daily MCF; water reads a cumulative
 * barrels index (delta-derived, like a disposal well). */
export type MeterSubstance = "gas" | "water";

/** A meter with its gatherer + optional single-well link. */
export interface Meter {
  id: string;
  /**
   * DERIVED display name — "Dofflemeyer M1234", the lease plus `meterNo`. See
   * `meterDisplayName`. There is no stored meter name any more: `meters.name`
   * is neither read nor written, so this is the only name a meter has.
   */
  name: string;
  /** Resolved lease name (joined), or "" when unassigned. Read-only. */
  lease: string;
  /** The identifier the gatherer uses for this meter on its volume statements. */
  meterNo: string;
  /** Assigned gatherer id (People → Gatherers), or null. */
  gathererId: string | null;
  /** Resolved gatherer name (joined), or "" if unassigned. Read-only. */
  gatherer: string;
  /** The lease this meter belongs to (`meters.lease_id`), or null if unassigned. */
  leaseId: string | null;
  /** How the meter's volume splits to its wells: `straight` (fixed %) or `weighted`. */
  method: AllocationMethod;
  /**
   * The URL segment its detail page routes on — the name, suffixed only when
   * another meter in the org carries the same one. Stamped by the loaders that
   * read the whole set (see `withFacilitySlugs`); absent on rows loaded as a
   * subset, where a link falls back to the id and the page redirects.
   */
  slug?: string;
  /** Gas (direct daily MCF) or water (cumulative barrels index). */
  substance: MeterSubstance;
  active: boolean;
}

/** Fields for creating a meter. `org_id`/`created_by` come from RLS defaults. */
export interface MeterInput {
  meterNo?: string;
  /** The lease this meter sits on — the other half of its derived name. */
  leaseId?: string | null;
  gathererId?: string | null;
  /** Defaults to `gas` when omitted. */
  substance?: MeterSubstance;
  active?: boolean;
}

/** Partial meter patch (only the keys present change). */
export interface MeterPatch {
  meterNo?: string | null;
  /** Move the meter to another lease (or `null` to unassign). Renames it. */
  leaseId?: string | null;
  gathererId?: string | null;
  active?: boolean;
}

/** One daily gas reading on a meter — MCF as reported by the pumper. */
export interface MeterReading {
  id: string;
  meterId: string;
  /** Reading date as an ISO `YYYY-MM-DD` string. */
  date: string;
  /** Reading time as a 24-hour `HH:MM` string, or "" if none. */
  time: string;
  /**
   * Gas: the CURRENT FLOW RATE off the meter face, in MCF/day, which is the rate
   * for the reading's own date. Water: the cumulative barrel index. Entered
   * directly, never computed, and never derived from the other two.
   */
  mcf: number | null;
  /**
   * Gas only: the cumulative counter on the meter at this reading, or null when
   * it was not recorded. Independent of the other two in both directions. The
   * difference between two of these is a measured volume, which is what lets the
   * daily series fill in days nobody read.
   */
  cumulativeMcf: number | null;
  /**
   * Gas only: the volume the meter reports for the calendar day BEFORE `date`,
   * midnight to midnight, or null when it was not recorded.
   *
   * The DEFINITIVE volume for the day it names — a whole day measured by the
   * meter itself, against a counter span (a measured volume spread by a shape
   * the pumper estimated) and a spot rate (not a volume at all). Where it
   * exists, nothing else contributes to that day.
   */
  yesterdayMcf: number | null;
  /** Orifice plate size (context/QA), or null. */
  orifice: number | null;
  /** Differential pressure (context/QA), or null. */
  differential: number | null;
  /** Separator pressure (context/QA), or null. */
  separator: number | null;
  /** Heater temperature/setting (context/QA), or null. */
  heater: number | null;
  /**
   * Injection (tubing) pressure in psi, or null. WATER/SWD meters only — the
   * pressure the pumper read at the injection well this meter feeds. A gas
   * meter's pressure context is `separator`/`differential` instead.
   */
  injectionPressure: number | null;
  /** Casing pressure in psi, or null. Water/SWD meters only (see above). */
  casingPressure: number | null;
  /**
   * Clock time (`HH:MM`) the meter was reset on this reading's date, or null if
   * it was not reset. Annotation only. The derived series detects a reset from
   * the counter going backwards (`buildCounterSpans`), not from this field, so a
   * pumper who forgets the toggle still gets the right numbers.
   */
  resetTime: string | null;
  /** Free-text comments the pumper left with the reading. */
  comments?: string;
}

/** A gauge reading as supplied by the UI / tools. */
export interface MeterReadingInput {
  date: string;
  time?: string;
  /** Current flow rate off the meter face, for the reading's own date. Optional
   *  when another of the three numbers is set. */
  mcf?: number | null;
  /** The meter's cumulative counter. Optional when another of the three is set. */
  cumulativeMcf?: number | null;
  /** Volume for the calendar day BEFORE `date`. Optional when another is set. */
  yesterdayMcf?: number | null;
  orifice?: number | null;
  differential?: number | null;
  separator?: number | null;
  heater?: number | null;
  /** Injection (tubing) psi — water/SWD meters only. */
  injectionPressure?: number | null;
  /** Casing psi — water/SWD meters only. */
  casingPressure?: number | null;
  /** `HH:MM` the meter was reset, or null/"" for no reset. */
  resetTime?: string | null;
  /** Free-text comments the pumper left with the reading. */
  comments?: string;
}

// `name` is deliberately absent: a meter's name is derived from its lease and
// its number (`meterDisplayName`), so the lease is joined and the stored column
// is not read. Nothing writes it either; see `createMeter` / `updateMeter`.
const METER_COLS =
  "id, meter_no, gatherer_id, gatherer:gatherers!gatherer_id(name), lease_id, lease:leases!lease_id(name), substance, active";
const READING_COLS =
  "id, meter_id, reading_date, reading_time, mcf, cumulative_mcf, yesterday_mcf, orifice, differential, separator, heater, " +
  "injection_pressure, casing_pressure, reset_time, comments";

type Sb = SupabaseClient;

interface MeterRow {
  id: string;
  meter_no: string | null;
  gatherer_id: string | null;
  /** Embedded gatherer name from the `gatherer_id` join. */
  gatherer?: { name: string | null } | null;
  lease_id: string | null;
  /** Embedded lease name from the `lease_id` join — half of the meter's name. */
  lease?: { name: string | null } | null;
  allocation_method: string | null;
  substance: string | null;
  active: boolean | null;
}

interface MeterReadingRow {
  id: string;
  meter_id: string;
  reading_date: string;
  reading_time: string | null;
  mcf: number | null;
  cumulative_mcf: number | null;
  yesterday_mcf: number | null;
  orifice: number | null;
  differential: number | null;
  separator: number | null;
  heater: number | null;
  injection_pressure: number | null;
  casing_pressure: number | null;
  reset_time: string | null;
  comments: string | null;
}

function mapMeter(r: MeterRow): Meter {
  const lease = r.lease?.name ?? "";
  const meterNo = r.meter_no ?? "";
  return {
    id: r.id,
    name: meterDisplayName(lease, meterNo),
    lease,
    meterNo,
    gathererId: r.gatherer_id ?? null,
    gatherer: r.gatherer?.name ?? "",
    leaseId: r.lease_id ?? null,
    method: r.allocation_method === "weighted" ? "weighted" : "straight",
    substance: r.substance === "water" ? "water" : "gas",
    active: r.active ?? true,
  };
}

function mapReading(r: MeterReadingRow): MeterReading {
  return {
    id: r.id,
    meterId: r.meter_id,
    date: r.reading_date,
    time: (r.reading_time ?? "").slice(0, 5),
    mcf: r.mcf,
    cumulativeMcf: r.cumulative_mcf,
    yesterdayMcf: r.yesterday_mcf,
    orifice: r.orifice ?? null,
    differential: r.differential ?? null,
    separator: r.separator ?? null,
    heater: r.heater ?? null,
    injectionPressure: r.injection_pressure ?? null,
    casingPressure: r.casing_pressure ?? null,
    resetTime: r.reset_time ? r.reset_time.slice(0, 5) : null,
    comments: r.comments || undefined,
  };
}

/**
 * Meter order, everywhere a list is returned: by the DERIVED name, read the way
 * a person reads it ("Dofflemeyer M9" before "Dofflemeyer M10"). It cannot be an
 * `.order("name")` on the query any more — that column is retired — so the sort
 * happens here, after mapping.
 */
function byMeterName(a: Meter, b: Meter): number {
  return a.name.localeCompare(b.name, "en", { numeric: true });
}

// --- Meters: reads ---------------------------------------------------------

/**
 * Meters in the org (RLS-scoped), ordered by name. Filtered by `substance`,
 * which DEFAULTS TO `gas`: every existing caller (gas production, revenue,
 * analytics, the gas engine) is gas-only, so water/SWD meters never leak into
 * gas math. Pass `"water"` for the SWD surface, or `"all"` for both.
 */
export async function listMeters(
  sb: Sb,
  substance: MeterSubstance | "all" = "gas",
  opts?: { orgId?: string }
): Promise<Meter[]> {
  let q = sb.from("meters").select(METER_COLS);
  if (substance !== "all") q = q.eq("substance", substance);
  // `orgId` scopes service-role (admin) reads that have no RLS org context (the
  // digest cron); RLS callers omit it. See the note on `listTanks`.
  if (opts?.orgId) q = q.eq("org_id", opts.orgId);
  const { data, error } = await q;
  if (error) throw new Error(`listMeters: ${error.message}`);
  // Slugged against the same substance-filtered list the matching detail page
  // resolves against: gas meters answer `/production/meters/[meter]`
  // (`getMeters()`), water meters `/disposal/meters/[meter]`
  // (`getWaterMeters()`). See `withFacilitySlugs`.
  return withFacilitySlugs(
    ((data ?? []) as unknown as MeterRow[]).map(mapMeter).sort(byMeterName)
  );
}

/** Meters a well is allocated to (via `meter_well_allocations`), by name.
 * Substance-filtered (default gas) so a well's gas view never shows SWD meters. */
export async function listWellMeters(
  sb: Sb,
  wellId: string,
  substance: MeterSubstance | "all" = "gas"
): Promise<Meter[]> {
  const { data: allocs, error: aErr } = await sb
    .from("meter_well_allocations")
    .select("meter_id")
    .eq("well_id", wellId);
  if (aErr) throw new Error(`listWellMeters: ${aErr.message}`);
  const ids = [...new Set((allocs ?? []).map((r) => r.meter_id as string))];
  if (ids.length === 0) return [];
  let q = sb.from("meters").select(METER_COLS).in("id", ids);
  if (substance !== "all") q = q.eq("substance", substance);
  const { data, error } = await q;
  if (error) throw new Error(`listWellMeters: ${error.message}`);
  return ((data ?? []) as unknown as MeterRow[]).map(mapMeter).sort(byMeterName);
}

/** Meters assigned to a lease (`meters.lease_id`), ordered by name.
 * Substance-filtered (default gas). */
export async function listLeaseMeters(
  sb: Sb,
  leaseId: string,
  substance: MeterSubstance | "all" = "gas"
): Promise<Meter[]> {
  let q = sb.from("meters").select(METER_COLS).eq("lease_id", leaseId);
  if (substance !== "all") q = q.eq("substance", substance);
  const { data, error } = await q;
  if (error) throw new Error(`listLeaseMeters: ${error.message}`);
  return ((data ?? []) as unknown as MeterRow[]).map(mapMeter).sort(byMeterName);
}

/** A single meter by id, or null if it doesn't exist / isn't visible. */
export async function getMeter(sb: Sb, id: string): Promise<Meter | null> {
  const { data, error } = await sb
    .from("meters")
    .select(METER_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getMeter: ${error.message}`);
  return data ? mapMeter(data as unknown as MeterRow) : null;
}

// --- Meters: writes --------------------------------------------------------

/** Create a meter; returns its id. `org_id` is assigned by RLS. */
export async function createMeter(
  sb: Sb,
  input: MeterInput
): Promise<{ id: string }> {
  const { data, error } = await sb
    .from("meters")
    .insert({
      meter_no: input.meterNo || null,
      lease_id: input.leaseId || null,
      gatherer_id: input.gathererId || null,
      substance: input.substance ?? "gas",
      active: input.active ?? true,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createMeter: ${error.message}`);
  // The folder is named after the meter, and the meter's name is derived from
  // its lease — an id here, and absent entirely on an unassigned meter. Read the
  // row back and let `mapMeter` name it.
  await ensureFacilityFolder(
    sb,
    "meter",
    data.id,
    (await getMeter(sb, data.id))?.name ?? meterDisplayName("", input.meterNo),
    input.substance ?? "gas"
  );
  return { id: data.id };
}

/** Update a meter's fields (only the keys present in `patch` change). */
export async function updateMeter(
  sb: Sb,
  id: string,
  patch: MeterPatch
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.meterNo !== undefined) update.meter_no = patch.meterNo || null;
  if (patch.leaseId !== undefined) update.lease_id = patch.leaseId || null;
  if (patch.gathererId !== undefined)
    update.gatherer_id = patch.gathererId || null;
  if (patch.active !== undefined) update.active = patch.active;
  if (Object.keys(update).length === 0) return;

  const { error } = await sb.from("meters").update(update).eq("id", id);
  if (error) throw new Error(`updateMeter: ${error.message}`);
  // The derived name moves when either INPUT moves. There is no name field to
  // trigger off any more; the number and the lease are both editable here, and
  // moving a meter to another lease renames it exactly as renumbering does.
  if (patch.meterNo !== undefined || patch.leaseId !== undefined) {
    const renamed = await getMeter(sb, id);
    if (renamed) await renameFacilityFolder(sb, "meter", id, renamed.name);
  }
}

/**
 * Delete a meter — a SOFT delete (2026081800200_facility_soft_delete.sql): the
 * row is stamped `deleted_at` and the RLS policies stop returning it, so its
 * readings, allocations and volume statements survive instead of cascading
 * away. RLS scopes it to the caller's org and gates it on
 * `manage_well_production`.
 */
export async function deleteMeter(sb: Sb, id: string): Promise<void> {
  // See `deleteTank` — the stamp goes through the security-definer RPC.
  const { error } = await sb.rpc("soft_delete_facility", {
    p_kind: "meter",
    p_id: id,
  });
  if (error) throw new Error(`deleteMeter: ${error.message}`);
}

// --- Meter readings --------------------------------------------------------

/**
 * A meter's readings (excluding soft-deleted), oldest first.
 *
 * Paginated: PostgREST caps a single response at 1000 rows, so a meter with more
 * than that would otherwise return only the oldest 1000 (silently cutting the
 * table off mid-history). We page through in 1000-row windows until drained.
 */
export async function listMeterReadings(
  sb: Sb,
  meterId: string
): Promise<MeterReading[]> {
  // The one-meter form of `listReadingsByMeter`, and it goes through the same
  // RPC for the same reason: narrowing to one meter does not avoid the per-row
  // `current_org_id()` in the read policy, and callers run this in a LOOP —
  // `gasDailyForMeters` walks every meter on a lease — so the predicate is paid
  // once per reading per meter. /leases timed out on it.
  return [...(await listReadingsByMeter(sb, [meterId])).values()].flat();
}

/**
 * Readings for MANY meters in one round trip, keyed by meter id and oldest-first
 * within each — the bulk form of `listMeterReadings`, for org-wide roll-ups that
 * would otherwise fire one query per meter (the disposal index, the Water
 * Disposed report). Meters with no readings are absent from the map.
 */
export async function listReadingsByMeter(
  sb: Sb,
  meterIds: string[],
  /**
   * ISO day. Only readings on or after it, plus each meter's last reading
   * before it (the counter baseline the first in-window delta needs). Unset
   * reads the whole history. See migration 2026090900200.
   */
  from?: string
): Promise<Map<string, MeterReading[]>> {
  if (process.env.PERF_TRACE_BATCH === "1") {
    // Measurement only: which caller issued this bulk read. A reading query
    // that starts a wave late is only fixable once its requester is known.
    console.info(`[read] listReadingsByMeter opened by ${new Error().stack?.split("\n")[2]?.trim()}`);
  }
  const out = new Map<string, MeterReading[]>();
  if (meterIds.length === 0) return out;
  // Through the RPC (2026081700500), which resolves the org and the capability
  // ONCE. Read as a plain PostgREST query the row-security predicate ran
  // `current_org_id()` per row — four subqueries each, across every reading on
  // every meter — and re-ran the whole thing for each 1,000-row page, which is
  // what timed /production out. Still paged (the cap is PostgREST's and applies
  // to a function's rows too), but the pages go out together: see `rpcAllRows`.
  // Service-role callers pass their org explicitly (2026081900100); a
  // request-scoped client passes null and resolves its own.
  const base = { ids: meterIds, p_org: serviceOrgFor(sb) };
  let { rows, error } = await rpcAllRows<MeterReadingRow>(
    sb,
    "meter_readings_for_meters",
    from ? { ...base, p_from: from } : base,
    { chunkKey: "ids" }
  );
  if (error && from && isMissingFunction(error)) {
    // The windowed overload is missing until 2026090900200 is pushed. Reading
    // the whole history is slower, not wrong, so do that rather than fail.
    ({ rows, error } = await rpcAllRows<MeterReadingRow>(sb, "meter_readings_for_meters", base, { chunkKey: "ids" }));
  }
  if (error) {
    if (isMissingFunction(error)) {
      // The function is missing until that migration is pushed. The old query
      // is slow, not wrong, so fall back to it rather than to a blank page.
      return listReadingsByMeterFallback(sb, meterIds);
    }
    throw new Error(`listReadingsByMeter: ${error.message}`);
  }
  for (const row of rows) {
    const r = mapReading(row);
    const list = out.get(r.meterId);
    if (list) list.push(r);
    else out.set(r.meterId, [r]);
  }
  return out;
}

/** {@link listReadingsByMeter} before 2026081700500 — the read that times out on
 *  a large history, kept only for the window before the migration is pushed. */
async function listReadingsByMeterFallback(
  sb: Sb,
  meterIds: string[]
): Promise<Map<string, MeterReading[]>> {
  const out = new Map<string, MeterReading[]>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("meter_readings")
      .select(READING_COLS)
      .in("meter_id", meterIds)
      .is("deleted_at", null)
      .order("reading_date", { ascending: true })
      .order("reading_time", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listReadingsByMeter: ${error.message}`);
    const page = (data ?? []) as unknown as MeterReadingRow[];
    for (const row of page) {
      const r = mapReading(row);
      const list = out.get(r.meterId);
      if (list) list.push(r);
      else out.set(r.meterId, [r]);
    }
    if (page.length < PAGE) break;
  }
  return out;
}

/**
 * Current MCF/day for every meter in the org, keyed by meter id — the latest
 * (by date, then time) non-deleted reading. Powers the Meters list without an
 * N+1. Meters with no readings are absent (callers treat that as 0).
 */
export async function latestMcfByMeter(
  sb: Sb
): Promise<Record<string, number>> {
  // One row per meter, resolved in the database (2026081700200, made org-scoped
  // and SECURITY DEFINER in 2026081700400 — see the tanks twin: the row-security
  // predicate, not the data, is what makes an unfiltered read time out).
  // This used to select EVERY non-deleted reading ordered by date and keep the
  // last one seen per meter. PostgREST caps the rows it returns, but Postgres
  // still sorts the whole table to find them, so the cost grew with history
  // until the dashboard died on `canceling statement due to statement timeout`.
  const { data, error } = await sb.rpc("latest_meter_readings");
  if (!error) {
    const out: Record<string, number> = {};
    for (const r of (data ?? []) as { meter_id: string; mcf: number | null }[]) {
      out[r.meter_id] = r.mcf ?? 0;
    }
    return out;
  }
  // The function is missing until that migration is pushed. Fall back to one
  // indexed lookup per meter rather than to the query that timed out: chattier,
  // but every one of them is a single row off `meter_readings_meter_date_idx`.
  if (!isMissingFunction(error)) {
    throw new Error(`latestMcfByMeter: ${error.message}`);
  }
  return latestMcfPerMeterFallback(sb);
}

async function latestMcfPerMeterFallback(
  sb: Sb
): Promise<Record<string, number>> {
  // `meters` has no soft-delete column; a removed meter is a deleted row.
  const { data: meterRows, error: meterErr } = await sb
    .from("meters")
    .select("id");
  if (meterErr) throw new Error(`latestMcfByMeter: ${meterErr.message}`);

  const ids = ((meterRows ?? []) as { id: string }[]).map((m) => m.id);
  const out: Record<string, number> = {};
  const BATCH = 8;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((id) =>
        sb
          .from("meter_readings")
          .select("meter_id, mcf")
          .eq("meter_id", id)
          .is("deleted_at", null)
          .order("reading_date", { ascending: false })
          // Nulls first on the way down: a reading with no clock time was the
          // last of its date under the ascending read this replaces.
          .order("reading_time", { ascending: false, nullsFirst: true })
          .limit(1)
          .maybeSingle<{ meter_id: string; mcf: number | null }>()
      )
    );
    for (const { data, error } of results) {
      if (error) throw new Error(`latestMcfByMeter: ${error.message}`);
      if (data) out[data.meter_id] = data.mcf ?? 0;
    }
  }
  return out;
}

/** Null out a blank/non-finite optional numeric field. */
function optNum(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

/** Record a daily MCF reading on a meter. Returns its id. */
export async function addMeterReading(
  sb: Sb,
  meterId: string,
  reading: MeterReadingInput
): Promise<{ id: string }> {
  const { data, error } = await sb
    .from("meter_readings")
    .insert({
      meter_id: meterId,
      reading_date: reading.date,
      // Pin a blank time to noon so (meter, date, time) uniqueness is stable and a
      // timeless reading anchors mid-day (a neutral guess that minimizes interval
      // skew against readings that DO carry a time), not at the day's edge.
      reading_time: reading.time || "12:00",
      mcf: optNum(reading.mcf),
      cumulative_mcf: optNum(reading.cumulativeMcf),
      yesterday_mcf: optNum(reading.yesterdayMcf),
      orifice: optNum(reading.orifice),
      differential: optNum(reading.differential),
      separator: optNum(reading.separator),
      heater: optNum(reading.heater),
      injection_pressure: optNum(reading.injectionPressure),
      casing_pressure: optNum(reading.casingPressure),
      reset_time: reading.resetTime || null,
      comments: reading.comments?.trim() || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`addMeterReading: ${error.message}`);
  return { id: data.id };
}

/**
 * Bulk-insert many meter readings in one round trip per chunk — the fast path for
 * an approval landing hundreds/thousands of rows (row-by-row inserts made that as
 * many sequential DB calls). Callers must dedup first: a duplicate
 * `(meter_id, reading_date, reading_time)` aborts its chunk. Returns rows inserted.
 */
export async function addMeterReadings(
  sb: Sb,
  items: { meterId: string; reading: MeterReadingInput }[]
): Promise<number> {
  if (items.length === 0) return 0;
  const records = items.map(({ meterId, reading }) => ({
    meter_id: meterId,
    reading_date: reading.date,
    // Blank time → noon (see addMeterReading): stable key + mid-day anchor.
    reading_time: reading.time || "12:00",
    mcf: optNum(reading.mcf),
    cumulative_mcf: optNum(reading.cumulativeMcf),
    yesterday_mcf: optNum(reading.yesterdayMcf),
    orifice: optNum(reading.orifice),
    differential: optNum(reading.differential),
    separator: optNum(reading.separator),
    heater: optNum(reading.heater),
    injection_pressure: optNum(reading.injectionPressure),
    casing_pressure: optNum(reading.casingPressure),
    reset_time: reading.resetTime || null,
    comments: reading.comments?.trim() || null,
  }));
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const { data, error } = await sb
      .from("meter_readings")
      .insert(records.slice(i, i + CHUNK))
      .select("id");
    if (error) throw new Error(`addMeterReadings: ${error.message}`);
    inserted += data?.length ?? 0;
  }
  return inserted;
}

/** Update a reading, scoped to its meter. `updatedBy` stamps the audit trail. */
export async function updateMeterReading(
  sb: Sb,
  meterId: string,
  id: string,
  patch: MeterReadingInput & { updatedBy?: string | null }
): Promise<void> {
  const update: Record<string, unknown> = {
    reading_date: patch.date,
    // Blank time → noon (see addMeterReading): stable key + mid-day anchor.
    reading_time: patch.time || "12:00",
    mcf: optNum(patch.mcf),
    cumulative_mcf: optNum(patch.cumulativeMcf),
    yesterday_mcf: optNum(patch.yesterdayMcf),
    orifice: optNum(patch.orifice),
    differential: optNum(patch.differential),
    separator: optNum(patch.separator),
    heater: optNum(patch.heater),
    injection_pressure: optNum(patch.injectionPressure),
    casing_pressure: optNum(patch.casingPressure),
    reset_time: patch.resetTime || null,
    comments: patch.comments?.trim() || null,
  };
  if (patch.updatedBy !== undefined) update.updated_by = patch.updatedBy;

  const { error } = await sb
    .from("meter_readings")
    .update(update)
    .eq("id", id)
    .eq("meter_id", meterId);
  if (error) throw new Error(`updateMeterReading: ${error.message}`);
}

/** Soft-delete a reading (stamps `deleted_at/by`), scoped to its meter. */
export async function softDeleteMeterReading(
  sb: Sb,
  meterId: string,
  id: string,
  deletedBy: string | null = null
): Promise<void> {
  const { error } = await sb
    .from("meter_readings")
    .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
    .eq("id", id)
    .eq("meter_id", meterId);
  if (error) throw new Error(`softDeleteMeterReading: ${error.message}`);
}

// Meter comments moved to the shared facility thread — `@/lib/comments`. An SWD
// meter is the same `meters` row as a gas meter, so both pages read one thread.

/**
 * Put a well on exactly these GAS meters, and off any other.
 *
 * The counterpart of `setWellTanks`: a well sells its gas through one meter
 * on most leases and through two where the lease is split, and until now the
 * only way to say so was the meter's own allocation panel, one meter at a time.
 *
 * Shares are shares OF ONE METER, so a well joining a meter nothing else is on
 * takes the whole of it and one joining a meter that already has wells starts at
 * 0% for the operator to split — inventing a share here would take volume off
 * the wells already there.
 */
export async function setWellMeters(
  sb: Sb,
  wellId: string,
  meterIds: string[],
  /** A producer sells gas through gas meters; a disposal well is measured by
   *  water meters. One edit must never detach the other's rows. */
  substance: "gas" | "water" = "gas"
): Promise<void> {
  const wanted = [...new Set(meterIds.filter(Boolean))];

  const { data: rows, error: rErr } = await sb
    .from("meter_well_allocations")
    .select("meter_id, meters!inner(substance)")
    .eq("well_id", wellId)
    .eq("meters.substance", substance);
  if (rErr) throw new Error(`setWellMeters (list): ${rErr.message}`);

  const detachIds = ((rows ?? []) as { meter_id: string }[])
    .map((r) => r.meter_id)
    .filter((id) => !wanted.includes(id));
  if (detachIds.length > 0) {
    const { error } = await sb
      .from("meter_well_allocations")
      .delete()
      .eq("well_id", wellId)
      .in("meter_id", detachIds);
    if (error) throw new Error(`setWellMeters (detach): ${error.message}`);
  }

  for (const meterId of wanted) {
    // Read the rows rather than asking for a HEAD count: a meter has a handful
    // of wells, and the counting form returns no body, so its errors arrive
    // with an empty message and nothing to debug from.
    const { data: onMeter, error: cErr } = await sb
      .from("meter_well_allocations")
      .select("well_id")
      .eq("meter_id", meterId);
    if (cErr) {
      throw new Error(
        `setWellMeters (existing wells): ${cErr.message || cErr.code || "unknown error"}`
      );
    }
    const others = ((onMeter ?? []) as { well_id: string }[]).filter(
      (r) => r.well_id !== wellId
    );
    await addMeterAllocationsForWells(sb, meterId, [wellId], others.length ? 0 : 100);
  }
}
