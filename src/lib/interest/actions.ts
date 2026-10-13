"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { getWellNameMap, getWells } from "@/lib/wells/wells";
import {
  addLeaseInterest,
  addWiOwnerInterest as addWiOwnerHolding,
  listAllInterests,
  listLeaseInterests,
  listMonthlyProductionVolumes,
  removeLeaseInterest,
  setLeaseInterest,
  upsertOperatorInterest,
  type InterestHolding,
  type InterestPatch,
  type InterestType,
  type MonthlyWellVolumes,
} from "@/lib/interest/interest";
import { getLeaseOptions } from "@/lib/leases/actions";
import {
  assembleGrossVsNet,
  interestByLease,
  ownedInterest,
  wellInterestFromLease,
  type GrossVsNetReport,
  type WellVolumeInterest,
} from "@/lib/interest/gross-net";

/**
 * Server actions for interest + the Gross-vs-Net report — thin wrappers over the
 * `@/lib/interest` data-access layer, run through the request-scoped RLS client
 * (org ownership enforced by RLS). The data-access layer stays client-injectable
 * for tests; these bind it to the server client.
 *
 * Interest is held per LEASE (`wells.lease_id` maps each well to its lease); the
 * Gross-vs-Net report stays per-well by resolving each well's interest through
 * its lease, so the reports UI/exports are unchanged.
 */

/**
 * An interest is a fraction of the lease, so 1 is the whole of it and there is
 * nothing above that. Checked here as well as in the Add-interest modal because
 * the table edits inline through `updateLeaseInterest`, which never passes
 * through that form — and a fraction typed as "12.5" instead of 0.125 would be
 * multiplied into every volume and revenue figure the lease reports.
 */
function assertFraction(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `${label} must be a fraction between 0 and 1 (0.125 = 12.5%), not ${value}.`
    );
  }
}

/** Both fractions of a holding, checked together. */
function assertInterestValues(values: {
  workingInterest?: number;
  netRevenueInterest?: number;
}): void {
  assertFraction(values.workingInterest, "Working interest");
  assertFraction(values.netRevenueInterest, "Net revenue interest");
}

/** The interest holdings for one lease. */
export async function getLeaseInterests(
  leaseId: string
): Promise<InterestHolding[]> {
  const sb = await getRequestSupabase();
  return listLeaseInterests(sb, leaseId);
}

/** Add a royalty owner's interest holding on a lease. */
export async function addOwnerInterest(
  leaseId: string,
  ownerId: string,
  values: {
    interestType: InterestType;
    workingInterest: number;
    netRevenueInterest: number;
  }
): Promise<void> {
  assertInterestValues(values);
  const sb = await getSupabaseServer();
  await addLeaseInterest(sb, leaseId, ownerId, values);
  revalidatePath("/leases", "layout");
}

/**
 * Add a holding under one of the ORG's own companies.
 *
 * Its own action rather than a flag on `addOwnerInterest` because the row means
 * something different: the fraction belongs to the user, so it counts toward
 * the org's NRI and never becomes a distribution. The company is named in
 * Settings, not created here, which is the point of the separation: these
 * entities are the company, and `addNewOwnerInterest` below puts a name in the
 * People directory, where they do not belong.
 */
export async function addWiOwnerInterest(
  leaseId: string,
  wiOwnerId: string,
  values: {
    interestType: InterestType;
    workingInterest: number;
    netRevenueInterest: number;
  }
): Promise<void> {
  assertInterestValues(values);
  const sb = await getSupabaseServer();
  await addWiOwnerHolding(sb, leaseId, wiOwnerId, values);
  revalidatePath("/leases", "layout");
}

/**
 * Create a brand-new royalty owner (a directory entry that shows up in /people)
 * and, only if that succeeds, grant it an interest holding on this lease — the
 * "Create new interest owner" path in the Add-interest modal. The owner is
 * created FIRST so a named owner always lands in the directory; the holding is
 * written second on the same RLS client. Revalidates both the lease page and the
 * People directory.
 */
export async function addNewOwnerInterest(
  leaseId: string,
  name: string,
  values: {
    interestType: InterestType;
    workingInterest: number;
    netRevenueInterest: number;
  }
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("addNewOwnerInterest: owner name is required");
  assertInterestValues(values);

  const sb = await getSupabaseServer();
  // 1) Create the directory entry (org_id/created_by come from RLS defaults,
  //    same as createRoyaltyOwner). Interest type/rate is NOT stored here — it
  //    lives on the per-lease holding written in step 2.
  const { data, error } = await sb
    .from("royalty_owners")
    .insert({
      name: trimmed,
      email: null,
      mailing_address: null,
      last_payment: 0,
      description: null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`addNewOwnerInterest (owner): ${error.message}`);

  // 2) Grant the interest on this lease to the owner we just created.
  await addLeaseInterest(sb, leaseId, data.id, values);

  revalidatePath("/leases", "layout");
  revalidatePath("/people");
}

/** Update one interest holding by row id; revalidates the lease page. */
export async function updateLeaseInterest(
  id: string,
  leaseId: string,
  patch: InterestPatch
): Promise<void> {
  assertInterestValues(patch);
  const sb = await getSupabaseServer();
  await setLeaseInterest(sb, id, leaseId, patch);
  revalidatePath("/leases", "layout");
}

/** Remove one interest holding by row id; revalidates the lease page. */
export async function removeInterest(
  id: string,
  leaseId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  await removeLeaseInterest(sb, id, leaseId);
  revalidatePath("/leases", "layout");
}

/**
 * Upsert the operator's own WI/NRI for a lease — the `is_operator` holding whose
 * GWI/NRI the Gross-vs-Net report applies to the gross volumes of every well on
 * the lease. At most one per lease. Revalidates the lease page.
 */
export async function saveOperatorInterest(
  leaseId: string,
  values: { workingInterest: number; netRevenueInterest: number }
): Promise<void> {
  assertInterestValues(values);
  const sb = await getSupabaseServer();
  await upsertOperatorInterest(sb, leaseId, values);
  revalidatePath("/leases", "layout");
}

/** One lease an interest owner holds a share of, with the share they hold. */
export interface OwnerLeaseInterest {
  leaseId: string;
  leaseNo: string;
  leaseName: string;
  interestType: InterestType;
  /** The fraction this owner holds — `ownedInterest` of the lease's holding. */
  interest: number;
  /** How many wells sit on that lease; the interest covers every one of them. */
  wellCount: number;
}

/**
 * Every lease an interest owner has a share of, with that share.
 *
 * Interest is held per LEASE — every well on the lease carries the same
 * holding — so the lease is the unit an owner actually owns a piece of, and one
 * row per lease is the honest shape of it. The well count says how much that
 * one holding covers without repeating the same percentage down a list.
 */
export async function getOwnerLeaseInterests(
  ownerId: string
): Promise<OwnerLeaseInterest[]> {
  const sb = await getSupabaseServer();
  const [holdings, wells, leases] = await Promise.all([
    listAllInterests(sb),
    getWells(),
    getLeaseOptions(),
  ]);
  const mine = holdings.filter((h) => h.ownerId === ownerId);
  if (mine.length === 0) return [];

  const leaseById = new Map(leases.map((l) => [l.id, l]));
  const wellCount = new Map<string, number>();
  for (const w of wells) {
    if (w.leaseId) wellCount.set(w.leaseId, (wellCount.get(w.leaseId) ?? 0) + 1);
  }

  return mine
    .map((h) => {
      const lease = leaseById.get(h.leaseId);
      return {
        leaseId: h.leaseId,
        leaseNo: lease?.leaseNo ?? "",
        leaseName: lease?.name ?? "",
        interestType: h.interestType,
        interest: ownedInterest(h),
        wellCount: wellCount.get(h.leaseId) ?? 0,
      };
    })
    .sort((a, b) =>
      (a.leaseName || a.leaseNo).localeCompare(b.leaseName || b.leaseNo, "en", {
        numeric: true,
      })
    );
}

/**
 * Gross monthly production volumes per well across every month — the Gross-vs-Net
 * report's raw material, loaded once for the reports hub.
 */
export async function getMonthlyProductionVolumes(): Promise<
  MonthlyWellVolumes[]
> {
  return listMonthlyProductionVolumes();
}

/** Map of well id → its lease id (or null), from `wells.lease_id`. */
async function wellLeaseMap(): Promise<Record<string, string | null>> {
  const wells = await getWells();
  return Object.fromEntries(wells.map((w) => [w.id, w.leaseId]));
}

/**
 * Per-WELL operator GWI/NRI, keyed by well id — for the reports hub. Interest is
 * held per lease, so each well inherits its lease's interest.
 */
export async function getWellInterestMap(): Promise<
  Record<string, WellVolumeInterest>
> {
  const sb = await getSupabaseServer();
  const [holdings, wellLease] = await Promise.all([
    listAllInterests(sb),
    wellLeaseMap(),
  ]);
  return wellInterestFromLease(interestByLease(holdings), wellLease);
}

/**
 * Build one month's Gross-vs-Net report server-side: gross monthly production
 * volumes × the operator's GWI/NRI per well (resolved through each well's
 * lease). Re-derived from the data, so the export route can trust it.
 */
export async function loadGrossVsNetReport(
  month: string
): Promise<GrossVsNetReport> {
  const sb = await getSupabaseServer();
  const [volumes, holdings, names, wellLease] = await Promise.all([
    listMonthlyProductionVolumes(),
    listAllInterests(sb),
    getWellNameMap(),
    wellLeaseMap(),
  ]);
  const byWell = wellInterestFromLease(interestByLease(holdings), wellLease);
  return assembleGrossVsNet(month, volumes, byWell, (wellId) => names[wellId] ?? wellId);
}
