"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import type { Note, NoteTag } from "@/lib/notes/types";

/**
 * The customer note actions over `admin_notes` (migration 2026091600600), in
 * the same signatures so the shared note editor takes them as its `actions`.
 * An admin note belongs to exactly one project: the create reads it from the
 * project tag the draft carries, and there is no tag list to edit.
 * Request-scoped client; the policy is `is_platform_admin()`.
 */

function revalidateProjects(): void {
  revalidatePath("/projects", "layout");
}

export async function createAdminNote(
  initialTags: NoteTag[] = [],
  id?: string
): Promise<{ id: string }> {
  const projectId = initialTags.find((t) => t.type === "project")?.id;
  if (!projectId) throw new Error("createAdminNote: a note needs its project.");
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  const { data, error } = await sb
    .from("admin_notes")
    .insert({
      ...(id ? { id } : {}),
      project_id: projectId,
      author_name: user?.email ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createAdminNote: ${error.message}`);
  revalidateProjects();
  return { id: data.id as string };
}

export async function saveAdminNote(
  id: string,
  patch: { title?: string; content?: string }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.title !== undefined) update.title = patch.title.trim() || "Untitled";
  if (patch.content !== undefined) update.content = patch.content;
  if (Object.keys(update).length === 0) return;
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_notes").update(update).eq("id", id);
  if (error) throw new Error(`saveAdminNote: ${error.message}`);
  revalidateProjects();
}

/** Admin notes carry no tags; the project is fixed at creation. */
export async function setAdminNoteTags(_id: string, _tags: NoteTag[]): Promise<void> {
  void _id;
  void _tags;
}

/** Soft delete, like the customer notes. */
export async function deleteAdminNote(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("admin_notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`deleteAdminNote: ${error.message}`);
  revalidateProjects();
}

export async function getAdminNoteById(id: string): Promise<Note | null> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_notes")
    .select("id, title, content, author_name, author_auth_id, created_at, updated_at, admin_projects(id, name)")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`getAdminNoteById: ${error.message}`);
  if (!data) return null;
  const project = data.admin_projects as unknown as { id: string; name: string } | null;
  return {
    id: data.id as string,
    title: data.title as string,
    content: data.content as string,
    tags: project ? [{ type: "project", id: project.id, label: project.name, kind: "project" }] : [],
    updatedAt: data.updated_at as string,
    createdAt: data.created_at as string,
    author: (data.author_name as string | null) ?? null,
    authorAuthId: (data.author_auth_id as string | null) ?? null,
  };
}
