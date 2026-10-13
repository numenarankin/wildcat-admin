import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { slugify } from "@/lib/slug";

export interface ProjectFolder {
  /** Stable identifier / URL slug for the folder. */
  id: string;
  /** Display name shown beneath the folder icon. */
  name: string;
  /** Number of items inside the folder, when known. */
  itemCount?: number;
  /** Created date, formatted for the list's Modified column ("" if unknown). */
  modified?: string;
}

/** Format an ISO timestamp for the folder list, matching the Files browser. */
function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

/**
 * Returns the project folders to display in the grid.
 *
 * Each project is a folder under the `Projects` system root.
 * Item counts are derived from `file_placements`.
 */
export async function getProjectFolders(): Promise<ProjectFolder[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();

  const { data: root, error: rootErr } = await sb
    .from("folders")
    .select("id")
    .eq("is_system", true)
    .eq("name", "Projects")
    .maybeSingle();
  if (rootErr) throw new Error(`getProjectFolders: ${rootErr.message}`);
  if (!root) return [];

  // The children and their item counts in ONE wave: the placements are
  // reached through their folder's parent rather than each folder's id, so
  // they need not wait for the list (one count per folder, serially, made a
  // ten-project page twelve round trips).
  const [{ data: children, error }, { data: placements, error: placementsErr }] =
    await Promise.all([
      sb
        .from("folders")
        .select("id, name, created_at")
        .eq("parent_folder_id", root.id)
        .order("name"),
      sb
        .from("file_placements")
        .select("folder_id, folders!inner(parent_folder_id)")
        .eq("folders.parent_folder_id", root.id),
    ]);
  if (error) throw new Error(`getProjectFolders: ${error.message}`);
  if (placementsErr) throw new Error(`getProjectFolders: ${placementsErr.message}`);

  const counts = new Map<string, number>();
  for (const p of (placements ?? []) as { folder_id: string | null }[]) {
    if (p.folder_id) counts.set(p.folder_id, (counts.get(p.folder_id) ?? 0) + 1);
  }
  return ((children ?? []) as { id: string; name: string; created_at: string }[]).map((f) => ({
    id: f.id,
    name: f.name,
    itemCount: counts.get(f.id) ?? 0,
    modified: formatDate(f.created_at),
  }));
}

/**
 * Resolve a project by the slug of its name (the pretty URL).
 * Returns the folder id + name, or null if no project matches.
 */
export async function getProjectBySlug(
  slug: string
): Promise<{ id: string; name: string } | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();

  const { data: root } = await sb
    .from("folders")
    .select("id")
    .eq("is_system", true)
    .eq("name", "Projects")
    .maybeSingle();
  if (!root) return null;

  const { data: children } = await sb
    .from("folders")
    .select("id, name")
    .eq("parent_folder_id", root.id);

  const match = (children ?? []).find((f) => slugify(f.name) === slug);
  return match ? { id: match.id, name: match.name } : null;
}
