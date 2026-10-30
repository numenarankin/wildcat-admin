import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MATRIX_MAX, clearGeocodeCache, driveTimes, geocode } from "./mapbox";

const requests: URL[] = [];

beforeEach(() => {
  process.env.MAPBOX_SECRET_TOKEN = "tok";
  clearGeocodeCache();
  requests.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("geocode", () => {
  it("reads the first US match as lat/lng, and asks once per address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: URL) => {
        requests.push(u);
        return Response.json({ features: [{ geometry: { coordinates: [-97.25, 32.93] } }] });
      }),
    );
    expect(await geocode("805 Secretariat Trail, Keller, TX")).toEqual({ lat: 32.93, lng: -97.25 });
    expect(await geocode("  805 secretariat trail,  keller, tx ")).toEqual({ lat: 32.93, lng: -97.25 });
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("country")).toBe("us");
  });

  it("answers null when nothing matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ features: [] })));
    expect(await geocode("qqqq")).toBeNull();
  });
});

describe("driveTimes", () => {
  it("batches 24 places a request with the visitor first, both directions, null for no route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: URL) => {
        requests.push(u);
        const n = u.pathname.split("/").pop()!.split(";").length;
        // Visitor -> place j: 300 s (5 min). Place i -> visitor: 900 s (15 min), except the 2nd place: no route.
        const durations = Array.from({ length: n }, (_, i) =>
          Array.from({ length: n }, (_, j) => (i === j ? 0 : i === 0 ? 300 : j === 0 ? (i === 2 ? null : 900) : 60)),
        );
        return Response.json({ code: "Ok", durations });
      }),
    );
    const places = Array.from({ length: 30 }, (_, i) => ({ lat: 30 + i / 100, lng: -97 }));
    const { to, from } = await driveTimes({ lat: 31, lng: -97 }, places);

    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.pathname.split("/").pop()!.split(";").length)).toEqual([MATRIX_MAX, 7]);
    expect(requests[0].pathname.split("/").pop()!.split(";")[0]).toBe("-97,31");
    expect(to).toHaveLength(30);
    expect(from.every((m) => m === 5)).toBe(true);
    // Place 1 in each batch (index 1 and 25 overall) has no route back.
    expect(to[1]).toBeNull();
    expect(to[25]).toBeNull();
    expect(to.filter((m) => m === 15)).toHaveLength(28);
  });

  it("throws when Mapbox refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "InvalidInput" })));
    await expect(driveTimes({ lat: 31, lng: -97 }, [{ lat: 30, lng: -97 }])).rejects.toThrow(/InvalidInput/);
  });
});
