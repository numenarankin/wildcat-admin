"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { TaskInput } from "@/lib/tasks/actions";
import type { TaskStatus } from "@/lib/tasks/tasks";

/**
 * Writes for the admin team's task board (`admin_tasks`). The customer
 * board's actions with the table and the revalidated path swapped; the board
 * takes them as its `actions` prop. Request-scoped client, admin-only policy.
 */

// Both boards over `admin_tasks`.
const TASK_PATHS = ["/tasks", "/sales"];
function revalidateAdminTasks(): void {
  for (const path of TASK_PATHS) revalidatePath(path);
  revalidatePath("/projects", "layout");
}

function toRow(input: TaskInput) {
  return {
    title: input.title,
    description: input.description ?? null,
    status: input.status,
    priority: input.priority,
    assignee: input.assignee ?? null,
    deadline: input.deadline ?? null,
    // A time is only meaningful alongside a date.
    deadline_time: input.deadline ? input.deadlineTime ?? null : null,
    budget: input.budget ?? null,
    spend: input.spend ?? null,
    // `folderId` is the board's project tag; on this side it names an admin project.
    project_id: input.folderId ?? null,
  };
}

export async function createAdminTask(input: TaskInput): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_tasks").insert(toRow(input));
  if (error) throw new Error(`createAdminTask: ${error.message}`);
  revalidateAdminTasks();
}

export async function updateAdminTask(id: string, input: TaskInput): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_tasks").update(toRow(input)).eq("id", id);
  if (error) throw new Error(`updateAdminTask: ${error.message}`);
  revalidateAdminTasks();
}

export async function deleteAdminTask(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_tasks").delete().eq("id", id);
  if (error) throw new Error(`deleteAdminTask: ${error.message}`);
  revalidateAdminTasks();
}

export async function moveAdminTask(id: string, status: TaskStatus): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_tasks").update({ status }).eq("id", id);
  if (error) throw new Error(`moveAdminTask: ${error.message}`);
  revalidateAdminTasks();
}
