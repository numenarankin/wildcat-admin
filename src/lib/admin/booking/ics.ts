/**
 * The calendar file sent with a booking's confirmation (and, from admin, its
 * cancellation): one 30-minute event, the visitor as attendee. The UID is the
 * booking's id, so a cancellation replaces the same event in their calendar.
 * The landing keeps a copy of this file (wildcatiq-landing src/lib/book/ics.ts); keep the two the same.
 */

/** Who books, sends and signs every demo email. */
export const ORGANIZER = { name: "Rankin Poage", email: "rankin@wildcatiq.ai", phone: "817.217.6250" };

export interface IcsEvent {
  bookingId: string;
  start: string;
  end: string;
  address: string;
  attendee: { name: string; email: string };
  method: "REQUEST" | "CANCEL";
}

const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets continue on the next line after a space (RFC 5545 3.1). */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function buildIcs(e: IcsEvent, now = new Date().toISOString()): string {
  const cancel = e.method === "CANCEL";
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//WildcatIQ//Demo booking//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${e.method}`,
    "BEGIN:VEVENT",
    `UID:${e.bookingId}@wildcatiq.ai`,
    `DTSTAMP:${stamp(now)}`,
    `SEQUENCE:${cancel ? 1 : 0}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(e.end)}`,
    "SUMMARY:WildcatIQ demo",
    `LOCATION:${escape(e.address)}`,
    `ORGANIZER;CN=${escape(ORGANIZER.name)}:mailto:${ORGANIZER.email}`,
    `ATTENDEE;CN=${escape(e.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=${cancel ? "NEEDS-ACTION" : "ACCEPTED"};RSVP=FALSE:mailto:${e.attendee.email}`,
    `STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
