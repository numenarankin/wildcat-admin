import { beforeEach, describe, expect, it, vi } from "vitest";

const maybeSingle = vi.fn();
const updates: unknown[] = [];
const googleFetch = vi.fn();

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
vi.mock("@/lib/admin/google/calendar/client", () => ({ CALENDAR_API: "https://www.googleapis.com/calendar/v3/" }));

const { cancelBooking } = await import("./cancel");
const { GoogleApiError } = await import("@/lib/admin/google/fetch");

beforeEach(() => {
  updates.length = 0;
});

describe("cancelBooking", () => {
  it("marks the booking cancelled and deletes its event, emailing the visitor", async () => {
    maybeSingle.mockResolvedValue({ data: { google_event_id: "g1" }, error: null });
    googleFetch.mockResolvedValue(null);
    expect(await cancelBooking("b1")).toEqual({ calendar: true });
    expect(updates).toEqual([{ status: "cancelled" }]);
    expect(googleFetch).toHaveBeenCalledWith(
      "owner",
      "calendar",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/g1?sendUpdates=all",
      { method: "DELETE" },
    );
  });

  it("refuses a booking that is already cancelled", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(cancelBooking("b1")).rejects.toThrow(/already cancelled/);
    expect(googleFetch).not.toHaveBeenCalled();
  });

  it("skips Google when the booking never reached the calendar", async () => {
    maybeSingle.mockResolvedValue({ data: { google_event_id: null }, error: null });
    expect(await cancelBooking("b1")).toEqual({ calendar: true });
    expect(googleFetch).not.toHaveBeenCalled();
  });

  it("counts an event already gone from Google as deleted, and reports any other failure", async () => {
    maybeSingle.mockResolvedValue({ data: { google_event_id: "g1" }, error: null });
    googleFetch.mockRejectedValueOnce(new GoogleApiError("gone", 410, null));
    expect(await cancelBooking("b1")).toEqual({ calendar: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    googleFetch.mockRejectedValueOnce(new GoogleApiError("boom", 500, null));
    expect(await cancelBooking("b1")).toEqual({ calendar: false });
  });
});
