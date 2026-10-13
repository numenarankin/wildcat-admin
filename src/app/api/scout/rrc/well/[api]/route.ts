import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getWellDossier } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ api: string }> }
) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const { api } = await ctx.params;
  // API numbers are the 8-digit RRC form; reject anything else rather than
  // letting it reach the database.
  if (!/^\d{8}$/.test(api)) {
    return Response.json({ error: "bad API number" }, { status: 400 });
  }
  try {
    const dossier = await getWellDossier(api);
    if (!dossier) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(dossier);
  } catch (err) {
    console.error("[scout/rrc/well]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
