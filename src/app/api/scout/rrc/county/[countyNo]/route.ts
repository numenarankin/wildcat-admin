import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getCountyProfile } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ countyNo: string }> }
) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const { countyNo } = await ctx.params;
  // RRC county codes are three digits. `getCountyProfile` runs the reference
  // through `resolveCounty`, which also accepts a name, but this route is only
  // ever called with a code from a row the UI already holds -- so the narrower
  // check is the honest one, and it keeps a free-text county name from reaching
  // a query that scans 76.5M rows on a miss.
  if (!/^\d{1,3}$/.test(countyNo)) {
    return Response.json({ error: "bad county number" }, { status: 400 });
  }
  try {
    const profile = await getCountyProfile(countyNo);
    if (!profile) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(profile);
  } catch (err) {
    console.error("[scout/rrc/county]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
