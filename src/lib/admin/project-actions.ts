"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/files/limits";

/**
 * Writes for /admin/projects. Rows go through the request-scoped client, so
 * the `is_platform_admin()` policy is the boundary. File BYTES go through the
 * service role (the customer `files` bucket works the same way), so those
 * paths check `isPlatformAdmin()` themselves and only touch storage for a row
 * the request client could read or write.
 */

const BUCKET = "admin-files";

function revalidateProjects(): void {
  revalidatePath("/projects", "layout");
}

async function requireAdmin(): Promise<void> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
}

export async function createAdminProject(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_projects").insert({ name: trimmed });
  if (error) throw new Error(`createAdminProject: ${error.message}`);
  revalidateProjects();
}

export async function renameAdminProject(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_projects")
    .update({ name: trimmed })
    .eq("id", id)
    .select("id");
  if (error) throw new Error(`renameAdminProject: ${error.message}`);
  if (!data?.length) throw new Error("renameAdminProject: project not found.");
  revalidateProjects();
}

/**
 * Upload files into a project. The metadata row is inserted FIRST through the
 * request client, so a caller who cannot write to this project never gets as
 * far as storage; a failed upload removes its row again.
 */
export async function uploadAdminProjectFiles(
  projectId: string,
  formData: FormData
): Promise<void> {
  await requireAdmin();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_UPLOAD_BYTES) {
    throw new Error(`Uploads are limited to ${MAX_UPLOAD_LABEL} at a time.`);
  }

  const sb = await getSupabaseServer();
  const storage = getSupabaseAdmin().storage.from(BUCKET);
  for (const file of files) {
    const storagePath = `${projectId}/${crypto.randomUUID()}`;
    const { data: row, error: rowErr } = await sb
      .from("admin_project_files")
      .insert({
        project_id: projectId,
        name: file.name,
        storage_path: storagePath,
        mime_type: file.type || null,
        size_bytes: file.size,
      })
      .select("id")
      .single();
    if (rowErr) throw new Error(`uploadAdminProjectFiles: ${rowErr.message}`);

    const { error: upErr } = await storage.upload(storagePath, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (upErr) {
      await sb.from("admin_project_files").delete().eq("id", row.id);
      throw new Error(`uploadAdminProjectFiles: ${upErr.message}`);
    }
  }
  revalidateProjects();
}

/** A signed link to a project file, readable for an hour. */
export async function getAdminProjectFileUrl(
  id: string,
  opts: { download?: boolean } = {}
): Promise<string | null> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { data: file } = await sb
    .from("admin_project_files")
    .select("storage_path, name")
    .eq("id", id)
    .maybeSingle();
  if (!file) return null;
  const { data, error } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .createSignedUrl(
      file.storage_path as string,
      60 * 60,
      opts.download ? { download: (file.name as string) || true } : undefined
    );
  if (error) throw new Error(`getAdminProjectFileUrl: ${error.message}`);
  return data?.signedUrl ?? null;
}

export async function deleteAdminProjectFile(id: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_project_files")
    .delete()
    .eq("id", id)
    .select("storage_path");
  if (error) throw new Error(`deleteAdminProjectFile: ${error.message}`);
  const path = data?.[0]?.storage_path as string | undefined;
  if (path) {
    const { error: rmErr } = await getSupabaseAdmin().storage.from(BUCKET).remove([path]);
    // The row is gone, so the file no longer lists; an orphaned object is
    // logged rather than resurrecting a row the admin just deleted.
    if (rmErr) console.error("deleteAdminProjectFile: storage remove failed", rmErr);
  }
  revalidateProjects();
}
