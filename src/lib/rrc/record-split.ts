import "server-only";

import { rrcQuery } from "@/lib/scout/rrc-db";
import { toPdqDistrict } from "@/lib/scout/rrc-districts";
import {
  applyShares,
  monthsForWell,
  ownedShareByMonth,
  sharesByMonth,
  type TestRow,
  type WellRef,
} from "./well-share";
import type { RrcMonth } from "./lease-history-series";

/**
 * An RRC lease record, its wells, and what we can weight them by.
 *
 * This is the join that everything else in the RRC estimate hangs off, and it is
 * the one place the two district codings meet, so it is the one place to get them
 * wrong. They are NOT interchangeable:
 *
 *   rrc.wellbore, rrc.w10_test   real-world label   "6E", "8A", "01"
 *   rrc.lease_production          PDQ internal      "06", "8A" is impossible
 *
 * The production field is PIC 9(02) and cannot hold "6E" at all, so a record's
 * volumes are read with `toPdqDistrict(district)` while its wells and tests are
 * read with the raw label. Swapping them lands on a different district's lease
 * and reports another operator's production as ours.
 *
 * ## Oil records split, gas records do not
 *
 * Texas files oil at the lease level and gas at the WELL level. Measured across
 * the mirror: 138,962 gas records, none with more than one well, average 1.00;
 * 84,059 oil records averaging 3.48 wells and running to 1,854. So a gas record's
 * reported volume already belongs to exactly one well and needs no weighting,
 * while an oil record's has to be divided by well test. Both fall out of the same
 * code path: a one-well record splits 100% to that well without a special case.
 */
export interface RecordSlice {
  /** `O` lease-level oil, `G` well-level gas. */
  oilGasCode: "O" | "G";
  /** Real-world district label. Joins `wellbore` and `w10_test`. */
  district: string;
  /** `wellbore.lease_number`: the oil lease number, or the six-digit gas id. */
  leaseNo: string;
  /** The same district translated for `lease_production`. */
  pdqDistrict: string;
  /**
   * EVERY well on the record, whoever operates it, with the month it was
   * completed. This is the denominator, and the dates keep a well from being
   * weighted in the decades before it was drilled.
   */
  wells: WellRef[];
  /** The record's whole W-10 history. Empty on a gas record. */
  tests: TestRow[];
  /** The record wells whose API matched one we asked about. */
  ourWellNos: string[];
  /** Asked-about API (8 digits) to its well number on this record. */
  wellNoByApi: Record<string, string>;
}

const LOG = "[rrc-split]";

/**
 * `YYYYMMDD` as the mirror stores it, to the `YYYY-MM` the split works in.
 *
 * Blank ('' on 38,221 of 440,050 scheduled wellbores) and the zero-filled
 * placeholder both mean "not stated", which leaves the well eligible in every
 * month rather than excluding it from its own production.
 */
export function completionMonth(raw: string | null): string | null {
  const digits = (raw ?? "").trim();
  if (!/^\d{8}$/.test(digits) || digits.startsWith("0000")) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}`;
}

/**
 * EVERY W-10 on a lease, not just the latest per well.
 *
 * `getLeaseW10` (in `scout/rrc-queries`) answers "how does this lease split
 * today", which is what a dossier's header wants. Splitting decades of reported
 * production needs the whole history instead: a lease's split moves as wells are
 * drilled, water out and are recompleted, so each production month is weighted
 * by the test in effect THEN.
 *
 * It lives HERE, not with the other Scout queries, so that `rrc-queries` can
 * import this module for the split without the two importing each other.
 *
 * Real-world district, same as `getWellW10`. Both rate columns come back because
 * oil and casinghead gas are weighted separately.
 */
export async function getLeaseW10History(
  district: string,
  leaseNo: string
): Promise<
  {
    well_no: string;
    test_date: string | null;
    daily_oil: number | null;
    daily_gas: number | null;
  }[]
> {
  return rrcQuery(
    `select well_no,
            to_char(test_date, 'YYYY-MM-DD') as test_date,
            daily_oil, daily_gas
       from rrc.w10_test
      where district = $1 and lease_no = $2 and test_date is not null
      order by well_no, test_date`,
    [district, leaseNo]
  );
}

/**
 * `YYYYMM` as the shut-in columns store it, to the `YYYY-MM` the split works in.
 *
 * A different width from `completion_date`, which is `YYYYMMDD`. Blank, '0' and
 * the zero-filled placeholder all mean "still running", which leaves the well
 * weighted — the same fail-open posture the completion date takes.
 */
export function shutInMonth(raw: string | null): string | null {
  const digits = (raw ?? "").trim();
  if (!/^\d{6}$/.test(digits) || digits.startsWith("0000")) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}`;
}

/**
 * Well types that CANNOT deliver oil or gas to the lease's reported volume.
 *
 * A deny-list, not an allow-list: an unrecognised type stays in the denominator,
 * because wrongly dropping a producer inflates every other well on the lease
 * while wrongly keeping a service hole only dilutes them. The listed types are
 * the ones the mirror's `well_type_name` domain makes unambiguous.
 */
const SERVICE_TYPES = new Set([
  "INJECTION",
  "WATER SUPPLY",
  "OBSERVATION",
  "LPG STORAGE",
  "GAS STRG-INJECTION",
  "GAS STRG-WITHDRAWAL",
  "GAS STRG-SALT FORMATION",
  "BRINE MINING",
  "DOMESTIC USE WELL",
  "GEOTHERMAL WELL",
  "OTHER TYPE SERVICE",
]);

/** Whether a hole of this type can be weighted for a share of the lease. */
export function producesToLease(wellTypeName: string | null): boolean {
  return !SERVICE_TYPES.has((wellTypeName ?? "").trim().toUpperCase());
}

/** The mirror keys on the last 8 digits, with no dashes. */
export function apiDigits(api: string | null | undefined): string | null {
  const digits = (api ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-8) : null;
}

/**
 * The RRC lease records a set of our wells sit on, loaded whole.
 *
 * A well with no API number, or one that is not on a current P-5 schedule, has no
 * identity in the public record and simply contributes nothing. That is a chart
 * that starts later, never an error on the page.
 */
/**
 * Process-wide caches of what the mirror returns, one hour.
 *
 * The public record changes when Texas publishes, i.e. monthly; every render
 * was re-reading the same records from a database in another region. A
 * request-scoped memo still dedupes within a render; this carries the answer
 * across renders on one instance. Keyed on the same inputs the reads take, and
 * a failed read is not cached (it throws before the `set`).
 */
const RRC_TTL_MS = 60 * 60_000;

/**
 * Empty the process caches. MEASUREMENT ONLY: the page harness asks for this
 * at the start of the render it times, so that render is the once-an-hour cold
 * one. (A zero TTL was tried first and measured something that does not exist:
 * it also defeated the reuse WITHIN a render, so the prefetch and the read that
 * consumes it each went to the mirror.)
 */
export function clearRrcCaches(): void {
  sliceCache.clear();
  monthsCache.clear();
}
const sliceCache = new Map<string, { at: number; value: RecordSlice[] }>();
const monthsCache = new Map<string, { at: number; value: RrcMonth[] }>();
/** Reads in progress, so a prefetch and the read that consumes it are one query. */
const monthsInflight = new Map<string, Promise<RrcMonth[]>>();
function fresh<T>(hit: { at: number; value: T } | undefined): T | undefined {
  return hit && Date.now() - hit.at < RRC_TTL_MS ? hit.value : undefined;
}

export interface LoadSlicesOpts {
  /**
   * Start each record's production read the moment the record is known, in
   * the same wave as its well list and tests, so the caller's `ownedMonths` /
   * `wellMonthsBatch` finds it in flight. Without it the months are a fourth
   * round trip after our-wells, record-wells and tests. Pass the same
   * `sinceMonths` the later read will use, or the prefetch warms the wrong key.
   */
  months?: { sinceMonths?: number };
}

export async function loadRecordSlices(
  apis: string[],
  opts: LoadSlicesOpts = {}
): Promise<RecordSlice[]> {
  const wanted = [...new Set(apis.map(apiDigits).filter((a): a is string => !!a))];
  if (wanted.length === 0) return [];
  const cacheKey = [...wanted].sort().join(",");
  const cached = fresh(sliceCache.get(cacheKey));
  if (cached) return cached;
  const slices = await loadRecordSlicesUncached(wanted, opts);
  sliceCache.set(cacheKey, { at: Date.now(), value: slices });
  return slices;
}

async function loadRecordSlicesUncached(
  wanted: string[],
  opts: LoadSlicesOpts
): Promise<RecordSlice[]> {

  const ours = await rrcQuery<{
    api_number: string;
    oil_gas_code: "O" | "G" | null;
    district: string | null;
    lease_number: string | null;
    well_no: string | null;
  }>(
    `select api_number, oil_gas_code, district, lease_number, well_no
       from rrc.wellbore
      where api_number = any($1)
        and on_schedule = 'Y'
        and lease_number is not null`,
    [wanted]
  );

  // Group our matched wells by the record they sit on. One of our wells can be on
  // two records at once: an oil lease for its oil, its own gas id for its gas.
  const byRecord = new Map<
    string,
    { oilGasCode: "O" | "G"; district: string; leaseNo: string; ours: Map<string, string> }
  >();
  for (const row of ours) {
    if (!row.oil_gas_code || !row.district || !row.lease_number || !row.well_no) continue;
    const id = `${row.oil_gas_code}/${row.district}/${row.lease_number}`;
    const at =
      byRecord.get(id) ??
      {
        oilGasCode: row.oil_gas_code,
        district: row.district,
        leaseNo: row.lease_number,
        ours: new Map<string, string>(),
      };
    at.ours.set(row.api_number, row.well_no);
    byRecord.set(id, at);
  }

  if (byRecord.size === 0) {
    console.warn(
      `${LOG} none of ${wanted.length} API number(s) are on a current P-5 schedule`
    );
    return [];
  }

  const recs = [...byRecord.values()];
  if (opts.months) {
    for (const rec of recs) {
      const key = {
        oilGasCode: rec.oilGasCode,
        districtNo: toPdqDistrict(rec.district) ?? rec.district,
        leaseNo: rec.leaseNo,
      };
      // Warm only; the caller's own read is what consumes it. A failure here
      // is that read's failure to report.
      monthlyForKey(key, opts.months).catch(() => {});
    }
  }
  return buildSlices(recs);
}

/**
 * Build many slices: ONE `rrc.wellbore` read and ONE `rrc.w10_test` read for
 * every record together.
 *
 * Both are `unnest(...) cross join lateral (...)`: the planner probes the
 * keyed btree once per record inside one statement (EXPLAIN on the mirror:
 * 14 records, wellbore 194ms as 14 concurrent reads → 33ms as one; w10 26 →
 * 28ms). The win is less the wall time than the connections: 14 records were
 * 42 concurrent queries against a pool of 20, so the production reads queued
 * behind the well lists. A composite `IN (unnest(...))` was tried earlier and
 * is the wrong shape for `lease_production` (see `fleetRrcRates`); the
 * lateral form is NOT used there either, since that table's compressed
 * segments key on district only and a lateral loop scans them once per key
 * (3.9s for 14 keys against 1.1s concurrent).
 */
async function buildSlices(
  recs: {
    oilGasCode: "O" | "G";
    district: string;
    leaseNo: string;
    ours: Map<string, string>;
  }[]
): Promise<RecordSlice[]> {
  if (recs.length === 0) return [];
  const oil = recs.map((r, i) => ({ r, i })).filter(({ r }) => r.oilGasCode === "O");
  const [wellRows, testRows] = await Promise.all([
    rrcQuery<{
      i: number | string;
      well_no: string;
      completion_date: string | null;
      well_type_name: string | null;
      shut_in_date: string | null;
    }>(
      `select k.i, w.well_no, min(w.completion_date) as completion_date,
              min(w.well_type_name) as well_type_name,
              -- wl_shut_in_date is populated for every shut-in wellbore on
              -- a current schedule; wb_shut_in_date agrees but is blank on
              -- 8,767 of them, so it is the fallback rather than the source.
              min(coalesce(nullif(btrim(w.wl_shut_in_date), ''),
                           nullif(btrim(w.wb_shut_in_date), ''))) as shut_in_date
         from unnest($1::text[], $2::text[], $3::text[]) with ordinality as k(c, d, l, i)
         cross join lateral (
           select well_no, completion_date, well_type_name, wl_shut_in_date, wb_shut_in_date
             from rrc.wellbore
            where oil_gas_code = k.c and district = k.d and lease_number = k.l
              and on_schedule = 'Y' and well_no is not null
         ) w
        group by k.i, w.well_no`,
      [recs.map((r) => r.oilGasCode), recs.map((r) => r.district), recs.map((r) => r.leaseNo)]
    ),
    // The W-10 history is keyed the same way `getLeaseW10History` reads it;
    // gas records carry none, so they are left out of the key list.
    oil.length === 0
      ? Promise.resolve([])
      : rrcQuery<{
          i: number | string;
          well_no: string;
          test_date: string | null;
          daily_oil: number | null;
          daily_gas: number | null;
        }>(
          `select k.i, t.well_no,
                  to_char(t.test_date, 'YYYY-MM-DD') as test_date,
                  t.daily_oil, t.daily_gas
             from unnest($1::text[], $2::text[]) with ordinality as k(d, l, i)
             cross join lateral (
               select well_no, test_date, daily_oil, daily_gas
                 from rrc.w10_test
                where district = k.d and lease_no = k.l and test_date is not null
             ) t
            order by k.i, t.well_no, t.test_date`,
          [oil.map(({ r }) => r.district), oil.map(({ r }) => r.leaseNo)]
        ),
  ]);
  // `with ordinality` is 1-based; `i` comes back as a bigint string.
  const wellsByRec = new Map<number, typeof wellRows>();
  for (const row of wellRows) {
    const at = Number(row.i) - 1;
    const list = wellsByRec.get(at);
    if (list) list.push(row);
    else wellsByRec.set(at, [row]);
  }
  const testsByRec = new Map<number, typeof testRows>();
  for (const row of testRows) {
    const at = oil[Number(row.i) - 1].i;
    const list = testsByRec.get(at);
    if (list) list.push(row);
    else testsByRec.set(at, [row]);
  }
  return Promise.all(
    recs.map((rec, i) => buildSlice(rec, wellsByRec.get(i) ?? [], testsByRec.get(i) ?? []))
  );
}

/**
 * One record loaded whole: its wells, its tests, and which of them are ours.
 *
 * Split out because two callers need the identical thing from two different
 * starting points — a set of our APIs, or a bare lease key. Duplicating it would
 * put a second definition of "the denominator" in the codebase, and the whole
 * reason a well's share is trustworthy is that there is only one.
 */
async function buildSlice(
  rec: {
    oilGasCode: "O" | "G";
    district: string;
    leaseNo: string;
    ours: Map<string, string>;
  },
  /**
   * The record's wells, already read. The denominator: every well on the
   * record, including other operators'. The W-10 file covers all of them, which
   * is what makes our wells' shares true; narrowing to our own would inflate
   * every one. Read for all records at once by `buildSlices`; the query it
   * came from keeps the shut-in fallback (wl_shut_in_date is populated for
   * every shut-in wellbore on a current schedule, wb_shut_in_date is blank on
   * 8,767 of them).
   */
  wells: {
    well_no: string;
    completion_date: string | null;
    well_type_name: string | null;
    shut_in_date: string | null;
  }[],
  /** The record's W-10 history, read beside the wells. Empty on a gas record. */
  tests: Awaited<ReturnType<typeof getLeaseW10History>>
): Promise<RecordSlice> {
  const refs: WellRef[] = wells.map((w) => ({
    wellNo: w.well_no,
    produces: producesToLease(w.well_type_name),
    completedMonth: completionMonth(w.completion_date),
    shutInMonth: shutInMonth(w.shut_in_date),
  }));
  // Our well is on the record by definition; keep it even if the well list
  // query missed it, so a well can never be split out of its own lease.
  for (const wellNo of rec.ours.values()) {
    if (!refs.some((r) => r.wellNo === wellNo)) {
      refs.push({
        wellNo,
        produces: true,
        completedMonth: null,
        shutInMonth: null,
      });
    }
  }

  return {
    oilGasCode: rec.oilGasCode,
    district: rec.district,
    leaseNo: rec.leaseNo,
    pdqDistrict: toPdqDistrict(rec.district) ?? rec.district,
    wells: refs,
    tests: tests.map((t) => ({
      wellNo: t.well_no,
      testDate: t.test_date,
      dailyOil: t.daily_oil,
      dailyGas: t.daily_gas,
    })),
    ourWellNos: [...new Set(rec.ours.values())],
    wellNoByApi: Object.fromEntries(rec.ours),
  } satisfies RecordSlice;
}

/**
 * The same record, reached from a LEASE key rather than from a set of our APIs.
 *
 * The public-record tools ask "how does this lease split among its wells", where
 * there is no "ours" at all — every well on the record is in scope, and
 * `ourWellNos` comes back empty. That emptiness is meaningful and correct: it
 * says nothing here is claimed as this company's, which is exactly right for a
 * question about somebody else's lease.
 *
 * `district` is the REAL district label (the one `wellbore` and `w10_test` are
 * keyed on), not PDQ's internal code. Callers holding a `lease_production` key
 * have the internal one and must translate before calling.
 */
export async function loadLeaseSlice(
  oilGasCode: "O" | "G",
  district: string,
  leaseNo: string
): Promise<RecordSlice> {
  const [slice] = await buildSlices([{ oilGasCode, district, leaseNo, ours: new Map() }]);
  return slice;
}

interface ProductionRow {
  cycle: string | Date;
  oil_bbl: string | number | null;
  gas_mcf: string | number | null;
}

function num(v: string | number | null): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n !== null ? (n as number) : 0;
}

/**
 * Monthly production for an RRC lease key, oldest first.
 *
 * `rrc.lease_production` is keyed on the composite (oil_gas_code, district_no,
 * lease_no) — the district being PDQ's INTERNAL code, which is what
 * `leases.rrc_district` stores and NOT the label printed on a permit.
 */
export async function monthlyForKey(
  key: {
    oilGasCode: "O" | "G";
    districtNo: string;
    leaseNo: string;
  },
  opts: {
    /**
     * Only the last N cycles. OPT-IN, because most callers need the whole
     * record: the scout lease views roll every year up and reconcile against
     * the monthly rows, and a window here broke both. The fleet-rate path is
     * the caller that wants it (a 14-month EMA whose displayed value is the
     * latest reported month), and on a Timescale hypertable chunked by cycle
     * the bound excludes whole chunks: 0.1-0.8s per record became a few ms.
     */
    sinceMonths?: number;
  } = {}
): Promise<RrcMonth[]> {
  const cacheKey = `${key.oilGasCode}/${key.districtNo}/${key.leaseNo}:${opts.sinceMonths ?? "all"}`;
  const cached = fresh(monthsCache.get(cacheKey));
  if (cached) return cached;
  const pending = monthsInflight.get(cacheKey);
  if (pending) return pending;
  const run = monthlyForKeyUncached(key, opts.sinceMonths)
    .then((months) => {
      monthsCache.set(cacheKey, { at: Date.now(), value: months });
      return months;
    })
    .finally(() => {
      monthsInflight.delete(cacheKey);
    });
  monthsInflight.set(cacheKey, run);
  return run;
}

async function monthlyForKeyUncached(
  key: {
    oilGasCode: "O" | "G";
    districtNo: string;
    leaseNo: string;
  },
  sinceMonths?: number
): Promise<RrcMonth[]> {
  /*
   * Each stream is the SUM of the two columns that can carry it, because which
   * one is populated depends on the lease's type:
   *
   *   oil lease  → liquid in `oil_prod_vol`,  gas in `csgd_prod_vol` (casinghead)
   *   gas lease  → gas in `gas_prod_vol`,     liquid in `cond_prod_vol` (condensate)
   *
   * Reading only oil_prod_vol/gas_prod_vol drops every oil lease's gas and every
   * gas lease's liquid. For operator 786408 that was 257,229 MCF and 26,148 bbl
   * of real production silently missing. Condensate sells as oil and casinghead
   * sells as gas, so summing is what the operator would expect to see.
   *
   * Only one column of each pair is ever populated on a given row, so the sum is
   * never a double count.
   */
  const rows = await rrcQuery<ProductionRow>(
    `select cycle,
            coalesce(oil_prod_vol, 0) + coalesce(cond_prod_vol, 0) as oil_bbl,
            coalesce(gas_prod_vol, 0) + coalesce(csgd_prod_vol, 0) as gas_mcf
       from rrc.lease_production
      where oil_gas_code = $1
        and district_no  = $2
        and lease_no     = $3
        -- Unfiled months store as zero, and a zero that means "not reported yet"
        -- is not a zero that means "made nothing". Texas runs two to three months
        -- behind, so keeping them draws every lease falling off a cliff to zero
        -- at the right-hand edge and makes the latest value 0.00 everywhere.
        and prod_report_filed = 'Y'
        -- Optional recency bound; see monthlyForKey. $4 is null for the whole
        -- record.
        and ($4::int is null or cycle >= (date_trunc('month', current_date) - ($4::int * interval '1 month'))::date)
      order by cycle`,
    [key.oilGasCode, key.districtNo, key.leaseNo, sinceMonths ?? null]
  );
  return rows.map((r) => ({
    cycle: r.cycle instanceof Date ? r.cycle.toISOString() : String(r.cycle),
    oilBbl: num(r.oil_bbl),
    gasMcf: num(r.gas_mcf),
  }));
}

/** The record's own monthly volumes, unsplit. */
export function sliceKey(slice: RecordSlice): {
  oilGasCode: "O" | "G";
  districtNo: string;
  leaseNo: string;
} {
  return {
    oilGasCode: slice.oilGasCode,
    districtNo: slice.pdqDistrict,
    leaseNo: slice.leaseNo,
  };
}

/** The two share tables a record's months are divided by. */
function sharesFor(slice: RecordSlice, months: RrcMonth[]) {
  return sharesForMonths(slice, months.map((m) => m.cycle.slice(0, 7)));
}

/**
 * The oil and gas share tables for a record over the given `YYYY-MM` months.
 *
 * Exposed for callers that carry their OWN row shape and cannot go through
 * `wellMonths`: Scout's dossier reads sixteen measures per lease-month, not the
 * two volumes `RrcMonth` holds, and needs to scale each of them by the share of
 * the stream it belongs to.
 */
export function sharesForMonths(slice: RecordSlice, monthKeys: string[]) {
  return {
    oil: sharesByMonth(slice.wells, slice.tests, monthKeys, "oil"),
    gas: sharesByMonth(slice.wells, slice.tests, monthKeys, "gas"),
  };
}

/**
 * The part of a record's production that belongs to the wells we hold.
 *
 * Unscaled when none of the record's wells are ours, which happens when the key
 * came from a lease's stored RRC number rather than from a well's API. We have no
 * evidence we own less than all of it, and shrinking the chart on no evidence
 * would be worse than the small chance of overstating it.
 */
export async function ownedMonths(slice: RecordSlice): Promise<RrcMonth[]> {
  const months = await monthlyForKey(sliceKey(slice));
  if (slice.ourWellNos.length === 0 || months.length === 0) return months;
  if (slice.ourWellNos.length === slice.wells.length) return months; // all ours
  const { oil, gas } = sharesFor(slice, months);
  return applyShares(
    months,
    ownedShareByMonth(oil, slice.ourWellNos),
    ownedShareByMonth(gas, slice.ourWellNos)
  );
}

/** One record well's share of that record's production, month by month. */
export async function wellMonths(
  slice: RecordSlice,
  wellNo: string
): Promise<RrcMonth[]> {
  return (await wellMonthsBatch(slice, [wellNo])).get(wellNo) ?? [];
}

/**
 * Several wells' shares of one record, reading the record ONCE.
 *
 * A lease's wells all sit on the same record, so asking well by well runs the
 * same production query and rebuilds the same share table for each of them. A
 * 52-well fleet across 28 records is the difference between 28 reads and 52.
 */
export async function wellMonthsBatch(
  slice: RecordSlice,
  wellNos: string[],
  opts: { sinceMonths?: number } = {}
): Promise<Map<string, RrcMonth[]>> {
  const out = new Map<string, RrcMonth[]>();
  const months = await monthlyForKey(sliceKey(slice), opts);
  if (months.length === 0) {
    for (const wellNo of wellNos) out.set(wellNo, []);
    return out;
  }
  const { oil, gas } = sharesFor(slice, months);
  for (const wellNo of wellNos) {
    out.set(wellNo, monthsForWell(months, oil, gas, wellNo));
  }
  return out;
}

/** Sum monthly volumes from several records into one series, oldest first. */
export function mergeMonths(sets: RrcMonth[][]): RrcMonth[] {
  const byMonth = new Map<string, RrcMonth>();
  for (const months of sets) {
    for (const m of months) {
      const key = m.cycle.slice(0, 7);
      const at = byMonth.get(key);
      if (at) {
        at.oilBbl += m.oilBbl;
        at.gasMcf += m.gasMcf;
      } else {
        byMonth.set(key, { ...m });
      }
    }
  }
  return [...byMonth.values()].sort((a, b) => (a.cycle < b.cycle ? -1 : 1));
}

/** A well's share of the record's most recent reported month, as a daily rate. */
export interface WellRate {
  /** `YYYY-MM` the rate came from. */
  cycle: string;
  oilBblPerDay: number;
  gasMcfPerDay: number;
}

/** Days in the month `YYYY-MM`. */
function daysIn(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Each well's current rate on a record, weighted by well test.
 *
 * The month is the record's most recent one carrying any volume, NOT the newest
 * row: Texas runs two to three months behind and files what it has not collected
 * as zero, so the newest row is normally a zero that means "not yet reported".
 *
 * A service hole gets a zero share from `sharesByMonth` and so reads 0 here,
 * which is correct and is why the caller can show the column for every row.
 */
export async function latestWellRates(
  slice: RecordSlice
): Promise<Map<string, WellRate>> {
  const out = new Map<string, WellRate>();
  const months = await monthlyForKey(sliceKey(slice));
  const last = [...months]
    .reverse()
    .find((m) => m.oilBbl > 0 || m.gasMcf > 0);
  if (!last) return out;

  const cycle = last.cycle.slice(0, 7);
  const { oil, gas } = sharesForMonths(slice, [cycle]);
  const days = daysIn(cycle);
  for (const well of slice.wells) {
    out.set(well.wellNo, {
      cycle,
      oilBblPerDay: (last.oilBbl * (oil.get(cycle)?.get(well.wellNo) ?? 0)) / days,
      gasMcfPerDay: (last.gasMcf * (gas.get(cycle)?.get(well.wellNo) ?? 0)) / days,
    });
  }
  return out;
}
