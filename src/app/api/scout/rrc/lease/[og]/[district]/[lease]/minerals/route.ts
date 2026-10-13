import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getLeaseMinerals } from "@/lib/scout/cad-queries";

export const runtime = "nodejs";

/**
 * The Minerals tab's data, fetched when the tab opens rather than folded into
 * the lease dossier: the dossier is the slow modal, a tab whose data is
 * independent should not fail with it, and the tab is hidden for every county
 * without a roll, so the dossier would pay a read for nothing.
 *
 * `district` is PDQ's internal code, as on the parent route. `county` is the
 * county the caller attributes the lease to (the dossier's dominant county).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ og: string; district: string; lease: string }> }
) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const { og, district, lease } = await ctx.params;
  const county = new URL(req.url).searchParams.get("county")?.trim() ?? "";
  if (!/^[OG]$/.test(og) || !/^\d{2}$/.test(district) || !/^\w{1,6}$/.test(lease)) {
    return Response.json({ error: "bad lease key" }, { status: 400 });
  }
  if (!/^\d{1,3}$/.test(county)) {
    return Response.json({ error: "bad county" }, { status: 400 });
  }
  try {
    const minerals = await getLeaseMinerals(og, district, lease, county);
    // A county with no roll is a 404, so the tab can say "not covered" rather
    // than "could not load".
    if (!minerals) return Response.json({ error: "not covered" }, { status: 404 });
    return Response.json(minerals);
  } catch (err) {
    console.error("[scout/rrc/lease/minerals]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
