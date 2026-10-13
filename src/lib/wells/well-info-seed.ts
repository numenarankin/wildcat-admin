/**
 * Seeding a new org's well info sheets from the hardcoded defaults.
 *
 * Kept out of `./well-info-fields` because sign-up has no session: it runs as
 * the service role and passes the org id it has just created, and a `"use
 * server"` module may only export actions taking serializable arguments.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultInfoFields } from "@/lib/wells/well-info-template";
import type { WellType } from "@/lib/wells/wells";

/** The default rows for one sheet, shaped for insert. */
export function defaultFieldRows(type: WellType) {
  return defaultInfoFields(type).map((field) => ({
    well_type: type,
    label: field.label,
    aliases: field.aliases,
    sort_order: field.sortOrder,
    kind: field.kind,
  }));
}

/** Both sheets' default rows, for the org being created. */
export function defaultFieldRowsForOrg(orgId: string) {
  return (["producer", "injection"] as const).flatMap((type) =>
    defaultFieldRows(type).map((row) => ({ ...row, org_id: orgId }))
  );
}

/**
 * Seed a brand-new org's sheets. Called from `/api/auth/signup` with the
 * service-role client that just inserted the org — never with a client-supplied
 * org id.
 *
 * A duplicate-key error means something already seeded this org, which is the
 * outcome we wanted; anything else is a real failure and is thrown.
 */
export async function seedWellInfoFieldsForOrg(
  admin: SupabaseClient,
  orgId: string
): Promise<void> {
  const { error } = await admin
    .from("well_info_fields")
    .insert(defaultFieldRowsForOrg(orgId));
  if (error && error.code !== "23505") {
    throw new Error(`seedWellInfoFieldsForOrg: ${error.message}`);
  }
}
