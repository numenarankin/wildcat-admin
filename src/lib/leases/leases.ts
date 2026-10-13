import type { SupabaseClient } from "@supabase/supabase-js";
import { withFacilitySlugs } from "@/lib/facilities/slug-route";
import { ensureFacilityFolder, renameFacilityFolder } from "@/lib/files/facility-folder";

/**
 * Lease data-access (GBC). A lease is the land/legal unit that sits above
 * tanks/meters (which sit above wells). Each lease has a required lease number
 * and carries its wells, tanks, and meters via their nullable `lease_id`.
 *
 * Same idiom as `@/lib/tanks/*`: every helper takes the caller's Supabase
 * client as its first argument. Pass the request-scoped RLS client
 * (`getSupabaseServer()`) — the `leases` policies scope reads to
 * `view_leases`/`manage_leases` and writes to `manage_leases` within
 * `current_org_id()`. Never hand these the service-role admin client.
 *
 * Royalty/interest still keys off wells at this stage; `netInterestPct` is
 * therefore null until the interest join is re-pointed to the lease (see
 * docs/plans/leases.md, phase 4).
 */

type Sb = SupabaseClient;

/** A lease with rollup counts of the wells/tanks/meters assigned to it. */
export interface Lease {
  id: string;
  /** The lease number — the identifier every lease is known by. */
  leaseNo: string;
  name: string;
  county: string;
  /** Wells assigned to this lease (`wells.lease_id`). */
  wellCount: number;
  /** Tanks assigned to this lease (`tanks.lease_id`). */
  tankCount: number;
  /** Meters assigned to this lease (`meters.lease_id`). */
  meterCount: number;
  /** Aggregate net revenue interest across owners, or null until interest is
   * re-pointed to the lease. */
  netInterestPct: number | null;
  active: boolean;
  /**
   * The URL segment its page routes on — the name, suffixed only when another
   * lease in the org carries the same one. Stamped by the loaders that read the
   * whole set (see `withFacilitySlugs`); absent on a lease the client has just
   * created optimistically, which slugs itself against the list it is joining.
   */
  slug?: string;
}

/** Fields for creating a lease. `org_id`/`created_by` come from RLS defaults. */
export interface LeaseInput {
  /** Optional lease number (unique per org when present); blank stores as NULL. */
  leaseNo?: string;
  name: string;
  county?: string | null;
  active?: boolean;
}

/** Partial lease patch (only the keys present change). */
export interface LeasePatch {
  leaseNo?: string;
  name?: string;
  county?: string | null;
  active?: boolean;
}

const LEASE_COLS = "id, lease_no, name, county, active";

interface LeaseRow {
  id: string;
  lease_no: string | null;
  name: string | null;
  county: string | null;
  active: boolean | null;
}

function mapLease(
  r: LeaseRow,
  counts: { wells: number; tanks: number; meters: number }
): Lease {
  return {
    id: r.id,
    leaseNo: r.lease_no ?? "",
    name: r.name ?? "",
    county: r.county ?? "",
    wellCount: counts.wells,
    tankCount: counts.tanks,
    meterCount: counts.meters,
    netInterestPct: null,
    active: r.active ?? true,
  };
}

/** Tally `lease_id` occurrences across a table (RLS-scoped) into a map. */
async function countByLease(
  sb: Sb,
  table: "wells" | "tanks" | "meters",
  orgId?: string
): Promise<Map<string, number>> {
  let query = sb.from(table).select("lease_id").not("lease_id", "is", null);
  if (orgId) query = query.eq("org_id", orgId);
  const { data, error } = await query;
  if (error) throw new Error(`countByLease(${table}): ${error.message}`);
  const out = new Map<string, number>();
  for (const row of (data ?? []) as { lease_id: string | null }[]) {
    if (!row.lease_id) continue;
    out.set(row.lease_id, (out.get(row.lease_id) ?? 0) + 1);
  }
  return out;
}

// --- Reads -----------------------------------------------------------------

/** All leases in the org (RLS-scoped) with rollup counts, ordered by number. */
export async function listLeases(
  sb: Sb,
  /** Service-role callers with no RLS org context (the digest cron) name their
   *  org; RLS callers omit it. Same contract as `listTanks`. */
  opts?: { orgId?: string }
): Promise<Lease[]> {
  const orgId = opts?.orgId;
  let leaseQuery = sb.from("leases").select(LEASE_COLS).order("lease_no");
  if (orgId) leaseQuery = leaseQuery.eq("org_id", orgId);
  const [leasesRes, wells, tanks, meters] = await Promise.all([
    leaseQuery,
    countByLease(sb, "wells", orgId),
    countByLease(sb, "tanks", orgId),
    countByLease(sb, "meters", orgId),
  ]);
  if (leasesRes.error) throw new Error(`listLeases: ${leasesRes.error.message}`);
  // Slugged against every lease in the org, which is what `/leases/[lease]`
  // resolves a param against. See `withFacilitySlugs`.
  return withFacilitySlugs(
    ((leasesRes.data ?? []) as LeaseRow[]).map((r) =>
      mapLease(r, {
        wells: wells.get(r.id) ?? 0,
        tanks: tanks.get(r.id) ?? 0,
        meters: meters.get(r.id) ?? 0,
      })
    )
  );
}

/** Just enough to label a lease in a picker. */
export interface LeaseOption {
  id: string;
  leaseNo: string;
  name: string;
}

/**
 * Leases for a dropdown — id and label only.
 *
 * {@link listLeases} costs FOUR queries, three of them full-table scans of
 * `wells` / `tanks` / `meters` to roll up per-lease counts. Only the /leases
 * table renders those counts; every other caller wants a picker. This is the one
 * query that answers that.
 */
export async function listLeaseOptions(sb: Sb): Promise<LeaseOption[]> {
  const { data, error } = await sb
    .from("leases")
    .select("id, lease_no, name")
    .order("lease_no");
  if (error) throw new Error(`listLeaseOptions: ${error.message}`);
  return ((data ?? []) as { id: string; lease_no: string | null; name: string | null }[])
    .map((r) => ({ id: r.id, leaseNo: r.lease_no ?? "", name: r.name ?? "" }));
}

/** A single lease by id, or null if it doesn't exist / isn't visible. */
export async function getLease(sb: Sb, id: string): Promise<Lease | null> {
  const { data, error } = await sb
    .from("leases")
    .select(LEASE_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getLease: ${error.message}`);
  if (!data) return null;
  const [wells, tanks, meters] = await Promise.all([
    countByLease(sb, "wells"),
    countByLease(sb, "tanks"),
    countByLease(sb, "meters"),
  ]);
  return mapLease(data as LeaseRow, {
    wells: wells.get(id) ?? 0,
    tanks: tanks.get(id) ?? 0,
    meters: meters.get(id) ?? 0,
  });
}

// --- Writes ----------------------------------------------------------------

/** Create a lease; returns its id. `org_id` is assigned by RLS, not the caller. */
export async function createLease(
  sb: Sb,
  input: LeaseInput
): Promise<{ id: string }> {
  const { data, error } = await sb
    .from("leases")
    .insert({
      // Optional: a blank number stores as NULL so the (org_id, lease_no) unique
      // index doesn't collide across multiple no-number leases ("" would).
      lease_no: input.leaseNo?.trim() || null,
      name: input.name,
      county: input.county || null,
      active: input.active ?? true,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createLease: ${error.message}`);
  await ensureFacilityFolder(sb, "lease", data.id, input.name);
  return { id: data.id };
}

/** Update a lease's fields (only the keys present in `patch` change). */
export async function updateLease(
  sb: Sb,
  id: string,
  patch: LeasePatch
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.leaseNo !== undefined) update.lease_no = patch.leaseNo.trim() || null;
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.county !== undefined) update.county = patch.county || null;
  if (patch.active !== undefined) update.active = patch.active;
  if (Object.keys(update).length === 0) return;

  const { error } = await sb.from("leases").update(update).eq("id", id);
  if (error) throw new Error(`updateLease: ${error.message}`);
  if (patch.name !== undefined) {
    await renameFacilityFolder(sb, "lease", id, patch.name);
  }
}

/**
 * Hard-delete a lease. Its wells, tanks, and meters keep their rows but lose the
 * assignment (`lease_id` FKs are `on delete set null`); per-lease interest rows
 * are removed (`on delete cascade`). RLS scopes the delete to the org and gates
 * it on `manage_leases`.
 */
export async function deleteLease(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("leases").delete().eq("id", id);
  if (error) throw new Error(`deleteLease: ${error.message}`);
}

// --- Assignment ------------------------------------------------------------
// Set a well/tank/meter's `lease_id` (null unassigns). Governed by the child
// table's own write policy (wells → add_wells; tanks/meters →
// manage_well_production), so the caller needs that capability too.

/** Assign a well to a lease (or `null` to unassign). */
export async function setWellLease(
  sb: Sb,
  wellId: string,
  leaseId: string | null
): Promise<void> {
  const { error } = await sb
    .from("wells")
    .update({ lease_id: leaseId })
    .eq("id", wellId);
  if (error) throw new Error(`setWellLease: ${error.message}`);
}

/** Assign a tank to a lease (or `null` to unassign). */
export async function setTankLease(
  sb: Sb,
  tankId: string,
  leaseId: string | null
): Promise<void> {
  const { error } = await sb
    .from("tanks")
    .update({ lease_id: leaseId })
    .eq("id", tankId);
  if (error) throw new Error(`setTankLease: ${error.message}`);
}

/** Assign a meter to a lease (or `null` to unassign). */
export async function setMeterLease(
  sb: Sb,
  meterId: string,
  leaseId: string | null
): Promise<void> {
  const { error } = await sb
    .from("meters")
    .update({ lease_id: leaseId })
    .eq("id", meterId);
  if (error) throw new Error(`setMeterLease: ${error.message}`);
}
