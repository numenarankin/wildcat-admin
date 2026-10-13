import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { addDays, toISO } from "@/lib/calendar/dates";
import { getTasks, type Task } from "@/lib/tasks/tasks";
import { taskDeadlineEvents } from "@/lib/calendar/task-deadlines";

/**
 * Operations calendar events — field work, maintenance, hauling, regulatory
 * deadlines, and office items. Times are local `HH:MM` strings; all-day items
 * omit them.
 */

/** Broad category for an event, used for subtle visual differentiation. */
export type EventCategory =
  | "production"
  | "maintenance"
  | "logistics"
  | "compliance"
  | "office";

export interface CalendarEvent {
  id: string;
  title: string;
  /** Date as an ISO `YYYY-MM-DD` string. */
  date: string;
  /** True for all-day items; `start`/`end` are omitted when true. */
  allDay: boolean;
  /** Start time as a 24-hour `HH:MM` string (timed events only). */
  start?: string;
  /** End time as a 24-hour `HH:MM` string (timed events only). */
  end?: string;
  category: EventCategory;
  /** Optional location / lease the event takes place at. */
  location?: string;
  /** Optional attendees. */
  people?: string[];
  /** Optional free-form notes. */
  description?: string;
  /**
   * Set when this entry is a task deadline surfaced on the calendar rather than
   * a real `calendar_events` row. Such entries are read-only here (clicking
   * them links back to the task) and cannot be edited via the event modal.
   */
  taskId?: string;
  /**
   * The entry's own colors (a Google calendar's or event's). Unset, the chip
   * wears its category shade.
   */
  color?: { background: string; foreground: string };
  /** Opens in the modal read only, with no delete control. */
  readOnly?: boolean;
}

interface CalendarEventRow {
  id: string;
  title: string;
  event_date: string;
  all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  category: EventCategory;
  location: string | null;
  people: string[] | null;
  description: string | null;
}

function mapEvent(r: CalendarEventRow): CalendarEvent {
  return {
    id: r.id,
    title: r.title,
    date: r.event_date,
    allDay: r.all_day,
    start: r.start_time ? r.start_time.slice(0, 5) : undefined,
    end: r.end_time ? r.end_time.slice(0, 5) : undefined,
    category: r.category,
    location: r.location ?? undefined,
    people: r.people ?? undefined,
    description: r.description ?? undefined,
  };
}

/** How far before / after today to load events for the month / week views. */
const WINDOW_BEFORE_DAYS = 60;
const WINDOW_AFTER_DAYS = 120;

/**
 * Returns calendar events within a window around the current date, so month
 * and week views can page without refetching. Returns an empty list when
 * Supabase is not configured.
 */
export async function getCalendarEvents(): Promise<CalendarEvent[]> {
  if (!hasSupabase()) return [];

  const today = new Date();
  const from = toISO(addDays(today, -WINDOW_BEFORE_DAYS));
  const to = toISO(addDays(today, WINDOW_AFTER_DAYS));

  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("calendar_events")
    .select(
      "id, title, event_date, all_day, start_time, end_time, category, location, people, description"
    )
    .gte("event_date", from)
    .lte("event_date", to)
    .order("event_date", { ascending: true })
    .order("start_time", { ascending: true, nullsFirst: true });
  if (error) throw new Error(`getCalendarEvents: ${error.message}`);

  return ((data ?? []) as CalendarEventRow[]).map(mapEvent);
}

/**
 * Tasks that carry a deadline, surfaced as read-only calendar entries so due
 * dates show up alongside scheduled events. Always timed: a task with a due time
 * renders at that time, and a date-only deadline defaults to end of the work day
 * (`DEFAULT_DEADLINE_TIME`) so it sits on the grid at its due time instead
 * of the all-day band.
 */
export async function getTaskDeadlineEvents(
  /** Tasks already in hand (the agenda page reads them for its board), so the
   *  table is read once per render; unset, this reads them. */
  tasks?: Task[]
): Promise<CalendarEvent[]> {
  return taskDeadlineEvents(tasks ?? (await getTasks()));
}
