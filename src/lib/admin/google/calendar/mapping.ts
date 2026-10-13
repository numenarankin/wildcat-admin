import type { CalendarEvent } from "@/lib/calendar/calendar";
import type { EventFormValues } from "@/components/calendar/event-modal";
import { addDays, fromISO, monthCells, toISO, weekDays } from "@/lib/calendar/dates";
import type {
  CalendarColor,
  GoogleAttendee,
  GoogleCalendar,
  GoogleCalendarListEntry,
  GoogleColors,
  GoogleEvent,
  GoogleEventDateTime,
  GoogleEventInput,
  GoogleEventRow,
} from "@/lib/admin/google/calendar/types";

/**
 * Pure mapping between Google Calendar's shapes and the agenda's. Shared by
 * the server client (reads) and the page's client view (writes), so it never
 * imports anything server-only.
 */

export type AdminCalendarView = "month" | "week";

/** Google's own default when a calendar carries no color. */
const DEFAULT_COLOR: CalendarColor = { background: "#039be5", foreground: "#ffffff" };

/** A timed segment that runs past midnight is drawn to the end of its day. */
const END_OF_DAY = "23:59";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `n` days after an ISO date, in calendar arithmetic (no zone involved). */
export function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Wall-clock date and time of an instant in `zone`. */
export function wallTime(instant: Date, zone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** Milliseconds `zone` is ahead of UTC at `utcMs` (a whole minute). */
function offsetMs(utcMs: number, zone: string): number {
  const { date, time } = wallTime(new Date(utcMs), zone);
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, min) - utcMs;
}

/** The instant midnight starts `iso` in `zone`, as RFC 3339 (UTC). */
export function zonedMidnight(iso: string, zone: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let utc = guess - offsetMs(guess, zone);
  // Across a DST change the offset at the guess and at the answer differ.
  const second = guess - offsetMs(utc, zone);
  if (second !== utc) utc = second;
  return new Date(utc).toISOString();
}

/** First and last (inclusive) day a view draws around `cursor`. */
export function visibleDays(view: AdminCalendarView, cursor: string): { first: string; last: string } {
  const date = fromISO(cursor);
  const days = view === "month" ? monthCells(date.getFullYear(), date.getMonth()) : weekDays(date);
  return { first: toISO(days[0]), last: toISO(days[days.length - 1]) };
}

/** `timeMin` / `timeMax` for `events.list`: the visible days, in the admin's zone. */
export function visibleRange(
  view: AdminCalendarView,
  cursor: string,
  zone: string
): { timeMin: string; timeMax: string } {
  const { first, last } = visibleDays(view, cursor);
  return { timeMin: zonedMidnight(first, zone), timeMax: zonedMidnight(addDaysISO(last, 1), zone) };
}

/** The cursor a prev / next step lands on, as the customer agenda steps. */
export function stepCursor(view: AdminCalendarView, cursor: string, delta: number): string {
  const date = fromISO(cursor);
  return view === "month"
    ? toISO(new Date(date.getFullYear(), date.getMonth() + delta, 1))
    : toISO(addDays(date, delta * 7));
}

export function toCalendar(entry: GoogleCalendarListEntry): GoogleCalendar {
  return {
    id: entry.id,
    name: entry.summaryOverride || entry.summary || entry.id,
    color: {
      background: entry.backgroundColor ?? DEFAULT_COLOR.background,
      foreground: entry.foregroundColor ?? DEFAULT_COLOR.foreground,
    },
    primary: entry.primary === true,
    writable: entry.accessRole === "owner" || entry.accessRole === "writer",
    selected: entry.selected === true,
  };
}

/** Where an event starts or ends, in the admin's zone. */
function endpoint(value: GoogleEventDateTime, zone: string): { date: string; time?: string } {
  if (value.date) return { date: value.date };
  return wallTime(new Date(value.dateTime ?? ""), zone);
}

export function toRow(
  calendar: GoogleCalendar,
  event: GoogleEvent,
  colors: GoogleColors,
  zone: string
): GoogleEventRow {
  const allDay = Boolean(event.start.date);
  const start = endpoint(event.start, zone);
  const end = endpoint(event.end, zone);
  // All-day: Google's end date is exclusive. Timed: an end at exactly midnight
  // belongs to the day before.
  const endDate = allDay
    ? addDaysISO(end.date, -1)
    : end.time === "00:00" && end.date > start.date
      ? addDaysISO(end.date, -1)
      : end.date;
  const palette = event.colorId ? colors.event?.[event.colorId] : undefined;
  return {
    key: `${calendar.id}|${event.id}`,
    calendarId: calendar.id,
    eventId: event.id,
    etag: event.etag,
    title: event.summary || "(No title)",
    allDay,
    startDate: start.date,
    endDate: endDate < start.date ? start.date : endDate,
    start: allDay ? undefined : start.time,
    end: allDay ? undefined : end.time === "00:00" && end.date > start.date ? END_OF_DAY : end.time,
    location: event.location || undefined,
    description: event.description || undefined,
    attendees: event.attendees ?? [],
    color: palette ? { background: palette.background, foreground: palette.foreground } : calendar.color,
    writable: calendar.writable,
  };
}

/** Rows for every listed event, cancelled ones dropped, in start order. */
export function toRows(
  calendars: GoogleCalendar[],
  eventsByCalendar: Map<string, GoogleEvent[]>,
  colors: GoogleColors,
  zone: string
): GoogleEventRow[] {
  const rows: GoogleEventRow[] = [];
  for (const calendar of calendars) {
    for (const event of eventsByCalendar.get(calendar.id) ?? []) {
      if (event.status === "cancelled") continue;
      rows.push(toRow(calendar, event, colors, zone));
    }
  }
  return rows.sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      (a.start ?? "").localeCompare(b.start ?? "") ||
      a.title.localeCompare(b.title)
  );
}

/** The chip id a row's segment on `date` is drawn under. */
export function segmentId(row: GoogleEventRow, date: string): string {
  return `${row.key}|${date}`;
}

/**
 * The agenda entries one row draws: one per day it covers, so a three-day
 * event sits on all three days, as it does in Google.
 */
export function toSegments(row: GoogleEventRow): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (let date = row.startDate; date <= row.endDate; date = addDaysISO(date, 1)) {
    out.push({
      id: segmentId(row, date),
      title: row.title,
      date,
      allDay: row.allDay,
      start: row.allDay ? undefined : date === row.startDate ? row.start : "00:00",
      end: row.allDay ? undefined : date === row.endDate ? row.end : END_OF_DAY,
      category: "office",
      location: row.location,
      people: row.attendees.length ? row.attendees.map((a) => a.email) : undefined,
      description: row.description,
      color: row.color,
      readOnly: !row.writable,
    });
  }
  return out;
}

/** What the event modal opens with for a row. */
export function toFormValues(row: GoogleEventRow): EventFormValues {
  const multiDay = row.endDate > row.startDate;
  return {
    title: row.title,
    date: row.startDate,
    allDay: row.allDay,
    start: row.start ?? "",
    end: row.allDay ? "" : multiDay ? END_OF_DAY : (row.end ?? ""),
    location: row.location ?? "",
    people: row.attendees.map((a) => a.email),
    description: row.description ?? "",
  };
}

/**
 * Start and end for these modal values. All-day sends `date` (end exclusive);
 * timed sends a wall-clock `dateTime` with the admin's `timeZone`, which Google
 * accepts in place of an offset. On a patch the other kind is cleared with an
 * explicit null, or Google keeps it alongside.
 */
function times(values: EventFormValues, zone: string, clear: boolean): Pick<GoogleEventInput, "start" | "end"> {
  if (values.allDay) {
    const extra = clear ? { dateTime: null, timeZone: null } : {};
    return {
      start: { date: values.date, ...extra },
      end: { date: addDaysISO(values.date, 1), ...extra },
    };
  }
  const extra = clear ? { date: null } : {};
  return {
    start: { dateTime: `${values.date}T${values.start}:00`, timeZone: zone, ...extra },
    end: { dateTime: `${values.date}T${values.end}:00`, timeZone: zone, ...extra },
  };
}

/** The `events.insert` body for a new event. */
export function insertBody(values: EventFormValues, zone: string): GoogleEventInput {
  const body: GoogleEventInput = { summary: values.title, ...times(values, zone, false) };
  if (values.location) body.location = values.location;
  if (values.description) body.description = values.description;
  if (values.people.length) body.attendees = values.people.map((email) => ({ email }));
  return body;
}

/**
 * The `events.patch` body: only what the admin changed from what the modal
 * opened with, so an untouched field (a multi-day span the modal cannot show,
 * a guest's reply) is left as Google has it. Null when nothing changed.
 */
export function patchBody(
  row: GoogleEventRow,
  values: EventFormValues,
  zone: string
): GoogleEventInput | null {
  const initial = toFormValues(row);
  const body: GoogleEventInput = {};
  if (values.title !== initial.title) body.summary = values.title;
  if (values.location !== initial.location) body.location = values.location;
  if (values.description !== initial.description) body.description = values.description;
  if (
    values.date !== initial.date ||
    values.allDay !== initial.allDay ||
    (!values.allDay && (values.start !== initial.start || values.end !== initial.end))
  ) {
    Object.assign(body, times(values, zone, true));
  }
  const before = initial.people.map((e) => e.toLowerCase()).sort().join(",");
  const after = values.people.map((e) => e.toLowerCase()).sort().join(",");
  if (before !== after) {
    // Kept guests keep their replies; Google replaces the whole list on patch.
    const byEmail = new Map(row.attendees.map((a) => [a.email.toLowerCase(), a]));
    body.attendees = values.people.map(
      (email): GoogleAttendee => byEmail.get(email.toLowerCase()) ?? { email }
    );
  }
  return Object.keys(body).length ? body : null;
}
