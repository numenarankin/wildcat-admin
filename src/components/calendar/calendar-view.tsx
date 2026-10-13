"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useServerState } from "@/hooks/use-server-state";
import { addDays, addMonths, fromISO, toISO } from "@/lib/calendar/dates";
import { CalendarToolbar } from "@/components/calendar/calendar-toolbar";
import {
  AssigneeFilter,
  assigneeOptions,
  isVisible,
} from "@/components/calendar/assignee-filter";
import { MonthGrid } from "@/components/calendar/month-grid";
import { WeekGrid } from "@/components/calendar/week-grid";
import {
  EventModal,
  type EventFormValues,
} from "@/components/calendar/event-modal";
import { TaskModal, type NewTask } from "@/components/tasks/task-modal";
import { TasksBoard } from "@/components/tasks/tasks-board";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
} from "@/lib/calendar/actions";
import { createTask, deleteTask, updateTask } from "@/lib/tasks/actions";
import type { Task } from "@/lib/tasks/tasks";
import type { PersonGroup } from "@/lib/people/directory";
import type { CalendarEvent } from "@/lib/calendar/calendar";
import { taskDeadlineEvents } from "@/lib/calendar/task-deadlines";

export type CalendarViewMode = "month" | "week" | "board";

/** What the modal is currently doing: creating a new event or editing one. */
type ModalState =
  | { mode: "create" }
  | { mode: "edit"; event: CalendarEvent }
  | null;

/** The task modal state: adding a new task or editing an existing one. */
type TaskModalState =
  | { mode: "add" }
  | { mode: "edit"; task: Task }
  | null;

/**
 * What the confirm dialog is about to remove. A calendar entry flagged with a
 * `taskId` is a task deadline rather than a `calendar_events` row, so it is
 * resolved to its task up front and deleted as one.
 */
type PendingDelete =
  | { kind: "event"; event: CalendarEvent }
  | { kind: "task"; id: string; title: string; folderId?: string };

function toFormValues(event: CalendarEvent): EventFormValues {
  return {
    title: event.title,
    date: event.date,
    allDay: event.allDay,
    start: event.start ?? "",
    end: event.end ?? "",
    location: event.location ?? "",
    people: event.people ?? [],
    description: event.description ?? "",
  };
}

/**
 * The entry the server will read back for these modal values, mirroring
 * `toFields` in `@/lib/calendar/actions` so the optimistic chip and the stored
 * row look the same when the refresh swaps one for the other.
 */
function toEvent(
  id: string,
  values: EventFormValues,
  category: CalendarEvent["category"]
): CalendarEvent {
  return {
    id,
    title: values.title || "Untitled event",
    date: values.date,
    allDay: values.allDay,
    start: values.allDay ? undefined : values.start || undefined,
    end: values.allDay ? undefined : values.end || undefined,
    category,
    location: values.location || undefined,
    people: values.people.length ? values.people : undefined,
    description: values.description || undefined,
  };
}

/** A task's deadline entry swapped for its new one (or none, when deleted). */
function withTaskDeadline(
  events: CalendarEvent[],
  taskId: string,
  task: Task | null
): CalendarEvent[] {
  return [
    ...events.filter((e) => e.taskId !== taskId),
    ...(task ? taskDeadlineEvents([task]) : []),
  ];
}

/** A clean event seeded on the focused day, for the create modal. */
function createDefaults(date: string): EventFormValues {
  return {
    title: "",
    date,
    allDay: false,
    start: "",
    end: "",
    location: "",
    people: [],
    description: "",
  };
}

export function CalendarView({
  today,
  events: serverEvents,
  people,
  tasks: serverTasks,
  assignees,
  viewer,
  initialView = "month",
}: {
  today: string;
  events: CalendarEvent[];
  /** Selectable attendees for the event modal, grouped. */
  people: PersonGroup[];
  /** All tasks, so a clicked task deadline can open its editor in place. */
  tasks: Task[];
  /** Assignable people for the task modal (org members). */
  assignees: string[];
  /** The signed-in person's name, so a task assigned "Me" resolves to them. */
  viewer?: string;
  /** Which view to open on (e.g. "board" via a task deep-link). */
  initialView?: CalendarViewMode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Entries land, move and vanish the moment the modal closes; the refresh after
  // each write hands both lists back to the server, which also undoes a failure.
  const [events, setEvents] = useServerState(serverEvents);
  const [tasks, setTasks] = useServerState(serverTasks);
  const [view, setView] = useState<CalendarViewMode>(initialView);
  const [cursorISO, setCursorISO] = useState(today);
  const [modal, setModal] = useState<ModalState>(null);
  const [taskModal, setTaskModal] = useState<TaskModalState>(null);
  const [deleting, setDeleting] = useState<PendingDelete | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const cursor = useMemo(() => fromISO(cursorISO), [cursorISO]);

  // Who can be filtered on — see `assigneeOptions`.
  const filterOptions = useMemo(
    () =>
      assigneeOptions(
        assignees,
        tasks.map((task) => task.assignee),
        viewer
      ),
    [assignees, tasks, viewer]
  );

  const visibleTasks = useMemo(
    () => tasks.filter((task) => isVisible(hidden, task.assignee, viewer)),
    [tasks, hidden, viewer]
  );

  /*
   * The filter reaches the month and week grids too, via the SAME task list the
   * board renders. A task deadline on the calendar IS a task, so filtering it
   * out of one view and not the other would put two views of one set of tasks
   * visibly at odds. Real calendar events are untouched: they are not tasks and
   * the control does not claim to filter them.
   */
  const visibleEvents = useMemo(() => {
    if (hidden.size === 0) return events;
    const shownTaskIds = new Set(visibleTasks.map((t) => t.id));
    return events.filter((e) => !e.taskId || shownTaskIds.has(e.taskId));
  }, [events, visibleTasks, hidden]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of visibleEvents) {
      const list = map.get(event.date) ?? [];
      list.push(event);
      map.set(event.date, list);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) ||
          (a.start ?? "").localeCompare(b.start ?? "")
      );
    }
    return map;
  }, [visibleEvents]);

  function navigate(delta: number) {
    setCursorISO((iso) => {
      const date = fromISO(iso);
      return view === "month"
        ? toISO(addMonths(date, delta))
        : toISO(addDays(date, delta * 7));
    });
  }

  function handleEventClick(event: CalendarEvent) {
    // A task deadline opens the task editor in place (there's no calendar_events
    // row to edit). Fall back to the board only if the task isn't loaded here.
    if (event.taskId) {
      const task = tasks.find((t) => t.id === event.taskId);
      if (task) setTaskModal({ mode: "edit", task });
      else setView("board");
      return;
    }
    setModal({ mode: "edit", event });
  }

  /** Resolve a clicked calendar entry to the thing that actually gets deleted. */
  function toPendingDelete(event: CalendarEvent): PendingDelete {
    if (!event.taskId) return { kind: "event", event };
    // A task deadline whose task isn't loaded here still has an id, which is
    // all `deleteTask` needs; the folder tag only steers revalidation.
    const task = tasks.find((t) => t.id === event.taskId);
    return {
      kind: "task",
      id: event.taskId,
      title: task?.title ?? event.title,
      folderId: task?.folderId,
    };
  }

  /** Persist a write already drawn; tell the user and restore on failure. */
  function persist(write: () => Promise<void>, failure: string) {
    startTransition(async () => {
      try {
        await write();
      } catch (error) {
        console.error(failure, error);
        toast.error(failure);
      }
      // Always refresh: on success it confirms the entry, on failure it restores
      // the server's truth over the optimistic one.
      router.refresh();
    });
  }

  function handleConfirmDelete() {
    const target = deleting;
    if (!target) return;
    if (target.kind === "task") {
      setTasks((prev) => prev.filter((t) => t.id !== target.id));
      setEvents((prev) => withTaskDeadline(prev, target.id, null));
      persist(
        () => deleteTask(target.id, target.folderId),
        "Couldn't delete the task."
      );
    } else {
      setEvents((prev) => prev.filter((e) => e.id !== target.event.id));
      persist(
        () => deleteCalendarEvent(target.event.id),
        "Couldn't delete the event."
      );
    }
  }

  function handleAddTask(task: NewTask) {
    const local: Task = { id: `task-local-${Date.now()}`, ...task };
    setTasks((prev) => [local, ...prev]);
    setEvents((prev) => withTaskDeadline(prev, local.id, local));
    persist(() => createTask(task), "Couldn't add the task.");
  }

  function handleSaveTask(task: NewTask) {
    if (taskModal?.mode !== "edit") return;
    const id = taskModal.task.id;
    // The modal doesn't edit the project tag — preserve the task's existing one.
    const full: NewTask = { ...task, folderId: taskModal.task.folderId };
    const saved: Task = { id, ...full };
    setTasks((prev) => prev.map((t) => (t.id === id ? saved : t)));
    setEvents((prev) => withTaskDeadline(prev, id, saved));
    persist(() => updateTask(id, full), "Couldn't save the task.");
  }

  function handleSubmit(values: EventFormValues) {
    if (modal?.mode === "edit") {
      const { id, category } = modal.event;
      setEvents((prev) =>
        prev.map((e) => (e.id === id ? toEvent(id, values, category) : e))
      );
      persist(
        () => updateCalendarEvent(id, values),
        "Couldn't save the event."
      );
    } else {
      // Minted here so the chip carries the id the row is stored under.
      const id = crypto.randomUUID();
      setEvents((prev) => [...prev, toEvent(id, values, "office")]);
      persist(
        () => createCalendarEvent(values, id),
        "Couldn't add the event."
      );
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CalendarToolbar
        view={view}
        onView={setView}
        cursor={cursor}
        onPrev={() => navigate(-1)}
        onNext={() => navigate(1)}
        onNewTask={() => setTaskModal({ mode: "add" })}
        onNewEvent={() => setModal({ mode: "create" })}
        filter={
          <AssigneeFilter
            options={filterOptions}
            hidden={hidden}
            viewer={viewer}
            onChange={setHidden}
          />
        }
      />
      {view === "board" ? (
        // The exact tasks-page board, embedded (its own add/edit modals + DnD).
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-8">
          <TasksBoard
            tasks={visibleTasks}
            assignees={assignees}
            embedded
            hideHeader
          />
        </div>
      ) : view === "month" ? (
        <MonthGrid
          cursor={cursor}
          today={today}
          eventsByDate={eventsByDate}
          onEventClick={handleEventClick}
          onEventDelete={(event) => setDeleting(toPendingDelete(event))}
        />
      ) : (
        <WeekGrid
          cursor={cursor}
          today={today}
          eventsByDate={eventsByDate}
          onEventClick={handleEventClick}
          onEventDelete={(event) => setDeleting(toPendingDelete(event))}
        />
      )}

      <EventModal
        open={modal !== null}
        mode={modal?.mode ?? "create"}
        people={people}
        initial={
          modal?.mode === "edit"
            ? toFormValues(modal.event)
            : createDefaults(cursorISO)
        }
        onClose={() => setModal(null)}
        onSubmit={handleSubmit}
        // Close the editor first: the confirm dialog replaces it rather than
        // stacking on top of it.
        onDelete={
          modal?.mode === "edit"
            ? () => {
                const { event } = modal;
                setModal(null);
                setDeleting({ kind: "event", event });
              }
            : undefined
        }
      />

      <TaskModal
        mode="add"
        open={taskModal?.mode === "add"}
        assignees={assignees}
        onClose={() => setTaskModal(null)}
        onSubmit={handleAddTask}
      />
      <TaskModal
        mode="edit"
        open={taskModal?.mode === "edit"}
        task={taskModal?.mode === "edit" ? taskModal.task : null}
        assignees={assignees}
        onClose={() => setTaskModal(null)}
        onSubmit={handleSaveTask}
        onDelete={(task) => {
          setTaskModal(null);
          setDeleting({
            kind: "task",
            id: task.id,
            title: task.title,
            folderId: task.folderId,
          });
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleConfirmDelete}
        title={
          deleting
            ? `Delete ${deleting.kind === "task" ? deleting.title : deleting.event.title}?`
            : "Delete?"
        }
        description={
          deleting?.kind === "task"
            ? "This permanently removes the task, not just its deadline. This can't be undone."
            : "This permanently removes the event. This can't be undone."
        }
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}
