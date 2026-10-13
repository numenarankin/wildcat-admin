import "server-only";

import { rrcQuery, rrcQueryOne, rrcQuerySlow } from "./rrc-db";
import type {
  AreaSeries,
  PersonAffiliation,
  PersonDossier,
  PersonMatch,
  CycleTotals,
  DispositionMonth,
  DispositionStream,
  LeaseCountySplit,
  LeaseDossier,
  LeaseMonth,
  LeaseWell,
  MarketData,
  OperatorDossier,
  OperatorFieldRow,
  OperatorLeaseRow,
  OperatorOfficerRow,
  OperatorRecord,
  OperatorWellCounts,
  CompletionReport,
  CompletionCasing,
  CompletionFormation,
  OperatorWellListRow,
  PermitRow,
  RankedRow,
  WellDossier,
  WellboreRow,
  InjectionMonth,
  NearbyDisposal,
  OperatorDisposal,
  UicPermit,
  WellInjection,
  CasingString,
  H15Test,
  OperatorH15,
  PerfInterval,
  WellConstruction,
  G10Test,
  LeaseW10,
  PluggingJob,
  W10Test,
  LeaseP4,
} from "./rrc-types";
import { districtLabel, toPdqDistrict } from "./rrc-districts";
import {
  apiDigits,
  latestWellRates,
  loadRecordSlices,
  sharesForMonths,
} from "@/lib/rrc/record-split";
import { mergeRecordMonths, scaleMonth } from "./allocate-months";
import { FLUIDS, fluidLabels } from "./rrc-uic";
import { permittedPressurePsig } from "./injection-series";
import { COUNTY_NAMES, COUNTY_OPTIONS } from "./counties";
import { countyApiRange } from "./focus-where";

/**
 * Every read against the Tiger Cloud RRC mirror.
 *
 * The contract is `rrc-types.ts` — these functions return those shapes exactly,
 * so the modals need no reshaping. See `docs/plans/scout-tiger-wiring.md`.
 *
 * THE RULE THAT KEEPS THE PAGE FAST (wiring plan §5): nothing here touches
 * `rrc.lease_production` without either a lease/operator filter or one of the
 * three continuous aggregates. Measured, full dataset: a filtered lease history
 * is 193 ms; an unaggregated scan of the same table is 15.9 SECONDS. The pool
 * carries a 5 s statement_timeout so a violation fails one request instead of
 * taking the page down.
 *
 * Standing domain rules, from the mirror's own schema notes:
 *   - oil is reported per LEASE and allocated across wells; per-well oil is an
 *     estimate and must be labelled as such
 *   - RRC lags ~3 months, so the last 2-3 cycles are unpublished, NOT zero
 *   - `wellbore` is one row per well x lease x field: count(distinct api_number)
 */

// ---------------------------------------------------------------- helpers

/** `date` -> "YYYY-MM". Cast in SQL so no timezone can shift the month. */
const CYCLE = `to_char(cycle, 'YYYY-MM')`;

/**
 * Same, for the PDQ tables that kept RRC's 'YYYYMM' text instead of a date.
 * `district_cycle` and `county_cycle` are plain tables, not hypertables, so
 * they have no `cycle` date column at all.
 */
const YM = `substr(cycle_year_month,1,4) || '-' || substr(cycle_year_month,5,2)`;

/** The 25 published lease measures, aliased to the LeaseMonth field names. */
const LEASE_MEASURES = `
  ${CYCLE} as cycle,
  coalesce(oil_prod_vol, 0)  as oil_prod_vol,
  oil_allow, oil_ending_bal,
  coalesce(gas_prod_vol, 0)  as gas_prod_vol,
  gas_allow, gas_lift_inj_vol,
  coalesce(cond_prod_vol, 0) as cond_prod_vol,
  cond_limit, cond_ending_bal,
  coalesce(csgd_prod_vol, 0) as csgd_prod_vol,
  csgd_limit, csgd_gas_lift,
  oil_tot_disp, gas_tot_disp, cond_tot_disp, csgd_tot_disp,
  prod_report_filed`;

/**
 * The last cycle RRC has actually published, and the last cycle loaded.
 *
 * These differ by ~3 months and the gap is the reporting lag. Cached per
 * process: it changes once a month, and every production chart needs it to
 * decide which trailing zeros are real.
 */
let cycleEdgeCache: { reported: string; loaded: string; at: number } | null =
  null;

export async function getCycleEdge(): Promise<{
  reported: string;
  loaded: string;
}> {
  if (cycleEdgeCache && Date.now() - cycleEdgeCache.at < 3_600_000) {
    return cycleEdgeCache;
  }
  const row = await rrcQueryOne<{ reported: string; loaded: string }>(
    `select to_char(max(month) filter (where oil > 0 or gas > 0), 'YYYY-MM') as reported,
            to_char(max(month), 'YYYY-MM') as loaded
       from rrc.statewide_production_monthly`
  );
  const edge = {
    reported: row?.reported ?? "",
    loaded: row?.loaded ?? "",
    at: Date.now(),
  };
  cycleEdgeCache = edge;
  return edge;
}

type RawLeaseMonth = Omit<LeaseMonth, "reported">;

function withReported(rows: RawLeaseMonth[], reported: string): LeaseMonth[] {
  return rows.map((r) => ({ ...r, reported: r.cycle <= reported }));
}

// ------------------------------------------------------------- disposition

/**
 * Disposition volumes are stored one column per code, e.g.
 * `lease_oil_dispcd00_vol`. Note the casinghead columns are spelled `dispcde`,
 * not `dispcd` — an RRC inconsistency, not a typo here.
 */
const DISP_PREFIX: Record<DispositionStream, string> = {
  oil: "lease_oil_dispcd",
  gas: "lease_gas_dispcd",
  cond: "lease_cond_dispcd",
  csgd: "lease_csgd_dispcde",
};

const DISP_CODES: Record<DispositionStream, string[]> = {
  oil: ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "99"],
  gas: ["01", "02", "03", "04", "05", "06", "07", "08", "09", "99"],
  cond: ["00", "01", "02", "03", "04", "05", "06", "07", "08", "99"],
  csgd: ["01", "02", "03", "04", "05", "06", "07", "08", "99"],
};

function dispSelect(): string {
  const parts: string[] = [`${CYCLE} as cycle`];
  for (const stream of Object.keys(DISP_PREFIX) as DispositionStream[]) {
    for (const code of DISP_CODES[stream]) {
      parts.push(
        `sum(coalesce(${DISP_PREFIX[stream]}${code}_vol,0))::bigint as ${stream}_${code}`
      );
    }
  }
  return parts.join(",\n    ");
}

function shapeDisposition(
  rows: Record<string, unknown>[]
): Record<DispositionStream, DispositionMonth[]> {
  const out: Record<DispositionStream, DispositionMonth[]> = {
    oil: [],
    gas: [],
    cond: [],
    csgd: [],
  };
  for (const row of rows) {
    const cycle = String(row.cycle);
    for (const stream of Object.keys(DISP_PREFIX) as DispositionStream[]) {
      const codes: Record<string, number> = {};
      let any = false;
      for (const code of DISP_CODES[stream]) {
        const v = Number(row[`${stream}_${code}`] ?? 0);
        if (v !== 0) any = true;
        codes[code] = v;
      }
      // Skip all-zero months so a 33-year series is not mostly empty objects.
      if (any) out[stream].push({ cycle, codes });
    }
  }
  return out;
}

// ------------------------------------------------------------------- wells

const WELLBORE_COLS = `
  api_number, district, county_code, county_name, oil_gas_code,
  lease_name, lease_number, field_number, field_name, well_no,
  well_no_display, oil_unit_number, operator_name, operator_number, on_schedule`;

/**
 * One wellbore's share of every record it sits on, by filed well test.
 *
 * Returns an empty array when the hole is on no current schedule, which is the
 * normal state for a plugged or historic wellbore: the caller falls back to the
 * lease series, which is the only grain Texas actually publishes.
 *
 * The scaling and the merge are pure and live in `./allocate-months`, where they
 * are checked against a hand-computed oracle. This function is the reads.
 */
export async function allocatedByTest(
  api: string,
  reported: string
): Promise<LeaseMonth[]> {
  const digits = apiDigits(api);
  if (!digits) return [];
  return (await allocatedByTestBatch([api], reported)).get(digits) ?? [];
}

/**
 * The same allocation for MANY wellbores, reading each record once.
 *
 * A fleet's wells share leases: 400 wells sit on ~110 records, and asking well
 * by well runs the same lease_production read and rebuilds the same share table
 * once per well instead of once per record. This is the batched body and
 * `allocatedByTest` is the one-well caller, so the two cannot drift — there is
 * one definition of a well's share, and the well page, the map's hover rate and
 * an operator's fleet list all reach it through here.
 *
 * Keyed by 8-digit API. A well absent from the result is on no current
 * schedule; the caller falls back to the lease series.
 */
export async function allocatedByTestBatch(
  apis: string[],
  reported: string,
  /**
   * Keep only each record's last `trailing` REPORTED months (and any after
   * them) before scaling. For callers that only read a trailing rate: the
   * merged series' last N reported months are always among its records' own
   * last N, so `monthlyRate(..., N)` is unchanged, and scaling a few months
   * instead of a well's whole history is most of an operator tab's CPU.
   */
  opts: { trailing?: number } = {}
): Promise<Map<string, LeaseMonth[]>> {
  const wanted = new Set(
    apis.map(apiDigits).filter((a): a is string => Boolean(a))
  );
  if (wanted.size === 0) return new Map();
  const slices = await loadRecordSlices([...wanted]);
  if (slices.length === 0) return new Map();

  /*
   * EVERY RECORD IN ONE READ.
   *
   * This was one query per record, eight at a time: Hilcorp's Active wells tab
   * is ~50 records, so six to nine serial waves of ~100-500 ms each, 1.3-2.0 s
   * measured (`ui-perf-check`, "Active wells rates"). The keys go in as three
   * parallel arrays and each row comes back tagged with its record's position,
   * so the rows are exactly the per-record reads' rows, regrouped.
   *
   * LATERAL, not a join: joined, the planner hashes the key list against all
   * of lease_production and hits the 5 s timeout. Lateral keeps it the same
   * per-key `lp_lease_idx` lookup the old reads made, in one round trip.
   */
  const keys = [
    slices.map((sl) => sl.oilGasCode),
    slices.map((sl) => sl.pdqDistrict),
    slices.map((sl) => sl.leaseNo),
  ];
  const perKey = `oil_gas_code = k.og and district_no = k.dist and lease_no = k.lease`;
  const raw = await rrcQuery<RawLeaseMonth & { rec: number }>(
    opts.trailing
      ? // Trailing only: each record's last N reported months, newest-first
        // off the index, plus the unreported months after them. The same rows
        // the trim below keeps from a full read.
        `select k.rec::int as rec, lp.*
           from unnest($1::text[], $2::text[], $3::text[]) with ordinality
                  as k(og, dist, lease, rec)
           cross join lateral (
             (select ${LEASE_MEASURES}
                from rrc.lease_production
               where ${perKey} and cycle < to_date($4, 'YYYY-MM') + interval '1 month'
               order by cycle desc
               limit $5)
             union all
             (select ${LEASE_MEASURES}
                from rrc.lease_production
               where ${perKey} and cycle >= to_date($4, 'YYYY-MM') + interval '1 month')
           ) lp
          order by k.rec, lp.cycle`
      : `select k.rec::int as rec, lp.*
           from unnest($1::text[], $2::text[], $3::text[]) with ordinality
                  as k(og, dist, lease, rec)
           cross join lateral (
             select ${LEASE_MEASURES}
               from rrc.lease_production
              where ${perKey}
              order by cycle
           ) lp
          order by k.rec, lp.cycle`,
    opts.trailing ? [...keys, reported, opts.trailing] : keys
  );
  const rowsByRec = new Map<number, RawLeaseMonth[]>();
  for (const { rec, ...row } of raw) {
    const at = rowsByRec.get(rec);
    if (at) at.push(row);
    else rowsByRec.set(rec, [row]);
  }
  const read = slices.map((slice, i) => {
    // `with ordinality` counts from 1.
    const all = withReported(rowsByRec.get(i + 1) ?? [], reported);
    let months = all;
    if (opts.trailing) {
      let seen = 0;
      let from = 0;
      for (let j = all.length - 1; j >= 0; j -= 1) {
        if (all[j].reported && ++seen === opts.trailing) {
          from = j;
          break;
        }
      }
      months = all.slice(from);
    }
    const shares = sharesForMonths(
      slice,
      months.map((m) => m.cycle.slice(0, 7))
    );
    return { slice, months, shares };
  });

  const perApi = new Map<string, LeaseMonth[][]>();
  for (const { slice, months, shares } of read) {
    for (const [api, wellNo] of Object.entries(slice.wellNoByApi)) {
      if (!wanted.has(api)) continue;
      const scaled = months.map((m) => {
        const month = m.cycle.slice(0, 7);
        return scaleMonth(
          m,
          shares.oil.get(month)?.get(wellNo) ?? 0,
          shares.gas.get(month)?.get(wellNo) ?? 0
        );
      });
      const at = perApi.get(api);
      if (at) at.push(scaled);
      else perApi.set(api, [scaled]);
    }
  }
  // A hole is routinely on two records at once — an oil lease for its oil and
  // its own gas id for its gas — and both are its production.
  return new Map(
    [...perApi].map(([api, sets]) => [api, mergeRecordMonths(sets)])
  );
}

export async function getWellDossier(
  api: string
): Promise<WellDossier | null> {
  // Every row for this hole: the grain is well x lease x field, and the modal
  // shows all of them rather than hiding the duplication behind a distinct.
  const rows = await rrcQuery<WellboreRow & Record<string, unknown>>(
    `select ${WELLBORE_COLS},
            well_type_name, wb_water_land_code, multi_comp_flag, api_depth,
            wb_shut_in_date, wl_shut_in_date, plug_date, plug_lease_name,
            plug_operator_name, completion_date, orig_completion_dt,
            curr_inact_yrs, curr_inact_mos, p5_org_status, h15_status_code,
            wb_14b2_flag, surf_eqp_viol, w3x_viol,
            wl_14b2_ext_status, wl_14b2_mech_integ, wl_14b2_plg_ord_sf,
            wl_14b2_pollution, wl_14b2_fldops_hold, wl_14b2_h15_prob,
            wl_14b2_h15_delq, wl_14b2_oper_delq, wl_14b2_dist_sfp,
            wl_14b2_dist_sf_clnup, wl_14b2_dist_st_plg, wl_14b2_good_faith,
            wl_14b2_well_other,
            w2_g1_filed_date, w2_g1_date, w3_file_date,
            p5_renewal_month, p5_renewal_year,
            recent_permit, recent_permit_lease_name, recent_permit_operator_no,
            modified_dt
       from rrc.wellbore
      where api_number = $1
      order by on_schedule desc nulls last, lease_number`,
    [api]
  );
  if (rows.length === 0) return null;

  // The on-schedule row is the current assignment and the ONLY one carrying
  // status / compliance / filings. 927,795 rows are historic and blank there;
  // `current` is what tells the modal to hide those tabs rather than render
  // them empty.
  const cur = rows.find((r) => r.on_schedule === "Y") ?? null;
  const header = cur ?? rows[0];
  const num = (v: unknown) =>
    v === null || v === undefined || v === "" ? null : Number(v);

  const location = await rrcQueryOne<{
    lat: number | null;
    lon: number | null;
    bottom_lat: number | null;
    bottom_lon: number | null;
    symbol_num: string | null;
    reliability: string | null;
    api10: string | null;
    stcode: string | null;
  }>(
    `select s.lat, s.lon, b.lat as bottom_lat, b.lon as bottom_lon,
            s.symbol_num, s.reliability, b.api10, b.stcode
       from (select lat, lon, symbol_num, reliability from rrc.well_location
              where api_number = $1 limit 1) s
       full outer join
            (select lat, lon, api10, stcode from rrc.well_bottomhole
              where api_number = $1 limit 1) b on true`,
    [api]
  );

  // Production is the LEASE's series reached through well_completion, and it is
  // allocated, never metered per well.
  const { reported } = await getCycleEdge();

  // Which lease's production to show.
  //
  // Take it from the well's CURRENT (on_schedule='Y') EWA row, not from
  // well_completion. That table lists every lease the hole has ever been on --
  // API 00932354 appears under both 00115 (historic) and 28209 (current) --
  // and `limit 1` there silently picks whichever comes first, which showed the
  // wrong lease's production entirely.
  //
  // EWA keys on the REAL district, PDQ on its internal code, so translate.
  // Lease numbers are zero-padded IDENTICALLY in both, so do NOT strip them.
  const link = cur
    ? {
        oil_gas_code: cur.oil_gas_code as string,
        district_no: toPdqDistrict(cur.district as string) as string,
        lease_no: cur.lease_number as string,
      }
    : null;

  let production: LeaseMonth[] = [];
  let allocationShare: number | null = null;
  if (link) {
    const raw = await rrcQuery<RawLeaseMonth>(
      `select ${LEASE_MEASURES}
         from rrc.lease_production
        where oil_gas_code = $1 and district_no = $2 and lease_no = $3
        order by cycle`,
      [link.oil_gas_code, link.district_no, link.lease_no]
    );
    production = withReported(raw, reported);

    // Allocation denominator is wells ON SCHEDULE for the lease — including
    // off-schedule wells understates every per-well figure.
    // rrc.wellbore is EWA and keys on the REAL district; `link` came from
    // well_completion, which is PDQ and keys on the internal code. Joining them
    // directly returns a different lease entirely (see rrc-districts.ts).
    const share = await rrcQueryOne<{ n: number }>(
      `select count(distinct api_number)::int as n
         from rrc.wellbore
        where oil_gas_code = $1 and district = $2 and lease_number = $3
          and on_schedule = 'Y'`,
      [link.oil_gas_code, districtLabel(link.district_no), link.lease_no]
    );
    allocationShare = share && share.n > 0 ? 1 / share.n : null;
  }

  /*
   * The same hole's production, weighted by WELL TEST instead of well count,
   * and gathered from every record the hole sits on rather than one.
   *
   * Two things the `link` series above cannot do:
   *
   *   1. BOTH STREAMS. Texas files oil at the lease level and gas at the WELL
   *      level, so a hole is routinely on two records at once — an oil lease for
   *      its oil and its own six-digit gas id for its gas. Showing one record
   *      shows one stream. The columns do not collide (an oil record carries gas
   *      as `csgd_prod_vol`, a gas record as `gas_prod_vol`), so summing the two
   *      records double-counts nothing.
   *   2. A MEASURED WEIGHT. `allocationShare` is 1/n, which asserts every well
   *      on the lease is the same well. This uses each well's filed W-10 rate,
   *      per month, from the test in effect at the time — the machinery in
   *      `@/lib/rrc/well-share`, shared with the operator-facing pages so a well
   *      reads the same number in Scout as on its own page.
   *
   * Liquids and gas are scaled by DIFFERENT shares: a well can carry the lease's
   * oil and little of its gas. Allowables move with the volume they cap, so a
   * well's share is not left sitting under the whole lease's allowable and read
   * as chronic underproduction.
   */
  const testedProduction = await allocatedByTest(api, reported);

  // Fetched here rather than behind its own route: it is one indexed lookup
  // that misses for most holes, and a second round trip would only buy the
  // modal a spinner on a tab it usually does not show.
  // Three small indexed reads, run together. Each misses for a large share of
  // holes, and a caller that opened the modal is going to look at the tabs they
  // feed — a second round trip per tab would buy a spinner and nothing else.
  const [injection, construction, h15, w10, leaseW10, g10, plugging,
         completionReports] =
    await Promise.all([
    getWellInjection(api),
    getWellConstruction(api),
    getWellH15(api),
    // W-10 is an OIL form keyed on the lease, so it only applies where the
    // current row is an oil completion. A gas well has none and asking costs a
    // round trip for an empty answer.
    cur && cur.oil_gas_code === "O" && cur.district && cur.lease_number
      ? getWellW10(
          cur.district as string,
          cur.lease_number as string,
          (cur.well_no as string) ?? ""
        )
      : Promise.resolve([]),
    cur && cur.oil_gas_code === "O" && cur.district && cur.lease_number
      ? getLeaseW10(cur.district as string, cur.lease_number as string)
      : Promise.resolve(null),
    // G-10 is the exact mirror: a GAS form, and on a gas row `lease_number`
    // holds the six-digit RRC gas id the form is keyed by. Oil and gas wells
    // are disjoint here, so at most one of w10/g10 is ever non-empty.
    cur && cur.oil_gas_code === "G" && cur.district && cur.lease_number
      ? getWellG10(cur.district as string, cur.lease_number as string)
      : Promise.resolve([]),
    // Unconditional: a plugged hole is exactly the case where `cur` is often
    // absent, since a plugged well usually has no on-schedule row left.
    getWellPlugging(api),
    // The filed W-2 / G-1 packets. Three, not five: each carries its own
    // formation list, which averages 22 rows, so the default of five would ship
    // a hundred rows of formation tops to render a panel the reader scrolls.
    // Newest first, so three is the recompletion history that matters.
    getCompletionReports(api, 3),
  ]);
  const w10Share =
    leaseW10?.wells.find((x) => x.well_no === cur?.well_no)?.share ?? null;

  const pick = (r: Record<string, unknown>, k: string) =>
    (r[k] ?? null) as string | null;

  return {
    api_number: api,
    current: Boolean(cur),
    header: header as WellboreRow,
    status: cur
      ? {
          well_type_name: pick(cur, "well_type_name"),
          wb_water_land_code: pick(cur, "wb_water_land_code"),
          multi_comp_flag: pick(cur, "multi_comp_flag"),
          api_depth: num(cur.api_depth),
          wb_shut_in_date: pick(cur, "wb_shut_in_date"),
          wl_shut_in_date: pick(cur, "wl_shut_in_date"),
          plug_date: pick(cur, "plug_date"),
          plug_lease_name: pick(cur, "plug_lease_name"),
          plug_operator_name: pick(cur, "plug_operator_name"),
          completion_date: pick(cur, "completion_date"),
          orig_completion_dt: pick(cur, "orig_completion_dt"),
          curr_inact_yrs: num(cur.curr_inact_yrs),
          curr_inact_mos: num(cur.curr_inact_mos),
          p5_org_status: pick(cur, "p5_org_status"),
          h15_status_code: pick(cur, "h15_status_code"),
        }
      : null,
    compliance: cur
      ? {
          wb_14b2_flag: pick(cur, "wb_14b2_flag"),
          flags: {
            ext_status: pick(cur, "wl_14b2_ext_status"),
            mech_integ: pick(cur, "wl_14b2_mech_integ"),
            plg_ord_sf: pick(cur, "wl_14b2_plg_ord_sf"),
            pollution: pick(cur, "wl_14b2_pollution"),
            fldops_hold: pick(cur, "wl_14b2_fldops_hold"),
            h15_prob: pick(cur, "wl_14b2_h15_prob"),
            h15_delq: pick(cur, "wl_14b2_h15_delq"),
            oper_delq: pick(cur, "wl_14b2_oper_delq"),
            dist_sfp: pick(cur, "wl_14b2_dist_sfp"),
            dist_sf_clnup: pick(cur, "wl_14b2_dist_sf_clnup"),
            dist_st_plg: pick(cur, "wl_14b2_dist_st_plg"),
            good_faith: pick(cur, "wl_14b2_good_faith"),
            well_other: pick(cur, "wl_14b2_well_other"),
          },
          surf_eqp_viol: pick(cur, "surf_eqp_viol"),
          w3x_viol: pick(cur, "w3x_viol"),
        }
      : null,
    filings: cur
      ? {
          w2_g1_filed_date: pick(cur, "w2_g1_filed_date"),
          w2_g1_date: pick(cur, "w2_g1_date"),
          w3_file_date: pick(cur, "w3_file_date"),
          p5_renewal_month: pick(cur, "p5_renewal_month"),
          p5_renewal_year: pick(cur, "p5_renewal_year"),
          recent_permit: pick(cur, "recent_permit"),
          recent_permit_lease_name: pick(cur, "recent_permit_lease_name"),
          recent_permit_operator_no: pick(cur, "recent_permit_operator_no"),
          modified_dt: pick(cur, "modified_dt"),
        }
      : null,
    location: {
      lat: location?.lat ?? null,
      lon: location?.lon ?? null,
      bottom_lat: location?.bottom_lat ?? null,
      bottom_lon: location?.bottom_lon ?? null,
      symbol_num: location?.symbol_num ?? null,
      reliability: location?.reliability ?? null,
      api10: location?.api10 ?? null,
      stcode: location?.stcode ?? null,
      abstract_label: null,
      survey_name: null,
      block_number: null,
    },
    completions: rows as WellboreRow[],
    production,
    allocationShare,
    injection,
    construction,
    h15,
    w10,
    g10,
    plugging,
    completionReports,
    w10Share,
    productionByTest: testedProduction,
  };
}

// ------------------------------------------------------------------ leases

export async function getLeaseDossier(
  oilGasCode: string,
  districtNo: string,
  leaseNo: string
): Promise<LeaseDossier | null> {
  const { reported } = await getCycleEdge();
  const key = [oilGasCode, districtNo, leaseNo];

  // lease_production carries no lease_name: the denormalised name columns were
  // deliberately left out of the 78.6M-row table. rrc.lease has them.
  const head = await rrcQueryOne<{
    lease_name: string | null;
    field_no: string | null;
    operator_no: string | null;
    field_type: string | null;
    gas_well_no: string | null;
  }>(
    `select l.lease_name,
            lp.field_no, lp.operator_no, lp.field_type, lp.gas_well_no
       from rrc.lease_production lp
       left join rrc.lease l
              on l.oil_gas_code = lp.oil_gas_code
             and l.district_no  = lp.district_no
             and l.lease_no     = lp.lease_no
      where lp.oil_gas_code = $1 and lp.district_no = $2 and lp.lease_no = $3
      order by lp.cycle desc
      limit 1`,
    key
  );
  if (!head) return null;

  const [rawMonthly, disp, counties, wells, meta] = await Promise.all([
    rrcQuery<RawLeaseMonth>(
      `select ${LEASE_MEASURES}
         from rrc.lease_production
        where oil_gas_code = $1 and district_no = $2 and lease_no = $3
        order by cycle`,
      key
    ),
    rrcQuery<Record<string, unknown>>(
      `select ${dispSelect()}
         from rrc.lease_cycle_disp
        where oil_gas_code = $1 and district_no = $2 and lease_no = $3
        group by cycle
        order by cycle`,
      key
    ),
    // The ONLY correct way to attribute a lease to a county: 7,353 leases span
    // more than one and carry 10.13% of all Texas oil.
    rrcQuery<LeaseCountySplit>(
      `select county_no,
              max(county_name) as county_name,
              sum(coalesce(cnty_lse_oil_prod_vol,0))::bigint  as oil_prod_vol,
              sum(coalesce(cnty_lse_gas_prod_vol,0))::bigint  as gas_prod_vol,
              sum(coalesce(cnty_lse_cond_prod_vol,0))::bigint as cond_prod_vol,
              sum(coalesce(cnty_lse_csgd_prod_vol,0))::bigint as csgd_prod_vol
         from rrc.county_lease_cycle
        where oil_gas_code = $1 and district_no = $2 and lease_no = $3
        group by county_no
        order by oil_prod_vol desc`,
      key
    ),
    // well_root_no groups sidetracks so one hole is not counted twice.
    rrcQuery<LeaseWell>(
      /*
       * `well_location` joins for the Map tab. LEFT, and deliberately so: a
       * hole the RRC never geocoded must still appear in the Wells table, so a
       * missing coordinate costs it a pin and nothing else.
       *
       * THE `::char(8)` IS LOAD-BEARING. `api_number` is `character(8)` on both
       * joined tables while the concatenation is `text`, and bpchar = text
       * casts the INDEXED side, so `wellbore_api_idx` and
       * `well_location_api_idx` both went unused: the plan seq-scanned
       * well_location (1.4M rows) and sorted 439,686 wellbore rows to disk to
       * answer a lease with 11 wells. Measured 1,010 ms, against 60-90 ms with
       * the cast and two index scans. See docs/scout-load-profile.md.
       */
      `select distinct on (wc.api_county_code || wc.api_unique_no)
              wc.api_county_code || wc.api_unique_no as api_number,
              wc.well_no, wc.well_root_no, w.well_type_name, wc.county_name,
              l.lat, l.lon
         from rrc.well_completion wc
         left join rrc.wellbore w
           on w.api_number = (wc.api_county_code || wc.api_unique_no)::char(8)
          and w.on_schedule = 'Y'
         left join rrc.well_location l
           on l.api_number = (wc.api_county_code || wc.api_unique_no)::char(8)
        where wc.oil_gas_code = $1 and wc.district_no = $2 and wc.lease_no = $3
        order by 1`,
      key
    ),
    rrcQueryOne<{ off_schedule: string | null; severance: string | null }>(
      `select lease_off_sched_flag as off_schedule,
              lease_severance_flag    as severance
         from rrc.regulatory_lease
        where oil_gas_code = $1 and district_no = $2 and lease_no = $3
        limit 1`,
      key
    ).catch(() => null),
  ]);

  const field = head.field_no
    ? await rrcQueryOne<{ field_name: string | null }>(
        `select field_name from rrc.field where field_no = $1 limit 1`,
        [head.field_no]
      )
    : null;

  const operator = head.operator_no
    ? await rrcQueryOne<{ operator_name: string }>(
        `select operator_name from rrc.operators where operator_number = $1`,
        [head.operator_no]
      )
    : null;

  /*
   * Each well's share of the lease's latest reported month, weighted by filed
   * well test, so the Wells tab answers "which of these is making the oil"
   * rather than only listing them. Service holes take no share.
   *
   * Reached through the wells' API numbers because `w10_test` and `wellbore` key
   * on the REAL district while this dossier carries PDQ's internal code.
   */
  const rates = await (async () => {
    try {
      const slices = await loadRecordSlices(wells.map((w) => w.api_number));
      const mine = slices.find(
        (sl) => sl.pdqDistrict === districtNo && sl.leaseNo === leaseNo
      );
      return mine ? await latestWellRates(mine) : null;
    } catch (err) {
      // A rate is context, not content: the table lists the wells regardless.
      console.error("[scout] lease well rates failed", err);
      return null;
    }
  })();
  const wellsWithRates: LeaseWell[] = wells.map((w) => {
    const wellNo = (w.well_no ?? "").trim();
    const rate = rates?.get(wellNo) ?? null;
    return {
      ...w,
      oil_bbl_per_day: rate?.oilBblPerDay ?? null,
      gas_mcf_per_day: rate?.gasMcfPerDay ?? null,
    };
  });

  // The lease modal's district IS the PDQ internal code, which is exactly what
  // p4_lease keys on — so this join needs no translation, unlike the wellbore
  // reads above it. Settled so a missing P-4 table costs the tab, not the modal.
  const p4 = await getLeaseP4(oilGasCode, districtNo, leaseNo).catch((err) => {
    console.error("[scout] lease P-4 lookup failed", err);
    return { connections: [], filings: [] };
  });

  return {
    oil_gas_code: oilGasCode as "O" | "G",
    district_no: districtNo,
    // The user must see the REAL district (09), not PDQ's internal code (13).
    district_name: districtLabel(districtNo),
    lease_no: leaseNo,
    lease_name: head.lease_name,
    field_no: head.field_no,
    field_name: field?.field_name ?? null,
    field_type: head.field_type,
    gas_well_no: head.gas_well_no,
    operator_no: head.operator_no,
    operator_name: operator?.operator_name ?? null,
    off_schedule: meta?.off_schedule === "Y",
    severance: meta?.severance === "Y",
    monthly: withReported(rawMonthly, reported),
    disposition: shapeDisposition(disp),
    counties,
    wells: wellsWithRates,
    p4,
  };
}

// --------------------------------------------------------------- operators

const REASON_LABELS: { col: string; label: string }[] = [
  { col: "wl_14b2_ext_status", label: "Extension status" },
  { col: "wl_14b2_mech_integ", label: "Mechanical integrity" },
  { col: "wl_14b2_plg_ord_sf", label: "Plugging order" },
  { col: "wl_14b2_pollution", label: "Pollution" },
  { col: "wl_14b2_fldops_hold", label: "Field ops hold" },
  { col: "wl_14b2_h15_prob", label: "H-15 problem" },
  { col: "wl_14b2_h15_delq", label: "H-15 delinquent" },
  { col: "wl_14b2_oper_delq", label: "Operator delinquent" },
  { col: "wl_14b2_dist_sfp", label: "District SFP" },
  { col: "wl_14b2_dist_sf_clnup", label: "District surface cleanup" },
  { col: "wl_14b2_dist_st_plg", label: "District state plugging" },
  { col: "wl_14b2_good_faith", label: "Good faith" },
  { col: "wl_14b2_well_other", label: "Other" },
];

/**
 * The leases and fields an operator holds TODAY, with each one's trailing
 * twelve months of production, whoever filed it.
 *
 * WHY NOT `lease_production.operator_no`. That column is the operator of record
 * for THAT MONTH'S report. A lease sold after the last published cycle wears
 * the seller's number on all twelve trailing months, so the old query, which
 * filtered production by operator, gave a seller his outgoing year and gave the
 * buyer nothing until the next report landed. Joseph G. Ryan (739833) is the
 * case that surfaced it: 34 leases and ~7,700 bbl on the tab, 21 of those
 * leases already filed under Roil Operating in `rrc.lease`, and the wells tab,
 * which reads the CURRENT P-5 schedule, showing the 20 holes he kept. The two
 * tabs were describing different companies.
 *
 * `rrc.lease.operator_no` is the lease master, updated on the P-4 transfer, so
 * driving from it makes every tab of the modal answer "what does this operator
 * run now": Ryan gets 27 leases and ~170 bbl, Roil gets the 18 with their full
 * trailing year. Leases with nothing filed in the window still appear, at zero,
 * because holding an idle lease is part of the footprint.
 *
 * ONE STATEMENT for both lists: the per-lease pass is a keyed probe into
 * `lease_production` per lease held (`lp_lease_idx`, cycle-pruned), which is
 * the whole cost for a big fleet, and the field list is that same pass grouped
 * differently. Measured: Ryan 368 ms, Approach 128 ms, Hilcorp's 10,051 leases
 * 1.86 s, against ~1.1 s for the old lease read alone. `rrc.lease` has no index
 * on operator_no yet (rrc-data sql/021 adds one); until it is applied the
 * driving scan is 385k rows, which is well under 100 ms of that.
 *
 * The RRC's own `operator_production` series (the Production tab) is left on
 * the filer basis deliberately: it is the record of what each operator
 * reported, and rebasing decades of it onto today's lease list would show a
 * buyer producing leases it did not own.
 */
async function getOperatorFootprint(
  operatorNo: string,
  reported: string
): Promise<{ leases: OperatorLeaseRow[]; fields: OperatorFieldRow[] }> {
  const row = await rrcQueryOne<{
    leases: OperatorLeaseRow[];
    fields: OperatorFieldRow[];
  }>(
    `with mine as (
       select l.oil_gas_code, l.district_no, l.lease_no, l.lease_name, l.field_no
         from rrc.lease l
        where l.operator_no = $1
     ),
     recent as (
       select m.oil_gas_code, m.district_no, m.lease_no, m.lease_name,
              -- The field the production was filed against, falling back to
              -- the lease master's for a lease with nothing in the window.
              coalesce(x.field_no, m.field_no) as field_no,
              x.oil_last12, x.gas_last12, x.months
         from mine m
         cross join lateral (
           select max(lp.field_no) as field_no,
                  coalesce(sum(coalesce(lp.oil_prod_vol,0)),0)::bigint as oil_last12,
                  coalesce(sum(coalesce(lp.gas_prod_vol,0)),0)::bigint as gas_last12,
                  count(distinct lp.cycle)::int as months
             from rrc.lease_production lp
            where lp.oil_gas_code = m.oil_gas_code
              and lp.district_no  = m.district_no
              and lp.lease_no     = m.lease_no
              and lp.cycle >  to_date($2, 'YYYY-MM') - interval '12 months'
              and lp.cycle <= to_date($2, 'YYYY-MM')
         ) x
     ),
     leases as (
       select r.oil_gas_code, r.district_no, r.lease_no, r.lease_name,
              f.field_name, null::text as county_name, 0::int as well_count,
              r.oil_last12, r.gas_last12, r.months,
              coalesce(rl.lease_off_sched_flag = 'Y', false) as off_schedule,
              coalesce(rl.lease_severance_flag   = 'Y', false) as severance
         from recent r
         left join rrc.field f on f.field_no = r.field_no
         left join rrc.regulatory_lease rl
                on rl.oil_gas_code = r.oil_gas_code
               and rl.district_no  = r.district_no
               and rl.lease_no     = r.lease_no
        order by r.oil_last12 desc, r.gas_last12 desc, r.lease_name
        limit 500
     ),
     fields as (
       select r.field_no,
              coalesce(max(f.field_name), r.field_no) as field_name,
              count(distinct r.lease_no)::int as lease_count,
              sum(r.oil_last12)::bigint as oil_last12,
              sum(r.gas_last12)::bigint as gas_last12,
              max(r.months)::int as months
         from recent r
         left join rrc.field f on f.field_no = r.field_no
        where r.field_no is not null
        group by r.field_no
        order by oil_last12 desc nulls last
        limit 200
     )
     select (select coalesce(json_agg(leases), '[]'::json) from leases) as leases,
            (select coalesce(json_agg(fields), '[]'::json) from fields) as fields`,
    [operatorNo, reported]
  ).catch(() => null);
  return { leases: row?.leases ?? [], fields: row?.fields ?? [] };
}

export async function getOperatorDossier(
  operatorNo: string
): Promise<OperatorDossier | null> {
  const record = await rrcQueryOne<OperatorRecord>(
    `select operator_number, operator_name, p5_status, flags,
            addr1, city1, state1, zip1, addr2, city2, state2, zip2,
            phone1, phone2,
            to_char(org_date, 'YYYY-MM-DD')     as org_date,
            to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
       from rrc.operators
      where operator_number = $1`,
    [operatorNo]
  );
  if (!record) return null;

  const { reported } = await getCycleEdge();

  /*
   * ONE wave, not four.
   *
   * The lease list, the field list and the two compliance reads depend on
   * nothing in this group and on nothing in each other: they need the operator
   * number and the reported cycle, both of which are already in hand. Awaited
   * one after another they made the dossier six serial round trips deep, with
   * the 1.0 s lease read and the 0.4 s field read sitting end to end behind a
   * group that had already finished. See docs/scout-load-profile.md.
   */
  const [
    officers,
    wellRows,
    counts,
    reasons,
    rawMonthly,
    permits,
    permitCount,
    { leases, fields },
    disposal,
    h15,
  ] = await Promise.all([
      rrcQuery<OperatorOfficerRow>(
        `select officer_name, officer_title, addr1, city, state, zip
           from rrc.operator_officers
          where operator_number = $1
          order by officer_title, officer_name`,
        [operatorNo]
      ),
      // The fleet, CAPPED. Buckets come from the RRC's OWN well_type_name
      // domain, not from a lease-production proxy.
      //
      // Uncapped this was the one query in the dossier that could not be
      // served: 8,953 rows for the largest operator in Texas, measured at 3.6
      // to 6.2 s against a 5 s statement timeout, so the top two operators by
      // production could not be opened AT ALL. Every other collection here is
      // already bounded (leases 500, permits OPERATOR_PERMIT_CAP) and this one
      // was not. At the cap it is 1.4 s.
      //
      // Nothing counted depends on this list any more: `wells.total` and the
      // flag tallies come off the aggregate below, which reads the same rows
      // without shipping them.
      rrcQuery<OperatorWellListRow & { wb_14b2_flag: string | null }>(
        `select distinct on (api_number)
                api_number, well_no, lease_name, lease_number as lease_no,
                county_name, well_type_name,
                nullif(api_depth,'')::bigint as api_depth,
                nullif(curr_inact_yrs,'')::bigint as curr_inact_yrs,
                -- This row's own plug date. Every row here is on-schedule, so
                -- it is the hole's CURRENT record; a plug date on a historic row
                -- belongs to a wellbore this one was re-entered from and does
                -- not make the well plugged (see well-activity.ts).
                nullif(plug_date,'') as plug_date,
                wb_14b2_flag
           from rrc.wellbore
          where operator_number = $1 and on_schedule = 'Y'
          order by api_number
          limit ${OPERATOR_WELL_CAP + 1}`,
        [operatorNo]
      ),
      rrcQuery<{ well_type_name: string | null; n: number }>(
        `select well_type_name, count(distinct api_number)::int as n
           from rrc.wellbore
          where operator_number = $1 and on_schedule = 'Y'
          group by well_type_name
          order by n desc`,
        [operatorNo]
      ),
      rrcQueryOne<Record<string, number>>(
        `select ${REASON_LABELS.map(
          (r) => `count(*) filter (where nullif(${r.col},'') is not null)::int as ${r.col}`
        ).join(", ")},
                count(*) filter (where wb_14b2_flag = 'Y')::int as flagged,
                count(*) filter (where nullif(surf_eqp_viol,'') is not null)::int as surf,
                count(*) filter (where nullif(w3x_viol,'') is not null)::int as w3x,
                count(*) filter (where nullif(plug_date,'') is not null)::int as plugged,
                -- The fleet size, and the reason the list above can be capped.
                -- NOT the sum of the per-type counts beside it: 13 of Pioneer's
                -- wells carry two well_type_names, so that sum reads 8,966
                -- against 8,953 actual holes. One number, one derivation.
                count(distinct api_number)::int as well_total
           from rrc.wellbore
          where operator_number = $1 and on_schedule = 'Y'`,
        [operatorNo]
      ),
      // Operator series comes from the RRC's own rollup, never a roll-up from
      // 78.6M lease rows.
      rrcQuery<{
        cycle: string;
        oil_prod_vol: number;
        gas_prod_vol: number;
        cond_prod_vol: number;
        csgd_prod_vol: number;
      }>(
        `select ${CYCLE} as cycle,
                coalesce(oil_prod_vol,0)  as oil_prod_vol,
                coalesce(gas_prod_vol,0)  as gas_prod_vol,
                coalesce(cond_prod_vol,0) as cond_prod_vol,
                coalesce(csgd_prod_vol,0) as csgd_prod_vol
           from rrc.operator_production
          where operator_no = $1
          order by cycle`,
        [operatorNo]
      ),
      // Approved drilling permits. Index-backed on
      // (operator_number, issued_date desc), so the cap is about how much is
      // worth SENDING, not about query cost -- measured at ~0.6 s for the
      // 16,264-permit operator with or without it.
      listPermits({ operatorNo, limit: OPERATOR_PERMIT_CAP }),
      rrcQueryOne<{ n: number }>(
        `select count(*)::int as n from rrc.permit where operator_number = $1`,
        [operatorNo]
      ),
      getOperatorFootprint(operatorNo, reported),
      // Two indexed reads off a table that is small next to production; cheap
      // enough to belong in the dossier rather than behind another tab fetch.
      getOperatorDisposal(operatorNo),
      getOperatorH15(operatorNo),
    ]);

  const byType = counts
    .filter((c) => c.well_type_name)
    .map((c) => ({ type: c.well_type_name as string, count: c.n }));

  const wellRowsTruncated = wellRows.length > OPERATOR_WELL_CAP;
  const fleet = wellRowsTruncated ? wellRows.slice(0, OPERATOR_WELL_CAP) : wellRows;

  const wells: OperatorWellCounts = {
    // From the aggregate, so it stays the whole fleet even when the list below
    // is a page of it.
    total: reasons?.well_total ?? fleet.length,
    byType,
    plugged: reasons?.plugged ?? 0,
    flagged14b2: reasons?.flagged ?? 0,
    reasons: REASON_LABELS.map((r) => ({
      label: r.label,
      count: reasons?.[r.col] ?? 0,
    })).filter((r) => r.count > 0),
    surfaceViolations: reasons?.surf ?? 0,
    w3xViolations: reasons?.w3x ?? 0,
  };

  const monthly: LeaseMonth[] = rawMonthly.map((m) => ({
    cycle: m.cycle,
    oil_prod_vol: m.oil_prod_vol,
    oil_allow: null,
    oil_ending_bal: null,
    gas_prod_vol: m.gas_prod_vol,
    gas_allow: null,
    gas_lift_inj_vol: null,
    cond_prod_vol: m.cond_prod_vol,
    cond_limit: null,
    cond_ending_bal: null,
    csgd_prod_vol: m.csgd_prod_vol,
    csgd_limit: null,
    csgd_gas_lift: null,
    oil_tot_disp: null,
    gas_tot_disp: null,
    cond_tot_disp: null,
    csgd_tot_disp: null,
    prod_report_filed: null,
    reported: m.cycle <= reported,
  }));

  return {
    record,
    officers,
    wells,
    wellRowsTruncated,
    wellRows: fleet.map((w) => ({
      api_number: w.api_number,
      well_no: w.well_no,
      lease_name: w.lease_name,
      lease_no: w.lease_no,
      county_name: w.county_name,
      well_type_name: w.well_type_name,
      api_depth: w.api_depth,
      curr_inact_yrs: w.curr_inact_yrs,
      plug_date: w.plug_date,
      flagged14b2: w.wb_14b2_flag === "Y",
    })),
    leases,
    fields,
    monthly,
    // Loaded lazily by getOperatorDisposition(): an operator's disposition
    // spans every lease they have ever held across 48.5M rows, which is the one
    // query in this file that cannot be served inside the 5 s budget. The
    // Disposition tab fetches it on open; nothing else pays for it.
    disposition: { oil: [], gas: [], cond: [], csgd: [] },
    disposal,
    h15,
    permits,
    permitTotal: permitCount?.n ?? permits.length,
  };
}

/**
 * Operator-grain disposition, for the Disposition tab only.
 *
 * Deliberately NOT part of getOperatorDossier: see the note there. Callers must
 * treat this as a slow path -- show the tab's own loading state rather than
 * blocking the modal.
 */
export async function getOperatorDisposition(
  operatorNo: string
): Promise<Record<DispositionStream, DispositionMonth[]>> {
  const rows = await rrcQuerySlow<Record<string, unknown>>(
    `select ${dispSelect()}
       from rrc.lease_cycle_disp
      where operator_no = $1
      group by cycle
      order by cycle`,
    [operatorNo]
  );
  return shapeDisposition(rows);
}

// ------------------------------------------------------------------ market

export async function getMarketData(): Promise<MarketData> {
  const { reported, loaded } = await getCycleEdge();

  // Districts and counties are pre-aggregated BY THE RRC — 5,252 and 243,957
  // rows. Neither needs a roll-up and neither touches the 78.6M-row table.
  const [statewide, districts, counties, topCounties, topFields, topOperators,
         topLeases] =
    await Promise.all([
      // STOP AT THE REPORTED EDGE. RRC lags ~3 months, so 2026-06..08 exist in
      // the mirror as zeros. Plotted, they draw a cliff to zero that reads as
      // Texas production collapsing. `lastLoadedCycle` still tells the user
      // those months are present but unpublished -- the chart must not imply
      // they are real. CycleTotals carries no per-point "reported" flag, so the
      // only honest option is to not emit them.
      rrcQuery<CycleTotals>(
        `select to_char(month,'YYYY-MM') as cycle,
                coalesce(sum(oil),0)::bigint  as oil,
                coalesce(sum(gas),0)::bigint  as gas,
                coalesce(sum(cond),0)::bigint as cond,
                coalesce(sum(csgd),0)::bigint as csgd
           from rrc.statewide_production_monthly
          group by 1 having coalesce(sum(oil),0) > 0 or coalesce(sum(gas),0) > 0
          order by 1`
      ),
      rrcQuery<{ key: string; label: string; cycle: string } & CycleTotals>(
        `select district_no as key,
                coalesce(max(district_name), district_no) as label,
                ${YM} as cycle,
                coalesce(sum(dist_oil_prod_vol),0)::bigint  as oil,
                coalesce(sum(dist_gas_prod_vol),0)::bigint  as gas,
                coalesce(sum(dist_cond_prod_vol),0)::bigint as cond,
                coalesce(sum(dist_csgd_prod_vol),0)::bigint as csgd
           from rrc.district_cycle
          group by district_no, cycle_year_month
         having coalesce(sum(dist_oil_prod_vol),0) > 0
             or coalesce(sum(dist_gas_prod_vol),0) > 0
          order by district_no, cycle_year_month`
      ).catch(() => []),
      rrcQuery<{ key: string; label: string; cycle: string } & CycleTotals>(
        `select county_no as key,
                coalesce(max(county_name), county_no) as label,
                ${YM} as cycle,
                coalesce(sum(cnty_oil_prod_vol),0)::bigint  as oil,
                coalesce(sum(cnty_gas_prod_vol),0)::bigint  as gas,
                coalesce(sum(cnty_cond_prod_vol),0)::bigint as cond,
                coalesce(sum(cnty_csgd_prod_vol),0)::bigint as csgd
           from rrc.county_cycle
          group by county_no, cycle_year_month
         having coalesce(sum(cnty_oil_prod_vol),0) > 0
             or coalesce(sum(cnty_gas_prod_vol),0) > 0
          order by county_no, cycle_year_month`
      ).catch(() => []),
      // `count` is the Wells column. Without it every row rendered "—", which
      // reads as broken rather than as "not applicable". Well counts come from
      // EWA, keyed on the county code embedded in the API number.
      rrcQuery<RankedRow>(
        `with prod as (
           select county_no,
                  coalesce(max(county_name), county_no) as label,
                  coalesce(sum(cnty_oil_prod_vol),0)::bigint as oil,
                  coalesce(sum(cnty_gas_prod_vol),0)::bigint as gas,
                  count(distinct cycle_year_month)::int      as months
             from rrc.county_cycle
            -- Strictly greater-than at the lower bound, matching topFields and
            -- topOperators below. With >= this table alone summed 13 cycles, so
            -- the three leaderboards on one screen ranked different windows.
            -- The window ENDS at the last reported cycle, so none of the ~3
            -- lagging months sit inside it as empty ones.
            where cycle_year_month >  to_char(to_date($1,'YYYY-MM') - interval '12 months','YYYYMM')
              and cycle_year_month <= to_char(to_date($1,'YYYY-MM'),'YYYYMM')
            group by county_no
            order by oil desc nulls last
            limit 25
         ), wells as (
           select substr(api_number,1,3) as cc,
                  count(distinct api_number)::int as n
             from rrc.wellbore where on_schedule = 'Y'
            group by 1
         )
         select p.county_no as key, p.label, p.oil, p.gas, p.months,
                coalesce(w.n, 0) as count
           from prod p left join wells w on w.cc = p.county_no
          order by p.oil desc`,
        [reported]
      ).catch(() => []),
      rrcQuery<RankedRow>(
        `with prod as (
           select f.field_no,
                  coalesce(max(fd.field_name), f.field_no) as label,
                  coalesce(sum(f.field_oil_prod_vol),0)::bigint as oil,
                  coalesce(sum(f.field_gas_prod_vol),0)::bigint as gas,
                  count(distinct f.cycle)::int                  as months
             from rrc.field_cycle f
             left join rrc.field fd on fd.field_no = f.field_no
            where f.cycle >  to_date($1,'YYYY-MM') - interval '12 months'
              and f.cycle <= to_date($1,'YYYY-MM')
            group by f.field_no
            order by oil desc nulls last
            limit 25
         ), wells as (
           select field_number, count(distinct api_number)::int as n
             from rrc.wellbore where on_schedule = 'Y'
            group by 1
         )
         select p.field_no as key, p.label, p.oil, p.gas, p.months,
                coalesce(w.n, 0) as count
           from prod p left join wells w on w.field_number = p.field_no
          order by p.oil desc`,
        [reported]
      ).catch(() => []),
      // Credited to the lease holder of record, not the filer of each month;
      // see `operatorTopRecent`. The wells column is the current schedule
      // either way, so on the fallback the two columns can disagree about who
      // an operator is, which is the very thing the view fixes.
      operatorTopRecent(25).then(async (top) => {
        if (!top) {
          return rrcQuery<RankedRow>(
            `with prod as (
               select m.operator_no,
                      coalesce(max(o.operator_name), m.operator_no) as label,
                      coalesce(sum(m.oil),0)::bigint as oil,
                      coalesce(sum(m.gas),0)::bigint as gas,
                      count(distinct m.month)::int   as months
                 from rrc.operator_production_monthly m
                 left join rrc.operators o on o.operator_number = m.operator_no
                where m.month >  to_date($1,'YYYY-MM') - interval '12 months'
                  and m.month <= to_date($1,'YYYY-MM')
                group by m.operator_no
                order by oil desc nulls last
                limit 25
             ), wells as (
               select operator_number, count(distinct api_number)::int as n
                 from rrc.wellbore where on_schedule = 'Y'
                group by 1
             )
             select p.operator_no as key, p.label, p.oil, p.gas, p.months,
                    coalesce(w.n, 0) as count
               from prod p left join wells w on w.operator_number = p.operator_no
              order by p.oil desc`,
            [reported]
          );
        }
        const wells = await rrcQuery<{ operator_number: string; n: number }>(
          `select operator_number, count(distinct api_number)::int as n
             from rrc.wellbore
            where on_schedule = 'Y' and operator_number = any($1)
            group by 1`,
          [top.map((r) => r.operator_no)]
        );
        const byOp = new Map(wells.map((w) => [w.operator_number, w.n]));
        return top.map<RankedRow>((r) => ({
          key: r.operator_no,
          label: r.operator_name ?? r.operator_no,
          oil: r.oil,
          gas: r.gas,
          months: r.months,
          count: byOp.get(r.operator_no) ?? 0,
        }));
      }),
      // The one board that cannot be read off an RRC rollup: there is no
      // lease-grain aggregate, so this groups the 78.6M-row table itself. Safe
      // only because the cycle bound lets Timescale prune to the last twelve
      // chunks first — 1.6 s measured. Never widen the window here without
      // re-measuring it.
      //
      // THE ONE BOARD STILL DIVIDED BY A FLAT TWELVE. `getLeaderboard` serves
      // the RRC browser and an agent tool as well, where "the last N months"
      // means N CALENDAR months, and its fast path reads the materialised
      // `lease_top_recent`, which carries no cycle count to divide by. So this
      // board's per-month figures still spread their total over twelve months
      // when the RRC has only published nine — reading low against the three
      // boards beside it, which are anchored to the reported edge. Fixing it
      // means giving the materialised view a `months` column.
      getLeaderboard("leases", 12, 25),
    ]);

  const group = (
    rows: ({ key: string; label: string; cycle: string } & CycleTotals)[]
  ): AreaSeries[] => {
    const map = new Map<string, AreaSeries>();
    for (const r of rows) {
      let s = map.get(r.key);
      if (!s) {
        s = { key: r.key, label: r.label, monthly: [] };
        map.set(r.key, s);
      }
      s.monthly.push({
        cycle: r.cycle,
        oil: r.oil,
        gas: r.gas,
        cond: r.cond,
        csgd: r.csgd,
      });
    }
    return [...map.values()];
  };

  // RRC issues distinct field NUMBERS that share a name (two "SPRABERRY (TREND
  // AREA)" entries are different reservoirs, not a duplicate row). Merging them
  // would be wrong, so disambiguate the label instead of hiding the collision.
  const disambiguate = (rows: RankedRow[]): RankedRow[] => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.label, (seen.get(r.label) ?? 0) + 1);
    return rows.map((r) =>
      (seen.get(r.label) ?? 0) > 1 ? { ...r, label: `${r.label} · ${r.key}` } : r
    );
  };

  return {
    statewide,
    districts: group(districts),
    counties: group(counties),
    topCounties,
    topFields: disambiguate(topFields),
    topOperators,
    topLeases: topLeases.map((r) => ({
      key: r.key,
      label: r.label,
      sub: r.sub,
      oil: r.oil,
      gas: r.gas,
    })),
    lastReportedCycle: reported,
    lastLoadedCycle: loaded,
  };
}

// ------------------------------------------------------------------ search

export interface SearchHit {
  kind: "operator" | "lease" | "field" | "well";
  key: string;
  label: string;
  sub?: string | null;
}

/** One box over operators, leases, fields and wellbore lease names. */
export async function search(q: string, limit = 10): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;

  const [operators, leases, fields, wells] = await Promise.all([
    rrcQuery<{ key: string; label: string; sub: string | null }>(
      `select operator_number as key, operator_name as label,
              nullif(concat_ws(', ', city1, state1), '') as sub
         from rrc.operators
        where operator_name ilike $1
        order by operator_name
        limit $2`,
      [like, limit]
    ),
    // NOTE the district here: `key` carries PDQ's internal code because the
    // lease route is keyed on it, but `sub` must show the REAL district or the
    // user reads "District 13" for a District 09 lease. Translated below.
    rrcQuery<{ key: string; label: string; sub: string | null }>(
      `select oil_gas_code || '/' || district_no || '/' || lease_no as key,
              lease_name as label,
              district_no as sub
         from rrc.lease
        where lease_name ilike $1
        order by lease_name
        limit $2`,
      [like, limit]
    ),
    rrcQuery<{ key: string; label: string; sub: string | null }>(
      `select field_no as key, field_name as label, district_no as sub
         from rrc.field
        where field_name ilike $1
        order by field_name
        limit $2`,
      [like, limit]
    ),
    rrcQuery<{ key: string; label: string; sub: string | null }>(
      `select api_number as key,
              coalesce(lease_name, api_number) as label,
              county_name as sub
         from rrc.wellbore
        where on_schedule = 'Y' and lease_name ilike $1
        order by lease_name
        limit $2`,
      [like, limit]
    ),
  ]);

  return [
    ...operators.map((r) => ({ kind: "operator" as const, ...r })),
    ...leases.map((r) => ({
      kind: "lease" as const,
      ...r,
      sub: `District ${districtLabel(r.sub) ?? r.sub}`,
    })),
    ...fields.map((r) => ({ kind: "field" as const, ...r })),
    ...wells.map((r) => ({ kind: "well" as const, ...r })),
  ];
}

// =============================================================== agent reads
//
// Everything below is reached by Orion's tools (`src/lib/ai/rrc-tools.ts`) and
// by no UI screen. Same rules as above — filtered or pre-aggregated, never an
// unbounded scan of `lease_production`.
//
// DISTRICT CODING, AGAIN. Two of the tables below are keyed differently and it
// is NOT cosmetic:
//   - `rrc.permit`     uses PDQ's internal code (01-11, 13, 14) — same as
//                      `lease` / `lease_production`. Verified: its domain is
//                      exactly PDQ's, with no 6E/7B/7C/8A.
//   - `rrc.completion` uses the REAL district label (01-10, 6E, 7B, 7C, 8A) —
//                      same as `wellbore`.
// A permit row reading "district 13" is District 09. Translate on the way out
// with `districtLabel`, and on the way in with `toPdqDistrict`.

/** RRC county codes are 3-char zero-padded text everywhere in the mirror. */
function padCounty(code: number | string): string {
  return String(code).replace(/\D/g, "").padStart(3, "0");
}

/**
 * Resolve "Andrews" / "003" / "3" to a county code + name, or null.
 *
 * The name table is `counties.ts` (the RRC's own code handout), not a query:
 * county names live in `county_cycle` only for counties that have produced, and
 * a permit in a county with no production still needs a name.
 */
export function resolveCounty(
  ref: string
): { county_no: string; county_name: string } | null {
  const raw = ref.trim();
  if (!raw) return null;
  if (/^\d{1,3}$/.test(raw)) {
    const n = Number(raw);
    const name = COUNTY_NAMES[n];
    return name ? { county_no: padCounty(n), county_name: name } : null;
  }
  const want = raw.toLowerCase();
  const hit =
    COUNTY_OPTIONS.find((c) => c.name.toLowerCase() === want) ??
    COUNTY_OPTIONS.find((c) => c.name.toLowerCase().startsWith(want));
  return hit
    ? { county_no: padCounty(hit.code), county_name: hit.name }
    : null;
}

/**
 * Cycle-bound expression for the hypertables: bounded => chunk pruning.
 *
 * Strictly greater-than, so `since(12)` is the twelve cycles ENDING with the
 * current month. `months` is clamped to a whole number because it is
 * interpolated, never bound.
 */
const since = (months: number) =>
  `(date_trunc('month', now()) - interval '${Math.max(1, Math.floor(months))} months')`;

/**
 * The same window for the two PDQ tables that kept RRC's 'YYYYMM' TEXT instead
 * of a date (`county_cycle`, `district_cycle`).
 *
 * It must be `>` and not `>=`, or these tables answer for one more month than
 * every date-keyed table does. That is not a rounding difference: measured on
 * Andrews over 12 months, `>=` returned 51,240,520 bbl against the
 * `county_lease_cycle` grain's 45,047,075 — a 13.7% overstatement that looks
 * exactly like a data error and isn't one.
 */
const sinceYm = (months: number) =>
  `to_char(now() - interval '${Math.max(1, Math.floor(months))} months', 'YYYYMM')`;

export interface SeriesPoint {
  cycle: string;
  oil: number;
  gas: number;
  cond: number;
  csgd: number;
  /** False once past the RRC's publication edge — unpublished, NOT zero. */
  reported: boolean;
}

// ------------------------------------------------------------------- fields

export interface FieldMatch {
  field_no: string;
  field_name: string | null;
  district_no: string;
  district_name: string | null;
}

/** Field numbers are the key; names are neither unique nor stable. */
export async function resolveField(ref: string, limit = 8): Promise<FieldMatch[]> {
  const term = ref.trim();
  if (!term) return [];
  const rows = await rrcQuery<{
    field_no: string;
    field_name: string | null;
    district_no: string;
  }>(
    `select field_no, field_name, district_no
       from rrc.field
      where field_no = $1 or field_name ilike $2
      order by (field_no = $1) desc, (upper(field_name) = upper($3)) desc, field_name
      limit $4`,
    [term, `%${term}%`, term, limit]
  );
  return rows.map((r) => ({ ...r, district_name: districtLabel(r.district_no) }));
}

export interface FieldProfile extends FieldMatch {
  monthly: SeriesPoint[];
  lifetime: { oil: number; gas: number; cond: number; csgd: number };
  leaseCount: number;
  topOperators: {
    operator_no: string;
    operator_name: string | null;
    oil: number;
    gas: number;
    leases: number;
  }[];
}

export async function getFieldProfile(
  fieldNo: string,
  months = 24
): Promise<FieldProfile | null> {
  // Validate against `rrc.field` FIRST. `field_cycle` has no index on field_no,
  // so a miss there scans all 11.2M rows (measured 7.5 s — past the timeout),
  // while a hit prunes to the segment. The primary-key check costs ~50 ms and
  // turns "unknown field" from a timeout into a null.
  const head = await rrcQueryOne<{
    field_no: string;
    field_name: string | null;
    district_no: string;
  }>(`select field_no, field_name, district_no from rrc.field where field_no = $1`, [
    fieldNo,
  ]);
  if (!head) return null;

  const { reported } = await getCycleEdge();

  // field_cycle carries one row per district per cycle for a field, so every
  // read here groups before it reports.
  const [monthly, lifetime, ops] = await Promise.all([
    rrcQuery<Omit<SeriesPoint, "reported">>(
      `select ${CYCLE} as cycle,
              coalesce(sum(field_oil_prod_vol),0)::bigint  as oil,
              coalesce(sum(field_gas_prod_vol),0)::bigint  as gas,
              coalesce(sum(field_cond_prod_vol),0)::bigint as cond,
              coalesce(sum(field_csgd_prod_vol),0)::bigint as csgd
         from rrc.field_cycle
        where field_no = $1 and cycle > ${since(months)}
        group by 1
        order by 1`,
      [fieldNo]
    ),
    rrcQueryOne<{ oil: number; gas: number; cond: number; csgd: number }>(
      `select coalesce(sum(field_oil_prod_vol),0)::bigint  as oil,
              coalesce(sum(field_gas_prod_vol),0)::bigint  as gas,
              coalesce(sum(field_cond_prod_vol),0)::bigint as cond,
              coalesce(sum(field_csgd_prod_vol),0)::bigint as csgd
         from rrc.field_cycle where field_no = $1`,
      [fieldNo]
    ),
    rrcQuery<{
      operator_no: string;
      operator_name: string | null;
      oil: number;
      gas: number;
      leases: number;
    }>(
      `with agg as (
         select operator_no,
                coalesce(sum(oil_prod_vol),0)::bigint as oil,
                coalesce(sum(gas_prod_vol),0)::bigint as gas,
                count(distinct lease_no)::int         as leases
           from rrc.lease_production
          where field_no = $1 and cycle > ${since(months)}
          group by 1
          order by oil desc nulls last
          limit 15
       )
       select a.*, o.operator_name
         from agg a left join rrc.operators o on o.operator_number = a.operator_no
        order by a.oil desc, a.gas desc`,
      [fieldNo]
    ),
  ]);

  const leases = await rrcQueryOne<{ n: number }>(
    `select count(distinct lease_no)::int as n
       from rrc.lease_production
      where field_no = $1 and cycle > ${since(months)}`,
    [fieldNo]
  );

  return {
    field_no: head.field_no,
    field_name: head.field_name,
    district_no: head.district_no,
    district_name: districtLabel(head.district_no),
    monthly: monthly.map((m) => ({ ...m, reported: m.cycle <= reported })),
    lifetime: lifetime ?? { oil: 0, gas: 0, cond: 0, csgd: 0 },
    leaseCount: leases?.n ?? 0,
    topOperators: ops,
  };
}

// ----------------------------------------------------------------- counties

export interface CountyProfile {
  county_no: string;
  county_name: string;
  districts: string[];
  monthly: SeriesPoint[];
  lifetime: { oil: number; gas: number; cond: number; csgd: number };
  wellCount: number;
  permitsLast12: number;
  topLeases: {
    oil_gas_code: string;
    district_no: string;
    district_name: string | null;
    lease_no: string;
    lease_name: string | null;
    oil: number;
    gas: number;
  }[];
}

export async function getCountyProfile(
  countyNo: string,
  months = 24
): Promise<CountyProfile | null> {
  const resolved = resolveCounty(countyNo);
  if (!resolved) return null;
  const code = resolved.county_no;
  const { reported } = await getCycleEdge();

  const [monthly, lifetime, districts, wells, permits, leases] =
    await Promise.all([
      // county_cycle keeps RRC's 'YYYYMM' text, and splits each month across
      // oil and gas rows — group before reporting.
      rrcQuery<Omit<SeriesPoint, "reported">>(
        `select ${YM} as cycle,
                coalesce(sum(cnty_oil_prod_vol),0)::bigint  as oil,
                coalesce(sum(cnty_gas_prod_vol),0)::bigint  as gas,
                coalesce(sum(cnty_cond_prod_vol),0)::bigint as cond,
                coalesce(sum(cnty_csgd_prod_vol),0)::bigint as csgd
           from rrc.county_cycle
          where county_no = $1 and cycle_year_month > ${sinceYm(months)}
          group by 1
          order by 1`,
        [code]
      ),
      rrcQueryOne<{ oil: number; gas: number; cond: number; csgd: number }>(
        `select coalesce(sum(cnty_oil_prod_vol),0)::bigint  as oil,
                coalesce(sum(cnty_gas_prod_vol),0)::bigint  as gas,
                coalesce(sum(cnty_cond_prod_vol),0)::bigint as cond,
                coalesce(sum(cnty_csgd_prod_vol),0)::bigint as csgd
           from rrc.county_cycle where county_no = $1`,
        [code]
      ),
      rrcQuery<{ district_name: string | null }>(
        `select distinct district_name from rrc.county_cycle
          where county_no = $1 and district_name is not null`,
        [code]
      ),
      // The county code is the first three characters of the API number.
      rrcQueryOne<{ n: number }>(
        `select count(distinct api_number)::int as n
           from rrc.wellbore
          where county_code = $1 and on_schedule = 'Y'`,
        [code]
      ),
      rrcQueryOne<{ n: number }>(
        `select count(*)::int as n from rrc.permit
          where county_code = $1 and issued_date > now() - interval '12 months'`,
        [code]
      ),
      rrcQuery<{
        oil_gas_code: string;
        district_no: string;
        lease_no: string;
        lease_name: string | null;
        oil: number;
        gas: number;
      }>(
        `with agg as (
           select oil_gas_code, district_no, lease_no,
                  coalesce(sum(cnty_lse_oil_prod_vol),0)::bigint as oil,
                  coalesce(sum(cnty_lse_gas_prod_vol),0)::bigint as gas
             from rrc.county_lease_cycle
            where county_no = $1 and cycle > ${since(months)}
            group by 1,2,3
            order by oil desc nulls last
            limit 20
         )
         select a.*, l.lease_name
           from agg a
           left join rrc.lease l
                  on l.oil_gas_code = a.oil_gas_code
                 and l.district_no  = a.district_no
                 and l.lease_no     = a.lease_no
          order by a.oil desc, a.gas desc`,
        [code]
      ),
    ]);

  return {
    county_no: code,
    county_name: resolved.county_name,
    districts: districts.map((d) => d.district_name).filter((d): d is string => Boolean(d)),
    monthly: monthly.map((m) => ({ ...m, reported: m.cycle <= reported })),
    lifetime: lifetime ?? { oil: 0, gas: 0, cond: 0, csgd: 0 },
    wellCount: wells?.n ?? 0,
    permitsLast12: permits?.n ?? 0,
    topLeases: leases.map((l) => ({
      ...l,
      district_name: districtLabel(l.district_no),
    })),
  };
}

// -------------------------------------------------------------- leaderboard

export type LeaderboardKind = "operators" | "fields" | "counties" | "leases";

export interface LeaderRow {
  key: string;
  label: string;
  sub: string | null;
  oil: number;
  gas: number;
}

/**
 * The top operators by trailing-twelve-month production, credited to whoever
 * HOLDS each lease today.
 *
 * `rrc.operator_production_monthly` is the RRC's rollup by the operator who
 * filed each month, so an operator who sold out after the last published cycle
 * tops a board for a year of production he no longer runs, and the buyer is
 * absent. `rrc.operator_top_recent` (rrc-data sql/021) regroups the trailing
 * year of `lease_production` by `rrc.lease.operator_no`, the lease master, and
 * is refreshed after each PDQ load, for the same reason `lease_top_recent`
 * exists: the regroup is a statewide pass over 78.6M rows that cannot run
 * inside a request. Null when the view is not there, so callers fall back to
 * the filer rollup rather than failing.
 */
async function operatorTopRecent(limit: number): Promise<
  | {
      operator_no: string;
      operator_name: string | null;
      p5_status: string | null;
      oil: number;
      gas: number;
      months: number;
    }[]
  | null
> {
  const rows = await rrcQuery<{
    operator_no: string;
    operator_name: string | null;
    p5_status: string | null;
    oil: number;
    gas: number;
    months: number;
  }>(
    `select operator_no, operator_name, p5_status, oil, gas, months
       from rrc.operator_top_recent
      order by oil desc, gas desc
      limit $1`,
    [Math.min(500, Math.max(1, Math.floor(limit)))]
  ).catch(() => null);
  return rows && rows.length > 0 ? rows : null;
}

export async function getLeaderboard(
  kind: LeaderboardKind,
  months = 12,
  limit = 25
): Promise<LeaderRow[]> {
  const n = Math.min(100, Math.max(1, Math.floor(limit)));

  if (kind === "operators") {
    // Current holders first; see `operatorTopRecent`. The filer rollup below
    // is the fallback for a mirror without the view or a non-default window.
    if (months === 12) {
      const top = await operatorTopRecent(n);
      if (top) {
        return top.map((r) => ({
          key: r.operator_no,
          label: r.operator_name ?? r.operator_no,
          sub: r.p5_status,
          oil: r.oil,
          gas: r.gas,
        }));
      }
    }
    return rrcQuery<LeaderRow>(
      `with agg as (
         select operator_no,
                coalesce(sum(oil),0)::bigint as oil,
                coalesce(sum(gas),0)::bigint as gas
           from rrc.operator_production_monthly
          where month > ${since(months)}
          group by 1 order by oil desc nulls last limit $1
       )
       select a.operator_no as key,
              coalesce(o.operator_name, a.operator_no) as label,
              o.p5_status as sub, a.oil, a.gas
         from agg a left join rrc.operators o on o.operator_number = a.operator_no
        order by a.oil desc, a.gas desc`,
      [n]
    );
  }

  if (kind === "fields") {
    return rrcQuery<LeaderRow>(
      `select field_no as key,
              coalesce(max(field_name), field_no) as label,
              null::text as sub,
              coalesce(sum(field_oil_prod_vol),0)::bigint as oil,
              coalesce(sum(field_gas_prod_vol),0)::bigint as gas
         from rrc.field_cycle
        where cycle > ${since(months)}
        group by 1 order by oil desc nulls last limit $1`,
      [n]
    );
  }

  if (kind === "counties") {
    return rrcQuery<LeaderRow>(
      `select county_no as key,
              coalesce(max(county_name), county_no) as label,
              max(district_name) as sub,
              coalesce(sum(cnty_oil_prod_vol),0)::bigint as oil,
              coalesce(sum(cnty_gas_prod_vol),0)::bigint as gas
         from rrc.county_cycle
        where cycle_year_month > ${sinceYm(months)}
        group by 1 order by oil desc nulls last limit $1`,
      [n]
    );
  }

  /*
   * Leases, from rrc.lease_top_recent -- a materialised top 500 -- whenever the
   * window is the default twelve months.
   *
   * Grouping rrc.lease_production directly is 1.63 s warm and past the pool's
   * 5 s statement_timeout cold, and this board sits on the market PAGE, so a
   * cold read took the whole page down rather than one panel. Any other window
   * still falls through to the live group-by below, which is the honest answer
   * for a question the view was not built for.
   */
  if (months === 12 && n <= 500) {
    const top = await rrcQuery<{
      oil_gas_code: string;
      district_no: string;
      lease_no: string;
      lease_name: string | null;
      operator_name: string | null;
      oil: number;
      gas: number;
    }>(
      `select oil_gas_code, district_no, lease_no, lease_name, operator_name,
              oil, gas
         from rrc.lease_top_recent
        order by oil desc, gas desc
        limit $1`,
      [n]
    );
    if (top.length) {
      return top.map((r) => ({
        key: `${r.oil_gas_code}/${r.district_no}/${r.lease_no}`,
        label: r.lease_name ?? r.lease_no,
        sub: [r.operator_name,
              `District ${districtLabel(r.district_no) ?? r.district_no}`]
          .filter(Boolean)
          .join(" · "),
        oil: r.oil,
        gas: r.gas,
      }));
    }
  }

  // Fallback: group the 78.6M-row table FIRST (cycle-bounded, so Timescale
  // prunes to the recent chunks), then join names onto the surviving rows.
  const rows = await rrcQuery<{
    oil_gas_code: string;
    district_no: string;
    lease_no: string;
    lease_name: string | null;
    operator_name: string | null;
    oil: number;
    gas: number;
  }>(
    `with agg as (
       select oil_gas_code, district_no, lease_no,
              max(operator_no) as operator_no,
              coalesce(sum(oil_prod_vol),0)::bigint as oil,
              coalesce(sum(gas_prod_vol),0)::bigint as gas
         from rrc.lease_production
        where cycle > ${since(months)}
        group by 1,2,3 order by oil desc nulls last limit $1
     )
     select a.oil_gas_code, a.district_no, a.lease_no, a.oil, a.gas,
            l.lease_name, o.operator_name
       from agg a
       left join rrc.lease l
              on l.oil_gas_code = a.oil_gas_code
             and l.district_no  = a.district_no
             and l.lease_no     = a.lease_no
       left join rrc.operators o on o.operator_number = a.operator_no
      order by a.oil desc, a.gas desc`,
    [n]
  );
  return rows.map((r) => ({
    key: `${r.oil_gas_code}/${r.district_no}/${r.lease_no}`,
    label: r.lease_name ?? r.lease_no,
    sub: [r.operator_name, `District ${districtLabel(r.district_no) ?? r.district_no}`]
      .filter(Boolean)
      .join(" · "),
    oil: r.oil,
    gas: r.gas,
  }));
}

// ------------------------------------------------------------------ permits

export type { CompletionCasing, CompletionFormation, CompletionReport, PermitRow };

/** How many of an operator's permits the dossier carries. See OperatorDossier. */
export const OPERATOR_PERMIT_CAP = 500;

/**
 * How many wellbores a dossier ships.
 *
 * The cap exists for the statement timeout, not for the payload: uncapped, the
 * largest operators could not be opened at all. `wells.total` is unaffected and
 * `wellRowsTruncated` says when the list is a page rather than the fleet.
 */
export const OPERATOR_WELL_CAP = 2000;

export interface PermitFilter {
  operatorNo?: string;
  /** County name or code. */
  county?: string;
  /** District as the user says it ("8A", "09") — translated to PDQ here. */
  district?: string;
  leaseName?: string;
  /** Inclusive issue-date bounds, YYYY-MM-DD. */
  since?: string;
  until?: string;
  limit?: number;
}

export async function listPermits(f: PermitFilter): Promise<PermitRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };

  if (f.operatorNo) add("p.operator_number = $?", f.operatorNo.trim());
  if (f.county) {
    const c = resolveCounty(f.county);
    if (!c) return [];
    add("p.county_code = $?", c.county_no);
  }
  if (f.district) {
    // The user says "8A"; the table stores "11". Accept either — a raw PDQ code
    // passes through toPdqDistrict unchanged only if it is also a real label,
    // so try the translation and fall back to the literal.
    const pdq = toPdqDistrict(f.district.trim()) ?? f.district.trim();
    add("p.district = $?", pdq);
  }
  if (f.leaseName) add("p.lease_name ilike $?", `%${f.leaseName.trim()}%`);
  if (f.since) add("p.issued_date >= $?::date", f.since);
  if (f.until) add("p.issued_date <= $?::date", f.until);

  params.push(Math.min(500, Math.max(1, Math.floor(f.limit ?? 50))));
  const rows = await rrcQuery<{
    permit_number: string | null;
    permit_seq: string | null;
    lease_name: string | null;
    well_number: string | null;
    county_code: string | null;
    district: string | null;
    total_depth: number | null;
    operator_number: string | null;
    operator_name: string | null;
    filed_date: string | null;
    issued_date: string | null;
    expires_date: string | null;
  }>(
    `select p.permit_number, p.permit_seq, p.lease_name, p.well_number,
            p.county_code, p.district, p.total_depth, p.operator_number,
            o.operator_name,
            to_char(p.filed_date,   'YYYY-MM-DD') as filed_date,
            to_char(p.issued_date,  'YYYY-MM-DD') as issued_date,
            to_char(p.expires_date, 'YYYY-MM-DD') as expires_date
       from rrc.permit p
       left join rrc.operators o on o.operator_number = p.operator_number
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by p.issued_date desc nulls last
      limit $${params.length}`,
    params
  );

  return rows.map((r) => ({
    permit_number: r.permit_number,
    permit_seq: r.permit_seq,
    lease_name: r.lease_name,
    well_number: r.well_number,
    county_no: r.county_code,
    county_name: r.county_code
      ? COUNTY_NAMES[Number(r.county_code)] ?? null
      : null,
    district_no: r.district,
    district_name: districtLabel(r.district),
    total_depth: r.total_depth,
    operator_number: r.operator_number,
    operator_name: r.operator_name,
    filed_date: r.filed_date,
    issued_date: r.issued_date,
    expires_date: r.expires_date,
  }));
}

// ------------------------------------------------------------------ pipelines

export interface PipelineSegment {
  objectid: number;
  p5_num: string | null;
  operator_name: string | null;
  system_name: string | null;
  commodity: string | null;
  commodity_desc: string | null;
  diameter: number | null;
  status: string | null;
  interstate: string | null;
  t4permit: string | null;
  length_mi: number | null;
  geojson: string;
}

/**
 * Pipeline segments inside a viewport, biggest bore first.
 *
 * MINIMUM DIAMETER, not just a bbox. There are 470,554 segments statewide and
 * the useful ones at a given zoom are the big ones: a trunk line is worth
 * drawing from across the state, a two-inch gathering stub is noise until you
 * are on top of it. The caller raises the floor as it zooms out, which is what
 * keeps a wide viewport from returning a hairball.
 *
 * Ordered by diameter DESCENDING so that when the limit does bite, what
 * survives is the trunk network rather than an arbitrary slice of stubs.
 */
export async function getPipelines(
  west: number,
  south: number,
  east: number,
  north: number,
  minDiameter = 0,
  limit = 4000
): Promise<PipelineSegment[]> {
  return rrcQuery<PipelineSegment>(
    `select objectid, p5_num, operator_name, system_name, commodity,
            commodity_desc, diameter, status, interstate, t4permit,
            length_mi, geojson
       from rrc.pipeline
      where bbox && box(point($1, $2), point($3, $4))
        and coalesce(diameter, 0) >= $5
      order by diameter desc nulls last
      limit $6`,
    [west, south, east, north, minDiameter, limit]
  );
}

// ---------------------------------------------------------- pending permits

export interface PendingPermit {
  universal_doc_no: string;
  status_number: string | null;
  operator_number: string | null;
  operator_name: string | null;
  lease_name: string | null;
  well_number: string | null;
  county_name: string | null;
  district_name: string | null;
  total_depth: number | null;
  filing_purpose: string | null;
  current_state_code: string | null;
  submit_date: string | null;
  days_pending: number | null;
  horizontal: boolean;
  api_sequence_number: string | null;
  surface_lat: number | null;
  surface_lon: number | null;
  /** gis | decimal | dms | state_plane — how the pin was placed. */
  location_source: string | null;
  /** Approved permits only: the state's record shows the hole was completed. */
  drilled?: boolean;
}

/** RRC filing-purpose codes, per the pending-permit manual §5. */
export const FILING_PURPOSE: Record<string, string> = {
  "01": "New drill",
  "07": "Reenter",
  "09": "Field transfer",
  "14": "Recompletion",
  "15": "Reclass",
  "16": "Amended as-drilled BHL",
  "99": "Unknown",
};

/**
 * The live pending-permit queue, for the map.
 *
 * Served whole rather than by viewport: the queue is ~500 applications, which
 * is one small GeoJSON payload. A tile pipeline for it would be machinery
 * around nothing.
 *
 * Rows WITHOUT a position are still returned. 8 of 515 have no usable
 * coordinate in any of the four forms the feed reports one in, and dropping
 * them here would make the count under the map disagree with the pins on it
 * for no stated reason. The caller decides what to do with a null lat.
 */
export interface PermitBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Decided permits the map will draw before it reports a sample. */
export const PERMIT_MAP_CAP = 8000;

export async function getApprovedPermits(
  box?: PermitBox,
  limit = PERMIT_MAP_CAP,
  /** Issue-date range, inclusive `YYYY-MM-DD` (permits mode's Date filter). */
  dates: { since?: string; until?: string } = {}
): Promise<PendingPermit[]> {
  const n = Math.min(50000, Math.max(1, Math.floor(limit)));
  const rows = await rrcQuery<PendingPermit & { filing_purpose_code: string | null }>(
    `with app as (
       select distinct on (p.universal_doc_no)
              p.universal_doc_no, p.status_number, p.status_seq_no,
              p.operator_number, p.operator_name, p.district,
              p.default_lease_name as lease_name, p.default_well_number as well_number,
              p.total_depth, p.filing_purpose_code, p.current_state_code,
              p.submit_date, coalesce(p.default_horizantal,'N') as horizontal,
              w.county_code, w.api_sequence_number,
              w.surface_lat, w.surface_lon, w.location_source
         from rrc.pending_permit p
         left join rrc.pending_wellbore w using (universal_doc_no)
        order by p.universal_doc_no, p.snapshot desc
     )
     select a.universal_doc_no, a.status_number, a.operator_number, a.operator_name,
            a.lease_name, a.well_number, a.county_code, a.district,
            a.total_depth, a.filing_purpose_code, a.current_state_code,
            to_char(m.issued_date, 'YYYY-MM-DD') as submit_date,
            (current_date - m.issued_date)       as days_pending,
            (a.horizontal = 'Y')                 as horizontal,
            a.api_sequence_number, a.surface_lat, a.surface_lon, a.location_source,
            ${drilledSql("a.api_sequence_number")} as drilled
       from app a
       join rrc.permit m
         on m.permit_number = lpad(a.status_number, 7, '0')
        and m.permit_seq    = a.status_seq_no
      where a.surface_lat is not null
        ${box ? "and a.surface_lat between $2 and $3 and a.surface_lon between $4 and $5" : ""}
        ${dates.since ? `and m.issued_date >= $${box ? 6 : 2}::date` : ""}
        ${dates.until ? `and m.issued_date <= $${(box ? 6 : 2) + (dates.since ? 1 : 0)}::date` : ""}
      order by m.issued_date desc nulls last
      limit $1`,
    [
      n,
      ...(box ? [box.south, box.north, box.west, box.east] : []),
      ...(dates.since ? [dates.since] : []),
      ...(dates.until ? [dates.until] : []),
    ]
  );
  return rows.map(shapePermit);
}

/**
 * DRILLED, as far as the state's own record shows it — as a SQL predicate over
 * whichever expression holds the permit's API number.
 *
 * A completion date on the wellbore, or a filed W-2/G-1 packet. Either is the
 * operator telling the RRC the hole exists; a permit with neither is approved
 * and not yet acted on, and that is normal for two years, which is how long a
 * permit runs.
 *
 * Only answerable where the permit carries an API. 6,447 of the 10,741 approved
 * permits in the window do not, because the number is assigned DURING
 * processing and this feed snapshots each application when it is filed -- so a
 * blank here means "cannot tell", not "not drilled", and reads as undrilled.
 *
 * A function rather than a literal because two callers ask it of two different
 * columns — the map's permit mode here, and the operator dossier's permits in
 * `scout/queries.ts` — and a permit that is drilled on one map and not on the
 * other would be the bug.
 */
export function drilledSql(apiExpr: string): string {
  return `(exists (select 1 from rrc.wellbore wb
                    where wb.api_number = ${apiExpr}
                      and nullif(btrim(wb.completion_date), '') is not null)
           or exists (select 1 from rrc.completion c
                       where c.api_no = ${apiExpr}))`;
}

/**
 * APPROVED permits are mappable only because we watched them pend.
 *
 * rrc.permit carries no coordinates at all -- 951,628 rows, not one position --
 * so the only approved permits this can draw are the ones that passed through
 * the pending feed while we were holding it. That is 10,472 of the 10,741
 * approved inside the window, and exactly zero from before 2025-07-07.
 * `submit_date` here is the ISSUE date, and `days_pending` days since issue:
 * the same two fields the map reads for a pending row, meaning the analogous
 * thing for an approved one.
 *
 * VIEWPORT-SCOPED, and capped at PERMIT_MAP_CAP newest-first.
 *
 * The window this feed is held over went from 400 days to the full published
 * history, which takes the mappable set from ~11,100 to ~51,000 -- and the
 * whole-state payload with it, from about 1.5 MB to 7 MB. Clustering solves
 * how 51,000 points RENDER and does nothing about shipping them. So the map
 * asks for what it is looking at, and when the cap bites it keeps the NEWEST,
 * which is the half of the history anyone is asking about.
 */
function shapePermit(
  r: PendingPermit & { filing_purpose_code: string | null }
): PendingPermit {
  const rec = r as unknown as Record<string, unknown>;
  const county = rec.county_code as string | null;
  return {
    ...r,
    county_name: county ? COUNTY_NAMES[Number(county)] ?? null : null,
    // NOT districtLabel(). That translates a PDQ internal code into a real RRC
    // label, and the pending W-1 feed already carries the real label: it holds
    // '7B', '7C' and '8A', which PDQ has no way to express. Translating anyway
    // read '08' as PDQ and displayed it as '7B', '09' as '7C' and '10' as '08'
    // -- 37,732 of 67,872 permits labelled with a district they are not in,
    // District 08 and the whole Permian among them. See rrc-districts.ts: the
    // two codings collide on exactly these values, which is why the wrong one
    // looks plausible instead of looking broken.
    district_name: (rec.district as string | null) ?? null,
    filing_purpose:
      FILING_PURPOSE[r.filing_purpose_code ?? ""] ?? r.filing_purpose_code,
  };
}

/** One permit for a deep link: the map's permit properties plus where it is. */
export interface PermitLookup {
  /** The same keys `/api/scout/rrc/pending` puts on a feature, so the panel
   *  renders a linked permit exactly as it renders a clicked one. */
  properties: Record<string, unknown>;
  lat: number | null;
  lon: number | null;
  /** RRC county code, for landing a permit that has no position. */
  countyCode: number | null;
}

function lookupOf(
  r: PendingPermit & { filing_purpose_code: string | null },
  kind: "pending" | "approved" | "drilled"
): PermitLookup {
  const p = shapePermit(r);
  const county = (r as unknown as { county_code: string | null }).county_code;
  return {
    properties: {
      doc: p.universal_doc_no,
      op: p.operator_name,
      opNo: p.operator_number,
      lease: p.lease_name,
      well: p.well_number,
      county: p.county_name,
      district: p.district_name,
      depth: p.total_depth,
      purpose: p.filing_purpose,
      state: p.current_state_code,
      submitted: p.submit_date,
      days: p.days_pending,
      horiz: p.horizontal ? 1 : 0,
      src: p.location_source,
      api: p.api_sequence_number,
      kind,
    },
    lat: p.surface_lat,
    lon: p.surface_lon,
    countyCode: county ? Number(county) : null,
  };
}

/**
 * One application by its `universal_doc_no`, pending or decided.
 *
 * Shaped the way the map's two collections shape it: still pending reads from
 * submission, decided reads from issue (the same swap `getApprovedPermits`
 * makes), so a permit opened from an email says what the clicked dot says.
 */
export async function getPermitByDoc(doc: string): Promise<PermitLookup | null> {
  const row = await rrcQueryOne<
    PendingPermit & { filing_purpose_code: string | null; issued: string | null }
  >(
    `with app as (
       select p.universal_doc_no, p.status_number, p.status_seq_no,
              p.operator_number, p.operator_name, p.district,
              p.default_lease_name as lease_name, p.default_well_number as well_number,
              p.total_depth, p.filing_purpose_code, p.current_state_code,
              p.submit_date, coalesce(p.default_horizantal,'N') as horizontal,
              w.county_code, w.api_sequence_number,
              w.surface_lat, w.surface_lon, w.location_source
         from rrc.pending_permit p
         left join rrc.pending_wellbore w using (universal_doc_no)
        where p.universal_doc_no = $1
        order by p.snapshot desc
        limit 1
     )
     select a.universal_doc_no, a.status_number, a.operator_number, a.operator_name,
            a.lease_name, a.well_number, a.county_code, a.district,
            a.total_depth, a.filing_purpose_code, a.current_state_code,
            to_char(coalesce(m.issued_date, a.submit_date), 'YYYY-MM-DD') as submit_date,
            (current_date - coalesce(m.issued_date, a.submit_date::date)) as days_pending,
            (a.horizontal = 'Y') as horizontal,
            a.api_sequence_number, a.surface_lat, a.surface_lon, a.location_source,
            to_char(m.issued_date, 'YYYY-MM-DD') as issued,
            (m.issued_date is not null and ${drilledSql("a.api_sequence_number")}) as drilled
       from app a
       left join rrc.permit m
         on m.permit_number = lpad(a.status_number, 7, '0')
        and m.permit_seq    = a.status_seq_no`,
    [doc]
  );
  if (!row) return null;
  return lookupOf(row, !row.issued ? "pending" : row.drilled ? "drilled" : "approved");
}

/**
 * An approved permit by number, for one we never saw pend.
 *
 * Prefers the application behind it when there is one (it carries the
 * position). Otherwise the permit row alone: no position, so the caller lands
 * on its county. The original sequence is the highest (amendments count down
 * from 99), and that is the one that was issued as new.
 */
export async function getPermitByNumber(permitNo: string): Promise<PermitLookup | null> {
  const app = await rrcQueryOne<{ universal_doc_no: string }>(
    `select p.universal_doc_no
       from rrc.permit m
       join rrc.pending_permit p
         on p.status_number = right(m.permit_number, 6)
        and lpad(p.status_number, 7, '0') = m.permit_number
        and p.status_seq_no = m.permit_seq
      where m.permit_number = $1
      order by m.permit_seq desc, p.snapshot desc
      limit 1`,
    [permitNo]
  );
  if (app) return getPermitByDoc(app.universal_doc_no);

  const row = await rrcQueryOne<
    PendingPermit & { filing_purpose_code: string | null }
  >(
    `select null::text as universal_doc_no, m.permit_number as status_number,
            m.operator_number, o.operator_name,
            m.lease_name, m.well_number, m.county_code, m.district,
            m.total_depth, null::text as filing_purpose_code, null::text as current_state_code,
            to_char(m.issued_date, 'YYYY-MM-DD') as submit_date,
            (current_date - m.issued_date) as days_pending,
            false as horizontal, null::text as api_sequence_number,
            null::float8 as surface_lat, null::float8 as surface_lon,
            null::text as location_source
       from rrc.permit m
       left join rrc.operators o on o.operator_number = m.operator_number
      where m.permit_number = $1
      order by m.permit_seq desc
      limit 1`,
    [permitNo]
  );
  return row ? lookupOf(row, "approved") : null;
}

/**
 * The extent of a set of counties, from where their wells are.
 *
 * Recon has no county outlines, and a deep link to an area (or to a permit
 * with no position) has to land somewhere. The wells ARE the area: the 1st to
 * 99th percentile of their surface locations frames the county without one
 * mis-plotted well dragging the view across the state. Keyed by the API range
 * (`countyApiRange`), which `well_location_api` indexes.
 */
export async function getCountyBounds(
  codes: number[]
): Promise<{ west: number; south: number; east: number; north: number } | null> {
  const ranges = codes.slice(0, 40).map(countyApiRange);
  if (!ranges.length) return null;
  const clauses = ranges
    .map((_, i) => `(l.api_number between $${i * 2 + 1} and $${i * 2 + 2})`)
    .join(" or ");
  const row = await rrcQueryOne<{
    west: number | null;
    south: number | null;
    east: number | null;
    north: number | null;
  }>(
    `select percentile_cont(0.01) within group (order by l.lon) as west,
            percentile_cont(0.01) within group (order by l.lat) as south,
            percentile_cont(0.99) within group (order by l.lon) as east,
            percentile_cont(0.99) within group (order by l.lat) as north
       from rrc.well_location l
      where (${clauses})
        and l.lat is not null and l.lon is not null`,
    ranges.flat()
  );
  if (!row || row.west == null || row.south == null || row.east == null || row.north == null) {
    return null;
  }
  return { west: row.west, south: row.south, east: row.east, north: row.north };
}

/**
 * The pending queue, cached for an hour.
 *
 * It is the same ~515 statewide rows behind a NIGHTLY sync, and the map asks
 * for it again on every pan: the mode's route re-reads it beside the decided
 * set, which genuinely is viewport-scoped. Measured at 0.95-1.4 s a pan, for a
 * payload that cannot have changed. Keyed by limit so a caller asking for a
 * different slice is not served someone else's.
 *
 * Same shape and the same reasoning as `getCycleEdge`'s cache above; an hour is
 * well inside the sync's daily cadence.
 */
const pendingQueueCache = new Map<number, { at: number; rows: PendingPermit[] }>();
const PENDING_QUEUE_TTL_MS = 3_600_000;

export async function getPendingQueue(limit = 2000): Promise<PendingPermit[]> {
  const bounded = Math.min(5000, Math.max(1, Math.floor(limit)));
  const cached = pendingQueueCache.get(bounded);
  if (cached && Date.now() - cached.at < PENDING_QUEUE_TTL_MS) return cached.rows;

  const rows = await rrcQuery<PendingPermit & { filing_purpose_code: string | null }>(
    `select universal_doc_no, status_number, operator_number, operator_name,
            lease_name, well_number, county_code, district,
            total_depth, filing_purpose_code, current_state_code,
            to_char(submit_date, 'YYYY-MM-DD') as submit_date,
            days_pending,
            (horizontal = 'Y') as horizontal,
            api_sequence_number, surface_lat, surface_lon, location_source
       from rrc.pending_queue
      order by days_pending
      limit $1`,
    [bounded]
  );
  const shaped = rows.map(shapePermit);
  pendingQueueCache.set(bounded, { at: Date.now(), rows: shaped });
  return shaped;
}

// -------------------------------------------------------------- completions

/**
 * Every completion report filed against one wellbore, newest first.
 *
 * `completion.api_no` is the 8-digit county+unique API, the same key
 * `wellbore.api_number` uses — no state prefix on either side.
 */
export async function getCompletionReports(
  api: string,
  limit = 5
): Promise<CompletionReport[]> {
  const packets = await rrcQuery<Record<string, string | null>>(
    `select c.tracking_no, c.api_no, c.operator_no, o.operator_name,
            c.lease_name, c.well_no, c.field_no, c.field_name, c.county,
            c.district, c.well_type, c.completion_type, c.purpose_of_filing,
            c.cmpl_or_recmpl_date, c.spud_dt, c.approved_dt,
            c.wellbore_profile, c.total_acres, c.no_of_producing_wells,
            c.survey, c.survey_block, c.survey_section, c.survey_abstract,
            c.latitude, c.longitude
       from rrc.completion c
       left join rrc.operators o on o.operator_number = c.operator_no
      where c.api_no = $1
      order by c.approved_dt desc nulls last
      limit $2`,
    [api.trim(), Math.min(20, Math.max(1, Math.floor(limit)))]
  );
  if (packets.length === 0) return [];

  const ids = packets.map((p) => p.tracking_no).filter(Boolean) as string[];
  const [formations, casing, other] = await Promise.all([
    rrcQuery<CompletionFormation & { tracking_no: string }>(
      `select tracking_no, formation, depth, depth_tmd,
              user_encountered as encountered, user_isolated as isolated,
              user_remark as remark
         from rrc.completion_formation
        where tracking_no = any($1)
        order by tracking_no, nullif(regexp_replace(depth, '[^0-9]', '', 'g'), '')::bigint nulls last`,
      [ids]
    ),
    rrcQuery<CompletionCasing & { tracking_no: string }>(
      `select tracking_no, casing_size, weight_lb_per_foot, depth_set, hole_size,
              cement_type, sacks_of_cement, top_of_cement, row_type
         from rrc.completion_casing
        where tracking_no = any($1)
        order by tracking_no, row_no`,
      [ids]
    ),
    rrcQuery<{ tracking_no: string; tag: string; rows: number }>(
      `select tracking_no, tag, count(*)::int as rows
         from rrc.completion_other
        where tracking_no = any($1)
        group by 1,2 order by 1,2`,
      [ids]
    ),
  ]);

  const by = <T extends { tracking_no: string }>(rows: T[], id: string) =>
    rows.filter((r) => r.tracking_no === id);

  return packets.map((p) => {
    const id = p.tracking_no ?? "";
    return {
      tracking_no: p.tracking_no,
      api_no: p.api_no,
      operator_no: p.operator_no,
      operator_name: p.operator_name,
      lease_name: p.lease_name,
      well_no: p.well_no,
      field_no: p.field_no,
      field_name: p.field_name,
      county_no: p.county,
      county_name: p.county ? COUNTY_NAMES[Number(p.county)] ?? null : null,
      district: p.district,
      well_type: p.well_type,
      completion_type: p.completion_type,
      purpose_of_filing: p.purpose_of_filing,
      completion_date: p.cmpl_or_recmpl_date,
      spud_date: p.spud_dt,
      approved_date: p.approved_dt,
      wellbore_profile: p.wellbore_profile,
      total_acres: p.total_acres,
      producing_wells: p.no_of_producing_wells,
      survey: p.survey,
      survey_block: p.survey_block,
      survey_section: p.survey_section,
      survey_abstract: p.survey_abstract,
      latitude: p.latitude,
      longitude: p.longitude,
      formations: by(formations, id).map(({ ...f }) => ({
        formation: f.formation,
        depth: f.depth,
        depth_tmd: f.depth_tmd,
        encountered: f.encountered,
        isolated: f.isolated,
        remark: f.remark,
      })),
      casing: by(casing, id).map((c) => ({
        casing_size: c.casing_size,
        weight_lb_per_foot: c.weight_lb_per_foot,
        depth_set: c.depth_set,
        hole_size: c.hole_size,
        cement_type: c.cement_type,
        sacks_of_cement: c.sacks_of_cement,
        top_of_cement: c.top_of_cement,
        row_type: c.row_type,
      })),
      otherSections: by(other, id).map((o) => ({ tag: o.tag, rows: o.rows })),
    };
  });
}

// -------------------------------------------------------- wells by location

export interface NearbyWell {
  api_number: string;
  lease_name: string | null;
  well_no: string | null;
  operator_number: string | null;
  operator_name: string | null;
  well_type_name: string | null;
  county_name: string | null;
  field_name: string | null;
  /** Real RRC district label — this comes from EWA. */
  district: string | null;
  lat: number | null;
  lon: number | null;
  /** Great-circle miles from the search point; null for non-radius searches. */
  distance_mi: number | null;
}

export interface WellFinder {
  lat?: number;
  lon?: number;
  radiusMi?: number;
  /** County name or code. */
  county?: string;
  operatorNo?: string;
  /** Substring of RRC's well_type_name, e.g. "PRODUCING", "INJECTION". */
  wellType?: string;
  limit?: number;
}

/**
 * Find wells by position, county, or operator.
 *
 * Do NOT reach for `rrc.wells_mapped` here: the view runs a DISTINCT ON over
 * the full 1.37M-row join before any filter applies, which measured 8.4 s
 * against a 5 s budget. Filtering `well_location` first — it carries the
 * (lat, lon) index — and joining `wellbore` after brings the same answer back
 * in ~55 ms.
 */
export async function findWells(f: WellFinder): Promise<NearbyWell[]> {
  const limit = Math.min(500, Math.max(1, Math.floor(f.limit ?? 50)));
  const hasPoint =
    typeof f.lat === "number" &&
    typeof f.lon === "number" &&
    Number.isFinite(f.lat) &&
    Number.isFinite(f.lon);

  const where: string[] = ["w.on_schedule = 'Y'"];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };

  if (f.county) {
    const c = resolveCounty(f.county);
    if (!c) return [];
    add("w.county_code = $?", c.county_no);
  }
  if (f.operatorNo) add("w.operator_number = $?", f.operatorNo.trim());
  if (f.wellType) add("w.well_type_name ilike $?", `%${f.wellType.trim()}%`);

  let distanceSelect = "null::float8 as distance_mi";
  let order = "w.api_number";

  if (hasPoint) {
    const radius = Math.min(100, Math.max(0.1, f.radiusMi ?? 5));
    // Bounding box first so the (lat, lon) index does the work; the exact
    // great-circle distance then trims the box's corners. One degree of
    // latitude is 69.0 miles; longitude shrinks by cos(latitude).
    const dLat = radius / 69.0;
    const dLon = radius / (69.0 * Math.max(0.05, Math.cos((f.lat! * Math.PI) / 180)));
    params.push(f.lat, f.lon, f.lat! - dLat, f.lat! + dLat, f.lon! - dLon, f.lon! + dLon, radius);
    const [pLat, pLon, minLat, maxLat, minLon, maxLon, pRad] = [
      params.length - 6,
      params.length - 5,
      params.length - 4,
      params.length - 3,
      params.length - 2,
      params.length - 1,
      params.length,
    ];
    where.push(`l.lat between $${minLat} and $${maxLat}`);
    where.push(`l.lon between $${minLon} and $${maxLon}`);
    const dist = `(3958.7613 * acos(least(1, greatest(-1,
        sin(radians($${pLat})) * sin(radians(l.lat)) +
        cos(radians($${pLat})) * cos(radians(l.lat)) * cos(radians(l.lon) - radians($${pLon}))))))`;
    where.push(`${dist} <= $${pRad}`);
    distanceSelect = `round(${dist}::numeric, 2)::float8 as distance_mi`;
    order = "distance_mi";
  } else if (!f.county && !f.operatorNo) {
    // Refuse an unfiltered scan rather than let it time out.
    return [];
  }

  params.push(limit);
  return rrcQuery<NearbyWell>(
    `select w.api_number, w.lease_name, w.well_no, w.operator_number,
            w.operator_name, w.well_type_name, w.county_name, w.field_name,
            w.district, l.lat, l.lon, ${distanceSelect}
       from rrc.well_location l
       join rrc.wellbore w on w.api_number = l.api_number
      where ${where.join(" and ")}
      order by ${order}
      limit $${params.length}`,
    params
  );
}

// ------------------------------------------------------------------ surveys

export interface SurveyRow {
  abstract_number: string | null;
  abstract_label: string | null;
  survey_name: string | null;
  block_number: string | null;
  survey_number: string | null;
}

/**
 * Abstract / survey / block lookup.
 *
 * The mirror's `survey` table carries NO county column, so an abstract number
 * is not unique statewide — two counties can both have an A-64. Callers must
 * treat a match as a candidate, not an identification.
 */
export async function findSurveys(f: {
  abstract?: string;
  name?: string;
  block?: string;
  limit?: number;
}): Promise<SurveyRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };
  if (f.abstract) {
    // Users write "A-64", the table stores both "00164" (padded) and the
    // "A-64" label. Match either spelling from either input.
    const a = f.abstract.trim().replace(/^A-?/i, "");
    params.push(a.padStart(5, "0"), `A-${a}`);
    where.push(
      `(abstract_number = $${params.length - 1} or abstract_label = $${params.length})`
    );
  }
  if (f.name) add("survey_name ilike $?", `%${f.name.trim()}%`);
  if (f.block) add("block_number ilike $?", `%${f.block.trim()}%`);
  if (where.length === 0) return [];

  params.push(Math.min(200, Math.max(1, Math.floor(f.limit ?? 25))));
  return rrcQuery<SurveyRow>(
    `select abstract_number, abstract_label, survey_name, block_number, survey_number
       from rrc.survey
      where ${where.join(" and ")}
      order by survey_name, block_number
      limit $${params.length}`,
    params
  );
}

// ---------------------------------------------------------- survey polygons
//
// The survey/abstract tracts behind Scout's property lines. Loaded by
// `rrc-data`'s `gis_polygons.py` from RRC public viewer layer 24 — the shapes
// the original GIS pull skipped by fetching with `returnGeometry=false`.
//
// NO POSTGIS ON THIS SERVER, so the geometry is GeoJSON text with the bounding
// box beside it in core's `box` type, GiST-indexed. That makes the only query
// the map needs — "what tracts overlap this viewport" — an index scan: measured
// 23 ms for a 0.1-degree window near Midland.

export interface SurveyPolygon {
  objectid: number;
  abstract_number: string | null;
  abstract_label: string | null;
  survey_name: string | null;
  block_number: string | null;
  acres: number | null;
  /** GeoJSON Polygon | MultiPolygon, as stored. */
  geojson: string;
}

/**
 * Survey tracts overlapping a viewport.
 *
 * `&&` is bounding-box overlap, not containment: a tract larger than the screen
 * still has to be drawn, and one clipped by the edge is still on screen. The
 * caller decides the zoom at which asking is sensible — statewide this table is
 * 311,158 rows, and no viewport-sized answer should approach that.
 */
export async function getSurveyPolygons(
  west: number,
  south: number,
  east: number,
  north: number,
  limit = 6000
): Promise<SurveyPolygon[]> {
  return rrcQuery<SurveyPolygon>(
    `select objectid, abstract_number, abstract_label, survey_name,
            block_number, acres, geojson
       from rrc.survey_polygon
      where bbox && box(point($1, $2), point($3, $4))
      order by acres desc nulls last
      limit $5`,
    [west, south, east, north, limit]
  );
}

// ------------------------------------------------------------------- people
//
// Scout's Person search: the third way into the map, next to operator and
// county. People do not hold wellbores — operating companies do — so a person
// resolves to every P-5 they are listed on, and the map draws those operators.
//
// OPERATOR NUMBERS ARE EMITTED AS INTEGERS HERE, and nowhere else in this file.
// `rrc.operator_officers.operator_number` is `character(6)`, zero-padded
// ("000016"), while the /scout map keys operators as ints (`operators.json`,
// `well_operator`). Verified against both stores: Tiger "000016" and Archon 16
// are the same operator ("A & E MINERALS, LLC"), and every officer row's number
// is numeric, so the cast is total. The RRC dossier ROUTES still take the padded
// text key — do not swap one for the other.

/** How many name matches get their wells counted before the top `limit` is cut. */
const PEOPLE_CANDIDATES = 40;

/**
 * People whose name matches `q`, biggest fleet first.
 *
 * Two-stage on purpose. Ranking by wells is what makes the list useful — typing
 * "smith" should surface the Smith behind 4,977 wells, not the one on the most
 * shell companies — but counting wells for every match of a common name is not
 * affordable. So the trigram index picks the `PEOPLE_CANDIDATES` widest-spread
 * matches, only those get their wells counted, and the final cut is by wells.
 * Measured 180-670 ms end to end, the worst case being a two-letter term that
 * matches a corporate filing agent on 1,494 operators.
 *
 * Wells are counted over DISTINCT `api_number`, the rule this whole mirror runs
 * on (see the `rrc-types.ts` header): `wellbore` holds one row per well x lease
 * x field, so a plain `count(*)` reads 5,458 wells for the 5,227 a real person
 * actually has. The pairs CTE is deduped for the same reason one layer up — a
 * person holding two titles at one operator must not count it twice.
 */
export async function searchPeople(q: string, limit = 10): Promise<PersonMatch[]> {
  const term = q.trim();
  if (term.length < 2) return [];

  return rrcQuery<PersonMatch>(
    `with matched as (
       select officer_name,
              count(distinct operator_number)::int as operator_count,
              min(nullif(btrim(city), ''))  as city,
              min(nullif(btrim(state), '')) as state
         from rrc.operator_officers
        where officer_name ilike $1
          and operator_number is not null
          and nullif(btrim(officer_name), '') is not null
        group by officer_name
        order by operator_count desc, officer_name
        limit ${PEOPLE_CANDIDATES}
     ),
     pairs as (
       select distinct m.officer_name, oo.operator_number
         from matched m
         join rrc.operator_officers oo on oo.officer_name = m.officer_name
        where oo.operator_number is not null
     ),
     wells as (
       select p.officer_name, count(distinct wb.api_number)::int as total_wells
         from pairs p
         join rrc.wellbore wb on wb.operator_number = p.operator_number
        where wb.on_schedule = 'Y'
        group by p.officer_name
     )
     select m.officer_name, m.operator_count, m.city, m.state,
            coalesce(w.total_wells, 0)::int as total_wells
       from matched m
       left join wells w on w.officer_name = m.officer_name
      order by total_wells desc, m.operator_count desc, m.officer_name
      limit $2`,
    [`%${term}%`, limit]
  );
}

/**
 * Every operator one person is listed on — both the map filter and the panel.
 *
 * One read serves both: the panel renders the names and P-5 statuses, and the
 * map takes `operator_number` off the same rows, so what the panel lists and
 * what the map draws cannot disagree.
 */
export async function getPerson(name: string): Promise<PersonDossier> {
  const affiliations = await rrcQuery<PersonAffiliation>(
    `select btrim(oo.operator_number)::int as operator_number,
            o.operator_name, o.p5_status,
            string_agg(distinct nullif(btrim(oo.officer_title), ''), ' / ')
              as officer_title,
            min(nullif(btrim(oo.city), ''))  as officer_city,
            min(nullif(btrim(oo.state), '')) as officer_state
       from rrc.operator_officers oo
       left join rrc.operators o on o.operator_number = oo.operator_number
      where oo.officer_name = $1
        and oo.operator_number is not null
      group by oo.operator_number, o.operator_name, o.p5_status
      order by o.operator_name nulls last
      limit 500`,
    [name]
  );
  return { name, affiliations };
}

// --------------------------------------------------------- operator network

export interface OperatorNetwork {
  operator_number: string;
  operator_name: string | null;
  p5_status: string | null;
  officers: { officer_name: string | null; officer_title: string | null }[];
  /** Other P-5 operators sharing at least one named officer with this one. */
  related: {
    officer_name: string;
    operator_number: string;
    operator_name: string | null;
    p5_status: string | null;
  }[];
}

export async function getOperatorNetwork(
  operatorNo: string
): Promise<OperatorNetwork | null> {
  const head = await rrcQueryOne<{
    operator_number: string;
    operator_name: string | null;
    p5_status: string | null;
  }>(
    `select operator_number, operator_name, p5_status
       from rrc.operators where operator_number = $1`,
    [operatorNo]
  );
  if (!head) return null;

  const [officers, related] = await Promise.all([
    rrcQuery<{ officer_name: string | null; officer_title: string | null }>(
      `select officer_name, officer_title from rrc.operator_officers
        where operator_number = $1 order by officer_title, officer_name`,
      [operatorNo]
    ),
    rrcQuery<{
      officer_name: string;
      operator_number: string;
      operator_name: string | null;
      p5_status: string | null;
    }>(
      `select distinct mine.officer_name, theirs.operator_number,
              o.operator_name, o.p5_status
         from rrc.operator_officers mine
         join rrc.operator_officers theirs
           on theirs.officer_name = mine.officer_name
          and theirs.operator_number <> mine.operator_number
         left join rrc.operators o on o.operator_number = theirs.operator_number
        where mine.operator_number = $1
          and nullif(trim(mine.officer_name), '') is not null
        order by mine.officer_name, theirs.operator_number
        limit 200`,
      [operatorNo]
    ),
  ]);

  return { ...head, officers, related };
}

// ------------------------------------------------------------------- trend

export interface TrendSeries {
  key: string;
  label: string;
  points: SeriesPoint[];
}

/**
 * Statewide or per-district production over time.
 *
 * A leaner path than `getMarketData()`, which also builds a ~250-series county
 * set and three leaderboards for the market SCREEN. A chat answer needs one
 * series, so this asks for one.
 *
 * `years` rolls monthly cycles up in JS rather than in SQL: 34 years of Texas
 * is 404 rows either way, and doing it here keeps the reported-edge rule in one
 * place.
 */
export async function getProductionTrend(
  scope: "statewide" | "districts",
  months = 60,
  granularity: "monthly" | "yearly" = "monthly"
): Promise<TrendSeries[]> {
  const { reported } = await getCycleEdge();

  const rows =
    scope === "statewide"
      ? (
          await rrcQuery<Omit<SeriesPoint, "reported">>(
            `select to_char(month,'YYYY-MM') as cycle,
                    coalesce(sum(oil),0)::bigint  as oil,
                    coalesce(sum(gas),0)::bigint  as gas,
                    coalesce(sum(cond),0)::bigint as cond,
                    coalesce(sum(csgd),0)::bigint as csgd
               from rrc.statewide_production_monthly
              where month > ${since(months)}
              group by 1 order by 1`
          )
        ).map((r) => ({ ...r, key: "TX", label: "Texas" }))
      : await rrcQuery<Omit<SeriesPoint, "reported"> & { key: string; label: string }>(
          `select district_no as key,
                  coalesce(max(district_name), district_no) as label,
                  ${YM} as cycle,
                  coalesce(sum(dist_oil_prod_vol),0)::bigint  as oil,
                  coalesce(sum(dist_gas_prod_vol),0)::bigint  as gas,
                  coalesce(sum(dist_cond_prod_vol),0)::bigint as cond,
                  coalesce(sum(dist_csgd_prod_vol),0)::bigint as csgd
             from rrc.district_cycle
            where cycle_year_month > ${sinceYm(months)}
            group by district_no, cycle_year_month
            order by district_no, cycle_year_month`
        );

  const series = new Map<string, TrendSeries>();
  for (const r of rows) {
    const bucket = granularity === "yearly" ? r.cycle.slice(0, 4) : r.cycle;
    let s = series.get(r.key);
    if (!s) {
      s = { key: r.key, label: r.label, points: [] };
      series.set(r.key, s);
    }
    const last = s.points[s.points.length - 1];
    if (last && last.cycle === bucket) {
      last.oil += r.oil;
      last.gas += r.gas;
      last.cond += r.cond;
      last.csgd += r.csgd;
      // A year is only fully reported when its LAST cycle is.
      last.reported = r.cycle <= reported;
    } else {
      s.points.push({ ...r, cycle: bucket, reported: r.cycle <= reported });
    }
  }
  return [...series.values()];
}

// -------------------------------------------------- lease, annual roll-up

export interface LeaseYear {
  year: string;
  oil: number;
  gas: number;
  cond: number;
  csgd: number;
}

/**
 * A lease's whole history as years, from the `lease_production_yearly`
 * continuous aggregate. A 33-year monthly series is ~400 rows; nobody reads
 * that in a chat answer, and the shape survives the roll-up.
 */
export async function getLeaseYearly(
  oilGasCode: string,
  districtNo: string,
  leaseNo: string
): Promise<LeaseYear[]> {
  return rrcQuery<LeaseYear>(
    `select to_char(year, 'YYYY') as year,
            coalesce(oil,0)::bigint  as oil,
            coalesce(gas,0)::bigint  as gas,
            coalesce(cond,0)::bigint as cond,
            coalesce(csgd,0)::bigint as csgd
       from rrc.lease_production_yearly
      where oil_gas_code = $1 and district_no = $2 and lease_no = $3
      order by year`,
    [oilGasCode, districtNo, leaseNo]
  );
}

// -------------------------------------------------- injection / disposal

/*
 * UIC: where produced water is legally allowed to go, and where it went.
 *
 * `rrc.uic_permit` is the capacity, `rrc.uic_h10` the utilisation. Two rules
 * hold everywhere below and are not restated per query:
 *
 *   1. LIVE means class 2, activated, not cancelled, and no W-3 plugging
 *      report. `rrc.uic_live_permit` is that rule in the mirror, and it does
 *      NOT test approved_date — RRC populates that column on 896 of 126,709
 *      permits, so requiring it would discard thousands of wells that are
 *      filing H-10s today. The extra `inj_type in ('1','2')` filter below
 *      narrows further to DISPOSAL: type 3 is waterflood injection into a
 *      producing zone, which is not somewhere a third party's water can go.
 *   2. An unfiled month is an ABSENT row, not a zero. Any rate derived from
 *      H-10 divides by the days actually reported, never by twelve months.
 *   3. H-10 FILING RUNS ABOUT FOURTEEN MONTHS BEHIND, far further than the
 *      three-month production lag. Filings per month plateau near 42,000 and
 *      then fall away — 15,692 for 2026-01, 1,077 for 2026-06, 26 for 2026-07.
 *      Every window below ends at `getInjectionEdge()`, never at today, or a
 *      well that is disposing normally reads as one that stopped.
 */

let injectionEdgeCache:
  | { reported: string; loaded: string; at: number }
  | null = null;

/**
 * How far H-10 reporting is actually complete.
 *
 * "Complete" is 90% of the busiest month in the last three years, which puts
 * the edge at 2025-06 against a 2026-08 file. A simpler "latest non-empty
 * month" would return 2026-07 and quietly divide real volume by a month nobody
 * filed. Cached for an hour, like `getCycleEdge`.
 */
export async function getInjectionEdge(): Promise<{
  reported: string;
  loaded: string;
}> {
  if (injectionEdgeCache && Date.now() - injectionEdgeCache.at < 3_600_000) {
    return injectionEdgeCache;
  }
  // Reads rrc.uic_h10_monthly (622 rows), NOT rrc.uic_h10 (21,065,581).
  //
  // This used to group the raw table on every cold start: 1.16M rows across the
  // 36-month window, 2.16 s warm and past the pool's own 5 s statement_timeout
  // cold. So the first request after a cache eviction did not just run slowly,
  // it FAILED -- taking the well modal's injection tab, the operator dossier
  // and every disposal search with it. The loader carried a cache-warming step
  // to paper over it, which held only until something evicted those pages.
  // See rrc-data/sql/015_uic_h10_monthly.sql.
  const row = await rrcQueryOne<{ reported: string; loaded: string }>(
    `with m as (
       select cycle, filings as n
         from rrc.uic_h10_monthly
        where cycle > current_date - interval '36 months'
          and cycle <= current_date
     ), peak as (select max(n)::numeric as mx from m)
     select to_char(max(cycle) filter (where n >= mx * 0.9), 'YYYY-MM') as reported,
            to_char(max(cycle), 'YYYY-MM')                             as loaded
       from m, peak`
  );
  const edge = {
    reported: row?.reported ?? "",
    loaded: row?.loaded ?? "",
    at: Date.now(),
  };
  injectionEdgeCache = edge;
  return edge;
}

/** Permitted-fluid columns, ordered as UIC-INJ-FLUIDS stores them. */
const FLUID_COLS = FLUIDS.map((f) => f.key).join(", ");

/**
 * The live-permit test, spelled the same way everywhere.
 *
 * `p` is the alias the caller gave rrc.uic_permit. Not read from
 * rrc.uic_live_permit because these queries also filter on inj_type and join
 * differently; sharing the predicate keeps the two from drifting.
 */
const LIVE = (p = "p") =>
  `${p}.uic_class = '2' and ${p}.activated_flag = 'Y'
   and ${p}.cancel_date is null and ${p}.w3_date is null`;

/*
 * No de-duplication of H-10 months, deliberately.
 *
 * Amended filings looked like an obvious hazard — repeat a (uic_no, cycle) and
 * a plain sum double-counts — so this was written with a distinct-on that kept
 * the highest document id. Then it was checked: all 21,065,581 rows have a
 * distinct (uic_no, cycle). The machinery was removing nothing and costing a
 * sort, so it is gone. If a future vintage introduces duplicates, this comment
 * is where to start.
 */

/** Days in the month a "YYYY-MM" names. */
function daysInCycle(cycle: string): number {
  const [y, m] = cycle.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** "YYYY-MM" twelve months earlier, exclusive lower bound for a 12-month window. */
function monthsBefore(cycle: string, n: number): string {
  const [y, m] = cycle.split("-").map(Number);
  const t = (y * 12 + (m - 1)) - n;
  return `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/**
 * Average barrels per day over the twelve months ending at the reporting edge.
 *
 * Two divisors were possible and the choice matters: days in the WINDOW (365)
 * or days in the months this well actually filed. This uses the latter, so the
 * figure is "how hard it runs when it runs" — a well that filed three months
 * is not averaged as if it sat idle for nine. It reads high for an
 * intermittent well, which is the honest direction for a capacity question.
 */
function ratePerDay(
  monthly: InjectionMonth[],
  edge: string,
  months = 12
): number | null {
  const from = monthsBefore(edge, months - 1);
  const win = monthly.filter((m) => m.cycle >= from && m.cycle <= edge);
  if (win.length === 0) return null;
  const days = win.reduce((s, m) => s + daysInCycle(m.cycle), 0);
  if (days === 0) return null;
  return win.reduce((s, m) => s + m.bbl, 0) / days;
}

function toPermit(r: Record<string, unknown>): UicPermit {
  // The same rule as rrc.uic_live_permit, minus the class test the caller has
  // already applied by asking for this well's permits at all.
  const live =
    r.activated_flag === "Y" && r.cancel_date == null && r.w3_date == null;
  return {
    uic_no: String(r.uic_no ?? "").trim(),
    api_number: (r.api_number as string | null)?.trim() ?? null,
    operator_no: (r.operator_no as string | null)?.trim() ?? null,
    operator_name: (r.operator_name as string | null) ?? null,
    lease_name: (r.lease_name as string | null) ?? null,
    uic_class: (r.uic_class as string | null) ?? null,
    inj_type: (r.inj_type as string | null) ?? null,
    approved_date: (r.approved_date as string | null) ?? null,
    cancel_date: (r.cancel_date as string | null) ?? null,
    w3_date: (r.w3_date as string | null) ?? null,
    max_bbl_per_day: (r.max_bbl_per_day as number | null) ?? null,
    max_mcf_per_day: (r.max_mcf_per_day as number | null) ?? null,
    max_inj_pressure: (r.max_inj_pressure as number | null) ?? null,
    max_inj_pressure_note: (r.max_inj_pressure_note as string | null) ?? null,
    top_inj_zone: (r.top_inj_zone as number | null) ?? null,
    bot_inj_zone: (r.bot_inj_zone as number | null) ?? null,
    inj_mode: (r.inj_mode as string | null) ?? null,
    is_commercial: r.is_commercial === true,
    fluid_comment: (r.fluid_comment as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    fluids: fluidLabels(r),
    live,
  };
}

/**
 * The Injection tab for one wellbore.
 *
 * Volumes are summed across the well's permits: a hole permitted for two
 * intervals reports each separately and the tab shows the hole's total. Returns
 * null rather than an empty shape when the well has no UIC record at all, so
 * the modal can drop the tab instead of rendering an empty one.
 */
export async function getWellInjection(
  api: string
): Promise<WellInjection | null> {
  const permits = await rrcQuery<Record<string, unknown>>(
    `select p.uic_no, p.api_number, p.operator_no, o.operator_name,
            p.lease_name, p.uic_class, p.inj_type, p.activated_flag,
            to_char(p.approved_date, 'YYYY-MM-DD') as approved_date,
            to_char(p.cancel_date,   'YYYY-MM-DD') as cancel_date,
            to_char(p.w3_date,       'YYYY-MM-DD') as w3_date,
            p.max_bbl_per_day, p.max_mcf_per_day,
            p.max_inj_pressure, p.max_inj_pressure_note,
            p.top_inj_zone, p.bot_inj_zone, p.inj_mode,
            p.is_commercial, p.fluid_comment, p.location,
            ${FLUID_COLS}
       from rrc.uic_permit p
       left join rrc.operators o on o.operator_number = p.operator_no
      where p.api_number = $1
      order by (p.cancel_date is null and p.w3_date is null) desc,
               p.approved_date desc nulls last`,
    [api]
  );
  if (permits.length === 0) return null;

  const [edge, rawMonthly] = await Promise.all([
    getInjectionEdge(),
    rrcQuery<Omit<InjectionMonth, "reported">>(
    `select to_char(cycle, 'YYYY-MM')          as cycle,
            coalesce(sum(volume_bbl), 0)::bigint as bbl,
            coalesce(sum(volume_mcf), 0)::bigint as mcf,
            max(avg_pressure)                  as avg_pressure,
            max(max_pressure)                  as max_pressure
       from rrc.uic_h10
      where api_number = $1
        and cycle between date '1950-01-01' and date '2030-12-01'
      group by cycle
      order by cycle`,
      [api]
    ),
  ]);
  const monthly: InjectionMonth[] = rawMonthly.map((m) => ({
    ...m,
    reported: m.cycle <= edge.reported,
  }));

  const rows = permits.map(toPermit);
  const permittedBbl = rows
    .filter((p) => p.live && p.max_bbl_per_day != null)
    .reduce<number | null>((s, p) => (s ?? 0) + (p.max_bbl_per_day ?? 0), null);

  return {
    permits: rows,
    monthly,
    reportedThrough: edge.reported,
    permittedBblPerDay: permittedBbl,
    // Derived HERE rather than in the modal that draws it: the ceiling is a
    // fact about the well's permits, so everything reading this payload gets
    // it, including the tools that hand a well to Orion.
    permittedPressurePsig: permittedPressurePsig(rows),
    recentBblPerDay: ratePerDay(monthly, edge.reported),
  };
}

/**
 * An operator's disposal fleet, for the stat beside the well buckets.
 *
 * Counts PERMITS, not wellbores, and says so on screen: two intervals on one
 * hole are two permits and two capacities, which is what a buyer is acquiring.
 */
export async function getOperatorDisposal(
  operatorNo: string
): Promise<OperatorDisposal> {
  const rows = await rrcQuery<{
    uic_no: string;
    max_bbl_per_day: number | null;
    is_commercial: boolean;
  }>(
    `select p.uic_no, p.max_bbl_per_day, p.is_commercial
       from rrc.uic_permit p
      where p.operator_no = $1
        and p.inj_type in ('1','2')
        and ${LIVE()}`,
    [operatorNo]
  );
  if (rows.length === 0) {
    return {
      wells: 0,
      commercialWells: 0,
      permittedBblPerDay: null,
      injectedBbl12m: null,
      lastReported: null,
      reportedThrough: (await getInjectionEdge()).reported,
    };
  }

  const permitted = rows
    .filter((r) => r.max_bbl_per_day != null)
    .reduce<number | null>((s, r) => (s ?? 0) + (r.max_bbl_per_day ?? 0), null);

  // Bounded by the fleet's own permit list, so this never scans the 21M-row
  // table: the (uic_no, cycle) index is probed once per permit.
  const ids = rows.map((r) => r.uic_no);
  const edge = await getInjectionEdge();
  const recent = await rrcQueryOne<{
    injected: number | null;
    last_reported: string | null;
  }>(
    `select sum(volume_bbl)::bigint        as injected,
            to_char(max(cycle), 'YYYY-MM') as last_reported
       from rrc.uic_h10
      where uic_no = any($1)
        and cycle >  to_date($2, 'YYYY-MM') - interval '12 months'
        and cycle <= to_date($2, 'YYYY-MM')`,
    [ids, edge.reported]
  );

  return {
    wells: rows.length,
    commercialWells: rows.filter((r) => r.is_commercial).length,
    permittedBblPerDay: permitted,
    injectedBbl12m: recent?.injected ?? null,
    lastReported: recent?.last_reported ?? null,
    reportedThrough: edge.reported,
  };
}

/**
 * Live disposal wells matching a filter, with how full each one already is.
 *
 * Two questions, one shape, because they want the same rows back: "where can
 * this water go" (a point and a radius) and "what disposal does this operator
 * own" (an operator number). `findWells` takes the same either/or for the same
 * reason, and a second function would be a second place for the live-permit
 * rule and the utilisation arithmetic to drift.
 *
 * With a point: bounding box first so 003's (lat, lon) index does the work,
 * great-circle distance after to trim the box's corners — the shape that
 * measured 55 ms against a 5 s budget. Without one, `distance_mi` is null and
 * the rows come back biggest permit first, which is the order a package is read
 * in.
 *
 * Returns [] rather than the whole state when neither filter is given.
 */
export async function findDisposal(f: {
  lat?: number;
  lon?: number;
  radiusMi?: number;
  /** 6-digit RRC operator number; may be combined with a point. */
  operatorNo?: string;
  /** Only wells permitted to take third-party water. */
  commercialOnly?: boolean;
  limit?: number;
}): Promise<NearbyDisposal[]> {
  const hasPoint =
    typeof f.lat === "number" &&
    typeof f.lon === "number" &&
    Number.isFinite(f.lat) &&
    Number.isFinite(f.lon);
  const operatorNo = f.operatorNo?.trim();
  // Refuse an unfiltered scan rather than let it time out, exactly as
  // `findWells` does.
  if (!hasPoint && !operatorNo) return [];

  const limit = Math.min(200, Math.max(1, Math.floor(f.limit ?? 25)));
  const params: unknown[] = [];
  const where: string[] = [`p.inj_type in ('1','2')`, LIVE()];
  let distanceSelect = "null::float8 as distance_mi";
  let order = "p.max_bbl_per_day desc nulls last";
  // A point filters `well_location`, so without one the join must not drop
  // permits whose well has no coordinates on file.
  let joinLocation = "left join";

  if (hasPoint) {
    const radius = Math.min(100, Math.max(0.1, f.radiusMi ?? 25));
    const dLat = radius / 69.0;
    const dLon =
      radius / (69.0 * Math.max(0.05, Math.cos((f.lat! * Math.PI) / 180)));
    params.push(f.lat, f.lon, f.lat! - dLat, f.lat! + dLat, f.lon! - dLon, f.lon! + dLon, radius);
    const dist = `(3958.7613 * acos(least(1, greatest(-1,
        sin(radians($1)) * sin(radians(l.lat)) +
        cos(radians($1)) * cos(radians(l.lat)) * cos(radians(l.lon) - radians($2))))))`;
    where.push("l.lat between $3 and $4", "l.lon between $5 and $6", `${dist} <= $7`);
    distanceSelect = `round(${dist}::numeric, 2)::float8 as distance_mi`;
    order = "distance_mi";
    joinLocation = "join";
  }
  if (operatorNo) {
    params.push(operatorNo);
    where.push(`p.operator_no = $${params.length}`);
  }
  if (f.commercialOnly) where.push("p.is_commercial");

  params.push(limit);
  const wells = await rrcQuery<NearbyDisposal & { distance_mi: number }>(
    `select p.uic_no, p.api_number, p.operator_no, o.operator_name,
            coalesce(w.lease_name, p.lease_name) as lease_name,
            w.well_no, w.county_name,
            p.inj_type, p.is_commercial, p.max_bbl_per_day,
            p.top_inj_zone, p.bot_inj_zone,
            l.lat, l.lon,
            ${distanceSelect}
       from rrc.uic_permit p
       ${joinLocation} rrc.well_location l on l.api_number = p.api_number
       left join rrc.operators o on o.operator_number = p.operator_no
       left join rrc.wellbore w
              on w.api_number = p.api_number and w.on_schedule = 'Y'
      where ${where.join(" and ")}
      order by ${order}
      limit $${params.length}`,
    params
  );
  if (wells.length === 0) return [];

  // How full each one already is. One extra round trip rather than a lateral
  // per row: the permit list is at most `limit` long and the (uic_no, cycle)
  // index answers it directly.
  const ids = wells.map((w) => w.uic_no);
  const edge = await getInjectionEdge();
  const used = await rrcQuery<{ uic_no: string; bbl: number; days: number }>(
    `select uic_no,
            coalesce(sum(volume_bbl), 0)::bigint as bbl,
            sum(extract(day from (cycle + interval '1 month' - interval '1 day')))::int
              as days
       from rrc.uic_h10
      where uic_no = any($1)
        and cycle >  to_date($2, 'YYYY-MM') - interval '12 months'
        and cycle <= to_date($2, 'YYYY-MM')
      group by uic_no`,
    [ids, edge.reported]
  );
  const byId = new Map(used.map((u) => [u.uic_no.trim(), u]));

  return wells.map((w) => {
    const u = byId.get(w.uic_no.trim());
    // Divided by the days in the months this well actually filed, the same
    // definition `ratePerDay` uses on the well modal, so the two surfaces
    // cannot quote different rates for the same well.
    const rate = u && u.days > 0 ? u.bbl / u.days : null;
    return {
      ...w,
      uic_no: w.uic_no.trim(),
      api_number: w.api_number?.trim() ?? null,
      operator_no: w.operator_no?.trim() ?? null,
      recentBblPerDay: rate,
      utilisation:
        rate != null && w.max_bbl_per_day ? rate / w.max_bbl_per_day : null,
    };
  });
}


// ------------------------------------------------ wellbore construction

/*
 * The Well Bore Database (dbf900): how each hole was actually built.
 *
 * `rrc.wellbore` says who runs it, `rrc.completion*` holds the paperwork, and
 * these tables hold the hole — perforated intervals, casing strings, H-15
 * tests. See `docs/plans/rrc-data-expansion.md` §1.2.
 *
 * THE GRAIN RULE, and it is the one that bites: casing and perforations belong
 * to a FILING, not to a well. A recompleted hole carries several sets, and a
 * query that groups only by api_number blends a 1978 completion with a 2019
 * one. Everything below groups by (api_number, file_date).
 */

/** Feet, or null — the source zero-fills what it does not know. */
function ft(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/**
 * How one hole was built.
 *
 * Returns null when dbf900 has no root row for the API, which is the honest
 * answer for a well the Well Bore Database does not carry — distinct from a
 * well it carries with no filings, which returns an empty `filings`.
 */
export async function getWellConstruction(
  api: string
): Promise<WellConstruction | null> {
  const root = await rrcQueryOne<{
    total_depth: number | null;
  }>(`select total_depth from rrc.wb_root where api_number = $1`, [api]);
  if (!root) return null;

  const [filings, casing, perfs] = await Promise.all([
    rrcQuery<{
      file_date: string | null;
      completion_date: string | null;
      plug_back_depth1: number | null;
      plug_back_depth2: number | null;
      elevation: number | null;
      elevation_code: string | null;
    }>(
      `select to_char(file_date, 'YYYY-MM-DD')       as file_date,
              to_char(completion_date, 'YYYY-MM-DD') as completion_date,
              plug_back_depth1, plug_back_depth2, elevation, elevation_code
         from rrc.wb_filing
        where api_number = $1
        order by file_date desc nulls last`,
      [api]
    ),
    rrcQuery<Record<string, unknown>>(
      `select to_char(file_date, 'YYYY-MM-DD') as file_date,
              seq, size_in, weight_lb_ft, depth_set, cement_amount,
              cement_measure, top_of_cement, hole_inch, hole_num, hole_denom
         from rrc.wb_casing
        where api_number = $1
        order by file_date desc nulls last, depth_set desc nulls last`,
      [api]
    ),
    rrcQuery<Record<string, unknown>>(
      `select to_char(file_date, 'YYYY-MM-DD') as file_date,
              seq, top_ft, bottom_ft, open_hole_code
         from rrc.wb_perf
        where api_number = $1
        order by file_date desc nulls last, top_ft nulls last`,
      [api]
    ),
  ]);

  // Group the children onto their filing. A null file_date is its own bucket
  // rather than being folded into the newest filing: "which completion this
  // belongs to is unrecorded" is a fact, not a reason to guess.
  const key = (d: string | null) => d ?? "";
  const casingBy = new Map<string, CasingString[]>();
  for (const c of casing) {
    const denom = Number(c.hole_denom) || 0;
    const list = casingBy.get(key(c.file_date as string | null)) ?? [];
    list.push({
      seq: ft(c.seq),
      size_in: c.size_in == null ? null : Number(c.size_in),
      weight_lb_ft: c.weight_lb_ft == null ? null : Number(c.weight_lb_ft),
      depth_set: ft(c.depth_set),
      hole_size_in:
        c.hole_inch == null
          ? null
          : Number(c.hole_inch) + (denom ? Number(c.hole_num) / denom : 0),
      cement_amount: ft(c.cement_amount),
      cement_measure: (c.cement_measure as string | null) ?? null,
      top_of_cement: (c.top_of_cement as string | null) ?? null,
    });
    casingBy.set(key(c.file_date as string | null), list);
  }

  const perfBy = new Map<string, PerfInterval[]>();
  for (const p of perfs) {
    const list = perfBy.get(key(p.file_date as string | null)) ?? [];
    list.push({
      seq: ft(p.seq),
      top_ft: ft(p.top_ft),
      bottom_ft: ft(p.bottom_ft),
      open_hole: p.open_hole_code === "OH",
    });
    perfBy.set(key(p.file_date as string | null), list);
  }

  const tops = perfs
    .map((p) => ft(p.top_ft))
    .filter((n): n is number => n != null);
  const bottoms = perfs
    .map((p) => ft(p.bottom_ft))
    .filter((n): n is number => n != null);

  return {
    filings: filings.map((f) => ({
      file_date: f.file_date,
      completion_date: f.completion_date,
      // Two plug-back columns, and the DEEPER one is the operative depth: the
      // second is an earlier, shallower plug on the same hole.
      plug_back_ft:
        f.plug_back_depth1 == null && f.plug_back_depth2 == null
          ? null
          : Math.max(f.plug_back_depth1 ?? 0, f.plug_back_depth2 ?? 0),
      elevation: f.elevation,
      elevation_code: f.elevation_code,
      casing: casingBy.get(key(f.file_date)) ?? [],
      perforations: perfBy.get(key(f.file_date)) ?? [],
    })),
    total_depth: root.total_depth,
    shallowest_perf: tops.length ? Math.min(...tops) : null,
    deepest_perf: bottoms.length ? Math.max(...bottoms) : null,
    has_open_hole: perfs.some((p) => p.open_hole_code === "OH"),
  };
}

/** One hole's H-15 test history, newest first. */
export async function getWellH15(api: string): Promise<H15Test[]> {
  const rows = await rrcQuery<Record<string, unknown>>(
    `select to_char(test_date, 'YYYY-MM-DD')   as test_date,
            to_char(status_date, 'YYYY-MM-DD') as status_date,
            status, operator_no, test_type, fluid_method, mech_method,
            top_of_fluid, next_test_year, next_test_month
       from rrc.wb_h15
      where api_number = $1
      order by test_date desc nulls last, status_date desc nulls last`,
    [api]
  );
  return rows.map((r) => ({
    test_date: (r.test_date as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    status_date: (r.status_date as string | null) ?? null,
    operator_no: ((r.operator_no as string | null) ?? null)?.trim() ?? null,
    test_type: (r.test_type as string | null) ?? null,
    fluid_method: (r.fluid_method as string | null) ?? null,
    mech_method: (r.mech_method as string | null) ?? null,
    top_of_fluid: ft(r.top_of_fluid),
    next_test_due:
      r.next_test_year && r.next_test_month
        ? `${r.next_test_year}-${r.next_test_month}`
        : null,
  }));
}

/**
 * An operator's H-15 position.
 *
 * Counted over each WELLBORE'S MOST RECENT filing, not over every filing ever.
 * A well that was delinquent in 2019 and has been current since is not a
 * liability today, and counting rows rather than wells would say it is — which
 * is exactly the kind of number that reads as a red flag on a counterparty who
 * has since put their house in order.
 */
export async function getOperatorH15(
  operatorNo: string
): Promise<OperatorH15> {
  const row = await rrcQueryOne<{
    wells: number;
    delinquent: number;
    due_soon: number;
    last_test: string | null;
  }>(
    `with latest as (
       select distinct on (api_number)
              api_number, status, test_date, next_test_year, next_test_month
         from rrc.wb_h15
        where operator_no = $1
        order by api_number, test_date desc nulls last, status_date desc nulls last
     )
     select count(*)::int                                  as wells,
            count(*) filter (where status = 'D')::int      as delinquent,
            count(*) filter (
              where next_test_year ~ '^\\d{4}$' and next_test_month ~ '^\\d{2}$'
                and to_date(next_test_year || next_test_month, 'YYYYMM')
                      between current_date and current_date + interval '90 days'
            )::int                                         as due_soon,
            to_char(max(test_date), 'YYYY-MM-DD')          as last_test
       from latest`,
    [operatorNo]
  );
  return {
    wellsTested: row?.wells ?? 0,
    delinquent: row?.delinquent ?? 0,
    dueSoon: row?.due_soon ?? 0,
    lastTest: row?.last_test ?? null,
  };
}

// ----------------------------------------------------------- W-10 tests

/*
 * Form W-10: the only measured per-WELL oil rate in the Texas record.
 *
 * TWO RULES, both measured rather than assumed:
 *
 *   1. A TEST IS NOT A MONTH. It is one day's rate on the day the well was
 *      tested, filed to establish an allowable. Across 14,663 leases the sum
 *      of a lease's latest tests is a MEDIAN 1.64x its actual daily production
 *      — the right relationship, since a test is a good day and the reported
 *      series averages in downtime. Never show a test rate as what a well
 *      makes, and never sum tests into a lease total.
 *   2. WHAT THE RATIO IS GOOD FOR is weighting. Two wells' tests are
 *      comparable to each other even when both read high, which makes them a
 *      defensible basis for splitting a lease — the alternative being the even
 *      split, which assumes every well on the lease is identical.
 *
 * Keyed district + lease + well, the RRC's own oil key. The district is the
 * REAL-WORLD label, so it joins `rrc.wellbore`, never a PDQ table.
 */

const W10_COLS = `
  to_char(test_date, 'YYYY-MM-DD') as test_date,
  to_char(cycle, 'YYYY-MM-DD')     as cycle,
  daily_oil, daily_water, daily_gas, gas_oil_ratio,
  producing_method, type_flag`;

/** One wellbore's W-10 test history, newest first. */
export async function getWellW10(
  district: string,
  leaseNo: string,
  wellNo: string
): Promise<W10Test[]> {
  return rrcQuery<W10Test>(
    `select ${W10_COLS}
       from rrc.w10_test
      where district = $1 and lease_no = $2 and well_no = $3
      order by test_date desc nulls last`,
    [district, leaseNo, wellNo]
  );
}

/**
 * One gas wellbore's G-10 deliverability history, newest first.
 *
 * Keyed district + the six-digit RRC gas id, which is what `lease_number`
 * holds on a gas row of `rrc.wellbore`. That indirection is the whole reason
 * this dataset sat unused: the G-10 file carries no API number, and neither
 * does the Well Database that was supposed to supply one.
 *
 * Deliberately NOT read through `rrc.g10_well`. That view exists to attach an
 * API to a test, and 1,501 apis carry more than one gas id (a hole completed
 * in several gas reservoirs files a G-10 per reservoir), so reading a single
 * wellbore's history through it would multiply the rows.
 */
/**
 * Every W-3 plugging job on this hole, newest first, with its plugs summarised.
 *
 * Read through `rrc.wb_plug_summary`, which does the group-by against
 * `wb_plug_detail` on (api_number, plug_date). Joining on api_number alone
 * would merge two plugging jobs on one hole into a single implausible list of
 * cement plugs — a hole plugged back and later re-entered really does have two.
 */
export async function getWellPlugging(api: string): Promise<PluggingJob[]> {
  return rrcQuery<PluggingJob>(
    `select to_char(plug_date, 'YYYY-MM-DD')     as plug_date,
            -- rrc.wb_plug_summary carries no filing date: its columns are
            -- api_number, plug_date and the plug measurements. Selecting one
            -- 42703'd, and because this read sits in the dossier's Promise.all
            -- it took the WHOLE well modal down with it, not just the Plugging
            -- tab. Held as null so the shape the UI reads stays put.
            null::text as w3_filed_date,
            total_depth, fresh_water_depth, cement_comp, well_type,
            state_funded, plugs, cement_sacks,
            shallowest_plug_top, deepest_plug_bottom
       from rrc.wb_plug_summary
      where api_number = $1
      order by plug_date desc nulls last`,
    [api]
  );
}

export async function getWellG10(
  district: string,
  gasId: string
): Promise<G10Test[]> {
  return rrcQuery<G10Test>(
    `select to_char(test_date, 'YYYY-MM-DD')    as test_date,
            to_char(shut_in_date, 'YYYY-MM-DD') as shut_in_date,
            daily_gas, daily_cond, daily_water, potential,
            siwh_press, flow_press, bhp, gas_gravity, gas_liquid_ratio,
            shut_in_flag, late_test, corrected, operator_no
       from rrc.g10_test
      where district = $1 and gas_id = $2
      order by test_date desc nulls last`,
    [district, gasId]
  );
}

/**
 * The latest test per well on a lease, and each well's share of the tested oil.
 *
 * `share` is deliberately null rather than zero for a well with no usable test.
 * Zero would say "this well makes nothing"; null says "this well cannot be
 * weighted", which is what forces the caller to fall back to the even split
 * rather than quietly assigning the untested wells no oil.
 */
export async function getLeaseW10(
  district: string,
  leaseNo: string
): Promise<LeaseW10> {
  const rows = await rrcQuery<{
    well_no: string;
    api_number: string | null;
    test_date: string | null;
    daily_oil: number | null;
    producing_method: string | null;
  }>(
    `select distinct on (t.well_no)
            t.well_no,
            w.api_number,
            to_char(t.test_date, 'YYYY-MM-DD') as test_date,
            t.daily_oil, t.producing_method
       from rrc.w10_test t
       left join rrc.wellbore w
              on w.district = t.district and w.lease_number = t.lease_no
             and w.well_no = t.well_no and w.oil_gas_code = 'O'
             and w.on_schedule = 'Y'
      where t.district = $1 and t.lease_no = $2
      order by t.well_no, t.test_date desc nulls last`,
    [district, leaseNo]
  );

  const tested = rows.filter((r) => (r.daily_oil ?? 0) > 0);
  const total = tested.reduce((s, r) => s + (r.daily_oil ?? 0), 0);
  return {
    wells: rows.map((r) => ({
      well_no: r.well_no,
      api_number: r.api_number?.trim() ?? null,
      test_date: r.test_date,
      daily_oil: r.daily_oil,
      producing_method: r.producing_method,
      share: total > 0 && (r.daily_oil ?? 0) > 0 ? (r.daily_oil ?? 0) / total : null,
    })),
    testedBopd: total,
    untested: rows.length - tested.length,
  };
}

// ------------------------------------------------------------------- P-4

/*
 * Form P-4: who is authorised to move a lease's product, and when that changed.
 *
 * THE DISTRICT HERE IS PDQ'S INTERNAL CODE. The source field is PIC 9(02) and
 * cannot hold "6E" or "8A" at all, so these tables join `rrc.lease` and the
 * lease modal's own key — and NEVER `rrc.wellbore`, which uses the real labels.
 * That is the opposite of `rrc.w10_test`. Getting it backwards lands on a
 * different district's lease and reports another operator's purchaser.
 */

/** What each P-4 change flag means, in the order a reader wants them. */
const P4_CHANGES: { col: string; label: string }[] = [
  { col: "chg_operator", label: "Operator" },
  { col: "chg_purchaser", label: "Purchaser" },
  { col: "chg_gatherer", label: "Gatherer" },
  { col: "chg_nominator", label: "Nominator" },
  { col: "chg_field", label: "Field" },
  { col: "chg_lease_name", label: "Lease name" },
  { col: "chg_new_well", label: "New well" },
  { col: "chg_purch_system", label: "Purchaser system" },
  { col: "consolidation", label: "Consolidation" },
  { col: "subdivision", label: "Subdivision" },
  { col: "reclassification", label: "Reclassification" },
  { col: "oil_field_transfer", label: "Oil field transfer" },
];

/**
 * A lease's P-4: its current counterparties and the filings that changed them.
 *
 * `is_current` is deliberately NOT used to pick the live connection. The tape's
 * own 88-levels make it "current PURCHASER", so a gatherer is always '0'
 * whatever its state — measured across 12.1M rows, '1' occurs only with type
 * 'H' and only for gas. Currency comes from the filing's effective date.
 */
export async function getLeaseP4(
  oilGasCode: string,
  districtNo: string,
  leaseNo: string
): Promise<LeaseP4> {
  const [conns, filings] = await Promise.all([
    rrcQuery<Record<string, unknown>>(
      `select distinct on (g.product_code, g.type_code)
              g.product_code, g.type_code, g.gpn_no, o.operator_name,
              g.actual_percent, g.interstate, g.intrastate,
              to_char(g.effective_date, 'YYYY-MM-DD') as effective_date
         from rrc.p4_gatherer g
         left join rrc.operators o on o.operator_number = g.gpn_no
        where g.oil_gas_code = $1 and g.district = $2 and g.lease_no = $3
          and g.gpn_no is not null and g.gpn_no <> '000000'
        order by g.product_code, g.type_code, g.effective_date desc nulls last`,
      [oilGasCode, districtNo, leaseNo]
    ),
    rrcQuery<Record<string, unknown>>(
      `select to_char(effective_date, 'YYYY-MM-DD') as effective_date,
              to_char(approval_date, 'YYYY-MM-DD')  as approval_date,
              record_type, f.operator_no, o.operator_name, f.field_no,
              ${P4_CHANGES.map((c) => c.col).join(", ")}
         from rrc.p4_filing f
         left join rrc.operators o on o.operator_number = f.operator_no
        where f.oil_gas_code = $1 and f.district = $2 and f.lease_no = $3
          -- record_type 'D' is an RRC dummy written to initialise a lease.
          -- Filtering on the type, NOT on "has a date": 54,980 dummies carry
          -- one, so a date does not separate them from real filings.
          and f.record_type <> 'D'
        order by f.effective_date desc nulls last
        limit 200`,
      [oilGasCode, districtNo, leaseNo]
    ),
  ]);

  return {
    connections: conns.map((c) => ({
      product_code: (c.product_code as string | null) ?? null,
      type_code: (c.type_code as string | null) ?? null,
      gpn_no: ((c.gpn_no as string | null) ?? null)?.trim() ?? null,
      operator_name: (c.operator_name as string | null) ?? null,
      actual_percent:
        c.actual_percent == null ? null : Number(c.actual_percent),
      effective_date: (c.effective_date as string | null) ?? null,
      interstate: c.interstate === "Y",
      intrastate: c.intrastate === "Y",
    })),
    filings: filings
      .map((f) => ({
        effective_date: (f.effective_date as string | null) ?? null,
        approval_date: (f.approval_date as string | null) ?? null,
        record_type: (f.record_type as string | null) ?? null,
        operator_no: ((f.operator_no as string | null) ?? null)?.trim() ?? null,
        operator_name: (f.operator_name as string | null) ?? null,
        field_no: (f.field_no as string | null) ?? null,
        changes: P4_CHANGES.filter((c) => f[c.col] === "Y").map((c) => c.label),
      }))
      // A filing that changed nothing named is paperwork, not an event.
      .filter((f) => f.changes.length > 0),
  };
}
