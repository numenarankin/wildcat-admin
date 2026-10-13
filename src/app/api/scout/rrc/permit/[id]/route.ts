import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getPermitByDoc, getPermitByNumber } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

/**
 * One drilling permit, for a Recon deep link (`/recon?permit=` or
 * `?permitNo=`, the links in a Recon alert email).
 *
 * `?by=number` reads `id` as a 7-digit permit number; otherwise it is the
 * application's `universal_doc_no`. The answer carries the same properties a
 * permit dot on the map carries, so the panel renders it the same way.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const byNumber = new URL(req.url).searchParams.get("by") === "number";
  if (byNumber ? !/^\d{1,7}$/.test(id) : !/^[A-Za-z0-9-]{1,24}$/.test(id)) {
    return Response.json({ error: "bad permit id" }, { status: 400 });
  }
  try {
    const permit = byNumber
      ? await getPermitByNumber(id.padStart(7, "0"))
      : await getPermitByDoc(id);
    if (!permit) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(permit);
  } catch (err) {
    console.error("[scout/rrc/permit]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
