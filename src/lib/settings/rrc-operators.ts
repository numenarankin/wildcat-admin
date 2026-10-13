"use server";

/**
 * The RRC operator numbers this workspace claims, and the names it trades under.
 *
 * Onboarding writes the first row when the owner confirms a match; everything
 * after that happens here. Both surfaces read the same table, and RLS decides
 * who may write it (admin or owner) rather than a capability key, because
 * changing these changes WHICH COMPANY the workspace says it is.
 *
 * See docs/plans/rrc-onboarding-sync.md.
 */

import { requireAdmin } from "@/lib/auth/permissions";
import { getSupabaseServer } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { hasRrcDb } from "@/lib/scout/rrc-db";
import {
  findOperatorByNumber,
  searchOperatorsByName,
} from "@/lib/rrc/operator-candidates";
import type { OperatorSummary } from "@/lib/rrc/onboarding-types";

export interface OrgRrcOperator {
  id: string;
  operatorNo: string;
  /** Name as it was at the time it was linked; the mirror's is authoritative. */
  operatorName: string | null;
  isPrimary: boolean;
  source: "typed" | "matched" | "manual";
}

interface Row {
  id: string;
  operator_no: string;
  operator_name: string | null;
  is_primary: boolean;
  source: string;
}

function mapRow(r: Row): OrgRrcOperator {
  return {
    id: r.id,
    operatorNo: r.operator_no,
    operatorName: r.operator_name,
    isPrimary: r.is_primary,
    source:
      r.source === "typed" || r.source === "matched" ? r.source : "manual",
  };
}

/** The org's operator numbers, primary first. */
export async function listOrgRrcOperators(): Promise<OrgRrcOperator[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("org_rrc_operators")
    .select("id, operator_no, operator_name, is_primary, source")
    .order("is_primary", { ascending: false })
    .order("operator_no");
  if (error) throw new Error(`listOrgRrcOperators: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapRow);
}

/**
 * Add an operator number.
 *
 * Looked up in the mirror before it is stored, and refused if it resolves to
 * nothing: an operator number that does not exist is a typo, and storing it
 * would make every later sync silently return an empty fleet. The name is
 * denormalized from the lookup so the list renders without a cross-server query.
 */
export async function addOrgRrcOperator(
  operatorNo: string
): Promise<OrgRrcOperator> {
  await requireAdmin();
  const digits = operatorNo.replace(/\D/g, "");
  if (!digits) throw new Error("Enter an RRC operator number.");
  if (!hasRrcDb()) throw new Error("Railroad Commission records are not available right now.");

  const found = await findOperatorByNumber(digits);
  if (!found) {
    throw new Error(`No operator is registered with the Railroad Commission under number ${digits}.`);
  }

  const sb = await getSupabaseServer();
  // First one in is the primary. A partial unique index enforces at most one,
  // so this is checked rather than assumed.
  const existing = await listOrgRrcOperators();
  const { data, error } = await sb
    .from("org_rrc_operators")
    .insert({
      operator_no: found.operatorNumber,
      operator_name: found.operatorName,
      is_primary: existing.length === 0,
      source: "manual",
    })
    .select("id, operator_no, operator_name, is_primary, source")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error("That operator number is already on this workspace.");
    }
    throw new Error(`addOrgRrcOperator: ${error.message}`);
  }
  return mapRow(data as Row);
}

/**
 * Set the workspace's operator number to exactly this one, or to none.
 *
 * The field on the Company card is a text box like the name and the address
 * beside it, so its write has to be "make it say this" rather than add-plus-
 * remove: typing over a number replaces it, and clearing the box unlinks. The
 * old rows go first, so a workspace that linked several before the one-per-
 * company rule ends up with the one that is now on screen.
 *
 * Refused when the number is not in the Commission's register, for the same
 * reason `addOrgRrcOperator` refuses it: a number that resolves to nothing
 * makes every later lookup silently return an empty fleet, and the likely cause
 * is a typo in six digits.
 *
 * The wells the old number brought in are untouched either way.
 */
export async function setOrgRrcOperator(
  operatorNo: string
): Promise<OrgRrcOperator | null> {
  await requireAdmin();
  const digits = operatorNo.replace(/\D/g, "");
  const sb = await getSupabaseServer();

  if (!digits) {
    const { error } = await sb
      .from("org_rrc_operators")
      .delete()
      .not("id", "is", null);
    if (error) throw new Error(`setOrgRrcOperator: ${error.message}`);
    return null;
  }

  if (!hasRrcDb()) {
    throw new Error("Railroad Commission records are not available right now.");
  }
  const found = await findOperatorByNumber(digits);
  if (!found) {
    throw new Error(
      `No operator is registered with the Railroad Commission under number ${digits}.`
    );
  }

  // Cleared BEFORE the insert, and not just the rows that differ: both unique
  // indexes on this table (one primary per org, one row per number per org)
  // would reject the new row while the one it replaces is still there.
  const { error: clearError } = await sb
    .from("org_rrc_operators")
    .delete()
    .not("id", "is", null);
  if (clearError) throw new Error(`setOrgRrcOperator: ${clearError.message}`);

  const { data, error } = await sb
    .from("org_rrc_operators")
    .insert({
      operator_no: found.operatorNumber,
      operator_name: found.operatorName,
      is_primary: true,
      source: "manual",
    })
    .select("id, operator_no, operator_name, is_primary, source")
    .single();
  if (error) throw new Error(`setOrgRrcOperator: ${error.message}`);
  return mapRow(data as Row);
}

/** Remove an operator number. The wells it brought in are untouched. */
export async function removeOrgRrcOperator(id: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb.from("org_rrc_operators").delete().eq("id", id);
  if (error) throw new Error(`removeOrgRrcOperator: ${error.message}`);
}

/**
 * Make one operator the primary.
 *
 * Two writes, demote then promote, because the partial unique index rejects a
 * second primary. Ordered so a failure between them leaves NO primary rather
 * than two: no primary degrades to "we do not know which", while two makes every
 * reader pick arbitrarily and disagree with each other.
 */
export async function setPrimaryRrcOperator(id: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error: clearError } = await sb
    .from("org_rrc_operators")
    .update({ is_primary: false })
    .eq("is_primary", true);
  if (clearError) throw new Error(`setPrimaryRrcOperator: ${clearError.message}`);
  const { error } = await sb
    .from("org_rrc_operators")
    .update({ is_primary: true })
    .eq("id", id);
  if (error) throw new Error(`setPrimaryRrcOperator: ${error.message}`);
}

/** The trading names used for matching, beyond the org's own name. */
export async function getCompanyAliases(): Promise<string[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("organizations")
    .select("company_aliases")
    .maybeSingle<{ company_aliases: string[] | null }>();
  if (error) throw new Error(`getCompanyAliases: ${error.message}`);
  return data?.company_aliases ?? [];
}

/** Replace the alias list. Empty strings and duplicates are dropped. */
export async function setCompanyAliases(aliases: string[]): Promise<string[]> {
  await requireAdmin();
  const clean = [
    ...new Set(aliases.map((a) => a.trim()).filter(Boolean)),
  ].slice(0, 20);
  const sb = await getSupabaseServer();
  const { data: org } = await sb
    .from("organizations")
    .select("id")
    .maybeSingle<{ id: string }>();
  if (!org) throw new Error("No organization to update.");
  const { error } = await sb
    .from("organizations")
    .update({ company_aliases: clean })
    .eq("id", org.id);
  if (error) throw new Error(`setCompanyAliases: ${error.message}`);
  return clean;
}

/** Operator search for the Settings picker. Admin-only, like the writes. */
export async function searchRrcOperatorsForSettings(
  query: string
): Promise<OperatorSummary[]> {
  await requireAdmin();
  if (!hasRrcDb()) return [];
  const hits = await searchOperatorsByName(query);
  return hits.map((c) => ({
    operatorNumber: c.operatorNumber,
    name: c.operatorName,
    city: c.city,
    state: c.state,
    wellCount: c.wellCount ?? 0,
    p5Status: null,
    officers: c.officerNames ?? [],
  }));
}
