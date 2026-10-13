// Operator-grain disposition — the SLOW path, deliberately separate.
//
// An operator's disposition spans every lease they have ever held across 48.5M
// rows. It is the one query that cannot be served inside the dossier's budget,
// so the Disposition tab fetches it on open and nothing else pays for it.
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getOperatorDisposition } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";
export const maxDuration = 60;

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
    return Response.json(await getOperatorDisposition(operator));
  } catch (err) {
    console.error("[scout/rrc/operator/disposition]", err);
    return Response.json({ error: "disposition unavailable" }, { status: 502 });
  }
}
