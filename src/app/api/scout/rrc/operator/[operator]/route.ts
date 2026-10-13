import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getOperatorDossier } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ operator: string }> }
) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const { operator } = await ctx.params;
  if (!/^\d{6}$/.test(operator)) {
    return Response.json({ error: "bad operator number" }, { status: 400 });
  }
  try {
    const dossier = await getOperatorDossier(operator);
    if (!dossier) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(dossier);
  } catch (err) {
    console.error("[scout/rrc/operator]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
