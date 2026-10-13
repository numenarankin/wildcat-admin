import type { TaskBoardActions } from "@/components/tasks/tasks-board";
import {
  createGoogleTask,
  deleteGoogleTask,
  moveGoogleTask,
  updateGoogleTask,
} from "@/lib/admin/google/tasks-actions";

/** A Google list's board writes; each entry is the server action itself (see ADMIN_TASK_ACTIONS). */
export const GOOGLE_TASK_ACTIONS: TaskBoardActions = {
  createTask: createGoogleTask,
  updateTask: updateGoogleTask,
  deleteTask: deleteGoogleTask,
  moveTask: moveGoogleTask,
};
