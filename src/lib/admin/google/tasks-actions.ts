"use server";

import { revalidatePath } from "next/cache";
import { requireGoogleAdminId } from "@/lib/admin/google/guard";
import { googleErrorMessage } from "@/lib/admin/google/fetch";
import { importGoogleTasks } from "@/lib/admin/google/tasks/import";
import { deleteTask, insertTask, patchTask } from "@/lib/admin/google/tasks/client";
import {
  isGoogleListId,
  parseBoardTaskId,
  statusToGoogle,
  toGoogleWrite,
} from "@/lib/admin/google/tasks/map";
import type { TaskInput } from "@/lib/tasks/actions";
import type { TaskStatus } from "@/lib/tasks/tasks";

/**
 * The `TaskBoardActions` behind a Google list on /admin/tasks. Each acts with
 * the session's own Google token, so an id from the client can only ever name
 * the caller's own lists and tasks; it is still shape-checked before use.
 */

const TASKS_PATH = "/tasks";

function ids(id: string): { listId: string; taskId: string } {
  const parsed = parseBoardTaskId(id);
  if (!parsed) throw new Error("Not a Google task.");
  return parsed;
}

export async function createGoogleTask(input: TaskInput): Promise<void> {
  const userId = await requireGoogleAdminId();
  const listId = input.folderId;
  if (!listId || !isGoogleListId(listId)) throw new Error("No Google list picked.");
  await insertTask(userId, listId, toGoogleWrite(input));
  revalidatePath(TASKS_PATH);
}

export async function updateGoogleTask(id: string, input: TaskInput): Promise<void> {
  const userId = await requireGoogleAdminId();
  const { listId, taskId } = ids(id);
  await patchTask(userId, listId, taskId, toGoogleWrite(input));
  revalidatePath(TASKS_PATH);
}

export async function deleteGoogleTask(id: string): Promise<void> {
  const userId = await requireGoogleAdminId();
  const { listId, taskId } = ids(id);
  await deleteTask(userId, listId, taskId);
  revalidatePath(TASKS_PATH);
}

export async function moveGoogleTask(id: string, status: TaskStatus): Promise<void> {
  const userId = await requireGoogleAdminId();
  const { listId, taskId } = ids(id);
  const google = statusToGoogle(status);
  await patchTask(userId, listId, taskId, google === "needsAction" ? { status: google, completed: null } : { status: google });
  revalidatePath(TASKS_PATH);
}

/**
 * Pull the caller's new open Google tasks onto the team board (Queue). Called
 * by the board on load (`GoogleTasksImport`); see `tasks/import.ts`. A result,
 * not a throw, so the board can say why it failed.
 */
export async function syncGoogleTasksToBoard(): Promise<{ added: number } | { error: string }> {
  try {
    const r = await importGoogleTasks();
    const added = "added" in r ? r.added : 0;
    if (added > 0) {
      revalidatePath(TASKS_PATH);
      revalidatePath("/projects", "layout");
    }
    return { added };
  } catch (error) {
    console.error("syncGoogleTasksToBoard failed", error);
    return { error: googleErrorMessage(error, "Tasks") };
  }
}
