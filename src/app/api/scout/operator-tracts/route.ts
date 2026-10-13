import { NextResponse } from "next/server";
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { hasRrcDb, rrcQuery } from "@/lib/scout/rrc-db";

/**
 * The survey tracts an operator's wells sit in, as one GeoJSON payload.
 *
 * The RRC publishes no lease boundaries, so a fleet's footprint is drawn the
 * same way `/leases` draws one lease's: the land-grant survey/abstract tracts
 * its wells fall inside. A tract is bigger than the lease inside it, which is
 * why this is a highlight under the dots rather than an outline of holdings.
 *
 * WHOLE FLEET, ONE REQUEST, rather than re-querying per viewport. Measured on
 * the two largest operators in Texas: 10,790 wells to 2,065 tracts in 347ms and
 * 0.5MB; 22,038 wells to 2,308 tracts in 1,150ms and 1.9MB. Tract count barely
 * grows with well count because a fleet's wells cluster into the same surveys,
 * so a per-viewport version would pay a round trip on every pan to redraw
 * substantially the same shapes.
 */
interface TractRow {
  objectid: number;
  abstract_number: string | null;
  survey_name: string | null;
  geojson: string | null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const operators = (url.searchParams.get("op") ?? "")
    .split(",")
    .map((n) => n.replace(/\D/g, "").padStart(6, "0"))
    .filter((n) => n.length === 6)
    .slice(0, 10);
  // A dossier map knows its own wells and asks by API; the page map focuses a
  // whole fleet and asks by operator. Same tracts, same shading, one route.
  const apis = (url.searchParams.get("api") ?? "")
    .split(",")
    .map((a) => a.replace(/\D/g, "").slice(-8))
    .filter((a) => a.length === 8)
    .slice(0, 5000);
  if ((operators.length === 0 && apis.length === 0) || !hasRrcDb()) {
    return NextResponse.json({ type: "FeatureCollection", features: [] });
  }

  // The route-handler form, not `assertPlatformAdmin`. Same gate, but it returns a
  // response instead of throwing, and `nav.test.ts` greps for this call by
  // name so an ungated Scout route cannot be added quietly.
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  try {
    /*
     * `&&` against a zero-area box, NOT `bbox @> point`. The two return the same
     * rows, but `@>` with a point on the right matches no GiST operator class
     * for `box` and drops to a seq scan of 311k polygons per point.
     *
     * On-schedule only, matching the dots: an operator's focus layer draws the
     * wells it runs today, so the tracts have to be the same set or the fill and
     * the dots would disagree.
     */
    const rows = apis.length
      ? await rrcQuery<TractRow>(
          `select distinct p.objectid, p.abstract_number, p.survey_name, p.geojson
             from rrc.well_location l
             join rrc.survey_polygon p
               on p.bbox && box(point(l.lon, l.lat), point(l.lon, l.lat))
            where l.api_number = any($1)
              and l.lat is not null and l.lon is not null
              and p.geojson is not null`,
          [apis]
        )
      : await rrcQuery<TractRow>(
          `select distinct p.objectid, p.abstract_number, p.survey_name, p.geojson
             from rrc.wellbore wb
             join rrc.well_location l on l.api_number = wb.api_number
             join rrc.survey_polygon p
               on p.bbox && box(point(l.lon, l.lat), point(l.lon, l.lat))
            where wb.operator_number = any($1)
              and wb.on_schedule = 'Y'
              and l.lat is not null and l.lon is not null
              and p.geojson is not null`,
          [operators]
        );

    const features = [];
    for (const row of rows) {
      let geometry: unknown;
      try {
        geometry = JSON.parse(row.geojson as string);
      } catch {
        // A tract we cannot parse is one we do not draw, not a failed request.
        continue;
      }
      features.push({
        type: "Feature" as const,
        id: row.objectid,
        geometry,
        properties: {
          abstract: row.abstract_number ?? "",
          surveyName: row.survey_name ?? "",
        },
      });
    }
    return NextResponse.json({ type: "FeatureCollection", features });
  } catch (error) {
    // The highlight is context: without it the dots still answer the question.
    console.error("[scout] operator tracts failed", error);
    return NextResponse.json({ type: "FeatureCollection", features: [] });
  }
}
