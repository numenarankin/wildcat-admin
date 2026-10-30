import "server-only";
import { getGtmDb } from "@/lib/admin/gtm/db";
import { insertEvent } from "@/lib/admin/google/calendar/client";
import type { GoogleEventInput } from "@/lib/admin/google/calendar/types";
import { availability, calendarUserId } from "@/lib/admin/booking/availability";
import { MEETING_MINUTES, ZONE, centralDate } from "@/lib/admin/booking/rules";

/**
 * Books a demo (docs/plans/demo-booking.md, "Database" and "Google Calendar"):
 * the slot is checked again, the row goes in through `book_demo`, then the
 * event goes on the owner's calendar with the visitor invited, which is the
 * confirmation email they are promised.
 */

export interface BookingInput {
  name: string;
  email: string;
  company: string;
  address: string;
  lat: number;
  lng: number;
  /** Slot start, ISO. */
  start: string;
  notes: string;
}

export type BookingResult =
  | { ok: true; id: string; start: string; end: string; calendar: boolean }
  | { ok: false; reason: "taken" };

/** App and database clocks may differ a little; checking from earlier only refuses more. */
const CLOCK_SLACK_MS = 10_000;

export function eventFor(input: BookingInput, end: string): GoogleEventInput {
  return {
    summary: `WildcatIQ demo: ${input.company}`,
    location: input.address,
    description: [
      `Name: ${input.name}`,
      `Email: ${input.email}`,
      `Company: ${input.company}`,
      input.notes.trim() ? `\nNotes:\n${input.notes.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    start: { dateTime: input.start, timeZone: ZONE },
    end: { dateTime: end, timeZone: ZONE },
    attendees: [{ email: input.email, displayName: input.name }],
  };
}

export async function confirmBooking(input: BookingInput): Promise<BookingResult> {
  const startMs = Date.parse(input.start);
  const start = new Date(startMs).toISOString();
  const end = new Date(startMs + MEETING_MINUTES * 60_000).toISOString();
  const date = centralDate(startMs);
  const db = getGtmDb();

  // A booking that lands on the same day between our check and our insert is
  // refused by book_demo; check again once with it in the busy list.
  let id: string | null = null;
  for (let attempt = 0; attempt < 2 && !id; attempt++) {
    const checkedAt = new Date(Date.now() - CLOCK_SLACK_MS).toISOString();
    const [day] = await availability({ lat: input.lat, lng: input.lng }, Date.now(), [date]);
    if (!day?.slots.includes(start)) return { ok: false, reason: "taken" };
    const { data, error } = await db.rpc("book_demo", {
      p_name: input.name,
      p_email: input.email,
      p_company: input.company,
      p_office_address: input.address,
      p_office_lat: input.lat,
      p_office_lng: input.lng,
      p_starts_at: start,
      p_ends_at: end,
      p_notes: input.notes,
      p_checked_at: checkedAt,
    });
    if (error) throw new Error(`book_demo failed: ${error.message}`);
    id = (data as string | null) ?? null;
  }
  if (!id) return { ok: false, reason: "taken" };

  // The booking stands even if Google refuses; the GTM page lists it without an event.
  let calendar = false;
  try {
    const event = await insertEvent(calendarUserId(), "primary", eventFor({ ...input, start }, end));
    const { error } = await db.from("demo_bookings").update({ google_event_id: event.id }).eq("id", id);
    if (error) console.error("[booking] event id not saved", id, error.message);
    calendar = true;
  } catch (err) {
    console.error("[booking] calendar event failed", id, err);
  }
  return { ok: true, id, start, end, calendar };
}
