import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleEvent } from "@/lib/admin/google/calendar/types";
import { busyForVisitor, busyFrom, type BookingRow } from "./availability";
import { clearGeocodeCache } from "./mapbox";

vi.mock("@/lib/admin/gtm/db", () => ({ getGtmDb: vi.fn() }));
vi.mock("@/lib/admin/google/calendar/client", () => ({ listEvents: vi.fn() }));

const event = (over: Partial<GoogleEvent>): GoogleEvent => ({
  id: "e1",
  etag: "x",
  start: { dateTime: "2026-11-02T15:00:00Z" },
  end: { dateTime: "2026-11-02T17:00:00Z" },
  ...over,
});

describe("busyFrom", () => {
  it("keeps a timed event with its location", () => {
    expect(busyFrom([event({ location: " 1 Main St, Fort Worth " })], [])).toEqual([
      { start: Date.parse("2026-11-02T15:00:00Z"), end: Date.parse("2026-11-02T17:00:00Z"), allDay: false, place: null, address: "1 Main St, Fort Worth" },
    ]);
  });

  it("drops Free, cancelled and declined events", () => {
    const declined = event({ attendees: [{ email: "me@x.com", self: true, responseStatus: "declined" }] });
    expect(busyFrom([event({ transparency: "transparent" }), event({ status: "cancelled" }), declined], [])).toEqual([]);
  });

  it("blocks an all-day event from Central midnight to Central midnight", () => {
    // 2026-11-02 00:00 CST = 06:00Z; end date is exclusive.
    const [b] = busyFrom([event({ start: { date: "2026-11-02" }, end: { date: "2026-11-03" } })], []);
    expect(b.allDay).toBe(true);
    expect(new Date(b.start).toISOString()).toBe("2026-11-02T06:00:00.000Z");
    expect(new Date(b.end).toISOString()).toBe("2026-11-03T06:00:00.000Z");
  });

  it("uses a booking's own row, not its Google event", () => {
    const booking: BookingRow = {
      id: "b1",
      starts_at: "2026-11-02T15:00:00Z",
      ends_at: "2026-11-02T17:00:00Z",
      office_lat: 32.75,
      office_lng: -97.33,
      google_event_id: "e1",
    };
    expect(busyFrom([event({ id: "e1", location: "somewhere" })], [booking])).toEqual([
      { start: Date.parse(booking.starts_at), end: Date.parse(booking.ends_at), allDay: false, place: { lat: 32.75, lng: -97.33 }, address: null },
    ]);
  });
});

describe("busyForVisitor", () => {
  const HOME = { lat: 32.93, lng: -97.25 };
  const OFFICE = { lat: 32.0, lng: -98.0 };
  const VISITOR = { lat: 31.0, lng: -97.0 };
  let calls: string[];

  beforeEach(() => {
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN = "tok";
    clearGeocodeCache();
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.includes("/geocode/")) {
          const q = url.searchParams.get("q") ?? "";
          const hit = q.includes("Secretariat") ? HOME : q.includes("Office") ? OFFICE : null;
          return Response.json({ features: hit ? [{ geometry: { coordinates: [hit.lng, hit.lat] } }] : [] });
        }
        // Matrix: visitor first, then the unique places in order. Seconds.
        const coords = url.pathname.split("/").pop()!.split(";");
        const n = coords.length;
        const durations = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : (i + j) * 600 + 1)));
        return Response.json({ code: "Ok", durations });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("drives from each event's place, treating no location or an unknown one as home", async () => {
    const busy = await busyForVisitor(VISITOR, [
      { start: 1, end: 2, allDay: false, place: null, address: "Office Tower" },
      { start: 3, end: 4, allDay: false, place: null, address: null },
      { start: 5, end: 6, allDay: false, place: null, address: "Nowhere at all" },
    ]);
    // Unique places: Office (index 1), home (index 2). Durations (i+j)*600+1 s, rounded up to 5 min:
    // office <-> visitor: 601 s -> 15 min; home <-> visitor: 1201 s -> 25 min.
    expect(busy.map((b) => [b.toVisitor, b.fromVisitor])).toEqual([
      [15, 15],
      [25, 25],
      [25, 25],
    ]);
    // One matrix request for two unique places.
    expect(calls.filter((c) => c.includes("directions-matrix"))).toHaveLength(1);
  });
});
