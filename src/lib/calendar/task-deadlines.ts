import type { CalendarEvent, EventCategory } from "@/lib/calendar/calendar";
import type { Task } from "@/lib/tasks/tasks";

/*
 * Kept out of `calendar.ts` so the agenda's client view can derive a task's
 * deadline entry the moment the task is edited, without importing the server
 * Supabase client that file reads through.
 */

/**
 * Default due time for a date-only task deadline: end of the work day. A task
 * with no explicit time still renders in the timed grid at this hour (rather than
 * the all-day band at the top), so "due today" reads as "due by end of day".
 */
const DEFAULT_DEADLINE_TIME = "17:00";

/** The deadline events of a task list; pure. */
export function taskDeadlineEvents(tasks: Task[]): CalendarEvent[] {
  return tasks
    .filter((task) => task.deadline)
    .map((task) => ({
      id: `task-${task.id}`,
      taskId: task.id,
      title: task.title,
      date: task.deadline as string,
      allDay: false,
      start: task.deadlineTime || DEFAULT_DEADLINE_TIME,
      category: "compliance" as EventCategory,
    }));
}
