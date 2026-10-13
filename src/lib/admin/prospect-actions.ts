"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { ProspectInput, ProspectStage } from "@/lib/admin/prospect-types";

/**
 * Writes for /admin/sales prospects. Request-scoped client: the row policy is
 * `is_platform_admin()`, so a non-admin's insert or update fails at the
 * database with no rows touched (see `prospects.ts`).
 */

const SALES_PATH = "/sales";

function toRow(input: ProspectInput) {
  return {
    company: input.company,
    contact_name: input.contactName ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    county: input.county ?? null,
    wells: input.wells ?? null,
    source: input.source ?? null,
    stage: input.stage,
    notes: input.notes ?? null,
  };
}

/** Create a prospect. Returns the new id so the optimistic card can be keyed. */
export async function createProspect(input: ProspectInput): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_prospects")
    .insert(toRow(input))
    .select("id")
    .single();
  if (error) throw new Error(`createProspect: ${error.message}`);
  revalidatePath(SALES_PATH);
  return { id: data.id as string };
}

/** Update a prospect's fields (the stage clock is the database trigger's). */
export async function updateProspect(id: string, input: ProspectInput): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_prospects").update(toRow(input)).eq("id", id);
  if (error) throw new Error(`updateProspect: ${error.message}`);
  revalidatePath(SALES_PATH);
}

export async function deleteProspect(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_prospects").delete().eq("id", id);
  if (error) throw new Error(`deleteProspect: ${error.message}`);
  revalidatePath(SALES_PATH);
}

/** Move a prospect to another column (drag-and-drop). */
export async function moveProspect(id: string, stage: ProspectStage): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_prospects").update({ stage }).eq("id", id);
  if (error) throw new Error(`moveProspect: ${error.message}`);
  revalidatePath(SALES_PATH);
}
