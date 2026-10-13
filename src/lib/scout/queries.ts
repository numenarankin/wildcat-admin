"use server";

/**
 * Scout's data layer: every read the /scout UI makes, against the TIGER mirror.
 *
 * This file used to read Archon's Supabase copy of the RRC dataset over
 * PostgREST. It now reads `RRC_DATABASE_URL` — the same server /scout/rrc has
 * always used — so the map, the RRC screens and the agent all answer from one
 * database. `src/lib/scout/archon-db.ts` is no longer referenced by anything on
 * this page.
 *
 * These stay server actions rather than route handlers because the components
 * calling them already do, and because `rrc-db.ts` carries no authorization of
 * its own: every exported action starts with `assertPlatformAdmin()`. Do not add
 * an export that skips it.
 *
 * THREE CONVENTIONS THE MIRROR IMPOSES, all different from Archon's:
 *
 *   1. OPERATOR NUMBERS ARE `character(6)`, zero-padded — "000016", not 16.
 *      The map keys operators as ints, so `op6()` pads on the way in and every
 *      select casts back out with `::int`. Verified equivalent against both
 *      stores: Tiger "000016" and Archon 16 are the same operator.
 *   2. WELLBORE IS ONE ROW PER WELL x LEASE x FIELD (1,368,247 rows for
 *      1,050,856 wells), and `well_location` one row per recorded location.
 *      Every read here collapses them with `distinct on (api_number)`,
 *      locations by `reliability` — the rule the mirror's own `wells_mapped`
 *      view uses.
 *   3. `on_schedule = 'Y'` IS WHAT "CURRENTLY" MEANS. The status columns are
 *      populated only on those rows, and 133,139 wells carry rows naming
 *      different operators over their history, so "wells this operator runs"
 *      is the on-schedule set. Counting every row an operator ever appeared on
 *      reads Hilcorp at 25,673 wells against the 19,353 it actually operates.
 *
 * Row shapes live in `./types` (a `"use server"` module may only export async
 * functions).
 */

import { assertPlatformAdmin } from "@/lib/auth/platform-admin";
import { rrcQuery, rrcQueryOne } from "@/lib/scout/rrc-db";
import { buildGraph } from "@/lib/scout/graph-build";
import { hubGraphEdges, subgraphEdges, topHubs } from "@/lib/scout/network";
import { districtLabel } from "@/lib/scout/rrc-districts";
import { perMonth } from "@/lib/scout/format";
import {
  allocatedByTestBatch,
  drilledSql,
  getCycleEdge,
} from "@/lib/scout/rrc-queries";
import { COUNTY_NAMES } from "@/lib/scout/counties";
import { GAS_KEYS, monthlyRate, OIL_KEYS } from "@/lib/scout/allocate-months";
import type { GraphData } from "@/lib/scout/graph-style";
import type {
  FocusOpts,
  FocusWell,
  NetworkRole,
  OfficerRow,
  OperatorDetailRow,
  OperatorFull,
  OperatorLast12,
  OperatorLease,
  OperatorMatch,
  OperatorP5,
  OperatorPermit,
  OperatorProfile,
  OperatorWell,
  OperatorWellEvent,
  OperatorWellRate,
  OperatorWellRates,
  SubgraphSeed,
  TopHub,
  WellDetail,
} from "@/lib/scout/types";
import { wellActivity } from "@/lib/scout/well-activity";
/*
 * The wellbore predicates the focus layer is built from live in `focus-where.ts`
 * rather than here: this module is `"use server"`, so it may only export async
 * functions, and a `const` holding SQL cannot be shared out of it. The other
 * reads below use the same two constants, which is why they are imported rather
 * than duplicated.
 */
import {
  buildFocusWhere,
  countyApiRange,
  op6,
  OWNS_WELL,
} from "@/lib/scout/focus-where";

/** Wells the focus layer will draw before it gives up and reports a sample. */
const FOCUS_CAP = 30000;
/** Wells fetched for the operator modal's lists + map. Beyond this: a sample. */
const WELL_SAMPLE_CAP = 2000;

/**
 * Full payload for a clicked well: the operator on its current row, plus that
 * operator's officers.
 *
 * The structural half of the well dossier comes from `/api/scout/rrc/well/<api>`
 * (see `scout-well-modal.tsx`); this supplies only what that route does not —
 * the officers, which are the route from a well into the principal panel. The
 * `well` field stays null because nothing renders it.
 */
export async function getWellDetail(api: number): Promise<WellDetail> {
  await assertPlatformAdmin();
  const apiText = String(api).replace(/\D/g, "").padStart(8, "0");

  const operator = await rrcQueryOne<OperatorDetailRow>(
    `select $1::bigint                       as api_number,
            btrim(wb.operator_number)::int   as operator_number,
            'wellbore'::text                 as operator_source,
            nullif(btrim(wb.plug_operator_name), '') as plugging_operator_name,
            o.operator_name,
            o.p5_status,
            o.addr1                          as addr_line1,
            o.addr2                          as addr_line2,
            o.city1                          as city,
            o.state1                         as state,
            nullif(regexp_replace(o.zip1, '\\D', '', 'g'), '')::int as zip,
            to_char(o.last_p5_date, 'YYYYMMDD')::int as last_p5_date,
            o.operator_name                  as operator_display_name,
            (select count(*)::int from rrc.operator_officers oo
              where oo.operator_number = wb.operator_number) as officer_count
       from (select distinct on (api_number) api_number, operator_number,
                    plug_operator_name
               from rrc.wellbore
              where api_number = $2
              order by api_number, (on_schedule = 'Y') desc) wb
       left join rrc.operators o on o.operator_number = wb.operator_number`,
    [api, apiText]
  );

  const officers = operator?.operator_number
    ? await rrcQuery<OfficerRow>(
        `select officer_name, officer_title,
                nullif(btrim(city), '')  as officer_city,
                nullif(btrim(state), '') as officer_state
           from rrc.operator_officers
          where operator_number = $1
          order by officer_title, officer_name
          limit 100`,
        [op6(operator.operator_number)]
      )
    : [];

  return { well: null, operator: operator ?? null, officers };
}

/**
 * Geocoded wells matching a narrow search, for the map's focus layer.
 *
 * One query rather than Archon's four paged round trips: the mirror can join
 * wellbores to locations itself, so the operator/county/category filters all
 * push down to indexes instead of being intersected in JavaScript.
 *
 * The WHERE is built by `buildFocusWhere`, which is pure and unit-tested: the
 * exact SQL each filter turns into is a hand-written assertion there rather
 * than a hope. It hands back its own JOINS too (`built.joins`), because one
 * filter needs a table this query would otherwise not touch: the production
 * band reads `wildcat.well_rate`, and it is joined only when a band is set so
 * an unbanded search runs the query it always ran.
 */
export async function getFocusWells(
  opts: FocusOpts
): Promise<{ wells: FocusWell[]; capped: boolean }> {
  await assertPlatformAdmin();

  const built = buildFocusWhere(opts);
  // Nothing to ask, or a question that resolved to nobody: both draw no wells,
  // and neither is a reason to run a statewide scan.
  if (built.kind === "none") return { wells: [], capped: false };

  const rows = await rrcQuery<{
    api: number;
    lon: number;
    lat: number;
    og: string | null;
    swd: number;
    dead: number;
  }>(
    // The disposal test is `findDisposal`'s, spelled the same way as in
    // scripts/scout-sync-data.mjs so a focused well and a tiled well are
    // coloured by one rule. It is ANY hole that injects, not only one holding a
    // live disposal permit: 34,979 wells rather than 9,725, because a waterflood
    // injector is not making the oil either. EXISTS rather than a join: uic_permit holds 126,709
    // rows against 117,348 wells, and a plain join would duplicate every well
    // that has been re-permitted.
    /*
     * Coordinates ROUNDED to 6 decimals, matching the points file.
     *
     * The mirror stores 8 (`-95.47692296`) and the map draws a dot, so the last
     * two digits are a hundredth of a pixel at any zoom, and across a capped
     * result they are a tenth of a 2.3 MB payload. 6 rather than 5 because
     * `scripts/scout-sync-data.mjs:256` rounds the tile layer's points to 6:
     * the same well must not sit a metre away from itself when a search
     * narrows onto it and this layer replaces those tiles.
     */
    `select distinct on (wb.api_number)
            wb.api_number::int as api,
            round(l.lon::numeric, 6)::float8 as lon,
            round(l.lat::numeric, 6)::float8 as lat,
            nullif(btrim(wb.oil_gas_code), '') as og,
            (exists (select 1 from rrc.uic_permit p
                      where p.api_number = wb.api_number
                        and p.inj_type in ('1','2')
                        and p.uic_class = '2' and p.activated_flag = 'Y'
                        and p.cancel_date is null and p.w3_date is null)
             or upper(btrim(coalesce(wb.well_type_name, ''))) in (
               'INJECTION', 'WATER SUPPLY', 'OBSERVATION', 'LPG STORAGE',
               'GAS STRG-INJECTION', 'GAS STRG-WITHDRAWAL',
               'GAS STRG-SALT FORMATION', 'BRINE MINING', 'DOMESTIC USE WELL',
               'GEOTHERMAL WELL', 'OTHER TYPE SERVICE'
             ))::int
              as swd,
            /*
             * No longer operational: plugged, or typed as a hole that has
             * stopped. Same rule as the points file, so a well does not change
             * colour when a search narrows onto it.
             */
            (nullif(btrim(wb.plug_date), '') is not null
             or upper(btrim(coalesce(wb.well_type_name, ''))) in (
               'SHUT IN', 'SHUT IN-MULTI-COMPL', 'TEMP ABANDONED', 'ABANDONED',
               'NO PRODUCTION', 'PARTIAL PLUG', 'SEALED',
               'NOT ELIGIBLE FOR ALLOWABLE'
             ))::int
              as dead
       from rrc.wellbore wb
       join rrc.well_location l on l.api_number = wb.api_number
       ${built.joins}
      where ${built.where}
        and l.lon is not null and l.lat is not null
      order by wb.api_number, (wb.on_schedule = 'Y') desc, l.reliability
      limit ${FOCUS_CAP + 1}`,
    built.params
  );

  const capped = rows.length > FOCUS_CAP;
  const drawn = rows.slice(0, FOCUS_CAP);

  return {
    wells: drawn.map((r) => ({
      api: r.api,
      lng: r.lon,
      lat: r.lat,
      og: r.og,
      swd: r.swd,
      dead: r.dead,
    })),
    capped,
  };
}

/**
 * Every operator with a wellbore in one county — what "county" means on the
 * OPERATOR map.
 *
 * Not what it looks like: operators are plotted at their mailing address, so
 * filtering to a county leaves points scattered across the state. It answers
 * "who works here", never "who is based here", and the UI has to say so.
 *
 * On-schedule only, matching how `scripts/scout-sync-data.mjs` attributes the
 * operator points this filter hides and shows. A county that selected operators
 * by historical attribution would keep pointing at dots that are not on the map.
 */
export async function getCountyOperators(countyCode: number): Promise<number[]> {
  await assertPlatformAdmin();
  const [lo, hi] = countyApiRange(countyCode);
  const rows = await rrcQuery<{ n: number }>(
    `select distinct btrim(wb.operator_number)::int as n
       from rrc.wellbore wb
      where wb.api_number between $1 and $2
        and wb.on_schedule = 'Y'
        and wb.operator_number is not null and btrim(wb.operator_number) <> ''
        and ${OWNS_WELL}`,
    [lo, hi]
  );
  return rows.map((r) => r.n);
}

/**
 * The counties each operator holds on-schedule wells in, most wells first.
 * The inverse of `getCountyOperators`, by the same rule: a county is the
 * API number's first three digits, and a wellbore counts for the operator
 * that owns it (`OWNS_WELL`). For the admin Targets table's County column
 * and filter.
 */
export async function getOperatorCounties(
  operatorNumbers: number[]
): Promise<Map<number, number[]>> {
  await assertPlatformAdmin();
  const m = new Map<number, number[]>();
  if (operatorNumbers.length === 0) return m;
  const rows = await rrcQuery<{ n: number; county: number }>(
    `select btrim(wb.operator_number)::int as n,
            substr(wb.api_number, 1, 3)::int as county,
            count(*)::int                      as wells
       from rrc.wellbore wb
      where wb.operator_number = any($1)
        and wb.on_schedule = 'Y'
        and ${OWNS_WELL}
      group by 1, 2
      order by 1, 3 desc`,
    [operatorNumbers.map(op6)]
  );
  for (const r of rows) {
    const list = m.get(r.n) ?? [];
    list.push(r.county);
    m.set(r.n, list);
  }
  return m;
}

// === Operator modal =========================================================

interface LeaseRow {
  oil_gas_code: string;
  district_no: string;
  lease_no: string;
  lease_name: string | null;
  oil_last12: number | null;
  gas_last12: number | null;
  months: number | null;
  last_cycle: number | null;
}

/** One wellbore row's dated events, as the Activity read returns them. */
interface EventRow {
  api_number: number;
  lease_name: string | null;
  well_no: string | null;
  county_code: string | null;
  oil_gas_code: string | null;
  district: string | null;
  lease_number: string | null;
  completion_date: string | null;
  plug_date: string | null;
  /** Sort key only: the later of the two dates. Not returned to the client. */
  newest: string | null;
}

/**
 * Everything the operator modal renders, in one call.
 *
 * The well buckets, the lease counties and the headline counts are all derived
 * from the SAME fetched well sample, which is what keeps them consistent with
 * each other.
 *
 * ONE BEHAVIOUR CHANGE WORTH KNOWING. Archon had no per-well status, so a well
 * counted as "producing" when any lease it sat on reported volume in the
 * trailing year — a lease-level proxy that marked every well on a producing
 * lease as producing. The mirror carries the RRC's own `well_type_name`, so a
 * well is now producing when the RRC says it is.
 */
/**
 * How many of an operator's granted permits the dossier ships.
 *
 * The tail is long — the busiest operator in the mirror holds 19,549 — and the
 * table is a "what have they been drilling lately" list, not a register.
 * `permitTotal` carries the real count.
 */
const OPERATOR_PERMIT_SAMPLE = 200;

/**
 * Dated wellbore events the Activity feed ships, newest first.
 *
 * Rows, not wells: a hole carries one per lease x field it was completed into,
 * so a 6,000-well operator can spell more than 6,000 of them. Cut at the OLD
 * end, because a feed is read from the top and "what have they done lately" is
 * the question it answers.
 */
const OPERATOR_EVENT_SAMPLE = 3000;

/**
 * `YYYYMMDD` text on `rrc.wellbore`, as `YYYY-MM-DD`, or null.
 *
 * The mirror stores these dates as text and ZERO-FILLS what it does not know
 * ('19750000' is a real value in the column), so the regex is the gate: a
 * partial date is dropped rather than cast, because `to_date` would happily
 * read it as December 31st 1974 and put an event on a day nothing happened.
 * Sliced rather than parsed for the same reason — no cast can raise here.
 */
function wellboreDate(col: string): string {
  const t = `btrim(${col})`;
  return `case when ${t} ~ '^(19|20)\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])$'
               then substr(${t}, 1, 4) || '-' || substr(${t}, 5, 2) || '-' || substr(${t}, 7, 2)
          end`;
}

/**
 * The operator's granted permits, newest issue first, with a position where
 * one can be recovered.
 *
 * TWO READS, JOINED HERE, because the position lives in a different table from
 * the permit. `rrc.permit` is the register and carries no coordinates at all;
 * `rrc.pending_permit` is the application feed this mirror snapshots daily, and
 * its wellbore rows do. A permit issued before that feed was being held has no
 * position and is listed without one rather than dropped — the table is the
 * record, the map is the subset that can be drawn.
 *
 * The join key is the RRC's own: a permit's `permit_number` is the application's
 * `status_number` zero-padded to seven, at the same `permit_seq`/`status_seq_no`
 * — exactly how `getApprovedPermits` matches the two.
 */
async function operatorPermits(no: string): Promise<OperatorPermit[]> {
  const [rows, located] = await Promise.all([
    rrcQuery<{
      permit_number: string | null;
      permit_seq: string | null;
      lease_name: string | null;
      well_number: string | null;
      county_code: string | null;
      district: string | null;
      total_depth: number | null;
      filed_date: string | null;
      issued_date: string | null;
      expires_date: string | null;
    }>(
      `select p.permit_number, p.permit_seq, p.lease_name, p.well_number,
              p.county_code, p.district, p.total_depth,
              to_char(p.filed_date,   'YYYY-MM-DD') as filed_date,
              to_char(p.issued_date,  'YYYY-MM-DD') as issued_date,
              to_char(p.expires_date, 'YYYY-MM-DD') as expires_date
         from rrc.permit p
        where p.operator_number = $1
        order by p.issued_date desc nulls last
        limit ${OPERATOR_PERMIT_SAMPLE}`,
      [no]
    ),
    // Newest snapshot per application, like every other read of this feed.
    rrcQuery<{
      permit_number: string | null;
      permit_seq: string | null;
      api_number: string | null;
      lat: number | null;
      lon: number | null;
      drilled: boolean;
    }>(
      `select distinct on (pp.universal_doc_no)
              lpad(pp.status_number, 7, '0') as permit_number,
              pp.status_seq_no               as permit_seq,
              w.api_sequence_number          as api_number,
              w.surface_lat                  as lat,
              w.surface_lon                  as lon,
              -- The map's own test, imported rather than restated, so a
              -- permit is drilled in both places or neither.
              ${drilledSql("w.api_sequence_number")} as drilled
         from rrc.pending_permit pp
         left join rrc.pending_wellbore w using (universal_doc_no)
        where pp.operator_number = $1
        order by pp.universal_doc_no, pp.snapshot desc`,
      [no]
    ).catch(() => []),
  ]);

  const byKey = new Map(
    located.map((l) => [`${l.permit_number}-${l.permit_seq}`, l])
  );

  return rows.map((r) => {
    const hit = byKey.get(`${r.permit_number}-${r.permit_seq}`);
    return {
      permit_number: r.permit_number,
      permit_seq: r.permit_seq,
      lease_name: r.lease_name,
      well_number: r.well_number,
      county_name: r.county_code
        ? COUNTY_NAMES[Number(r.county_code)] ?? null
        : null,
      district_name: districtLabel(r.district),
      total_depth: r.total_depth,
      filed_date: r.filed_date,
      issued_date: r.issued_date,
      expires_date: r.expires_date,
      api_number: hit?.api_number ?? null,
      drilled: hit?.drilled ?? false,
      lat: hit?.lat ?? null,
      lon: hit?.lon ?? null,
    };
  });
}

/**
 * Records one rate request will read. A record is a lease-sized read plus its
 * tests, and the largest operator in Texas spans thousands: measured, 110
 * records costs ~2.7 s and an unbounded fan-out over the whole fleet exhausts
 * the connection pool before it finishes. Beyond the cap the caller is told the
 * answer is partial rather than shown a wrong one.
 */
const OPERATOR_RATE_RECORD_CAP = 150;
/**
 * Wells per record, measured: 398 wells across 110 records, 395 across 49. Used
 * only to turn the record cap into a well cap before the records are known —
 * the reads are counted in records, the input is a list of wells.
 */
const RECORD_WELL_RATIO = 4;

/**
 * Each of an operator's wells, with the month it is estimated to have made.
 *
 * THE APP'S ONE PER-WELL ESTIMATOR, not a second one. Texas files production per
 * LEASE, so a per-well figure only exists as a split, and the split lives in
 * `@/lib/rrc/record-split` + `well-share.ts`: each well's share of its record's
 * last filed month, weighted by the W-10/G-10 in effect, with service holes,
 * undrilled wells and SHUT-IN wells taking no share. The well's own page, the
 * lease dossier's Wells tab and the map's hover label all read the same split,
 * so a well's rate is the same number wherever Scout prints it.
 *
 * SEPARATE FROM THE DOSSIER, and fetched when a well tab is opened, because it
 * is the expensive half: the dossier itself is four indexed reads, this is one
 * production read per record the fleet touches.
 */
export async function getOperatorWellRates(
  operatorNumber: number
): Promise<OperatorWellRates> {
  await assertPlatformAdmin();
  const no = op6(operatorNumber);

  const apis = await rrcQuery<{ api_number: string }>(
    `select distinct wb.api_number
       from rrc.wellbore wb
      where wb.operator_number = $1 and wb.on_schedule = 'Y'
        and ${OWNS_WELL}
      limit ${WELL_SAMPLE_CAP}`,
    [no]
  );
  if (apis.length === 0) return { byApi: {}, capped: false };

  /*
   * Capped by RECORD, which is what the reads are counted in. Under the cap the
   * whole fleet is estimated; over it, the wells on the records that were read
   * get a number and the rest read "—", which the tab says out loud rather than
   * letting a partial answer pass for a complete one.
   */
  const { reported } = await getCycleEdge();
  const capped = apis.length > OPERATOR_RATE_RECORD_CAP * RECORD_WELL_RATIO;
  const months = await allocatedByTestBatch(
    apis
      .slice(0, OPERATOR_RATE_RECORD_CAP * RECORD_WELL_RATIO)
      .map((a) => a.api_number),
    reported,
    // `monthlyRate`'s window below: only the trailing year is read off it.
    { trailing: 12 }
  );

  const byApi: Record<number, OperatorWellRate> = {};
  for (const [api, series] of months) {
    if (series.length === 0) continue;
    /*
     * The TRAILING AVERAGE, not the last month with a volume.
     *
     * `monthlyRate` is what `/api/scout/well-rate` sums for the map's hover and
     * what the well modal's headline shows, so a well quotes the same figure in
     * all three. The distinction matters exactly where this started: a well
     * whose lease last filed in 2024 reads 0 here, where "its most recent
     * producing month" would have printed a live-looking rate against a hole
     * that has made nothing since.
     */
    const last = [...series].reverse().find((m) => m.reported);
    byApi[Number(api)] = {
      cycle: last?.cycle.slice(0, 7) ?? "",
      oil: monthlyRate(series, OIL_KEYS),
      gas: monthlyRate(series, GAS_KEYS),
    };
  }
  return { byApi, capped };
}

export async function getOperatorProfile(
  operatorNumber: number
): Promise<OperatorProfile> {
  await assertPlatformAdmin();
  const no = op6(operatorNumber);
  // Both production windows below are anchored HERE, at the last cycle the RRC
  // has actually published, not at today. See `perMonth` in `format.ts`.
  const { reported } = await getCycleEdge();

  const [record, officers, wellRows, leaseRows, last12] = await Promise.all([
    rrcQueryOne<OperatorFull>(
      `select operator_number::int                as operator_number,
              operator_name, p5_status,
              addr1 as addr_line1, addr2 as addr_line2,
              city1 as city, state1 as state,
              nullif(regexp_replace(zip1, '\\D', '', 'g'), '')::int as zip,
              null::int                            as zip_suffix,
              -- bigint, NOT int: a 10-digit phone overflows int4.
              nullif(regexp_replace(phone1, '\\D', '', 'g'), '')::bigint as phone,
              to_char(last_p5_date, 'YYYYMMDD')::int as last_p5_date,
              -- Gatherers are not in the mirror; the P-5 master here has no
              -- gatherer columns at all. Null rather than invented.
              null::text as oil_gatherer, null::text as gas_gatherer
         from rrc.operators
        where operator_number = $1`,
      [no]
    ),
    rrcQuery<OfficerRow>(
      `select officer_name, officer_title,
              nullif(btrim(city), '')  as officer_city,
              nullif(btrim(state), '') as officer_state
         from rrc.operator_officers
        where operator_number = $1
        order by officer_title, officer_name
        limit 100`,
      [no]
    ),
    rrcQuery<{
      api_number: number;
      district: string | null;
      county_code: string | null;
      oil_gas_code: string | null;
      well_type_name: string | null;
      plugged: boolean;
      curr_inact_yrs: number | null;
      total_depth: number | null;
      lease_key: string | null;
      lease_name: string | null;
      well_no: string | null;
      lat: number | null;
      lon: number | null;
    }>(
      `select distinct on (wb.api_number)
              wb.api_number::int                                as api_number,
              btrim(wb.district)                                as district,
              btrim(wb.county_code)                             as county_code,
              nullif(btrim(wb.oil_gas_code), '')                as oil_gas_code,
              wb.well_type_name,
              -- The name a person uses for the hole. Two columns, not one:
              -- "ROACH" is also the lease these tabs group by.
              nullif(btrim(wb.lease_name), '')                  as lease_name,
              nullif(btrim(wb.well_no), '')                     as well_no,
              -- This row's own plug date. Every row here is on-schedule, so it
              -- IS the current record — step 2 of the rule. The historic-plug
              -- step does not apply to a well that has a live row at all.
              nullif(btrim(wb.plug_date), '') is not null       as plugged,
              nullif(btrim(wb.curr_inact_yrs), '')::int         as curr_inact_yrs,
              nullif(btrim(wb.api_depth), '')::bigint::int      as total_depth,
              nullif(btrim(wb.lease_number), '')                as lease_key,
              l.lat, l.lon
         from rrc.wellbore wb
         left join rrc.well_location l on l.api_number = wb.api_number
        where wb.operator_number = $1 and wb.on_schedule = 'Y'
          and ${OWNS_WELL}
        order by wb.api_number, l.reliability
        limit ${WELL_SAMPLE_CAP + 1}`,
      [no]
    ),
    // Bounded by cycle so Timescale prunes to the last chunks — the same window
    // and the same reason as `getOperatorDossier` in rrc-queries.ts.
    rrcQuery<LeaseRow>(
      `with recent as (
         select oil_gas_code, district_no, lease_no,
                sum(coalesce(oil_prod_vol, 0))::bigint as oil_last12,
                sum(coalesce(gas_prod_vol, 0))::bigint as gas_last12,
                count(distinct cycle)::int             as months,
                max(to_char(cycle, 'YYYYMM')::int)     as last_cycle
           from rrc.lease_production
          where operator_no = $1
            and cycle >  to_date($2, 'YYYY-MM') - interval '12 months'
            and cycle <= to_date($2, 'YYYY-MM')
          group by 1, 2, 3
       )
       select r.oil_gas_code, r.district_no, r.lease_no, l.lease_name,
              r.oil_last12, r.gas_last12, r.months, r.last_cycle
         from recent r
         left join rrc.lease l
                on l.oil_gas_code = r.oil_gas_code
               and l.district_no  = r.district_no
               and l.lease_no     = r.lease_no
        order by r.oil_last12 desc, r.gas_last12 desc
        limit 3000`,
      [no, reported]
    ).catch(() => [] as LeaseRow[]),
    rrcQueryOne<{ oil: number; gas: number; months: number }>(
      `select coalesce(sum(oil), 0)::bigint as oil,
              coalesce(sum(gas), 0)::bigint as gas,
              count(distinct month)::int    as months
         from rrc.operator_production_monthly
        where operator_no = $1
          and month >  to_date($2, 'YYYY-MM') - interval '12 months'
          and month <= to_date($2, 'YYYY-MM')`,
      [no, reported]
    ),
  ]);

  /*
   * The fleet's API numbers, for the event read below. Taken from the rows
   * phase one already returned rather than re-selected, so the Activity feed
   * covers exactly the wells the bucket tabs list.
   */
  const fleetApis = wellRows
    .slice(0, WELL_SAMPLE_CAP)
    .map((w) => String(w.api_number).padStart(8, "0"));

  const [exactCount, permits, permitCount, eventRows] = await Promise.all([
    rrcQueryOne<{ n: number }>(
      `select count(distinct wb.api_number)::int as n
         from rrc.wellbore wb
        where wb.operator_number = $1 and wb.on_schedule = 'Y'
          and ${OWNS_WELL}`,
      [no]
    ),
    operatorPermits(no),
    // The honest total, so the tab label is the operator's permit count and not
    // the size of the slice the table happens to show.
    rrcQueryOne<{ n: number }>(
      `select count(*)::int as n from rrc.permit where operator_number = $1`,
      [no]
    ),
    /*
     * COMPLETIONS AND PLUGGINGS, for the Activity feed.
     *
     * EVERY ROW of each hole, not the on-schedule one: the grain is well x
     * lease x field, so a recompletion is its own row with its own date, and on
     * 22% of holes the current row's completion date is blank while a historic
     * row carries a real one. `distinct` collapses the duplicates that leaves.
     *
     * KEYED ON THE FLEET'S API NUMBERS, not on `operator_number` alone, because
     * `wellbore_op_idx` is PARTIAL (`where on_schedule = 'Y'`) — a bare
     * operator predicate over every row is a 1.37M-row sequential scan on every
     * dossier open. `wellbore_api_idx` is not partial, so this is 2,000 index
     * lookups instead. The operator predicate stays as a filter: a completion
     * filed by the previous operator of a well is not this operator's activity.
     *
     * What that scoping costs: a well this operator has since sold contributes
     * nothing. Its wells are the ones the tabs list, and a feed row that named
     * a well absent from every bucket would be the worse trade.
     */
    fleetApis.length === 0
      ? Promise.resolve([] as EventRow[])
      : rrcQuery<EventRow>(
          `select distinct
                  wb.api_number::int                  as api_number,
                  nullif(btrim(wb.lease_name), '')    as lease_name,
                  nullif(btrim(wb.well_no), '')       as well_no,
                  nullif(btrim(wb.county_code), '')   as county_code,
                  nullif(btrim(wb.oil_gas_code), '')  as oil_gas_code,
                  nullif(btrim(wb.district), '')      as district,
                  nullif(btrim(wb.lease_number), '')  as lease_number,
                  ${wellboreDate("wb.completion_date")} as completion_date,
                  ${wellboreDate("wb.plug_date")}       as plug_date,
                  -- Newest of the two, so the cut below keeps recent history.
                  -- Text dates in YYYY-MM-DD sort as dates do.
                  greatest(
                    coalesce(${wellboreDate("wb.completion_date")}, ''),
                    coalesce(${wellboreDate("wb.plug_date")}, '')
                  ) as newest
             from rrc.wellbore wb
            where wb.api_number = any($1) and wb.operator_number = $2
              and (${wellboreDate("wb.completion_date")} is not null
                or ${wellboreDate("wb.plug_date")} is not null)
            order by newest desc
            limit ${OPERATOR_EVENT_SAMPLE + 1}`,
          [fleetApis, no]
        ).catch(() => [] as EventRow[]),
  ]);
  const wellCount = exactCount?.n ?? wellRows.length;
  const capped = wellRows.length > WELL_SAMPLE_CAP;
  const sample = wellRows.slice(0, WELL_SAMPLE_CAP);

  const wellEventsCapped = eventRows.length > OPERATOR_EVENT_SAMPLE;
  const wellEvents: OperatorWellEvent[] = eventRows
    .slice(0, OPERATOR_EVENT_SAMPLE)
    .map((e) => ({
      api_number: e.api_number,
      lease_name: e.lease_name,
      well_no: e.well_no,
      // Text in the mirror, a number everywhere in Scout — the same conversion
      // the well rows above make.
      county_code: e.county_code ? Number(e.county_code) : null,
      oil_gas_code: e.oil_gas_code,
      district: e.district,
      lease_number: e.lease_number,
      completion_date: e.completion_date,
      plug_date: e.plug_date,
    }));

  /*
   * The key a well and a lease agree on.
   *
   * One expression, used for the well's own `lease_id`, for the lease table's
   * well count, and for its counties — they used to be built inline in two
   * places, and a hole can only be attributed to one lease if all three spell
   * the key the same way. `null` for a well the wellbore row puts on no lease.
   */
  const leaseKeyOf = (w: (typeof sample)[number]): string | null =>
    w.lease_key ? `${w.oil_gas_code ?? ""}-${w.district ?? ""}-${w.lease_key}` : null;

  const wells: OperatorWell[] = sample
    .map((w) => {
      // Every row here is `on_schedule = 'Y'` by the query above, so the
      // schedule half of the rule is already satisfied.
      const activity = wellActivity({
        plugged: w.plugged,
        onSchedule: true,
        wellTypeName: w.well_type_name,
        inactiveYears: w.curr_inact_yrs,
      });
      return {
        api_number: w.api_number,
        admin_district: w.district ? Number(w.district.replace(/\D/g, "")) : null,
        county_code: w.county_code ? Number(w.county_code) : null,
        oil_gas_label:
          w.oil_gas_code === "O" ? "Oil" : w.oil_gas_code === "G" ? "Gas" : null,
        is_plugged: w.plugged,
        total_depth: w.total_depth,
        latitude: w.lat,
        longitude: w.lon,
        activity,
        well_type: w.well_type_name ?? null,
        lease_name: w.lease_name,
        well_no: w.well_no,
      };
    })
    .sort((a, b) => a.api_number - b.api_number);

  // A lease's counties and well count come from the SAME sample the well tabs
  // draw, so the lease table cannot claim wells the fleet list does not show.
  const countiesByLease = new Map<string, Set<number>>();
  const wellsByLease = new Map<string, number>();
  for (const w of sample) {
    const key = leaseKeyOf(w);
    if (!key) continue;
    wellsByLease.set(key, (wellsByLease.get(key) ?? 0) + 1);
    const county = Math.floor(w.api_number / 100000);
    const set = countiesByLease.get(key);
    if (set) set.add(county);
    else countiesByLease.set(key, new Set([county]));
  }

  const leases: OperatorLease[] = leaseRows.map((l) => {
    // `lease.district_no` is PDQ's internal code; the wellbore rows carry the
    // real label, so the key is built with the label to match.
    const label = districtLabel(l.district_no) ?? l.district_no;
    const key = `${l.oil_gas_code}-${label}-${l.lease_no.replace(/^0+/, "")}`;
    return {
      oil_gas_code: l.oil_gas_code,
      district_no: Number(l.district_no),
      lease_no: Number(l.lease_no),
      lease_name: l.lease_name,
      well_count: wellsByLease.get(key) ?? 0,
      oil_last12: l.oil_last12 ?? 0,
      gas_last12: l.gas_last12 ?? 0,
      months: l.months ?? null,
      last_cycle: l.last_cycle,
      county_codes: [...(countiesByLease.get(key) ?? [])].sort((a, b) => a - b),
    };
  });

  // Ordered by the RATE the table prints, not by the window's sum. The query
  // ranks on the sum (and cuts at 3,000 there), but the leases do not all cover
  // the same number of cycles, so the sum's order is not the printed column's
  // order. See `perMonth` in `format.ts`.
  leases.sort(
    (a, b) =>
      perMonth(b.oil_last12, b.months) - perMonth(a.oil_last12, a.months) ||
      perMonth(b.gas_last12, b.months) - perMonth(a.gas_last12, a.months)
  );

  return {
    operator: record ?? null,
    officers,
    wellCount,
    wells,
    capped,
    leases,
    leaseCount: leases.length,
    permits,
    permitTotal: permitCount?.n ?? permits.length,
    wellEvents,
    wellEventsCapped,
    last12: {
      oil_last12: Number(last12?.oil ?? 0),
      gas_last12: Number(last12?.gas ?? 0),
      months: Number(last12?.months ?? 0),
    } satisfies OperatorLast12,
  };
}

/**
 * Trailing-window oil/gas per operator for a set, keyed by operator number.
 *
 * The operator's OWN reported production, which is also what the operator
 * points carry — so the cluster list and the map agree by construction. It is
 * not the whole-lease footprint this returned under Archon.
 *
 * `months` is how many cycles each operator actually filed inside the window,
 * which is what the caller divides by to show a rate. The window itself ends at
 * the last REPORTED cycle, so the ~3 months of RRC lag are outside it rather
 * than sitting inside as empty months that drag every rate down.
 */
export async function getOperatorsLast12(
  operatorNumbers: number[]
): Promise<Map<number, { oil: number; gas: number; months: number }>> {
  await assertPlatformAdmin();
  const m = new Map<number, { oil: number; gas: number; months: number }>();
  if (operatorNumbers.length === 0) return m;
  const { reported } = await getCycleEdge();

  const rows = await rrcQuery<{
    n: number;
    oil: number;
    gas: number;
    months: number;
  }>(
    `select operator_no::int          as n,
            coalesce(sum(oil), 0)::bigint as oil,
            coalesce(sum(gas), 0)::bigint as gas,
            count(distinct month)::int    as months
       from rrc.operator_production_monthly
      where operator_no = any($1)
        and month >  to_date($2, 'YYYY-MM') - interval '12 months'
        and month <= to_date($2, 'YYYY-MM')
      group by 1`,
    [operatorNumbers.map(op6), reported]
  );
  for (const r of rows) {
    m.set(r.n, {
      oil: Number(r.oil),
      gas: Number(r.gas),
      months: Number(r.months),
    });
  }
  return m;
}


/*
 * An operator's commonest oil and gas GATHERER, from the P-4.
 *
 * The P-5 master has no gatherer columns — these are P-4 derived, which is why
 * they read null before `rrc.p4_gatherer` was loaded.
 *
 * "Commonest", not "the" gatherer: an operator with 400 leases can have several,
 * and the CSV has one column each. Taking the one that appears on the most
 * leases is a defensible summary and is labelled as such where it is rendered.
 *
 * TWO RULES THE SOURCE FORCES:
 *   - `is_current` cannot be used to pick the live row. The tape's own
 *     88-levels make it "current PURCHASER", so every gatherer is '0' whatever
 *     its state. Currency comes from the filing's effective date instead.
 *   - P-4 keys districts by PDQ's INTERNAL code, so this joins on the operator
 *     number and never on a district label.
 */
const GATHERER_BY_OPERATOR = `
  with leases as (
    -- Narrow to this operator's leases FIRST, through p4_lease_oper_idx. The
    -- first version of this started with a distinct-on over all 12.1M gatherer
    -- rows and hit the pool's 5 s timeout every time — the same rule that
    -- governs lease_production applies here: never touch the big table without
    -- a filter that an index can serve.
    select oil_gas_code, district, lease_no, operator_no
      from rrc.p4_lease
     where operator_no = any($1)
  ), latest as (
    select distinct on (g.oil_gas_code, g.district, g.lease_no, g.product_code)
           l.operator_no, g.product_code, g.gpn_no
      from leases l
      join rrc.p4_gatherer g
        on g.oil_gas_code = l.oil_gas_code and g.district = l.district
       and g.lease_no = l.lease_no
     where g.type_code = 'G' and g.gpn_no is not null and g.gpn_no <> '000000'
     order by g.oil_gas_code, g.district, g.lease_no, g.product_code,
              g.effective_date desc nulls last
  ), ranked as (
    select operator_no,
           case when product_code = 'O' then 'oil' else 'gas' end as stream,
           gpn_no, count(*) as n,
           row_number() over (
             partition by operator_no,
                          case when product_code = 'O' then 'oil' else 'gas' end
             order by count(*) desc) as rk
      from latest
     group by operator_no, stream, gpn_no
  )
  select r.operator_no,
         max(o.operator_name) filter (where r.stream = 'oil') as oil_gatherer,
         max(o.operator_name) filter (where r.stream = 'gas') as gas_gatherer
    from ranked r
    left join rrc.operators o on o.operator_number = r.gpn_no
   where r.rk = 1
   group by r.operator_no`;

/**
 * P-5 master record for a set of operators, keyed by operator number.
 *
 * `oil_gatherer` / `gas_gatherer` are filled from the P-4 (see
 * `GATHERER_BY_OPERATOR`) — they are not in the P-5 master and read null until
 * that table was loaded. Still null for an operator whose leases have no P-4
 * gatherer on file, which is the honest answer rather than a guess.
 */
export async function getOperatorsP5(
  operatorNumbers: number[]
): Promise<Map<number, OperatorP5>> {
  await assertPlatformAdmin();
  const m = new Map<number, OperatorP5>();
  if (operatorNumbers.length === 0) return m;

  const rows = await rrcQuery<OperatorP5>(
    `select operator_number::int as operator_number,
            p5_status,
            to_char(last_p5_date, 'YYYYMMDD')::int as last_p5_date,
            nullif(regexp_replace(phone1, '\\D', '', 'g'), '')::bigint as phone,
            addr1 as addr_line1, addr2 as addr_line2,
            city1 as city, state1 as state,
            nullif(regexp_replace(zip1, '\\D', '', 'g'), '')::int as zip,
            null::int  as zip_suffix,
            null::text as oil_gatherer,
            null::text as gas_gatherer
       from rrc.operators
      where operator_number = any($1)`,
    [operatorNumbers.map(op6)]
  );
  for (const r of rows) m.set(r.operator_number, r);

  // Second query rather than a join: the gatherer roll-up walks 12.1M P-4
  // connections and the P-5 read is a 78k-row index probe. Joining them would
  // put the cheap read behind the expensive one for every caller, including
  // those that never look at the gatherer columns.
  //
  // Settled, not awaited: this fills two columns of a CSV export. If the P-4
  // tables are missing or the query is slow, the export should still go out
  // with them empty rather than fail.
  try {
    const gath = await rrcQuery<{
      operator_no: string;
      oil_gatherer: string | null;
      gas_gatherer: string | null;
    }>(GATHERER_BY_OPERATOR, [operatorNumbers.map(op6)]);
    for (const g of gath) {
      const rec = m.get(Number(g.operator_no));
      if (rec) {
        rec.oil_gatherer = g.oil_gatherer;
        rec.gas_gatherer = g.gas_gatherer;
      }
    }
  } catch (err) {
    console.error("[scout] P-4 gatherer lookup failed", err);
  }
  return m;
}

/**
 * P-5 status letter for a set of operators — just the letter, keyed by number.
 *
 * Deliberately NOT `getOperatorsP5`, which the operator lists' Status filter
 * would otherwise be tempted to reuse: that one also runs the P-4 gatherer
 * roll-up over 12.1M connections and awaits it, which is the right trade for
 * building a CSV and completely wrong for populating a dropdown. This is the
 * 78k-row index probe on its own.
 *
 * Resolve the letter to a label with `P5_STATUS` (see `format.ts`).
 */
export async function getOperatorsP5Status(
  operatorNumbers: number[]
): Promise<Map<number, string>> {
  await assertPlatformAdmin();
  const m = new Map<number, string>();
  if (operatorNumbers.length === 0) return m;
  const rows = await rrcQuery<{ n: number; p5_status: string | null }>(
    `select operator_number::int as n, p5_status
       from rrc.operators
      where operator_number = any($1)`,
    [operatorNumbers.map(op6)]
  );
  for (const r of rows) {
    const st = r.p5_status?.trim();
    if (st) m.set(r.n, st);
  }
  return m;
}

/** Resolve an operator-name search to numbers for the operator-highlight filter. */
export async function searchOperators(query: string): Promise<OperatorMatch[]> {
  await assertPlatformAdmin();
  const q = query.trim();
  if (q.length < 2) return [];
  return rrcQuery<OperatorMatch>(
    `select operator_number::int as operator_number, operator_name
       from rrc.operators
      where operator_name ilike $1
      order by operator_name
      limit 10`,
    [`%${q.replace(/[%_]/g, "")}%`]
  );
}

// === Network view ===========================================================
// The edge queries live in `./network`, which now reads the mirror's
// `operator_officers` directly instead of Archon's two materialized views.

/**
 * Default Network view: top hubs and the operators they connect (capped per hub
 * so one mega-hub does not crowd out the rest). minWells drops the tiny one-well
 * operators that otherwise form a noisy left tail.
 */
export async function getHubGraph(
  role: NetworkRole = "all",
  minWells = 20,
  hubLimit = 100,
  perHub = 18
): Promise<GraphData> {
  await assertPlatformAdmin();
  return buildGraph(await hubGraphEdges(role, 3, hubLimit, minWells, perHub));
}

/** Focused subgraph around a single person, operator, or county. */
export async function getSubgraph(
  seed: SubgraphSeed,
  minWells = 20
): Promise<GraphData> {
  await assertPlatformAdmin();
  return buildGraph(await subgraphEdges(seed, minWells, 1200));
}

/** Ranked hub list for the controls panel (the "biggest filing partners"). */
export async function getTopHubs(
  role: NetworkRole = "all",
  minOperators = 2,
  limit = 60
): Promise<TopHub[]> {
  await assertPlatformAdmin();
  return topHubs(role, minOperators, limit);
}
