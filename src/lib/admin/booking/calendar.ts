import "server-only";
import { getGtmDb } from "@/lib/admin/gtm/db";
import { insertEvent, listEvents } from "@/lib/admin/google/calendar/client";
import type { GoogleEvent, GoogleEventInput } from "@/lib/admin/google/calendar/types";

/**
 * The owner's Google Calendar, for the landing's demo booking
 * (docs/plans/demo-booking.md). The landing works out open slots itself; it
 * comes here only for what needs the owner's Google login: the busy events,
 * and the event for a new booking.
 */

const ZONE = "America/Chicago";

export function calendarUserId(): string {
  const id = process.env.BOOKING_CALENDAR_USER_ID;
  if (!id) throw new Error("Booking not configured: set BOOKING_CALENDAR_USER_ID");
  return id;
}

/** One event that keeps the owner busy. Timed events carry instants, all-day ones Central dates (end exclusive). */
export interface BusyEvent {
  id: string;
  start: string | null;
  end: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
}

/** Events not shown as Free, not cancelled and not declined. */
export function busyEvents(events: readonly GoogleEvent[]): BusyEvent[] {
  const out: BusyEvent[] = [];
  for (const e of events) {
    if (e.status === "cancelled" || e.transparency === "transparent") continue;
    if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
    const location = e.location?.trim() || null;
    if (e.start.date && e.end.date) {
      out.push({ id: e.id, start: null, end: null, startDate: e.start.date, endDate: e.end.date, location });
    } else if (e.start.dateTime && e.end.dateTime) {
      out.push({ id: e.id, start: new Date(e.start.dateTime).toISOString(), end: new Date(e.end.dateTime).toISOString(), startDate: null, endDate: null, location });
    }
  }
  return out;
}

export async function readBusy(timeMin: string, timeMax: string): Promise<BusyEvent[]> {
  return busyEvents(await listEvents(calendarUserId(), "primary", { timeMin, timeMax }));
}

interface BookingRow {
  name: string;
  email: string;
  company: string;
  office_address: string;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  status: string;
  google_event_id: string | null;
}

export function eventFor(b: BookingRow): GoogleEventInput {
  return {
    summary: `WildcatIQ demo: ${b.company}`,
    location: b.office_address,
    description: [`Name: ${b.name}`, `Email: ${b.email}`, `Company: ${b.company}`, b.notes?.trim() ? `\nNotes:\n${b.notes.trim()}` : ""]
      .filter(Boolean)
      .join("\n"),
    start: { dateTime: new Date(b.starts_at).toISOString(), timeZone: ZONE },
    end: { dateTime: new Date(b.ends_at).toISOString(), timeZone: ZONE },
    attendees: [{ email: b.email, displayName: b.name }],
  };
}

/**
 * Puts a confirmed booking on the owner's calendar with the visitor invited
 * (Google emails them). Reads the row itself, so the caller can only name a
 * booking, not shape the event. Once only: a booking with an event is left alone.
 */
export async function createBookingEvent(bookingId: string): Promise<{ eventId: string }> {
  const db = getGtmDb();
  const { data, error } = await db
    .from("demo_bookings")
    .select("name, email, company, office_address, starts_at, ends_at, notes, status, google_event_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw new Error(`Booking read failed: ${error.message}`);
  const row = data as BookingRow | null;
  if (!row || row.status !== "confirmed") throw new Error("No such booking.");
  if (row.google_event_id) return { eventId: row.google_event_id };

  const event = await insertEvent(calendarUserId(), "primary", eventFor(row));
  const { error: saveErr } = await db.from("demo_bookings").update({ google_event_id: event.id }).eq("id", bookingId);
  if (saveErr) console.error("[booking] event id not saved", bookingId, saveErr.message);
  return { eventId: event.id };
}
