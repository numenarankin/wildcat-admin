import "server-only";
import { getGtmDb } from "@/lib/admin/gtm/db";
import { CALENDAR_API } from "@/lib/admin/google/calendar/client";
import { GoogleApiError, googleFetch, googleUrl } from "@/lib/admin/google/fetch";
import { calendarUserId } from "@/lib/admin/booking/calendar";
import { sendBookingEmail, type BookingEmailRow } from "@/lib/admin/booking/emails";

interface CancelledRow extends BookingEmailRow {
  google_event_id: string | null;
}

/**
 * Cancels a booking: the row is marked cancelled, which frees the slot, the
 * visitor is emailed from the owner's Gmail with a calendar file that removes
 * the event, and the owner's Google event is deleted quietly. An event
 * already gone from Google counts as deleted.
 */
export async function cancelBooking(id: string): Promise<{ calendar: boolean; email: boolean }> {
  const db = getGtmDb();
  const { data, error } = await db
    .from("demo_bookings")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("status", "confirmed")
    .select("name, email, office_address, starts_at, ends_at, google_event_id")
    .maybeSingle();
  if (error) throw new Error(`Cancel failed: ${error.message}`);
  const row = data as CancelledRow | null;
  if (!row) throw new Error("That booking is already cancelled.");

  let email = true;
  try {
    await sendBookingEmail(calendarUserId(), id, row, "CANCEL");
  } catch (err) {
    console.error("[booking] cancellation email failed", id, err);
    email = false;
  }

  if (!row.google_event_id) return { calendar: true, email };
  try {
    const url = `${CALENDAR_API}calendars/primary/events/${encodeURIComponent(row.google_event_id)}`;
    await googleFetch<null>(calendarUserId(), "calendar", googleUrl(url, { sendUpdates: "none" }), { method: "DELETE" });
    return { calendar: true, email };
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return { calendar: true, email };
    console.error("[booking] calendar delete failed", id, err);
    return { calendar: false, email };
  }
}
