// Search across the RRC mirror: operators, leases, fields, wellbore lease names.
//
// GATED on every request. `rrc-db.ts` carries no authorization of its own, and
// this returns the full operator list given a broad enough term.
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { search } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json({ hits: [] });

  try {
    return Response.json({ hits: await search(q) });
  } catch (err) {
    console.error("[scout/rrc/search]", err);
    return Response.json({ error: "search failed" }, { status: 502 });
  }
}
