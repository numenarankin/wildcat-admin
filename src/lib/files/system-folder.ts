import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Get-or-create for a TOP-LEVEL system folder, by name.
 *
 * The `SYSTEM_FOLDERS` list (`lib/files/system-folders-seed.ts`) is seeded lazily at
 * sign-in, but no write may depend on that heal having run for the session in
 * front of it — an invited member uploading on their first minute in the org
 * would otherwise fail on a folder nobody had created yet. So every writer that
 * targets one of those folders resolves it through here instead.
 *
 * Uses the CALLER's RLS-scoped client, not the admin one: the folder it creates
 * then gets its `org_id` from the same write policy as a folder the user makes
 * by hand, so a system folder can never be minted into the wrong org.
 *
 * The names are load-bearing — they are matched here and in the seed list.
 */
export async function getOrCreateRootSystemFolderId(
  sb: SupabaseClient,
  name: string
): Promise<string> {
  const { data, error } = await sb
    .from("folders")
    .select("id")
    .eq("name", name)
    .is("parent_folder_id", null)
    .maybeSingle();
  if (error) throw new Error(`getOrCreateRootSystemFolderId(${name}): ${error.message}`);
  if (data?.id) return data.id as string;

  const { data: created, error: insErr } = await sb
    .from("folders")
    .insert({ name, parent_folder_id: null, is_system: true })
    .select("id")
    .single();
  if (insErr) {
    throw new Error(`getOrCreateRootSystemFolderId(${name}): ${insErr.message}`);
  }
  return created.id as string;
}

/**
 * Where a scan taken on the phone lands.
 *
 * The phone is a camera, not a filing cabinet: a pumper photographs a ticket at
 * the wellhead, and which well or invoice it belongs against is decided later,
 * at a desk, on this app. So every mobile scan goes to one folder, newest
 * first, and is attached from there — see `docs/plans/scan-to-files.md` in the
 * phone repo.
 */
export const SCANS_FOLDER_NAME = "Scans";

/** Resolve the `Scans` root folder id, creating it if missing. */
export async function getOrCreateScansFolderId(sb: SupabaseClient): Promise<string> {
  return getOrCreateRootSystemFolderId(sb, SCANS_FOLDER_NAME);
}
