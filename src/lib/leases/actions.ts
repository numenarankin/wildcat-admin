"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { cachedLeases } from "@/lib/cache/loaders";
import { deleteCommentsFor } from "@/lib/comments/comments";
import {
  listLeaseOptions,
  type LeaseOption,
  createLease,
  deleteLease,
  getLease,
  listLeases,
  setMeterLease,
  setTankLease,
  setWellLease,
  updateLease,
  type Lease,
  type LeaseInput,
  type LeasePatch,
} from "@/lib/leases/leases";
import { requirePermission, userCan } from "@/lib/auth/permissions";
import { listBatteries } from "@/lib/batteries/batteries";
import { listWellNavRows } from "@/lib/wells/wells";
import { buildLeaseNavTree, type LeaseNavLease } from "@/lib/leases/nav-tree";
import { listLeaseTanks, listTanks, type Tank } from "@/lib/tanks/tanks";
import { listTankAllocations } from "@/lib/tanks/allocations";
import { listLeaseMeters, listMeters, type Meter } from "@/lib/meters/meters";
import { listMeterAllocations } from "@/lib/meters/allocations";

/**
 * Server actions for leases — thin wrappers over the `@/lib/leases/leases`
 * data-access layer that run through the request-scoped RLS client (org
 * ownership + the view/manage_leases capabilities are enforced by RLS) and
 * revalidate the affected pages. The lease UI calls these; the data-access
 * layer stays client-injectable for tests.
 */

/** List all leases in the org with rollup counts. */
export async function getLeases(): Promise<Lease[]> {
  const sb = await getRequestSupabase();
  // Memoized per request scope; a plain read outside one (server actions).
  return cachedLeases(sb);
}

/** Leases as picker options — one query, no roll-up counts. */
export async function getLeaseOptions(): Promise<LeaseOption[]> {
  const sb = await getRequestSupabase();
  return listLeaseOptions(sb);
}

/**
 * Every lease with the facilities that sit on it, for the sidebar's Leases
 * flyout. One read per facility table, no rates or series: the flyout is a menu,
 * and the heavy per-facility loaders belong to the pages it links to. Wells come
 * from `listWellNavRows` for that reason — `getWells` reads a strapping join
 * this menu has no use for.
 *
 * Gated on the same capability as `/leases` — the nav item that opens the flyout
 * is hidden without it, and this is the server-side half of that (RLS scopes the
 * rows themselves either way).
 *
 * Meters are read once per substance rather than as `"all"`, because a meter's
 * slug is only valid against the substance-filtered list its detail page
 * resolves against (see `withFacilitySlugs`).
 */
export async function getLeaseNavTree(): Promise<LeaseNavLease[]> {
  await requirePermission(["view_leases", "manage_leases"]);
  return readLeaseNavTree();
}

/**
 * The same tree for the ROOT LAYOUT, which renders on every page load and
 * hands it to the flyout so hovering Leases is instant. Null, not a throw,
 * for a user who cannot see leases (the nav item is hidden for them anyway)
 * and on a read failure: the sidebar must never take the page down, and the
 * flyout still fetches on hover when it has nothing.
 */
export async function getLeaseNavTreeForLayout(): Promise<LeaseNavLease[] | null> {
  try {
    if (!(await userCan(["view_leases", "manage_leases"]))) return null;
    return await readLeaseNavTree();
  } catch (error) {
    console.error("getLeaseNavTreeForLayout", error);
    return null;
  }
}

async function readLeaseNavTree(): Promise<LeaseNavLease[]> {
  const sb = await getRequestSupabase();
  const [leases, tanks, gasMeters, waterMeters, batteries, wells] =
    await Promise.all([
      listLeases(sb),
      listTanks(sb),
      listMeters(sb, "gas"),
      listMeters(sb, "water"),
      listBatteries(sb),
      listWellNavRows(sb),
    ]);
  return buildLeaseNavTree({
    leases,
    tanks,
    meters: [...gasMeters, ...waterMeters],
    batteries,
    wells,
  });
}

/** Fetch a single lease by id, or null if it isn't visible to the caller. */
export async function getLeaseById(id: string): Promise<Lease | null> {
  const sb = await getRequestSupabase();
  return getLease(sb, id);
}

/** The tanks assigned to a lease. */
export async function getLeaseTanks(leaseId: string): Promise<Tank[]> {
  const sb = await getRequestSupabase();
  return listLeaseTanks(sb, leaseId);
}

/** The meters assigned to a lease. */
export async function getLeaseMeters(leaseId: string): Promise<Meter[]> {
  const sb = await getRequestSupabase();
  return listLeaseMeters(sb, leaseId);
}

/** Create a lease; revalidates the lease index. */
export async function addLease(input: LeaseInput): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await createLease(sb, input);
  revalidatePath("/leases");
  return result;
}

/** Update a lease's fields; revalidates the index and the lease page. */
export async function editLease(
  id: string,
  patch: LeasePatch
): Promise<void> {
  const sb = await getSupabaseServer();
  await updateLease(sb, id, patch);
  revalidatePath("/leases");
  revalidatePath("/leases", "layout");
}

/**
 * Delete a lease. Its wells/tanks/meters keep their rows but lose the assignment
 * (FKs `on delete set null`); per-lease interest rows cascade away. Revalidates
 * the lease index.
 */
export async function removeLease(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  // Polymorphic comment key — no FK cascade, so sweep the thread explicitly.
  await deleteCommentsFor(sb, "lease", id);
  await deleteLease(sb, id);
  revalidatePath("/leases");
}

/** Assign a well to a lease (or `null` to unassign). */
export async function assignWellToLease(
  wellId: string,
  leaseId: string | null
): Promise<void> {
  const sb = await getSupabaseServer();
  await setWellLease(sb, wellId, leaseId);
  if (leaseId) revalidatePath("/leases", "layout");
  revalidatePath(`/wells/${wellId}`);
}

/**
 * The wells a device (tank/meter) measures, from its allocation split. This is
 * the authoritative membership set: a single-well device carries one 100% row
 * and a commingled device one row per well (see `addTankAllocationsForWells`),
 * so the split alone covers both. These are the wells auto-pulled onto the lease
 * when the device is assigned.
 */
async function wellsForDevice(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  kind: "tank" | "meter",
  deviceId: string
): Promise<string[]> {
  const allocations =
    kind === "tank"
      ? await listTankAllocations(sb, deviceId)
      : await listMeterAllocations(sb, deviceId);
  const ids = new Set<string>();
  for (const a of allocations) if (a.wellId) ids.add(a.wellId);
  return [...ids];
}

/**
 * Assign a device (tank/meter) to a lease and pull the wells it measures onto
 * the same lease, or `null` to unassign the device only (its wells keep their
 * current assignment). Consolidates the cascade shared by tank + meter assign.
 */
async function assignDeviceToLease(
  kind: "tank" | "meter",
  deviceId: string,
  leaseId: string | null
): Promise<void> {
  const sb = await getSupabaseServer();
  const setDeviceLease = kind === "tank" ? setTankLease : setMeterLease;
  await setDeviceLease(sb, deviceId, leaseId);
  if (!leaseId) return;

  // Auto-assign the device's wells to the same lease.
  const wellIds = await wellsForDevice(sb, kind, deviceId);
  await Promise.all(wellIds.map((id) => setWellLease(sb, id, leaseId)));

  revalidatePath("/leases", "layout");
  for (const id of wellIds) revalidatePath(`/wells/${id}`);
}

/**
 * Assign a tank to a lease (or `null` to unassign). Assigning also pulls the
 * wells in the tank's allocation split onto the lease.
 */
export async function assignTankToLease(
  tankId: string,
  leaseId: string | null
): Promise<void> {
  await assignDeviceToLease("tank", tankId, leaseId);
}

/**
 * Assign a meter to a lease (or `null` to unassign). Assigning also pulls the
 * wells in the meter's allocation split onto the lease.
 */
export async function assignMeterToLease(
  meterId: string,
  leaseId: string | null
): Promise<void> {
  await assignDeviceToLease("meter", meterId, leaseId);
}
