import { beforeEach, describe, expect, it, vi } from "vitest";

const maybeSingle = vi.fn();
const updates: unknown[] = [];
const googleFetch = vi.fn();
const sendBrevoEmail = vi.fn();

vi.mock("@/lib/admin/gtm/db", () => ({
  getGtmDb: () => ({
    from: () => ({
      update: (v: unknown) => {
        updates.push(v);
        const chain = { eq: () => chain, select: () => ({ maybeSingle }) };
        return chain;
      },
    }),
  }),
}));
vi.mock("@/lib/admin/booking/calendar", () => ({ calendarUserId: () => "owner" }));
vi.mock("@/lib/admin/google/fetch", async () => {
  class GoogleApiError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  return {
    GoogleApiError,
    googleFetch,
    googleUrl: (base: string, p: Record<string, string>) => `${base}?${new URLSearchParams(p)}`,
  };
});
vi.mock("@/lib/email/brevo", () => ({ sendBrevoEmail }));
vi.mock("@/lib/admin/google/calendar/client", () => ({ CALENDAR_API: "https://www.googleapis.com/calendar/v3/" }));

const { cancelBooking } = await import("./cancel");
const { GoogleApiError } = await import("@/lib/admin/google/fetch");

const row = {
  name: "Jo Field",
  email: "jo@acme.com",
  office_address: "1 Main St, Midland, TX",
  starts_at: "2026-11-02T16:00:00+00:00",
  ends_at: "2026-11-02T16:30:00+00:00",
  google_event_id: "g1" as string | null,
};

beforeEach(() => {
  updates.length = 0;
  sendBrevoEmail.mockResolvedValue({ messageId: "m1" });
});

describe("cancelBooking", () => {
  it("marks the booking cancelled, emails the visitor a cancelling calendar file, and deletes the owner's event quietly", async () => {
    maybeSingle.mockResolvedValue({ data: row, error: null });
    googleFetch.mockResolvedValue(null);
    expect(await cancelBooking("b1")).toEqual({ calendar: true, email: true });
    expect(updates).toEqual([{ status: "cancelled" }]);
    expect(googleFetch).toHaveBeenCalledWith(
      "owner",
      "calendar",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/g1?sendUpdates=none",
      { method: "DELETE" },
    );
    const mail = sendBrevoEmail.mock.calls[0][0];
    expect(mail.to).toEqual([{ email: "jo@acme.com", name: "Jo Field" }]);
    // 16:00Z on Nov 2 is 10:00am CST.
    expect(mail.subject).toBe("Cancelled: your WildcatIQ demo, Monday, November 2 at 10:00 AM CST");
    const ics = Buffer.from(mail.attachments[0].content, "base64").toString();
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("UID:b1@wildcatiq.ai");
    expect(ics).toContain("DTSTART:20261102T160000Z");
    expect(ics).toContain("DTEND:20261102T163000Z");
  });

  it("still cancels when the email fails, and says so", async () => {
    maybeSingle.mockResolvedValue({ data: row, error: null });
    googleFetch.mockResolvedValue(null);
    sendBrevoEmail.mockRejectedValue(new Error("Brevo down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await cancelBooking("b1")).toEqual({ calendar: true, email: false });
  });

  it("refuses a booking that is already cancelled", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(cancelBooking("b1")).rejects.toThrow(/already cancelled/);
    expect(googleFetch).not.toHaveBeenCalled();
  });

  it("skips Google when the booking never reached the calendar", async () => {
    maybeSingle.mockResolvedValue({ data: { ...row, google_event_id: null }, error: null });
    expect(await cancelBooking("b1")).toEqual({ calendar: true, email: true });
    expect(googleFetch).not.toHaveBeenCalled();
  });

  it("counts an event already gone from Google as deleted, and reports any other failure", async () => {
    maybeSingle.mockResolvedValue({ data: row, error: null });
    googleFetch.mockRejectedValueOnce(new GoogleApiError("gone", 410, null));
    expect(await cancelBooking("b1")).toEqual({ calendar: true, email: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    googleFetch.mockRejectedValueOnce(new GoogleApiError("boom", 500, null));
    expect(await cancelBooking("b1")).toEqual({ calendar: false, email: true });
  });
});
