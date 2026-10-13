import "server-only";

/**
 * The offset wellbores around a point, with how each hole was built.
 *
 * One feeder, many tools. Every offset question, what did the neighbours
 * penetrate, where are they perforated, how deep did they plug back, what datum
 * are their depths hung on, starts from the same set of wells around a point,
 * and each of those tools writing its own radius query would mean N versions of
 * the same SQL drifting apart.
 *
 * ## The batching rule, and it is the whole performance story
 *
 * THREE queries, always, whatever the well count: the wells in the radius, their
 * formation tops, their construction. A per-well loop over 25 offsets is 75
 * round trips inside a user's wait, against a pool whose statement timeout is
 * 5 s. The children are fetched with `= any(...)` and stitched together here.
 *
 * The array cast is load-bearing. `rrc.wb_*` keys on `character` (blank-padded),
 * so `any($1::text[])` compares as text, cannot use the index, and takes 24 s for
 * 26 wells; `any($1::bpchar[])` takes 41 ms. `rrc.completion.api_no` is real
 * `text`, so the picks query casts the other way.
 */
import { hasRrcDb, rrcQuery } from "@/lib/scout/rrc-db";
import { distanceMiles } from "./math";

export interface OffsetWellbore {
  api_number: string;
  operator_name: string | null;
  lease_name: string | null;
  distanceMi: number;
  lat: number;
  lon: number;
  bottomLat: number | null;
  bottomLon: number | null;
  /** The filed elevation. What it is measured from is `elevationCode`. */
  kbElevationFt: number | null;
  /** RRC code: KB, DF, RT, GL, GR. Null on the majority of filings. */
  elevationCode: string | null;
  totalDepthFt: number | null;
  plugBackFt: number | null;
  perforations: { topFt: number | null; bottomFt: number | null; openHole: boolean }[];
  casing: { sizeIn: number | null; weightLbFt: number | null; setFt: number | null; topOfCement: string | null }[];
  formationTops: { formation: string; depthFt: number | null }[];
}

interface WellRow {
  api_number: string;
  operator_name: string | null;
  lease_name: string | null;
  lat: number;
  lon: number;
  bottom_lat: number | null;
  bottom_lon: number | null;
}

interface PickRow {
  api_no: string;
  formation: string | null;
  depth: string | null;
  depth_tmd: string | null;
}

interface ConstructionRow {
  api_number: string;
  total_depth: number | null;
  elevation: number | null;
  elevation_code: string | null;
  plug_back_ft: number | null;
  casing: OffsetWellbore["casing"];
  perfs: OffsetWellbore["perforations"];
}

/**
 * The great-circle filter, as `findWells` writes it: a bounding box so the
 * (lat, lon) index does the work, then the exact distance to trim the corners.
 */
const DIST = `(3958.7613 * acos(least(1, greatest(-1,
        sin(radians($1)) * sin(radians(l.lat)) +
        cos(radians($1)) * cos(radians(l.lat)) * cos(radians(l.lon) - radians($2))))))`;

/** Depths arrive as free text on the completion report: "1004.0", "9,550'". */
function ft(text: string | null): number | null {
  if (!text) return null;
  const n = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Ceiling on an explicitly supplied population.
 *
 * Higher than the radius path's 100 because the caps there guard a NEAREST-N
 * read that silently biases a fit; a caller passing an api list has already
 * chosen its population and the only thing left to guard is the size of three
 * batched reads. Measured on the sibling batched queries in `recompletion.ts`:
 * flat from 25 to 2,000 apis.
 */
const MAX_BY_API = 400;


/**
 * The two child reads and the stitch, shared by both population paths.
 *
 * Extracted rather than duplicated because the correctness rules live here: a
 * pick landing on the wrong well is a wrong answer that looks exactly like a
 * right one, and two copies of that stitch would drift.
 */
async function hydrate(
  kept: WellRow[],
  centerLat: number,
  centerLon: number
): Promise<OffsetWellbore[]> {
  if (kept.length === 0) return [];
  const apis = kept.map((r) => r.api_number.trim());

  const [picks, construction] = await Promise.all([
    rrcQuery<PickRow>(
      `select c.api_no, cf.formation, cf.depth, cf.depth_tmd
         from rrc.completion c
         join rrc.completion_formation cf on cf.tracking_no = c.tracking_no
        where c.api_no = any($1::text[])
        order by c.api_no, nullif(regexp_replace(cf.depth, '[^0-9]', '', 'g'), '')::bigint nulls last`,
      [apis]
    ),
    // Casing and perforations belong to a FILING, not to a well: a recompleted
    // hole carries several sets, and taking them all would blend a 1978
    // completion with a 2019 one. Both children are pinned to the newest
    // filing's date, which is the same grain rule `getWellConstruction` follows.
    rrcQuery<ConstructionRow>(
      `select a.api_number, r.total_depth, f.elevation, f.elevation_code, f.plug_back_ft,
              coalesce(cs.rows, '[]'::json) as casing,
              coalesce(pf.rows, '[]'::json) as perfs
         from unnest($1::bpchar[]) as a(api_number)
         left join rrc.wb_root r on r.api_number = a.api_number
         left join lateral (
           select wf.file_date, wf.elevation, wf.elevation_code,
                  -- Two plug-back columns, and the DEEPER one is operative; the
                  -- other is an earlier, shallower plug on the same hole.
                  nullif(greatest(coalesce(wf.plug_back_depth1, 0), coalesce(wf.plug_back_depth2, 0)), 0)
                    as plug_back_ft
             from rrc.wb_filing wf
            where wf.api_number = a.api_number
            order by wf.file_date desc nulls last
            limit 1) f on true
         left join lateral (
           select json_agg(json_build_object('sizeIn', wc.size_in, 'weightLbFt', wc.weight_lb_ft,
                                             'setFt', wc.depth_set, 'topOfCement', wc.top_of_cement)
                           order by wc.depth_set desc nulls last) as rows
             from rrc.wb_casing wc
            where wc.api_number = a.api_number
              and wc.file_date is not distinct from f.file_date) cs on true
         left join lateral (
           select json_agg(json_build_object('topFt', wp.top_ft, 'bottomFt', wp.bottom_ft,
                                             'openHole', (wp.open_hole_code = 'OH') is true)
                           order by wp.top_ft nulls last) as rows
             from rrc.wb_perf wp
            where wp.api_number = a.api_number
              and wp.file_date is not distinct from f.file_date) pf on true`,
      [apis]
    ),
  ]);

  // Every child row is filed under the API it came back with. A pick landing on
  // the wrong well is a wrong answer that looks exactly like a right one.
  const tops = new Map<string, OffsetWellbore["formationTops"]>();
  for (const p of picks) {
    if (!p.formation?.trim()) continue;
    const api = p.api_no.trim();
    const list = tops.get(api) ?? [];
    const entry = { formation: p.formation.trim(), depthFt: ft(p.depth) ?? ft(p.depth_tmd) };
    // A well with several completions reports the same tops on each of them.
    if (list.some((t) => t.formation === entry.formation && t.depthFt === entry.depthFt)) continue;
    list.push(entry);
    tops.set(api, list);
  }

  const built = new Map(construction.map((c) => [c.api_number.trim(), c]));

  return kept.map((r) => {
    const api = r.api_number.trim();
    const c = built.get(api);
    return {
      api_number: api,
      operator_name: r.operator_name?.trim() ?? null,
      lease_name: r.lease_name?.trim() ?? null,
      // Zero when there is no anchor: a supplied population has nothing to be
      // far FROM, and a fabricated distance would be sorted and reported on.
      distanceMi:
        Number.isFinite(centerLat) && Number.isFinite(centerLon)
          ? distanceMiles(centerLat, centerLon, r.lat, r.lon)
          : 0,
      lat: r.lat,
      lon: r.lon,
      bottomLat: r.bottom_lat,
      bottomLon: r.bottom_lon,
      kbElevationFt: c?.elevation ?? null,
      elevationCode: c?.elevation_code?.trim() || null,
      totalDepthFt: c?.total_depth ?? null,
      plugBackFt: c?.plug_back_ft ?? null,
      perforations: c?.perfs ?? [],
      casing: c?.casing ?? [],
      formationTops: tops.get(api) ?? [],
    };
  });

}

/** The population as supplied, with the same three reads the radius path does. */
async function byApi(
  opts: { lat: number; lon: number; includeBottomhole?: boolean; limit?: number },
  apis: string[]
): Promise<{ wells: OffsetWellbore[]; truncated: boolean }> {
  const limit = Math.min(MAX_BY_API, Math.max(1, Math.floor(opts.limit ?? MAX_BY_API)));
  const kept = apis.slice(0, limit);
  const rows = await rrcQuery<WellRow>(
    `select distinct on (w.api_number)
            w.api_number, w.operator_name, w.lease_name, l.lat, l.lon,
            ${opts.includeBottomhole ? "b.lat" : "null::float8"} as bottom_lat,
            ${opts.includeBottomhole ? "b.lon" : "null::float8"} as bottom_lon
       from unnest($1::bpchar[]) as a(api_number)
       join rrc.wellbore w on w.api_number = a.api_number
       left join rrc.well_location l on l.api_number = a.api_number
       ${opts.includeBottomhole ? "left join rrc.well_bottomhole b on b.api_number = a.api_number" : ""}
      order by w.api_number, w.on_schedule desc nulls last`,
    [kept]
  );
  return {
    wells: await hydrate(rows, opts.lat, opts.lon),
    truncated: apis.length > kept.length,
  };
}

export async function offsetWellbores(opts: {
  lat: number;
  lon: number;
  radiusMi: number;
  /**
   * An EXPLICIT population, in place of the radius.
   *
   * When present, the radius query is skipped entirely and these wellbores are
   * the population. This exists because the screen and the structural tools were
   * answering about different sets of wells in the same breath: `rrc_well_screen`
   * would report 399 candidates over eight miles while a contact fit beside it
   * ran on the nearest 60 and reported it could not place them. Handing the
   * screened APIs straight in is what makes the two halves of one answer agree.
   *
   * `distanceMi` is measured from `lat`/`lon` when they are finite and is 0
   * otherwise, since a supplied population has no anchor to be far from.
   */
  apis?: readonly string[];
  limit?: number;
  /** Narrows to wells whose RRC field carries this name. See below. */
  formation?: string;
  /**
   * Fetch bottomhole coordinates too. OFF by default, and the default is the
   * whole point: `rrc.well_bottomhole` carries no index at all, so joining it
   * hashes 1.39M rows and costs about a second. That is affordable in a chat
   * turn and is not affordable here, because the geology harness calls this
   * from Stage 1 alongside four other concurrent branches against a 5 second
   * statement timeout, and the branch that overruns is discarded silently.
   *
   * Only lateral geometry needs it. Everything else reads the surface hole.
   */
  includeBottomhole?: boolean;
}): Promise<{ wells: OffsetWellbore[]; truncated: boolean }> {
  // A deployment without the mirror has no offsets, which is a fact about the
  // deployment rather than an error in the turn that asked.
  if (!hasRrcDb()) return { wells: [], truncated: false };

  const limit = Math.min(MAX_BY_API, Math.max(1, Math.floor(opts.limit ?? 25)));
  const supplied = opts.apis?.map((a) => a.trim()).filter(Boolean);
  if (supplied?.length) return byApi(opts, [...new Set(supplied)]);
  const radiusMi = Math.min(25, Math.max(0.05, opts.radiusMi));
  const dLat = radiusMi / 69.0;
  const dLon = radiusMi / (69.0 * Math.max(0.05, Math.cos((opts.lat * Math.PI) / 180)));

  const params: unknown[] = [
    opts.lat,
    opts.lon,
    opts.lat - dLat,
    opts.lat + dLat,
    opts.lon - dLon,
    opts.lon + dLon,
    radiusMi,
  ];
  // There is no formation column on a wellbore. The RRC field name is what
  // carries the target, SPRABERRY (TREND AREA), WOLFCAMP, so that is what a
  // formation filter can honestly match against.
  let fieldFilter = "";
  if (opts.formation?.trim()) {
    params.push(`%${opts.formation.trim()}%`);
    fieldFilter = `and w.field_name ilike $${params.length}`;
  }
  // One more than asked for, so "there are others inside the radius" is
  // observed rather than assumed.
  params.push(limit + 1);

  const rows = await rrcQuery<WellRow>(
    `select * from (
       select distinct on (w.api_number)
              w.api_number, w.operator_name, w.lease_name, l.lat, l.lon,
              ${opts.includeBottomhole ? "b.lat" : "null::float8"} as bottom_lat,
              ${opts.includeBottomhole ? "b.lon" : "null::float8"} as bottom_lon,
              ${DIST} as distance_mi
         from rrc.well_location l
         join rrc.wellbore w on w.api_number = l.api_number
         ${opts.includeBottomhole ? "left join rrc.well_bottomhole b on b.api_number = l.api_number" : ""}
        where l.lat between $3 and $4
          and l.lon between $5 and $6
          and ${DIST} <= $7
          ${fieldFilter}
        -- The on-schedule row is the hole's current assignment. Plugged and
        -- historic wellbores are KEPT: an old hole with formation tops is the
        -- offset a geology question wants most.
        order by w.api_number, w.on_schedule desc nulls last, distance_mi
     ) t
     order by distance_mi
     limit $${params.length}`,
    params
  );

  const truncated = rows.length > limit;
  const kept = rows.slice(0, limit);
  if (kept.length === 0) return { wells: [], truncated: false };

  const wells = await hydrate(kept, opts.lat, opts.lon);
  return { wells, truncated };
}
