import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Task, TaskPriority, TaskStatus } from "@/lib/tasks/tasks";

/**
 * The admin team's tasks (`admin_tasks`), for the Tasks tab of /admin/sales.
 *
 * Same `Task` shape as the customer board so `TasksBoard` renders both; the
 * rows live in their own table because they are Wildcat's, not any org's
 * (migration 2026091600500). Request-scoped client, `is_platform_admin()`
 * policy: an outsider gets no rows.
 */

interface AdminTaskRow {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  deadline: string | null;
  deadline_time: string | null;
  budget: number | null;
  spend: number | null;
  project_id: string | null;
}

const TASK_COLS =
  "id, title, description, status, priority, assignee, deadline, deadline_time, budget, spend, project_id";

function mapTask(r: AdminTaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    status: r.status,
    priority: r.priority,
    assignee: r.assignee ?? undefined,
    deadline: r.deadline ?? undefined,
    deadlineTime: r.deadline_time ? r.deadline_time.slice(0, 5) : undefined,
    budget: r.budget ?? undefined,
    spend: r.spend ?? undefined,
    // The admin project, in the customer field the board already carries.
    folderId: r.project_id ?? undefined,
  };
}

/**
 * Admin tasks, newest first. Pass a project id for that project's Tasks tab;
 * omit it for the team board, which shows every task (as the customer /tasks
 * board shows project tasks too).
 */
export async function getAdminTasks(projectId?: string): Promise<Task[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  let query = sb.from("admin_tasks").select(TASK_COLS);
  if (projectId) query = query.eq("project_id", projectId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`getAdminTasks: ${error.message}`);
  return ((data ?? []) as AdminTaskRow[]).map(mapTask);
}
