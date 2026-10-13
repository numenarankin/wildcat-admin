import "server-only";

import { z } from "zod";

import { hasRrcDb, rrcQuerySlow } from "@/lib/scout/rrc-db";
import { resolveCounty } from "@/lib/scout/rrc-queries";
import { formationWindow, isFormationRefusal } from "../formation-window";
import { RRC_TO_PDQ } from "@/lib/scout/rrc-districts";
import { defineTool, type RrcTool } from "../tool";

/**
 * The population entry point: a screen on the ROCK, with no circle drawn first.
 *
 * Every other geological tool in this codebase is anchored to a point. It takes
 * a lat/lon, pulls the NEAREST N wellbores, and analyses those. That shape is
 * right for "what are my neighbours doing" and it is the wrong shape, totally,
 * for the question this system exists to answer: an operator does something that
 * works and asks where else it can be done.
 *
 * Asked that way, the anchored tools fail in a way that reads like judgement.
 * The nearest-60 cap makes `radius_mi` a no-op past the sixtieth well, so
 * widening the search returns the same wells. The only population filter on the
 * anchored path is `field_name`, and an RRC field designation is an
 * administrative assignment that in many areas tracks one operator, so
 * "filtered on the rock" and "filtered on the operator" were the same act. A
 * screen of Texas came back as six wells belonging to one company.
 *
 * ## What is actually screenable statewide
 *
 * Measured against the mirror on 2026-08-11, and this measurement is the reason
 * the tool has the shape it has:
 *
 *   1,369,124 wellbores
 *     727,898 carry a filed total depth              (53%)
 *     627,107 carry a perforation with a real depth  (46%)
 *     569,114 carry a filed elevation                (42%)
 *      78,060 carry a completion-report formation top (5.7%)
 *
 * Formation tops are the thing a geologist would screen on and they cover one
 * well in eighteen, which is why a screen on filed geology is a screen of
 * whoever filed paperwork. Perforation depth and total depth are the two facts
 * most wells carry, and "TD below Z, nothing perforated in [Z1, Z2]" is
 * expressible in both. Per district the perforation-depth coverage runs 60% to
 * 84% everywhere the state actually drills:
 *
 *   01 79%  02 84%  03 77%  04 77%  05 73%  06 83%  08 83%
 *   09 60%  10 67%  7B 71%  7C 79%  8A 77%  6E 25%  (blank) 19%
 *
 * The two low cells are not districts anybody screens: 6E is the East Texas
 * special district and the 215,267 wellbores with no district assignment are
 * mostly pre-record holes. So the mechanical screen is statewide, and every
 * result says how much of the population it could actually judge rather than
 * quietly presenting the covered wells as the whole state.
 *
 * ## An unmatched well is not a well with no perforation there
 *
 * The distinction the whole tool turns on. A well with no perforation record at
 * all is UNKNOWN, not behind pipe: absence of a filing is not absence of a
 * completion. `behind_pipe` therefore requires the well to carry perforations
 * SOMEWHERE, proving the record exists for it, and none inside the window.
 * Wells without that proof are counted as unscreenable and excluded, never
 * defaulted into the match.
 */

// ------------------------------------------------------------------ limits

/** Rows returned by default. The true match count is always reported. */
const DEFAULT_LIMIT = 50;
/**
 * Hard ceiling on rows. Past this the answer to "which wells" is a count and a
 * breakdown, not a list, because a list of five hundred is not read.
 */
const MAX_LIMIT = 300;
/** Breakdown rows per dimension when the match set is bigger than the page. */
const FACETS = 12;
/**
 * Statewide with no extent filter measured 5.2s, which is over the pool's 5s
 * statement timeout; a district runs in ~1.1s and a county in ~0.5s. The budget
 * is lifted per query rather than globally, exactly as `rrcQuerySlow` documents,
 * because raising it for everything removes the guard that stops an accidental
 * full scan taking a page down.
 */
const BUDGET_MS = 25_000;

const PERF_STATES = ["behind_pipe", "perforated", "penetrated"] as const;

/**
 * The rock, the perforation state, and the extent. No lat/lon required.
 *
 * `depth_top_ft` and `depth_bottom_ft` are MEASURED depth on the operator's own
 * filings, not subsea. That is deliberate at this stage: the depths being
 * compared are the well's own perforations against the well's own total depth,
 * both from that one hole's paperwork, so no datum conversion is involved and
 * none is applied. Structural work on the survivors is a separate call, on a
 * population that has already been cut down to a size where a datum can be
 * argued about honestly.
 */
const POPULATION_SHAPE = {
  depth_top_ft: z.number().optional(),
  depth_bottom_ft: z.number().optional(),
  /**
   * The rock by NAME, instead of by depth.
   *
   * Resolved through the alias table the geology side builds from
   * `rrc.completion_formation` (see `../formation-window.ts`), which gives the
   * p10 to p90 spread of where that unit's top is filed in the county asked
   * about. Needs `county`, because a formation is at a different depth in every
   * one of them, and it refuses outside the six counties the table covers
   * rather than extrapolating a window into ground nobody filed.
   *
   * Either this plus a county, or an explicit depth window. Never neither: a
   * screen with no depth in it is not a screen.
   */
  formation: z.string().optional(),
  perforation_state: z.enum(PERF_STATES).optional(),
  county: z.string().optional(),
  district: z.string().optional(),
  operator_no: z.string().optional(),
  /**
   * Drop one operator's wells from the population.
   *
   * Point it at your own operator number when the question is what to BUY. A
   * screen that answers "where else can this be repeated" with wells the asker
   * already operates has answered a different question, and the live failure
   * was exactly that: the candidate list led with the user's own inventory.
   */
  exclude_operator_no: z.string().optional(),
  field_name: z.string().optional(),
  /** [south, west, north, east] in degrees. */
  bbox: z.array(z.number()).optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  /**
   * A well to centre the circle on, instead of coordinates.
   *
   * "Everything within 10 miles of Repass 2" is how the question is asked, and
   * the asker has an API number, not a latitude. Measured live: the model
   * passed `api` with `radius_mi` twice, was refused both times for missing
   * lat/lon, and burned two of the turn's steps looking them up.
   */
  api: z.string().optional(),
  radius_mi: z.number().optional(),
  exclude_plugged: z.boolean().optional(),
  limit: z.number().int().optional(),
};

// ------------------------------------------------------------------ types

interface ScreenRow {
  api_number: string;
  operator_name: string | null;
  /** The key every other tool filters on. The name is only a label. */
  operator_number: string | null;
  lease_name: string | null;
  well_no: string | null;
  field_name: string | null;
  county_name: string | null;
  district: string | null;
  total_depth: number | null;
  shallowest_perf_ft: number | null;
  deepest_perf_ft: number | null;
  perf_intervals: number | null;
  plug_date: string | null;
  elevation_ft: number | null;
  elevation_code: string | null;
  plug_back_ft: number | null;
  /** LEASE grain. Texas files oil per lease; this is not this well's volume. */
  lease_oil_bbl_recent: number | null;
  lease_gas_mcf_recent: number | null;
  /** YYYY-MM of the last cycle the lease reported a volume, or null. */
  lease_last_produced: string | null;
  /** True where a filed perforation sits below the hole's own filed TD. */
  perfs_below_filed_td: boolean | null;
  lat: number | null;
  lon: number | null;
}

interface Facet {
  key: string | null;
  wells: number;
}

interface ScreenResult {
  population: {
    wells_in_extent: number;
    with_total_depth: number;
    with_perforation_depths: number;
    screenable: number;
    unscreenable: number;
    penetrated_the_window: number;
    perforated_in_window: number;
    behind_pipe: number;
    penetrated_with_no_perforation_record: number;
  };
  matched: number;
  wells: ScreenRow[] | null;
  by_county: Facet[] | null;
  by_operator: Facet[] | null;
  by_field: Facet[] | null;
}

function fail(error: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, error, ...extra };
}

/** A refusal's own fields, minus the message `fail` is already carrying. */
function omitError(r: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => k !== "error"));
}

// ------------------------------------------------------------------ extent

/** One WHERE clause plus the parameters it consumed. */
interface Extent {
  where: string[];
  /**
   * Filters that must run AFTER the one-row-per-wellbore dedup.
   *
   * A wellbore carries a row per lease and field it has ever been assigned to,
   * and those rows can name DIFFERENT operators across its life. Excluding
   * `operator_number = X` in the inner WHERE therefore removes X's ROWS and not
   * X's WELLS: a hole X operates today that a previous owner also filed on
   * survives, wearing the old owner's name. Measured live, that leaked four
   * wells back into a screen that had excluded their operator.
   *
   * So anything about the well's CURRENT standing is applied to the row the
   * dedup chose, which is the on-schedule one.
   */
  postWhere: string[];
  params: unknown[];
  needsLocation: boolean;
  described: Record<string, string | number>;
}

/**
 * Turn the extent arguments into SQL, or into a refusal that names the problem.
 *
 * No extent at all is LEGAL and means statewide. That is the whole unlock: the
 * previous generation of these tools could not express a question bigger than
 * the nearest hundred wells, so a statewide screen was reported to the user as
 * impossible when it costs five seconds.
 */
/** The surface location of one well, for an api-anchored circle. */
async function anchorOf(api: string): Promise<{ lat: number; lon: number } | { error: string }> {
  const rows = await rrcQuerySlow<{ lat: number | null; lon: number | null }>(
    `select lat, lon from rrc.well_location where api_number = $1 limit 1`,
    [api.trim()],
    5_000
  );
  const p = rows[0];
  if (p?.lat == null || p.lon == null) {
    return { error: `No surface location on file for API ${api.trim()}, so a circle cannot be centred on it. Screen by county, district or bbox instead.` };
  }
  return { lat: p.lat, lon: p.lon };
}

function buildExtent(
  a: z.infer<z.ZodObject<typeof POPULATION_SHAPE>>,
  params: unknown[]
): Extent | { error: string } {
  const where: string[] = [];
  const postWhere: string[] = [];
  const described: Record<string, string | number> = {};
  let needsLocation = false;
  const push = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (a.county?.trim()) {
    const c = resolveCounty(a.county);
    if (!c) return { error: `Not a Texas county: "${a.county}".` };
    where.push(`w.county_code = ${push(c.county_no)}`);
    described.county = c.county_name;
  }

  if (a.district?.trim()) {
    const label = a.district.trim().toUpperCase();
    if (!RRC_TO_PDQ[label]) {
      return {
        error: `Not an RRC district: "${a.district}". Use the district label: ${Object.keys(RRC_TO_PDQ).join(", ")}.`,
      };
    }
    // The wellbore tape carries the EWA label, which is the one a person says.
    // No PDQ translation here because nothing in this screen touches the
    // production tape; see `rrc-districts.ts` for why that distinction matters.
    where.push(`w.district = ${push(label)}`);
    described.district = label;
  }

  if (a.operator_no?.trim()) {
    const op = a.operator_no.trim();
    // Both sides. The inner copy is a cheap prefilter that can use
    // `wellbore_op_idx` and is a strict superset of the answer; the outer copy
    // is what makes it mean "operates this well TODAY" rather than "ever filed
    // on it". Dropping the inner one costs a full scan on a statewide fleet
    // screen; dropping the outer one returns wells they no longer hold.
    where.push(`w.operator_number = ${push(op)}`);
    postWhere.push(`operator_number = ${push(op)}`);
    described.operator_no = op;
  }

  if (a.field_name?.trim()) {
    where.push(`w.field_name ilike ${push(`%${a.field_name.trim()}%`)}`);
    described.field_name = a.field_name.trim();
  }

  if (a.bbox) {
    if (a.bbox.length !== 4 || a.bbox.some((n) => !Number.isFinite(n))) {
      return { error: "bbox is [south, west, north, east] in degrees." };
    }
    const [south, west, north, east] = a.bbox;
    if (south >= north || west >= east) {
      return { error: "bbox must read [south, west, north, east], south below north and west below east." };
    }
    needsLocation = true;
    where.push(`l.lat between ${push(south)} and ${push(north)}`);
    where.push(`l.lon between ${push(west)} and ${push(east)}`);
    described.bbox = `${south},${west},${north},${east}`;
  }

  if (a.lat != null || a.lon != null || a.radius_mi != null) {
    if (a.lat == null || a.lon == null) {
      return { error: "A circle needs both lat and lon, or an api to centre on. Omit all three for a screen by county, district or bbox." };
    }
    // No cap on the radius and no nearest-N ordering. This is a FILTER, so a
    // wider circle returns more wells rather than the same ones; the anchored
    // tools' behaviour, where 15 miles and 40 miles gave the same sixty wells,
    // is the defect this tool exists to remove.
    const radiusMi = Math.max(0.1, a.radius_mi ?? 5);
    const dLat = radiusMi / 69.0;
    const dLon = radiusMi / (69.0 * Math.max(0.05, Math.cos((a.lat * Math.PI) / 180)));
    needsLocation = true;
    where.push(`l.lat between ${push(a.lat - dLat)} and ${push(a.lat + dLat)}`);
    where.push(`l.lon between ${push(a.lon - dLon)} and ${push(a.lon + dLon)}`);
    where.push(
      `3958.7613 * acos(least(1, greatest(-1,
         sin(radians(${push(a.lat)})) * sin(radians(l.lat)) +
         cos(radians(${push(a.lat)})) * cos(radians(l.lat)) * cos(radians(l.lon) - radians(${push(a.lon)}))))) <= ${push(radiusMi)}`
    );
    described.center = `${a.lat},${a.lon}`;
    described.radius_mi = radiusMi;
  }

  if (a.exclude_operator_no?.trim()) {
    // OUTER ONLY. An inner exclusion would drop this operator's rows and let an
    // older row for the same hole win the dedup, so the well comes back under a
    // previous owner's name instead of leaving.
    postWhere.push(`operator_number is distinct from ${push(a.exclude_operator_no.trim())}`);
    described.excluding_operator_no = a.exclude_operator_no.trim();
  }

  if (a.exclude_plugged) {
    // Outer, for the same reason: plugged status belongs to the hole's current
    // row, and filtering it inside would change which row represents the hole.
    postWhere.push(`plug_date is null`);
    described.exclude_plugged = "yes";
  }

  return { where, postWhere, params, needsLocation, described };
}


/**
 * The depth window a call is screening on, however it was asked for.
 *
 * Explicit depths win when both are given, because a caller who typed numbers
 * meant them. Otherwise a formation name plus a county is resolved through the
 * filings. A refusal here is returned to the model as a value, with what to do
 * about it, since "that county is not covered" is something it can act on and
 * an exception is not.
 */
function resolveWindow(a: {
  depth_top_ft?: number;
  depth_bottom_ft?: number;
  formation?: string;
  county?: string;
}):
  | { top: number; bottom: number; from?: ReturnType<typeof formationWindow> }
  | { error: string; [key: string]: unknown } {
  const named = a.formation?.trim();
  if (a.depth_top_ft != null && a.depth_bottom_ft != null) {
    const top = Math.min(a.depth_top_ft, a.depth_bottom_ft);
    const bottom = Math.max(a.depth_top_ft, a.depth_bottom_ft);
    if (!(bottom > top) || top < 0 || bottom > 40_000) {
      return {
        error:
          "depth_top_ft and depth_bottom_ft must be a real interval in feet, top above bottom, inside 0 to 40,000.",
      };
    }
    return { top, bottom };
  }
  if (!named) {
    return {
      error:
        "Give a depth window (depth_top_ft and depth_bottom_ft) or a formation name plus a county. A screen with no depth in it is not a screen.",
    };
  }
  if (!a.county?.trim()) {
    return {
      error: `A formation sits at a different depth in every county, so "${named}" needs a county to become a depth window. Name one, or give explicit depths.`,
    };
  }
  const resolved = formationWindow(named, a.county);
  if (isFormationRefusal(resolved)) return { ...resolved };
  return { top: resolved.top_ft, bottom: resolved.bottom_ft, from: resolved };
}

// ------------------------------------------------------------- shared query

/**
 * The population, as three CTEs, shared by every tool in this file.
 *
 * Written once because the two tools below must screen the SAME wells. If the
 * analog engine's denominator were assembled by its own copy of this SQL, the
 * base rate it quotes and the candidate list beside it would be counted over
 * two slightly different populations, and nothing about that disagreement would
 * be visible: both numbers would look right and the ratio between them would be
 * wrong. Parameters $1 and $2 are the depth window in every caller.
 */
function populationCte(locationJoin: string, whereSql: string, postWhereSql = ""): string {
  return `with chosen as (
  select distinct on (w.api_number)
         w.api_number, w.operator_name, w.lease_name, w.well_no, w.field_name,
         w.county_name, w.district, nullif(w.plug_date, '') as plug_date,
         w.operator_number, w.oil_gas_code, nullif(w.lease_number, '') as lease_number,
         -- Everything status-shaped on this tape is populated ONLY on the
         -- on-schedule row (440k of 1.37M), which is the row the DISTINCT ON
         -- below already prefers. A historic-only wellbore carries blanks, so
         -- these read as unknown rather than as a clean bill of health.
         nullif(trim(w.p5_org_status), '') as p5_org_status,
         nullif(trim(w.wb_14b2_flag), '') as wb_14b2_flag,
         nullif(trim(w.h15_status_code), '') as h15_status_code,
         -- Guarded: plug_date is free text on the tape, so a malformed value
         -- would abort the whole screen rather than skip one well.
         case when w.plug_date ~ '^[0-9]{8}$' then to_date(w.plug_date, 'YYYYMMDD') end as plugged_on,
         l.lat, l.lon
    from rrc.wellbore w
    ${locationJoin}
   ${whereSql}
   -- The on-schedule row is the hole's current assignment. A wellbore carries
   -- one row per lease and field it has ever been assigned to, so without this
   -- a single hole is counted, matched and returned several times over.
   --
   -- The tiebreakers after it are NOT decoration. on_schedule alone is not a
   -- total order: a hole with several rows carrying the same flag left the
   -- choice to whatever the planner returned first, so the operator, county,
   -- field and lease attached to that wellbore changed between identical calls.
   -- Measured: three consecutive runs of one screen gave the top operator 139,
   -- 135 and 138 candidates. The match COUNT was stable, which is why this hid
   -- until a question was asked about ownership. Every column below is part of
   -- the row's own grain (well x operator x field x lease), so the order is
   -- total and the same row wins every time.
   order by w.api_number,
            w.on_schedule desc nulls last,
            (w.operator_number is not null) desc,
            w.operator_number nulls last,
            w.field_number nulls last,
            w.lease_number nulls last
),
extent as (
  select * from chosen
   ${postWhereSql}
),
perf as (
  select p.api_number,
         count(*) filter (where p.top_ft > 0) as perf_with_depth,
         count(*) filter (where p.top_ft <= $2 and p.bottom_ft >= $1) as in_window,
         min(p.top_ft) filter (where p.top_ft > 0) as shallowest_perf_ft,
         max(p.bottom_ft) filter (where p.bottom_ft > 0) as deepest_perf_ft,
         -- When this hole was FIRST shot in the window. The clock the base rate
         -- is measured on: a plug is only evidence against the zone if it came
         -- after somebody tried it.
         min(p.file_date) filter (where p.top_ft <= $2 and p.bottom_ft >= $1)
           as first_window_perf_on
    from rrc.wb_perf p
   -- Perforations belong to a FILING, and a recompleted hole carries several
   -- sets. Every set counts here on purpose: the question is whether this hole
   -- was EVER shot in the window, not what its newest filing says.
   where exists (select 1 from extent e where e.api_number = p.api_number)
   group by p.api_number
),
/*
 * What the LEASE this hole sits on has actually made lately.
 *
 * The unit of analysis is the WELL, and until this existed nothing on a well
 * said whether it was any good. Candidates were ranked geometrically, on how
 * much room sat between the target window and the shallowest existing
 * perforation, which measures opportunity and not quality. The only block in
 * the result carrying a business signal was the operator summary, so the answer
 * organised itself around whoever held the most holes and looked most
 * distressed. That is concentration by artifact.
 *
 * LEASE GRAIN, and it cannot be otherwise: Texas files oil per lease, so there
 * is no per-well volume in this record at all. A lease making nothing for two
 * years is a fact about every well on it; a lease making 900 bbl a month is not
 * evidence that THIS hole makes any of it. Both are worth far more than
 * nothing, and every field below says lease in its name so the grain travels
 * with the number.
 *
 * The district translation is load-bearing. wellbore.district is the EWA
 * label and lease_production.district_no is the PDQ code, and joining them
 * directly returns a real lease belonging to somebody else. Measured on the
 * county below: without the translation the twelve-month oil came back
 * 50,359,190 bbl, with it 904,972.
 */
lease_prod as (
  select lp.oil_gas_code, lp.district_no, lp.lease_no,
         sum(lp.oil_prod_vol) as oil_bbl,
         sum(lp.gas_prod_vol + lp.csgd_prod_vol) as gas_mcf,
         max(lp.cycle) filter (where lp.oil_prod_vol > 0 or lp.gas_prod_vol > 0)
           as last_producing_cycle
    from rrc.lease_production lp
    join (
      select distinct e.oil_gas_code, pdq.pdq as district_no, e.lease_number as lease_no
        from extent e
        join (values ('01','01'),('02','02'),('03','03'),('04','04'),('05','05'),
                     ('06','06'),('6E','07'),('7B','08'),('7C','09'),('08','10'),
                     ('8A','11'),('09','13'),('10','14')) as pdq(ewa, pdq)
          on pdq.ewa = e.district
       where nullif(e.lease_number, '') is not null
    ) k on k.oil_gas_code = lp.oil_gas_code
       and k.district_no = lp.district_no
       and k.lease_no = lp.lease_no
   where lp.cycle >= date_trunc('month', current_date) - interval '15 months'
   group by 1, 2, 3
),
pop as (
  select e.*, r.total_depth,
         lpr.oil_bbl as lease_oil_bbl_recent,
         lpr.gas_mcf as lease_gas_mcf_recent,
         lpr.last_producing_cycle as lease_last_produced,
         -- One number to sort on, at six mcf to the barrel. Named for its grain
         -- so it cannot be quoted as this well's production.
         (coalesce(lpr.oil_bbl, 0) + coalesce(lpr.gas_mcf, 0) / 6.0) as lease_boe_recent,
         coalesce(pf.perf_with_depth, 0) as perf_with_depth,
         coalesce(pf.in_window, 0) as in_window,
         pf.shallowest_perf_ft, pf.deepest_perf_ft, pf.first_window_perf_on,
         -- A FILED PERFORATION IS PROOF OF PENETRATION, and reading total depth
         -- alone is not. Total depth is absent on 47% of Texas wellbores, and
         -- measured on this mirror there are wells whose deepest perforation is
         -- below the total depth on file. A hole that was shot at 4,100 ft
         -- reached 4,100 ft whatever the paperwork says about TD, so the deepest
         -- thing the record can prove is what decides this.
         (greatest(coalesce(r.total_depth, 0), coalesce(pf.deepest_perf_ft, 0)) >= $2)
           as penetrated
    from extent e
    left join rrc.wb_root r on r.api_number = e.api_number
    left join perf pf on pf.api_number = e.api_number
    left join lease_prod lpr
      on lpr.oil_gas_code = e.oil_gas_code
     and lpr.lease_no = e.lease_number
     and lpr.district_no = (case e.district
           when '6E' then '07' when '7B' then '08' when '7C' then '09'
           when '08' then '10' when '8A' then '11' when '09' then '13'
           when '10' then '14' else e.district end)
)`;
}

/** The filing lateral, for the rows a tool actually returns and no others. */
const RETURNED_ROW_DETAIL = `left join lateral (
          select wf.elevation, nullif(wf.elevation_code, '') as elevation_code,
                 nullif(greatest(coalesce(wf.plug_back_depth1, 0),
                                 coalesce(wf.plug_back_depth2, 0)), 0) as plug_back_ft
            from rrc.wb_filing wf
           where wf.api_number = p.api_number
           order by wf.file_date desc nulls last
           limit 1) f on true`;

// ------------------------------------------------------------------ the tool

const wellScreen = defineTool(
  "rrc_well_screen",
  "Which wells in Texas penetrated a depth window and were never perforated in it? The population entry point: screens on depth and perforation state with NO lat/lon anchor, over a county, district, bbox, circle, operator, field or the whole state, and returns the TRUE match count. Use this before any analysis that needs a set of wells, then pass its api list on.",
  POPULATION_SHAPE,
  async (a) => {
    if (!hasRrcDb()) {
      return fail("The Texas RRC mirror is not configured in this environment.");
    }

    const window = resolveWindow(a);
    if ("error" in window) return fail(window.error, omitError(window));
    const { top, bottom } = window;
    const state = a.perforation_state ?? "behind_pipe";
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(a.limit ?? DEFAULT_LIMIT)));

    // Window bounds are parameters 1 and 2 for every branch below.
    const params: unknown[] = [top, bottom];
    // An api-anchored circle becomes a lat/lon one before the extent is built,
    // so there is one code path for a circle and not two.
    let anchored = a;
    if (a.api?.trim() && a.lat == null && a.lon == null) {
      const at = await anchorOf(a.api);
      if ("error" in at) return fail(at.error);
      anchored = { ...a, lat: at.lat, lon: at.lon, radius_mi: a.radius_mi ?? 5 };
    }
    const extent = buildExtent(anchored, params);
    if ("error" in extent) return fail(extent.error);

    const whereSql = extent.where.length ? `where ${extent.where.join("\n     and ")}` : "";
    const locationJoin = extent.needsLocation
      ? "join rrc.well_location l on l.api_number = w.api_number"
      : "left join rrc.well_location l on l.api_number = w.api_number";
    const postWhereSql = extent.postWhere.length
      ? `where ${extent.postWhere.join("\n     and ")}`
      : "";

    /*
     * The match predicate, and the three states are NOT symmetric.
     *
     *   penetrated  - the hole reached the window. Says nothing about
     *                 completion, and is the honest denominator for the others.
     *   perforated  - a filed perforation overlaps the window. This is the
     *                 population that TRIED the zone, which is what a base rate
     *                 is computed over.
     *   behind_pipe - reached it, is known to carry perforations somewhere, and
     *                 has none in the window. The uphole candidate.
     *
     * `behind_pipe` is the only one that requires proof the record exists for
     * the well, because it is the only one asserting a NEGATIVE.
     */
    const MATCH: Record<(typeof PERF_STATES)[number], string> = {
      penetrated: "penetrated",
      perforated: "in_window > 0",
      behind_pipe: "penetrated and perf_with_depth > 0 and in_window = 0",
    };
    const match = MATCH[state];

    const limitParam = `$${params.push(limit)}`;
    const facetParam = `$${params.push(FACETS)}`;

    const sql = `
${populationCte(locationJoin, whereSql, postWhereSql)},
hits as (
  select * from pop where ${match}
),
page as (
  select * from hits
   -- Unplugged first, then the biggest standoff between the target window and
   -- whatever is currently open, because that gap IS the move being screened
   -- for. Stated on the result as ordered_by so a reader never has to guess
   -- whether a ranking was applied.
   /*
    * The WELL is the unit, so the ranking has to carry a signal about the well.
    *
    * This used to be geometry alone: unplugged, then the biggest gap between
    * the target window and whatever is currently open. That measures how much
    * room there is, which is opportunity, not quality. With no other signal on
    * a row, the only part of the result that meant anything commercially was
    * the operator summary, and answers organised themselves around whoever held
    * the most holes rather than around the best ones.
    *
    * So a live lease outranks a dead one, and a bigger one outranks a smaller,
    * before the geometry breaks the tie. Lease grain is a real limit and it is
    * still worth more than nothing: a candidate on a lease that has not
    * produced since 1994 is a different proposition from one on a lease making
    * money this month, and that difference was invisible.
    */
   order by (plug_date is null) desc,
            (lease_last_produced is not null) desc,
            lease_boe_recent desc nulls last,
            coalesce(shallowest_perf_ft, 0) - $2 desc,
            api_number
   limit ${limitParam}
)
select json_build_object(
  'population', (select json_build_object(
      'wells_in_extent', count(*),
      'with_total_depth', count(*) filter (where total_depth > 0),
      'with_perforation_depths', count(*) filter (where perf_with_depth > 0),
      'screenable', count(*) filter (where total_depth > 0 and perf_with_depth > 0),
      'unscreenable', count(*) filter (where not (total_depth > 0 and perf_with_depth > 0)),
      'penetrated_the_window', count(*) filter (where penetrated),
      -- The three buckets the wells that REACHED the window fall into, and they
      -- are here so the arithmetic can be CHECKED: these three must sum to
      -- penetrated_the_window exactly. Without the third one a reader cannot
      -- tell a well that was never shot in the window from a well whose record
      -- does not say either way, which is the one distinction this screen turns
      -- on.
      'perforated_in_window', count(*) filter (where penetrated and in_window > 0),
      'behind_pipe',
        count(*) filter (where penetrated and perf_with_depth > 0 and in_window = 0),
      'penetrated_with_no_perforation_record',
        count(*) filter (where penetrated and perf_with_depth = 0)) from pop),
  'matched', (select count(*) from hits),
  'by_county', (select json_agg(x) from (
      select county_name as key, count(*)::int as wells from hits
       group by 1 order by 2 desc nulls last limit ${facetParam}) x),
  'by_operator', (select json_agg(x) from (
      select operator_name as key, count(*)::int as wells from hits
       group by 1 order by 2 desc nulls last limit ${facetParam}) x),
  'by_field', (select json_agg(x) from (
      select field_name as key, count(*)::int as wells from hits
       group by 1 order by 2 desc nulls last limit ${facetParam}) x),
  'wells', (select json_agg(y) from (
      select p.api_number, p.operator_name, p.operator_number, p.lease_name, p.well_no, p.field_name,
             p.county_name, p.district, p.total_depth,
             p.shallowest_perf_ft, p.deepest_perf_ft, p.in_window as perf_intervals,
             -- A perforation below the hole's own filed total depth. Either the
             -- TD is wrong or the hole is deviated, and on a horizontal the
             -- measured depths are not comparable with a vertical's at all. It
             -- ranked a Barnett lateral beside vertical Marble Falls wells with
             -- nothing to mark the difference, so the flag travels with the row.
             -- Written as "is true" rather than a bare comparison: with no filed TD the
             -- comparison is NULL, and a null boolean makes the reader decide
             -- what it meant. The flag asserts positive evidence of a perf
             -- below the filed TD, so no evidence is false, not unknown.
             ((p.deepest_perf_ft > p.total_depth) is true) as perfs_below_filed_td,
             p.plug_date, p.lat, p.lon,
             p.lease_oil_bbl_recent, p.lease_gas_mcf_recent,
             to_char(p.lease_last_produced, 'YYYY-MM') as lease_last_produced,
             f.elevation as elevation_ft, f.elevation_code,
             f.plug_back_ft
        from page p
        -- Only for the rows actually returned. Running this lateral over the
        -- whole population would be a filing lookup per well across the state.
        ${RETURNED_ROW_DETAIL}) y)
) as result`;

    const rows = await rrcQuerySlow<{ result: ScreenResult }>(sql, params, BUDGET_MS);
    const r = rows[0]?.result;
    if (!r) return fail("The screen returned nothing at all, which means the query failed rather than matching zero wells.");

    const wells = r.wells ?? [];
    const complete = r.matched <= wells.length;

    return {
      ok: true as const,
      screen: {
        depth_window_ft: [top, bottom],
        formation: window.from ?? undefined,
        perforation_state: state,
        ...extent.described,
        statewide: extent.where.length === 0 || undefined,
      },
      population: r.population,
      /** The TRUE count of wells meeting the screen. Not the rows below. */
      matched: r.matched,
      returned: wells.length,
      is_complete: complete,
      ordered_by:
        "unplugged first, then leases still producing, then the lease's recent volume, then the largest gap between the top of the target window and the shallowest existing perforation",
      wells,
      by_county: r.by_county ?? [],
      by_operator: r.by_operator ?? [],
      by_field: r.by_field ?? [],
      guidance: guidance(r, state, complete, top, bottom, wells.length),
    };
  }
);

/**
 * INSTRUCTIONS TO THE MODEL. Not text for the operator.
 *
 * Written as sentences rather than flags because the failure being guarded
 * against is a caption, not a calculation: the previous generation of results
 * carried a `truncated` boolean and it was skimmed past twice in one
 * conversation.
 *
 * Sentences turned out to have their own failure, and it is the reason the
 * field is called `guidance` rather than `notes`. Handed a result whose notes
 * read like prose, the model RELAYED them: an answer to "what could I buy"
 * opened with "First, the limitation", confessed which arguments it had chosen,
 * explained that the list was capped, and closed with a section headed "What I
 * did not do". None of that is an answer. The person asking has run wells for
 * thirty years, is not debugging a screen, and wanted the wells.
 *
 * So the first line of every result says who this is for, and the persona rule
 * against naming the machinery covers the rest.
 */
function guidance(
  r: ScreenResult,
  state: string,
  complete: boolean,
  top: number,
  bottom: number,
  listed: number
): string[] {
  const out: string[] = ["INTERNAL. Act on these. Never quote or paraphrase one."];

  /*
   * The completion half, and it is here because the caution below was being
   * read as a ban.
   *
   * Told only that a capped list is never a population, the model stopped
   * naming wells at all: asked what it could buy, it answered with county
   * totals and an apology, twice.
   */
  if (complete) {
    out.push(`complete: every one of the ${r.matched.toLocaleString()} matches is in wells. Name them.`);
  } else {
    // Narrowing that would actually FIT, computed rather than suggested in the
    // abstract. "Narrow by county" is advice; `operator_no "PETEX" (94)` is an
    // instruction the model can act on in one more call.
    const fits = [
      ...(r.by_county ?? []).map((f) => ({ ...f, arg: "county" })),
      ...(r.by_field ?? []).map((f) => ({ ...f, arg: "field_name" })),
      ...(r.by_operator ?? []).map((f) => ({ ...f, arg: "operator_no" })),
    ]
      // Measured against the tool's CEILING, not against this call's limit. At
      // limit 5 nothing fits under 5, and the fallback then said "narrow it"
      // without naming anything, which is the abstract advice this list exists
      // to replace. A facet that fits at limit 300 is actionable in one call.
      .filter((f) => f.key && f.wells > 0 && f.wells <= MAX_LIMIT)
      .slice(0, 5)
      .map((f) => `${f.arg}=${f.key} (${f.wells})`);
    out.push(
      `sample: ${listed} of ${r.matched.toLocaleString()}. Narrow and call again before naming candidates. ` +
        (fits.length
          ? `These come back complete with limit ${MAX_LIMIT}: ${fits.join(", ")}.`
          : `Add county, district, field_name, operator_no or bbox, or tighten the depth window. limit max ${MAX_LIMIT}.`)
    );
    out.push("facets are over all matches. Rows are not.");
  }

  const p = r.population;
  if (p.unscreenable > 0) {
    out.push(
      `${p.unscreenable.toLocaleString()} of ${p.wells_in_extent.toLocaleString()} wellbores unjudgeable (no filed TD or perf depth). Excluded, not misses.`
    );
  }
  if (state === "behind_pipe") {
    out.push(`behind_pipe = reached ${bottom} ft, has perfs somewhere, none in ${top}-${bottom}.`);
    out.push("plug_back_ft above the window means drilling out, not just perforating. Say so per well.");
    out.push("perfs_below_filed_td=true means the filed TD is wrong or the hole is deviated. Do not rank one of those beside a vertical without saying which it is.");
    out.push("where-else / what-to-buy: use rrc_analog_screen, not this.");
  }
  out.push("lease_* fields are LEASE grain, never this well's production. Texas files oil per lease. Say lease when you quote one.",
    "the WELL is the unit. owners is a lookup for who to approach, not a ranking of what to buy.",
    "depth and perforation state only. No tops, no subsea.");
  return out;
}

// --------------------------------------------------------- the analog engine

interface AnalogResult {
  tried: {
    wells: number;
    still_on_schedule: number;
    plugged_after_shooting_it: number;
    plugged_within_5_years: number;
    median_years_from_shooting_it_to_plugging: number | null;
    dated: number;
  };
  available: number;
  candidates_with_no_operator_on_file: number;
  candidates: ScreenRow[] | null;
  owners: Owner[] | null;
  by_county: Facet[] | null;
}

/** One operator's position inside the screened extent. Flags, never a score. */
interface Owner {
  operator_number: string | null;
  operator_name: string | null;
  candidates: number;
  of_which_plugged: number;
  wells_in_extent: number;
  wells_on_the_14b2_clock: number;
  wells_plugged_in_extent: number;
  /** "active" | "lapsed or delinquent" | "unknown". Never a bare code. */
  p5_standing: string;
  p5_org_status: string | null;
  h15_status_code: string | null;
}

/**
 * The analog engine's shape, which is the population shape MINUS two arguments.
 *
 * `perforation_state` is gone because this tool reads both states at once, by
 * definition: the wells that tried the window are the base rate and the wells
 * that have not are the candidates. Leaving the argument in the schema would
 * have made it a silently ignored knob, which is worse than not having it.
 *
 * `exclude_plugged` is gone because it would have quietly destroyed the answer.
 * Applied here it would drop plugged wells from the denominator, and the plugged
 * wells ARE the failures: the base rate would come back near zero, correct
 * arithmetic over a population selected to exclude every negative outcome.
 * Filter the candidate list for plugged holes with `rrc_well_screen` if that is
 * what is wanted, where it means what it says.
 */
const ANALOG_SHAPE = Object.fromEntries(
  Object.entries(POPULATION_SHAPE).filter(
    ([key]) => key !== "perforation_state" && key !== "exclude_plugged"
  )
) as Omit<typeof POPULATION_SHAPE, "perforation_state" | "exclude_plugged">;

const analogScreen = defineTool(
  "rrc_analog_screen",
  "A completion worked. Where else can it be repeated, and how often has it failed? Returns the BASE RATE first (every well that shot this depth window in the extent, how many were plugged afterwards and how fast), then the wells that penetrated the window and never perforated it. Both counted over the same population, so the ratio between them is real.",
  ANALOG_SHAPE,
  async (a) => {
    if (!hasRrcDb()) {
      return fail("The Texas RRC mirror is not configured in this environment.");
    }

    const window = resolveWindow(a);
    if ("error" in window) return fail(window.error, omitError(window));
    const { top, bottom } = window;
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(a.limit ?? DEFAULT_LIMIT)));

    const params: unknown[] = [top, bottom];
    // An api-anchored circle becomes a lat/lon one before the extent is built,
    // so there is one code path for a circle and not two.
    let anchored = a;
    if (a.api?.trim() && a.lat == null && a.lon == null) {
      const at = await anchorOf(a.api);
      if ("error" in at) return fail(at.error);
      anchored = { ...a, lat: at.lat, lon: at.lon, radius_mi: a.radius_mi ?? 5 };
    }
    const extent = buildExtent(anchored, params);
    if ("error" in extent) return fail(extent.error);

    const whereSql = extent.where.length ? `where ${extent.where.join("\n     and ")}` : "";
    const locationJoin = extent.needsLocation
      ? "join rrc.well_location l on l.api_number = w.api_number"
      : "left join rrc.well_location l on l.api_number = w.api_number";
    const postWhereSql = extent.postWhere.length
      ? `where ${extent.postWhere.join("\n     and ")}`
      : "";
    const limitParam = `$${params.push(limit)}`;
    const facetParam = `$${params.push(FACETS)}`;

    /*
     * Why the outcome is measured from the PERFORATION and not from the well.
     *
     * A hole drilled in 1954 and plugged in 2019 tells you nothing about a zone
     * somebody shot in 2014. The base rate has to be conditional on the attempt:
     * of the wells that tried this window, how many were abandoned AFTER trying
     * it, and how long they lasted. Wells plugged before they were ever shot in
     * the window are excluded from the ratio, not counted as failures.
     *
     * This is deliberately the crudest honest outcome measure the mirror can
     * support at population scale. Production is filed per LEASE, so a per-well
     * before-and-after needs the allocation machinery and one query per well;
     * `rrc_recompletion_outcomes` does exactly that for a handful of offsets and
     * is the right follow-up on the survivors. Plugging is filed per WELLBORE,
     * which is why it scales to a statewide denominator.
     */
    const sql = `
${populationCte(locationJoin, whereSql, postWhereSql)},
tried as (
  select * from pop where in_window > 0
),
outcome as (
  select *,
         (plugged_on is not null and first_window_perf_on is not null
          and plugged_on > first_window_perf_on) as failed_after,
         case when plugged_on is not null and first_window_perf_on is not null
                   and plugged_on > first_window_perf_on
              then (plugged_on - first_window_perf_on) / 365.25 end as years_to_plug
    from tried
),
available as (
  select * from pop where penetrated and perf_with_depth > 0 and in_window = 0
),
page as (
  select * from available
   /*
    * The WELL is the unit, so the ranking has to carry a signal about the well.
    *
    * This used to be geometry alone: unplugged, then the biggest gap between
    * the target window and whatever is currently open. That measures how much
    * room there is, which is opportunity, not quality. With no other signal on
    * a row, the only part of the result that meant anything commercially was
    * the operator summary, and answers organised themselves around whoever held
    * the most holes rather than around the best ones.
    *
    * So a live lease outranks a dead one, and a bigger one outranks a smaller,
    * before the geometry breaks the tie. Lease grain is a real limit and it is
    * still worth more than nothing: a candidate on a lease that has not
    * produced since 1994 is a different proposition from one on a lease making
    * money this month, and that difference was invisible.
    */
   order by (plug_date is null) desc,
            (lease_last_produced is not null) desc,
            lease_boe_recent desc nulls last,
            coalesce(shallowest_perf_ft, 0) - $2 desc,
            api_number
   limit ${limitParam}
)
select json_build_object(
  'tried', (select json_build_object(
      'wells', count(*),
      'still_on_schedule', count(*) filter (where plug_date is null),
      'plugged_after_shooting_it', count(*) filter (where failed_after),
      'plugged_within_5_years', count(*) filter (where years_to_plug <= 5),
      'median_years_from_shooting_it_to_plugging',
        round(percentile_cont(0.5) within group (order by years_to_plug)::numeric, 1),
      -- The denominator behind the two figures above. Perforation filings carry
      -- no date on some old holes, so the ratio is over THIS, not over wells.
      'dated', count(*) filter (where first_window_perf_on is not null)) from outcome),
  'available', (select count(*) from available),
  'candidates_with_no_operator_on_file',
    (select count(*) from available where operator_number is null),
  -- WHO HOLDS THEM, which is the half of "where else can I do this" that a
  -- count of wells does not answer. Asked what to BUY, the previous shape
  -- returned an inventory total and a list of api numbers, and the reader still
  -- had no idea whose they were or whether any of it was for sale.
  --
  -- Every column is counted over that operator's wells IN THIS EXTENT, not over
  -- their whole company: their footprint here, how much of it they have already
  -- plugged, how many are sitting on the Statewide Rule 14(b)(2) inactivity
  -- clock, and what their P-5 says. No score is computed from them. A weighted
  -- number would read as a verdict on a company's solvency built out of four
  -- administrative flags, which is not something this record can support; the
  -- flags are handed over as flags.
  'owners', (select json_agg(x) from (
      select o.operator_number,
             -- Grouped on the NUMBER alone. The number is the identity and the
             -- name is a label the tape spells inconsistently, so grouping on
             -- both split one company into two rows, each holding part of its
             -- candidates, and excluding it then removed more wells than either
             -- row claimed.
             max(o.operator_name) as operator_name,
             count(*)::int as candidates,
             count(*) filter (where o.plug_date is not null)::int as of_which_plugged,
             (select count(*)::int from pop q where q.operator_number = o.operator_number)
               as wells_in_extent,
             (select count(*)::int from pop q
               where q.operator_number = o.operator_number and q.wb_14b2_flag = 'Y')
               as wells_on_the_14b2_clock,
             (select count(*)::int from pop q
               where q.operator_number = o.operator_number and q.plug_date is not null)
               as wells_plugged_in_extent,
             -- A LABEL, not the raw code. The tape's status is blank on any
             -- wellbore with no on-schedule row, and a blank rendered into a
             -- table becomes a dash, which a reader takes for "nothing wrong".
             -- Unknown and clean are the opposite of each other here.
             -- Searched CASE, not a simple one: "when null" never matches in
             -- SQL, so a simple CASE would have labelled every unknown operator
             -- "lapsed or delinquent" and invented distress that is not there.
             case
               when max(o.p5_org_status) is null then 'unknown'
               when max(o.p5_org_status) = 'A' then 'active'
               else 'lapsed or delinquent'
             end as p5_standing,
             max(o.p5_org_status) as p5_org_status,
             max(o.h15_status_code) as h15_status_code
        from available o
       -- A wellbore with no operator number on file has no counterparty to buy
       -- it from, and listing it as an owner produced a row claiming candidates
       -- against zero wells, because nothing equals NULL. Counted separately
       -- below instead of shown as a company.
       where o.operator_number is not null
       group by o.operator_number
       order by candidates desc nulls last limit ${facetParam}) x),
  'by_county', (select json_agg(x) from (
      select county_name as key, count(*)::int as wells from available
       group by 1 order by 2 desc nulls last limit ${facetParam}) x),
  'candidates', (select json_agg(y) from (
      select p.api_number, p.operator_name, p.operator_number, p.lease_name, p.well_no, p.field_name,
             p.county_name, p.district, p.total_depth,
             p.shallowest_perf_ft, p.deepest_perf_ft, p.in_window as perf_intervals,
             -- A perforation below the hole's own filed total depth. Either the
             -- TD is wrong or the hole is deviated, and on a horizontal the
             -- measured depths are not comparable with a vertical's at all. It
             -- ranked a Barnett lateral beside vertical Marble Falls wells with
             -- nothing to mark the difference, so the flag travels with the row.
             -- Written as "is true" rather than a bare comparison: with no filed TD the
             -- comparison is NULL, and a null boolean makes the reader decide
             -- what it meant. The flag asserts positive evidence of a perf
             -- below the filed TD, so no evidence is false, not unknown.
             ((p.deepest_perf_ft > p.total_depth) is true) as perfs_below_filed_td,
             p.plug_date, p.lat, p.lon,
             p.lease_oil_bbl_recent, p.lease_gas_mcf_recent,
             to_char(p.lease_last_produced, 'YYYY-MM') as lease_last_produced,
             f.elevation as elevation_ft, f.elevation_code, f.plug_back_ft
        from page p
        ${RETURNED_ROW_DETAIL}) y)
) as result`;

    const rows = await rrcQuerySlow<{ result: AnalogResult }>(sql, params, BUDGET_MS);
    const r = rows[0]?.result;
    if (!r) return fail("The analog screen returned nothing at all, which means the query failed rather than matching zero wells.");

    const candidates = r.candidates ?? [];
    const t = r.tried;
    const complete = r.available <= candidates.length;
    const failureRate = t.dated > 0 ? t.plugged_after_shooting_it / t.dated : null;

    return {
      ok: true as const,
      screen: {
        depth_window_ft: [top, bottom],
        formation: window.from ?? undefined,
        ...extent.described,
        statewide: extent.where.length === 0 || undefined,
      },
      /*
       * The base rate is FIRST in the result on purpose.
       *
       * A prompt rule telling the model to state the base rate before
       * recommending an action is a rule it can forget. A result whose first
       * field is the failure rate, computed over the same population as the
       * candidate list beneath it, is one it has to walk past.
       */
      base_rate: {
        ...t,
        failure_rate:
          failureRate == null ? null : `${Math.round(failureRate * 100)}% of wells that shot this window were plugged afterwards`,
      },
      available: r.available,
      candidates_with_no_operator_on_file: r.candidates_with_no_operator_on_file,
      returned: candidates.length,
      is_complete: complete,
      candidates,
      owners: r.owners ?? [],
      by_county: r.by_county ?? [],
      guidance: [
        "INTERNAL. Act on these. Never quote or paraphrase one.",
        t.wells === 0
          ? "NO PRECEDENT: nobody in this extent has perforated this window. There is no base rate and these are untested holes, not repeatable moves. Say that plainly."
          : `base rate: ${t.plugged_after_shooting_it.toLocaleString()} of ${t.dated.toLocaleString()} dated attempts plugged afterwards` +
            (t.median_years_from_shooting_it_to_plugging != null
              ? `, median ${t.median_years_from_shooting_it_to_plugging} yr.`
              : "."),
        "outcome is plugging, filed per wellbore. Crude. rrc_recompletion_outcomes reads production before and after, on the survivors.",
        complete
          ? `complete: every one of the ${r.available.toLocaleString()} candidates is in candidates. Name them, with who holds each.`
          : `sample: ${candidates.length} of ${r.available.toLocaleString()}. Narrow by county, field_name or an operator in owners, then call again.`,
        "the WELL is the unit; owners is a lookup for who holds them, not a ranking of what to buy. Flags, not a score. Use p5_standing, not the raw code. unknown is not clean: it means the wellbore has no on-schedule row. rrc_distress_signal, rrc_operator_exit, rrc_liability_check judge a counterparty.",
        "plug_back_ft above the window means drilling out. perfs_below_filed_td=true means a wrong TD or a deviated hole; do not rank it beside a vertical silently.",
        "depth free only. Casing, cement, plug-back clearance, squeeze burden and takeaway are unchecked: rrc_casing_at_depth, rrc_cement_top_check, rrc_plugback_feasibility, rrc_squeeze_burden, rrc_uphole_takeaway_check.",
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [wellScreen, analogScreen];
