import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";
import { snippetFromHtml } from "@/lib/notes/format";
import type { ProjectFolder } from "@/lib/projects/folders";
import type { NoteSummary, NoteTag } from "@/lib/notes/types";
import type { AdminProjectFile } from "@/lib/admin/project-types";

/**
 * Admin projects (`admin_projects`, migration 2026091600600), for
 * /admin/projects. The commercial Projects page's reads over the admin
 * tables. Request-scoped client: every table's policy is
 * `is_platform_admin()`, so an outsider reads no rows whatever the route did.
 */

/** "Sep 16, 2026", the commercial folder list's Modified format. */
function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

/**
 * Every admin project in the commercial list's shape. The item count is the
 * project's files, as a customer project counts the files placed in it.
 */
export async function getAdminProjects(): Promise<ProjectFolder[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const [{ data: projects, error }, { data: files, error: filesErr }] = await Promise.all([
    sb.from("admin_projects").select("id, name, created_at").order("name"),
    sb.from("admin_project_files").select("project_id"),
  ]);
  if (error) throw new Error(`getAdminProjects: ${error.message}`);
  if (filesErr) throw new Error(`getAdminProjects: ${filesErr.message}`);

  const counts = new Map<string, number>();
  for (const f of (files ?? []) as { project_id: string }[]) {
    counts.set(f.project_id, (counts.get(f.project_id) ?? 0) + 1);
  }
  return ((projects ?? []) as { id: string; name: string; created_at: string }[]).map((p) => ({
    id: p.id,
    name: p.name,
    itemCount: counts.get(p.id) ?? 0,
    modified: formatDate(p.created_at),
  }));
}

/** Resolve a project by the slug of its name, as `/projects/[folder]` does. */
export async function getAdminProjectBySlug(
  slug: string
): Promise<{ id: string; name: string } | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data, error } = await sb.from("admin_projects").select("id, name").order("created_at");
  if (error) throw new Error(`getAdminProjectBySlug: ${error.message}`);
  const match = ((data ?? []) as { id: string; name: string }[]).find(
    (p) => slugify(p.name) === slug
  );
  return match ?? null;
}

/** The project's files, newest first. */
export async function getAdminProjectFiles(projectId: string): Promise<AdminProjectFile[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_project_files")
    .select("id, name, mime_type, size_bytes, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`getAdminProjectFiles: ${error.message}`);
  return ((data ?? []) as {
    id: string;
    name: string;
    mime_type: string | null;
    size_bytes: number | string;
    created_at: string;
  }[]).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mime_type,
    sizeBytes: Number(f.size_bytes),
    createdAt: f.created_at,
  }));
}

/**
 * The tag a note in this project carries. Admin notes have no tag table; the
 * project IS the note's column, and this tag is only how the shared note
 * editor and draft hook name the project (and how a new note says which
 * project to file itself in).
 */
export function adminProjectTag(project: { id: string; name: string }): NoteTag {
  return { type: "project", id: project.id, label: project.name, kind: "project" };
}

/** The project's live notes, most recently edited first, as note cards. */
export async function getAdminProjectNotes(project: {
  id: string;
  name: string;
}): Promise<NoteSummary[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_notes")
    .select("id, title, content, author_name, updated_at")
    .eq("project_id", project.id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`getAdminProjectNotes: ${error.message}`);
  const tag = adminProjectTag(project);
  return ((data ?? []) as {
    id: string;
    title: string;
    content: string;
    author_name: string | null;
    updated_at: string;
  }[]).map((n) => ({
    id: n.id,
    title: n.title,
    snippet: snippetFromHtml(n.content),
    tags: [tag],
    updatedAt: n.updated_at,
    author: n.author_name,
  }));
}
