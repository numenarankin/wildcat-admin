"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { TargetInput } from "@/lib/admin/target-types";

/**
 * Writes for /prospecting targets. Request-scoped client: the row policy is
 * `is_platform_admin()`, so a non-admin's write fails at the database.
 */

const PROSPECTING_PATH = "/prospecting";

/**
 * Add operators checked on the map. An operator already on the list is left
 * as it was (its original date added stands), so re-adding is harmless.
 */
export async function addTargets(inputs: TargetInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_targets").upsert(
    inputs.map((t) => ({
      operator_no: t.operatorNo,
      name: t.name,
      city: t.city,
      state: t.state,
    })),
    { onConflict: "operator_no", ignoreDuplicates: true }
  );
  if (error) throw new Error(`addTargets: ${error.message}`);
  revalidatePath(PROSPECTING_PATH);
}

export async function removeTarget(operatorNo: number): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_targets").delete().eq("operator_no", operatorNo);
  if (error) throw new Error(`removeTarget: ${error.message}`);
  revalidatePath(PROSPECTING_PATH);
}
