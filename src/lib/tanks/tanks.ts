import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcAllRows } from "@/lib/supabase/paged-rpc";
import { withFacilitySlugs } from "@/lib/facilities/slug-route";
import { serviceOrgFor } from "@/lib/supabase/service-org";
import { bblsFromGauge } from "@/lib/tanks/strapping";
import { tankDisplayName } from "@/lib/tanks/tank-name";
import { isMissingFunction } from "@/lib/supabase/errors";
import { addTankAllocationsForWells } from "@/lib/tanks/allocations";
import { ensureBatteryMembership } from "@/lib/batteries/allocations";
import {
  ensureFacilityFolder,
  moveFacilityFolder,
  renameFacilityFolder,
} from "@/lib/files/facility-folder";

/**
 * Tank measurement data-access (GBC-1).
 *
 * Every helper takes the caller's Supabase client as its first argument (the
 * same idiom `well-folder.ts` uses). Passing the request-scoped RLS client
 * (`getSupabaseServer()`) is what enforces org ownership: the `tanks` /
 * `tank_readings` RLS policies scope reads and writes to `current_org_id()`, so
 * there is no cross-org read or write regardless of the ids a caller passes.
 * Never hand these the service-role admin client — that bypasses RLS.
 *
 * Inches→barrels conversion lives at the tank level (`bblsFromGauge`); readings
 * store the derived `bbls` so reads need no further math.
 */

export type TankProduct = "oil" | "water";

/**
 * Which end of the water cycle a WATER tank sits at.
 *
 *  - `production` — the tank on a producing lease's battery, catching water off
 *    the separator until a hauler empties it. Its barrels are that lease's
 *    produced water, and it lists on /production.
 *  - `disposal` — the tank at an SWD station, holding water before injection.
 *    Its barrels are station inventory, possibly trucked in from several
 *    leases, and it lists on /disposal.
 *
 * Orthogonal to `product`, which says what the tank HOLDS. Both kinds hold
 * water and are gauged identically, which is why the product enum was not
 * widened — see `docs/plans/water-tank-categories.md`.
 */
export type WaterService = "production" | "disposal";

/**
 * How a tank's measured total is split to its wells. `straight` uses fixed
 * per-well percentages (default; works on day one); `weighted` uses well-test
 * rates (GBC-11). The derivation engine is GBC-2; here it's just config.
 */
export type AllocationMethod = "straight" | "weighted";

/** A physical tank with its own strapping (barrels-per-inch) factor. */
export interface Tank {
  id: string;
  /**
   * DERIVED display name — "Roach T123", the effective lease plus `tankNo`.
   * See `tankDisplayName`. There is no stored tank name any more: `tanks.name`
   * is neither read nor written, so this is the only name a tank has.
   */
  name: string;
  /** Resolved effective-lease name (joined), or "" when unassigned. Read-only. */
  lease: string;
  product: TankProduct;
  /** Which page a WATER tank belongs on; null on an oil tank. See
   *  `WaterService` and the `isProductionWater` / `isDisposalWater` predicates
   *  in `./water-service`, which every list filters through. */
  waterService: WaterService | null;
  /**
   * The URL segment its detail page routes on — the name, suffixed only when
   * another tank in the org carries the same one. Stamped by the loaders that
   * read the whole set (see `withFacilitySlugs`); absent on rows loaded as a
   * subset, where a link falls back to the id and the page redirects.
   */
  slug?: string;

  /** Resolved battery name — the linked `tank_batteries` row's name, falling
   * back to the legacy free-text label — or "" for a standalone tank. Read-only;
   * set the link via `batteryId`. */
  battery: string;
  /** The tank battery this tank is linked to (`tanks.battery_id`), or null. */
  batteryId: string | null;
  /** The tank's identifier number — the number a purchaser / gatherer uses for
   * its runs (e.g. the Phillips 66 tank number), or "" if unset. Text, not
   * numeric: identifiers carry leading zeros and the occasional letter. */
  tankNo: string;
  /** The gatherer (hauling company) assigned to this tank, or null. Managed on
   * People → Gatherers; replaces `battery` in the tank UI. */
  gathererId: string | null;
  /** Resolved gatherer name (joined), or "" if unassigned. Read-only. */
  gatherer: string;
  /** The tank's effective lease: its battery's lease when linked, else its own
   * `tanks.lease_id` (battery authoritative, tank as fallback). A downward cascade
   * keeps the two in sync, so this equals `tanks.lease_id` in practice. */
  leaseId: string | null;
  /** Linear strapping factor: barrels per inch of gauge. */
  bblPerInch: number;
  /** Shell capacity in barrels, or null if unrecorded. */
  capacityBbls: number | null;
  /** Per-tank allocation method (all wells on the tank share it). */
  allocationMethod: AllocationMethod;
  /** The SWD/injection well this water tank feeds (`tanks.injection_well_id`), or
   * null. When set, the tank is FLOW-THROUGH (Mode B): its level is not a
   * production proxy; the SWD well's meter series is the volume source. */
  injectionWellId: string | null;
  /** This tank's fixed % of its SWD well's total under the `straight` method
   * (`tanks.injection_share_pct`), or null. `weighted` derives the share from
   * water-test rates instead. */
  injectionSharePct: number | null;
  active: boolean;
  /** When the tank was "called in" for a crude pickup (ISO), or null if it is
   * not currently in the pickup queue. */
  calledInAt: string | null;
  /** Purchaser called for the pickup (name), or null. Only resolved by
   * `getTank` (the detail read); list reads leave it null. */
  calledInPurchaser: string | null;
}

/** One gauge reading on a tank, with the derived barrels. */
export interface TankReading {
  id: string;
  tankId: string;
  /** Reading date as an ISO `YYYY-MM-DD` string. */
  date: string;
  /** Reading time as a 24-hour `HH:MM` string, or "" if none. */
  time: string;
  /** Raw top gauge, in inches. */
  gauge: number;
  /** Derived barrels (gauge × the tank's bbl-per-inch). */
  bbls: number;

  // --- Field ops (GBC-7) -----------------------------------------------------
  // Facility work logged against the tank on this day. All optional:
  // undefined means "not measured / none that day", never 0.

  /** BS&W pulled off the tank bottom (bbls). */
  pulledBottom?: number;
  /** Water trucked off lease (bbls). */
  waterHauled?: number;
  /** Hot-oil treatment volume (bbls). */
  hotOil?: number;
  /** Free-text comments the pumper left with the reading. */
  comments?: string;
}

/** Fields for creating a tank. `org_id`/`created_by` come from RLS defaults. */
export interface TankInput {
  product: TankProduct;
  /** Required for a water tank (the DB constraint enforces it); ignored on an
   *  oil tank. Omitted on a water tank it defaults to `disposal`, which is
   *  where every water tank listed before this column existed. */
  waterService?: WaterService | null;
  battery?: string;
  /** Link to a tank battery (`tank_batteries.id`), or null for standalone. */
  batteryId?: string | null;
  tankNo?: string;
  /** The lease the tank sits on. A tank in a battery reads its lease from the
   *  battery instead, so this is the standalone case and the fallback. */
  leaseId?: string | null;
  gathererId?: string | null;
  bblPerInch: number;
  capacityBbls?: number | null;
  allocationMethod?: AllocationMethod;
  injectionWellId?: string | null;
  injectionSharePct?: number | null;
  active?: boolean;
}

/** Partial tank patch (read-then-merge is the caller's job if needed). */
export interface TankPatch {
  product?: TankProduct;
  /** Moves a water tank between /production and /disposal. Set it whenever
   *  `product` changes: the DB requires water tanks to carry one and oil tanks
   *  not to. */
  waterService?: WaterService | null;
  battery?: string | null;
  /** Link to a tank battery (`tank_batteries.id`); null unlinks it. */
  batteryId?: string | null;
  tankNo?: string | null;
  /** The lease the tank sits on; null unassigns it. */
  leaseId?: string | null;
  gathererId?: string | null;
  bblPerInch?: number;
  capacityBbls?: number | null;
  allocationMethod?: AllocationMethod;
  /** SWD well this water tank feeds; null unlinks it (Mode B). */
  injectionWellId?: string | null;
  /** Fixed % of the SWD well under the `straight` method; null clears it. */
  injectionSharePct?: number | null;
  active?: boolean;
}

/** A gauge reading as supplied by the UI / tools, before conversion. */
export interface TankReadingInput {
  date: string;
  time?: string;
  gauge: number;
  /** Field ops (GBC-7); blank → undefined so an unmeasured value stays null. */
  pulledBottom?: number;
  waterHauled?: number;
  hotOil?: number;
  /** Blank → undefined, stored null. */
  comments?: string;
}

// `name` is deliberately absent: a tank's name is derived from its lease and
// its number (`tankDisplayName`), so both leases are joined — the battery's
// (authoritative) and the tank's own (fallback) — and the stored column is not
// read. Nothing writes it either; see `createTank` / `updateTank`.
const TANK_COLS =
  "id, product, water_service, battery, battery_id, battery_rel:tank_batteries!battery_id(name, lease_id, lease:leases!lease_id(name)), tank_no, gatherer_id, gatherer:gatherers!gatherer_id(name), lease_id, lease:leases!lease_id(name), bbl_per_inch, capacity_bbls, allocation_method, injection_well_id, injection_share_pct, active, called_in_at";
const READING_COLS =
  "id, tank_id, reading_date, reading_time, gauge, pulled_bottom, water_hauled, hot_oil, comments, tanks(bbl_per_inch)";

type Sb = SupabaseClient;

interface TankRow {
  id: string;
  product: string | null;
  /** Optional on the row type so test/mocks needn't set it; a missing value
   *  reads as `disposal` on a water tank, which is the page it was on before
   *  the column existed. */
  water_service?: string | null;
  battery: string | null;
  battery_id: string | null;
  /** Embedded battery name + lease from the `battery_id` join. */
  battery_rel?: {
    name: string | null;
    lease_id: string | null;
    lease?: { name: string | null } | null;
  } | null;
  tank_no: string | null;
  gatherer_id: string | null;
  /** Embedded gatherer name from the `gatherer_id` join. */
  gatherer?: { name: string | null } | null;
  lease_id: string | null;
  /** Embedded lease name from the tank's OWN `lease_id` join. */
  lease?: { name: string | null } | null;
  bbl_per_inch: number | null;
  capacity_bbls: number | null;
  allocation_method: string | null;
  injection_well_id: string | null;
  injection_share_pct: number | null;
  active: boolean | null;
  called_in_at?: string | null;
  /** Embedded purchaser name (only when the read joins it via `getTank`). */
  called_in_purchaser?: { name: string | null } | null;
}

interface TankReadingRow {
  id: string;
  tank_id: string;
  reading_date: string;
  reading_time: string | null;
  gauge: number | null;
  pulled_bottom: number | null;
  water_hauled: number | null;
  hot_oil: number | null;
  comments: string | null;
  /** Parent tank's strapping factor (joined), for read-time bbls conversion. */
  tanks?: { bbl_per_inch: number | null } | null;
}

/**
 * Tank order, everywhere a list is returned: by the DERIVED name, read the way
 * a person reads it ("Roach T9" before "Roach T10"). It cannot be an
 * `.order("name")` on the query any more — the column the DB would sort by is
 * the retired one — so the sort happens here, after mapping.
 */
function byTankName(a: Tank, b: Tank): number {
  return a.name.localeCompare(b.name, "en", { numeric: true });
}

/** Null → undefined, so an unmeasured field-ops value stays absent (not `0`). */
function optNum(v: number | null | undefined): number | undefined {
  return v ?? undefined;
}

function mapTank(r: TankRow): Tank {
  // Battery's lease wins over the tank's own, exactly as `leaseId` below does —
  // the name has to follow the same precedence as the id it names.
  const lease = r.battery_rel?.lease?.name ?? r.lease?.name ?? "";
  const tankNo = r.tank_no ?? "";
  const product: TankProduct = r.product === "water" ? "water" : "oil";
  return {
    id: r.id,
    name: tankDisplayName(lease, tankNo, product),
    lease,
    product,
    /*
     * Water tanks only, and anything unrecognised reads as `disposal` — the
     * page every water tank listed on before this column existed. A row that
     * slipped past the migration stays where its operator last saw it rather
     * than moving to a tab they have never opened.
     */
    waterService:
      product === "water"
        ? r.water_service === "production"
          ? "production"
          : "disposal"
        : null,
    battery: r.battery_rel?.name ?? r.battery ?? "",
    batteryId: r.battery_id ?? null,
    tankNo,
    gathererId: r.gatherer_id ?? null,
    gatherer: r.gatherer?.name ?? "",
    // Battery authoritative, tank's own lease as fallback (Phase 1 hierarchy).
    leaseId: r.battery_rel?.lease_id ?? r.lease_id ?? null,
    bblPerInch: r.bbl_per_inch ?? 1,
    capacityBbls: r.capacity_bbls ?? null,
    allocationMethod: r.allocation_method === "weighted" ? "weighted" : "straight",
    injectionWellId: r.injection_well_id ?? null,
    injectionSharePct: r.injection_share_pct ?? null,
    active: r.active ?? true,
    calledInAt: r.called_in_at ?? null,
    calledInPurchaser: r.called_in_purchaser?.name ?? null,
  };
}

function mapReading(r: TankReadingRow): TankReading {
  return {
    id: r.id,
    tankId: r.tank_id,
    date: r.reading_date,
    time: (r.reading_time ?? "").slice(0, 5),
    gauge: r.gauge ?? 0,
    // Barrels are derived at READ time from the tank's current strapping factor
    // (inputs are stored in inches), so a factor change reprices all history.
    bbls: bblsFromGauge(r.gauge ?? 0, r.tanks?.bbl_per_inch ?? 1),
    pulledBottom: optNum(r.pulled_bottom),
    waterHauled: optNum(r.water_hauled),
    hotOil: optNum(r.hot_oil),
    comments: r.comments || undefined,
  };
}

// --- Tanks: reads ----------------------------------------------------------

/** All tanks in the org (RLS-scoped), ordered by name. */
export async function listTanks(
  sb: Sb,
  opts?: { orgId?: string }
): Promise<Tank[]> {
  // `orgId` is only for service-role (admin) callers with no RLS org context
  // (e.g. the scheduled digest cron); RLS callers omit it and are scoped by
  // policy. When set it adds an explicit org filter so admin reads stay per-org.
  let q = sb.from("tanks").select(TANK_COLS);
  if (opts?.orgId) q = q.eq("org_id", opts.orgId);
  const { data, error } = await q;
  if (error) throw new Error(`listTanks: ${error.message}`);
  // Slugged here, against every tank in the org — which is the list both
  // `/production/tanks/[tank]` and `/disposal/tanks/[tank]` resolve a param
  // against. Callers filter this down by product; the slug they carry away is
  // still the one those pages accept. See `withFacilitySlugs`.
  return withFacilitySlugs(
    ((data ?? []) as unknown as TankRow[]).map(mapTank).sort(byTankName)
  );
}

/**
 * Count of distinct wells allocated to each tank id (via `tank_well_allocations`).
 * Returned as a map for the Production tanks table's Wells column; a tank with no
 * allocations is absent (callers treat missing as 0).
 */
export async function wellCountsByTank(
  sb: Sb
): Promise<Record<string, number>> {
  const { data, error } = await sb
    .from("tank_well_allocations")
    .select("tank_id, well_id");
  if (error) throw new Error(`wellCountsByTank: ${error.message}`);
  const byTank = new Map<string, Set<string>>();
  for (const r of (data ?? []) as { tank_id: string; well_id: string }[]) {
    if (!r.tank_id || !r.well_id) continue;
    const wells = byTank.get(r.tank_id) ?? new Set<string>();
    wells.add(r.well_id);
    byTank.set(r.tank_id, wells);
  }
  const counts: Record<string, number> = {};
  for (const [tankId, wells] of byTank) counts[tankId] = wells.size;
  return counts;
}

/** Tanks a well is allocated to (via `tank_well_allocations`), ordered by name. */
export async function listWellTanks(sb: Sb, wellId: string): Promise<Tank[]> {
  const { data: allocs, error: aErr } = await sb
    .from("tank_well_allocations")
    .select("tank_id")
    .eq("well_id", wellId);
  if (aErr) throw new Error(`listWellTanks: ${aErr.message}`);
  const ids = [...new Set((allocs ?? []).map((r) => r.tank_id as string))];
  if (ids.length === 0) return [];
  const { data, error } = await sb
    .from("tanks")
    .select(TANK_COLS)
    .in("id", ids);
  if (error) throw new Error(`listWellTanks: ${error.message}`);
  return ((data ?? []) as unknown as TankRow[]).map(mapTank).sort(byTankName);
}

/** Water tanks that feed an SWD/injection well (`tanks.injection_well_id`), by name. */
export async function listInjectionTanks(
  sb: Sb,
  injectionWellId: string
): Promise<Tank[]> {
  const { data, error } = await sb
    .from("tanks")
    .select(TANK_COLS)
    .eq("injection_well_id", injectionWellId);
  if (error) throw new Error(`listInjectionTanks: ${error.message}`);
  return ((data ?? []) as unknown as TankRow[]).map(mapTank).sort(byTankName);
}

/** Tanks assigned to a lease (`tanks.lease_id`), ordered by name. */
export async function listLeaseTanks(sb: Sb, leaseId: string): Promise<Tank[]> {
  const { data, error } = await sb
    .from("tanks")
    .select(TANK_COLS)
    .eq("lease_id", leaseId);
  if (error) throw new Error(`listLeaseTanks: ${error.message}`);
  return ((data ?? []) as unknown as TankRow[]).map(mapTank).sort(byTankName);
}

/** A single tank by id, or null if it doesn't exist / isn't visible. */
export async function getTank(sb: Sb, id: string): Promise<Tank | null> {
  const { data, error } = await sb
    .from("tanks")
    .select(
      `${TANK_COLS}, called_in_purchaser:purchasers!called_in_purchaser_id(name)`
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getTank: ${error.message}`);
  return data ? mapTank(data as unknown as TankRow) : null;
}

/**
 * The well's default oil tank — the active oil tank the well is allocated to,
 * which carries its strapping factor (seeded per well by `createWell`). The
 * earliest one wins when a well is allocated to several oil tanks.
 */
export async function getWellOilTank(
  sb: Sb,
  wellId: string
): Promise<Tank | null> {
  const { data: allocs, error: aErr } = await sb
    .from("tank_well_allocations")
    .select("tank_id")
    .eq("well_id", wellId);
  if (aErr) throw new Error(`getWellOilTank: ${aErr.message}`);
  const ids = [...new Set((allocs ?? []).map((r) => r.tank_id as string))];
  if (ids.length === 0) return null;
  const { data, error } = await sb
    .from("tanks")
    .select(TANK_COLS)
    .in("id", ids)
    .eq("product", "oil")
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getWellOilTank: ${error.message}`);
  return data ? mapTank(data as unknown as TankRow) : null;
}

/**
 * The well's oil strapping factor (barrels per gauge inch), or 1 when the well
 * has no oil tank. This is the tank-level replacement for the old
 * `wells.oil_bbl_per_inch`.
 */
export async function getWellOilRatio(sb: Sb, wellId: string): Promise<number> {
  const tank = await getWellOilTank(sb, wellId);
  const r = tank?.bblPerInch;
  return r != null && Number.isFinite(r) && r > 0 ? r : 1;
}

// --- Tanks: writes ---------------------------------------------------------

/** Create a tank; returns its id. `org_id` is assigned by RLS, not the caller. */
export async function createTank(
  sb: Sb,
  input: TankInput
): Promise<{ id: string }> {
  const ratio =
    Number.isFinite(input.bblPerInch) && input.bblPerInch > 0
      ? input.bblPerInch
      : 1;
  const { data, error } = await sb
    .from("tanks")
    .insert({
      product: input.product,
      // The DB requires exactly one of these two shapes: a water tank with a
      // service, or a non-water tank with none. Defaulting to disposal keeps a
      // caller that predates the column creating tanks where it always did.
      water_service:
        input.product === "water" ? input.waterService ?? "disposal" : null,
      battery: input.battery || null,
      battery_id: input.batteryId || null,
      tank_no: input.tankNo || null,
      lease_id: input.leaseId || null,
      gatherer_id: input.gathererId || null,
      bbl_per_inch: ratio,
      capacity_bbls: input.capacityBbls ?? null,
      allocation_method: input.allocationMethod ?? "straight",
      injection_well_id: input.injectionWellId || null,
      injection_share_pct: input.injectionSharePct ?? null,
      active: input.active ?? true,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createTank: ${error.message}`);
  // The folder is named after the tank, and the tank's name is derived from its
  // lease — which the insert only knows as an id (or not at all, when the lease
  // comes down from a battery). Read the row back and let `mapTank` name it.
  await ensureFacilityFolder(
    sb,
    "tank",
    data.id,
    (await getTank(sb, data.id))?.name ??
      tankDisplayName("", input.tankNo, input.product),
    input.product
  );
  return { id: data.id };
}

/** Update a tank's fields (only the keys present in `patch` change). */
export async function updateTank(
  sb: Sb,
  id: string,
  patch: TankPatch
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.product !== undefined) update.product = patch.product;
  /*
   * The two columns move together. A tank turned into water needs a service
   * (the DB rejects a null one), and a tank turned into oil must lose the one
   * it had — so a `product` patch without an explicit service still writes the
   * matching value rather than leaving the row in a shape the constraint
   * refuses.
   */
  if (patch.waterService !== undefined || patch.product !== undefined) {
    const product = patch.product;
    update.water_service =
      product === "water"
        ? patch.waterService ?? "disposal"
        : product !== undefined
          ? null
          : patch.waterService ?? null;
  }
  if (patch.battery !== undefined) update.battery = patch.battery || null;
  if (patch.batteryId !== undefined) update.battery_id = patch.batteryId || null;
  if (patch.tankNo !== undefined) update.tank_no = patch.tankNo || null;
  if (patch.leaseId !== undefined) update.lease_id = patch.leaseId || null;
  if (patch.gathererId !== undefined)
    update.gatherer_id = patch.gathererId || null;
  if (patch.bblPerInch !== undefined) update.bbl_per_inch = patch.bblPerInch;
  if (patch.capacityBbls !== undefined)
    update.capacity_bbls = patch.capacityBbls;
  if (patch.allocationMethod !== undefined)
    update.allocation_method = patch.allocationMethod;
  if (patch.injectionWellId !== undefined)
    update.injection_well_id = patch.injectionWellId || null;
  if (patch.injectionSharePct !== undefined)
    update.injection_share_pct = patch.injectionSharePct;
  if (patch.active !== undefined) update.active = patch.active;
  if (Object.keys(update).length === 0) return;

  const { error } = await sb.from("tanks").update(update).eq("id", id);
  if (error) throw new Error(`updateTank: ${error.message}`);
  // The derived name moves when its INPUTS move: the tank number, the battery
  // link that decides which lease the tank sits on, or — for a standalone tank —
  // its own lease. Any of the three renames the folder; there is no name field
  // to trigger off any more.
  if (
    patch.tankNo !== undefined ||
    patch.batteryId !== undefined ||
    patch.leaseId !== undefined ||
    // Oil ↔ water swaps the name's letter (T123 ↔ W123), so it renames too.
    patch.product !== undefined
  ) {
    const renamed = await getTank(sb, id);
    if (renamed) await renameFacilityFolder(sb, "tank", id, renamed.name);
  }
  // Oil ↔ water moves the tank between the Oil and Saltwater folders.
  if (patch.product !== undefined) {
    await moveFacilityFolder(sb, "tank", id, patch.product);
  }
}

/**
 * Delete a tank — a SOFT delete (2026081800200_facility_soft_delete.sql): the
 * row is stamped `deleted_at` and the RLS policies stop returning it, so its
 * gauge readings, run tickets and allocations survive instead of cascading
 * away. RLS scopes it to the caller's org and gates it on
 * `manage_well_production`.
 */
export async function deleteTank(sb: Sb, id: string): Promise<void> {
  // Through the RPC, never a bare update: the policies hide `deleted_at`-
  // stamped rows, and Postgres applies that SELECT policy to the new row of the
  // very update that stamps it (2026081800300_soft_delete_facility_fn.sql).
  const { error } = await sb.rpc("soft_delete_facility", {
    p_kind: "tank",
    p_id: id,
  });
  if (error) throw new Error(`deleteTank: ${error.message}`);
}

/**
 * Reassign a well to an oil tank: allocate `tankId` to the well (100%) and drop
 * the well's allocation rows on any other oil tank, so it keeps exactly one oil
 * tank — the one whose `bbl_per_inch` drives its oil conversion
 * (`getWellOilRatio`). Passing `null` drops the well's oil-tank allocation
 * row(s) without linking a new one. The detached tank isn't deleted; it just
 * loses this well from its split.
 *
 * The `tank_well_allocations` row this writes is a STRAPPING link, not the oil
 * split: oil is allocated at the tank's BATTERY and the engine never reads this
 * table for it. So the well is also made a member of that battery
 * (`ensureBatteryMembership`) — otherwise picking a tank here wired a well that
 * showed a connection everywhere and produced zero barrels.
 */
export async function setWellTanks(
  sb: Sb,
  wellId: string,
  tankIds: string[],
  /**
   * Which side of the well this is about. A producer runs oil into oil tanks; a
   * disposal well takes saltwater out of water tanks, and neither edit may
   * detach the other's rows.
   */
  product: "oil" | "water" = "oil"
): Promise<void> {
  const wanted = [...new Set(tankIds.filter(Boolean))];

  // The oil tanks this well is currently allocated to.
  const { data: rows, error: rErr } = await sb
    .from("tank_well_allocations")
    .select("tank_id, tanks!inner(product)")
    .eq("well_id", wellId)
    .eq("tanks.product", product);
  if (rErr) throw new Error(`setWellTanks (list): ${rErr.message}`);

  const detachIds = ((rows ?? []) as { tank_id: string }[])
    .map((r) => r.tank_id)
    .filter((id) => !wanted.includes(id));
  if (detachIds.length > 0) {
    const { error } = await sb
      .from("tank_well_allocations")
      .delete()
      .eq("well_id", wellId)
      .in("tank_id", detachIds);
    if (error) throw new Error(`setWellTanks (detach): ${error.message}`);
  }

  for (const tankId of wanted) {
    /*
     * A tank's shares are shares OF THAT TANK, so what this well takes depends
     * on who else is already on it: the first well on a tank takes the whole of
     * it, and one joining a tank that already has wells starts at 0% for the
     * operator to split — the same rule `ensureBatteryMembership` uses, and for
     * the same reason (a share invented here would silently take volume off the
     * wells already there).
     */
    // Read the rows rather than a HEAD count — see `setWellMeters`: the
    // counting form returns no body and errors with an empty message.
    const { data: onTank, error: cErr } = await sb
      .from("tank_well_allocations")
      .select("well_id")
      .eq("tank_id", tankId);
    if (cErr) {
      throw new Error(
        `setWellTanks (existing wells): ${cErr.message || cErr.code || "unknown error"}`
      );
    }
    const others = ((onTank ?? []) as { well_id: string }[]).filter(
      (r) => r.well_id !== wellId
    );
    await addTankAllocationsForWells(sb, tankId, [wellId], others.length ? 0 : 100);
    const battery = await tankBatteryId(sb, tankId);
    if (battery) await ensureBatteryMembership(sb, battery, wellId);
  }
}

/** The battery a tank sits on, or null. */
async function tankBatteryId(sb: Sb, tankId: string): Promise<string | null> {
  const { data, error } = await sb
    .from("tanks")
    .select("battery_id")
    .eq("id", tankId)
    .maybeSingle();
  if (error) throw new Error(`tankBatteryId: ${error.message}`);
  return (data as { battery_id: string | null } | null)?.battery_id ?? null;
}

/**
 * Set a well's oil strapping factor by upserting its default oil tank. Used by
 * `createWell` / `updateWell` so the well's edit-data modal keeps writing one
 * ratio while the value now lives on the tank. No-op if the value is unchanged.
 */
export async function setWellOilRatio(
  sb: Sb,
  wellId: string,
  ratio: number
): Promise<void> {
  const clean = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const existing = await getWellOilTank(sb, wellId);
  if (existing) {
    if (existing.bblPerInch === clean) return;
    const { error } = await sb
      .from("tanks")
      .update({ bbl_per_inch: clean })
      .eq("id", existing.id);
    if (error) throw new Error(`setWellOilRatio (update): ${error.message}`);
    return;
  }
  const { id } = await createTank(sb, {
    product: "oil",
    bblPerInch: clean,
  });
  await addTankAllocationsForWells(sb, id, [wellId], 100);
}

// --- Tank readings ---------------------------------------------------------

/**
 * A tank's gauge readings (excluding soft-deleted), oldest first.
 *
 * Paginated: PostgREST caps a single response at 1000 rows, so a tank with more
 * than that would otherwise return only the oldest 1000 (silently cutting the
 * table off mid-history). We page through in 1000-row windows until drained.
 */
export async function listTankReadings(
  sb: Sb,
  tankId: string
): Promise<TankReading[]> {
  // The one-tank form of `listReadingsByTank`, sharing its RPC: narrowing to a
  // single tank does not avoid the read policy's per-row `current_org_id()`, and
  // the callers that hurt run this once per tank in a loop.
  return (await listReadingsByTank(sb, [tankId])).get(tankId) ?? [];
}

/**
 * Readings for a SET of tanks, keyed by tank id (each list oldest-first) — the
 * bulk form of {@link listTankReadings}. Well-test derivation resolves many tests
 * at once and each names an isolation tank plus control tanks, so this loads every
 * referenced tank's series in one round trip instead of an N+1 per test.
 */
export async function listReadingsByTank(
  sb: Sb,
  tankIds: string[],
  /** ISO day. Readings on or after it plus each tank's last one before it (the
   *  opening level of the first in-window segment). Unset: whole history. */
  from?: string
): Promise<Map<string, TankReading[]>> {
  if (process.env.PERF_TRACE_BATCH === "1") {
    // Measurement only: which caller issued this bulk read. A reading query
    // that starts a wave late is only fixable once its requester is known.
    console.info(`[read] listReadingsByTank opened by ${new Error().stack?.split("\n")[2]?.trim()}`);
  }
  const out = new Map<string, TankReading[]>();
  const ids = [...new Set(tankIds.filter(Boolean))];
  if (ids.length === 0) return out;

  // Through the RPC (2026081700500) for the same reason its meter twin is: read
  // as a plain query, the row-security predicate ran `current_org_id()` — four
  // subqueries — on every reading, and again for each 1,000-row page. See
  // `meter_readings_for_meters`; this is the same outage on a smaller table.
  type FlatRow = Omit<TankReadingRow, "tanks"> & { bbl_per_inch: number | null };
  const rows: TankReadingRow[] = [];
  // `p_org` is read ONLY when the caller is the service role (2026081900100);
  // a request-scoped client resolves its own org and passes null here.
  const base = { ids, p_org: serviceOrgFor(sb) };
  let paged = await rpcAllRows<FlatRow>(
    sb,
    "tank_readings_for_tanks",
    from ? { ...base, p_from: from } : base,
    { chunkKey: "ids" }
  );
  if (paged.error && from && isMissingFunction(paged.error)) {
    // Windowed overload not pushed yet (2026090900200): whole history instead.
    paged = await rpcAllRows<FlatRow>(sb, "tank_readings_for_tanks", base, { chunkKey: "ids" });
  }
  if (paged.error) {
    if (isMissingFunction(paged.error)) {
      rows.push(...(await listReadingsByTankFallback(sb, ids)));
    } else {
      throw new Error(`listReadingsByTank: ${paged.error.message}`);
    }
  } else {
    // The function returns the strapping factor flat; `mapReading` reads it off
    // the shape the embedded join produced, so re-nest it here rather than
    // teaching every caller two shapes.
    rows.push(...paged.rows.map((r) => ({ ...r, tanks: { bbl_per_inch: r.bbl_per_inch } })));
  }

  for (const r of rows) {
    const mapped = mapReading(r);
    const list = out.get(mapped.tankId);
    if (list) list.push(mapped);
    else out.set(mapped.tankId, [mapped]);
  }
  return out;
}

/** {@link listReadingsByTank} before 2026081700500 — slow, not wrong, and only
 *  reached in the window before that migration is pushed. */
async function listReadingsByTankFallback(
  sb: Sb,
  ids: string[]
): Promise<TankReadingRow[]> {
  const PAGE = 1000;
  const rows: TankReadingRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("tank_readings")
      .select(READING_COLS)
      .in("tank_id", ids)
      .is("deleted_at", null)
      .order("reading_date", { ascending: true })
      .order("reading_time", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listReadingsByTank: ${error.message}`);
    const page = (data ?? []) as unknown as TankReadingRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/**
 * Current barrels on hand for every tank in the org, keyed by tank id — the
 * latest (by date, then time) non-deleted reading's derived bbls. Powers the
 * Tanks list's "% full" column without an N+1 of per-tank queries. Tanks with no
 * readings are simply absent from the map (callers treat that as 0).
 */
export async function latestBblsByTank(
  sb: Sb
): Promise<Record<string, number>> {
  // One row per tank, resolved in the database (2026081700300, made org-scoped
  // and SECURITY DEFINER in 2026081700400 — the row-security predicate, not the
  // data, was what timed this out; it called `current_org_id()` per row).
  // This used to select EVERY non-deleted reading ordered by date and keep the
  // last one seen per tank. PostgREST caps the rows it returns, but Postgres
  // still sorts the whole table to find them, so the cost grew with history
  // until /disposal died on `canceling statement due to statement timeout` —
  // and because the cap fell on an ASCENDING read, the "latest" reading kept
  // was really the newest of the oldest page.
  const { data, error } = await sb.rpc("latest_tank_readings");
  if (!error) {
    const out: Record<string, number> = {};
    for (const r of (data ?? []) as LatestTankReadingRow[]) {
      out[r.tank_id] = bblsFromGauge(r.gauge ?? 0, r.bbl_per_inch ?? 1);
    }
    return out;
  }
  // The function is missing until that migration is pushed. Fall back to one
  // indexed lookup per tank rather than to the query that timed out: chattier,
  // but every one of them is a single row off `tank_readings_tank_date_idx`.
  if (!isMissingFunction(error)) {
    throw new Error(`latestBblsByTank: ${error.message}`);
  }
  return latestBblsPerTankFallback(sb);
}

/** A row of `latest_tank_readings()`: one tank's latest gauge and strapping. */
interface LatestTankReadingRow {
  tank_id: string;
  gauge: number | null;
  bbl_per_inch: number | null;
}

async function latestBblsPerTankFallback(
  sb: Sb
): Promise<Record<string, number>> {
  const { data: tankRows, error: tankErr } = await sb
    .from("tanks")
    .select("id, bbl_per_inch");
  if (tankErr) throw new Error(`latestBblsByTank: ${tankErr.message}`);

  const tanks = (tankRows ?? []) as { id: string; bbl_per_inch: number | null }[];
  const out: Record<string, number> = {};
  const BATCH = 8;
  for (let i = 0; i < tanks.length; i += BATCH) {
    const batch = tanks.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((t) =>
        sb
          .from("tank_readings")
          .select("tank_id, gauge")
          .eq("tank_id", t.id)
          .is("deleted_at", null)
          .order("reading_date", { ascending: false })
          // Nulls first on the way down: a reading with no clock time was the
          // last of its date under the ascending read this replaces.
          .order("reading_time", { ascending: false, nullsFirst: true })
          .limit(1)
          .maybeSingle<{ tank_id: string; gauge: number | null }>()
          .then((res) => ({ ...res, bblPerInch: t.bbl_per_inch }))
      )
    );
    for (const { data, error, bblPerInch } of results) {
      if (error) throw new Error(`latestBblsByTank: ${error.message}`);
      if (data) out[data.tank_id] = bblsFromGauge(data.gauge ?? 0, bblPerInch ?? 1);
    }
  }
  return out;
}

// Tank comments moved to the shared facility thread — `@/lib/comments`. A tank
// is one facility among five now, and an SWD tank is the same `tanks` row as a
// production tank, so both pages read one conversation.

/**
 * Record a gauge reading on a tank. Only the raw gauge (inches) is stored;
 * barrels are derived at read time from the tank's current strapping factor.
 * Returns its id.
 */
export async function addTankReading(
  sb: Sb,
  tankId: string,
  reading: TankReadingInput
): Promise<{ id: string }> {
  const { data, error } = await sb
    .from("tank_readings")
    .insert({
      tank_id: tankId,
      reading_date: reading.date,
      // Pin a blank time to midnight so (tank, date, time) uniqueness is stable.
      reading_time: reading.time || "00:00",
      gauge: reading.gauge,
      pulled_bottom: reading.pulledBottom ?? null,
      water_hauled: reading.waterHauled ?? null,
      hot_oil: reading.hotOil ?? null,
      comments: reading.comments?.trim() || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`addTankReading: ${error.message}`);
  return { id: data.id };
}

/**
 * Bulk-insert many gauge readings in one round trip per chunk — the fast path for
 * an approval that lands hundreds/thousands of rows at once (row-by-row inserts
 * turned that into as many sequential DB calls). Callers must dedup first: this is
 * a plain insert, so a duplicate `(tank_id, reading_date, reading_time)` aborts
 * its chunk. Returns the number of rows inserted.
 */
export async function addTankReadings(
  sb: Sb,
  items: { tankId: string; reading: TankReadingInput }[]
): Promise<number> {
  if (items.length === 0) return 0;
  const records = items.map(({ tankId, reading }) => ({
    tank_id: tankId,
    reading_date: reading.date,
    reading_time: reading.time || "00:00",
    gauge: reading.gauge,
    pulled_bottom: reading.pulledBottom ?? null,
    water_hauled: reading.waterHauled ?? null,
    hot_oil: reading.hotOil ?? null,
    comments: reading.comments?.trim() || null,
  }));
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const { data, error } = await sb
      .from("tank_readings")
      .insert(records.slice(i, i + CHUNK))
      .select("id");
    if (error) throw new Error(`addTankReadings: ${error.message}`);
    inserted += data?.length ?? 0;
  }
  return inserted;
}

/**
 * Update a reading, scoped to its tank. Only the raw gauge (inches) is stored;
 * barrels are derived at read time. `updatedBy` stamps the audit trail (the DB
 * trigger stamps `updated_at`).
 */
export async function updateTankReading(
  sb: Sb,
  tankId: string,
  id: string,
  patch: TankReadingInput & { updatedBy?: string | null }
): Promise<void> {
  const update: Record<string, unknown> = {
    reading_date: patch.date,
    reading_time: patch.time || "00:00",
    gauge: patch.gauge,
    pulled_bottom: patch.pulledBottom ?? null,
    water_hauled: patch.waterHauled ?? null,
    hot_oil: patch.hotOil ?? null,
    comments: patch.comments?.trim() || null,
  };
  if (patch.updatedBy !== undefined) update.updated_by = patch.updatedBy;

  const { error } = await sb
    .from("tank_readings")
    .update(update)
    .eq("id", id)
    .eq("tank_id", tankId);
  if (error) throw new Error(`updateTankReading: ${error.message}`);
}

/**
 * Soft-delete a reading (stamps `deleted_at/by`), scoped to its tank. Readings
 * are never hard-deleted so GBC-10's measurement audit stays complete.
 */
export async function softDeleteTankReading(
  sb: Sb,
  tankId: string,
  id: string,
  deletedBy: string | null = null
): Promise<void> {
  const { error } = await sb
    .from("tank_readings")
    .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
    .eq("id", id)
    .eq("tank_id", tankId);
  if (error) throw new Error(`softDeleteTankReading: ${error.message}`);
}
