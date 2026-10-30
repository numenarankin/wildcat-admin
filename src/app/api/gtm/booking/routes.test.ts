import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const availability = vi.fn();
const geocode = vi.fn();
const confirmBooking = vi.fn();

vi.mock("@/lib/admin/booking/availability", () => ({ availability }));
vi.mock("@/lib/admin/booking/mapbox", () => ({ geocode }));
vi.mock("@/lib/admin/booking/confirm", () => ({ confirmBooking }));

const { POST: availabilityPOST } = await import("./availability/route");
const { POST: confirmPOST } = await import("./confirm/route");

const req = (body: unknown, auth: string | null = "Bearer s3cret") =>
  new Request("http://admin/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.BOOKING_API_SECRET = "s3cret";
});
afterEach(() => {
  delete process.env.BOOKING_API_SECRET;
});

describe("booking routes", () => {
  it("refuse a missing or wrong secret, and answer 503 when none is set", async () => {
    expect((await availabilityPOST(req({ address: "x y z" }, null))).status).toBe(401);
    expect((await confirmPOST(req({}, "Bearer nope"))).status).toBe(401);
    delete process.env.BOOKING_API_SECRET;
    expect((await availabilityPOST(req({ address: "x y z" }))).status).toBe(503);
    expect(availability).not.toHaveBeenCalled();
  });

  it("answer an address that does not geocode with error: address", async () => {
    geocode.mockResolvedValue(null);
    expect(await (await availabilityPOST(req({ address: "nowhere at all" }))).json()).toEqual({ error: "address" });
  });

  it("use a picked suggestion's coordinates without geocoding", async () => {
    availability.mockResolvedValue([{ date: "2026-11-02", slots: [] }]);
    const res = await availabilityPOST(req({ address: "1 Main St", lat: 32, lng: -102 }));
    expect(await res.json()).toEqual({ place: { address: "1 Main St", lat: 32, lng: -102 }, days: [{ date: "2026-11-02", slots: [] }] });
    expect(geocode).not.toHaveBeenCalled();
  });

  it("refuse a malformed booking", async () => {
    expect((await confirmPOST(req({ name: "Jo", email: "not-an-email" }))).status).toBe(400);
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it("pass a valid booking through", async () => {
    confirmBooking.mockResolvedValue({ ok: false, reason: "taken" });
    const body = { name: "Jo", email: "jo@acme.com", company: "Acme", address: "1 Main St", lat: 32, lng: -102, start: "2026-11-02T16:00:00.000Z" };
    expect(await (await confirmPOST(req(body))).json()).toEqual({ ok: false, reason: "taken" });
    expect(confirmBooking).toHaveBeenCalledWith({ ...body, notes: "" });
  });
});
