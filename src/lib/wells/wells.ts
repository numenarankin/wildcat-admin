import { hasSupabase } from "@/lib/env";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { memo } from "@/lib/cache/request-cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { findWellFolderId } from "@/lib/wells/well-folder";
import { listAttachedDocuments } from "@/lib/files/attached-documents";
import { attachedWellFile, mergeAttached, withoutAddedAt } from "@/lib/files/attached-pure";
import { wellGasSeriesMeasured } from "@/lib/meters/engine";
import { isWholeDay } from "@/lib/production/partial-day";
import { wellProductionSeries, wellWaterSeries } from "@/lib/tanks/series-loaders";

/**
 * A producing oil well and its current economics.
 *
 * Production figures are daily rates; monetary figures are in US dollars.
 */
/** Producer (the default) or a saltwater-disposal / injection well (GBC-9). */
export type WellType = "producer" | "injection";

export interface Well {
  /** Stable identifier / URL slug for the well. */
  id: string;
  /** Operator-assigned well name. */
  name: string;
  /** Whether this is a producing well or an injection/SWD well. */
  type: WellType;
  /** Total measured depth, in feet. */
  depth: number;
  /** Producing formation / zone. */
  zone: string;
  /** Perforated interval, in feet (top–bottom). */
  perforations: string;
  /** County the surface location sits in. */
  county: string;
  /** Surface-location coordinates, free-form (e.g. "31.9686, -102.0779"). */
  coordinates: string;
  /** Date the well was drilled, as an ISO `YYYY-MM-DD` string, or "" if unknown. */
  dateDrilled: string;
  /** Oil production rate, in barrels per day. */
  oilProduction: number;
  /** Gas production rate, in thousand cubic feet (MCF) per day. */
  gasProduction: number;
  /** Produced (salt) water rate, in barrels per day. */
  saltWater: number;
  /** Monthly gross revenue, in US dollars. */
  revenue: number;
  /** Lifting cost, in US dollars per barrel of oil. */
  liftingCost: number;
  /** Monthly profit / loss, in US dollars (negative = loss). */
  pl: number;
  /**
   * Barrels of oil per inch of tank gauge. Readings are entered in gauge inches;
   * the UI multiplies oil production / stock / sales by this to show barrels.
   * Defaults to 1 (1:1, no conversion).
   *
   * The value now lives on the well's default oil tank (`tanks`), not the well
   * itself — this field is derived from it on read so the well UI is unchanged.
   */
  oilBblPerInch: number;
  /** API well number (regulatory identity), or "" if unset. */
  apiWellNo: string;
  /** Texas RRC lease / gas ID the well files under, or "" if unset. */
  rrcLeaseId: string;
  /** Operator's RRC operator number, or "" if unset. */
  rrcOperatorNo: string;
  /**
   * Injection-pump plunger size for a disposal well, as written in the field
   * (`2 1/4"`), or "" if unset. Injection wells only — a producer never shows it.
   */
  plungerSize: string;
  /**
   * Tubing joint lengths in feet, in string order from surface — the well's
   * tubing tally. The joint number is the index + 1 and the tubing depth is the
   * sum, so this array is the whole tally (see {@link tubingCumulative}). Empty
   * when no tally has been recorded.
   */
  tubingJoints: number[];
  /** The lease this well belongs to (`wells.lease_id`), or null if unassigned. */
  leaseId: string | null;
  /** For an injection/SWD well, how its metered disposal total is split across
   * its feeding tanks: `straight` (fixed per-tank %) or `weighted` (water-test
   * rates). Defaults to `straight`; ignored for producers. */
  injectionAllocationMethod: "straight" | "weighted";
  /** Whether the well is active. Inactive = retired (shut-in / sold), kept for
   * history. Defaults to true. A plugged well is always inactive. */
  active: boolean;
  /**
   * The date the hole was plugged (`YYYY-MM-DD`), or null if it has not been.
   *
   * THE flag: a well is plugged if and only if this is set, and the database
   * refuses a plugged well that is also active (`wells_plugged_is_inactive`).
   * There is no second boolean, because "plugged, date unknown" cannot arise:
   * the RRC defines plugged BY the plug date and the settings dialog requires
   * the field. See docs/plans/plugged-wells.md §1.1.
   */
  pluggedAt: string | null;
  /**
   * Wellbore geometry: how the hole was drilled, not what it produces.
   *
   * Null means unknown, which is the honest answer for most older wells: it is
   * seeded from the RRC completion packet and that record only reaches back a
   * few years. See `@/lib/rrc/well-record`, and note that the RRC's own code 1
   * means horizontal, not vertical.
   */
  wellboreProfile: WellboreProfile | null;
}

/** How the hole was drilled. `null` on a `Well` means nobody has said. */
export type WellboreProfile =
  | "vertical"
  | "horizontal"
  | "directional"
  | "sidetrack";

/**
 * Editable well fields written by `createWell` / `updateWell`. Kept here beside
 * `Well` so the write-row mapping (`wellUpdateRow`) and its unit tests live with
 * the read mapping (`mapWell`). `oilBblPerInch` is routed separately onto the
 * well's default oil tank, not through `wellUpdateRow`.
 */
export interface WellInput {
  name: string;
  /** Producer (production) vs injection (disposal) well. `undefined` leaves the
   * current type untouched (so a partial update never reclassifies a well). */
  type?: WellType;
  formation: string;
  county: string;
  depth: number;
  perforations: string;
  dateDrilled: string;
  coordinates: string;
  /** Barrels of oil per inch of gauge (oil reading conversion). Defaults to 1. */
  oilBblPerInch?: number;
  /**
   * Reassign the well to this oil tank (`tanks.id`) — the tank its oil goes to,
   * whose strapping factor then drives the well's conversion. `null` detaches the
   * current one; `undefined` leaves the assignment untouched. Routed onto `tanks`
   * by the actions layer, not through `wellUpdateRow`.
   */
  oilTankIds?: string[];
  /** The GAS meters this well sells through (`meter_well_allocations`). */
  meterIds?: string[];
  /**
   * PRODUCERS only: the saltwater tanks this well's water goes to. Same table as
   * `oilTankIds` (a tank allocation), on the other product — which is why it is
   * a second field and not a wider `oilTankIds`: that one follows the well's
   * TYPE, so on a producer it can only ever mean oil.
   *
   * `undefined` leaves the water side untouched, exactly like the fields above.
   */
  waterTankIds?: string[];
  /** API well number (regulatory identity). */
  apiWellNo?: string;
  /** Texas RRC lease / gas ID. */
  rrcLeaseId?: string;
  /** Operator's RRC operator number. */
  rrcOperatorNo?: string;
  /** Injection-pump plunger size (injection wells only), free-form text.
   * `undefined` leaves it untouched, so a partial update never clears it. */
  plungerSize?: string;
  /** Replace the well's tubing tally with these joint lengths (feet, string order
   * from surface). `undefined` leaves it untouched, so a partial update — a plain
   * settings edit, Orion's update_well — can never wipe a tally. */
  tubingJoints?: number[];
  /**
   * The lease to assign the well to (`wells.lease_id`), or null to unassign.
   * `undefined` leaves the current assignment untouched (so callers that don't
   * manage leases never clobber it).
   */
  leaseId?: string | null;
  /** For an injection/SWD well, the tank -> SWD-well allocation method.
   * `undefined` leaves it untouched. */
  injectionAllocationMethod?: "straight" | "weighted";
  /** Active / retired status. `undefined` leaves it untouched (so a partial
   * update, e.g. the AI tool, never flips a well's status). */
  active?: boolean;
  /**
   * Plug date. `undefined` leaves it untouched, `null` CLEARS it (un-plugging).
   * A caller that sets this must send `active: false` in the same write, or the
   * check constraint rejects the row.
   */
  pluggedAt?: string | null;
  /** Wellbore geometry. `undefined` leaves it untouched; `null` clears it, which
   * is how the settings dialog's blank option means "unknown" rather than
   * "unchanged". */
  wellboreProfile?: WellboreProfile | null;
}

/**
 * Map a `WellInput` to a `wells` DB row for insert/update. Pure and side-effect
 * free so it can be unit-tested directly. Blank text is normalized to null.
 * `oilBblPerInch` is deliberately excluded — it lives on the well's default oil
 * tank and is routed there separately by the actions layer.
 */
/**
 * Feet, rounded to 2 dp. `numeric[]` is exact in Postgres but the running sum
 * happens in float64, so 300 joints of 31.52 ft must read `9,456.00` rather than
 * `9,456.000000000002`.
 */
/**
 * The tubing-tally and shot helpers now live in `@/lib/wells/wells-pure`, which
 * client components import directly — pulling them from here dragged this
 * module's `server-only` graph into the browser bundle and broke the build. See
 * that file's header. Re-exported so every existing server-side import of
 * `@/lib/wells/wells` keeps working.
 */
export {
  tubingCumulative,
  tubingDepth,
  mapTubingJoints,
  isTallyEquipmentLabel,
  fluidOverPump,
  mapShotRow,
  mapPumpingRow,
  pumpingOn,
  wellState,
  partitionProducers,
} from "@/lib/wells/wells-pure";
export type {
  WellShot,
  ShotField,
  ShotRow,
  WellPumping,
  PumpingField,
  PumpingRow,
  WellState,
} from "@/lib/wells/wells-pure";

// `export ... from` re-exports without binding the names locally, and the
// loaders below call them.
import {
  mapTubingJoints,
  mapShotRow,
  mapPumpingRow,
} from "@/lib/wells/wells-pure";
import type {
  WellShot,
  ShotRow,
  WellPumping,
  PumpingRow,
} from "@/lib/wells/wells-pure";

export function wellUpdateRow(input: WellInput) {
  return {
    name: input.name,
    zone: input.formation || null,
    county: input.county || null,
    perforations: input.perforations || null,
    depth: Number.isFinite(input.depth) ? input.depth : null,
    date_drilled: input.dateDrilled || null,
    coordinates: input.coordinates || null,
    api_well_no: input.apiWellNo?.trim() || null,
    rrc_lease_id: input.rrcLeaseId?.trim() || null,
    rrc_operator_no: input.rrcOperatorNo?.trim() || null,
    // Only touch lease_id when the caller explicitly set it, so a plain well
    // edit (or the AI update path) never wipes an existing lease assignment.
    ...(input.leaseId !== undefined ? { lease_id: input.leaseId } : {}),
    // Same guard for active: leave the flag untouched on a partial update.
    ...(input.active !== undefined ? { active: input.active } : {}),
    // ...and for the plug date, where `null` is a real value (un-plugging) and
    // `undefined` means "not my business", so a partial update can never
    // resurrect a plugged well by omission.
    ...(input.pluggedAt !== undefined ? { plugged_at: input.pluggedAt } : {}),
    // ...and for type (producer/injection), so a plain edit never reclassifies.
    ...(input.type !== undefined ? { type: input.type } : {}),
    // ...and for the SWD tank-allocation method (injection wells only).
    ...(input.injectionAllocationMethod !== undefined
      ? { injection_allocation_method: input.injectionAllocationMethod }
      : {}),
    // ...and for the SWD pump plunger size: guarded so a caller that doesn't
    // manage it (Orion's update_well, a producer-well edit) can't blank it.
    ...(input.plungerSize !== undefined
      ? { plunger_size: input.plungerSize.trim() || null }
      : {}),
    // ...and for the tubing tally: guarded so a settings edit or Orion's
    // update_well can't wipe a tally it never touched. A save REPLACES the array
    // (re-running the string replaces the tally), so the caller sends the whole
    // list, cleaned of anything that isn't a positive length.
    ...(input.tubingJoints !== undefined
      ? { tubing_joints: mapTubingJoints(input.tubingJoints) }
      : {}),
    // ...and for the wellbore profile. Guarded like the rest, so a partial
    // update never clears it — but `null` IS a value here (the dialog's blank
    // option), which is why the guard tests for `undefined` and not falsiness.
    ...(input.wellboreProfile !== undefined
      ? { wellbore_profile: input.wellboreProfile }
      : {}),
  };
}

/** Embedded tank rows used only to derive the well's oil strapping factor. */
interface WellTankRow {
  bbl_per_inch: number | null;
  product: string | null;
  active: boolean | null;
}

/** One of the well's battery allocation rows, embedding the battery's tanks (oil
 * allocation lives at the battery, so the strapping factor comes from an oil tank
 * in a battery the well is allocated to). */
interface WellAllocationRow {
  tank_batteries: { tanks: WellTankRow[] | null } | null;
}

interface WellRow {
  id: string;
  name: string;
  type: string | null;
  zone: string | null;
  perforations: string | null;
  county: string | null;
  coordinates: string | null;
  depth: number | null;
  date_drilled: string | null;
  oil_production: number | null;
  gas_production: number | null;
  salt_water: number | null;
  revenue: number | null;
  lifting_cost: number | null;
  pl: number | null;
  api_well_no: string | null;
  rrc_lease_id: string | null;
  rrc_operator_no: string | null;
  /** Optional on the row type so test/mocks needn't set it (see below). */
  plunger_size?: string | null;
  /** Optional for the same reason; `mapTubingJoints` treats a missing value as an
   * empty tally. Postgres may hand back numerics as strings, hence `unknown`. */
  tubing_joints?: unknown;
  lease_id: string | null;
  /** Optional on the row type so test/mocks needn't set it; the `*` read always
   * returns it and `mapWell` treats a missing value as `straight`. */
  injection_allocation_method?: string | null;
  /** Optional for the same reason; absent reads as unknown, not as vertical. */
  wellbore_profile?: string | null;
  active: boolean | null;
  /** Optional on the row type so test/mocks needn't set it; the `*` read always
   * returns it and `mapWell` treats a missing value as "never plugged". */
  plugged_at?: string | null;
  battery_well_allocations: WellAllocationRow[] | null;
}

/** The four geometries `wells.wellbore_profile` accepts. */
const WELLBORE_PROFILES: readonly WellboreProfile[] = [
  "vertical",
  "horizontal",
  "directional",
  "sidetrack",
];

/**
 * A stored profile, or null.
 *
 * Anything unrecognised reads as null rather than being passed through: the
 * column is constrained, so a surprising value means the row predates the
 * constraint or arrived out of band, and "unknown" is the truthful rendering of
 * that. Never defaults to vertical — a guessed geometry is a wrong geometry.
 */
function mapWellboreProfile(raw: string | null | undefined): WellboreProfile | null {
  const value = (raw ?? "").trim().toLowerCase();
  return (WELLBORE_PROFILES as readonly string[]).includes(value)
    ? (value as WellboreProfile)
    : null;
}

// Wells embed the batteries they're allocated to and those batteries' tanks
// (through `battery_well_allocations` → `tank_batteries` → `tanks`) so a single
// query yields the oil strapping factor.
const WELL_COLS =
  "*, battery_well_allocations(tank_batteries(tanks(bbl_per_inch, product, active)))";

/** The well's oil strapping factor from an active oil tank in a battery it's
 * allocated to, or 1. */
function oilRatioFromAllocations(allocs: WellAllocationRow[] | null): number {
  for (const a of allocs ?? []) {
    const oil = (a.tank_batteries?.tanks ?? []).find(
      (t) => t != null && t.product === "oil" && t.active !== false
    );
    const r = oil?.bbl_per_inch;
    if (r != null && Number.isFinite(r) && r > 0) return r;
  }
  return 1;
}

function mapWell(r: WellRow): Well {
  return {
    id: r.id,
    name: r.name,
    type: r.type === "injection" ? "injection" : "producer",
    depth: r.depth ?? 0,
    zone: r.zone ?? "",
    perforations: r.perforations ?? "",
    county: r.county ?? "",
    coordinates: r.coordinates ?? "",
    dateDrilled: r.date_drilled ?? "",
    oilProduction: r.oil_production ?? 0,
    gasProduction: r.gas_production ?? 0,
    saltWater: r.salt_water ?? 0,
    revenue: r.revenue ?? 0,
    liftingCost: r.lifting_cost ?? 0,
    pl: r.pl ?? 0,
    oilBblPerInch: oilRatioFromAllocations(r.battery_well_allocations),
    apiWellNo: r.api_well_no ?? "",
    rrcLeaseId: r.rrc_lease_id ?? "",
    rrcOperatorNo: r.rrc_operator_no ?? "",
    plungerSize: r.plunger_size ?? "",
    tubingJoints: mapTubingJoints(r.tubing_joints),
    leaseId: r.lease_id ?? null,
    injectionAllocationMethod:
      r.injection_allocation_method === "weighted" ? "weighted" : "straight",
    active: r.active ?? true,
    pluggedAt: r.plugged_at ?? null,
    wellboreProfile: mapWellboreProfile(r.wellbore_profile),
  };
}

/** Exposed for unit tests of the read mapping. */
export { mapWell, mapWellboreProfile };

/** Returns all wells, ordered by name. */
export async function getWells(): Promise<Well[]> {
  if (!hasSupabase()) return [];
  return cachedWells(await getRequestSupabase());
}

/** The org's wells, once per request. */
export function cachedWells(sb: Awaited<ReturnType<typeof getRequestSupabase>>) {
  return memo(sb, "wells", () => loadWells(sb));
}

async function loadWells(
  sb: Awaited<ReturnType<typeof getRequestSupabase>>
): Promise<Well[]> {
  const { data, error } = await sb
    .from("wells")
    .select(WELL_COLS)
    .order("name");
  if (error) throw new Error(`getWells: ${error.message}`);
  return ((data ?? []) as unknown as WellRow[]).map(mapWell);
}

/** Just enough to name a well and place it on a lease. */
export interface WellNavRow {
  id: string;
  name: string;
  leaseId: string | null;
  type: WellType;
  active: boolean;
  pluggedAt: string | null;
}

/**
 * The four columns the sidebar's Leases flyout needs, for every well in the org.
 *
 * `getWells` reads `*` plus a three-level battery → tank join to derive each
 * well's strapping factor — a page's worth of work for a menu, and slow enough
 * on a large fleet to hit the statement timeout. A menu that has to wait on that
 * is a menu the operator has already moved past. Soft-deleted wells are hidden
 * by RLS, the same as they are for `getWells`.
 */
export async function listWellNavRows(
  sb: Awaited<ReturnType<typeof getRequestSupabase>>
): Promise<WellNavRow[]> {
  const { data, error } = await sb
    .from("wells")
    .select("id, name, lease_id, type, active, plugged_at")
    .order("name");
  if (error) throw new Error(`listWellNavRows: ${error.message}`);
  return (
    (data ?? []) as {
      id: string;
      name: string | null;
      lease_id: string | null;
      type: WellType | null;
      active: boolean | null;
      plugged_at: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    name: r.name ?? "",
    leaseId: r.lease_id ?? null,
    type: r.type ?? "producer",
    active: r.active ?? true,
    pluggedAt: r.plugged_at ?? null,
  }));
}

/** Returns the wells assigned to a lease (`wells.lease_id`), ordered by name. */
export async function getLeaseWells(leaseId: string): Promise<Well[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("wells")
    .select(WELL_COLS)
    .eq("lease_id", leaseId)
    .order("name");
  if (error) throw new Error(`getLeaseWells: ${error.message}`);
  return ((data ?? []) as unknown as WellRow[]).map(mapWell);
}

/** Returns a single well by its id / slug, or `null` when it does not exist. */
export async function getWell(id: string): Promise<Well | null> {
  if (!hasSupabase()) return null;
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("wells")
    .select(WELL_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getWell: ${error.message}`);
  return data ? mapWell(data as unknown as WellRow) : null;
}

/** Returns a lookup of well id → well name, for labelling references to wells. */
export async function getWellNameMap(): Promise<Record<string, string>> {
  const wells = await getWells();
  return Object.fromEntries(wells.map((well) => [well.id, well.name]));
}

/**
 * A single day of production for a well.
 */
export interface ProductionPoint {
  /** Row id, when loaded from the database (absent for unsaved/optimistic rows). */
  id?: string;
  /** Production date as an ISO `YYYY-MM-DD` string. */
  date: string;
  /** Reading time as a 24-hour `HH:MM` string. */
  time: string;
  oilProduction: number;
  /**
   * Which streams were MEASURED on this date, when the row was derived.
   *
   * A derived row exists for the union of the well's three series, so a day the
   * gas meter was read and no tank gauged carries `oilProduction: 0` — and an
   * average that divides by every row reports oil the well never failed to make.
   * Absent on hand-entered rows, where the row is the reading and every field on
   * it was entered together; callers read `?? true` for those.
   */
  measured?: { oil: boolean; gas: boolean; water: boolean };
  /** Oil held in tanks (lease inventory), in barrels. */
  oilStock: number;
  /** Oil sold / hauled, in barrels per day. */
  oilSales: number;
  gasProduction: number;
  saltWater: number;

  // --- Richer daily gas-measurement fields (GBC-7 / gap B.6) ----------------
  // All optional: null/undefined means "not measured that day". These are
  // captured at the well/meter. Field-ops volumes (pulled bottom / water hauled
  // / hot oil) moved to the tank reading (`tank_readings`, GBC-7 follow-up).

  /** Gas orifice plate size (inches). */
  orifice?: number;
  /** Gas differential pressure (inches H₂O). */
  differential?: number;
  /** Corrected hourly volume / chart multiplier. */
  chm?: number;
  /** Casing pressure (psi). */
  casingPressure?: number;
  /** Tubing pressure (psi). */
  tubingPressure?: number;
  /** Flowing/static line pressure (psi). */
  flowPressure?: number;
  /** Choke size (64ths of an inch). */
  choke?: number;
  /** Free-text pumper remarks. */
  remarks?: string;
}

/**
 * A production reading as a SOURCE reports it, for `writeProductionReadings`.
 *
 * The difference from `ProductionPoint` is the five core volumes: here they are
 * nullable, and `null`/`undefined` means "this source did not report it" —
 * distinct from a reported zero. That distinction is the whole basis of the
 * last-wins merge: a reported value overwrites what is on file, an unreported
 * one leaves the stored value alone. A document that only prints gas must not
 * zero out the day's oil.
 *
 * `ProductionPoint` (all five required) is assignable to this, so callers that
 * genuinely measure every field — the manual grid, Orion's `record_production` —
 * pass one unchanged and every field counts as reported.
 */
export type ProductionWritePoint = Omit<
  ProductionPoint,
  "oilProduction" | "oilStock" | "oilSales" | "gasProduction" | "saltWater"
> & {
  oilProduction?: number | null;
  oilStock?: number | null;
  oilSales?: number | null;
  gasProduction?: number | null;
  saltWater?: number | null;
};

interface ProductionRow {
  id: string;
  reading_date: string;
  reading_time: string | null;
  oil_production: number | null;
  oil_stock: number | null;
  oil_sales: number | null;
  gas_production: number | null;
  salt_water: number | null;
  orifice: number | null;
  differential: number | null;
  chm: number | null;
  casing_pressure: number | null;
  tubing_pressure: number | null;
  flow_pressure: number | null;
  choke: number | null;
  remarks: string | null;
}

/** Null → undefined, so unmeasured richer fields stay absent (not `0`). */
function optNum(v: number | null): number | undefined {
  return v ?? undefined;
}

function mapProduction(r: ProductionRow): ProductionPoint {
  return {
    id: r.id,
    date: r.reading_date,
    time: (r.reading_time ?? "").slice(0, 5),
    oilProduction: r.oil_production ?? 0,
    oilStock: r.oil_stock ?? 0,
    oilSales: r.oil_sales ?? 0,
    gasProduction: r.gas_production ?? 0,
    saltWater: r.salt_water ?? 0,
    orifice: optNum(r.orifice),
    differential: optNum(r.differential),
    chm: optNum(r.chm),
    casingPressure: optNum(r.casing_pressure),
    tubingPressure: optNum(r.tubing_pressure),
    flowPressure: optNum(r.flow_pressure),
    choke: optNum(r.choke),
    remarks: r.remarks ?? undefined,
  };
}

/** Returns the production history for a well, oldest reading first. */
export async function getWellProduction(
  id: string
): Promise<ProductionPoint[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("production_readings")
    .select(
      "id, reading_date, reading_time, oil_production, oil_stock, oil_sales, gas_production, salt_water, orifice, differential, chm, casing_pressure, tubing_pressure, flow_pressure, choke, remarks"
    )
    .eq("well_id", id)
    .order("reading_date", { ascending: true })
    .order("reading_time", { ascending: true });
  if (error) throw new Error(`getWellProduction: ${error.message}`);
  return (data ?? []).map(mapProduction);
}

/**
 * A well's production, built the SAME way the reports and the production pages
 * do: aggregate the well's page series — oil `wellProductionSeries`, gas
 * `wellGasSeries`, water `wellWaterSeries` — with the well page's hand-entered
 * fallback (gas/water fall back to the entered reading on days no meter/flow
 * covers; oil is series-only). This is the single-well analogue of
 * `getCompanyProduction`, so the AI's `get_production` answers agree with what
 * the reports and the well page show, per (well, date). Rows span the union of
 * every date a series OR a reading covers; reading-only fields (stock, sales,
 * pressures, remarks, time, id) come from the reading where one exists.
 *
 * Use this for READ/answer paths that must agree with the app's reports (e.g.
 * the AI's `get_production`). Do NOT use it for the raw-entry grid or
 * read-modify-write edits — those need the un-overlaid rows from
 * `getWellProduction`.
 */
export async function getWellProductionDerived(
  id: string
): Promise<ProductionPoint[]> {
  const readings = await getWellProduction(id);
  if (!hasSupabase()) return readings;
  const sb = await getSupabaseServer();
  const [oil, gas, water] = await Promise.all([
    wellProductionSeries(sb, id, { mode: "regularized" }),
    wellGasSeriesMeasured(sb, id),
    wellWaterSeries(sb, id),
  ]);
  // The battery's last day is covered only to its last gauge -- a few hours of
  // barrels under a whole day's date. Whole rows come off at that boundary, as
  // the well page's own table does it (`withoutPartialTail`); anything else
  // answers a question about "yesterday" with a fraction of a day. The boundary
  // is the battery's, not this slice's last row, which can also be the day the
  // well came off the split.
  //
  // Gas and water end at THEIR last reading too, and those days can fall before
  // the oil boundary. On or after its own boundary a stream is unmeasured on
  // the row, and the hand-entered reading is the fallback -- the same rule the
  // dashboard's rows follow (`assembleWellDayRows`), so the two agree.
  const oilBoundary = oil.measuredThrough;
  const oilBy = new Map(oil.rows.map((p) => [p.date, p.bbls]));
  const gasBy = new Map(
    gas.rows
      .filter((p) => isWholeDay(p.date, gas.measuredThrough))
      .map((p) => [p.date, p.bbls])
  );
  const waterBy = new Map(
    water.rows
      .filter((p) => isWholeDay(p.date, water.measuredThrough))
      .map((p) => [p.date, p.bbls])
  );
  // Latest reading per date carries the reading-only fields + the gas/water
  // fallback (readings are oldest-first, so last write wins).
  const readingByDate = new Map<string, ProductionPoint>();
  for (const p of readings) readingByDate.set(p.date, p);

  const dates = [
    ...new Set([...oilBy.keys(), ...gasBy.keys(), ...waterBy.keys(), ...readingByDate.keys()]),
  ]
    .filter((date) => oilBoundary == null || date < oilBoundary)
    .sort();
  return dates.map((date) => {
    const base = readingByDate.get(date);
    return {
      ...base,
      date,
      time: base?.time ?? "",
      oilProduction: oilBy.get(date) ?? 0,
      gasProduction: gasBy.get(date) ?? base?.gasProduction ?? 0,
      saltWater: waterBy.get(date) ?? base?.saltWater ?? 0,
      oilStock: base?.oilStock ?? 0,
      oilSales: base?.oilSales ?? 0,
      /*
       * Which streams this date actually carries. The zeros above are the whole
       * reason: a date present only because the gas meter was read has oil 0,
       * and anything averaging that as production says the well stopped. Same
       * flags, same meaning, as `CompanyProductionRow.measured`.
       */
      measured: {
        oil: oilBy.has(date),
        gas: gasBy.has(date) || base?.gasProduction != null,
        water: waterBy.has(date) || base?.saltWater != null,
      },
    };
  });
}

// Per-well current rates (the /production Oil / Gas / Revenue columns) moved to
// `@/lib/wells/rate-cache`, which owns both the derivation and the materialized
// copy of it. Re-exported so existing server-side imports keep resolving.
export {
  getWellProductionRates,
  deriveWellProductionRates,
  refreshWellProductionRates,
} from "@/lib/wells/rate-cache";
export type { WellProductionRate } from "@/lib/wells/rate-cache";

export function initialsFrom(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// Well comments moved to the shared facility thread — `@/lib/comments`. A well
// is one facility among five now, and its thread is the same table as every
// other facility's (2026072900000_facility_comments.sql). `initialsFrom` stays
// here because it is the canonical display helper for the whole app; the
// comments module imports it rather than the other way round.

/**
 * One field on a well's equipment / wellbore spec sheet — a flexible label →
 * value pair (e.g. "Tbg Pump" → "2.25\" x 20'BN"). A well's equipment is an
 * ordered list of these, with a set of standard fields offered as defaults and
 * room for arbitrary custom rows.
 */
export interface WellEquipment {
  id: string;
  /** Field name, e.g. "Tbg Pump", "Casing", "Motor". */
  label: string;
  /** Field value, free text. */
  value: string;
  /** Display order within the sheet. */
  position: number;
  /** Free-text notes, edited in the row's detail modal (russell-feedback-one.md:9). */
  notes: string;
}

/** An equipment field as supplied by the UI / tools, before it has a row id. */
export interface EquipmentField {
  label: string;
  value: string;
}

interface EquipmentRow {
  id: string;
  label: string | null;
  value: string | null;
  position: number | null;
  notes: string | null;
}

/** Returns a well's equipment fields, in sheet order. */
export async function getWellEquipment(id: string): Promise<WellEquipment[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("well_equipment")
    .select("id, label, value, position, notes")
    .eq("well_id", id)
    .order("position", { ascending: true });
  if (error) throw new Error(`getWellEquipment: ${error.message}`);
  return ((data ?? []) as EquipmentRow[]).map((r) => ({
    id: r.id,
    label: r.label ?? "",
    value: r.value ?? "",
    position: r.position ?? 0,
    notes: r.notes ?? "",
  }));
}

/**
 * One formation the wellbore encountered, with the depth to its top.
 *
 * Distinct from `Well.zone`, which is the single producing formation the well is
 * making from. This is the whole column the hole passed through, which is what
 * answers "what is uphole of where we are perforated" — the recompletion
 * question, and the reason the data is worth keeping.
 *
 * Seeded from the RRC completion packet at import and editable afterwards, so a
 * row can be the state's or the operator's; `source` says which.
 */
export interface WellFormation {
  id: string;
  /** Formation name as filed, e.g. "SPRABERRY, LOWER". */
  name: string;
  /** Measured depth to the top, in feet, or null when none was filed. */
  topFt: number | null;
  /** True vertical depth, in feet, when the packet carried one. */
  tvdFt: number | null;
  /** `rrc` = seeded from the state record, `user` = entered here. */
  source: "rrc" | "user";
  /** Display order for rows with no depth; rows with a depth sort by it. */
  position: number;
}

interface FormationRow {
  id: string;
  name: string | null;
  top_ft: number | string | null;
  tvd_ft: number | string | null;
  source: string | null;
  position: number | null;
}

/** Postgres hands `numeric` back as a string over PostgREST. */
function numericOrNull(value: number | string | null): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Shared row -> model mapping, so the loader and the actions agree. */
export function mapFormation(r: FormationRow): WellFormation {
  return {
    id: r.id,
    name: r.name ?? "",
    topFt: numericOrNull(r.top_ft),
    tvdFt: numericOrNull(r.tvd_ft),
    source: r.source === "user" ? "user" : "rrc",
    position: r.position ?? 0,
  };
}

export const FORMATION_COLS = "id, name, top_ft, tvd_ft, source, position";

/**
 * A well's formation tops, shallowest first.
 *
 * Ordered in SQL by depth with nulls last, then by `position`, so a row nobody
 * gave a depth still has a stable place instead of jumping around between
 * loads.
 */
export async function getWellFormations(id: string): Promise<WellFormation[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("well_formations")
    .select(FORMATION_COLS)
    .eq("well_id", id)
    .order("top_ft", { ascending: true, nullsFirst: false })
    .order("position", { ascending: true });
  if (error) throw new Error(`getWellFormations: ${error.message}`);
  return ((data ?? []) as FormationRow[]).map(mapFormation);
}

/**
 * One service-history row on a well — a dated job/service event (repair,
 * workover, acid job, tubing/pump test, cleanout, vendor service call). This is
 * distinct from {@link WellEquipment}: equipment is the well's physical
 * configuration; service is what was DONE to it.
 */
export interface WellService {
  id: string;
  /** Date the job was performed, ISO `YYYY-MM-DD`, or "" if unknown. */
  date: string;
  /** What was done, e.g. "Acid Job", "Tubing Test", "Pump Repair". */
  job: string;
  /** Who did it, e.g. "Perfect Pump". */
  vendor: string;
  /** Cost in dollars, or null when unknown. */
  cost: number | null;
  /** Free-text details: ticket/invoice numbers, results. */
  notes: string;
  /** Display order within the service list. */
  position: number;
  /**
   * The source document this entry was recorded from — the vendor ticket or
   * invoice (`files.id`), or null when the entry was hand-entered with no paper.
   * The primary source behind the row.
   */
  fileId: string | null;
  /** The attached document's name, for display. Null when nothing is attached —
   * or when the file exists but this caller cannot read it (no `manage_files`),
   * in which case `fileId` is still set. */
  fileName: string | null;
}

/** A service row as supplied by the UI / tools, before it has a row id. */
export interface ServiceField {
  date: string;
  job: string;
  vendor: string;
  cost: number | null;
  notes: string;
}

interface ServiceRow {
  id: string;
  date: string | null;
  job: string | null;
  vendor: string | null;
  cost: number | null;
  notes: string | null;
  position: number | null;
  file_id: string | null;
  /** Embedded source document (name only). Null when nothing is attached, or
   * when the file is invisible to this caller — `file_id` still says one exists.
   * PostgREST returns a to-one embed as an object; tolerate an array too, since
   * that is how the client's type inference describes it. */
  file:
    | { id: string; name: string | null }
    | { id: string; name: string | null }[]
    | null;
}

/**
 * Returns a well's service-history rows, in list order.
 *
 * The column list and mapping here must stay in step with `SERVICE_COLS` /
 * `mapService` in `@/lib/wells/actions.ts` — the page loads through this one and
 * the realtime resync loads through that one, so a field present in only one of
 * them appears and then vanishes as soon as the table refreshes.
 */
export async function getWellService(id: string): Promise<WellService[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("well_service")
    .select(
      "id, date, job, vendor, cost, notes, position, file_id, file:files!file_id(id, name)"
    )
    .eq("well_id", id)
    .order("position", { ascending: true });
  if (error) throw new Error(`getWellService: ${error.message}`);
  return ((data ?? []) as unknown as ServiceRow[]).map((r) => ({
    id: r.id,
    date: r.date ?? "",
    job: r.job ?? "",
    vendor: r.vendor ?? "",
    cost: r.cost,
    notes: r.notes ?? "",
    position: r.position ?? 0,
    fileId: r.file_id ?? null,
    fileName: (Array.isArray(r.file) ? r.file[0] : r.file)?.name ?? null,
  }));
}

/**
 * One fluid-level shot on a well — a dated acoustic/sonolog/Echometer reading of
 * the depth from surface to the top of the fluid column. Fired to judge pumping
 * depth. Distinct from {@link WellEquipment} (the well's physical configuration)
 * and {@link WellService} (dated jobs done to it): a shot is a diagnostic
 * measurement, not a component or a job.
 *
 * `WellShot`, `ShotField`, `ShotRow`, `fluidOverPump` and `mapShotRow` moved to
 * `@/lib/wells/wells-pure` (the shot panel and modal are client components) and
 * are re-exported at the top of this file.
 */

/** Columns selected for a well's shots, shared by the loaders in both modules. */
export const SHOT_COLS =
  "id, shot_date, shot_time, fluid_level_ft, notes";

/** Columns selected for a well's pumping records. One string literal: the
 *  Supabase client parses this at the TYPE level and a `+` loses every column. */
export const PUMPING_COLS =
  "id, effective_date, pump_depth_ft, pump_size_in, stroke_length_in, strokes_per_min, timer";

/**
 * Returns a well's fluid-level shots, newest first: `shot_date` descending, then
 * `shot_time` descending with missing times sorting last.
 */
export async function getWellShots(id: string): Promise<WellShot[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("well_shots")
    .select(SHOT_COLS)
    .eq("well_id", id)
    .order("shot_date", { ascending: false })
    .order("shot_time", { ascending: false, nullsFirst: false });
  if (error) throw new Error(`getWellShots: ${error.message}`);
  return ((data ?? []) as ShotRow[]).map(mapShotRow);
}

/**
 * A well's pumping setups, newest first by effective date.
 *
 * The whole history, not just the current one: a fluid-level shot resolves its
 * pump depth against the setup in force on the shot's own date (`pumpingOn`), so
 * the page needs every record, not the latest.
 */
export async function getWellPumping(id: string): Promise<WellPumping[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("well_pumping")
    .select(PUMPING_COLS)
    .eq("well_id", id)
    .order("effective_date", { ascending: false });
  if (error) throw new Error(`getWellPumping: ${error.message}`);
  return ((data ?? []) as PumpingRow[]).map(mapPumpingRow);
}

/** A document or file attached to a well. */
export interface WellFile {
  id: string;
  name: string;
  type: string;
  /** File size in kilobytes. */
  sizeKb: number;
  /** Upload date as an ISO `YYYY-MM-DD` string. */
  uploadedAt: string;
  /**
   * Proactive-ingest scan state: 'scanning' while Orion reads the fresh upload
   * for addable data, 'done' once finished, null for files never scanned. Drives
   * the "Checking for data to add…" indicator on the upload card.
   */
  scanStatus?: "scanning" | "done" | null;
  /** Listed because a domain row points at it, not placed here; no remove. */
  attached?: boolean;
}

interface WellFilePlacement {
  created_at: string;
  files: {
    id: string;
    name: string;
    type: string | null;
    size: number | null;
    created_at: string;
    scan_status: string | null;
  } | null;
}

/**
 * Returns the files attached to a well, newest first.
 *
 * Well files reuse the unified file model: each well has a subfolder under the
 * `Wells` system root (named by the well id) and its files are ordinary `files`
 * placed there via `file_placements` — the same de-duplicated storage `/files`
 * and `/projects` use. No per-well join table.
 */
export async function getWellFiles(id: string): Promise<WellFile[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();

  // The folder's placements and the documents that point at the well
  // (invoices, field tickets, service sources) in one wave; neither needs the
  // other. A well with no folder yet can still have an invoice filed against it.
  const [folderId, attached] = await Promise.all([
    findWellFolderId(sb, id),
    listAttachedDocuments(sb, { kind: "well", entityId: id }),
  ]);

  let placed: (WellFile & { addedAt: string })[] = [];
  if (folderId) {
    const { data, error } = await sb
      .from("file_placements")
      .select("created_at, files(id, name, type, size, created_at, scan_status)")
      .eq("folder_id", folderId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`getWellFiles: ${error.message}`);

    placed = ((data ?? []) as unknown as WellFilePlacement[]).flatMap((row) => {
      const file = row.files;
      if (!file) return [];
      const addedAt = row.created_at ?? file.created_at ?? "";
      return [
        {
          id: file.id,
          name: file.name,
          type: (file.type ?? "file").toUpperCase(),
          sizeKb: Math.max(1, Math.round((file.size ?? 0) / 1024)),
          uploadedAt: addedAt.slice(0, 10),
          scanStatus: (file.scan_status as WellFile["scanStatus"]) ?? null,
          addedAt,
        },
      ];
    });
  }

  return withoutAddedAt(mergeAttached(placed, attached.map(attachedWellFile)));
}
