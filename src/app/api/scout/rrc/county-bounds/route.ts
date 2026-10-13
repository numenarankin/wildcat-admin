import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getCountyBounds } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

/**
 * Where a set of counties is, as a box (`?codes=301,389`), for landing a
 * Recon deep link on an area. See `getCountyBounds`.
 */
export async function GET(req: Request) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const codes = (new URL(req.url).searchParams.get("codes") ?? "")
    .split(",")
    .filter((c) => /^\d{1,3}$/.test(c))
    .map(Number);
  if (!codes.length) return Response.json({ error: "no counties" }, { status: 400 });
  try {
    const bounds = await getCountyBounds(codes);
    if (!bounds) return Response.json({ error: "not found" }, { status: 404 });
    // County extents do not move.
    return Response.json(bounds, { headers: { "Cache-Control": "private, max-age=86400" } });
  } catch (err) {
    console.error("[scout/rrc/county-bounds]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
