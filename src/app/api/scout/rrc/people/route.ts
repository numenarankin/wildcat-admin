// People in the RRC mirror: the Person search on /scout, and the affiliations
// behind one name.
//
// One route, two reads of the same resource: `?q=` searches names, `?name=`
// returns that person's operators. `name` is a query parameter rather than a
// path segment because officer names carry commas, periods and the occasional
// slash ("O'BRIEN, J.R."), which a path key would have to survive twice.
//
// GATED on every request. `rrc-db.ts` carries no authorization of its own.
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getPerson, searchPeople } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const name = params.get("name")?.trim() ?? "";
  const q = params.get("q")?.trim() ?? "";

  try {
    if (name) return Response.json({ person: await getPerson(name) });
    if (q.length < 2) return Response.json({ hits: [] });
    return Response.json({ hits: await searchPeople(q) });
  } catch (err) {
    console.error("[scout/rrc/people]", err);
    return Response.json({ error: "people lookup failed" }, { status: 502 });
  }
}
