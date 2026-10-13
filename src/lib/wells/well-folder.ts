import type { SupabaseClient } from "@supabase/supabase-js";
import {
  findFacilityFolderId,
  getOrCreateFacilityFolderId,
} from "@/lib/files/facility-folder";

/**
 * Per-well file storage.
 *
 * Wells were the first facility to get a folder, and for a while the only one,
 * so this module owned the whole scheme: a subfolder under the `Wells` root
 * NAMED by the well id, since a well id is an immutable slug.
 *
 * Every facility has a folder now, and the link lives on `folders.entity_type`
 * / `entity_id` instead (see `lib/files/facility-folder.ts` for why the name
 * could not stay load-bearing once tanks and meters joined). These two
 * functions remain as the well-shaped spelling of that, so the half-dozen well
 * call sites read as they did.
 */

/** Resolve the folder that holds a well's files, or null if not created yet. */
export function findWellFolderId(
  sb: SupabaseClient,
  wellId: string
): Promise<string | null> {
  return findFacilityFolderId(sb, "well", wellId);
}

/** Resolve the well's folder, creating it under the `Wells` root on first use. */
export function getOrCreateWellFolderId(
  sb: SupabaseClient,
  wellId: string
): Promise<string> {
  return getOrCreateFacilityFolderId(sb, "well", wellId);
}
