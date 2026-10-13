import type { TaskBoardActions } from "@/components/tasks/tasks-board";
import {
  createAdminTask,
  deleteAdminTask,
  moveAdminTask,
  updateAdminTask,
} from "@/lib/admin/task-actions";

/**
 * The writes behind every admin task board (/admin/tasks and the Tasks tab of
 * /admin/sales show the SAME `admin_tasks` rows). Client-importable: the
 * actions are server actions. The columns are `ADMIN_TASK_COLUMNS` in
 * `@/lib/tasks/tasks`, beside the customer list they extend.
 */
// Every entry is the server action itself, never a wrapper: a server
// component hands this object to the client board, and only functions marked
// "use server" survive that crossing.
export const ADMIN_TASK_ACTIONS: TaskBoardActions = {
  createTask: createAdminTask,
  updateTask: updateAdminTask,
  deleteTask: deleteAdminTask,
  moveTask: moveAdminTask,
};
