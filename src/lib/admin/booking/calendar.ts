import "server-only";
import { getGtmDb } from "@/lib/admin/gtm/db";
import { insertEvent, listEvents } from "@/lib/admin/google/calendar/client";
import type { GoogleEvent, GoogleEventInput } from "@/lib/admin/google/calendar/types";
import { sendBookingEmail } from "@/lib/admin/booking/emails";

/**
 * The owner's Google Calendar, for the landing's demo booking
 * (docs/plans/demo-booking.md). The landing works out open slots itself; it
 * comes here only for what needs the owner's Google login: the busy events,
 * and, for a new booking, the owner's calendar event and the visitor's
 * confirmation from the owner's Gmail.
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
  };
}

/**
 * A booking the landing just wrote: puts it on the owner's calendar (the 30
 * minutes on paper, no guests, so Google Calendar emails nobody) and sends the
 * visitor's confirmation, with its calendar file, from the owner's Gmail.
 * Reads the row itself, so the caller can only name a booking, not shape the
 * event or the email. A booking that already has an event was handled before
 * and is left alone, so a repeat call sends nothing twice.
 */
export async function handleNewBooking(bookingId: string): Promise<{ calendar: boolean; email: boolean }> {
  const db = getGtmDb();
  const { data, error } = await db
    .from("demo_bookings")
    .select("name, email, company, office_address, starts_at, ends_at, notes, status, google_event_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw new Error(`Booking read failed: ${error.message}`);
  const row = data as BookingRow | null;
  if (!row || row.status !== "confirmed") throw new Error("No such booking.");
  if (row.google_event_id) return { calendar: true, email: true };

  const owner = calendarUserId();
  const [event, email] = await Promise.allSettled([
    insertEvent(owner, "primary", eventFor(row)),
    sendBookingEmail(owner, bookingId, row, "REQUEST"),
  ]);
  if (email.status === "rejected") console.error("[booking] confirmation email failed", bookingId, email.reason);
  if (event.status === "rejected") {
    console.error("[booking] calendar event failed", bookingId, event.reason);
  } else {
    const { error: saveErr } = await db.from("demo_bookings").update({ google_event_id: event.value.id }).eq("id", bookingId);
    if (saveErr) console.error("[booking] event id not saved", bookingId, saveErr.message);
  }
  return { calendar: event.status === "fulfilled", email: email.status === "fulfilled" };
}
