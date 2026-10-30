import "server-only";
import { buildMessage, toRaw } from "@/lib/admin/google/gmail/compose";
import { sendMessage } from "@/lib/admin/google/gmail/send";
import { buildIcs, ORGANIZER } from "@/lib/admin/booking/ics";

/**
 * The visitor's booking emails, sent from the owner's own Gmail (his
 * connected account), so they arrive from Google with his name and photo and
 * sit in his Sent folder. Each carries a calendar file whose UID is the
 * booking id, so the cancellation removes what the confirmation added.
 */

export interface BookingEmailRow {
  name: string;
  email: string;
  office_address: string;
  starts_at: string;
  ends_at: string;
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
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const signature = `<p>${html(ORGANIZER.name)}<br>WildcatIQ<br>${html(ORGANIZER.phone)}</p>`;

export function confirmationEmail(row: BookingEmailRow): { subject: string; html: string } {
  const at = when.format(new Date(row.starts_at));
  return {
    subject: `Your WildcatIQ demo: ${at}`,
    html: `<p>Hi ${html(firstName(row.name))},</p>
<p>Thanks for making time for us. Your demo is on the calendar. I'm looking forward to coming out and showing you WildcatIQ.</p>
<p><strong>When:</strong> ${html(at)} (30 minutes)<br><strong>Where:</strong> ${html(row.office_address)}</p>
<p>I've attached a calendar invite. If anything comes up or you need to move it, just reply here or give me a call.</p>
<p>See you then,</p>
${signature}`,
  };
}

export function cancellationEmail(row: BookingEmailRow): { subject: string; html: string } {
  const at = when.format(new Date(row.starts_at));
  return {
    subject: `Cancelled: your WildcatIQ demo, ${at}`,
    html: `<p>Hi ${html(firstName(row.name))},</p>
<p>Your WildcatIQ demo on ${html(at)} has been cancelled.</p>
<p>If you'd like to find another time, just reply here or give me a call.</p>
<p>Regards,</p>
${signature}`,
  };
}

/** The whole message as Gmail receives it. `boundary` is passed in so tests are exact. */
export function bookingMessage(id: string, row: BookingEmailRow, method: "REQUEST" | "CANCEL", boundary: string): string {
  const mail = method === "REQUEST" ? confirmationEmail(row) : cancellationEmail(row);
  const ics = buildIcs({
    bookingId: id,
    start: row.starts_at,
    end: row.ends_at,
    address: row.office_address,
    attendee: { name: row.name, email: row.email },
    method,
  });
  return buildMessage(
    {
      recipients: { to: [row.email], cc: [], bcc: [] },
      subject: mail.subject,
      html: mail.html,
      attachments: [
        {
          filename: method === "REQUEST" ? "invite.ics" : "cancel.ics",
          mimeType: `text/calendar; method=${method}`,
          bytes: new TextEncoder().encode(ics),
        },
      ],
    },
    boundary,
  );
}

export async function sendBookingEmail(userId: string, id: string, row: BookingEmailRow, method: "REQUEST" | "CANCEL"): Promise<void> {
  const boundary = `wc${crypto.randomUUID().replace(/-/g, "")}`;
  await sendMessage(userId, toRaw(bookingMessage(id, row, method, boundary)));
}
