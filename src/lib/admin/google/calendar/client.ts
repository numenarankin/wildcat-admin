import "server-only";
import { googleFetch, googleUrl } from "@/lib/admin/google/fetch";
import { toCalendar, toRows } from "@/lib/admin/google/calendar/mapping";
import type {
  GoogleCalendar,
  GoogleCalendarList,
  GoogleColors,
  GoogleEvent,
  GoogleEventInput,
  GoogleEventList,
  GoogleEventRef,
  GoogleEventRow,
} from "@/lib/admin/google/calendar/types";

/**
 * Google Calendar API v3 for one admin. Every call takes the SESSION's user id
 * (from `guard.ts`), never one from input. Plan:
 * docs/plans/google-integration.md section 7.2.
 */

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3/";

function eventsUrl(calendarId: string, eventId?: string): string {
  const base = `${CALENDAR_API}calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

/** Every calendar on the admin's list, primary first, then Google's order. */
export async function listCalendars(userId: string): Promise<GoogleCalendar[]> {
  const calendars: GoogleCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleFetch<GoogleCalendarList>(
      userId,
      "calendar",
      googleUrl(`${CALENDAR_API}users/me/calendarList`, { maxResults: 250, pageToken })
    );
    for (const entry of page.items ?? []) {
      if (entry.deleted || entry.hidden) continue;
      calendars.push(toCalendar(entry));
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return calendars.sort((a, b) => Number(b.primary) - Number(a.primary));
}

/** Google's event color palette (`colorId` to colors). */
export async function getColors(userId: string): Promise<GoogleColors> {
  return googleFetch<GoogleColors>(userId, "calendar", `${CALENDAR_API}colors`);
}

/** One calendar's events overlapping the range, recurring ones expanded. */
export async function listEvents(
  userId: string,
  calendarId: string,
  range: { timeMin: string; timeMax: string }
): Promise<GoogleEvent[]> {
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleFetch<GoogleEventList>(
      userId,
      "calendar",
      googleUrl(eventsUrl(calendarId), {
        timeMin: range.timeMin,
        timeMax: range.timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500,
        pageToken,
      })
    );
    events.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return events;
}

/**
 * Everything the page draws: the calendar list, and the events of the selected
 * calendars for the range. `selected` null means Google's own selection.
 */
export async function loadCalendar(
  userId: string,
  input: { range: { timeMin: string; timeMax: string }; selected: string[] | null; zone: string }
): Promise<{ calendars: GoogleCalendar[]; selected: string[]; rows: GoogleEventRow[] }> {
  const [calendars, colors] = await Promise.all([listCalendars(userId), getColors(userId)]);
  const known = new Set(calendars.map((c) => c.id));
  const selected = input.selected
    ? input.selected.filter((id) => known.has(id))
    : calendars.filter((c) => c.selected).map((c) => c.id);
  const shown = calendars.filter((c) => selected.includes(c.id));
  const lists = await Promise.all(shown.map((c) => listEvents(userId, c.id, input.range)));
  const byCalendar = new Map(shown.map((c, i) => [c.id, lists[i]]));
  return { calendars, selected, rows: toRows(shown, byCalendar, colors, input.zone) };
}

export async function insertEvent(
  userId: string,
  calendarId: string,
  body: GoogleEventInput
): Promise<GoogleEvent> {
  return googleFetch<GoogleEvent>(
    userId,
    "calendar",
    googleUrl(eventsUrl(calendarId), { sendUpdates: body.attendees?.length ? "all" : undefined }),
    { method: "POST", json: body }
  );
}

/**
 * Patch the event at the version it was read. A recurring event's instance id
 * patches that one occurrence. A 412 means it changed in Google since.
 */
export async function patchEvent(
  userId: string,
  ref: GoogleEventRef,
  body: GoogleEventInput
): Promise<GoogleEvent> {
  const notify = ref.hasAttendees || Boolean(body.attendees?.length);
  return googleFetch<GoogleEvent>(
    userId,
    "calendar",
    googleUrl(eventsUrl(ref.calendarId, ref.eventId), { sendUpdates: notify ? "all" : undefined }),
    { method: "PATCH", json: body, headers: { "If-Match": ref.etag } }
  );
}

export async function deleteEvent(userId: string, ref: GoogleEventRef): Promise<void> {
  await googleFetch<null>(
    userId,
    "calendar",
    googleUrl(eventsUrl(ref.calendarId, ref.eventId), { sendUpdates: ref.hasAttendees ? "all" : undefined }),
    { method: "DELETE", headers: { "If-Match": ref.etag } }
  );
}
