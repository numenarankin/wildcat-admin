import "server-only";

import { z } from "zod";

import { rrcQuery, rrcQueryOne } from "@/lib/scout/rrc-db";
import {
  findDisposal,
  getInjectionEdge,
  getPipelines,
  resolveCounty,
  type PipelineSegment,
} from "@/lib/scout/rrc-queries";
import { distanceMiles, hhi, mean, median, percentile, sum } from "../math";
import { offsetWellbores } from "../offsets";
import { defineTool, type RrcTool } from "../tool";

/**
 * Where things are: spacing, footprint, offsets, and the pipe an area leans on.
 *
 * Four facts hold across every tool in this file and are attached to the
 * results rather than left in a comment, because each one is a wrong answer
 * waiting to happen:
 *
 *   1. A TEXAS SECTION IS 640 ACRES, one square mile. Every density and every
 *      drainage number here is that conversion and says so.
 *   2. `rrc.well_location` CARRIES SURFACE COORDINATES ONLY, and only for the
 *      wells the RRC geocoded: coverage thins badly on old leases. Every tool
 *      counts the wells it could not place instead of quietly analysing the
 *      subset it could. This is the single most likely way these mislead.
 *   3. THERE ARE NO LEASE BOUNDARIES IN THE PUBLIC RECORD. A footprint is the
 *      land-grant survey tracts the wells fall inside, always bigger than the
 *      lease within them.
 *   4. `rrc.pipeline` CARRIES NO DATES AT ALL. Verified column by column: the
 *      RRC map layer behind it publishes operator, permit, system, commodity,
 *      diameter, interstate, type, status, county and a phone number, and not
 *      one timestamp. Anything asking when pipe appeared is refused, not
 *      estimated.
 */

/** One square mile. The whole density and drainage conversion. */
const SECTION_ACRES = 640;

const SURFACE_ONLY =
  "Coordinates are SURFACE holes from rrc.well_location, which the RRC geocoded for only part of the record and hardly at all on old leases. Wells with no coordinate are counted and reported here, never dropped quietly.";

const NO_LEASE_LINES =
  "The RRC publishes NO lease boundaries. This is the land-grant survey tract each well falls inside, and a tract is always bigger than the lease inside it: the acreage is the tracts', not the operator's holding.";

const NO_PIPELINE_DATES =
  "rrc.pipeline carries no date of any kind: no in-service date, no permit date, no first-seen date. The RRC public map layer behind it serves sixteen attributes (operator, P-5 number, T-4 permit, system, subsystem, commodity, diameter, interstate, system type, status, county, contact) and not one of them is a timestamp, and the mirror stores no load time beside them.";

const PRESENCE_IS_NOT_ACCESS =
  "A line on the map is not access. The record carries no capacity, no pressure, no interconnect and no tariff, and whether a midstream will take your product, and at what deduct, is commercial.";

const LATE_H10 = (edge: string) =>
  `H-10 filing runs about a year behind. Disposal volumes here are measured through ${edge}; a thin recent tail is late filing, not a well that stopped.`;

function fail(error: string) {
  return { ok: false as const, error };
}

// ------------------------------------------------------------------ the set

/**
 * The area argument, shared by the tools that work over a fleet.
 *
 * One of point, county, operator or lease is REQUIRED. A statewide scan is
 * refused rather than allowed to time out, the same rule `findWells` follows.
 */
const AREA_SHAPE = {
  lat: z.number().optional(),
  lon: z.number().optional(),
  radius_mi: z.number().optional(),
  county: z.string().optional(),
  operator_no: z.string().optional(),
  lease: z.string().optional(),
  limit: z.number().int().optional(),
};

interface AreaArgs {
  lat?: number;
  lon?: number;
  radius_mi?: number;
  county?: string;
  operator_no?: string;
  lease?: string;
  limit?: number;
}

const NO_AREA =
  'An area is required: give lat and lon, or a county, an operator_no, or a lease key like "O/08/12345". A statewide scan is refused.';

/** `oil_gas_code/district/lease_no`, the one lease key a model can type. */
const LEASE_KEY = /^\s*([OGog])\s*\/\s*(\d{1,2})\s*\/\s*(\S+?)\s*$/;

function parseLease(key: string) {
  const m = LEASE_KEY.exec(key);
  if (!m) return null;
  return {
    oilGasCode: m[1].toUpperCase(),
    district: m[2].padStart(2, "0"),
    leaseNo: m[3],
  };
}

interface SetWell {
  api_number: string;
  operator_name: string | null;
  lease_name: string | null;
  well_type_name: string | null;
  county_name: string | null;
  lat: number | null;
  lon: number | null;
  bottom_lat: number | null;
  bottom_lon: number | null;
  distance_mi: number | null;
}

interface WellSet {
  label: string;
  center: { lat: number; lon: number } | null;
  radius_mi: number | null;
  wells: SetWell[];
  /** Wells in the set the RRC never geocoded. Meaningless for a radius search. */
  missing_coordinates: number;
  /**
   * False for a radius search. A well with no coordinate cannot be placed
   * inside or outside a circle, so it never enters the set at all and its
   * absence is invisible; only a county, operator or lease set knows its own
   * true size.
   */
  coverage_known: boolean;
  truncated: boolean;
}

/**
 * The bottomhole join is OPT-IN, and that is a performance decision.
 *
 * `rrc.well_bottomhole` carries no index at all, so joining it is a hash over
 * the whole table on every call: measured 967 ms against 28 ms for the same
 * two-mile radius without it, and 335 ms against 42 ms for a 2,000-well fleet.
 * Only the bottomhole datum has any use for those columns, so only it pays.
 */
const SET_COLS = (bottomhole: boolean) => `w.api_number, w.operator_name, w.lease_name,
                  w.well_type_name, w.county_name, l.lat, l.lon,
                  ${
                    bottomhole
                      ? "b.lat as bottom_lat, b.lon as bottom_lon"
                      : "null::float8 as bottom_lat, null::float8 as bottom_lon"
                  }`;

const BOTTOMHOLE_JOIN = (bottomhole: boolean, key: string) =>
  bottomhole ? `left join rrc.well_bottomhole b on b.api_number = ${key}` : "";

/** The great-circle filter as `findWells` and `offsetWellbores` write it. */
const DIST = `(3958.7613 * acos(least(1, greatest(-1,
        sin(radians($1)) * sin(radians(l.lat)) +
        cos(radians($1)) * cos(radians(l.lat)) * cos(radians(l.lon) - radians($2))))))`;

/**
 * The wells of an area, one row per HOLE.
 *
 * `distinct on (w.api_number)` is load-bearing and not tidiness: `rrc.wellbore`
 * holds one row per well x lease x field, and a duplicated well is a nearest
 * neighbour at zero feet, a doubled section count, and a footprint tract
 * credited twice.
 */
async function resolveWellSet(
  a: AreaArgs,
  defaults: { limit: number; max: number; radiusMi: number; bottomhole?: boolean }
): Promise<WellSet | { error: string }> {
  const limit = Math.min(defaults.max, Math.max(1, Math.floor(a.limit ?? defaults.limit)));
  const hasPoint = Number.isFinite(a.lat) && Number.isFinite(a.lon);
  const bh = defaults.bottomhole === true;

  if (hasPoint) {
    const lat = a.lat as number;
    const lon = a.lon as number;
    const radiusMi = Math.min(25, Math.max(0.05, a.radius_mi ?? defaults.radiusMi));
    const dLat = radiusMi / 69.0;
    const dLon = radiusMi / (69.0 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    const rows = await rrcQuery<SetWell>(
      `select * from (
         select distinct on (w.api_number) ${SET_COLS(bh)}, ${DIST} as distance_mi
           from rrc.well_location l
           join rrc.wellbore w on w.api_number = l.api_number
           ${BOTTOMHOLE_JOIN(bh, "l.api_number")}
          where l.lat between $3 and $4
            and l.lon between $5 and $6
            and ${DIST} <= $7
            and w.on_schedule = 'Y'
          order by w.api_number, distance_mi
       ) t
       order by distance_mi
       limit $8`,
      [lat, lon, lat - dLat, lat + dLat, lon - dLon, lon + dLon, radiusMi, limit + 1]
    );
    const kept = rows.slice(0, limit);
    return {
      label: `${radiusMi} mi of ${lat}, ${lon}`,
      center: { lat, lon },
      radius_mi: radiusMi,
      wells: kept.map(trim),
      missing_coordinates: 0,
      coverage_known: false,
      truncated: rows.length > limit,
    };
  }

  const where = ["w.on_schedule = 'Y'"];
  const params: unknown[] = [];
  const labels: string[] = [];

  if (a.county?.trim()) {
    const c = resolveCounty(a.county);
    if (!c) return { error: `Not a Texas county: "${a.county}".` };
    params.push(c.county_no);
    where.push(`w.county_code = $${params.length}`);
    labels.push(`${c.county_name} County`);
  }
  if (a.operator_no?.trim()) {
    const op = a.operator_no.replace(/\D/g, "").padStart(6, "0");
    if (op.length !== 6) return { error: `Not a 6-digit RRC operator number: "${a.operator_no}".` };
    params.push(op);
    where.push(`w.operator_number = $${params.length}`);
    labels.push(`operator ${op}`);
  }
  if (a.lease?.trim()) {
    const k = parseLease(a.lease);
    if (!k) return { error: `Not a lease key: "${a.lease}". Use "O/08/12345".` };
    params.push(k.oilGasCode, k.district, k.leaseNo);
    where.push(
      `w.oil_gas_code = $${params.length - 2} and w.district = $${params.length - 1} and w.lease_number = $${params.length}`
    );
    labels.push(`lease ${k.oilGasCode}/${k.district}/${k.leaseNo}`);
  }
  if (!params.length) return { error: NO_AREA };

  params.push(limit + 1);
  // Every filter here is indexed: operator_number (partial, on-schedule) and
  // (oil_gas_code, district, lease_number) on rrc.wellbore, api_number on both
  // children. A county falls back to a scan of the 1.37M-row wellbore table,
  // measured 538 ms, which is the same trade `findWells` already makes.
  const rows = await rrcQuery<SetWell>(
    `select distinct on (w.api_number) ${SET_COLS(bh)}, null::float8 as distance_mi
       from rrc.wellbore w
       left join rrc.well_location l on l.api_number = w.api_number
       ${BOTTOMHOLE_JOIN(bh, "w.api_number")}
      where ${where.join(" and ")}
      order by w.api_number
      limit $${params.length}`,
    params
  );
  const kept = rows.slice(0, limit).map(trim);
  return {
    label: labels.join(", "),
    center: null,
    radius_mi: null,
    wells: kept,
    missing_coordinates: kept.filter((w) => w.lat == null || w.lon == null).length,
    coverage_known: true,
    truncated: rows.length > limit,
  };
}

/** `character` keys come back blank-padded. */
function trim(w: SetWell): SetWell {
  return { ...w, api_number: w.api_number.trim() };
}

interface Located extends SetWell {
  lat: number;
  lon: number;
}

/** The wells that can be placed on the chosen datum. Never a mix of the two. */
function locate(wells: readonly SetWell[], datum: "surface" | "bottomhole"): Located[] {
  return wells.flatMap((w) => {
    const lat = datum === "surface" ? w.lat : w.bottom_lat;
    const lon = datum === "surface" ? w.lon : w.bottom_lon;
    return lat != null && lon != null ? [{ ...w, lat, lon }] : [];
  });
}

// ------------------------------------------------------------------ 23

/** Distance to the closest OTHER well, per well. O(n^2), which caps the set. */
function nearestNeighbours(wells: readonly Located[]): number[] {
  return wells
    .map((a, i) => {
      let best = Infinity;
      wells.forEach((b, j) => {
        if (i === j) return;
        const d = distanceMiles(a.lat, a.lon, b.lat, b.lon);
        if (d < best) best = d;
      });
      return best;
    })
    .filter((d) => Number.isFinite(d));
}

/**
 * Wells per one-square-mile cell, which is per SECTION by area.
 *
 * The grid is laid from the set's own south-west corner along latitude and
 * longitude. It is NOT the Texas survey grid: outside the panhandle Texas was
 * surveyed in land grants of every shape and size, so there is no uniform
 * township grid to align to and a cell here will never equal an abstract.
 */
function sectionCounts(wells: readonly Located[]): number[] {
  if (!wells.length) return [];
  const lat0 = Math.min(...wells.map((w) => w.lat));
  const lon0 = Math.min(...wells.map((w) => w.lon));
  const midLat = mean(wells.map((w) => w.lat)) ?? 0;
  const milesPerLon = 69.0 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const cells = new Map<string, number>();
  for (const w of wells) {
    const y = Math.floor((w.lat - lat0) * 69.0);
    const x = Math.floor((w.lon - lon0) * milesPerLon);
    const key = `${x}:${y}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  return [...cells.values()];
}

const spacing = defineTool(
  "rrc_spacing",
  "Nearest-neighbour spacing, wells per 640-acre section and the drainage area those imply, for a radius, county, operator or lease.",
  { ...AREA_SHAPE, datum: z.enum(["surface", "bottomhole"]).optional() },
  async (args) => {
    const datum = args.datum ?? "surface";
    const set = await resolveWellSet(args, {
      limit: 500,
      max: 2000,
      radiusMi: 2,
      bottomhole: datum === "bottomhole",
    });
    if ("error" in set) return fail(set.error);

    const located = locate(set.wells, datum);
    const nn = nearestNeighbours(located);
    const cells = sectionCounts(located);
    const medianNn = median(nn);
    const medianPerSection = median(cells);
    const discSqMi = set.radius_mi != null ? Math.PI * set.radius_mi ** 2 : null;
    // Two holes at one surface point are a pad, or the same hole filed twice.
    // Either way they are not a 50 ft spacing pattern.
    const collocated = nn.filter((d) => d * 5280 < 100).length;

    return {
      ok: true as const,
      area: set.label,
      center: set.center,
      radius_mi: set.radius_mi,
      datum,
      wells_in_set: set.wells.length,
      wells_located: located.length,
      wells_without_coordinates: set.wells.length - located.length,
      coverage_known: set.coverage_known,
      nearest_neighbour_mi: nn.length
        ? {
            min: Math.min(...nn),
            p10: percentile(nn, 0.1),
            median: medianNn,
            p90: percentile(nn, 0.9),
            max: Math.max(...nn),
            mean: mean(nn),
          }
        : null,
      median_nearest_neighbour_ft: medianNn == null ? null : medianNn * 5280,
      collocated_pairs: collocated,
      section_acres: SECTION_ACRES,
      occupied_sections: cells.length,
      wells_per_section: cells.length
        ? { mean: located.length / cells.length, median: medianPerSection, max: Math.max(...cells) }
        : null,
      wells_per_section_over_search_disc:
        discSqMi != null && discSqMi > 0 ? located.length / discSqMi : null,
      drainage_acres_from_spacing: medianNn == null ? null : medianNn ** 2 * SECTION_ACRES,
      drainage_acres_from_density:
        medianPerSection && medianPerSection > 0 ? SECTION_ACRES / medianPerSection : null,
      truncated: set.truncated,
      notes: [
        `A section is ${SECTION_ACRES} acres, one square mile. Wells per section is counted on a one-mile grid laid along latitude and longitude from this set's south-west corner, NOT on the Texas survey grid: Texas is surveyed in land grants, not uniform townships, so no cell here equals an abstract.`,
        "Drainage area is an arithmetic implication of spacing, not a reservoir measurement. From spacing it is median nearest-neighbour distance squared times 640, which assumes square packing; from density it is 640 divided by the median wells per occupied section. Two independent routes to the same quantity, so a wide gap between them means the wells are clustered rather than gridded.",
        SURFACE_ONLY,
        datum === "surface"
          ? 'Measured on SURFACE holes, so a pad of horizontal wells reads as spacing near zero while the laterals below are hundreds of feet apart. Ask for datum="bottomhole" to measure where the holes land instead, on the wells that carry one.'
          : "Measured on BOTTOMHOLE locations. Wells without one are excluded rather than filled in from the surface point, because mixing the two datums would report a spacing neither is.",
        set.coverage_known
          ? `${set.wells.length - located.length} of ${set.wells.length} wells in this set could not be placed and are excluded from every distance and density above.`
          : "A radius search can only see wells the RRC geocoded: a well with no coordinate cannot be placed inside or outside the circle, so it never enters the set and its absence is invisible here. The zero missing count is a property of the search, not a coverage claim.",
        // Measured on a real Midland two-mile radius: 137 of 177 nearest
        // neighbours under 100 ft, a median of 29 ft, and a spacing-route
        // drainage area of 0.02 acres. The number is arithmetically right and
        // says nothing about the reservoir, so it gets flagged where it happens.
        nn.length && collocated / nn.length >= 0.25
          ? `${collocated} of ${nn.length} nearest-neighbour distances are under 100 ft. That is a PAD, not a spacing pattern, and it makes the spacing route to drainage area meaningless for this set: read the density route, or ask for datum="bottomhole".`
          : "",
      ].filter(Boolean),
    };
  }
);

// ------------------------------------------------------------------ 24

type Ring = [number, number][];

interface TractRow {
  objectid: number;
  abstract_number: string | null;
  abstract_label: string | null;
  survey_name: string | null;
  block_number: string | null;
  acres: number | null;
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
  geojson: string;
}

/** Rings of a GeoJSON Polygon or MultiPolygon. Anything else encloses nothing. */
function ringsOf(geojson: string): Ring[] {
  try {
    const g = JSON.parse(geojson) as { type?: string; coordinates?: unknown };
    if (g.type === "Polygon") return g.coordinates as Ring[];
    if (g.type === "MultiPolygon") return (g.coordinates as Ring[][]).flat();
  } catch {
    // A tract we cannot parse is one we cannot place a well in, not a failure.
  }
  return [];
}

/**
 * Even-odd ray cast across EVERY ring, so a hole excludes without special
 * handling: a point inside the outer ring and inside a hole crosses twice.
 */
function inRings(lon: number, lat: number, rings: readonly Ring[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

const TRACT_CAP = 3000;

const footprint = defineTool(
  "rrc_footprint",
  "The survey tracts an operator's or a lease's wells sit in and their total acreage; the RRC publishes no lease lines, so this is always bigger than the lease.",
  {
    operator_no: z.string().optional(),
    lease: z.string().optional(),
    county: z.string().optional(),
    limit: z.number().int().optional(),
  },
  async (args) => {
    if (!args.operator_no?.trim() && !args.lease?.trim()) {
      return fail(
        'A footprint needs an operator_no or a lease key like "O/08/12345". A county alone would be the county, not a footprint.'
      );
    }
    const set = await resolveWellSet(args, { limit: 2000, max: 5000, radiusMi: 0 });
    if ("error" in set) return fail(set.error);

    const located = locate(set.wells, "surface");
    if (!located.length) {
      return {
        ok: true as const,
        area: set.label,
        wells_in_set: set.wells.length,
        wells_located: 0,
        wells_without_coordinates: set.wells.length,
        tract_count: 0,
        tract_acres_total: 0,
        tracts: [],
        truncated: set.truncated,
        notes: [NO_LEASE_LINES, SURFACE_ONLY],
      };
    }

    /*
     * TWO QUERIES, and the split is the whole performance story.
     *
     * `&&` against a zero-area box, NOT `@>` with a point: the two return the
     * same rows, but `@>` matches no GiST operator class for `box` and drops to
     * a sequential scan of 311k polygons per well.
     *
     * The DISTINCT must not carry `geojson`. Deduping rows that each hold a
     * tract's whole ring text is the entire cost: 500 wells in one query
     * measured past the 5 s statement timeout with the text in the select and
     * 62 ms without it, plus 45 ms to fetch the 130 tracts by primary key.
     */
    const ids = await rrcQuery<{ objectid: number }>(
      `select distinct p.objectid
         from rrc.well_location l
         join rrc.survey_polygon p
           on p.bbox && box(point(l.lon, l.lat), point(l.lon, l.lat))
        where l.api_number = any($1)
          and l.lat is not null and l.lon is not null
        limit $2`,
      [located.map((w) => w.api_number), TRACT_CAP + 1]
    );
    const candidates = ids.length
      ? await rrcQuery<TractRow>(
          `select objectid, abstract_number, abstract_label, survey_name, block_number,
                  acres, min_lon, min_lat, max_lon, max_lat, geojson
             from rrc.survey_polygon
            where objectid = any($1)`,
          [ids.slice(0, TRACT_CAP).map((r) => r.objectid)]
        )
      : [];

    // The bounding box was the INDEX, not the answer. Measured on one Midland
    // wellhead, two tracts of ~653 acres each overlap the point's box and only
    // one contains it: taking the box would have doubled the acreage.
    const placed = new Set<string>();
    const tracts = candidates
      .map((t) => {
        const rings = ringsOf(t.geojson);
        const inside = located.filter(
          (w) =>
            w.lon >= t.min_lon &&
            w.lon <= t.max_lon &&
            w.lat >= t.min_lat &&
            w.lat <= t.max_lat &&
            inRings(w.lon, w.lat, rings)
        );
        for (const w of inside) placed.add(w.api_number);
        return {
          objectid: t.objectid,
          abstract: t.abstract_label ?? t.abstract_number,
          survey_name: t.survey_name,
          block_number: t.block_number,
          acres: t.acres,
          wells_inside: inside.length,
        };
      })
      .filter((t) => t.wells_inside > 0)
      .sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));

    return {
      ok: true as const,
      area: set.label,
      wells_in_set: set.wells.length,
      wells_located: located.length,
      wells_without_coordinates: set.wells.length - located.length,
      wells_in_no_tract: located.length - placed.size,
      tract_count: tracts.length,
      // Each tract counted ONCE however many of the set's wells it holds.
      tract_acres_total: sum(tracts.map((t) => t.acres)),
      tracts_with_no_acreage: tracts.filter((t) => t.acres == null).length,
      tracts,
      truncated: set.truncated || ids.length > TRACT_CAP,
      notes: [
        NO_LEASE_LINES,
        SURFACE_ONLY,
        "A well is placed by point-in-polygon against the tract's own rings, not by bounding box. Acreage is the tract's own figure from the RRC survey layer and each tract is summed once, however many of these wells sit in it.",
        "Wells in no tract are wells whose surface point fell outside every polygon the layer carries there, which is a gap in the survey layer rather than land nobody owns.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 25

/** A year, or a full date. Anything else is a refusal rather than a guess. */
function boundDate(value: string | undefined, end: boolean): string | null | { error: string } {
  const v = value?.trim();
  if (!v) return null;
  if (/^\d{4}$/.test(v)) return end ? `${v}-12-31` : `${v}-01-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return { error: `Not a date: "${v}". Use "2019" or "2019-06-30".` };
}

const offsetPicker = defineTool(
  "rrc_offsets",
  "Pick the offset set around a target well or point by radius, field name and completion vintage, listing why each well is in and each rejection why it is out.",
  {
    api: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    radius_mi: z.number().optional(),
    formation: z.string().optional(),
    completed_after: z.string().optional(),
    completed_before: z.string().optional(),
    limit: z.number().int().optional(),
  },
  async (args) => {
    const after = boundDate(args.completed_after, false);
    const before = boundDate(args.completed_before, true);
    if (after && typeof after === "object") return fail(after.error);
    if (before && typeof before === "object") return fail(before.error);

    const target = args.api?.trim() ?? "";
    let center: { lat: number; lon: number } | null = null;
    if (target) {
      const row = await rrcQueryOne<{ lat: number | null; lon: number | null }>(
        `select lat, lon from rrc.well_location where api_number = $1`,
        [target]
      );
      if (row?.lat == null || row?.lon == null) {
        return fail(
          `No surface location on file for ${target}, so no radius can be drawn around it. Give lat and lon instead.`
        );
      }
      center = { lat: row.lat, lon: row.lon };
    } else if (Number.isFinite(args.lat) && Number.isFinite(args.lon)) {
      center = { lat: args.lat as number, lon: args.lon as number };
    }
    if (!center) return fail("An offset set needs a target api, or lat and lon.");

    const radiusMi = Math.min(25, Math.max(0.05, args.radius_mi ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 25)));
    const { wells, truncated } = await offsetWellbores({
      ...center,
      radiusMi,
      limit,
      formation: args.formation,
    });

    // One bounded lookup for the vintage, cast to bpchar because `rrc.wb_root`
    // keys on blank-padded `character`: a text[] cast cannot use the index.
    const dated = wells.length
      ? await rrcQuery<{ api_number: string; orig_completion: Date | null }>(
          `select api_number, orig_completion
             from rrc.wb_root
            where api_number = any($1::bpchar[])`,
          [wells.map((w) => w.api_number)]
        )
      : [];
    const completedBy = new Map(
      dated.map((d) => [
        d.api_number.trim(),
        d.orig_completion ? d.orig_completion.toISOString().slice(0, 10) : null,
      ])
    );

    const wantsVintage = Boolean(after || before);
    const included: unknown[] = [];
    const excluded: { api_number: string; distance_mi: number; why: string }[] = [];
    let undatedRejects = 0;

    for (const w of wells) {
      const completed = completedBy.get(w.api_number) ?? null;
      if (w.api_number === target) {
        excluded.push({
          api_number: w.api_number,
          distance_mi: w.distanceMi,
          why: "is the target well",
        });
        continue;
      }
      if (wantsVintage && !completed) {
        undatedRejects++;
        excluded.push({
          api_number: w.api_number,
          distance_mi: w.distanceMi,
          why: "no completion date on file and a vintage filter was set",
        });
        continue;
      }
      if (typeof after === "string" && completed && completed < after) {
        excluded.push({
          api_number: w.api_number,
          distance_mi: w.distanceMi,
          why: `completed ${completed}, before ${after}`,
        });
        continue;
      }
      if (typeof before === "string" && completed && completed > before) {
        excluded.push({
          api_number: w.api_number,
          distance_mi: w.distanceMi,
          why: `completed ${completed}, after ${before}`,
        });
        continue;
      }
      const why = [`within ${radiusMi} mi (${w.distanceMi.toFixed(2)} mi)`];
      if (args.formation?.trim()) why.push(`RRC field name matches "${args.formation.trim()}"`);
      if (completed) why.push(`completed ${completed}`);
      included.push({
        api_number: w.api_number,
        operator_name: w.operator_name,
        lease_name: w.lease_name,
        distance_mi: w.distanceMi,
        completed,
        total_depth_ft: w.totalDepthFt,
        plug_back_ft: w.plugBackFt,
        formation_tops: w.formationTops.length,
        perforated_intervals: w.perforations.length,
        why,
      });
    }

    return {
      ok: true as const,
      target: target || null,
      center,
      radius_mi: radiusMi,
      formation: args.formation ?? null,
      completed_after: typeof after === "string" ? after : null,
      completed_before: typeof before === "string" ? before : null,
      offsets: included.length,
      apis: included.map((w) => (w as { api_number: string }).api_number),
      included,
      excluded,
      truncated,
      notes: [
        'A formation filter matches the RRC FIELD NAME, e.g. "SPRABERRY (TREND AREA)", because a wellbore carries no formation column. It is the operator\'s field assignment, not a logged top.',
        `Vintage is orig_completion from rrc.wb_root, the original completion of the hole and not of a later recompletion.${wantsVintage ? ` ${undatedRejects} well(s) in the radius carry no completion date and were excluded rather than assumed in.` : ""}`,
        SURFACE_ONLY,
        "Distance is surface point to surface point. On a horizontal well the lateral may run a mile from the wellhead, so a laterally adjacent hole can read further away than a vertical one that is not.",
        truncated
          ? "More wells sit inside this radius than the limit returned. The set is the nearest ones, not all of them."
          : "Every well the mirror carries inside this radius is accounted for above, included or excluded.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 79

/** Vertex paths of a GeoJSON LineString or MultiLineString. */
function pathsOf(geojson: string): Ring[] {
  try {
    const g = JSON.parse(geojson) as { type?: string; coordinates?: unknown };
    if (g.type === "LineString") return [g.coordinates as Ring];
    if (g.type === "MultiLineString") return g.coordinates as Ring[];
  } catch {
    // A segment we cannot parse is one we cannot measure to.
  }
  return [];
}

/**
 * The closest point ON a centreline to (lat, lon).
 *
 * Projected to a local plane (degrees scaled by cos(latitude)) only to find
 * WHERE the closest point falls; the distance itself is then the one great
 * circle in `math.ts`. Nearest-vertex would overstate, because these segments
 * carry long straight runs between vertices.
 */
function closestOnPaths(
  lat: number,
  lon: number,
  paths: readonly Ring[]
): { lat: number; lon: number } | null {
  const kx = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  let best: { lat: number; lon: number } | null = null;
  let bestD2 = Infinity;
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const [x1, y1] = path[i - 1];
      const [x2, y2] = path[i];
      const dx = (x2 - x1) * kx;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, (((lon - x1) * kx * dx + (lat - y1) * dy) / len2))
            );
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t;
      const d2 = ((lon - px) * kx) ** 2 + (lat - py) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { lat: py, lon: px };
      }
    }
    // A one-vertex path has no segment but still has a position.
    if (path.length === 1) {
      const [x, y] = path[0];
      const d2 = ((lon - x) * kx) ** 2 + (lat - y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { lat: y, lon: x };
      }
    }
  }
  return best;
}

function distanceToSegment(lat: number, lon: number, geojson: string): number | null {
  const p = closestOnPaths(lat, lon, pathsOf(geojson));
  return p ? distanceMiles(lat, lon, p.lat, p.lon) : null;
}

const IN_SERVICE = "In Service";
const PIPE_CAP = 3000;

interface MeasuredPipe {
  objectid: number;
  p5_num: string | null;
  operator_name: string | null;
  system_name: string | null;
  commodity: string | null;
  diameter_in: number | null;
  status: string | null;
  interstate: string | null;
  length_mi: number | null;
  distance_mi: number;
}

/** Every segment in the box, with its distance to the point. */
function measure(rows: readonly PipelineSegment[], lat: number, lon: number): MeasuredPipe[] {
  return rows.flatMap((r) => {
    const d = distanceToSegment(lat, lon, r.geojson);
    return d == null
      ? []
      : [
          {
            objectid: r.objectid,
            p5_num: r.p5_num?.trim() ?? null,
            operator_name: r.operator_name,
            system_name: r.system_name,
            commodity: r.commodity,
            diameter_in: r.diameter,
            status: r.status,
            interstate: r.interstate,
            length_mi: r.length_mi,
            distance_mi: d,
          },
        ];
  });
}

/** The bounding box a radius in miles spans around a point. */
function boxAround(lat: number, lon: number, radiusMi: number) {
  const dLat = radiusMi / 69.0;
  const dLon = radiusMi / (69.0 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return {
    west: lon - dLon,
    south: lat - dLat,
    east: lon + dLon,
    north: lat + dLat,
  };
}

/** The point a lease or an explicit pair puts us at. */
async function areaPoint(
  args: AreaArgs
): Promise<{ point: { lat: number; lon: number }; label: string; set: WellSet | null } | { error: string }> {
  if (Number.isFinite(args.lat) && Number.isFinite(args.lon)) {
    const point = { lat: args.lat as number, lon: args.lon as number };
    return { point, label: `${point.lat}, ${point.lon}`, set: null };
  }
  if (!args.lease?.trim() && !args.operator_no?.trim() && !args.county?.trim()) {
    return { error: NO_AREA };
  }
  const set = await resolveWellSet(args, { limit: 500, max: 2000, radiusMi: 0 });
  if ("error" in set) return { error: set.error };
  const located = locate(set.wells, "surface");
  if (!located.length) {
    return {
      error: `No well in ${set.label} has a surface coordinate on file, so there is no point to measure from.`,
    };
  }
  return {
    point: {
      lat: mean(located.map((w) => w.lat)) as number,
      lon: mean(located.map((w) => w.lon)) as number,
    },
    label: set.label,
    set,
  };
}

const takeaway = defineTool(
  "rrc_takeaway",
  "Distance from a point or a lease to the nearest gathering and transmission lines, by commodity, with how many independent systems are within reach.",
  {
    lat: z.number().optional(),
    lon: z.number().optional(),
    lease: z.string().optional(),
    county: z.string().optional(),
    operator_no: z.string().optional(),
    radius_mi: z.number().optional(),
    min_diameter_in: z.number().optional(),
  },
  async (args) => {
    const at = await areaPoint(args);
    if ("error" in at) return fail(at.error);

    const radiusMi = Math.min(25, Math.max(0.25, args.radius_mi ?? 10));
    const minDiameter = Math.max(0, args.min_diameter_in ?? 0);
    const b = boxAround(at.point.lat, at.point.lon, radiusMi);
    const rows = await getPipelines(b.west, b.south, b.east, b.north, minDiameter, PIPE_CAP + 1);

    const all = measure(rows.slice(0, PIPE_CAP), at.point.lat, at.point.lon).filter(
      (p) => p.distance_mi <= radiusMi
    );
    const live = all.filter((p) => p.status === IN_SERVICE);
    const dead = all.filter((p) => p.status !== IN_SERVICE);
    const byDistance = (a: MeasuredPipe, c: MeasuredPipe) => a.distance_mi - c.distance_mi;
    live.sort(byDistance);
    dead.sort(byDistance);

    const commodities = [...new Set(live.map((p) => p.commodity ?? "unknown"))];
    const systems = new Set(live.map((p) => `${p.p5_num}|${p.system_name}`));

    return {
      ok: true as const,
      from: at.label,
      center: at.point,
      center_note: at.set
        ? "The point is the mean surface location of the wells in that set, so a scattered lease measures from its middle, not from any one well."
        : "The point is the one given.",
      radius_mi: radiusMi,
      min_diameter_in: minDiameter,
      segments_in_radius: all.length,
      in_service_segments: live.length,
      nearest_in_service: live[0] ?? null,
      nearest_by_commodity: commodities
        .map((c) => live.find((p) => (p.commodity ?? "unknown") === c) ?? null)
        .filter(Boolean),
      // Reported apart, never as takeaway: one segment in eight in this layer
      // is Abandoned, and the filing rules keep it there until it comes out of
      // the ground.
      nearest_out_of_service: dead[0] ?? null,
      systems_within_radius: systems.size,
      operators_within_radius: new Set(live.map((p) => p.p5_num)).size,
      largest_diameter_in: live.length
        ? Math.max(...live.map((p) => p.diameter_in ?? 0)) || null
        : null,
      truncated: rows.length > PIPE_CAP,
      notes: [
        PRESENCE_IS_NOT_ACCESS,
        "Distance is straight-line to the nearest point on the mapped centreline, not a routed lay distance and not a right-of-way. Real pipe follows easements, road and creek crossings, so a build is always longer than this.",
        `Diameter is OUTSIDE diameter in inches, so a 6 inch nominal line reads 6.63.`,
        `${dead.length} segment(s) in this radius are not in service. They are listed separately and never counted as takeaway.`,
        NO_PIPELINE_DATES,
      ],
    };
  }
);

// ------------------------------------------------------------------ 80

/** Capped hard: attribution is wells x segments, and both grow with the radius. */
const CHOKE_WELLS = 250;
const CHOKE_SEGMENTS = 1500;

const chokepoint = defineTool(
  "rrc_chokepoint",
  "The single lines and commercial disposal wells an area leans on, ranked by dependent wells and by barrels a day, with a concentration index for each.",
  {
    lat: z.number(),
    lon: z.number(),
    radius_mi: z.number().optional(),
    min_diameter_in: z.number().optional(),
    commercial_only: z.boolean().optional(),
  },
  async (args) => {
    if (!Number.isFinite(args.lat) || !Number.isFinite(args.lon)) {
      return fail("lat and lon are required.");
    }
    const radiusMi = Math.min(25, Math.max(0.25, args.radius_mi ?? 10));
    const commercialOnly = args.commercial_only ?? true;
    const b = boxAround(args.lat, args.lon, radiusMi);

    const [set, pipes, edge, disposal] = await Promise.all([
      resolveWellSet({ ...args, radius_mi: radiusMi, limit: CHOKE_WELLS }, {
        limit: CHOKE_WELLS,
        max: CHOKE_WELLS,
        radiusMi,
      }),
      getPipelines(b.west, b.south, b.east, b.north, Math.max(0, args.min_diameter_in ?? 0), CHOKE_SEGMENTS + 1),
      getInjectionEdge(),
      findDisposal({
        lat: args.lat,
        lon: args.lon,
        radiusMi,
        commercialOnly,
        limit: 200,
      }),
    ]);
    if ("error" in set) return fail(set.error);

    const live = measure(pipes.slice(0, CHOKE_SEGMENTS), args.lat, args.lon).filter(
      (p) => p.status === IN_SERVICE
    );
    const wells = locate(set.wells, "surface");

    // Each system's own segments, parsed once, then every well attributed to
    // the system whose nearest segment is closest to it.
    const geoms = new Map(pipes.slice(0, CHOKE_SEGMENTS).map((p) => [p.objectid, pathsOf(p.geojson)]));
    const key = (p: MeasuredPipe) => `${p.p5_num ?? "?"}|${p.system_name ?? "(unnamed)"}`;
    const dependents = new Map<string, number>();
    for (const w of wells) {
      let bestKey: string | null = null;
      let bestD = Infinity;
      for (const p of live) {
        const closest = closestOnPaths(w.lat, w.lon, geoms.get(p.objectid) ?? []);
        if (!closest) continue;
        const d = distanceMiles(w.lat, w.lon, closest.lat, closest.lon);
        if (d < bestD) {
          bestD = d;
          bestKey = key(p);
        }
      }
      if (bestKey) dependents.set(bestKey, (dependents.get(bestKey) ?? 0) + 1);
    }

    const grouped = new Map<string, MeasuredPipe[]>();
    for (const p of live) {
      const k = key(p);
      grouped.set(k, [...(grouped.get(k) ?? []), p]);
    }
    const attributed = [...dependents.values()].reduce((a, b2) => a + b2, 0);
    const rankedSystems = [...grouped.entries()]
      .map(([k, segs]) => ({
        p5_num: segs[0].p5_num,
        operator_name: segs[0].operator_name,
        system_name: segs[0].system_name,
        commodity: segs[0].commodity,
        segments: segs.length,
        miles_in_area: sum(segs.map((s) => s.length_mi)),
        max_diameter_in: Math.max(...segs.map((s) => s.diameter_in ?? 0)) || null,
        nearest_mi: Math.min(...segs.map((s) => s.distance_mi)),
        dependent_wells: dependents.get(k) ?? 0,
        dependent_share: attributed > 0 ? (dependents.get(k) ?? 0) / attributed : null,
      }))
      .sort((a, c) => c.dependent_wells - a.dependent_wells || c.miles_in_area - a.miles_in_area);

    // Only wells whose reported volume is known can carry a known dependency.
    // An unfiled well ranked as zero would read as the safest thing in the area.
    const scored = disposal.filter((d) => d.recentBblPerDay != null);
    const totalBbl = sum(scored.map((d) => d.recentBblPerDay));
    const rankedDisposal = scored
      .map((d) => ({
        uic_no: d.uic_no,
        api_number: d.api_number,
        operator_name: d.operator_name,
        lease_name: d.lease_name,
        distance_mi: d.distance_mi,
        is_commercial: d.is_commercial,
        max_bbl_per_day: d.max_bbl_per_day,
        recent_bbl_per_day: d.recentBblPerDay as number,
        share_of_area: totalBbl > 0 ? (d.recentBblPerDay as number) / totalBbl : null,
      }))
      .sort((a, c) => c.recent_bbl_per_day - a.recent_bbl_per_day);

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      commercial_only: commercialOnly,
      wells_in_area: set.wells.length,
      wells_attributed: attributed,
      pipeline: {
        in_service_segments: live.length,
        systems: rankedSystems.length,
        ranked: rankedSystems.slice(0, 25),
        hhi_by_miles: hhi(rankedSystems.map((s) => s.miles_in_area)),
        hhi_by_dependent_wells: hhi(rankedSystems.map((s) => s.dependent_wells)),
        top_system_dependent_share: rankedSystems[0]?.dependent_share ?? null,
      },
      disposal: {
        reported_through: edge.reported,
        wells: disposal.length,
        wells_scored: scored.length,
        area_bbl_per_day: totalBbl,
        ranked: rankedDisposal.slice(0, 25),
        hhi_by_bbl: hhi(rankedDisposal.map((d) => d.recent_bbl_per_day)),
        top_well_share: rankedDisposal[0]?.share_of_area ?? null,
        unscored: disposal
          .filter((d) => d.recentBblPerDay == null)
          .map((d) => ({ uic_no: d.uic_no, operator_name: d.operator_name })),
      },
      truncated: set.truncated || pipes.length > CHOKE_SEGMENTS || disposal.length >= 200,
      notes: [
        "Dependent wells are attributed by PROXIMITY to the nearest in-service line. That is a proxy and not a connection: the record that names who actually takes a lease's product is the P-4 filing, which this tool does not read.",
        "No line-level throughput exists anywhere in the public record, so pipe is ranked by wells nearest to it and by miles inside the area, never by volume.",
        "HHI runs 0 to 10,000 over shares. Above 2,500 is a concentrated market, and a single system holding more than half the dependent wells is a chokepoint by inspection.",
        "Permitted volume is a legal ceiling, not an offer: whether a disposal well will take your water, and at what price, is commercial and the state record is silent.",
        LATE_H10(edge.reported),
        "A well with no reported volume may be new, idle, or simply late filing. It is listed unscored, not counted as zero.",
        set.coverage_known
          ? ""
          : "The well count is only wells the RRC geocoded; ungeocoded wells in this radius are invisible to a radius search and are not in the attribution.",
      ].filter(Boolean),
    };
  }
);

// ------------------------------------------------------------------ 81

const pipelineActivity = defineTool(
  "rrc_pipeline_activity",
  "REFUSED, always: new pipe over time cannot be measured because the pipeline record carries no dates. Call it for the reason, not for an answer.",
  {
    lat: z.number().optional(),
    lon: z.number().optional(),
    radius_mi: z.number().optional(),
    county: z.string().optional(),
    since_year: z.number().int().optional(),
  },
  async () => ({
    ok: false as const,
    error: `New pipeline over time cannot be measured from this mirror. ${NO_PIPELINE_DATES}`,
    missing: [
      "an in-service or construction date on rrc.pipeline",
      "a T-4 permit issue date",
      "a status-change history, so a segment going from permitted to In Service leaves no trace",
      "a snapshot or first-seen timestamp, so appearance in the mirror cannot stand in for appearance in the ground",
    ],
    would_need:
      "Either a dated feed the RRC does not publish in this layer, or two or more dated snapshots of the layer diffed over time, which this mirror does not keep.",
    instead: [
      "rrc_takeaway: what pipe is near a lease or point today, by commodity, distance and system.",
      "rrc_chokepoint: which systems and disposal wells an area currently depends on.",
      "Approved drilling permits carry real dates and are the honest read on capital committed ahead of drilling.",
    ],
  })
);

export const TOOLS: RrcTool[] = [
  spacing,
  footprint,
  offsetPicker,
  takeaway,
  chokepoint,
  pipelineActivity,
];
