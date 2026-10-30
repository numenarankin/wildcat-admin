import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const update = vi.fn();
const availability = vi.fn();
const insertEvent = vi.fn();

vi.mock("@/lib/admin/gtm/db", () => ({
  getGtmDb: () => ({ rpc, from: () => ({ update: (v: unknown) => ({ eq: (_c: string, id: string) => update(v, id) }) }) }),
}));
vi.mock("@/lib/admin/booking/availability", () => ({ availability, calendarUserId: () => "owner" }));
vi.mock("@/lib/admin/google/calendar/client", () => ({ insertEvent }));

const { confirmBooking, eventFor } = await import("./confirm");

// Monday 2026-11-02, 10:00am CST = 16:00Z; two hours later is 18:00Z.
const input = {
  name: "Jo Field",
  email: "jo@acme.com",
  company: "Acme Oil",
  address: "1 Main St, Midland, TX",
  lat: 32,
  lng: -102,
  start: "2026-11-02T16:00:00.000Z",
  notes: "",
};
const open = [{ date: "2026-11-02", slots: ["2026-11-02T16:00:00.000Z"] }];

beforeEach(() => {
  update.mockResolvedValue({ error: null });
  insertEvent.mockResolvedValue({ id: "g1" });
});

describe("confirmBooking", () => {
  it("re-checks the slot on its Central day, books it for two hours, and invites the visitor", async () => {
    availability.mockResolvedValue(open);
    rpc.mockResolvedValue({ data: "b1", error: null });

    expect(await confirmBooking(input)).toEqual({ ok: true, id: "b1", start: input.start, end: "2026-11-02T18:00:00.000Z", calendar: true });
    expect(availability).toHaveBeenCalledWith({ lat: 32, lng: -102 }, expect.any(Number), ["2026-11-02"]);
    expect(rpc).toHaveBeenCalledWith("book_demo", expect.objectContaining({ p_starts_at: input.start, p_ends_at: "2026-11-02T18:00:00.000Z" }));
    expect(insertEvent).toHaveBeenCalledWith("owner", "primary", expect.objectContaining({ attendees: [{ email: "jo@acme.com", displayName: "Jo Field" }] }));
    expect(update).toHaveBeenCalledWith({ google_event_id: "g1" }, "b1");
  });

  it("refuses a slot that is no longer open, without writing", async () => {
    availability.mockResolvedValue([{ date: "2026-11-02", slots: [] }]);
    expect(await confirmBooking(input)).toEqual({ ok: false, reason: "taken" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("checks again once when another booking landed that day, then books", async () => {
    availability.mockResolvedValue(open);
    rpc.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: "b2", error: null });
    expect(await confirmBooking(input)).toMatchObject({ ok: true, id: "b2" });
    expect(availability).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second refusal", async () => {
    availability.mockResolvedValue(open);
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await confirmBooking(input)).toEqual({ ok: false, reason: "taken" });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps the booking when the calendar write fails", async () => {
    availability.mockResolvedValue(open);
    rpc.mockResolvedValue({ data: "b3", error: null });
    insertEvent.mockRejectedValue(new Error("Google down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await confirmBooking(input)).toMatchObject({ ok: true, id: "b3", calendar: false });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("eventFor", () => {
  it("titles the event with the company, places it at the office and lists the visitor", () => {
    expect(eventFor({ ...input, notes: " Bring the pumper. " }, "2026-11-02T18:00:00.000Z")).toEqual({
      summary: "WildcatIQ demo: Acme Oil",
      location: "1 Main St, Midland, TX",
      description: "Name: Jo Field\nEmail: jo@acme.com\nCompany: Acme Oil\n\nNotes:\nBring the pumper.",
      start: { dateTime: "2026-11-02T16:00:00.000Z", timeZone: "America/Chicago" },
      end: { dateTime: "2026-11-02T18:00:00.000Z", timeZone: "America/Chicago" },
      attendees: [{ email: "jo@acme.com", displayName: "Jo Field" }],
    });
  });
});
