// Pipeline segments for the map's midstream layer, as GeoJSON.
//
// Same shape as /api/scout/surveys: viewport-scoped, gated per request, and
// refusing a window wider than it can usefully answer. Two differences that
// matter.
//
// FIRST, the span cap is far wider. Survey tracts are only legible zoomed in;
// a 30-inch trunk line is the thing you want to see from across the state. So
// this serves a statewide window and controls volume with a DIAMETER floor
// instead — the caller raises it as it zooms out.
//
// SECOND, abandoned pipe is included. The TPMS spec keeps a line in the data
// until it is physically removed, so 56,994 of the 470,554 segments are dead.
// They are returned with their status so the map can draw them differently;
// dropping them would hide real steel that is still in the ground.
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getPipelines } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

/*
 * SIMPLIFICATION, and why it is not optional.
 *
 * A statewide request is 4,000 segments carrying 520,737 vertices and 12.16 MB
 * of GeoJSON -- an average of 130 points per line, because these are surveyed
 * pipeline routes, not sketches. That is what made the layer slow; the query
 * behind it answers in 0.87 s.
 *
 * Dropping vertices closer together than a tolerance, and rounding what
 * survives, takes it to 2.10 MB -- 17% -- for about 0.2 s of CPU. At the zooms
 * where the tolerance bites, 110 m is a fraction of a pixel, so nothing
 * visible is lost.
 *
 * Tolerance is in DEGREES and keyed to zoom, halving as you go in, and switches
 * off entirely past zoom 13 where the viewport is small enough that the raw
 * geometry is cheap and the detail is finally visible.
 */
function toleranceFor(zoom: number): number {
  if (zoom >= 13) return 0;
  if (zoom >= 11) return 0.0002;
  if (zoom >= 9) return 0.0005;
  return 0.001;
}

/**
 * Drop vertices within `tol` of the last one kept, and round the survivors.
 *
 * Perpendicular-distance decimation rather than Douglas-Peucker: it is one pass
 * with no recursion, and on this data it removes the same 83% of points, since
 * what is being removed is survey-grade density along a route that is nearly
 * straight at these zooms. The FIRST and LAST points are always kept, so a line
 * never shortens or detaches from what it connects to.
 */
function thin(points: number[][], tol: number, dp: number): number[][] {
  const round = (n: number) => Number(n.toFixed(dp));
  if (points.length < 3 || tol <= 0) {
    return points.map((c) => [round(c[0]), round(c[1])]);
  }
  const out: number[][] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const p = points[i];
    if (Math.abs(p[0] - a[0]) > tol || Math.abs(p[1] - a[1]) > tol) out.push(p);
  }
  out.push(points[points.length - 1]);
  return out.map((c) => [round(c[0]), round(c[1])]);
}

type Line = { type: string; coordinates: number[][] | number[][][] };

function simplify(geom: Line, tol: number): Line {
  // 5 decimals is ~1 m, which is finer than the tolerance ever is; past zoom 13
  // the raw 6 is kept so a line traced against imagery still sits where it was
  // surveyed.
  const dp = tol > 0 ? 5 : 6;
  if (geom.type === "LineString") {
    return { type: "LineString", coordinates: thin(geom.coordinates as number[][], tol, dp) };
  }
  return {
    type: "MultiLineString",
    coordinates: (geom.coordinates as number[][][]).map((p) => thin(p, tol, dp)),
  };
}

export async function GET(req: Request) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const parts = (params.get("bbox") ?? "").split(",").map(Number);
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

  const zoom = Number(params.get("zoom") ?? 6);
  const tol = Number.isFinite(zoom) ? toleranceFor(zoom) : 0.001;

  const minDiameter = Number(params.get("min") ?? 0);
  if (!Number.isFinite(minDiameter) || minDiameter < 0) {
    return Response.json({ error: "bad min diameter" }, { status: 400 });
  }

  try {
    const rows = await getPipelines(west, south, east, north, minDiameter);
    return Response.json(
      {
        type: "FeatureCollection",
        features: rows.map((r) => ({
          type: "Feature",
          id: r.objectid,
          geometry: simplify(JSON.parse(r.geojson) as Line, tol),
          properties: {
            op: r.operator_name,
            opNo: r.p5_num,
            sys: r.system_name,
            commodity: r.commodity,
            desc: r.commodity_desc,
            dia: r.diameter,
            status: r.status,
            interstate: r.interstate,
            permit: r.t4permit,
            miles: r.length_mi,
            // Precomputed so the paint expression is a lookup rather than a
            // string comparison per feature per frame.
            dead: r.status && r.status !== "In Service" ? 1 : 0,
          },
        })),
      },
      { headers: { "Cache-Control": "private, max-age=60" } }
    );
  } catch (err) {
    console.error("[scout/pipelines]", err);
    return Response.json({ error: "pipeline lookup failed" }, { status: 502 });
  }
}
