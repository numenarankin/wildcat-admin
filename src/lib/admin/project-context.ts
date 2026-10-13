import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { snippetFromHtml } from "@/lib/notes/format";
import { ADMIN_TASK_COLUMNS } from "@/lib/tasks/tasks";
import type { AdminProjectContext } from "@/lib/ai/admin/system-prompt";

/** Caps, so a large project cannot crowd the prompt. */
const MAX_TASKS = 50;
const MAX_NOTES = 20;
const MAX_FILES = 50;

/**
 * An admin project's contents for a project-scoped Orion turn: its tasks,
 * notes and file names. Request-scoped client, so a non-admin (or an id that
 * is not an admin project) reads nothing and gets null.
 */
export async function getAdminProjectContext(projectId: string): Promise<AdminProjectContext | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const [project, tasks, notes, files] = await Promise.all([
    sb.from("admin_projects").select("name").eq("id", projectId).maybeSingle(),
    sb
      .from("admin_tasks")
      .select("title, status, priority, assignee, deadline")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(MAX_TASKS),
    sb
      .from("admin_notes")
      .select("title, content")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(MAX_NOTES),
    sb
      .from("admin_project_files")
      .select("name")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(MAX_FILES),
  ]);
  if (project.error || !project.data) return null;

  // The board's words for a status, so "Queue" in an answer matches the column.
  const label = new Map(ADMIN_TASK_COLUMNS.map((c) => [c.status as string, c.label]));
  return {
    name: project.data.name as string,
    tasks: ((tasks.data ?? []) as {
      title: string;
      status: string;
      priority: string;
      assignee: string | null;
      deadline: string | null;
    }[]).map((t) => ({
      title: t.title,
      status: label.get(t.status) ?? t.status,
      priority: t.priority,
      assignee: t.assignee ?? undefined,
      deadline: t.deadline ?? undefined,
    })),
    notes: ((notes.data ?? []) as { title: string; content: string }[]).map((n) => ({
      title: n.title,
      snippet: snippetFromHtml(n.content),
    })),
    files: ((files.data ?? []) as { name: string }[]).map((f) => ({ name: f.name })),
  };
}
