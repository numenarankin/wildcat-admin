"use client";

import type { Ref } from "react";
import { useDrop } from "react-dnd";
import { cn } from "@/lib/utils";
import { TaskCard, TASK_DND_TYPE, type TaskDragItem } from "@/components/tasks/task-card";
import type { Task, TaskColumn as TaskColumnDef, TaskField } from "@/lib/tasks/tasks";

interface TaskColumnProps {
  column: TaskColumnDef;
  tasks: Task[];
  onDropTask: (taskId: string, status: TaskColumnDef["status"]) => void;
  onOpenTask: (task: Task) => void;
  /** Delete a task from its card; omit to hide the control. */
  onDeleteTask?: (task: Task) => void;
  hiddenFields?: readonly TaskField[];
}

export function TaskColumn({
  column,
  tasks,
  onDropTask,
  onOpenTask,
  onDeleteTask,
  hiddenFields,
}: TaskColumnProps) {
  const [{ isOver }, dropRef] = useDrop<
    TaskDragItem,
    unknown,
    { isOver: boolean }
  >(() => ({
    accept: TASK_DND_TYPE,
    drop: (item) => onDropTask(item.id, column.status),
    collect: (monitor) => ({ isOver: monitor.isOver() }),
  }), [column.status, onDropTask]);

  return (
    <div className="flex min-h-0 min-w-[280px] max-w-[320px] flex-1 flex-col rounded-xl bg-muted/40">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <span className="text-sm font-semibold text-foreground">
          {column.label}
        </span>
        <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
          {tasks.length}
        </span>
      </div>
      <div
        ref={dropRef as unknown as Ref<HTMLDivElement>}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-2 transition-colors",
          isOver && "bg-foreground/5 ring-1 ring-inset ring-foreground/15"
        )}
      >
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onOpen={onOpenTask}
            onDelete={onDeleteTask}
            hiddenFields={hiddenFields}
          />
        ))}
        {tasks.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground/70">
            No tasks
          </p>
        )}
      </div>
    </div>
  );
}
