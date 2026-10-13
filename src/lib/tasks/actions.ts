"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Task, TaskStatus } from "@/lib/tasks/tasks";

export type TaskInput = Omit<Task, "id">;

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
    folder_id: input.folderId ?? null,
    budget: input.budget ?? null,
    spend: input.spend ?? null,
  };
}

/**
 * Revalidate the global board plus, when tagged, the owning project page.
 * `/agenda` is included because the same board (and the task deadlines drawn on
 * the month and week views) is rendered there.
 */
function revalidateTask(folderId?: string): void {
  revalidatePath("/tasks");
  revalidatePath("/agenda");
  if (folderId) revalidatePath("/projects", "layout");
}

/** Create a task. */
export async function createTask(input: TaskInput): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("tasks").insert(toRow(input));
  if (error) throw new Error(`createTask: ${error.message}`);
  revalidateTask(input.folderId);
}

/** Update a task's fields. */
export async function updateTask(id: string, input: TaskInput): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("tasks").update(toRow(input)).eq("id", id);
  if (error) throw new Error(`updateTask: ${error.message}`);
  revalidateTask(input.folderId);
}

/**
 * Delete a task. `folderId` is only used to pick the pages to revalidate, so a
 * caller that doesn't know the tag can omit it.
 */
export async function deleteTask(id: string, folderId?: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("tasks").delete().eq("id", id);
  if (error) throw new Error(`deleteTask: ${error.message}`);
  revalidateTask(folderId);
}

/** Move a task to a different column (drag-and-drop). */
export async function moveTask(id: string, status: TaskStatus): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("tasks").update({ status }).eq("id", id);
  if (error) throw new Error(`moveTask: ${error.message}`);
  revalidatePath("/tasks");
  revalidatePath("/projects", "layout");
}
