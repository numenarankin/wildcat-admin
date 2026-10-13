import type { SupabaseClient } from "@supabase/supabase-js";

import { getOrCreateRootSystemFolderId } from "@/lib/files/system-folder";

/**
 * Files ingested through the Data Entry page land in a dedicated top-level
 * "Data Entry" system folder instead of the Files root, so parsed source
 * documents stay grouped and out of the way. The folder is one of the
 * `SYSTEM_FOLDERS` seeded lazily at sign-in (see `lib/files/system-folders-seed.ts`),
 * but we get-or-create it here too so an upload never depends on that heal
 * having run for the current session.
 *
 * The name is load-bearing: it's resolved by name below and by the seed list.
 */
export const DATA_ENTRY_FOLDER_NAME = "Data Entry";

/**
 * Resolve the "Data Entry" root folder id, creating it if missing. Uses the
 * caller's RLS-scoped client so the new folder's `org_id` is assigned by the
 * usual write policy, exactly like a folder the user creates in the UI.
 */
export async function getOrCreateDataEntryFolderId(
  sb: SupabaseClient
): Promise<string> {
  return getOrCreateRootSystemFolderId(sb, DATA_ENTRY_FOLDER_NAME);
}
