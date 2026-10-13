import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getLeaseDossier } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

/**
 * `district` here is PDQ's INTERNAL code (01-11, 13, 14), not the RRC district
 * label a user sees. District 09 is PDQ 13. See lib/scout/rrc-districts.ts —
 * mixing the two silently returns a different lease.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ og: string; district: string; lease: string }> }
) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const { og, district, lease } = await ctx.params;
  if (!/^[OG]$/.test(og) || !/^\d{2}$/.test(district) || !/^\w{1,6}$/.test(lease)) {
    return Response.json({ error: "bad lease key" }, { status: 400 });
  }
  try {
    const dossier = await getLeaseDossier(og, district, lease);
    if (!dossier) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(dossier);
  } catch (err) {
    console.error("[scout/rrc/lease]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
