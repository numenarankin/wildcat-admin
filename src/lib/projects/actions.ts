"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { getSupabaseServer } from "@/lib/supabase/server";

/**
 * Create a new project as a folder under the Projects root.
 *
 * `owner_uid` is what makes it private: a folder carrying one is visible only
 * to its owner, the people it is shared with, and the org owner (see the
 * project_privacy migration). Every other folder in the tree leaves it null and
 * stays org-wide.
 */
export async function createProject(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const user = await requireUser();
  const sb = await getSupabaseServer();

  const { data: root, error: rootErr } = await sb
    .from("folders")
    .select("id")
    .eq("is_system", true)
    .eq("name", "Projects")
    .maybeSingle();
  if (rootErr) throw new Error(`createProject: ${rootErr.message}`);
  if (!root)
    throw new Error(
      "createProject: Projects root folder not found. Run the default-folders migration"
    );

  const { error } = await sb.from("folders").insert({
    name: trimmed,
    parent_folder_id: root.id,
    is_system: false,
    owner_uid: user.id,
  });
  if (error) throw new Error(`createProject: ${error.message}`);

  revalidatePath("/projects");
}

/**
 * Share a project with another member of the org, or stop sharing it.
 *
 * Both are single-row writes against `project_shares`; the guard that only the
 * project's owner (or the org owner) may change the list lives in RLS
 * (`is_project_owner`), so a non-owner's call fails at the database rather than
 * on a check the client could skip.
 */
export async function shareProject(
  folderId: string,
  authUserId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("project_shares")
    .upsert(
      { folder_id: folderId, auth_user_id: authUserId },
      { onConflict: "folder_id,auth_user_id", ignoreDuplicates: true }
    );
  if (error) throw new Error(`shareProject: ${error.message}`);
  revalidatePath("/projects");
}

export async function unshareProject(
  folderId: string,
  authUserId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("project_shares")
    .delete()
    .eq("folder_id", folderId)
    .eq("auth_user_id", authUserId);
  if (error) throw new Error(`unshareProject: ${error.message}`);
  revalidatePath("/projects");
}
