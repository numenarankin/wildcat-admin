/**
 * Which Texas county a point lies in, against the Census county outlines in
 * `public/tx-counties.json` (properties `code` = the RRC county code, the
 * same numbering as `COUNTY_NAMES`). Pure, so it can be checked by hand.
 */

type Ring = [number, number][];

export interface CountyFeature {
  properties: { code: number; name: string };
  geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
}

/** Even-odd ray cast: inside the outer ring and outside every hole. */
function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lng: number, lat: number, rings: Ring[]): boolean {
  if (!rings.length || !inRing(lng, lat, rings[0])) return false;
  return !rings.slice(1).some((hole) => inRing(lng, lat, hole));
}

/** The RRC county code the point falls in, or null outside Texas. */
export function countyAt(lng: number, lat: number, features: CountyFeature[]): number | null {
  for (const f of features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (polys.some((rings) => inPolygon(lng, lat, rings))) return f.properties.code;
  }
  return null;
}
