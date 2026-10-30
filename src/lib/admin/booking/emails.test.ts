import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin/google/gmail/send", () => ({ sendMessage: vi.fn() }));
const { bookingMessage, cancellationEmail, confirmationEmail } = await import("./emails");

// Fri Nov 13 2026, 11:00am CST = 17:00Z; 30 minutes on paper.
const row = {
  name: "Jo Field",
  email: "jo@acme.com",
  office_address: "300 Throckmorton St, Fort Worth, TX 76102",
  starts_at: "2026-11-13T17:00:00+00:00",
  ends_at: "2026-11-13T17:30:00+00:00",
};

/** The base64 body of each MIME part, decoded. */
function parts(message: string): string[] {
  return message
    .split(/\r\n--[^\r\n]+/)
    .map((p) => p.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n/g, ""))
    .filter((b) => /^[A-Za-z0-9+/=]+$/.test(b))
    .map((b) => Buffer.from(b, "base64").toString("utf8"));
}

describe("booking emails", () => {
  it("confirmation: the agreed wording, signed by the owner", () => {
    const mail = confirmationEmail(row);
    expect(mail.subject).toBe("Your WildcatIQ demo: Friday, November 13 at 11:00 AM CST");
    expect(mail.html).toContain("<p>Hi Jo,</p>");
    expect(mail.html).toContain("Thanks for making time for us. Your demo is on the calendar. I'm looking forward to coming out and showing you WildcatIQ.");
    expect(mail.html).toContain("<strong>When:</strong> Friday, November 13 at 11:00 AM CST (30 minutes)<br><strong>Where:</strong> 300 Throckmorton St, Fort Worth, TX 76102");
    expect(mail.html).toContain("If anything comes up or you need to move it, just reply here or give me a call.");
    expect(mail.html).toContain("<p>See you then,</p>\n<p>Rankin Poage<br>WildcatIQ<br>817.217.6250</p>");
  });

  it("cancellation: generic, signed Regards", () => {
    const mail = cancellationEmail(row);
    expect(mail.subject).toBe("Cancelled: your WildcatIQ demo, Friday, November 13 at 11:00 AM CST");
    expect(mail.html).toContain("Your WildcatIQ demo on Friday, November 13 at 11:00 AM CST has been cancelled.");
    expect(mail.html).toContain("<p>Regards,</p>\n<p>Rankin Poage<br>WildcatIQ<br>817.217.6250</p>");
  });

  it("sends to the visitor with no From (Gmail stamps the owner), and a 30-minute calendar file", () => {
    const message = bookingMessage("b1", row, "REQUEST", "BOUNDARY");
    expect(message).toMatch(/^To: jo@acme\.com\r\n/);
    expect(message).not.toMatch(/^From:/m);
    expect(message).toContain('Content-Type: text/calendar; method=REQUEST; name="invite.ics"');
    const ics = parts(message).find((p) => p.startsWith("BEGIN:VCALENDAR"))!.replace(/\r\n /g, "");
    expect(ics).toContain("METHOD:REQUEST\r\n");
    expect(ics).toContain("UID:b1@wildcatiq.ai\r\n");
    expect(ics).toContain("DTSTART:20261113T170000Z\r\n");
    expect(ics).toContain("DTEND:20261113T173000Z\r\n");
    expect(ics).toContain("LOCATION:300 Throckmorton St\\, Fort Worth\\, TX 76102\r\n");
    expect(ics).toContain("ORGANIZER;CN=Rankin Poage:mailto:rankin@wildcatiq.ai\r\n");
    expect(ics).toContain("RSVP=FALSE:mailto:jo@acme.com\r\n");
  });

  it("cancels the same event: same UID, METHOD:CANCEL", () => {
    const message = bookingMessage("b1", row, "CANCEL", "BOUNDARY");
    expect(message).toContain('Content-Type: text/calendar; method=CANCEL; name="cancel.ics"');
    const ics = parts(message).find((p) => p.startsWith("BEGIN:VCALENDAR"))!;
    expect(ics).toContain("METHOD:CANCEL\r\n");
    expect(ics).toContain("STATUS:CANCELLED\r\n");
    expect(ics).toContain("UID:b1@wildcatiq.ai\r\n");
  });
});
