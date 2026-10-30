import "server-only";
import { getGtmDb } from "@/lib/admin/gtm/db";
import { CALENDAR_API } from "@/lib/admin/google/calendar/client";
import { GoogleApiError, googleFetch, googleUrl } from "@/lib/admin/google/fetch";
import { calendarUserId } from "@/lib/admin/booking/calendar";

/**
 * Cancels a booking: the row is marked cancelled, which frees the slot, then
 * its Google event is deleted with the visitor emailed. An event already gone
 * from Google counts as deleted.
 */
export async function cancelBooking(id: string): Promise<{ calendar: boolean }> {
  const db = getGtmDb();
  const { data, error } = await db
    .from("demo_bookings")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("status", "confirmed")
    .select("google_event_id")
    .maybeSingle();
  if (error) throw new Error(`Cancel failed: ${error.message}`);
  if (!data) throw new Error("That booking is already cancelled.");
  if (!data.google_event_id) return { calendar: true };

  try {
    const url = `${CALENDAR_API}calendars/primary/events/${encodeURIComponent(data.google_event_id)}`;
    await googleFetch<null>(calendarUserId(), "calendar", googleUrl(url, { sendUpdates: "all" }), { method: "DELETE" });
    return { calendar: true };
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return { calendar: true };
    console.error("[booking] calendar delete failed", id, err);
    return { calendar: false };
  }
}
