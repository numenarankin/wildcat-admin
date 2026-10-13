import "server-only";

import { rrcQuery } from "@/lib/scout/rrc-db";

/**
 * What a filed elevation actually MEASURES, and what to do about the wells that
 * filed none.
 *
 * Every structural number in this codebase is `subsea = elevation - depth`, and
 * until now `elevation` was read as though it were the kelly bushing on every
 * filing. It is not. The RRC's own `elevation_code` says what the number is
 * measured from, and counted across the mirror:
 *
 *   GR  360,342     ground level
 *   GL  336,658     ground level
 *   KB   94,997     kelly bushing
 *   (none) 92,428
 *   DF   61,541     derrick floor
 *   RT    2,077     rotary table
 *
 * So 697,000 filings are GROUND referenced and 158,600 are referenced to the
 * rig floor. Treating a ground elevation as a kelly bushing puts that well's
 * perforations too shallow in subsea by the height of the derrick, on four
 * wells in five, in a system where the standoff being argued about was eleven
 * feet. That is not a rounding error, it is the same size as the answer.
 *
 * ## The derrick height is MEASURED, not assumed
 *
 * 14,881 wellbores filed both a ground-referenced and a rig-floor-referenced
 * elevation on the same hole, so the difference between the two IS the derrick
 * height for that rig, exactly, with no interpolation involved:
 *
 *   p10 0 ft, p25 7 ft, MEDIAN 11 ft, p75 14 ft, p90 22 ft
 *
 * Eleven feet is the correction and eleven feet is also the honest band on it,
 * because the p10-to-p90 spread is about that wide either side. Which is the
 * point of the whole module: the correction is applied AND its uncertainty is
 * carried, so nothing downstream can quote a converted depth as though it were
 * surveyed.
 *
 * ## A derived elevation SCREENS, it does not decide
 *
 * 42% of Texas wellbores carry a filed elevation at all. For the rest, ground
 * elevation is interpolated from the neighbours that do have one, which works
 * because surface elevation is smooth over a few miles in a way that formation
 * depth is not. It is inverse-distance weighted and it reports the spread of
 * the wells it used as its band, so a well on a bluff comes back with a wide
 * band rather than a confident wrong number.
 *
 * A FILED ELEVATION ALWAYS WINS. Interpolation runs only where there is
 * nothing, every value says which it is, and the three-bucket comparison below
 * is the only sanctioned way to act on one:
 *
 *   above / below / TOO CLOSE TO CALL
 *
 * The third bucket is not optional. A screen that answers in two buckets will
 * be believed in two buckets.
 *
 * ## Why this is not a DEM, and what would be better
 *
 * The plan called for a 10 m 3DEP raster loaded as reference data with subsea
 * computed by `ST_Value(dem.rast, well.geom)`. The mirror has no PostGIS at all
 * (its extensions are timescaledb, pgvector, pg_trgm, postgres_fdw and the
 * stats packs), so there is no raster type to load one into, and the load itself
 * belongs to the separate pipeline that owns the mirror. Neighbour
 * interpolation needs no new data, costs one query, and carries a band derived
 * from the actual local relief rather than a published vertical accuracy. When
 * a DEM does land, `groundElevation` is the one function that has to change.
 */

/** Filed elevations referenced to the ground. The majority of the record. */
const GROUND_CODES = new Set(["GL", "GR", "G", "GRD"]);
/** Filed elevations referenced to the rig floor, which is what a log is hung on. */
const DERRICK_CODES = new Set(["KB", "DF", "RT", "DB", "RB", "DR", "RK"]);

/**
 * Median rig floor height above ground, in feet.
 *
 * Measured over the 14,881 wellbores that filed both, as described above. Not a
 * textbook figure and not a guess.
 */
export const DERRICK_HEIGHT_FT = 11;
/**
 * The band on that correction, and on any elevation whose code is missing.
 *
 * p10 is 0 ft and p90 is 22 ft against a median of 11, so eleven feet either
 * side covers eight filings in ten. An uncoded elevation gets the same band for
 * a different reason: it may already include the derrick or it may not, and
 * eleven feet is the size of the thing not known.
 */
export const DERRICK_BAND_FT = 11;

/** Neighbours used for an interpolated ground elevation. */
const NEIGHBOURS = 8;
/** How far out to look for them. Beyond this, relief stops being local. */
const DEFAULT_RADIUS_MI = 5;
/** A band is never reported tighter than this, whatever the neighbours agree on. */
const MIN_DERIVED_BAND_FT = 15;
/** Guards the neighbour read from pulling a city's worth of wells. */
const MAX_NEIGHBOUR_ROWS = 4000;

const FT_PER_DEG_LAT = 69.0;

export type ElevationSource =
  | "filed_rig_floor"
  | "filed_ground"
  | "filed_uncoded"
  | "derived_ground"
  | "none";

export interface Datum {
  /** Rig-floor elevation in feet, which is what a filed depth is measured from. */
  elevationFt: number | null;
  /** Plus or minus, in feet. Zero only for an elevation filed as a rig floor. */
  bandFt: number;
  source: ElevationSource;
  /** Neighbours behind an interpolated value. Absent when the value was filed. */
  neighbours?: number;
}

export const NO_DATUM: Datum = { elevationFt: null, bandFt: 0, source: "none" };

/**
 * A filed elevation, converted to the rig floor it is compared against.
 *
 * The conversion goes toward the rig floor rather than toward the ground
 * because every depth on the other side of the subtraction is a driller's
 * depth, measured from the floor. Converting the depths instead would mean
 * touching every filing rather than one number.
 */
export function filedDatum(elevationFt: number | null, code: string | null): Datum {
  if (elevationFt == null || !Number.isFinite(elevationFt) || elevationFt <= 0) {
    return NO_DATUM;
  }
  const c = (code ?? "").trim().toUpperCase();
  if (DERRICK_CODES.has(c)) {
    return { elevationFt, bandFt: 0, source: "filed_rig_floor" };
  }
  if (GROUND_CODES.has(c)) {
    return {
      elevationFt: elevationFt + DERRICK_HEIGHT_FT,
      bandFt: DERRICK_BAND_FT,
      source: "filed_ground",
    };
  }
  // No code. The number is taken as filed rather than adjusted by half a
  // derrick, because a made-up midpoint is a number nobody filed. The band says
  // the derrick may or may not be in it.
  return { elevationFt, bandFt: DERRICK_BAND_FT, source: "filed_uncoded" };
}

// ------------------------------------------------------------- interpolation

interface NeighbourRow {
  lat: number;
  lon: number;
  elevation: number;
  elevation_code: string | null;
}

export interface Point {
  lat: number;
  lon: number;
}

/**
 * Every filed elevation near a set of points, in one read.
 *
 * One query for the whole population rather than one per well: a fit runs over
 * dozens of wells and a query each would be dozens of round trips inside a
 * user's wait, against a five second statement timeout.
 */
async function nearbyElevations(points: readonly Point[], radiusMi: number): Promise<NeighbourRow[]> {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const dLat = radiusMi / FT_PER_DEG_LAT;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLon = radiusMi / (FT_PER_DEG_LAT * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));

  return rrcQuery<NeighbourRow>(
    `select l.lat, l.lon, f.elevation, f.elevation_code
       from rrc.well_location l
       join lateral (
         select wf.elevation, nullif(trim(wf.elevation_code), '') as elevation_code
           from rrc.wb_filing wf
          where wf.api_number = l.api_number
            and wf.elevation > 0
          order by wf.file_date desc nulls last
          limit 1) f on true
      where l.lat between $1 and $2
        and l.lon between $3 and $4
      limit $5`,
    [
      Math.min(...lats) - dLat,
      Math.max(...lats) + dLat,
      Math.min(...lons) - dLon,
      Math.max(...lons) + dLon,
      MAX_NEIGHBOUR_ROWS,
    ]
  );
}

/** Miles between two points, flat-earth over a few miles and accurate enough. */
function milesBetween(a: Point, b: Point): number {
  const dLat = (a.lat - b.lat) * FT_PER_DEG_LAT;
  const dLon =
    (a.lon - b.lon) * FT_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Interpolate a rig-floor datum for one point from the filed elevations around
 * it.
 *
 * Inverse distance squared over the nearest few, and the BAND is the weighted
 * spread of the neighbours used. That is the property that makes this safe to
 * screen with: flat country returns a tight band, a point on the edge of a
 * scarp returns a band wide enough that the three-bucket test refuses to call
 * it, and neither case needed anybody to know in advance which one it was.
 */
function interpolate(point: Point, rows: readonly NeighbourRow[], radiusMi: number): Datum {
  const near = rows
    .map((r) => ({ row: r, mi: milesBetween(point, r) }))
    .filter((n) => n.mi <= radiusMi)
    .sort((a, b) => a.mi - b.mi)
    .slice(0, NEIGHBOURS);
  if (near.length < 3) return NO_DATUM;

  // Each neighbour is converted to the rig floor first, so a GL neighbour and a
  // KB neighbour are not averaged as though they measured the same thing.
  const values = near.map((n) => ({
    ft: filedDatum(n.row.elevation, n.row.elevation_code).elevationFt as number,
    // Clamped: a neighbour on top of the point would otherwise carry all the
    // weight and report a band of zero.
    w: 1 / Math.max(0.05, n.mi) ** 2,
  }));
  const totalW = values.reduce((s, v) => s + v.w, 0);
  const mean = values.reduce((s, v) => s + v.ft * v.w, 0) / totalW;
  const variance = values.reduce((s, v) => s + v.w * (v.ft - mean) ** 2, 0) / totalW;
  const spread = Math.sqrt(variance);

  return {
    elevationFt: Math.round(mean),
    // The derrick band rides along: every neighbour's own conversion carries it,
    // so the interpolated value cannot be tighter than its inputs.
    bandFt: Math.round(Math.max(MIN_DERIVED_BAND_FT, spread + DERRICK_BAND_FT)),
    source: "derived_ground",
    neighbours: near.length,
  };
}

export interface DatumTarget extends Point {
  api_number: string;
  /** As filed. Null where the well filed none. */
  elevationFt: number | null;
  elevationCode: string | null;
}

export interface DatumSet {
  /** Keyed by API. Every target appears, including the ones still unplaceable. */
  byApi: Map<string, Datum>;
  filed: number;
  derived: number;
  unplaced: number;
  /** Every band in play, so a caller can report the worst case honestly. */
  widestBandFt: number;
}

/**
 * Place a whole population on one datum.
 *
 * `derive` off is the conservative reading of the record: only what somebody
 * filed. It is also how two of these tools came to find two qualifying wells
 * where they needed five, and zero where they needed any, so the interpolated
 * path exists to make the fit possible at all. Which wells came from which is
 * on the result, always.
 */
export async function placeOnDatum(
  targets: readonly DatumTarget[],
  opts: { derive?: boolean; radiusMi?: number } = {}
): Promise<DatumSet> {
  const byApi = new Map<string, Datum>();
  const missing: DatumTarget[] = [];

  for (const t of targets) {
    const filed = filedDatum(t.elevationFt, t.elevationCode);
    if (filed.elevationFt != null) byApi.set(t.api_number, filed);
    else missing.push(t);
  }

  const radiusMi = Math.min(25, Math.max(0.5, opts.radiusMi ?? DEFAULT_RADIUS_MI));
  if (opts.derive && missing.length > 0) {
    const usable = missing.filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lon));
    if (usable.length > 0) {
      const rows = (await nearbyElevations(usable, radiusMi)).filter(
        (r) => r.elevation > 0 && Number.isFinite(r.lat) && Number.isFinite(r.lon)
      );
      for (const t of usable) {
        const d = interpolate(t, rows, radiusMi);
        if (d.elevationFt != null) byApi.set(t.api_number, d);
      }
    }
  }

  let filed = 0;
  let derived = 0;
  let widestBandFt = 0;
  for (const d of byApi.values()) {
    if (d.source === "derived_ground") derived++;
    else filed++;
    widestBandFt = Math.max(widestBandFt, d.bandFt);
  }

  return { byApi, filed, derived, unplaced: targets.length - byApi.size, widestBandFt };
}

// ----------------------------------------------------------- three buckets

export type Bucket = "above" | "below" | "too_close_to_call";

/**
 * Where a subsea value sits relative to a reference, with the uncertainty
 * honoured.
 *
 * The whole reason the band is carried everywhere else in this file. A derived
 * datum can sort a population and it must never pick a perforation depth, and
 * the mechanism that enforces the difference is this function refusing to
 * answer when the gap is inside the error.
 */
export function bucketAgainst(
  subseaFt: number,
  referenceFt: number,
  bandFt: number
): Bucket {
  const gap = subseaFt - referenceFt;
  if (Math.abs(gap) <= Math.abs(bandFt)) return "too_close_to_call";
  return gap > 0 ? "above" : "below";
}

/** The sentence a result carries whenever any of its wells were interpolated. */
export function datumNote(set: DatumSet): string {
  // The excluded count is appended on BOTH branches. It was on the interpolated
  // branch only, which meant the conservative path, the one that excludes the
  // most wells, was the one that said nothing about excluding any.
  const dropped =
    set.unplaced > 0
      ? ` ${set.unplaced} filed no elevation and could not be placed at all, so they are excluded from anything structural here, never treated as zero.`
      : "";
  if (set.derived === 0) {
    return (
      "Every well placed here sits on its own FILED elevation. Ground-referenced filings were converted to the rig floor by the measured median derrick height of 11 ft, which carries plus or minus 11 ft." +
      dropped
    );
  }
  return (
    `${set.filed} of these wells sit on a filed elevation and ${set.derived} were placed by interpolating ground elevation from the filed elevations around them, ` +
    `to plus or minus ${set.widestBandFt} ft at the widest. An interpolated datum SCREENS a population and never decides a perforation depth: ` +
    "anything inside the band is too close to call, not above or below." +
    dropped
  );
}
