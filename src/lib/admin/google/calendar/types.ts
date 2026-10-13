/**
 * Google Calendar API v3 shapes (only the fields this page reads or writes),
 * and the rows the admin calendar draws from them. Plan:
 * docs/plans/google-integration.md section 7.2.
 */

/** `calendarList` entry. https://developers.google.com/calendar/api/v3/reference/calendarList */
export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  accessRole?: "freeBusyReader" | "reader" | "writer" | "owner";
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
  deleted?: boolean;
}

export interface GoogleCalendarList {
  items?: GoogleCalendarListEntry[];
  nextPageToken?: string;
}

/** An event's start or end: `date` for all-day, `dateTime` (RFC 3339) for timed. */
export interface GoogleEventDateTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

export interface GoogleAttendee {
  email: string;
  displayName?: string;
  optional?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  comment?: string;
  additionalGuests?: number;
}

/** `events` resource. https://developers.google.com/calendar/api/v3/reference/events */
export interface GoogleEvent {
  id: string;
  etag: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  attendees?: GoogleAttendee[];
  recurringEventId?: string;
  htmlLink?: string;
}

export interface GoogleEventList {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

/** `colors.get`. https://developers.google.com/calendar/api/v3/reference/colors */
export interface GoogleColors {
  event?: Record<string, { background: string; foreground: string }>;
}

/** What a write sends: only these fields ever reach Google. */
export interface GoogleEventInput {
  summary?: string;
  location?: string;
  description?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  attendees?: GoogleAttendee[];
}

/** Which event a patch or delete is for, and the version it was read at. */
export interface GoogleEventRef {
  calendarId: string;
  eventId: string;
  etag: string;
  /** Guests are emailed about the change (`sendUpdates=all`). */
  hasAttendees: boolean;
}

export interface CalendarColor {
  background: string;
  foreground: string;
}

/** One calendar in the picker. */
export interface GoogleCalendar {
  id: string;
  name: string;
  color: CalendarColor;
  primary: boolean;
  /** Owner or writer: events on it can be created, edited and deleted. */
  writable: boolean;
  /** Shown in Google's own calendar UI; the picker's default. */
  selected: boolean;
}

/**
 * One Google event, in the admin's zone. Dates are ISO `YYYY-MM-DD`, times
 * 24-hour `HH:MM`. `endDate` is the LAST day the event covers (Google's
 * all-day `end.date` is exclusive; this is not).
 */
export interface GoogleEventRow {
  /** Unique across calendars: one meeting can sit on two of them. */
  key: string;
  calendarId: string;
  eventId: string;
  etag: string;
  title: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  /** Timed only. */
  start?: string;
  /** Timed only. */
  end?: string;
  location?: string;
  description?: string;
  attendees: GoogleAttendee[];
  color: CalendarColor;
  writable: boolean;
}

export type CalendarActionResult =
  | { ok: true }
  | { ok: false; error: string; stale?: boolean };
