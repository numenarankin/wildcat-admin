import { bookingAuth } from "@/lib/admin/booking/auth";
import { availability } from "@/lib/admin/booking/availability";
import { geocode } from "@/lib/admin/booking/mapbox";
import { availabilityInput } from "@/lib/admin/booking/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open demo slots for an office address (docs/plans/demo-booking.md). Called
 * only by the landing's /api/book/availability with the shared secret.
 * Coordinates from a picked address suggestion are used as given; a typed
 * address is geocoded, and one that does not geocode answers `{ error: "address" }`.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = bookingAuth(req);
  if (auth === "unconfigured") return new Response("Not configured", { status: 503 });
  if (auth === "unauthorized") return new Response("Unauthorized", { status: 401 });

  const parsed = availabilityInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "input" }, { status: 400 });
  const { address, lat, lng } = parsed.data;

  try {
    const place = lat !== undefined && lng !== undefined ? { lat, lng } : await geocode(address);
    if (!place) return Response.json({ error: "address" });
    const days = await availability(place, Date.now());
    return Response.json({ place: { address, ...place }, days });
  } catch (err) {
    console.error("[booking] availability failed", err);
    return Response.json({ error: "unavailable" }, { status: 502 });
  }
}
