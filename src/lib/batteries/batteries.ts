import type { SupabaseClient } from "@supabase/supabase-js";
import { withFacilitySlugs } from "@/lib/facilities/slug-route";
import { ensureFacilityFolder, renameFacilityFolder } from "@/lib/files/facility-folder";

/**
 * Tank battery data-access (GBC). A tank battery is the physical facility that
 * groups tanks; each tank links to one via `tanks.battery_id`. Same client-
 * injected idiom as `@/lib/tanks/*` and `@/lib/leases/*`: every helper takes the
 * caller's Supabase client as its first argument. Pass the request-scoped RLS
 * client (`getSupabaseServer()`) — the `tank_batteries` policies scope reads to
 * `view_well_production`/`manage_well_production` and writes to
 * `manage_well_production` within `current_org_id()`. Never hand these the
 * service-role admin client — that bypasses RLS.
 */

type Sb = SupabaseClient;

/** A tank battery with a rollup of the tanks linked to it. */
export interface TankBattery {
  id: string;
  name: string;
  /**
   * The URL segment its detail page routes on — the name, suffixed only when
   * another battery in the org carries the same one. Stamped by the loaders that
   * read the whole set (see `withFacilitySlugs`); absent on rows loaded as a
   * subset, where a link falls back to the id and the page redirects.
   */
  slug?: string;
  /** Tanks linked to this battery (`tanks.battery_id`). */
  tankCount: number;
  /** The lease this battery belongs to (`tank_batteries.lease_id`), or null. */
  leaseId: string | null;
  /**
   * The SWD/injection well this battery's WATER feeds, or null. When set, the
   * battery is FLOW-THROUGH (Mode B): its water tanks' level is not a production
   * signal, and the disposal well's own meter is the volume source. A saltwater
   * station points at its well once here, rather than once per member tank
   * (`tanks.injection_well_id`, which remains for a standalone tank).
   */
  injectionWellId: string | null;
  /** This battery's fixed % of its SWD well's total under the `straight`
   *  method, or null (the `weighted` method derives it from water tests). */
  injectionSharePct: number | null;
  active: boolean;
}

/** Fields for creating a battery. `org_id`/`created_by` come from RLS defaults. */
export interface BatteryInput {
  name: string;
  active?: boolean;
}

/** Partial battery patch (only the keys present change). */
export interface BatteryPatch {
  name?: string;
  active?: boolean;
  /** SWD well this battery's water feeds; null unlinks it (Mode B). */
  injectionWellId?: string | null;
  /** Fixed % of that well under the `straight` method; null clears it. */
  injectionSharePct?: number | null;
  /**
   * The lease this battery belongs to (authoritative). Setting it fires the
   * `tank_batteries_cascade_lease` trigger, which repoints every member tank's
   * `lease_id`; pass null to unassign.
   */
  leaseId?: string | null;
}

const BATTERY_COLS =
  "id, name, lease_id, injection_well_id, injection_share_pct, active";

interface BatteryRow {
  id: string;
  name: string | null;
  lease_id: string | null;
  injection_well_id: string | null;
  injection_share_pct: number | null;
  active: boolean | null;
}

function mapBattery(r: BatteryRow, tankCount: number): TankBattery {
  return {
    id: r.id,
    name: r.name ?? "",
    tankCount,
    leaseId: r.lease_id ?? null,
    injectionWellId: r.injection_well_id ?? null,
    injectionSharePct: r.injection_share_pct ?? null,
    active: r.active ?? true,
  };
}

/** Tally `battery_id` occurrences across tanks (RLS-scoped) into a map. */
async function countByBattery(sb: Sb): Promise<Map<string, number>> {
  const { data, error } = await sb
    .from("tanks")
    .select("battery_id")
    .not("battery_id", "is", null);
  if (error) throw new Error(`countByBattery: ${error.message}`);
  const out = new Map<string, number>();
  for (const row of (data ?? []) as { battery_id: string | null }[]) {
    if (!row.battery_id) continue;
    out.set(row.battery_id, (out.get(row.battery_id) ?? 0) + 1);
  }
  return out;
}

// --- Reads -----------------------------------------------------------------

/** All batteries in the org (RLS-scoped) with tank counts, ordered by name. */
export async function listBatteries(sb: Sb): Promise<TankBattery[]> {
  const [res, counts] = await Promise.all([
    sb.from("tank_batteries").select(BATTERY_COLS).order("name"),
    countByBattery(sb),
  ]);
  if (res.error) throw new Error(`listBatteries: ${res.error.message}`);
  // Slugged against every battery in the org, which is what
  // `/production/batteries/[battery]` resolves against. See `withFacilitySlugs`.
  return withFacilitySlugs(
    ((res.data ?? []) as BatteryRow[]).map((r) =>
      mapBattery(r, counts.get(r.id) ?? 0)
    )
  );
}

/** A single battery by id, or null if it doesn't exist / isn't visible. */
export async function getBattery(
  sb: Sb,
  id: string
): Promise<TankBattery | null> {
  const { data, error } = await sb
    .from("tank_batteries")
    .select(BATTERY_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getBattery: ${error.message}`);
  if (!data) return null;
  const counts = await countByBattery(sb);
  return mapBattery(data as BatteryRow, counts.get(id) ?? 0);
}

// --- Writes ----------------------------------------------------------------

/** Create a battery; returns its id. `org_id` is assigned by RLS, not the caller. */
export async function createBattery(
  sb: Sb,
  input: BatteryInput
): Promise<{ id: string }> {
  const { data, error } = await sb
    .from("tank_batteries")
    .insert({ name: input.name, active: input.active ?? true })
    .select("id")
    .single();
  if (error) throw new Error(`createBattery: ${error.message}`);
  await ensureFacilityFolder(sb, "battery", data.id, input.name);
  return { id: data.id };
}

/** Update a battery's fields (only the keys present in `patch` change). */
export async function updateBattery(
  sb: Sb,
  id: string,
  patch: BatteryPatch
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.active !== undefined) update.active = patch.active;
  if (patch.leaseId !== undefined) update.lease_id = patch.leaseId;
  if (patch.injectionWellId !== undefined) {
    update.injection_well_id = patch.injectionWellId;
  }
  if (patch.injectionSharePct !== undefined) {
    update.injection_share_pct = patch.injectionSharePct;
  }
  if (Object.keys(update).length === 0) return;

  const { error } = await sb.from("tank_batteries").update(update).eq("id", id);
  if (error) throw new Error(`updateBattery: ${error.message}`);
  if (patch.name !== undefined) {
    await renameFacilityFolder(sb, "battery", id, patch.name);
  }
}

/**
 * Delete a battery — a SOFT delete (2026081800200_facility_soft_delete.sql).
 * The row is stamped `deleted_at` and the RLS policies stop returning it; its
 * member tanks keep their `battery_id`, so restoring the battery restores the
 * station rather than a shell. RLS scopes it to the caller's org and gates it
 * on `manage_well_production`.
 */
export async function deleteBattery(sb: Sb, id: string): Promise<void> {
  // See `deleteTank` — the stamp goes through the security-definer RPC.
  const { error } = await sb.rpc("soft_delete_facility", {
    p_kind: "battery",
    p_id: id,
  });
  if (error) throw new Error(`deleteBattery: ${error.message}`);
}

/**
 * Set the exact set of tanks in a battery: link every id in `tankIds` to it and
 * unlink any tank currently on the battery that is no longer selected. The DB
 * trigger (`adopt_battery_lease`) cascades the battery's lease down to newly
 * linked tanks. RLS scopes both writes to the caller's org.
 */
export async function setBatteryTanks(
  sb: Sb,
  batteryId: string,
  tankIds: string[]
): Promise<void> {
  const ids = [...new Set(tankIds.filter(Boolean))];

  // Unlink tanks currently on this battery that were deselected.
  let unlink = sb
    .from("tanks")
    .update({ battery_id: null })
    .eq("battery_id", batteryId);
  if (ids.length > 0) unlink = unlink.not("id", "in", `(${ids.join(",")})`);
  const { error: unlinkErr } = await unlink;
  if (unlinkErr) throw new Error(`setBatteryTanks (unlink): ${unlinkErr.message}`);

  // Link the selected tanks.
  if (ids.length > 0) {
    const { error: linkErr } = await sb
      .from("tanks")
      .update({ battery_id: batteryId })
      .in("id", ids);
    if (linkErr) throw new Error(`setBatteryTanks (link): ${linkErr.message}`);
  }
}

/**
 * The batteries whose water feeds one SWD/injection well — the battery twin of
 * `listInjectionTanks`. A member tank of one of these is plumbed into the same
 * hole without carrying the link itself.
 */
export async function listInjectionBatteries(
  sb: Sb,
  wellId: string
): Promise<TankBattery[]> {
  const [res, counts] = await Promise.all([
    sb
      .from("tank_batteries")
      .select(BATTERY_COLS)
      .eq("injection_well_id", wellId)
      .order("name"),
    countByBattery(sb),
  ]);
  if (res.error) throw new Error(`listInjectionBatteries: ${res.error.message}`);
  return ((res.data ?? []) as BatteryRow[]).map((r) =>
    mapBattery(r, counts.get(r.id) ?? 0)
  );
}
