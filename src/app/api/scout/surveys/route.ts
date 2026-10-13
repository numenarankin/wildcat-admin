// Survey/abstract tracts for the map's property-line layer, as GeoJSON.
//
// VIEWPORT-SCOPED BY DESIGN. There are 311,158 tracts in Texas and no useful
// answer to "give me all of them": the client asks only when it is zoomed past
// the threshold where lines are readable, and this refuses windows wider than
// `MAX_SPAN` so a hand-written request cannot ask for the state.
//
// GeoJSON rather than vector tiles because the geometry is already GeoJSON text
// in the mirror (no PostGIS to encode MVT with), the bbox index answers in tens
// of milliseconds, and a zoomed-in viewport holds a few hundred tracts — small
// enough that a tile pipeline would be machinery without a payoff.
//
// GATED on every request. `rrc-db.ts` carries no authorization of its own.
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getSurveyPolygons } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

/**
 * Widest window served, in degrees.
 *
 * Roughly a 55 km box at Texas latitudes — a little beyond the zoom the client
 * starts asking at, so a slightly stale viewport still answers instead of
 * flashing empty, while a statewide request (13 degrees wide) is refused.
 */
const MAX_SPAN = 0.6;

export async function GET(req: Request) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const raw = new URL(req.url).searchParams.get("bbox") ?? "";
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return Response.json(
      { error: "bbox=west,south,east,north required" },
      { status: 400 }
    );
  }
  const [west, south, east, north] = parts;
  if (east <= west || north <= south) {
    return Response.json({ error: "empty bbox" }, { status: 400 });
  }
  if (east - west > MAX_SPAN || north - south > MAX_SPAN) {
    return Response.json(
      { error: `bbox too large; max ${MAX_SPAN} degrees per side` },
      { status: 422 }
    );
  }

  try {
    const rows = await getSurveyPolygons(west, south, east, north);
    return Response.json(
      {
        type: "FeatureCollection",
        features: rows.map((r) => ({
          type: "Feature",
          id: r.objectid,
          // Parsed, not interpolated: these strings come back as GeoJSON
          // objects, and re-serialising the collection around raw text would
          // mean hand-assembling JSON.
          geometry: JSON.parse(r.geojson),
          properties: {
            label: r.abstract_label,
            abstract: r.abstract_number,
            survey: r.survey_name,
            block: r.block_number,
            acres: r.acres,
          },
        })),
      },
      // The survey grid changes when the RRC republishes the layer, which is
      // not often; a minute of client caching absorbs the pan-and-return case
      // without holding a stale grid through a refresh.
      { headers: { "Cache-Control": "private, max-age=60" } }
    );
  } catch (err) {
    console.error("[scout/surveys]", err);
    return Response.json({ error: "survey lookup failed" }, { status: 502 });
  }
}
