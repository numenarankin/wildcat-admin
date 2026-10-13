/**
 * Scout's spatial selection core: the shapes a user draws, and what they select.
 *
 * A radius around one or several wells, a draggable quadrilateral and a freehand
 * lasso are ONE build, because they differ only in how the ring is produced
 * ([scout-prospecting-gaps.md §4](../../../docs/plans/scout-prospecting-gaps.md)).
 * Everything after that point is shared, and this module is that shared part:
 * ring generation, the SQL predicate, the client-side hit test, lasso
 * simplification, and the union dedupe. Pure, no imports, no I/O, so both halves
 * (the browser preview and the server query) run the same geometry.
 *
 * ## Why native `point` and not PostGIS
 *
 * Measured on the live mirror 2026-08-21: `pg_extension` holds only
 * `pg_buffercache`, `pg_stat_statements`, `pg_trgm` and `plpgsql`. There is no
 * PostGIS, so no `ST_Within` and no geography type. What there IS is better for
 * this job anyway: `rrc.well_location.pt` is a native Postgres `point` with a
 * GiST index (`well_location_pt_gist`), all 1,378,966 rows populated, and
 * `where pt <@ $1::polygon` plans as an Index Only Scan. A 0.4 x 0.4 degree box
 * over Midland answers in 4 ms with zero heap fetches. `<@` is real containment,
 * not the index's bounding box: cutting that same box concave drops the notch's
 * wells out of the answer.
 *
 * `pt` is `(lon, lat)`, x then y, verified against the row's own `lon`/`lat`
 * columns. Every ring in this module is therefore `[lon, lat]`, in that order,
 * which is also GeoJSON's order and mapbox-gl's.
 *
 * ## The one place planar degrees are NOT good enough
 *
 * Postgres `point` and `polygon` are PLANAR and their unit is the degree. For a
 * shape the user drew on screen that is exactly right: the shape IS a set of
 * screen positions, and the question is which wells are under it. For a RADIUS
 * it is wrong, because a radius is a distance on the ground, and a degree of
 * longitude is shorter than a degree of latitude by cos(latitude). At 32 N, the
 * Midland Basin, that factor is 0.848, so a "10 mile" circle drawn as a
 * lat/lon square is a visible east/west-squashed ellipse and reaches only 8.5
 * miles east and west. `circleRing` applies the correction; nothing else here
 * needs to, because nothing else here is measured in miles.
 */

/** `[lon, lat]`, x then y, matching `rrc.well_location.pt`, GeoJSON and mapbox-gl. */
export type LonLat = [lon: number, lat: number];

/**
 * A radius around a point. It stays a CIRCLE in the model and becomes a ring
 * only when drawn or queried, so "10 miles from this well" survives as that
 * statement rather than as 64 anonymous vertices that nobody can edit or
 * re-centre (plan §4.1).
 */
export type CircleShape = {
  kind: "circle";
  lat: number;
  lon: number;
  miles: number;
};

/** A drawn quadrilateral or a simplified lasso. Open ring: do not repeat the first vertex. */
export type PolygonShape = { kind: "polygon"; ring: LonLat[] };

export type Shape = CircleShape | PolygonShape;

/** The shape of a focus well this module needs. Structurally `FocusWell`. */
export type LocatedWell = { api: number; lng: number; lat: number };

/**
 * Mean earth radius in miles, the SAME constant the existing radius search
 * already uses for its great-circle test (`rrc-queries.ts`, `3958.7613 *
 * acos(...)`). Sharing it is what lets the two paths reconcile: plan §4 names
 * `findWells({lat, lon, radiusMi})` as the oracle for the new spatial path, and
 * an oracle computed on a different earth is not an oracle.
 */
export const EARTH_RADIUS_MI = 3958.7613;

/** 69.0933 miles. Spherical, so 0.15% long against WGS-84's 68.99 at 32 N, which is 79 ft on a ten-mile circle. */
export const MILES_PER_DEG_LAT = (Math.PI * EARTH_RADIUS_MI) / 180;

/**
 * 64 vertices for a circle, the count plan §4.1 names.
 *
 * An inscribed n-gon falls short of its circle by r * (1 - cos(pi/n)) at the
 * edge midpoints: 0.12% of the radius at n = 64, which is 63 ft on a 10 mile
 * circle and 159 ft on a 25 mile one. RRC surface coordinates are not that good
 * (`well_location.reliability` exists precisely because many are digitised off
 * plats), so the polygon is inside the mirror's own coordinate noise. Doubling
 * to 128 would buy 47 of those 63 ft and double the literal, which is the wrong
 * trade for a GiST probe. Going down to 32 costs 253 ft, which starts to be
 * visible as flat spots on the drawn ring at basin zoom.
 *
 * Multiple of 4 on purpose: vertex 0 is due north and vertices 16/32/48 are due
 * east/south/west, so the circle is EXACTLY `miles` in the four cardinal
 * directions and the shortfall lives only between them.
 */
export const CIRCLE_STEPS = 64;

/**
 * Douglas-Peucker tolerance as a fraction of the drawn shape's larger side,
 * used when `simplifyRing` is called without one.
 *
 * Relative and not absolute, because a lasso around a whole county and a lasso
 * around one section are both "the shape I drew" and a fixed degree tolerance
 * would flatten the second into a triangle. 0.0015 is roughly one pixel on a
 * 700 px map when the lasso spans the viewport, which is below what a hand can
 * steer. On a 0.4 degree lasso over Midland that is 0.0006 degrees, about 220 ft.
 */
export const SIMPLIFY_FRACTION = 0.0015;

/**
 * Slack on the on-the-line test in `pointInRing`, in degrees. 1e-12 degrees is
 * about 0.1 micron: far below any real coordinate, far above the rounding of a
 * cross product of numbers around 100.
 */
const BOUNDARY_EPS = 1e-12;

function assertFinite(n: number, what: string): void {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`geo-shapes: ${what} must be a finite number, got ${String(n)}`);
  }
}

/**
 * A ring of `steps` vertices `miles` from (lat, lon) ON THE GROUND.
 *
 * Built in the same planar degree space the Postgres containment test uses,
 * rather than by walking a great circle, so that the ring means exactly what
 * `pt <@ polygon` will measure. In that space the circle is an ellipse: the
 * lat semi-axis is `miles / 69.0933` and the lon semi-axis is that over
 * cos(lat). At 32 N and 10 miles this is 0.1447 degrees north/south against
 * 0.1707 east/west.
 *
 * The cos correction is taken at the CENTRE latitude and held for the whole
 * ring. Over the 0.145 degrees a ten-mile circle spans, cos varies by 0.16%,
 * so the top of the circle is about 85 ft narrower than it should be. That is
 * the same order as the 63 ft polygon shortfall and an order below the
 * coordinates' own accuracy.
 *
 * Vertex 0 is due north and the ring runs clockwise on screen; Postgres does
 * not care about winding for containment.
 */
export function circleRing(
  lat: number,
  lon: number,
  miles: number,
  steps: number = CIRCLE_STEPS
): LonLat[] {
  assertFinite(lat, "circle lat");
  assertFinite(lon, "circle lon");
  assertFinite(miles, "circle miles");
  if (miles <= 0) throw new Error(`geo-shapes: circle miles must be positive, got ${miles}`);
  if (Math.abs(lat) > 85) {
    // cos(lat) goes to zero at the pole and the lon semi-axis goes to infinity
    // with it. Texas is 25.8 N to 36.5 N, so this can only be a bad coordinate,
    // most likely a [lat, lon] pair passed as [lon, lat].
    throw new Error(`geo-shapes: circle lat ${lat} is outside the range this planar approximation holds`);
  }
  if (!Number.isInteger(steps) || steps < 8 || steps > 720) {
    throw new Error(`geo-shapes: circle steps must be an integer in 8..720, got ${steps}`);
  }

  const dLat = miles / MILES_PER_DEG_LAT;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);

  const ring: LonLat[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    ring.push([lon + dLon * Math.sin(t), lat + dLat * Math.cos(t)]);
  }
  return ring;
}

/** The ring a shape draws and queries as. A polygon is already one. */
export function shapeRing(shape: Shape, steps: number = CIRCLE_STEPS): LonLat[] {
  return shape.kind === "circle"
    ? circleRing(shape.lat, shape.lon, shape.miles, steps)
    : shape.ring;
}

/**
 * Render one coordinate.
 *
 * Rounded to 7 decimals, which is 1.1 cm of latitude, so the literal stays short
 * without moving anything. `String` switches to exponent notation below 1e-6
 * (`String(1e-7)` is `"1e-7"`); Postgres's float8 parser accepts that, but a
 * polygon literal is also read by humans in `explain` output and in these tests,
 * so it is spelled out.
 */
function fmt(n: number): string {
  const s = String(Math.round(n * 1e7) / 1e7);
  return s.includes("e") ? n.toFixed(7) : s;
}

/**
 * Validate a ring and drop the repetition Postgres does not need.
 *
 * Removes consecutive duplicate vertices INCLUDING the wrap-around pair, so a
 * GeoJSON-style closed ring (first vertex repeated last) and an open one both
 * arrive here and leave the same. Non-consecutive repeats are left alone: a
 * self-touching ring is a shape the user drew, not a defect to silently repair.
 */
function cleanRing(ring: readonly LonLat[]): LonLat[] {
  if (!Array.isArray(ring)) throw new Error("geo-shapes: ring must be an array");

  const pts: LonLat[] = [];
  for (let i = 0; i < ring.length; i++) {
    const v = ring[i];
    if (!Array.isArray(v) || v.length < 2) {
      throw new Error(`geo-shapes: ring vertex ${i} is not a [lon, lat] pair`);
    }
    const [lon, lat] = v;
    assertFinite(lon, `ring vertex ${i} lon`);
    assertFinite(lat, `ring vertex ${i} lat`);
    // A swapped pair is the failure this catches: in Texas [lat, lon] reads as
    // lon 31.9, lat -102.1, and lat -102.1 does not exist. Without this the
    // literal binds cleanly and returns zero wells, which looks like "no wells
    // here" rather than like a bug.
    if (lon < -180 || lon > 180) {
      throw new Error(`geo-shapes: ring vertex ${i} lon ${lon} is out of range; are lon and lat swapped?`);
    }
    if (lat < -90 || lat > 90) {
      throw new Error(`geo-shapes: ring vertex ${i} lat ${lat} is out of range; are lon and lat swapped?`);
    }
    pts.push([lon, lat]);
  }

  const out: LonLat[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
    else break;
  }
  return out;
}

/** Shoelace twice-area. Zero means every vertex is on one line. */
function twiceArea(ring: readonly LonLat[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum;
}

/**
 * The Postgres polygon literal, `((lon,lat),(lon,lat),...)`, for binding as
 * `$n::polygon`.
 *
 * Safe to bind because nothing but numbers ever reaches it: every coordinate is
 * checked finite and in range by `cleanRing`, and a non-number throws rather
 * than being stringified into the literal. No user-supplied STRING is ever
 * concatenated here, which is what makes it safe to build the literal as text
 * and pass it as a parameter.
 *
 * Degenerate rings throw instead of producing SQL. A ring with fewer than three
 * distinct vertices, or one whose vertices are all on a single line, is valid
 * `polygon` input that quietly contains almost nothing, and "the query ran and
 * found no wells" is the worst possible way for a dropped coordinate to
 * present itself.
 */
/**
 * Great-circle distance in miles, for turning a drag into a radius.
 *
 * The same spherical earth `circleRing` draws with, so a ring dragged to N
 * miles and a ring typed as N miles are the same ring rather than two answers
 * that differ by the projection.
 */
export function milesBetween(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function polygonLiteral(ring: readonly LonLat[]): string {
  const pts = cleanRing(ring);

  const distinct = new Set(pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`));
  if (distinct.size < 3) {
    throw new Error(
      `geo-shapes: a polygon needs 3 distinct vertices, got ${distinct.size}`
    );
  }
  // Exact zero, not a tolerance: a genuine sliver has a tiny nonzero area and
  // is still a shape the user meant to draw.
  if (twiceArea(pts) === 0) {
    throw new Error("geo-shapes: polygon vertices are collinear, so the shape has no area");
  }

  return `(${pts.map(([x, y]) => `(${fmt(x)},${fmt(y)})`).join(",")})`;
}

/**
 * The `where` fragment for a UNION of shapes: a well inside ANY shape is in.
 *
 * `bind` is the caller's parameter binder, the idiom `getFocusWells` already
 * uses (`const bind = (v) => { params.push(v); return $${params.length} }`), so
 * the literals land in `params` in the caller's own numbering.
 *
 * Returns null for an empty list, meaning NO SPATIAL CONSTRAINT AT ALL. Note
 * the asymmetry with `wellsInShapes`, which returns nothing for an empty list:
 * a query with no shapes is unrestricted, while a SELECTION with no shapes is
 * empty, because a selection is what the shapes contain. They are different
 * questions and the caller must not swap them.
 *
 * Identical shapes collapse to one term. Two circles the user dropped on the
 * same well would otherwise be two index probes returning the same rows.
 *
 * `column` is code, not input: it is the caller's own SQL identifier for the
 * point column, `l.pt` under `getFocusWells`'s `join rrc.well_location l`.
 */
export function shapePredicate(
  shapes: readonly Shape[],
  bind: (value: unknown) => string,
  column = "l.pt"
): string | null {
  if (shapes.length === 0) return null;

  const literals = [...new Set(shapes.map((s) => polygonLiteral(shapeRing(s))))];
  const terms = literals.map((lit) => `${column} <@ ${bind(lit)}::polygon`);
  return terms.length === 1 ? terms[0] : `(${terms.join(" or ")})`;
}

/** True when (lon, lat) lies on the segment a-b, within `BOUNDARY_EPS`. */
function onSegment(a: LonLat, b: LonLat, lon: number, lat: number): boolean {
  const cross = (b[0] - a[0]) * (lat - a[1]) - (b[1] - a[1]) * (lon - a[0]);
  // Scaled by the segment's own size so the test means the same thing for a
  // one-mile edge as for a one-degree one.
  const scale = 1 + Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
  if (Math.abs(cross) > BOUNDARY_EPS * scale) return false;
  return (
    lon >= Math.min(a[0], b[0]) - BOUNDARY_EPS &&
    lon <= Math.max(a[0], b[0]) + BOUNDARY_EPS &&
    lat >= Math.min(a[1], b[1]) - BOUNDARY_EPS &&
    lat <= Math.max(a[1], b[1]) + BOUNDARY_EPS
  );
}

/**
 * Ray casting, for the client half: a drawn shape selects the wells already on
 * screen without a round trip.
 *
 * BOUNDARY BEHAVIOUR, stated because ray casting's default answer on an edge is
 * whatever the arithmetic happens to do. Here a point exactly ON an edge, and a
 * point exactly ON a vertex, are both INSIDE, tested explicitly before the
 * crossing count rather than left to the crossing count. That is not a
 * preference, it is what the server does: measured 2026-08-21 against the
 * mirror, `point '(5,0)' <@ polygon '((0,0),(10,0),(10,10),(0,10))'` is true on
 * all four edges and on the corner, so a browser that answered otherwise would
 * preview a different set from the one the query returns.
 *
 * Away from the boundary the crossing test is half-open on y (`(yi > lat) !==
 * (yj > lat)`), which is what stops a horizontal ray through a vertex from
 * counting that vertex twice.
 *
 * The ring is treated as closed: the last vertex joins the first, whether or not
 * the caller repeated it.
 */
export function pointInRing(ring: readonly LonLat[], lon: number, lat: number): boolean {
  const n = ring.length;
  if (n < 3) return false;

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (onSegment(a, b, lon, lat)) return true;
    if (a[1] > lat !== b[1] > lat) {
      // (a.y > lat) !== (b.y > lat): the segment straddles the ray's row.
      const xAt = b[0] + ((lat - b[1]) * (a[0] - b[0])) / (a[1] - b[1]);
      if (lon < xAt) inside = !inside;
    }
  }
  return inside;
}

/**
 * Whether a point is in a shape, using the SAME ring the SQL will use.
 *
 * A circle is deliberately NOT tested by great-circle distance here. That would
 * be the truer answer to "is this well within 10 miles", but it would disagree
 * with the server on the 0.16% of the disc between the 64-gon and the circle,
 * and a preview that highlights a well the query then drops is worse than a
 * circle that is 63 ft shy. One geometry, two runtimes.
 */
export function pointInShape(shape: Shape, lon: number, lat: number): boolean {
  return pointInRing(shapeRing(shape), lon, lat);
}

/**
 * First occurrence wins, order preserved, keyed by API number.
 *
 * The reason this exists: two overlapping shapes are a union, so a well inside
 * both must be counted once. A count taken by summing per-shape counts is
 * wrong, and it is wrong in the direction that looks plausible.
 */
export function dedupeWells<T extends LocatedWell>(
  ...groups: readonly (readonly T[])[]
): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const group of groups) {
    for (const w of group) {
      if (seen.has(w.api)) continue;
      seen.add(w.api);
      out.push(w);
    }
  }
  return out;
}

/**
 * The wells inside ANY of the shapes, each once, in input order.
 *
 * Rings are built once per shape rather than per well: a 30,000-well focus
 * layer against three circles is 90,000 hit tests, and regenerating 64 sines
 * for each of them is the difference between instant and not.
 *
 * No shapes selects NOTHING, not everything. See `shapePredicate` for why the
 * two functions differ on the empty case.
 */
export function wellsInShapes<T extends LocatedWell>(
  wells: readonly T[],
  shapes: readonly Shape[]
): T[] {
  if (shapes.length === 0) return [];
  const rings = shapes.map((s) => shapeRing(s));
  return wells.filter((w) => rings.some((r) => pointInRing(r, w.lng, w.lat)));
}

/**
 * The default simplification tolerance for a set of points: `SIMPLIFY_FRACTION`
 * of the larger side of their bounding box, in degrees of latitude.
 */
export function ringTolerance(points: readonly LonLat[]): number {
  if (points.length === 0) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY) * SIMPLIFY_FRACTION;
}

/**
 * Douglas-Peucker, for the freehand lasso.
 *
 * A pointer drag samples on every move event, so a lasso around a field arrives
 * as several hundred points. That is a slow index probe (the GiST recheck runs
 * point-in-polygon per candidate row, per vertex), a polygon literal in the tens
 * of kilobytes, and a shape nobody can edit afterwards.
 *
 * `tolerance` is in degrees of LATITUDE. Longitude is scaled by cos(mean lat)
 * before the perpendicular distance is measured, so the test is isotropic on the
 * ground: without it a lasso at 32 N would be simplified 18% more aggressively
 * east/west than north/south and would come back subtly out of round.
 *
 * The first and last sampled points are always kept. The ring's closure is
 * implicit everywhere in this module, so the drag is simplified as the open
 * sequence it is.
 */
export function simplifyRing(
  points: readonly LonLat[],
  tolerance: number = ringTolerance(points)
): LonLat[] {
  if (points.length <= 2) return points.map(([x, y]) => [x, y] as LonLat);
  assertFinite(tolerance, "simplify tolerance");

  let latSum = 0;
  for (const [, y] of points) latSum += y;
  const kx = Math.cos(((latSum / points.length) * Math.PI) / 180);

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  // Explicit stack rather than recursion: a pathological drag (a spiral, or a
  // hand that shook along one axis) makes the recursion depth O(n), and n is
  // however many pointermove events the browser chose to fire.
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;

    const ax = points[first][0] * kx;
    const ay = points[first][1];
    const bx = points[last][0] * kx;
    const by = points[last][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);

    let worst = -1;
    let worstAt = -1;
    for (let i = first + 1; i < last; i++) {
      const px = points[i][0] * kx;
      const py = points[i][1];
      // A zero-length base means the endpoints coincide, which happens on a
      // closed drag; fall back to distance from the point they share.
      const d =
        len === 0
          ? Math.hypot(px - ax, py - ay)
          : Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }

    if (worst > tolerance) {
      keep[worstAt] = true;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }

  const out: LonLat[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push([points[i][0], points[i][1]]);
  }
  return out;
}
