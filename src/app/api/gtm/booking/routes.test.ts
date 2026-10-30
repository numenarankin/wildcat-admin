import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readBusy = vi.fn();
const handleNewBooking = vi.fn();
vi.mock("@/lib/admin/booking/calendar", () => ({ readBusy, handleNewBooking }));

const { POST: busyPOST } = await import("./busy/route");
const { POST: eventPOST } = await import("./booked/route");

const req = (body: unknown, auth: string | null = "Bearer s3cret") =>
  new Request("http://admin/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
const range = { timeMin: "2026-11-01T05:00:00.000Z", timeMax: "2026-12-15T06:00:00.000Z" };

beforeEach(() => {
  process.env.BOOKING_API_SECRET = "s3cret";
});
afterEach(() => {
  delete process.env.BOOKING_API_SECRET;
});

describe("booking routes", () => {
  it("refuse a missing or wrong secret, and answer 503 when none is set", async () => {
    expect((await busyPOST(req(range, null))).status).toBe(401);
    expect((await eventPOST(req({ bookingId: crypto.randomUUID() }, "Bearer nope"))).status).toBe(401);
    delete process.env.BOOKING_API_SECRET;
    expect((await busyPOST(req(range))).status).toBe(503);
    expect(readBusy).not.toHaveBeenCalled();
    expect(handleNewBooking).not.toHaveBeenCalled();
  });

  it("read the busy events for a range", async () => {
    readBusy.mockResolvedValue([]);
    expect(await (await busyPOST(req(range))).json()).toEqual({ events: [] });
    expect(readBusy).toHaveBeenCalledWith(range.timeMin, range.timeMax);
  });

  it("hand a new booking over only by its id", async () => {
    expect((await eventPOST(req({ bookingId: "not-a-uuid" }))).status).toBe(400);
    const id = crypto.randomUUID();
    handleNewBooking.mockResolvedValue({ calendar: true, email: true });
    expect(await (await eventPOST(req({ bookingId: id }))).json()).toEqual({ calendar: true, email: true });
    expect(handleNewBooking).toHaveBeenCalledWith(id);
  });
});
