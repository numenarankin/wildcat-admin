"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { isAccountType, type AccountType } from "@/lib/admin/accounts";

/**
 * Label an org customer / demo / test. Any platform admin; the service key
 * is what gets past the column's trigger (see migration 2026091600200), so the
 * gate here is the whole boundary.
 */
export async function setAccountType(orgId: string, type: AccountType): Promise<void> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  if (!isAccountType(type)) throw new Error("Unknown account type.");
  const { data, error } = await getSupabaseAdmin()
    .from("organizations")
    .update({ account_type: type })
    .eq("id", orgId)
    .select("id");
  if (error) throw new Error(`organizations: ${error.message}`);
  if (!data?.length) throw new Error("No such organization.");
  revalidatePath("/settings");
  revalidatePath("/dashboard");
}
