// Mineral owner search, for the map's Owner picker and the RRC browser.
//
// GATED on every request. `rrc-db.ts` carries no authorization of its own.
// One route for the search; the dossier is `[county]/[year]/[ownerId]`, because
// an owner id is only unique within one county's roll for one tax year.
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { searchOwners } from "@/lib/scout/cad-queries";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json({ hits: [] });
  try {
    return Response.json({ hits: await searchOwners(q) });
  } catch (err) {
    console.error("[scout/cad/owners]", err);
    return Response.json({ error: "owner search failed" }, { status: 502 });
  }
}
