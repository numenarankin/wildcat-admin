"use server";

/**
 * The org's OTHER companies: the working-interest-owning entities an operator
 * splits its assets into.
 *
 * An operating company holds the P-5 and carries the liability; one or more
 * sister companies hold the interest. The division is legal, not functional, so
 * a fraction held by any of them is a fraction the user keeps. Naming them here
 * is what lets the lease page record interest under one and what makes the
 * interest count toward NRI instead of being distributed to a stranger.
 *
 * NOT the People directory. `royalty_owners` is third parties with a mailing
 * address that the monthly distribution pays; these are the company.
 *
 * Reads are org-wide (the lease page's picker needs them); writes are admin,
 * enforced twice: `requireAdmin()` here and the RLS policy on the table, which
 * is the actual boundary. See docs/plans/working-interest-owner-companies.md.
 */

import { requireAdmin } from "@/lib/auth/permissions";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { hasSupabase } from "@/lib/env";

export interface OrgWiOwner {
  id: string;
  name: string;
}

interface Row {
  id: string;
  name: string;
}

/** The org's companies, by name. */
export async function listOrgWiOwners(): Promise<OrgWiOwner[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  const { data, error } = await sb
    .from("org_wi_owners")
    .select("id, name")
    .order("name");
  if (error) throw new Error(`listOrgWiOwners: ${error.message}`);
  return ((data ?? []) as Row[]).map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Add a company.
 *
 * No Railroad Commission lookup, unlike `addOrgRrcOperator`: these entities are
 * not operators, hold no P-5, and need not appear in the register at all. The
 * name is the whole record, so the only checks are that it is not blank and not
 * already there.
 */
export async function addOrgWiOwner(name: string): Promise<OrgWiOwner> {
  await requireAdmin();
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Enter a company name.");

  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("org_wi_owners")
    .insert({ name: clean })
    .select("id, name")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error(`${clean} is already on this workspace.`);
    }
    throw new Error(`addOrgWiOwner: ${error.message}`);
  }
  return { id: (data as Row).id, name: (data as Row).name };
}

/**
 * Rename a company.
 *
 * The name is the whole record, so this is the only edit there is. Refused when
 * it collides with another of the org's, for the reason the unique index
 * exists: two rows for one entity split its interest into halves that no total
 * adds up.
 */
export async function renameOrgWiOwner(
  id: string,
  name: string
): Promise<OrgWiOwner> {
  await requireAdmin();
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Enter a company name.");

  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("org_wi_owners")
    .update({ name: clean })
    .eq("id", id)
    .select("id, name")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error(`${clean} is already on this workspace.`);
    }
    throw new Error(`renameOrgWiOwner: ${error.message}`);
  }
  return { id: (data as Row).id, name: (data as Row).name };
}

/**
 * Remove a company.
 *
 * Refused while it holds interest. The foreign key is `on delete restrict`
 * precisely so this cannot go through: removing the company is a tidy-up
 * gesture, and silently deleting its holdings would change what every one of
 * those leases is worth. The count comes back in the message so the user knows
 * what they would have to unwind first.
 */
export async function removeOrgWiOwner(id: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb.from("org_wi_owners").delete().eq("id", id);
  if (!error) return;
  if (error.code !== "23503") {
    throw new Error(`removeOrgWiOwner: ${error.message}`);
  }
  const leases = await countLeasesHeld(sb, id);
  throw new Error(
    leases === 1
      ? "That company holds interest on 1 lease. Remove the holding first."
      : `That company holds interest on ${leases} leases. Remove the holdings first.`
  );
}

/** How many distinct leases this company holds interest in. */
async function countLeasesHeld(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  id: string
): Promise<number> {
  const { data, error } = await sb
    .from("royalty_owner_wells")
    .select("lease_id")
    .eq("wi_owner_id", id);
  if (error) return 0;
  const rows = (data ?? []) as { lease_id: string | null }[];
  return new Set(rows.map((r) => r.lease_id)).size;
}
