import "server-only";
import { roundDrive } from "@/lib/admin/booking/rules";

/**
 * Mapbox geocoding and driving times for the booking check
 * (docs/plans/demo-booking.md, "The availability check").
 */

export interface Point {
  lat: number;
  lng: number;
}

/** The Matrix API's driving profile takes at most 25 coordinates a request. */
export const MATRIX_MAX = 25;

function token(): string {
  const t = process.env.MAPBOX_SECRET_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!t) throw new Error("Mapbox not configured: set MAPBOX_SECRET_TOKEN");
  return t;
}

/** Geocoded addresses, kept for the life of the server instance. */
const geocodeCache = new Map<string, Point | null>();

/** The best US match for an address, or null when nothing matches. */
export async function geocode(address: string): Promise<Point | null> {
  const q = address.trim().replace(/\s+/g, " ");
  if (!q) return null;
  const k = q.toLowerCase();
  if (geocodeCache.has(k)) return geocodeCache.get(k)!;
  const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
  url.search = new URLSearchParams({ q, country: "us", limit: "1", access_token: token() }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox geocoding failed (${res.status})`);
  const body = (await res.json()) as { features?: { geometry?: { coordinates?: [number, number] } }[] };
  const c = body.features?.[0]?.geometry?.coordinates;
  const point = c ? { lng: c[0], lat: c[1] } : null;
  geocodeCache.set(k, point);
  return point;
}

export function clearGeocodeCache(): void {
  geocodeCache.clear();
}

/**
 * Drive minutes between the visitor and each place, both ways, rounded up to
 * 5 minutes; null where there is no road route. One Matrix request per 24
 * places, the visitor first in each.
 */
export async function driveTimes(visitor: Point, places: readonly Point[]): Promise<{ to: (number | null)[]; from: (number | null)[] }> {
  const to: (number | null)[] = [];
  const from: (number | null)[] = [];
  for (let i = 0; i < places.length; i += MATRIX_MAX - 1) {
    const batch = places.slice(i, i + MATRIX_MAX - 1);
    const coords = [visitor, ...batch].map((p) => `${p.lng},${p.lat}`).join(";");
    const url = new URL(`https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coords}`);
    url.search = new URLSearchParams({ annotations: "duration", access_token: token() }).toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Mapbox matrix failed (${res.status})`);
    const body = (await res.json()) as { code?: string; durations?: (number | null)[][] };
    if (body.code !== "Ok" || !body.durations) throw new Error(`Mapbox matrix failed (${body.code ?? "no durations"})`);
    const d = body.durations;
    batch.forEach((_, j) => {
      const fromPlace = d[j + 1]?.[0];
      const toPlace = d[0]?.[j + 1];
      to.push(fromPlace == null ? null : roundDrive(fromPlace));
      from.push(toPlace == null ? null : roundDrive(toPlace));
    });
  }
  return { to, from };
}
