import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleEvent } from "@/lib/admin/google/calendar/types";

const maybeSingle = vi.fn();
const updates: unknown[] = [];
const insertEvent = vi.fn();

vi.mock("@/lib/admin/gtm/db", () => ({
  getGtmDb: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      update: (v: unknown) => ({ eq: async () => (updates.push(v), { error: null }) }),
    }),
  }),
}));
vi.mock("@/lib/admin/google/calendar/client", () => ({ insertEvent, listEvents: vi.fn() }));

const { busyEvents, createBookingEvent, eventFor } = await import("./calendar");

process.env.BOOKING_CALENDAR_USER_ID = "owner";

const event = (over: Partial<GoogleEvent>): GoogleEvent => ({
  id: "e1",
  etag: "x",
  start: { dateTime: "2026-11-02T09:00:00-06:00" },
  end: { dateTime: "2026-11-02T11:00:00-06:00" },
  ...over,
});

const row = {
  name: "Jo Field",
  email: "jo@acme.com",
  company: "Acme Oil",
  office_address: "1 Main St, Midland, TX",
  starts_at: "2026-11-02T16:00:00+00:00",
  ends_at: "2026-11-02T16:30:00+00:00",
  notes: " Bring the pumper. ",
  status: "confirmed",
  google_event_id: null as string | null,
};

beforeEach(() => {
  updates.length = 0;
});

describe("busyEvents", () => {
  it("gives timed events as UTC instants with their location", () => {
    expect(busyEvents([event({ location: " 1 Main St " })])).toEqual([
      { id: "e1", start: "2026-11-02T15:00:00.000Z", end: "2026-11-02T17:00:00.000Z", startDate: null, endDate: null, location: "1 Main St" },
    ]);
  });

  it("gives all-day events as dates", () => {
    expect(busyEvents([event({ start: { date: "2026-11-02" }, end: { date: "2026-11-03" } })])).toEqual([
      { id: "e1", start: null, end: null, startDate: "2026-11-02", endDate: "2026-11-03", location: null },
    ]);
  });

  it("drops Free, cancelled and declined events", () => {
    const declined = event({ attendees: [{ email: "me@x.com", self: true, responseStatus: "declined" }] });
    expect(busyEvents([event({ transparency: "transparent" }), event({ status: "cancelled" }), declined])).toEqual([]);
  });
});

describe("createBookingEvent", () => {
  it("puts the booking on the calendar and saves the event id", async () => {
    maybeSingle.mockResolvedValue({ data: row, error: null });
    insertEvent.mockResolvedValue({ id: "g1" });
    expect(await createBookingEvent("b1")).toEqual({ eventId: "g1" });
    expect(insertEvent).toHaveBeenCalledWith("owner", "primary", eventFor(row));
    expect(updates).toEqual([{ google_event_id: "g1" }]);
  });

  it("leaves a booking that already has an event alone", async () => {
    maybeSingle.mockResolvedValue({ data: { ...row, google_event_id: "g0" }, error: null });
    expect(await createBookingEvent("b1")).toEqual({ eventId: "g0" });
    expect(insertEvent).not.toHaveBeenCalled();
  });

  it("refuses a missing or cancelled booking", async () => {
    maybeSingle.mockResolvedValue({ data: { ...row, status: "cancelled" }, error: null });
    await expect(createBookingEvent("b1")).rejects.toThrow(/No such booking/);
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(createBookingEvent("b1")).rejects.toThrow(/No such booking/);
  });
});

describe("eventFor", () => {
  it("titles with the company, places at the office, 30 minutes, no guests (Google emails nobody)", () => {
    expect(eventFor(row)).toEqual({
      summary: "WildcatIQ demo: Acme Oil",
      location: "1 Main St, Midland, TX",
      description: "Name: Jo Field\nEmail: jo@acme.com\nCompany: Acme Oil\n\nNotes:\nBring the pumper.",
      start: { dateTime: "2026-11-02T16:00:00.000Z", timeZone: "America/Chicago" },
      end: { dateTime: "2026-11-02T16:30:00.000Z", timeZone: "America/Chicago" },
    });
  });
});
