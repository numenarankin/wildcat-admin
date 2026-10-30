import "server-only";
import { getGtmDb } from "@/lib/admin/gtm/db";
import { CALENDAR_API } from "@/lib/admin/google/calendar/client";
import { GoogleApiError, googleFetch, googleUrl } from "@/lib/admin/google/fetch";
import { calendarUserId } from "@/lib/admin/booking/calendar";
import { buildIcs, ORGANIZER } from "@/lib/admin/booking/ics";
import { sendBrevoEmail } from "@/lib/email/brevo";

interface CancelledRow {
  name: string;
  email: string;
  office_address: string;
  starts_at: string;
  ends_at: string;
  google_event_id: string | null;
}

const when = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The visitor's cancellation, with a calendar file that removes the event their confirmation added. */
export async function sendCancellation(id: string, row: CancelledRow): Promise<void> {
  const at = when.format(new Date(row.starts_at));
  const first = row.name.trim().split(/\s+/)[0] || row.name;
  const ics = buildIcs({
    bookingId: id,
    start: row.starts_at,
    end: row.ends_at,
    address: row.office_address,
    attendee: { name: row.name, email: row.email },
    method: "CANCEL",
  });
  await sendBrevoEmail({
    sender: { email: ORGANIZER.email, name: ORGANIZER.name },
    to: [{ email: row.email, name: row.name }],
    subject: `Cancelled: your WildcatIQ demo, ${at}`,
    textContent: [
      `Hi ${first},`,
      "",
      `Your WildcatIQ demo on ${at} has been cancelled.`,
      "",
      "If you'd like to find another time, just reply here or give me a call.",
      "",
      "Regards,",
      "",
      ORGANIZER.name,
      "WildcatIQ",
      ORGANIZER.phone,
    ].join("\n"),
    htmlContent: `<p>Hi ${html(first)},</p>
<p>Your WildcatIQ demo on ${html(at)} has been cancelled.</p>
<p>If you'd like to find another time, just reply here or give me a call.</p>
<p>Regards,</p>
<p>${html(ORGANIZER.name)}<br>WildcatIQ<br>${html(ORGANIZER.phone)}</p>`,
    attachments: [{ name: "cancel.ics", content: Buffer.from(ics).toString("base64") }],
  });
}

/**
 * Cancels a booking: the row is marked cancelled, which frees the slot, the
 * visitor is emailed, and the owner's Google event is deleted. An event
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
    await sendCancellation(id, row);
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
