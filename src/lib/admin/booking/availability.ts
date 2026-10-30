import "server-only";
import { getGtmDb } from "@/lib/admin/gtm/db";
import { listEvents } from "@/lib/admin/google/calendar/client";
import type { GoogleEvent } from "@/lib/admin/google/calendar/types";
import { driveTimes, geocode, type Point } from "@/lib/admin/booking/mapbox";
import { HOME_ADDRESS, addDaysKey, bookingDates, centralInstant, openSlots, type Busy } from "@/lib/admin/booking/rules";

/**
 * Open demo slots for a visitor's office (docs/plans/demo-booking.md): the
 * owner's primary Google calendar and the confirmed bookings are the busy
 * list, and each busy event's place is driven to and from the visitor.
 */

export interface BookingRow {
  id: string;
  starts_at: string;
  ends_at: string;
  office_lat: number;
  office_lng: number;
  google_event_id: string | null;
}

/** A busy stretch and where the owner is during it (null = home). */
export interface PlacedBusy {
  start: number;
  end: number;
  allDay: boolean;
  place: Point | null;
  /** A location that has to be geocoded first. */
  address: string | null;
}

export function calendarUserId(): string {
  const id = process.env.BOOKING_CALENDAR_USER_ID;
  if (!id) throw new Error("Booking not configured: set BOOKING_CALENDAR_USER_ID");
  return id;
}

/**
 * The events that keep the owner busy: Google events not shown as Free, not
 * cancelled and not declined, plus every confirmed booking. A booking's own
 * Google event is dropped in favour of the booking row, which has coordinates.
 */
export function busyFrom(events: readonly GoogleEvent[], bookings: readonly BookingRow[]): PlacedBusy[] {
  const booked = new Set(bookings.map((b) => b.google_event_id).filter(Boolean));
  const out: PlacedBusy[] = [];
  for (const e of events) {
    if (e.status === "cancelled" || e.transparency === "transparent" || booked.has(e.id)) continue;
    if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
    const address = e.location?.trim() || null;
    if (e.start.date && e.end.date) {
      out.push({ start: centralInstant(e.start.date, 0), end: centralInstant(e.end.date, 0), allDay: true, place: null, address });
    } else if (e.start.dateTime && e.end.dateTime) {
      out.push({ start: Date.parse(e.start.dateTime), end: Date.parse(e.end.dateTime), allDay: false, place: null, address });
    }
  }
  for (const b of bookings) {
    out.push({
      start: Date.parse(b.starts_at),
      end: Date.parse(b.ends_at),
      allDay: false,
      place: { lat: b.office_lat, lng: b.office_lng },
      address: null,
    });
  }
  return out;
}

/** Busy events placed and timed against the visitor. No location, or one that does not geocode, means home. */
export async function busyForVisitor(visitor: Point, busy: readonly PlacedBusy[]): Promise<Busy[]> {
  const home = await geocode(HOME_ADDRESS);
  if (!home) throw new Error("Home address did not geocode");
  const placed = await Promise.all(busy.map(async (b) => b.place ?? (b.address ? await geocode(b.address) : null) ?? home));

  const keyOf = (p: Point) => `${p.lat},${p.lng}`;
  const unique = [...new Map(placed.map((p) => [keyOf(p), p])).values()];
  const { to, from } = await driveTimes(visitor, unique);
  const index = new Map(unique.map((p, i) => [keyOf(p), i]));

  return busy.map((b, i) => {
    const j = index.get(keyOf(placed[i]))!;
    return { start: b.start, end: b.end, allDay: b.allDay, toVisitor: to[j], fromVisitor: from[j] };
  });
}

/** Everything busy in a date range, read live from Google and the bookings table. */
export async function readBusy(firstDate: string, lastDate: string): Promise<PlacedBusy[]> {
  const timeMin = new Date(centralInstant(firstDate, 0)).toISOString();
  const timeMax = new Date(centralInstant(addDaysKey(lastDate, 1), 0)).toISOString();
  const [events, bookings] = await Promise.all([
    listEvents(calendarUserId(), "primary", { timeMin, timeMax }),
    getGtmDb()
      .from("demo_bookings")
      .select("id, starts_at, ends_at, office_lat, office_lng, google_event_id")
      .eq("status", "confirmed")
      .lt("starts_at", timeMax)
      .gt("ends_at", timeMin)
      .then(({ data, error }) => {
        if (error) throw new Error(`Bookings read failed: ${error.message}`);
        return (data ?? []) as BookingRow[];
      }),
  ]);
  return busyFrom(events, bookings);
}

export interface DayOpen {
  date: string;
  /** Slot starts, ISO. */
  slots: string[];
}

/** Open slots for the visitor on each date (default: the whole booking window). */
export async function availability(visitor: Point, now: number, dates: string[] = bookingDates(now)): Promise<DayOpen[]> {
  if (!dates.length) return [];
  const busy = await busyForVisitor(visitor, await readBusy(dates[0], dates[dates.length - 1]));
  return dates.map((date) => ({ date, slots: openSlots(date, busy).map((s) => new Date(s).toISOString()) }));
}
