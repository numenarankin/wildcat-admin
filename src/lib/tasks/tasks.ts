import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";

/** Every status a task can hold. */
export type TaskStatus = "planned" | "priority" | "doing" | "done";

export type TaskPriority = "Low" | "Medium" | "High";

/** A single work item on the Tasks kanban board. */
export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Person responsible, free-form (e.g. "J. Hale"). */
  assignee?: string;
  /** Due date as an ISO `YYYY-MM-DD` string, if the task has a deadline. */
  deadline?: string;
  /** Optional due time as a 24-hour `HH:MM` string (only meaningful with `deadline`). */
  deadlineTime?: string;
  /** Project this task belongs to (a folder id), if tagged to one. */
  folderId?: string;
  /** Budgeted amount in USD. A task with a budget set is a project budget line. */
  budget?: number;
  /** Amount spent so far in USD. */
  spend?: number;
}

export interface TaskColumn {
  status: TaskStatus;
  label: string;
}

/**
 * Column definitions, left-to-right.
 *
 * The labels are what the board shows; the `status` values are what is stored,
 * and they keep their original spelling so no row has to be rewritten and
 * nothing that already filters on `planned` or `priority` — the AI task tools,
 * saved links — breaks. Read them as the pair they are: `planned` IS Backlog,
 * `priority` IS Queue.
 */
export const TASK_COLUMNS: TaskColumn[] = [
  { status: "planned", label: "Backlog" },
  { status: "priority", label: "Queue" },
  { status: "doing", label: "Doing" },
  { status: "done", label: "Done" },
];

/**
 * The admin team's board (`admin_tasks`): the customer columns. Its Testing
 * column was removed 2026-10-23; the enum value `testing` still exists in the
 * database but no row holds it (migration 2026102300300 moved them to Doing).
 */
export const ADMIN_TASK_COLUMNS: TaskColumn[] = TASK_COLUMNS;

/**
 * A Google Tasks list on /admin/tasks: Google stores only open or completed,
 * so the board shows two columns. `planned` IS To do, `done` IS Done.
 */
export const GOOGLE_TASK_COLUMNS: TaskColumn[] = [
  { status: "planned", label: "To do" },
  { status: "done", label: "Done" },
];

/**
 * Task fields a board can leave out because its table cannot store them
 * (Google Tasks has no assignee, priority, due time or budget).
 */
export type TaskField = "assignee" | "priority" | "deadlineTime" | "budget";

export const TASK_PRIORITIES: TaskPriority[] = ["Low", "Medium", "High"];

/** Sentinel shown in the assignee dropdown for an unassigned task. */
export const UNASSIGNED = "Unassigned";

/**
 * Flatten a rich-text (HTML) description into a single line of plain text for
 * card previews. Returns "" for empty / whitespace-only bodies (including the
 * editor's empty "<p></p>").
 */
export function descriptionPreview(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  deadline: string | null;
  deadline_time: string | null;
  folder_id: string | null;
  budget: number | null;
  spend: number | null;
}

function mapTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    status: r.status,
    priority: r.priority,
    assignee: r.assignee ?? undefined,
    deadline: r.deadline ?? undefined,
    deadlineTime: r.deadline_time ? r.deadline_time.slice(0, 5) : undefined,
    folderId: r.folder_id ?? undefined,
    budget: r.budget ?? undefined,
    spend: r.spend ?? undefined,
  };
}

const TASK_COLS =
  "id, title, description, status, priority, assignee, deadline, deadline_time, folder_id, budget, spend";

/**
 * Returns tasks newest first. Pass a `folderId` to scope to one project's tasks
 * (the project Tasks/Budget tabs); omit it for the global board (all tasks).
 */
export async function getTasks(folderId?: string): Promise<Task[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  let query = sb.from("tasks").select(TASK_COLS);
  if (folderId) query = query.eq("folder_id", folderId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`getTasks: ${error.message}`);
  return ((data ?? []) as TaskRow[]).map(mapTask);
}
