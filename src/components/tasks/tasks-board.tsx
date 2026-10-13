"use client";

import { useCallback, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PlusIcon } from "lucide-react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TaskColumn } from "@/components/tasks/task-column";
import { TaskModal, type NewTask } from "@/components/tasks/task-modal";
import { useServerState } from "@/hooks/use-server-state";
import {
  createTask,
  deleteTask,
  moveTask,
  updateTask,
  type TaskInput,
} from "@/lib/tasks/actions";
import {
  TASK_COLUMNS,
  type Task,
  type TaskColumn as TaskColumnDef,
  type TaskField,
  type TaskStatus,
} from "@/lib/tasks/tasks";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { openTaskSlice, tasksBoardSlice } from "@/lib/ai/admin/page-slices";

/**
 * The writes behind the board. The customer board's server actions by
 * default; a host over another table (the admin team's `admin_tasks`) passes
 * its own, and the board itself never knows which table it is on.
 */
export interface TaskBoardActions {
  createTask: (input: TaskInput) => Promise<void>;
  updateTask: (id: string, input: TaskInput) => Promise<void>;
  deleteTask: (id: string, folderId?: string) => Promise<void>;
  moveTask: (id: string, status: TaskStatus) => Promise<void>;
}

const DEFAULT_ACTIONS: TaskBoardActions = { createTask, updateTask, deleteTask, moveTask };

export function TasksBoard({
  tasks: initial,
  assignees,
  folderId,
  embedded = false,
  hideHeader = false,
  addOpen: addOpenProp,
  onAddOpenChange,
  actions = DEFAULT_ACTIONS,
  columns = TASK_COLUMNS,
  hiddenFields,
  headerAction,
  contextLabel = "Task board",
}: {
  tasks: Task[];
  assignees: string[];
  /** When set, new tasks are tagged to this project (folder). */
  folderId?: string;
  /** Embedded in the project page: drop the page title (the tab menu owns it). */
  embedded?: boolean;
  /** Drop the header row entirely (title + add button) — the host provides its
   * own add control, e.g. the calendar toolbar's "New Task". */
  hideHeader?: boolean;
  /** Controlled add-task modal, for a host with its own add button (the project
   * toolbar's "New Task"). Left uncontrolled, the board owns the state. */
  addOpen?: boolean;
  onAddOpenChange?: (open: boolean) => void;
  /** Server actions for the table this board is over (see `TaskBoardActions`). */
  actions?: TaskBoardActions;
  /** The board's columns, in order (the customer four by default). */
  columns?: TaskColumnDef[];
  /** Fields this board's table cannot store: hidden on cards and in the modal. */
  hiddenFields?: readonly TaskField[];
  /** A control beside the add button, e.g. /admin/tasks' source picker. */
  headerAction?: ReactNode;
  /** What the Orion drawer calls this board. */
  contextLabel?: string;
}) {
  const router = useRouter();
  // Cards move the moment they're dragged or typed; the refresh that follows
  // each write hands the list back to the server.
  const [tasks, setTasks] = useServerState<Task[]>(initial);
  const [addOpenState, setAddOpenState] = useState(false);
  const addOpen = addOpenProp ?? addOpenState;
  const setAddOpen = onAddOpenChange ?? setAddOpenState;
  const [editing, setEditing] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [, startTransition] = useTransition();

  // The Orion drawer's view of the board, and of the task open in its modal.
  usePageContextSlice("tasks-board", tasksBoardSlice(contextLabel, tasks, columns));
  usePageContextSlice("tasks-board-open", editing ? openTaskSlice(editing, columns) : null);

  const handleDropTask = useCallback(
    (taskId: string, status: TaskStatus) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status } : t))
      );
      startTransition(async () => {
        try {
          await actions.moveTask(taskId, status);
        } catch (error) {
          console.error("Failed to move task", error);
          toast.error("Couldn't move the task.");
        }
        // On failure too: the refresh puts the card back where the server has it.
        router.refresh();
      });
    },
    // `setTasks` is a `useState` setter passed through `useServerState`, so it is
    // stable; it is listed because the lint can't see that through a custom hook.
    [router, setTasks, actions]
  );

  const handleOpenTask = useCallback((task: Task) => setEditing(task), []);
  const handleDeleteTask = useCallback((task: Task) => setDeleting(task), []);

  function handleConfirmDelete() {
    const task = deleting;
    if (!task) return;
    // Drop the card immediately, then persist. On failure the refresh re-fetches
    // the true list, so a task that survived on the server comes back.
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    startTransition(async () => {
      try {
        await actions.deleteTask(task.id, task.folderId);
      } catch (error) {
        console.error("Failed to delete task", error);
        toast.error("Couldn't delete the task.");
      }
      router.refresh();
    });
  }

  function handleAddTask(task: NewTask) {
    // Tag new tasks to the current project (no-op on the global board).
    const full: NewTask = { ...task, folderId };
    setTasks((prev) => [{ id: `task-local-${Date.now()}`, ...full }, ...prev]);
    startTransition(async () => {
      try {
        await actions.createTask(full);
      } catch (error) {
        console.error("Failed to create task", error);
        toast.error("Couldn't add the task.");
      }
      router.refresh();
    });
  }

  function handleSaveTask(task: NewTask) {
    if (!editing) return;
    const id = editing.id;
    // The modal doesn't edit the project tag — preserve the task's existing one.
    const full: NewTask = { ...task, folderId: editing.folderId };
    setTasks((prev) => prev.map((t) => (t.id === id ? { id, ...full } : t)));
    startTransition(async () => {
      try {
        await actions.updateTask(id, full);
      } catch (error) {
        console.error("Failed to update task", error);
        toast.error("Couldn't save the task.");
      }
      router.refresh();
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {!hideHeader && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-4",
            embedded ? "justify-end" : "justify-between"
          )}
        >
          {!embedded && (
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              Tasks
            </h1>
          )}
          <div className="flex items-center gap-2">
            {headerAction}
            <Button size="lg" onClick={() => setAddOpen(true)}>
              <PlusIcon />
              Task
            </Button>
          </div>
        </div>
      )}

      <DndProvider backend={HTML5Backend}>
        <div className="quiet-scrollbar flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2">
          {columns.map((column) => (
            <TaskColumn
              key={column.status}
              column={column}
              tasks={tasks.filter((t) => t.status === column.status)}
              onDropTask={handleDropTask}
              onOpenTask={handleOpenTask}
              onDeleteTask={handleDeleteTask}
              hiddenFields={hiddenFields}
            />
          ))}
        </div>
      </DndProvider>

      <TaskModal
        mode="add"
        open={addOpen}
        assignees={assignees}
        columns={columns}
        hiddenFields={hiddenFields}
        onClose={() => setAddOpen(false)}
        onSubmit={handleAddTask}
      />

      <TaskModal
        mode="edit"
        open={editing !== null}
        task={editing}
        assignees={assignees}
        columns={columns}
        hiddenFields={hiddenFields}
        onClose={() => setEditing(null)}
        onSubmit={handleSaveTask}
        // Close the editor first: the confirm dialog replaces it rather than
        // stacking on top of it.
        onDelete={(task) => {
          setEditing(null);
          setDeleting(task);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleConfirmDelete}
        title={deleting ? `Delete ${deleting.title}?` : "Delete?"}
        description="This permanently removes the task. This can't be undone."
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}
