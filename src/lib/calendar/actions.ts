"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";

/** The editable fields exposed by the event modal. */
export interface CalendarEventInput {
  title: string;
  /** Date as an ISO `YYYY-MM-DD` string. */
  date: string;
  /** True for all-day items; `start`/`end` are ignored when true. */
  allDay: boolean;
  /** Start time as a 24-hour `HH:MM` string ("" when all-day). */
  start: string;
  /** End time as a 24-hour `HH:MM` string ("" when all-day). */
  end: string;
  location: string;
  people: string[];
  description: string;
}

/** Maps the modal's editable fields to a `calendar_events` row patch. */
function toFields(input: CalendarEventInput) {
  return {
    title: input.title || "Untitled event",
    event_date: input.date,
    all_day: input.allDay,
    start_time: input.allDay ? null : input.start || null,
    end_time: input.allDay ? null : input.end || null,
    location: input.location || null,
    people: input.people.length ? input.people : null,
    description: input.description || null,
  };
}

/**
 * The page that renders the calendar. It lives at `/agenda`, not `/calendar` —
 * revalidating the latter was a no-op that the client's `router.refresh()`
 * happened to cover.
 */
const CALENDAR_PATH = "/agenda";

/**
 * Create a new event from the modal's fields. `id` lets the agenda draw the
 * event before this returns under the id it will keep, so opening it before the
 * refresh lands edits the real row rather than one that does not exist.
 */
export async function createCalendarEvent(
  input: CalendarEventInput,
  id?: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("calendar_events").insert({
    ...(id ? { id } : {}),
    category: "office",
    ...toFields(input),
  });
  if (error) throw new Error(`createCalendarEvent: ${error.message}`);
  revalidatePath(CALENDAR_PATH);
}

/** Update an existing event's editable fields. */
export async function updateCalendarEvent(
  id: string,
  input: CalendarEventInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("calendar_events")
    .update(toFields(input))
    .eq("id", id);
  if (error) throw new Error(`updateCalendarEvent: ${error.message}`);
  revalidatePath(CALENDAR_PATH);
}

/**
 * Delete an event. Only real `calendar_events` rows can be deleted here; task
 * deadlines shown on the calendar are derived from `tasks` and are removed by
 * deleting the task itself.
 */
export async function deleteCalendarEvent(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("calendar_events").delete().eq("id", id);
  if (error) throw new Error(`deleteCalendarEvent: ${error.message}`);
  revalidatePath(CALENDAR_PATH);
}
