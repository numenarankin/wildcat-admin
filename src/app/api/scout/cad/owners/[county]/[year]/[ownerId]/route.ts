import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getOwner } from "@/lib/scout/cad-queries";

export const runtime = "nodejs";

/**
 * One mineral owner's dossier. Keyed by county AND tax year because the roll's
 * owner ids are per county roll; the same person in two counties is two ids.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ county: string; year: string; ownerId: string }> }
) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const { county, year, ownerId } = await ctx.params;
  // Owner ids on the Archer roll are digits; the key is text, so allow the
  // characters a CAD might use, but never a path's worth of them.
  if (!/^\d{3}$/.test(county) || !/^\d{4}$/.test(year) || !/^[\w.-]{1,40}$/.test(ownerId)) {
    return Response.json({ error: "bad owner key" }, { status: 400 });
  }
  try {
    const owner = await getOwner(county, Number(year), ownerId);
    if (!owner) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(owner);
  } catch (err) {
    console.error("[scout/cad/owner]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
