import "server-only";

import { z } from "zod";

import { rrcQuery } from "@/lib/scout/rrc-db";
import { PDQ_TO_RRC, RRC_TO_PDQ } from "@/lib/scout/rrc-districts";
import {
  findDisposal,
  getCycleEdge,
  getLeaseP4,
  getOperatorDisposal,
  getOperatorH15,
  getOperatorNetwork,
  resolveCounty,
} from "@/lib/scout/rrc-queries";
import type { P4Filing } from "@/lib/scout/rrc-types";
import { fitDecline, forward12moDecline, project, type DeclineFit } from "@/lib/wells/arps";
import { daysInCycle, linearFit, mean } from "../math";
import { resolveOfficerNames, type OfficerMatch } from "../people";
import { dailyRate } from "../series";
import { defineTool, type RrcTool } from "../tool";

/**
 * Acquisition screening over the Texas public record: which leases and wells
 * are worth buying, and what the record already says about a package before
 * anyone talks to the seller.
 *
 * Five rules run through every tool in this file. Each one is a wrong answer
 * waiting to happen, and each one is attached to the RESULT rather than left in
 * a comment, because a reader who does not have it cannot catch the error.
 *
 *  1. NO PRICES, NO VALUATION, NO ECONOMICS. The RRC publishes volumes,
 *     filings and permits. It publishes no price, no cost, no working interest
 *     and no consideration on a transfer. Every tool here reads nothing but the
 *     RRC, so anything that would come out as a purchase price, a payout period
 *     or a cost per barrel is REFUSED rather than guessed.
 *     `rrc_package_value_drivers` sizes a package and says so in its own output.
 *  2. NO OWNERSHIP. The record shows OPERATORS, the party the state holds
 *     responsible. Working interest, royalty and mineral title appear nowhere in
 *     it, and no arithmetic over these tables recovers them.
 *  3. NO ACREAGE BOUNDARIES. The RRC publishes no lease outlines, so
 *     `rrc_bolt_on` works on land-grant SURVEY tracts, which contain the lease
 *     and are larger than it. That caveat rides on every bolt-on result.
 *  4. THE RECORD RUNS BEHIND. Production is about three cycles late and unfiled
 *     cycles sit in the mirror as zeros; H-10 injection runs about a year late.
 *     Every window here ends at the RRC's published edge, never at today.
 *  5. EVERY SCREEN IS BOUNDED. `rrc.lease_production` is 78.6M rows and
 *     `rrc.county_lease_cycle` 76.5M behind a 5 second statement timeout, so a
 *     screen with no narrowing filter is refused, not attempted. No caller
 *     string is ever interpolated into SQL: fragments are literals in this file
 *     and every value is bound.
 */

// ------------------------------------------------------------------- notes

const NO_PRICE =
  "The RRC record carries no prices, costs or consideration, so nothing here is a valuation. What a package is worth needs a price deck, a working interest and an LOE number, none of which are in this data.";

const NO_OWNERSHIP =
  "Operators only. The state record names the party it holds responsible, never the working-interest or royalty owners, so no ownership split can be read out of it.";

const TRACT_CAVEAT =
  "Survey tracts are land grants, not leases. The RRC publishes no lease boundaries, so a shared tract means the two operations sit on the same original grant, which is usually much larger than either lease inside it. Treat every match as a candidate to check on a plat, not as an established offset.";

const LAG_NOTE = (edge: string) =>
  `Production is measured through ${edge}, the last cycle the RRC has published. Later months are unfiled, not idle.`;

const SCHEDULE_NOTE =
  "Well counts are wellbores currently ON SCHEDULE to the operator (on_schedule = 'Y'). That is what the RRC carries against the P-5 today, not everything the operator has ever held.";

// ------------------------------------------------------------------- caps

/** The largest list any tool here sends back. */
const ROW_CAP = 100;
/** Rows pulled out of SQL before the in-memory filters run. */
const CANDIDATE_CAP = 300;
/** Leases that get a real Arps fit in one call. Each is one indexed read. */
const LEASE_FIT_CAP = 20;
/** Operators scored in one call. Each adds a probe to five tables. */
const OPERATOR_CAP = 25;
const MAX_MONTHS = 240;
/** Forward-projection horizon for a remaining-reserves integral, in months. */
const EUR_MONTHS = 600;
const DAYS_PER_MONTH = 365.25 / 12;

// -------------------------------------------------------- distress weights

/**
 * THE DISTRESS WEIGHTS AND FLOORS ARE ASSERTED, NOT FITTED.
 *
 * No backtest produced these. Nothing in this file learned from an outcome, and
 * no study says a rolling-over production curve is one and a half times a
 * lapsing P-5. They encode one judgement: that what actually precedes a sale is
 * the operator running out of barrels first and out of paperwork second, so the
 * production term carries the most weight and the compliance terms fill in
 * behind it.
 *
 * Because they are asserted, `rrc_distress_signal` returns every COMPONENT
 * beside the composite, with its raw value, its weight and its contribution, so
 * a reader who disagrees with the weighting can rescore by hand without
 * rerunning anything. Do not let a caller pass weights in: a score whose
 * weights move per call cannot be compared between two operators, which is the
 * only thing a ranking is for.
 */
const DISTRESS_WEIGHTS = {
  production_rollover: 0.3,
  h15_delinquency: 0.2,
  flags_14b2: 0.2,
  p5_expiry: 0.15,
  state_funded_plugs: 0.15,
} as const;

type DistressComponent = keyof typeof DISTRESS_WEIGHTS;

/**
 * The value at which each component scores a full point. Also asserted.
 *
 * A floor rather than a curve, because a curve would imply a distribution
 * nobody measured. Read each as "this much is as bad as it gets for scoring
 * purposes", never as "this much is the industry norm".
 */
const DISTRESS_FLOORS: Record<DistressComponent, number> = {
  /** Fractional drop in trailing-12 production against the prior twelve. */
  production_rollover: 0.5,
  /** Share of the operator's tested wellbores standing H-15 delinquent. */
  h15_delinquency: 0.25,
  /** Share of the on-schedule fleet under a 14(b)(2) flag. */
  flags_14b2: 0.25,
  /** Months since the last P-5 filing. The renewal cycle is twelve. */
  p5_expiry: 12,
  /** Wells on this operator's schedule the STATE had to plug. */
  state_funded_plugs: 5,
};

/** The P-5 renewal term. One year, per the Commission's own cycle. */
const P5_TERM_MONTHS = 12;
/** Statewide Rule 14(b)(2): a well inactive past this needs an extension. */
const INACTIVE_CLOCK_MONTHS = 12;

/**
 * Wind-down thresholds for `rrc_operator_exit`. Asserted, like the weights.
 *
 * These are a screen, not a finding. An operator can clear all three by selling
 * one good package and keeping the rest, and a good operator with no drilling
 * budget trips the permit test every year.
 */
const EXIT_THRESHOLDS = {
  /** Fractional fall in trailing-12 production that reads as a wind-down. */
  production_drop: 0.25,
  /** Fractional fall in the count of leases reporting production. */
  lease_drop: 0.2,
  /** Permits issued in the trailing twelve months at or below this is "stopped". */
  permits_stopped: 0,
} as const;

/** `rrc_why_selling` triggers. Asserted; see the note on DISTRESS_WEIGHTS. */
const WHY_THRESHOLDS = {
  /** Recent water cut above the earlier mean by this factor is inflecting. */
  water_cut_ratio: 1.25,
  /** Recent GOR above the earlier mean by this factor is blowing out. */
  gor_ratio: 1.25,
  /** Recent-window decline steeper than the whole history by this factor. */
  decline_ratio: 1.25,
  /** Disposal utilisation at or above this is near capacity. */
  disposal_utilisation: 0.8,
  /** A counterparty change inside this many months is recent. */
  counterparty_months: 24,
  /** Months of H-15 due dates that count as "coming due". */
  h15_due_months: 6,
} as const;

/** Inactive years past which an unplugged well reads as orphan risk. */
const ORPHAN_INACTIVE_YEARS = 5;

/** Well types the RRC's own domain calls idle rather than producing. */
const IDLE_WELL_TYPES = [
  "SHUT IN",
  "SHUT IN-MULTI-COMPL",
  "TEMP ABANDONED",
  "NO PRODUCTION",
  "NOT ELIGIBLE FOR ALLOWABLE",
] as const;

// ----------------------------------------------------------------- helpers

function fail(error: string) {
  return { ok: false as const, error };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** 0 to 1, so a component score cannot run off either end. */
function unit(n: number): number {
  return Number.isFinite(n) ? clamp(n, 0, 1) : 0;
}

/**
 * A parameterised where-clause builder.
 *
 * Fragments are literals written in this file; only values ever reach `params`.
 * Each `$?` is rewritten to its real position, so a fragment cannot carry a
 * hardcoded parameter number that goes stale when the caller supplies a
 * different set of filters.
 */
function clauses() {
  const where: string[] = [];
  const params: unknown[] = [];
  return {
    where,
    params,
    add(fragment: string, ...values: unknown[]) {
      let out = fragment;
      for (const value of values) {
        params.push(value);
        out = out.replace("$?", `$${params.length}`);
      }
      where.push(out);
    },
    bind(value: unknown): string {
      params.push(value);
      return `$${params.length}`;
    },
    sql(prefix = "where") {
      return where.length ? `${prefix} ${where.join(" and ")}` : "";
    },
  };
}

const SCOPE_SHAPE = {
  operator_no: z.string().optional(),
  county: z.string().optional(),
  district: z.string().optional(),
};

interface Scope {
  operatorNo: string | null;
  countyNo: string | null;
  countyName: string | null;
  /** The label the wellbore, completion and W-10 tapes use. */
  districtEwa: string | null;
  /** The internal code the production and permit tapes use. */
  districtPdq: string | null;
}

/**
 * At least one narrowing filter, or a refusal.
 *
 * The two district codings are NOT interchangeable and "08" is a real,
 * different district in each, so the caller always says the label a person uses
 * and both forms are carried from here on. See `rrc-districts.ts`.
 */
function resolveScope(args: {
  operator_no?: string;
  county?: string;
  district?: string;
}): Scope | { error: string } {
  const operatorNo = args.operator_no?.trim() || null;

  let countyNo: string | null = null;
  let countyName: string | null = null;
  if (args.county?.trim()) {
    const c = resolveCounty(args.county);
    if (!c) return { error: `Not a Texas county: "${args.county}".` };
    countyNo = c.county_no;
    countyName = c.county_name;
  }

  let districtEwa: string | null = null;
  let districtPdq: string | null = null;
  if (args.district?.trim()) {
    const label = args.district.trim().toUpperCase();
    const pdq = RRC_TO_PDQ[label];
    if (!pdq) {
      return {
        error: `Not an RRC district: "${args.district}". Use the district label: ${Object.keys(RRC_TO_PDQ).join(", ")}.`,
      };
    }
    districtEwa = label;
    districtPdq = pdq;
  }

  if (!operatorNo && !countyNo && !districtEwa) {
    return {
      error:
        "An unfiltered statewide screen is refused: the production tape is 78.6M rows behind a 5 second timeout. Supply at least one of operator_no, county or district.",
    };
  }
  return { operatorNo, countyNo, countyName, districtEwa, districtPdq };
}

function isScopeError(s: Scope | { error: string }): s is { error: string } {
  return "error" in s;
}

interface LeaseKey {
  oil_gas_code: string;
  /** PDQ internal code, as the production tape keys it. */
  district_no: string;
  lease_no: string;
}

const LEASE_KEY_SHAPE = {
  oil_gas_code: z.enum(["O", "G"]).optional(),
  district_no: z.string().optional(),
  lease_no: z.string().optional(),
};

function readLeaseKey(args: {
  oil_gas_code?: string;
  district_no?: string;
  lease_no?: string;
}): LeaseKey | null {
  const { oil_gas_code, district_no, lease_no } = args;
  if (!oil_gas_code || !district_no?.trim() || !lease_no?.trim()) return null;
  return {
    oil_gas_code: oil_gas_code.toUpperCase(),
    district_no: district_no.trim(),
    lease_no: lease_no.trim(),
  };
}

function leaseLabel(k: LeaseKey): string {
  return `${k.oil_gas_code}/${k.district_no}/${k.lease_no}`;
}

/** Three parallel arrays, the shape a composite `in (unnest(...))` needs. */
function keyArrays(keys: readonly LeaseKey[]) {
  return [
    keys.map((k) => k.oil_gas_code),
    keys.map((k) => k.district_no),
    keys.map((k) => k.lease_no),
  ] as const;
}

/** Calendar days in the `months` cycles ending at `edge`, e.g. "2025-06". */
function windowDays(edge: string, months: number): number {
  let days = 0;
  const [y, m] = edge.split("-").map(Number);
  for (let i = 0; i < months; i++) {
    const t = y * 12 + (m - 1) - i;
    days += daysInCycle(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
  }
  return days;
}

interface SeriesRow {
  cycle: string;
  oil: number;
  gas: number;
  cond: number;
  csgd: number;
}

/**
 * One lease's monthly volumes, REPORTED cycles only.
 *
 * Straight off `lp_lease_idx`, and bounded at the published edge rather than
 * filtered afterwards: the unfiled tail is zeros in the mirror, and a fit
 * through it reports a collapse that is not happening.
 */
async function leaseSeries(key: LeaseKey, edge: string): Promise<SeriesRow[]> {
  return rrcQuery<SeriesRow>(
    `select to_char(cycle, 'YYYY-MM')            as cycle,
            coalesce(oil_prod_vol, 0)::bigint    as oil,
            coalesce(gas_prod_vol, 0)::bigint    as gas,
            coalesce(cond_prod_vol, 0)::bigint   as cond,
            coalesce(csgd_prod_vol, 0)::bigint   as csgd
       from rrc.lease_production
      where oil_gas_code = $1 and district_no = $2 and lease_no = $3
        and cycle <= $4::date
      order by cycle`,
    [key.oil_gas_code, key.district_no, key.lease_no, `${edge}-01`]
  );
}

/** A stream as the monthly DAILY-rate series every fit consumes. */
function rates(rows: readonly SeriesRow[], stream: "oil" | "gas") {
  return rows.map((r) => ({ month: r.cycle, rate: dailyRate(r[stream], r.cycle) }));
}

/**
 * Forward integral of a fitted curve from the END of its window, so this is
 * REMAINING reserves and never original EUR.
 */
function remaining(fit: DeclineFit, limit: number) {
  let volume = 0;
  let monthsToLimit: number | null = null;
  for (let k = 1; k <= EUR_MONTHS; k++) {
    const q = project(fit, fit.spanYears + k / 12);
    if (limit > 0 && q < limit) {
      monthsToLimit = k - 1;
      break;
    }
    volume += q * DAYS_PER_MONTH;
  }
  return {
    remaining: volume,
    yearsToLimit: monthsToLimit === null ? null : monthsToLimit / 12,
    horizonYears: EUR_MONTHS / 12,
  };
}

/** The decline read every tool here reports, or null when no fit is legitimate. */
function declineOf(rows: readonly SeriesRow[], stream: "oil" | "gas", economicLimit: number) {
  const series = rates(rows, stream);
  const fit = fitDecline(series);
  if (!fit) {
    const producing = series.filter((r) => r.rate > 0).length;
    return {
      fitted: false as const,
      reason:
        producing < 6
          ? `Only ${producing} reported producing months; a fit needs 6.`
          : "No sustained post-peak decline in the reported window (flat or rising).",
    };
  }
  const r = remaining(fit, economicLimit);
  return {
    fitted: true as const,
    qi: fit.qi,
    Di: fit.Di,
    b: fit.b,
    startMonth: fit.startMonth,
    monthsFitted: fit.months,
    currentRate: project(fit, fit.spanYears),
    declinePctPerYear: forward12moDecline(fit) * 100,
    remaining: r.remaining,
    yearsToLimit: r.yearsToLimit,
  };
}

/** Trailing-12 against prior-12 as a fraction fallen. Null when there is no base. */
function rollover(last12: number, prior12: number): number | null {
  if (!(prior12 > 0)) return null;
  return Math.max(0, 1 - last12 / prior12);
}

/** Today, or the caller's `as_of`, as a UTC calendar date. */
function readDate(iso: string | undefined): { iso: string; ms: number } | null {
  const text = (iso ?? new Date().toISOString().slice(0, 10)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) ? { iso: text, ms } : null;
}

/** Whole days from one calendar date to another. Negative when `to` is past. */
function daysBetween(fromMs: number, toIso: string): number | null {
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(to)) return null;
  return Math.round((to - fromMs) / 86_400_000);
}

/** Add whole months to a calendar date, clamping to the shorter month's end. */
function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/** Slope of a value against MONTHS, from `YYYY-MM` or `YYYY-MM-DD` stamps. */
function trendPerYear(points: readonly { date: string; value: number }[]) {
  const pts = points
    .filter((p) => p.date && Number.isFinite(p.value))
    .map((p) => {
      const [y, m] = p.date.split("-").map(Number);
      return [y * 12 + (m - 1), p.value] as const;
    });
  const fit = linearFit(pts);
  return fit ? { slopePerYear: fit.slope * 12, r2: fit.r2, n: fit.n } : null;
}

/** Wells currently on schedule per operator, the one count these tools use. */
async function fleetCounts(operatorNos: readonly string[]) {
  if (!operatorNos.length) return new Map<string, { wells: number; flagged: number; plugged: number }>();
  const rows = await rrcQuery<{
    operator_number: string;
    wells: number;
    flagged: number;
    plugged: number;
  }>(
    `select operator_number,
            count(distinct api_number)::int                                        as wells,
            count(distinct api_number) filter (where wb_14b2_flag = 'Y')::int      as flagged,
            count(distinct api_number) filter (
              where nullif(plug_date, '') is not null)::int                        as plugged
       from rrc.wellbore
      where operator_number = any($1) and on_schedule = 'Y'
      group by 1`,
    [operatorNos]
  );
  return new Map(rows.map((r) => [r.operator_number.trim(), r]));
}

// ------------------------------------------------------------------- 35

const acquisitionScreen = defineTool(
  "rrc_acquisition_screen",
  "Screen Texas leases inside one county, district or operator by production band, well count, decline rate, operator size and the off-schedule and severance flags.",
  {
    ...SCOPE_SHAPE,
    oil_gas_code: z.enum(["O", "G"]).optional(),
    months: z.number().int().positive().optional(),
    min_bopd: z.number().nonnegative().optional(),
    max_bopd: z.number().nonnegative().optional(),
    min_mcfd: z.number().nonnegative().optional(),
    max_mcfd: z.number().nonnegative().optional(),
    min_wells: z.number().int().nonnegative().optional(),
    max_wells: z.number().int().nonnegative().optional(),
    min_operator_wells: z.number().int().nonnegative().optional(),
    max_operator_wells: z.number().int().nonnegative().optional(),
    off_schedule: z.boolean().optional(),
    severance: z.boolean().optional(),
    max_decline_pct_per_yr: z.number().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const scope = resolveScope(args);
    if (isScopeError(scope)) return fail(scope.error);

    const { reported } = await getCycleEdge();
    if (!reported) return fail("The mirror has no published production cycle.");

    const months = clamp(Math.floor(args.months ?? 12), 1, MAX_MONTHS);
    const limit = clamp(Math.floor(args.limit ?? 25), 1, ROW_CAP);
    const days = windowDays(reported, months);

    // Anchored on the published edge, never on now(): a window running to today
    // ends in unfiled zeros and scores every lease in Texas as collapsing.
    const c = clauses();
    c.add(
      "p.cycle > ($?::date - make_interval(months => $?::int))",
      `${reported}-01`,
      months
    );
    c.add("p.cycle <= $?::date", `${reported}-01`);
    if (scope.countyNo) c.add("p.county_no = $?", scope.countyNo);
    if (scope.districtPdq) c.add("p.district_no = $?", scope.districtPdq);
    if (scope.operatorNo) c.add("p.operator_no = $?", scope.operatorNo);
    if (args.oil_gas_code) c.add("p.oil_gas_code = $?", args.oil_gas_code);

    // The band goes in HAVING as a VOLUME, converted from the caller's rate by
    // the window's own calendar days. Filtering the rate afterwards would let
    // the row cap cut the answer before the band did.
    const having: string[] = [];
    if (args.min_bopd !== undefined) {
      having.push(`sum(coalesce(p.cnty_lse_oil_prod_vol,0)) >= ${c.bind(args.min_bopd * days)}`);
    }
    if (args.max_bopd !== undefined) {
      having.push(`sum(coalesce(p.cnty_lse_oil_prod_vol,0)) <= ${c.bind(args.max_bopd * days)}`);
    }
    if (args.min_mcfd !== undefined) {
      having.push(`sum(coalesce(p.cnty_lse_gas_prod_vol,0)) >= ${c.bind(args.min_mcfd * days)}`);
    }
    if (args.max_mcfd !== undefined) {
      having.push(`sum(coalesce(p.cnty_lse_gas_prod_vol,0)) <= ${c.bind(args.max_mcfd * days)}`);
    }

    const candidates = await rrcQuery<{
      oil_gas_code: string;
      district_no: string;
      lease_no: string;
      lease_name: string | null;
      operator_no: string | null;
      operator_name: string | null;
      county_name: string | null;
      field_name: string | null;
      oil: number;
      gas: number;
    }>(
      `select p.oil_gas_code, p.district_no, p.lease_no,
              max(p.lease_name)    as lease_name,
              max(p.operator_no)   as operator_no,
              max(p.operator_name) as operator_name,
              max(p.county_name)   as county_name,
              max(p.field_name)    as field_name,
              coalesce(sum(p.cnty_lse_oil_prod_vol), 0)::bigint as oil,
              coalesce(sum(p.cnty_lse_gas_prod_vol), 0)::bigint as gas
         from rrc.county_lease_cycle p
        ${c.sql()}
        group by 1, 2, 3
        ${having.length ? `having ${having.join(" and ")}` : ""}
        order by oil desc nulls last, gas desc nulls last
        limit ${c.bind(CANDIDATE_CAP)}`,
      c.params
    );

    if (!candidates.length) {
      return {
        ok: true as const,
        window: { months, through: reported, days },
        reported_through: reported,
        candidates_considered: 0,
        leases: [],
        truncated: false,
        notes: [LAG_NOTE(reported), NO_PRICE, NO_OWNERSHIP],
      };
    }

    const keys: LeaseKey[] = candidates.map((r) => ({
      oil_gas_code: r.oil_gas_code,
      district_no: r.district_no,
      lease_no: r.lease_no,
    }));
    const [okc, dkc, lkc] = keyArrays(keys);
    // The wellbore tape keys on the district LABEL, the production tape on the
    // internal code. Translating here, not in SQL, keeps the map in one place.
    const ewa = keys.map((k) => PDQ_TO_RRC[k.district_no] ?? k.district_no);
    const operatorNos = [...new Set(candidates.map((r) => r.operator_no?.trim()).filter((s): s is string => !!s))];

    const [wellRows, flagRows, fleets] = await Promise.all([
      rrcQuery<{ oil_gas_code: string; district: string; lease_number: string; wells: number }>(
        `select w.oil_gas_code, w.district, w.lease_number,
                count(distinct w.api_number)::int as wells
           from rrc.wellbore w
          where w.on_schedule = 'Y'
            and (w.oil_gas_code, w.district, w.lease_number)
                in (select * from unnest($1::text[], $2::text[], $3::text[]))
          group by 1, 2, 3`,
        [okc, ewa, lkc]
      ),
      rrcQuery<{
        oil_gas_code: string;
        district_no: string;
        lease_no: string;
        off_schedule: string | null;
        severance: string | null;
      }>(
        `select oil_gas_code, district_no, lease_no,
                lease_off_sched_flag as off_schedule,
                lease_severance_flag as severance
           from rrc.regulatory_lease
          where (oil_gas_code, district_no, lease_no)
                in (select * from unnest($1::text[], $2::text[], $3::text[]))`,
        [okc, dkc, lkc]
      ),
      fleetCounts(operatorNos),
    ]);

    const wellsBy = new Map(
      wellRows.map((r) => [`${r.oil_gas_code}/${r.district.trim()}/${r.lease_number.trim()}`, r.wells])
    );
    const flagsBy = new Map(
      flagRows.map((r) => [`${r.oil_gas_code}/${r.district_no}/${r.lease_no}`, r])
    );

    let rows = candidates.map((r, i) => {
      const key = keys[i];
      const flags = flagsBy.get(leaseLabel(key));
      const operatorNo = r.operator_no?.trim() ?? null;
      return {
        key: leaseLabel(key),
        oil_gas_code: key.oil_gas_code,
        district_no: key.district_no,
        district: PDQ_TO_RRC[key.district_no] ?? key.district_no,
        lease_no: key.lease_no,
        lease_name: r.lease_name,
        field_name: r.field_name,
        county_name: r.county_name,
        operator_no: operatorNo,
        operator_name: r.operator_name,
        oil_bbl: r.oil,
        gas_mcf: r.gas,
        bopd: r.oil / days,
        mcfd: r.gas / days,
        wells: wellsBy.get(`${key.oil_gas_code}/${ewa[i]}/${key.lease_no}`) ?? 0,
        operator_wells: operatorNo ? fleets.get(operatorNo)?.wells ?? null : null,
        off_schedule: flags?.off_schedule === "Y",
        severance: flags?.severance === "Y",
        decline: null as ReturnType<typeof declineOf> | null,
      };
    });

    const keep = (n: number | null, lo?: number, hi?: number) =>
      n === null ? lo === undefined && hi === undefined : (lo === undefined || n >= lo) && (hi === undefined || n <= hi);

    rows = rows.filter(
      (r) =>
        keep(r.wells, args.min_wells, args.max_wells) &&
        keep(r.operator_wells, args.min_operator_wells, args.max_operator_wells) &&
        (args.off_schedule === undefined || r.off_schedule === args.off_schedule) &&
        (args.severance === undefined || r.severance === args.severance)
    );

    // The fit is the expensive part: one indexed read per lease. Only asked for
    // when the caller filters on it, and only over the leases that would have
    // been returned anyway.
    let fittedCount = 0;
    if (args.max_decline_pct_per_yr !== undefined) {
      const head = rows.slice(0, Math.min(LEASE_FIT_CAP, Math.max(limit, 1) * 2));
      const fits = await Promise.all(
        head.map((r) =>
          leaseSeries(
            { oil_gas_code: r.oil_gas_code, district_no: r.district_no, lease_no: r.lease_no },
            reported
          ).then((s) => declineOf(s, "oil", 0))
        )
      );
      head.forEach((r, i) => {
        r.decline = fits[i];
      });
      fittedCount = head.length;
      rows = head.filter(
        (r) =>
          r.decline?.fitted === true &&
          r.decline.declinePctPerYear <= args.max_decline_pct_per_yr!
      );
    }

    return {
      ok: true as const,
      scope: {
        operator_no: scope.operatorNo,
        county: scope.countyName,
        district: scope.districtEwa,
        oil_gas_code: args.oil_gas_code ?? null,
      },
      window: { months, through: reported, days },
      reported_through: reported,
      candidates_considered: candidates.length,
      leases_fitted: fittedCount,
      leases: rows.slice(0, limit),
      truncated: rows.length > limit || candidates.length >= CANDIDATE_CAP,
      notes: [
        LAG_NOTE(reported),
        `bopd and mcfd are the window's volume over its ${days} calendar days, not a current rate. A lease that came on halfway through the window reads low.`,
        SCHEDULE_NOTE,
        args.max_decline_pct_per_yr === undefined
          ? "No decline filter was given, so no curve was fitted. Supply max_decline_pct_per_yr to fit, or call rrc_decline on a single lease."
          : `The decline filter fitted the top ${fittedCount} candidates by production only, so a shallow-declining lease further down the list is not here. Raise limit to widen the fit.`,
        scope.countyNo
          ? "Volumes are the RRC's county-by-lease grain and a county filter is applied, so a lease straddling a county line reports only its share inside this county."
          : "Volumes are the RRC's county-by-lease grain, summed back to the lease across every county it touches.",
        NO_PRICE,
        NO_OWNERSHIP,
      ],
    };
  }
);

// ------------------------------------------------------------------- 36

/** Operators in a county or district, biggest first. Bounded like every screen. */
async function scopeOperators(scope: Scope, edge: string, months: number, cap: number) {
  const c = clauses();
  c.add("p.cycle > ($?::date - make_interval(months => $?::int))", `${edge}-01`, months);
  c.add("p.cycle <= $?::date", `${edge}-01`);
  if (scope.countyNo) c.add("p.county_no = $?", scope.countyNo);
  if (scope.districtPdq) c.add("p.district_no = $?", scope.districtPdq);
  const rows = await rrcQuery<{ operator_no: string; oil: number }>(
    `select p.operator_no,
            coalesce(sum(p.cnty_lse_oil_prod_vol), 0)::bigint as oil
       from rrc.county_lease_cycle p
      ${c.sql()}
        and nullif(p.operator_no, '') is not null
      group by 1
      order by oil desc nulls last
      limit ${c.bind(cap)}`,
    c.params
  );
  return rows.map((r) => r.operator_no.trim());
}

/** Latest H-15 status per wellbore as of a date, counted per operator. */
async function h15Position(operatorNos: readonly string[], asOf: string) {
  const rows = await rrcQuery<{ operator_no: string; wells: number; delinquent: number }>(
    `with latest as (
       select distinct on (operator_no, api_number)
              operator_no, api_number, status
         from rrc.wb_h15
        where operator_no = any($1) and test_date <= $2::date
        order by operator_no, api_number, test_date desc nulls last,
                 status_date desc nulls last
     )
     select operator_no,
            count(*)::int                             as wells,
            count(*) filter (where status = 'D')::int as delinquent
       from latest group by 1`,
    [operatorNos, asOf]
  );
  return new Map(rows.map((r) => [r.operator_no.trim(), r]));
}

const distressSignal = defineTool(
  "rrc_distress_signal",
  "Rank operators on the combination that precedes a sale: production rolling over, H-15 delinquency, 14(b)(2) flags, a P-5 near expiry and state-funded plugs, with every weighted component returned beside the score.",
  {
    ...SCOPE_SHAPE,
    operators: z.array(z.string()).optional(),
    months: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const explicit = (args.operators ?? []).map((s) => s.trim()).filter(Boolean);
    const scope = resolveScope(args);
    if (!explicit.length && isScopeError(scope)) return fail(scope.error);

    const { reported } = await getCycleEdge();
    if (!reported) return fail("The mirror has no published production cycle.");
    const months = clamp(Math.floor(args.months ?? 12), 1, 60);
    const limit = clamp(Math.floor(args.limit ?? 25), 1, ROW_CAP);

    const operatorNos = explicit.length
      ? explicit.slice(0, OPERATOR_CAP)
      : await scopeOperators(scope as Scope, reported, months, OPERATOR_CAP);
    if (!operatorNos.length) return fail("No operator matched that scope.");

    const asOf = `${reported}-01`;
    const [production, records, fleets, h15Now, h15Then, statePlugs] = await Promise.all([
      rrcQuery<{ operator_no: string; last12: number; prior12: number }>(
        `select operator_no,
                coalesce(sum(oil_prod_vol) filter (
                  where cycle > $2::date - interval '12 months'), 0)::bigint as last12,
                coalesce(sum(oil_prod_vol) filter (
                  where cycle <= $2::date - interval '12 months'), 0)::bigint as prior12
           from rrc.operator_production
          where operator_no = any($1)
            and cycle >  $2::date - interval '24 months'
            and cycle <= $2::date
          group by 1`,
        [operatorNos, asOf]
      ),
      rrcQuery<{
        operator_number: string;
        operator_name: string | null;
        p5_status: string | null;
        last_p5_date: string | null;
      }>(
        `select operator_number, operator_name, p5_status,
                to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
           from rrc.operators where operator_number = any($1)`,
        [operatorNos]
      ),
      fleetCounts(operatorNos),
      h15Position(operatorNos, asOf),
      h15Position(operatorNos, `${addMonthsIso(asOf, -12)}`),
      rrcQuery<{ operator_number: string; state_plugs: number }>(
        `select w.operator_number, count(distinct p.api_number)::int as state_plugs
           from rrc.wellbore w
           join rrc.wb_plug p on p.api_number = w.api_number
          where w.operator_number = any($1) and w.on_schedule = 'Y'
            and p.state_funded_plug_no is not null
          group by 1`,
        [operatorNos]
      ),
    ]);

    const prodBy = new Map(production.map((r) => [r.operator_no.trim(), r]));
    const recBy = new Map(records.map((r) => [r.operator_number.trim(), r]));
    const plugBy = new Map(statePlugs.map((r) => [r.operator_number.trim(), r.state_plugs]));

    const scored = operatorNos.map((no) => {
      const prod = prodBy.get(no);
      const rec = recBy.get(no);
      const fleet = fleets.get(no);
      const now = h15Now.get(no);
      const then = h15Then.get(no);
      const plugs = plugBy.get(no) ?? 0;

      const drop = prod ? rollover(prod.last12, prod.prior12) : null;
      const delinquentShare = now && now.wells > 0 ? now.delinquent / now.wells : null;
      const thenShare = then && then.wells > 0 ? then.delinquent / then.wells : null;
      const flaggedShare = fleet && fleet.wells > 0 ? fleet.flagged / fleet.wells : null;
      // Months since the last P-5. An operator whose status letter is already
      // off 'A' is past the point the clock was measuring, so it scores full.
      const monthsSinceP5 =
        rec?.last_p5_date !== null && rec?.last_p5_date !== undefined
          ? (() => {
              const days = daysBetween(Date.parse(`${rec.last_p5_date}T00:00:00Z`), reported + "-01");
              return days === null ? null : days / 30.4375;
            })()
          : null;

      const raw: Record<DistressComponent, number | null> = {
        production_rollover: drop,
        h15_delinquency: delinquentShare,
        flags_14b2: flaggedShare,
        p5_expiry: rec && rec.p5_status !== "A" ? DISTRESS_FLOORS.p5_expiry : monthsSinceP5,
        state_funded_plugs: plugs,
      };

      const components = (Object.keys(DISTRESS_WEIGHTS) as DistressComponent[]).map((name) => {
        const value = raw[name];
        // A component with no data scores zero rather than dragging the
        // composite: an operator the H-15 tape has never seen is not thereby
        // healthy, and `measured` says which way to read it.
        const score = value === null ? 0 : unit(value / DISTRESS_FLOORS[name]);
        return {
          component: name,
          measured: value !== null,
          value,
          floor: DISTRESS_FLOORS[name],
          weight: DISTRESS_WEIGHTS[name],
          score,
          contribution: score * DISTRESS_WEIGHTS[name],
        };
      });

      return {
        operator_no: no,
        operator_name: rec?.operator_name ?? null,
        p5_status: rec?.p5_status ?? null,
        last_p5_date: rec?.last_p5_date ?? null,
        wells_on_schedule: fleet?.wells ?? null,
        score: components.reduce((a, c) => a + c.contribution, 0),
        components,
        evidence: {
          oil_last12_bbl: prod?.last12 ?? null,
          oil_prior12_bbl: prod?.prior12 ?? null,
          h15_wells: now?.wells ?? null,
          h15_delinquent: now?.delinquent ?? null,
          h15_delinquent_share: delinquentShare,
          // Reported, NOT scored. A quarter of the fleet delinquent costs a
          // buyer the same whether it got there this year or five years ago;
          // the direction is context for the conversation, not a second term.
          h15_delinquent_share_a_year_ago: thenShare,
          h15_delinquent_share_change:
            delinquentShare !== null && thenShare !== null ? delinquentShare - thenShare : null,
          wells_flagged_14b2: fleet?.flagged ?? null,
          wells_plugged: fleet?.plugged ?? null,
          state_funded_plugs: plugs,
          months_since_p5_filing: monthsSinceP5,
        },
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return {
      ok: true as const,
      reported_through: reported,
      weights: DISTRESS_WEIGHTS,
      floors: DISTRESS_FLOORS,
      operators_scored: scored.length,
      operators: scored.slice(0, limit),
      truncated: scored.length > limit || operatorNos.length >= OPERATOR_CAP,
      notes: [
        "The weights and floors are ASSERTED, not fitted. No backtest produced them. Every component is returned with its value, weight and contribution so the ranking can be rebuilt by hand under a different weighting.",
        "A high score is a reason to look, never a finding. Distress and a willingness to sell are different things, and the record shows neither directly.",
        "14(b)(2) flags are a SNAPSHOT: the wellbore tape carries the current flag with no history, so this is the level of flagging, not its rate of change.",
        LAG_NOTE(reported),
        SCHEDULE_NOTE,
        NO_PRICE,
      ],
    };
  }
);

// ------------------------------------------------------------------- 37

const idleWithReserves = defineTool(
  "rrc_idle_with_reserves",
  "Shut-in, temporarily abandoned and no-production wells whose lease decline curve still shows meaningful remaining reserves.",
  {
    ...SCOPE_SHAPE,
    min_inactive_years: z.number().nonnegative().optional(),
    economic_limit: z.number().nonnegative().optional(),
    min_remaining_bbl: z.number().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const scope = resolveScope(args);
    if (isScopeError(scope)) return fail(scope.error);
    const { reported } = await getCycleEdge();
    if (!reported) return fail("The mirror has no published production cycle.");

    const limit = clamp(Math.floor(args.limit ?? 25), 1, ROW_CAP);
    const economicLimit = args.economic_limit ?? 0;

    const c = clauses();
    c.add("w.on_schedule = 'Y'");
    c.add("nullif(w.plug_date, '') is null");
    c.add("w.well_type_name = any($?)", [...IDLE_WELL_TYPES]);
    if (scope.operatorNo) c.add("w.operator_number = $?", scope.operatorNo);
    if (scope.countyNo) c.add("w.county_code = $?", scope.countyNo);
    if (scope.districtEwa) c.add("w.district = $?", scope.districtEwa);
    if (args.min_inactive_years !== undefined) {
      c.add(
        "coalesce(nullif(w.curr_inact_yrs,'')::int, 0) + coalesce(nullif(w.curr_inact_mos,'')::int, 0) / 12.0 >= $?",
        args.min_inactive_years
      );
    }

    const wells = await rrcQuery<{
      api_number: string;
      well_no: string | null;
      lease_name: string | null;
      lease_number: string | null;
      oil_gas_code: string | null;
      district: string | null;
      county_name: string | null;
      operator_number: string | null;
      operator_name: string | null;
      well_type_name: string | null;
      inact_yrs: number | null;
      inact_mos: number | null;
      flagged: boolean;
    }>(
      `select distinct on (w.api_number)
              w.api_number, w.well_no, w.lease_name, w.lease_number, w.oil_gas_code,
              w.district, w.county_name, w.operator_number, w.operator_name,
              w.well_type_name,
              nullif(w.curr_inact_yrs, '')::int as inact_yrs,
              nullif(w.curr_inact_mos, '')::int as inact_mos,
              w.wb_14b2_flag = 'Y'              as flagged
         from rrc.wellbore w
        ${c.sql()}
        order by w.api_number
        limit ${c.bind(CANDIDATE_CAP)}`,
      c.params
    );
    if (!wells.length) {
      return {
        ok: true as const,
        reported_through: reported,
        idle_wells: 0,
        leases: [],
        truncated: false,
        notes: [LAG_NOTE(reported), NO_PRICE],
      };
    }

    // Grouped onto the LEASE because that is the only grain Texas publishes
    // volumes at. A per-well curve does not exist in this record.
    const groups = new Map<string, { key: LeaseKey; wells: typeof wells; label: string | null }>();
    for (const w of wells) {
      const district = w.district?.trim();
      const leaseNo = w.lease_number?.trim();
      if (!w.oil_gas_code || !district || !leaseNo) continue;
      const key: LeaseKey = {
        oil_gas_code: w.oil_gas_code,
        district_no: RRC_TO_PDQ[district] ?? district,
        lease_no: leaseNo,
      };
      const id = leaseLabel(key);
      const found = groups.get(id) ?? { key, wells: [] as typeof wells, label: w.lease_name };
      found.wells.push(w);
      groups.set(id, found);
    }

    const heads = [...groups.values()].slice(0, LEASE_FIT_CAP);
    const fitted = await Promise.all(
      heads.map(async (g) => {
        const series = await leaseSeries(g.key, reported);
        const decline = declineOf(series, "oil", economicLimit);
        const last = series.slice(-3);
        return {
          key: leaseLabel(g.key),
          lease_name: g.label,
          district: PDQ_TO_RRC[g.key.district_no] ?? g.key.district_no,
          operator_no: g.wells[0]?.operator_number?.trim() ?? null,
          operator_name: g.wells[0]?.operator_name ?? null,
          county_name: g.wells[0]?.county_name ?? null,
          idle_wells: g.wells.length,
          lease_bopd_last3: last.length ? mean(last.map((r) => dailyRate(r.oil, r.cycle))) : null,
          reported_months: series.length,
          decline,
          remaining_bbl: decline.fitted ? decline.remaining : null,
          wells: g.wells.map((w) => ({
            api_number: w.api_number.trim(),
            well_no: w.well_no,
            well_type: w.well_type_name,
            inactive_years: w.inact_yrs,
            inactive_months: w.inact_mos,
            flagged_14b2: w.flagged,
            past_14b2_clock:
              (w.inact_yrs ?? 0) * 12 + (w.inact_mos ?? 0) > INACTIVE_CLOCK_MONTHS,
          })),
        };
      })
    );

    const min = args.min_remaining_bbl ?? 0;
    const kept = fitted
      .filter((f) => f.remaining_bbl !== null && f.remaining_bbl >= min)
      .sort((a, b) => (b.remaining_bbl ?? 0) - (a.remaining_bbl ?? 0));

    return {
      ok: true as const,
      scope: {
        operator_no: scope.operatorNo,
        county: scope.countyName,
        district: scope.districtEwa,
      },
      reported_through: reported,
      economic_limit_bopd: economicLimit,
      idle_wells: wells.length,
      leases_found: groups.size,
      leases_fitted: heads.length,
      leases: kept.slice(0, limit),
      unfitted: fitted
        .filter((f) => f.remaining_bbl === null)
        .map((f) => ({ key: f.key, reason: f.decline.fitted ? null : f.decline.reason })),
      truncated: kept.length > limit || groups.size > heads.length || wells.length >= CANDIDATE_CAP,
      notes: [
        "REMAINING RESERVES ARE THE LEASE'S, NOT THE IDLE WELL'S. Texas publishes oil and gas by lease, so no per-well curve exists. What this finds is an idle wellbore sitting on a lease whose curve has not run out, which is a restart candidate to check, not a volume that well will make.",
        "The curve is fitted from the lease's reported history, which already includes whatever these wells stopped contributing. If the idle wells were the lease, the fit sees their loss and the remaining number is small on purpose.",
        `Idle means the RRC's own well_type_name is one of: ${IDLE_WELL_TYPES.join(", ")}. Plugged wells are excluded; see rrc_reentry_screen for those.`,
        `A well inactive past ${INACTIVE_CLOCK_MONTHS} months is on the Statewide Rule 14(b)(2) clock and needs an extension to stay unplugged. That is a cost to inherit, not a free option.`,
        LAG_NOTE(reported),
        NO_PRICE,
      ],
    };
  }
);

// ------------------------------------------------------------------- 38

const reentryScreen = defineTool(
  "rrc_reentry_screen",
  "What did they leave behind when they plugged these holes? Ranks plugged wellbores by perforated feet above the shallowest plug, formations logged but never perforated, and the cement on the job.",
  {
    ...SCOPE_SHAPE,
    min_perf_ft_above_plug: z.number().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const scope = resolveScope(args);
    if (isScopeError(scope)) return fail(scope.error);
    const limit = clamp(Math.floor(args.limit ?? 25), 1, ROW_CAP);

    const c = clauses();
    c.add("w.on_schedule = 'Y'");
    c.add("nullif(w.plug_date, '') is not null");
    if (scope.operatorNo) c.add("w.operator_number = $?", scope.operatorNo);
    if (scope.countyNo) c.add("w.county_code = $?", scope.countyNo);
    if (scope.districtEwa) c.add("w.district = $?", scope.districtEwa);

    const wells = await rrcQuery<{
      api_number: string;
      well_no: string | null;
      lease_name: string | null;
      county_name: string | null;
      field_name: string | null;
      operator_number: string | null;
      operator_name: string | null;
      api_depth: number | null;
    }>(
      `select distinct on (w.api_number)
              w.api_number, w.well_no, w.lease_name, w.county_name, w.field_name,
              w.operator_number, w.operator_name,
              nullif(w.api_depth, '')::bigint as api_depth
         from rrc.wellbore w
        ${c.sql()}
        order by w.api_number
        limit ${c.bind(ROW_CAP)}`,
      c.params
    );
    if (!wells.length) {
      return {
        ok: true as const,
        wells_examined: 0,
        wells: [],
        truncated: false,
        notes: [TRACT_CAVEAT, NO_PRICE],
      };
    }

    const apis = wells.map((w) => w.api_number.trim());
    const [plugs, perfs, formations] = await Promise.all([
      rrcQuery<{
        api_number: string;
        plug_date: string | null;
        total_depth: number | null;
        shallowest_plug_top: number | null;
        plugs: number | null;
        cement_sacks: number | null;
        state_funded: boolean;
      }>(
        `select distinct on (api_number)
                api_number, to_char(plug_date, 'YYYY-MM-DD') as plug_date,
                total_depth, shallowest_plug_top, plugs, cement_sacks, state_funded
           from rrc.wb_plug_summary
          where api_number = any($1)
          order by api_number, plug_date desc nulls last`,
        [apis]
      ),
      rrcQuery<{ api_number: string; top_ft: number | null; bottom_ft: number | null }>(
        `select api_number, top_ft, bottom_ft
           from rrc.wb_perf
          where api_number = any($1) and top_ft > 0
          order by api_number, top_ft`,
        [apis]
      ),
      // Formation tops come off the completion filing, keyed api_no. Depth is
      // TEXT on this tape, so it is cast here and a row that will not cast is
      // dropped rather than read as zero feet.
      rrcQuery<{ api_no: string; formation: string | null; depth: number | null }>(
        `select c.api_no, f.formation,
                nullif(regexp_replace(f.depth, '[^0-9]', '', 'g'), '')::bigint as depth
           from rrc.completion c
           join rrc.completion_formation f on f.tracking_no = c.tracking_no
          where c.api_no = any($1)`,
        [apis]
      ),
    ]);

    const plugBy = new Map(plugs.map((p) => [p.api_number.trim(), p]));
    const perfBy = new Map<string, { top_ft: number | null; bottom_ft: number | null }[]>();
    for (const p of perfs) {
      const id = p.api_number.trim();
      perfBy.set(id, [...(perfBy.get(id) ?? []), p]);
    }
    const formBy = new Map<string, { formation: string | null; depth: number | null }[]>();
    for (const f of formations) {
      const id = f.api_no.trim();
      formBy.set(id, [...(formBy.get(id) ?? []), f]);
    }

    const scored = wells.map((w) => {
      const id = w.api_number.trim();
      const plug = plugBy.get(id) ?? null;
      const wellPerfs = perfBy.get(id) ?? [];
      const forms = formBy.get(id) ?? [];
      const plugTop = plug?.shallowest_plug_top ?? null;

      // Feet of perforation ABOVE the shallowest plug: the interval a re-entry
      // would be drilling back down to, already shot once.
      let perfFtAbovePlug = 0;
      let perfsAbovePlug = 0;
      for (const p of wellPerfs) {
        if (p.top_ft == null || p.bottom_ft == null || p.bottom_ft <= p.top_ft) continue;
        const cut = plugTop == null ? p.bottom_ft : Math.min(p.bottom_ft, plugTop);
        if (cut > p.top_ft) {
          perfFtAbovePlug += cut - p.top_ft;
          perfsAbovePlug++;
        }
      }

      // A formation is "never shot" when no filed perforation interval covers
      // its top. Blunt, and it is the whole point: what got logged and left.
      const unshot = forms.filter(
        (f) =>
          f.depth != null &&
          f.depth > 0 &&
          !wellPerfs.some(
            (p) => p.top_ft != null && p.bottom_ft != null && f.depth! >= p.top_ft && f.depth! <= p.bottom_ft
          )
      );

      return {
        api_number: id,
        well_no: w.well_no,
        lease_name: w.lease_name,
        field_name: w.field_name,
        county_name: w.county_name,
        operator_no: w.operator_number?.trim() ?? null,
        operator_name: w.operator_name,
        plug_date: plug?.plug_date ?? null,
        state_funded_plug: plug?.state_funded ?? null,
        total_depth_ft: plug?.total_depth ?? w.api_depth,
        shallowest_plug_top_ft: plugTop,
        plugs_set: plug?.plugs ?? null,
        cement_sacks: plug?.cement_sacks ?? null,
        // Sacks per plug is the only cement quality number the W-3 gives. A
        // low figure is a thin job, which is a re-entry easier to drill and a
        // liability harder to defend. It is not a bond log.
        cement_sacks_per_plug:
          plug?.cement_sacks != null && plug?.plugs ? plug.cement_sacks / plug.plugs : null,
        perf_intervals: wellPerfs.length,
        perfs_above_plug: perfsAbovePlug,
        perf_ft_above_plug: perfFtAbovePlug,
        formations_logged: forms.length,
        formations_never_perforated: unshot.length,
        formations: unshot
          .slice(0, 20)
          .map((f) => ({ formation: f.formation, depth_ft: f.depth })),
      };
    });

    const min = args.min_perf_ft_above_plug ?? 0;
    const kept = scored
      .filter((s) => s.perf_ft_above_plug >= min)
      .sort(
        (a, b) =>
          b.perf_ft_above_plug - a.perf_ft_above_plug ||
          b.formations_never_perforated - a.formations_never_perforated
      );

    return {
      ok: true as const,
      scope: {
        operator_no: scope.operatorNo,
        county: scope.countyName,
        district: scope.districtEwa,
      },
      wells_examined: wells.length,
      wells: kept.slice(0, limit),
      truncated: kept.length > limit || wells.length >= ROW_CAP,
      notes: [
        "Ranked by what the FILINGS say was left, not by what is producible. Perforated feet above the shallowest plug means an interval was open once and is now behind cement; whether it still has pressure, and whether the casing is worth re-entering, this record cannot say.",
        "'Never perforated' compares completion-report formation tops against filed perforation intervals on the same hole. A formation shot under a filing that never reached the tape reads as unshot here.",
        "Perforations belong to a FILING, not to a well, so a recompleted hole has several sets and all of them are counted.",
        "The RRC does not publish plugging costs, so nothing here says what a re-entry would take.",
        NO_PRICE,
        NO_OWNERSHIP,
      ],
    };
  }
);

// ------------------------------------------------------------------- 39

const boltOn = defineTool(
  "rrc_bolt_on",
  "Leases sharing a land-grant survey tract with one operator's wells, or sitting on a neighbouring tract, ranked by recent production.",
  {
    operator_no: z.string(),
    include_adjacent: z.boolean().optional(),
    months: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const operatorNo = args.operator_no.trim();
    if (!operatorNo) return fail("operator_no is required.");
    const { reported } = await getCycleEdge();
    if (!reported) return fail("The mirror has no published production cycle.");
    const months = clamp(Math.floor(args.months ?? 12), 1, MAX_MONTHS);
    const limit = clamp(Math.floor(args.limit ?? 25), 1, ROW_CAP);
    const days = windowDays(reported, months);

    /*
     * Tract membership is a BOUNDING BOX test, in three steps and one query:
     * the tracts whose box holds one of this operator's wells, optionally the
     * tracts whose box touches those, then everyone else's wells inside them.
     *
     * A box, not the polygon: the mirror carries the tract geometry as GeoJSON
     * text with the box beside it in core's `box` type, and the box is what is
     * GiST-indexed. On an irregular grant that is looser than the outline, so
     * this is a screening test, which is what it is labelled as.
     */
    const rows = await rrcQuery<{
      oil_gas_code: string | null;
      district: string | null;
      lease_number: string | null;
      lease_name: string | null;
      operator_number: string | null;
      operator_name: string | null;
      survey_name: string | null;
      block_number: string | null;
      abstract_label: string | null;
      shared: boolean;
      wells: number;
    }>(
      `with mine as (
         select sp.objectid, sp.bbox, sp.survey_name, sp.block_number, sp.abstract_label
           from rrc.survey_polygon sp
          where exists (
            select 1
              from rrc.wellbore w
              join rrc.well_location l on l.api_number = w.api_number
             where w.operator_number = $1 and w.on_schedule = 'Y'
               and l.lat is not null and l.lon is not null
               and sp.bbox @> point(l.lon, l.lat))
          limit 200
       ),
       tracts as (
         select objectid, bbox, survey_name, block_number, abstract_label, true as shared
           from mine
          union all
         select sp.objectid, sp.bbox, sp.survey_name, sp.block_number, sp.abstract_label, false
           from rrc.survey_polygon sp
          where $2::boolean
            and exists (select 1 from mine m where sp.bbox && m.bbox)
            and not exists (select 1 from mine m where m.objectid = sp.objectid)
          limit 600
       ),
       hits as (
         select distinct on (t.objectid, w.api_number)
                t.survey_name, t.block_number, t.abstract_label, t.shared,
                w.api_number, w.oil_gas_code, w.district, w.lease_number,
                w.lease_name, w.operator_number, w.operator_name
           from tracts t
           join rrc.well_location l
             on l.lon between (t.bbox[1])[0] and (t.bbox[0])[0]
            and l.lat between (t.bbox[1])[1] and (t.bbox[0])[1]
           join rrc.wellbore w
             on w.api_number = l.api_number and w.on_schedule = 'Y'
          where w.operator_number <> $1
            and nullif(w.lease_number, '') is not null
          order by t.objectid, w.api_number
       )
       select oil_gas_code, district, lease_number,
              max(lease_name)      as lease_name,
              max(operator_number) as operator_number,
              max(operator_name)   as operator_name,
              max(survey_name)     as survey_name,
              max(block_number)    as block_number,
              max(abstract_label)  as abstract_label,
              bool_or(shared)      as shared,
              count(*)::int        as wells
         from hits
        group by 1, 2, 3
        order by shared desc, wells desc
        limit $3`,
      [operatorNo, Boolean(args.include_adjacent), CANDIDATE_CAP]
    );

    // Production is measured only for the leases that would be returned: the
    // production tape has no index this candidate set can be probed through in
    // one read, so each is its own indexed lookup and the set has to be small.
    const head = rows.slice(0, Math.min(LEASE_FIT_CAP * 2, limit * 2));
    const measured = await Promise.all(
      head.map(async (r) => {
        const district = r.district?.trim() ?? "";
        const key: LeaseKey = {
          oil_gas_code: r.oil_gas_code ?? "O",
          district_no: RRC_TO_PDQ[district] ?? district,
          lease_no: r.lease_number?.trim() ?? "",
        };
        const series = await leaseSeries(key, reported);
        const window = series.slice(-months);
        return {
          key: leaseLabel(key),
          lease_name: r.lease_name,
          district,
          operator_no: r.operator_number?.trim() ?? null,
          operator_name: r.operator_name,
          survey_name: r.survey_name,
          block_number: r.block_number,
          abstract_label: r.abstract_label,
          relation: r.shared ? ("same_tract" as const) : ("adjacent_tract" as const),
          wells_in_tract: r.wells,
          oil_bbl: window.reduce((a, s) => a + s.oil, 0),
          gas_mcf: window.reduce((a, s) => a + s.gas, 0),
          bopd: window.reduce((a, s) => a + s.oil, 0) / days,
          mcfd: window.reduce((a, s) => a + s.gas, 0) / days,
        };
      })
    );
    measured.sort((a, b) => b.oil_bbl - a.oil_bbl || b.gas_mcf - a.gas_mcf);

    return {
      ok: true as const,
      operator_no: operatorNo,
      include_adjacent: Boolean(args.include_adjacent),
      window: { months, through: reported, days },
      reported_through: reported,
      candidates_found: rows.length,
      leases_measured: measured.length,
      leases: measured.slice(0, limit),
      truncated: rows.length > head.length || rows.length >= CANDIDATE_CAP,
      notes: [
        TRACT_CAVEAT,
        "Tract membership is tested against the tract's BOUNDING BOX, not its outline, so a well just outside an irregular grant can read as inside it. Confirm on a plat before anything depends on it.",
        "Only wells the RRC geocoded take part. A lease whose holes were never given coordinates cannot be placed on a tract and is absent, not absent-from-the-tract.",
        "Adjacency is box overlap between tracts, which includes tracts that merely share a corner.",
        `Candidates are cut to the ${head.length} with the most wells in shared tracts before production is measured, so a small lease deep in the list is not here. Raise limit to widen.`,
        LAG_NOTE(reported),
        NO_OWNERSHIP,
        NO_PRICE,
      ],
    };
  }
);

// ------------------------------------------------------------------- 40

/**
 * Transfers out of a lease's P-4 history.
 *
 * A TRANSFER IS A CHANGE OF OPERATOR BETWEEN CONSECUTIVE FILINGS, never a
 * filing that says it changed the operator. The `chg_operator` flag is set on
 * plenty of filings that name the same operator as the one before, and reading
 * the flag rather than the operator turns routine paperwork into a deal.
 */
function reconstructTransfers(filings: readonly P4Filing[]) {
  const ordered = filings
    .filter((f) => f.effective_date && f.operator_no)
    .sort((a, b) => (a.effective_date! < b.effective_date! ? -1 : 1));

  const transfers: {
    effective_date: string | null;
    approval_date: string | null;
    from_operator_no: string | null;
    from_operator_name: string | null;
    to_operator_no: string | null;
    to_operator_name: string | null;
    changes: string[];
    record_type: string | null;
  }[] = [];

  let prev: P4Filing | null = null;
  for (const f of ordered) {
    if (prev && f.operator_no !== prev.operator_no) {
      transfers.push({
        effective_date: f.effective_date,
        approval_date: f.approval_date,
        from_operator_no: prev.operator_no,
        from_operator_name: prev.operator_name,
        to_operator_no: f.operator_no,
        to_operator_name: f.operator_name,
        changes: f.changes,
        record_type: f.record_type,
      });
    }
    prev = f;
  }
  return transfers;
}

const transactionHistory = defineTool(
  "rrc_transaction_history",
  "Reconstruct lease transfers and counterparty changes from the P-4 filing history, for one lease or for an operator's leases.",
  {
    ...LEASE_KEY_SHAPE,
    operator_no: z.string().optional(),
    leases: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const limit = clamp(Math.floor(args.limit ?? 20), 1, ROW_CAP);
    const single = readLeaseKey(args);
    const listed = (args.leases ?? [])
      .map((s) => /^\s*([OGog])\s*\/\s*([^/]+?)\s*\/\s*([^/]+?)\s*$/.exec(s))
      .filter((m): m is RegExpExecArray => m !== null)
      .map<LeaseKey>((m) => ({
        oil_gas_code: m[1].toUpperCase(),
        district_no: m[2],
        lease_no: m[3],
      }));

    let keys: LeaseKey[] = single ? [single, ...listed] : listed;
    const operatorNo = args.operator_no?.trim() || null;

    if (!keys.length && operatorNo) {
      const { reported } = await getCycleEdge();
      // Off lp_operator_idx and bounded to the recent window: an operator's
      // whole history across 78.6M rows has no index that answers it.
      const found = await rrcQuery<{ oil_gas_code: string; district_no: string; lease_no: string }>(
        `select distinct oil_gas_code, district_no, lease_no
           from rrc.lease_production
          where operator_no = $1
            and cycle > $2::date - interval '24 months'
            and cycle <= $2::date
          limit $3`,
        [operatorNo, `${reported}-01`, limit]
      );
      keys = found;
    }
    if (!keys.length) {
      return fail(
        "Needs a lease (oil_gas_code, district_no and lease_no), a leases list of \"O/08/12345\" keys, or an operator_no."
      );
    }

    const capped = keys.slice(0, limit);
    const leases = await Promise.all(
      capped.map(async (key) => {
        const p4 = await getLeaseP4(key.oil_gas_code, key.district_no, key.lease_no).catch(
          () => ({ connections: [], filings: [] })
        );
        const transfers = reconstructTransfers(p4.filings);
        const counterparty = p4.filings
          .filter((f) => f.changes.some((c) => c === "Purchaser" || c === "Gatherer" || c === "Nominator"))
          .map((f) => ({
            effective_date: f.effective_date,
            approval_date: f.approval_date,
            operator_no: f.operator_no,
            operator_name: f.operator_name,
            changes: f.changes,
          }));
        return {
          key: leaseLabel(key),
          district: PDQ_TO_RRC[key.district_no] ?? key.district_no,
          filings: p4.filings.length,
          operators_seen: [
            ...new Map(
              p4.filings
                .filter((f) => f.operator_no)
                .map((f) => [f.operator_no!, f.operator_name ?? null])
            ),
          ].map(([no, name]) => ({ operator_no: no, operator_name: name })),
          transfers,
          transfer_count: transfers.length,
          counterparty_changes: counterparty,
          current_connections: p4.connections.map((c) => ({
            product_code: c.product_code,
            type_code: c.type_code,
            counterparty_no: c.gpn_no,
            counterparty_name: c.operator_name,
            effective_date: c.effective_date,
          })),
        };
      })
    );

    return {
      ok: true as const,
      leases,
      transfers_total: leases.reduce((a, l) => a + l.transfer_count, 0),
      truncated: keys.length > capped.length,
      notes: [
        "A transfer here is a CHANGE OF OPERATOR between consecutive P-4 filings. A filing carrying the chg_operator flag that names the same operator as the one before it is paperwork, not a deal, and is not reported.",
        "THIS IS NOT A COMPS DATABASE IN THE MONEY SENSE. The P-4 records who took over and when. It carries no consideration, no reserves, no acreage and no terms, and no arithmetic over these tables recovers them.",
        "Effective date is what the operator stated; approval date is when the Commission processed it. They can be years apart, and a lease can change hands without a P-4 ever being filed.",
        "Dummy filings (record_type 'D') and filings that changed nothing named are already excluded upstream, so an empty history means no recorded change, not no data.",
        NO_OWNERSHIP,
        NO_PRICE,
      ],
    };
  }
);

// ------------------------------------------------------------------- 41

const operatorExit = defineTool(
  "rrc_operator_exit",
  "Operators whose production, permit rate and count of producing leases are all falling fast enough to read as a wind-down.",
  {
    ...SCOPE_SHAPE,
    operators: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const explicit = (args.operators ?? []).map((s) => s.trim()).filter(Boolean);
    const scope = resolveScope(args);
    if (!explicit.length && isScopeError(scope)) return fail(scope.error);

    const { reported } = await getCycleEdge();
    if (!reported) return fail("The mirror has no published production cycle.");
    const limit = clamp(Math.floor(args.limit ?? 25), 1, ROW_CAP);
    const asOf = `${reported}-01`;

    const operatorNos = explicit.length
      ? explicit.slice(0, OPERATOR_CAP)
      : await scopeOperators(scope as Scope, reported, 12, OPERATOR_CAP);
    if (!operatorNos.length) return fail("No operator matched that scope.");

    const [production, permits, leaseCounts, records, fleets] = await Promise.all([
      rrcQuery<{ operator_no: string; last12: number; prior12: number }>(
        `select operator_no,
                coalesce(sum(oil_prod_vol) filter (
                  where cycle > $2::date - interval '12 months'), 0)::bigint as last12,
                coalesce(sum(oil_prod_vol) filter (
                  where cycle <= $2::date - interval '12 months'), 0)::bigint as prior12
           from rrc.operator_production
          where operator_no = any($1)
            and cycle >  $2::date - interval '24 months'
            and cycle <= $2::date
          group by 1`,
        [operatorNos, asOf]
      ),
      // Permits are dated by the CALENDAR, not by the production edge: an
      // application is filed and issued in real time and has no reporting lag.
      rrcQuery<{ operator_number: string; last12: number; prior12: number }>(
        `select operator_number,
                count(*) filter (
                  where issued_date > current_date - interval '12 months')::int as last12,
                count(*) filter (
                  where issued_date <= current_date - interval '12 months')::int as prior12
           from rrc.permit
          where operator_number = any($1)
            and issued_date > current_date - interval '24 months'
          group by 1`,
        [operatorNos]
      ),
      rrcQuery<{ operator_no: string; last12: number; prior12: number }>(
        `select operator_no,
                count(distinct lease_no) filter (
                  where cycle > $2::date - interval '12 months'
                    and coalesce(oil_prod_vol,0) + coalesce(gas_prod_vol,0) > 0)::int as last12,
                count(distinct lease_no) filter (
                  where cycle <= $2::date - interval '12 months'
                    and coalesce(oil_prod_vol,0) + coalesce(gas_prod_vol,0) > 0)::int as prior12
           from rrc.lease_production
          where operator_no = any($1)
            and cycle >  $2::date - interval '24 months'
            and cycle <= $2::date
          group by 1`,
        [operatorNos, asOf]
      ),
      rrcQuery<{
        operator_number: string;
        operator_name: string | null;
        p5_status: string | null;
        last_p5_date: string | null;
      }>(
        `select operator_number, operator_name, p5_status,
                to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
           from rrc.operators where operator_number = any($1)`,
        [operatorNos]
      ),
      fleetCounts(operatorNos),
    ]);

    const prodBy = new Map(production.map((r) => [r.operator_no.trim(), r]));
    const permBy = new Map(permits.map((r) => [r.operator_number.trim(), r]));
    const leaseBy = new Map(leaseCounts.map((r) => [r.operator_no.trim(), r]));
    const recBy = new Map(records.map((r) => [r.operator_number.trim(), r]));

    const scored = operatorNos.map((no) => {
      const prod = prodBy.get(no);
      const perm = permBy.get(no);
      const lease = leaseBy.get(no);
      const rec = recBy.get(no);
      const fleet = fleets.get(no);

      const productionDrop = prod ? rollover(prod.last12, prod.prior12) : null;
      const leaseDrop = lease ? rollover(lease.last12, lease.prior12) : null;
      const permitsLast12 = perm?.last12 ?? 0;

      const signals = {
        production_falling:
          productionDrop !== null && productionDrop >= EXIT_THRESHOLDS.production_drop,
        leases_falling: leaseDrop !== null && leaseDrop >= EXIT_THRESHOLDS.lease_drop,
        permits_stopped: permitsLast12 <= EXIT_THRESHOLDS.permits_stopped,
      };

      return {
        operator_no: no,
        operator_name: rec?.operator_name ?? null,
        p5_status: rec?.p5_status ?? null,
        wells_on_schedule: fleet?.wells ?? null,
        wells_plugged: fleet?.plugged ?? null,
        oil_last12_bbl: prod?.last12 ?? null,
        oil_prior12_bbl: prod?.prior12 ?? null,
        production_drop: productionDrop,
        producing_leases_last12: lease?.last12 ?? null,
        producing_leases_prior12: lease?.prior12 ?? null,
        lease_drop: leaseDrop,
        permits_last12: permitsLast12,
        permits_prior12: perm?.prior12 ?? 0,
        signals,
        signals_tripped: Object.values(signals).filter(Boolean).length,
        winding_down: Object.values(signals).every(Boolean),
      };
    });

    scored.sort(
      (a, b) => b.signals_tripped - a.signals_tripped || (b.production_drop ?? 0) - (a.production_drop ?? 0)
    );

    return {
      ok: true as const,
      reported_through: reported,
      thresholds: EXIT_THRESHOLDS,
      operators_scored: scored.length,
      operators: scored.slice(0, limit),
      truncated: scored.length > limit || operatorNos.length >= OPERATOR_CAP,
      notes: [
        "The thresholds are ASSERTED, not fitted, and every underlying count is returned so they can be re-applied by hand.",
        "A FALLING WELL COUNT CANNOT BE MEASURED HERE. The wellbore schedule is a snapshot with no history in the mirror, so the count of leases reporting production stands in for it. A lease sold rather than shut looks the same from this side.",
        "Permits are counted on the calendar because an application has no reporting lag; production and lease counts end at the RRC's published edge. The two windows are deliberately different.",
        "Three signals tripping is a wind-down pattern, never a decision to sell. Plenty of sound operators stop permitting for a year.",
        LAG_NOTE(reported),
        SCHEDULE_NOTE,
        NO_PRICE,
      ],
    };
  }
);

// ------------------------------------------------------------------- 42

const estateMap = defineTool(
  "rrc_estate_map",
  "Principals behind a company or a named person: the operators each one holds, how old those P-5 filings are, and how big each fleet is.",
  {
    officer_name: z.string().optional(),
    operator_no: z.string().optional(),
    min_operators: z.number().int().positive().optional(),
    as_of: z.string().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const name = args.officer_name?.trim() || null;
    const operatorNo = args.operator_no?.trim() || null;
    if (!name && !operatorNo) return fail("Needs officer_name or operator_no.");

    const today = readDate(args.as_of);
    if (!today) return fail("as_of must be YYYY-MM-DD.");
    // Two different questions share this tool, and they want different floors.
    // Seeded from an OPERATOR the question is "who here is spread across more
    // than one company", so two is the point. Seeded from a NAME the question is
    // "what does this person hold", and a floor of two answers "nothing" for
    // anyone with a single P-5, which is most people.
    const minOperators = Math.max(1, Math.floor(args.min_operators ?? (name ? 1 : 2)));
    const limit = clamp(Math.floor(args.limit ?? 25), 1, ROW_CAP);

    let pairs: { officer_name: string; operator_number: string; officer_title: string | null }[];
    let resolvedNames: OfficerMatch[] = [];
    if (operatorNo) {
      const net = await getOperatorNetwork(operatorNo);
      if (!net) return fail(`No operator ${operatorNo}.`);
      pairs = [
        ...net.officers
          .filter((o) => o.officer_name?.trim())
          .map((o) => ({
            officer_name: o.officer_name!.trim(),
            operator_number: operatorNo,
            officer_title: o.officer_title,
          })),
        ...net.related.map((r) => ({
          officer_name: r.officer_name.trim(),
          operator_number: r.operator_number.trim(),
          officer_title: null,
        })),
      ];
    } else {
      // This used to be `officer_name ilike '%<the whole string as typed>%'`,
      // which cannot work: the mirror stores `SMITH, JOHN B.`, so a caller
      // typing the name in reading order matched zero rows, a middle name
      // matched zero rows, and one wrong letter matched zero rows. All three
      // came back as "no P-5 officer matched", which reads like "this person
      // operates nothing" and is the opposite answer. See `../people.ts`.
      resolvedNames = await resolveOfficerNames(name!, 5);
      if (!resolvedNames.length) return fail(`No P-5 officer name resembles "${name}".`);
      pairs = (
        await rrcQuery<{ officer_name: string; operator_number: string; officer_title: string | null }>(
          `select distinct officer_name, operator_number, officer_title
             from rrc.operator_officers
            where officer_name = any($1)
            order by officer_name, operator_number
            limit 400`,
          [resolvedNames.map((m) => m.officer_name)]
        )
      ).map((r) => ({ ...r, operator_number: r.operator_number.trim() }));
    }
    if (!pairs.length) return fail("No P-5 officer matched.");

    const operatorNos = [...new Set(pairs.map((p) => p.operator_number))].slice(0, CANDIDATE_CAP);
    const [records, fleets] = await Promise.all([
      rrcQuery<{
        operator_number: string;
        operator_name: string | null;
        p5_status: string | null;
        org_date: string | null;
        last_p5_date: string | null;
      }>(
        `select operator_number, operator_name, p5_status,
                to_char(org_date, 'YYYY-MM-DD')     as org_date,
                to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
           from rrc.operators where operator_number = any($1)`,
        [operatorNos]
      ),
      fleetCounts(operatorNos),
    ]);
    const recBy = new Map(records.map((r) => [r.operator_number.trim(), r]));

    const byPrincipal = new Map<string, Set<string>>();
    const titles = new Map<string, Set<string>>();
    for (const p of pairs) {
      if (!operatorNos.includes(p.operator_number)) continue;
      byPrincipal.set(p.officer_name, (byPrincipal.get(p.officer_name) ?? new Set()).add(p.operator_number));
      if (p.officer_title) {
        titles.set(p.officer_name, (titles.get(p.officer_name) ?? new Set()).add(p.officer_title));
      }
    }

    const principals = [...byPrincipal.entries()]
      .filter(([, ops]) => ops.size >= minOperators)
      .map(([officer, ops]) => {
        const operators = [...ops].map((no) => {
          const rec = recBy.get(no);
          const days = rec?.last_p5_date ? daysBetween(Date.parse(`${rec.last_p5_date}T00:00:00Z`), today.iso) : null;
          const orgDays = rec?.org_date ? daysBetween(Date.parse(`${rec.org_date}T00:00:00Z`), today.iso) : null;
          return {
            operator_no: no,
            operator_name: rec?.operator_name ?? null,
            p5_status: rec?.p5_status ?? null,
            org_date: rec?.org_date ?? null,
            last_p5_date: rec?.last_p5_date ?? null,
            // `daysBetween` counts FORWARD from the filing to as_of, so the
            // elapsed age is the value itself. Negating it here once read as a
            // filing 214 days in the future.
            days_since_p5_filing: days,
            years_registered: orgDays === null ? null : orgDays / 365.25,
            wells_on_schedule: fleets.get(no)?.wells ?? 0,
          };
        });
        operators.sort((a, b) => b.wells_on_schedule - a.wells_on_schedule);
        return {
          officer_name: officer,
          titles: [...(titles.get(officer) ?? [])],
          operator_count: operators.length,
          wells_on_schedule: operators.reduce((a, o) => a + o.wells_on_schedule, 0),
          oldest_registration: operators.map((o) => o.org_date).filter(Boolean).sort()[0] ?? null,
          newest_p5_filing:
            operators.map((o) => o.last_p5_date).filter(Boolean).sort().slice(-1)[0] ?? null,
          operators,
        };
      })
      .sort((a, b) => b.wells_on_schedule - a.wells_on_schedule || b.operator_count - a.operator_count);

    return {
      ok: true as const,
      as_of: today.iso,
      query: { officer_name: name, operator_no: operatorNo, min_operators: minOperators },
      // Which names the typed string actually resolved to. A caller reporting
      // this must say the name it read, not the name it was given.
      names_read: resolvedNames.map((m) => ({
        officer_name: m.officer_name,
        matched: m.matched,
        score: m.score,
      })),
      principals_found: principals.length,
      principals: principals.slice(0, limit),
      truncated: principals.length > limit || operatorNos.length >= CANDIDATE_CAP,
      notes: [
        ...(name
          ? [
              `The name typed was resolved by fuzzy match against the P-5 officer file, so more than one real person can appear. names_read says which strings were read; report those, not the one that was asked for.`,
            ]
          : []),
        "A principal here is an OFFICER NAME on a P-5, matched as text. Two different people with the same name merge into one principal, and one person filed under two spellings splits into two. Confirm identity before acting on a link.",
        "Being named on a P-5 is not ownership. It says the Commission was told this person is an officer of that company; it says nothing about who owns it, who funds it, or who takes the revenue.",
        "Operators an officer left are still on the tape until the P-5 is refiled, so an old affiliation can look current.",
        "Filing age is measured against as_of, which defaults to today. It is the age of the P-5 record, not of the company's activity.",
        SCHEDULE_NOTE,
        NO_OWNERSHIP,
        NO_PRICE,
      ],
    };
  }
);

// ------------------------------------------------------------------- 43

/** W-10 water cut history for one lease, newest tests last. */
async function leaseWaterCut(districtEwa: string, leaseNo: string) {
  const rows = await rrcQuery<{
    test_date: string | null;
    well_no: string | null;
    daily_oil: number | null;
    daily_water: number | null;
  }>(
    `select to_char(test_date, 'YYYY-MM-DD') as test_date, well_no, daily_oil, daily_water
       from rrc.w10_test
      where district = $1 and lease_no = $2 and test_date is not null
      order by test_date`,
    [districtEwa, leaseNo]
  );
  const points = rows
    .filter((r) => r.test_date && (r.daily_oil ?? 0) + (r.daily_water ?? 0) > 0)
    .map((r) => ({
      date: r.test_date!,
      well_no: r.well_no,
      water_cut: (r.daily_water ?? 0) / ((r.daily_oil ?? 0) + (r.daily_water ?? 0)),
    }));
  return { tests: rows.length, points };
}

const packageValueDrivers = defineTool(
  "rrc_package_value_drivers",
  "Size a candidate package: current rate, decline, remaining reserves, water cut trend, disposal exposure and plugging burden. Sizes a package, never values one.",
  {
    ...LEASE_KEY_SHAPE,
    operator_no: z.string().optional(),
    economic_limit: z.number().nonnegative().optional(),
  },
  async (args) => {
    const key = readLeaseKey(args);
    const operatorNo = args.operator_no?.trim() || null;
    if (!key && !operatorNo) {
      return fail("Needs a lease (oil_gas_code, district_no, lease_no) or an operator_no.");
    }
    const { reported } = await getCycleEdge();
    if (!reported) return fail("The mirror has no published production cycle.");
    const economicLimit = args.economic_limit ?? 0;

    let series: SeriesRow[] = [];
    let label: string;
    let districtEwa: string | null = null;
    if (key) {
      series = await leaseSeries(key, reported);
      label = leaseLabel(key);
      districtEwa = PDQ_TO_RRC[key.district_no] ?? key.district_no;
    } else {
      series = await rrcQuery<SeriesRow>(
        `select to_char(cycle, 'YYYY-MM')          as cycle,
                coalesce(oil_prod_vol, 0)::bigint  as oil,
                coalesce(gas_prod_vol, 0)::bigint  as gas,
                coalesce(cond_prod_vol, 0)::bigint as cond,
                coalesce(csgd_prod_vol, 0)::bigint as csgd
           from rrc.operator_production
          where operator_no = $1 and cycle <= $2::date
          order by cycle`,
        [operatorNo, `${reported}-01`]
      );
      label = `Operator ${operatorNo}`;
    }
    if (!series.length) return fail(`No reported production history for ${label}.`);

    const last3 = series.slice(-3);
    const last12 = series.slice(-12);
    const prior12 = series.slice(-24, -12);

    const water = key && districtEwa ? await leaseWaterCut(districtEwa, key.lease_no) : null;
    const waterTrend = water
      ? trendPerYear(water.points.map((p) => ({ date: p.date, value: p.water_cut })))
      : null;

    // Disposal exposure is an OPERATOR fact: a permit belongs to the P-5, not
    // to a lease, so it is only fetched when an operator was named.
    const disposal = operatorNo ? await getOperatorDisposal(operatorNo) : null;
    const fleets = operatorNo ? await fleetCounts([operatorNo]) : null;
    const fleet = operatorNo ? fleets?.get(operatorNo) ?? null : null;
    const depth = operatorNo
      ? await rrcQuery<{ wells: number; total_ft: number | null; deepest: number | null }>(
          `select count(distinct api_number)::int         as wells,
                  sum(nullif(api_depth, '')::bigint)      as total_ft,
                  max(nullif(api_depth, '')::bigint)      as deepest
             from rrc.wellbore
            where operator_number = $1 and on_schedule = 'Y'
              and nullif(plug_date, '') is null`,
          [operatorNo]
        )
      : [];

    const disposalUtilisation =
      disposal && disposal.permittedBblPerDay && disposal.injectedBbl12m
        ? disposal.injectedBbl12m / 365 / disposal.permittedBblPerDay
        : null;

    return {
      ok: true as const,
      /** Not a caveat in a note. This is the first thing the reader sees. */
      does_not_value:
        "This tool SIZES a package. It does not value one, and no field below is a valuation input on its own. " +
        NO_PRICE,
      target: label,
      reported_through: reported,
      economic_limit: economicLimit,
      rate: {
        oil_bopd_last3: last3.length ? mean(last3.map((r) => dailyRate(r.oil, r.cycle))) : null,
        gas_mcfd_last3: last3.length ? mean(last3.map((r) => dailyRate(r.gas, r.cycle))) : null,
        oil_last12_bbl: last12.reduce((a, r) => a + r.oil, 0),
        gas_last12_mcf: last12.reduce((a, r) => a + r.gas, 0),
        oil_yoy_change: prior12.length
          ? rollover(last12.reduce((a, r) => a + r.oil, 0), prior12.reduce((a, r) => a + r.oil, 0))
          : null,
        reported_months: series.length,
      },
      decline: {
        oil: declineOf(series, "oil", economicLimit),
        gas: declineOf(series, "gas", 0),
      },
      water_cut: water
        ? {
            source: "Form W-10 well tests",
            tests: water.tests,
            latest: water.points.length ? water.points[water.points.length - 1] : null,
            trend_per_year: waterTrend,
          }
        : {
            source: null,
            tests: 0,
            latest: null,
            trend_per_year: null,
            reason:
              "Water cut is a lease question here: the W-10 tape is keyed district plus lease plus well, so an operator-wide water cut would have to be assembled lease by lease.",
          },
      disposal_exposure: disposal
        ? {
            live_disposal_wells: disposal.wells,
            commercial_wells: disposal.commercialWells,
            permitted_bbl_per_day: disposal.permittedBblPerDay,
            injected_last12_bbl: disposal.injectedBbl12m,
            utilisation: disposalUtilisation,
            reported_through: disposal.reportedThrough,
          }
        : { reason: "Disposal permits belong to a P-5. Supply operator_no to size them." },
      plugging_burden: fleet
        ? {
            wells_on_schedule: fleet.wells,
            wells_plugged: fleet.plugged,
            wells_unplugged: depth[0]?.wells ?? null,
            total_unplugged_depth_ft: depth[0]?.total_ft ?? null,
            deepest_well_ft: depth[0]?.deepest ?? null,
            wells_flagged_14b2: fleet.flagged,
          }
        : { reason: "Plugging burden follows the P-5. Supply operator_no to size it." },
      notes: [
        "Depth in feet is the physical size of the plugging obligation. It is NOT a cost: the RRC publishes no plugging cost, and converting feet into money needs a bid this record does not have.",
        "Remaining reserves are the forward integral of a fitted curve from the end of its window, so they are REMAINING and never original EUR. They are a curve's arithmetic, not a reserve report.",
        "W-10 is a single day's metered test, filed to establish an allowable, and it reads high against the monthly average. Its VALUE here is the trend between tests, not the level of any one.",
        "Injection utilisation divides twelve months of reported barrels by 365 and by the permitted daily ceiling. H-10 filing runs about a year behind, so a thin recent tail is late paperwork.",
        LAG_NOTE(reported),
        NO_OWNERSHIP,
        NO_PRICE,
      ],
    };
  }
);

// ------------------------------------------------------------------- 44

const liabilityCheck = defineTool(
  "rrc_liability_check",
  "Pre-diligence sweep on one operator: 14(b)(2) flagged wells, delinquent H-15s, orphan risk, injection permits inherited and wells with no coordinates on file.",
  {
    operator_no: z.string(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const operatorNo = args.operator_no.trim();
    if (!operatorNo) return fail("operator_no is required.");
    const limit = clamp(Math.floor(args.limit ?? 25), 1, ROW_CAP);

    const [fleet, reasons, h15, delinquentWells, idle, uncoded, disposal, statePlugs] =
      await Promise.all([
        fleetCounts([operatorNo]),
        rrcQuery<Record<string, number>>(
          `select count(distinct api_number) filter (where wb_14b2_flag = 'Y')::int      as flagged,
                  count(distinct api_number) filter (
                    where nullif(wl_14b2_h15_delq, '') is not null)::int                 as h15_delinquent,
                  count(distinct api_number) filter (
                    where nullif(wl_14b2_pollution, '') is not null)::int                as pollution,
                  count(distinct api_number) filter (
                    where nullif(wl_14b2_mech_integ, '') is not null)::int               as mechanical_integrity,
                  count(distinct api_number) filter (
                    where nullif(wl_14b2_plg_ord_sf, '') is not null)::int               as plugging_order,
                  count(distinct api_number) filter (
                    where nullif(wl_14b2_dist_st_plg, '') is not null)::int              as district_state_plugging,
                  count(distinct api_number) filter (
                    where nullif(surf_eqp_viol, '') is not null)::int                    as surface_violations,
                  count(distinct api_number) filter (
                    where nullif(w3x_viol, '') is not null)::int                         as w3x_violations
             from rrc.wellbore
            where operator_number = $1 and on_schedule = 'Y'`,
          [operatorNo]
        ),
        getOperatorH15(operatorNo),
        rrcQuery<{ api_number: string; status_date: string | null; test_date: string | null }>(
          `select distinct on (api_number)
                  api_number, to_char(status_date, 'YYYY-MM-DD') as status_date,
                  to_char(test_date, 'YYYY-MM-DD') as test_date
             from rrc.wb_h15
            where operator_no = $1 and status = 'D'
            order by api_number, test_date desc nulls last
            limit $2`,
          [operatorNo, ROW_CAP]
        ),
        rrcQuery<{
          api_number: string;
          well_no: string | null;
          lease_name: string | null;
          well_type_name: string | null;
          inact_yrs: number | null;
          inact_mos: number | null;
          flagged: boolean;
        }>(
          `select distinct on (api_number)
                  api_number, well_no, lease_name, well_type_name,
                  nullif(curr_inact_yrs, '')::int as inact_yrs,
                  nullif(curr_inact_mos, '')::int as inact_mos,
                  wb_14b2_flag = 'Y'              as flagged
             from rrc.wellbore
            where operator_number = $1 and on_schedule = 'Y'
              and nullif(plug_date, '') is null
              and coalesce(nullif(curr_inact_yrs, '')::int, 0) >= $2
            order by api_number
            limit $3`,
          [operatorNo, ORPHAN_INACTIVE_YEARS, ROW_CAP]
        ),
        rrcQuery<{ wells: number }>(
          `select count(distinct w.api_number)::int as wells
             from rrc.wellbore w
             left join rrc.well_location l on l.api_number = w.api_number
            where w.operator_number = $1 and w.on_schedule = 'Y'
              and (l.lat is null or l.lon is null)`,
          [operatorNo]
        ),
        findDisposal({ operatorNo, limit: ROW_CAP }),
        rrcQuery<{ wells: number }>(
          `select count(distinct p.api_number)::int as wells
             from rrc.wellbore w
             join rrc.wb_plug p on p.api_number = w.api_number
            where w.operator_number = $1 and w.on_schedule = 'Y'
              and p.state_funded_plug_no is not null`,
          [operatorNo]
        ),
      ]);

    const counts = fleet.get(operatorNo) ?? { wells: 0, flagged: 0, plugged: 0 };
    const r = reasons[0] ?? {};

    return {
      ok: true as const,
      operator_no: operatorNo,
      fleet: {
        wells_on_schedule: counts.wells,
        wells_plugged: counts.plugged,
        wells_unplugged: counts.wells - counts.plugged,
      },
      flagged_14b2: {
        wells: counts.flagged,
        share: counts.wells > 0 ? counts.flagged / counts.wells : null,
        reasons: r,
      },
      h15: {
        wells_tested: h15.wellsTested,
        delinquent: h15.delinquent,
        due_within_90_days: h15.dueSoon,
        last_test: h15.lastTest,
        delinquent_wells: delinquentWells.slice(0, limit).map((w) => ({
          api_number: w.api_number.trim(),
          test_date: w.test_date,
          status_date: w.status_date,
        })),
        delinquent_truncated: delinquentWells.length >= ROW_CAP,
      },
      orphan_risk: {
        inactive_years_threshold: ORPHAN_INACTIVE_YEARS,
        wells_long_inactive: idle.length,
        state_funded_plugs_already: statePlugs[0]?.wells ?? 0,
        wells: idle.slice(0, limit).map((w) => ({
          api_number: w.api_number.trim(),
          well_no: w.well_no,
          lease_name: w.lease_name,
          well_type: w.well_type_name,
          inactive_years: w.inact_yrs,
          inactive_months: w.inact_mos,
          flagged_14b2: w.flagged,
        })),
        truncated: idle.length >= ROW_CAP,
      },
      injection_inherited: {
        live_permits: disposal.length,
        commercial: disposal.filter((d) => d.is_commercial).length,
        permitted_bbl_per_day: disposal.reduce((a, d) => a + (d.max_bbl_per_day ?? 0), 0),
        permits: disposal.slice(0, limit).map((d) => ({
          uic_no: d.uic_no,
          api_number: d.api_number,
          lease_name: d.lease_name,
          inj_type: d.inj_type,
          is_commercial: d.is_commercial,
          max_bbl_per_day: d.max_bbl_per_day,
          utilisation: d.utilisation,
        })),
        truncated: disposal.length >= ROW_CAP,
      },
      no_coordinates: {
        wells: uncoded[0]?.wells ?? 0,
        share: counts.wells > 0 ? (uncoded[0]?.wells ?? 0) / counts.wells : null,
      },
      notes: [
        "Every liability here transfers with the P-5, not with the lease. A buyer taking wells onto their own schedule takes the 14(b)(2) clocks, the H-15 obligations and the plugging duty with them.",
        "A state-funded plug already on the record is the strongest signal in this sweep: it means the operator did not plug and the state did.",
        "Wells with no coordinates on file are a diligence gap, not a defect. They cannot be located, offset, or checked against a survey without going to the plat.",
        "Injection permits are counted as LIVE (activated, not cancelled, no W-3 on file). A live permit carries a monitoring and eventual plugging duty whether or not anything is injected.",
        SCHEDULE_NOTE,
        NO_PRICE,
        NO_OWNERSHIP,
      ],
    };
  }
);

// ------------------------------------------------------------------- 67

const whySelling = defineTool(
  "rrc_why_selling",
  "The deterministic reasons a package is on the market: water cut inflecting, GOR blowing out, a purchaser departing, H-15s coming due, disposal near capacity and decline steepening.",
  {
    ...LEASE_KEY_SHAPE,
    operator_no: z.string().optional(),
  },
  async (args) => {
    const key = readLeaseKey(args);
    const operatorNo = args.operator_no?.trim() || null;
    if (!key && !operatorNo) {
      return fail("Needs a lease (oil_gas_code, district_no, lease_no) or an operator_no.");
    }
    const { reported } = await getCycleEdge();
    if (!reported) return fail("The mirror has no published production cycle.");

    const districtEwa = key ? PDQ_TO_RRC[key.district_no] ?? key.district_no : null;
    const [series, water, p4, h15, disposal] = await Promise.all([
      key
        ? leaseSeries(key, reported)
        : rrcQuery<SeriesRow>(
            `select to_char(cycle, 'YYYY-MM')          as cycle,
                    coalesce(oil_prod_vol, 0)::bigint  as oil,
                    coalesce(gas_prod_vol, 0)::bigint  as gas,
                    coalesce(cond_prod_vol, 0)::bigint as cond,
                    coalesce(csgd_prod_vol, 0)::bigint as csgd
               from rrc.operator_production
              where operator_no = $1 and cycle <= $2::date
              order by cycle`,
            [operatorNo, `${reported}-01`]
          ),
      key && districtEwa ? leaseWaterCut(districtEwa, key.lease_no) : null,
      key ? getLeaseP4(key.oil_gas_code, key.district_no, key.lease_no).catch(() => null) : null,
      operatorNo ? getOperatorH15(operatorNo) : null,
      operatorNo ? getOperatorDisposal(operatorNo) : null,
    ]);

    const reasons: {
      reason: string;
      indicated: boolean;
      source: string;
      evidence: Record<string, unknown>;
    }[] = [];

    // 1. Water cut inflecting: recent tests against the earlier ones.
    if (water && water.points.length >= 4) {
      const half = Math.floor(water.points.length / 2);
      const early = mean(water.points.slice(0, half).map((p) => p.water_cut));
      const late = mean(water.points.slice(half).map((p) => p.water_cut));
      reasons.push({
        reason: "water_cut_inflecting",
        indicated: early !== null && late !== null && early > 0 && late / early >= WHY_THRESHOLDS.water_cut_ratio,
        source: "Form W-10 well tests",
        evidence: {
          tests: water.points.length,
          early_mean_water_cut: early,
          recent_mean_water_cut: late,
          ratio: early && late ? late / early : null,
          threshold: WHY_THRESHOLDS.water_cut_ratio,
          latest_test: water.points[water.points.length - 1]?.date ?? null,
        },
      });
    } else {
      reasons.push({
        reason: "water_cut_inflecting",
        indicated: false,
        source: "Form W-10 well tests",
        evidence: {
          tests: water?.points.length ?? 0,
          reason_not_measured: key
            ? "Fewer than 4 usable W-10 tests on this lease."
            : "Water cut is keyed district plus lease plus well; supply a lease.",
        },
      });
    }

    // 2. GOR blowing out. One formula covers both lease types: an oil lease
    // carries its gas in csgd and its liquid in oil, a gas lease the other way.
    const gor = series
      .map((r) => {
        const gas = r.gas + r.csgd;
        const liquid = r.oil + r.cond;
        return { date: r.cycle, value: liquid > 0 ? (gas * 1000) / liquid : null };
      })
      .filter((p): p is { date: string; value: number } => p.value !== null);
    const recentGor = mean(gor.slice(-6).map((p) => p.value));
    const priorGor = mean(gor.slice(-24, -6).map((p) => p.value));
    reasons.push({
      reason: "gor_blowing_out",
      indicated:
        recentGor !== null && priorGor !== null && priorGor > 0 &&
        recentGor / priorGor >= WHY_THRESHOLDS.gor_ratio,
      source: "RRC monthly production filings",
      evidence: {
        recent_6mo_gor_scf_per_bbl: recentGor,
        prior_18mo_gor_scf_per_bbl: priorGor,
        ratio: recentGor !== null && priorGor ? recentGor / priorGor : null,
        threshold: WHY_THRESHOLDS.gor_ratio,
        trend_per_year: trendPerYear(gor.slice(-36)),
      },
    });

    // 3. Purchaser departed.
    const cutoff = addMonthsIso(`${reported}-01`, -WHY_THRESHOLDS.counterparty_months);
    const departures = (p4?.filings ?? []).filter(
      (f) =>
        f.effective_date &&
        f.effective_date >= cutoff &&
        f.changes.some((c) => c === "Purchaser" || c === "Gatherer")
    );
    reasons.push({
      reason: "purchaser_departed",
      indicated: departures.length > 0,
      source: "Form P-4",
      evidence: {
        window_months: WHY_THRESHOLDS.counterparty_months,
        since: cutoff,
        filings: departures.map((f) => ({
          effective_date: f.effective_date,
          approval_date: f.approval_date,
          changes: f.changes,
          operator_name: f.operator_name,
        })),
        current_connections: (p4?.connections ?? []).length,
      },
    });

    // 4. H-15s coming due.
    reasons.push({
      reason: "h15_coming_due",
      indicated: (h15?.dueSoon ?? 0) > 0 || (h15?.delinquent ?? 0) > 0,
      source: "Form H-15",
      evidence: h15
        ? {
            wells_tested: h15.wellsTested,
            delinquent: h15.delinquent,
            due_within_90_days: h15.dueSoon,
            last_test: h15.lastTest,
            note: `The RRC's own 90-day window is what the tape supports; ${WHY_THRESHOLDS.h15_due_months} months is not separately derivable here.`,
          }
        : { reason_not_measured: "H-15 obligations follow the P-5; supply operator_no." },
    });

    // 5. Disposal near capacity.
    const utilisation =
      disposal && disposal.permittedBblPerDay && disposal.injectedBbl12m
        ? disposal.injectedBbl12m / 365 / disposal.permittedBblPerDay
        : null;
    reasons.push({
      reason: "disposal_near_capacity",
      indicated: utilisation !== null && utilisation >= WHY_THRESHOLDS.disposal_utilisation,
      source: "Form H-10 and the UIC permit file",
      evidence: disposal
        ? {
            live_disposal_wells: disposal.wells,
            permitted_bbl_per_day: disposal.permittedBblPerDay,
            injected_last12_bbl: disposal.injectedBbl12m,
            utilisation,
            threshold: WHY_THRESHOLDS.disposal_utilisation,
            reported_through: disposal.reportedThrough,
          }
        : { reason_not_measured: "Disposal permits follow the P-5; supply operator_no." },
    });

    // 6. Decline steepening: the recent window against the whole history.
    const full = declineOf(series, "oil", 0);
    const recent = declineOf(series.slice(-24), "oil", 0);
    reasons.push({
      reason: "decline_steepening",
      indicated:
        full.fitted && recent.fitted &&
        full.declinePctPerYear > 0 &&
        recent.declinePctPerYear / full.declinePctPerYear >= WHY_THRESHOLDS.decline_ratio,
      source: "RRC monthly production filings, modified-Arps fit",
      evidence: {
        full_history: full,
        last_24_months: recent,
        ratio:
          full.fitted && recent.fitted && full.declinePctPerYear > 0
            ? recent.declinePctPerYear / full.declinePctPerYear
            : null,
        threshold: WHY_THRESHOLDS.decline_ratio,
      },
    });

    return {
      ok: true as const,
      target: key ? leaseLabel(key) : `Operator ${operatorNo}`,
      reported_through: reported,
      thresholds: WHY_THRESHOLDS,
      indicated: reasons.filter((r) => r.indicated).map((r) => r.reason),
      reasons,
      notes: [
        "These are the reasons the RECORD can show. The reasons that actually sell packages, a partner dispute, a death, a bank line, a tax year, leave no trace in a state filing and are absent here by nature, not by omission.",
        "Every threshold is ASSERTED, not fitted, and each reason carries the raw numbers so it can be re-judged.",
        "An indicated reason is a hypothesis to put to the seller, never a conclusion. Water cut rising is also what a successful waterflood looks like.",
        LAG_NOTE(reported),
        NO_PRICE,
      ],
    };
  }
);

// ------------------------------------------------------------------- 68

const sellerAsymmetry = defineTool(
  "rrc_seller_asymmetry",
  "What the public record shows that a seller is likely to understate, each item with the filing it came from and its date.",
  {
    operator_no: z.string().optional(),
    ...LEASE_KEY_SHAPE,
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const operatorNo = args.operator_no?.trim() || null;
    const key = readLeaseKey(args);
    if (!operatorNo && !key) {
      return fail("Needs an operator_no or a lease (oil_gas_code, district_no, lease_no).");
    }
    const limit = clamp(Math.floor(args.limit ?? 40), 1, ROW_CAP);

    interface Item {
      item: string;
      /** The form this came off, and the table it lives in. */
      filing: string;
      /** The date on the filing, or null when the tape carries none. */
      date: string | null;
      subject: string;
      detail: Record<string, unknown>;
    }
    const items: Item[] = [];

    if (operatorNo) {
      const [flagged, delinquent, plugs, record, permits] = await Promise.all([
        rrcQuery<{
          api_number: string;
          lease_name: string | null;
          modified_dt: string | null;
          reasons: string[];
        }>(
          `select api_number, lease_name, nullif(modified_dt, '') as modified_dt,
                  array_remove(array[
                    case when nullif(wl_14b2_h15_delq,'')     is not null then 'H-15 delinquent'     end,
                    case when nullif(wl_14b2_pollution,'')    is not null then 'Pollution'           end,
                    case when nullif(wl_14b2_mech_integ,'')   is not null then 'Mechanical integrity' end,
                    case when nullif(wl_14b2_plg_ord_sf,'')   is not null then 'Plugging order'      end,
                    case when nullif(wl_14b2_dist_st_plg,'')  is not null then 'District state plugging' end,
                    case when nullif(wl_14b2_good_faith,'')   is not null then 'Good faith'          end
                  ], null) as reasons
             from rrc.wellbore
            where operator_number = $1 and on_schedule = 'Y' and wb_14b2_flag = 'Y'
            order by api_number
            limit $2`,
          [operatorNo, ROW_CAP]
        ),
        rrcQuery<{ api_number: string; status_date: string | null; test_date: string | null }>(
          `select distinct on (api_number)
                  api_number, to_char(status_date, 'YYYY-MM-DD') as status_date,
                  to_char(test_date, 'YYYY-MM-DD')  as test_date
             from rrc.wb_h15
            where operator_no = $1 and status = 'D'
            order by api_number, test_date desc nulls last
            limit $2`,
          [operatorNo, ROW_CAP]
        ),
        rrcQuery<{ api_number: string; plug_date: string | null; total_depth: number | null }>(
          `select p.api_number, to_char(p.plug_date, 'YYYY-MM-DD') as plug_date, p.total_depth
             from rrc.wellbore w
             join rrc.wb_plug p on p.api_number = w.api_number
            where w.operator_number = $1 and w.on_schedule = 'Y'
              and p.state_funded_plug_no is not null
            order by p.plug_date desc nulls last
            limit $2`,
          [operatorNo, ROW_CAP]
        ),
        rrcQuery<{ p5_status: string | null; last_p5_date: string | null }>(
          `select p5_status, to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
             from rrc.operators where operator_number = $1`,
          [operatorNo]
        ),
        rrcQuery<{
          uic_no: string;
          approved_date: string | null;
          max_bbl_per_day: number | null;
          max_inj_pressure: number | null;
          is_commercial: boolean;
        }>(
          `select uic_no, to_char(approved_date, 'YYYY-MM-DD') as approved_date,
                  max_bbl_per_day, max_inj_pressure, is_commercial
             from rrc.uic_live_permit
            where operator_no = $1
            order by approved_date desc nulls last
            limit $2`,
          [operatorNo, ROW_CAP]
        ),
      ]);

      for (const w of flagged) {
        items.push({
          item: "14(b)(2) flagged well",
          // The wellbore tape carries the CURRENT flag with no filing of its
          // own, so the only date available is the RRC's audit stamp. Named as
          // what it is rather than dressed up as a filing date.
          filing: "RRC wellbore schedule (rrc.wellbore), record last modified",
          date: w.modified_dt,
          subject: w.api_number.trim(),
          detail: { lease_name: w.lease_name, reasons: w.reasons },
        });
      }
      for (const d of delinquent) {
        items.push({
          item: "H-15 delinquent well",
          filing: "Form H-15 (rrc.wb_h15), status 'D'",
          date: d.status_date ?? d.test_date,
          subject: d.api_number.trim(),
          detail: { last_test_date: d.test_date, status_date: d.status_date },
        });
      }
      for (const p of plugs) {
        items.push({
          item: "State-funded plug on the record",
          filing: "Form W-3 (rrc.wb_plug), state_funded_plug_no set",
          date: p.plug_date,
          subject: p.api_number.trim(),
          detail: { total_depth_ft: p.total_depth },
        });
      }
      const p5 = record[0] ?? null;
      if (p5 && (p5.p5_status !== "A" || p5.last_p5_date)) {
        items.push({
          item: p5.p5_status === "A" ? "P-5 filing age" : "P-5 not in active status",
          filing: "Form P-5 (rrc.operators)",
          date: p5.last_p5_date,
          subject: operatorNo,
          detail: { p5_status: p5.p5_status, term_months: P5_TERM_MONTHS },
        });
      }
      for (const u of permits) {
        items.push({
          item: "Live injection permit inherited",
          filing: "UIC permit file (rrc.uic_live_permit)",
          date: u.approved_date,
          subject: u.uic_no,
          detail: {
            max_bbl_per_day: u.max_bbl_per_day,
            max_inj_pressure_psig: u.max_inj_pressure,
            is_commercial: u.is_commercial,
          },
        });
      }
    }

    if (key) {
      const [flags, unfiled] = await Promise.all([
        rrcQuery<{ off_schedule: string | null; severance: string | null }>(
          `select lease_off_sched_flag as off_schedule, lease_severance_flag as severance
             from rrc.regulatory_lease
            where oil_gas_code = $1 and district_no = $2 and lease_no = $3
            limit 1`,
          [key.oil_gas_code, key.district_no, key.lease_no]
        ),
        rrcQuery<{ cycle: string }>(
          `select to_char(cycle, 'YYYY-MM') as cycle
             from rrc.lease_production
            where oil_gas_code = $1 and district_no = $2 and lease_no = $3
              and prod_report_filed = 'N'
            order by cycle desc
            limit $4`,
          [key.oil_gas_code, key.district_no, key.lease_no, ROW_CAP]
        ),
      ]);
      const f = flags[0];
      if (f?.off_schedule === "Y") {
        items.push({
          item: "Lease off schedule",
          filing: "Regulatory lease record (rrc.regulatory_lease). This table carries no date.",
          date: null,
          subject: leaseLabel(key),
          detail: { flag: "lease_off_sched_flag" },
        });
      }
      if (f?.severance === "Y") {
        items.push({
          item: "Lease under severance",
          filing: "Regulatory lease record (rrc.regulatory_lease). This table carries no date.",
          date: null,
          subject: leaseLabel(key),
          detail: { flag: "lease_severance_flag" },
        });
      }
      if (unfiled.length) {
        items.push({
          item: "Production months never filed",
          filing: "RRC monthly production (rrc.lease_production), prod_report_filed = 'N'",
          date: unfiled[0].cycle,
          subject: leaseLabel(key),
          detail: {
            months: unfiled.length,
            most_recent: unfiled[0].cycle,
            oldest: unfiled[unfiled.length - 1].cycle,
            note: "A zero in an unfiled month is missing paperwork, not an idle lease.",
          },
        });
      }
    }

    // Newest first, and undated items last: an item with no date on the tape
    // cannot be ranked against one that has one, and hiding that would be the
    // same understatement this tool exists to catch.
    items.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

    return {
      ok: true as const,
      target: operatorNo ? `Operator ${operatorNo}` : leaseLabel(key!),
      items_found: items.length,
      items: items.slice(0, limit),
      truncated: items.length > limit,
      notes: [
        "Every item carries the FILING it came from and its date so it can be put on the table as a document, not as an assertion.",
        "Where a date is null the tape genuinely carries none. The regulatory lease flags and the wellbore 14(b)(2) flags are current-state columns with no filing history in the mirror.",
        "An absent item is not a clean record. This reads only what the RRC publishes, and a great deal of what a seller could understate is not filed with the state at all.",
        SCHEDULE_NOTE,
        NO_PRICE,
        NO_OWNERSHIP,
      ],
    };
  }
);

// ------------------------------------------------------------------- 69

const obligationCalendar = defineTool(
  "rrc_obligation_calendar",
  "Forward calendar of what one operator owes the Commission and when: H-15 test dates, drilling permit expirations, the P-5 renewal and wells already past the 14(b)(2) inactivity clock.",
  {
    operator_no: z.string(),
    as_of: z.string().optional(),
    horizon_months: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const operatorNo = args.operator_no.trim();
    if (!operatorNo) return fail("operator_no is required.");
    const today = readDate(args.as_of);
    if (!today) return fail("as_of must be YYYY-MM-DD.");
    const horizon = clamp(Math.floor(args.horizon_months ?? 12), 1, 60);
    const limit = clamp(Math.floor(args.limit ?? 50), 1, ROW_CAP);
    const through = addMonthsIso(today.iso, horizon);

    const [h15Due, permits, record, inactive] = await Promise.all([
      rrcQuery<{
        api_number: string;
        next_test_year: string | null;
        next_test_month: string | null;
        status: string | null;
        test_date: string | null;
      }>(
        `select distinct on (api_number)
                api_number, next_test_year, next_test_month, status,
                to_char(test_date, 'YYYY-MM-DD') as test_date
           from rrc.wb_h15
          where operator_no = $1
          order by api_number, test_date desc nulls last, status_date desc nulls last`,
        [operatorNo]
      ),
      rrcQuery<{
        permit_number: string | null;
        lease_name: string | null;
        expires_date: string | null;
      }>(
        `select permit_number, lease_name,
                to_char(expires_date, 'YYYY-MM-DD') as expires_date
           from rrc.permit
          where operator_number = $1
            and expires_date between $2::date and $3::date
          order by expires_date
          limit $4`,
        [operatorNo, today.iso, through, ROW_CAP]
      ),
      rrcQuery<{ operator_name: string | null; p5_status: string | null; last_p5_date: string | null }>(
        `select operator_name, p5_status, to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
           from rrc.operators where operator_number = $1`,
        [operatorNo]
      ),
      rrcQuery<{
        api_number: string;
        lease_name: string | null;
        inact_yrs: number | null;
        inact_mos: number | null;
        flagged: boolean;
      }>(
        `select distinct on (api_number)
                api_number, lease_name,
                nullif(curr_inact_yrs, '')::int as inact_yrs,
                nullif(curr_inact_mos, '')::int as inact_mos,
                wb_14b2_flag = 'Y'              as flagged
           from rrc.wellbore
          where operator_number = $1 and on_schedule = 'Y'
            and nullif(plug_date, '') is null
            and coalesce(nullif(curr_inact_yrs, '')::int, 0) * 12
                + coalesce(nullif(curr_inact_mos, '')::int, 0) > $2
          order by api_number
          limit $3`,
        [operatorNo, INACTIVE_CLOCK_MONTHS, ROW_CAP]
      ),
    ]);

    interface Obligation {
      obligation: string;
      form: string;
      subject: string;
      due_date: string | null;
      days_until: number | null;
      overdue: boolean;
      detail: Record<string, unknown>;
    }
    const items: Obligation[] = [];

    for (const w of h15Due) {
      // The tape gives a due YEAR and MONTH, never a day. Anchored on the
      // first of that month, which is the earliest it can fall due.
      if (!/^\d{4}$/.test(w.next_test_year ?? "") || !/^\d{2}$/.test(w.next_test_month ?? "")) {
        continue;
      }
      const due = `${w.next_test_year}-${w.next_test_month}-01`;
      const days = daysBetween(today.ms, due);
      if (days === null || due > through) continue;
      items.push({
        obligation: "H-15 inactive-well test",
        form: "Form H-15",
        subject: w.api_number.trim(),
        due_date: due,
        days_until: days,
        overdue: days < 0,
        detail: { last_test_date: w.test_date, current_status: w.status },
      });
    }

    for (const p of permits) {
      const days = p.expires_date ? daysBetween(today.ms, p.expires_date) : null;
      items.push({
        obligation: "Drilling permit expires",
        form: "Form W-1 permit",
        subject: p.permit_number ?? "",
        due_date: p.expires_date,
        days_until: days,
        overdue: days !== null && days < 0,
        detail: { lease_name: p.lease_name },
      });
    }

    const rec = record[0] ?? null;
    if (rec?.last_p5_date) {
      const due = addMonthsIso(rec.last_p5_date, P5_TERM_MONTHS);
      const days = daysBetween(today.ms, due);
      if (days !== null && due <= through) {
        items.push({
          obligation: "P-5 organisation report renewal",
          form: "Form P-5",
          subject: operatorNo,
          due_date: due,
          days_until: days,
          overdue: days < 0,
          detail: {
            last_filed: rec.last_p5_date,
            term_months: P5_TERM_MONTHS,
            p5_status: rec.p5_status,
          },
        });
      }
    }

    for (const w of inactive) {
      const monthsInactive = (w.inact_yrs ?? 0) * 12 + (w.inact_mos ?? 0);
      items.push({
        obligation: "14(b)(2) inactivity clock already run",
        form: "Statewide Rule 14(b)(2)",
        subject: w.api_number.trim(),
        // No due date: the mirror carries the inactivity clock but not the
        // expiry of any extension granted against it. Reported as already past
        // rather than given a date this record cannot support.
        due_date: null,
        days_until: null,
        overdue: true,
        detail: {
          lease_name: w.lease_name,
          months_inactive: monthsInactive,
          months_past_clock: monthsInactive - INACTIVE_CLOCK_MONTHS,
          flagged_14b2: w.flagged,
        },
      });
    }

    items.sort((a, b) => {
      if (a.days_until === null) return b.days_until === null ? 0 : 1;
      if (b.days_until === null) return -1;
      return a.days_until - b.days_until;
    });

    return {
      ok: true as const,
      operator_no: operatorNo,
      operator_name: rec?.operator_name ?? null,
      as_of: today.iso,
      horizon_months: horizon,
      through,
      counts: {
        total: items.length,
        overdue: items.filter((i) => i.overdue).length,
        h15: items.filter((i) => i.form === "Form H-15").length,
        permits: items.filter((i) => i.form === "Form W-1 permit").length,
        inactivity: items.filter((i) => i.form === "Statewide Rule 14(b)(2)").length,
      },
      obligations: items.slice(0, limit),
      truncated: items.length > limit,
      notes: [
        `The window runs from ${today.iso} to ${through}, and days_until is whole calendar days from as_of. A negative value is already past due.`,
        "H-15 due dates come from the tape's next-test YEAR and MONTH, which carry no day, so each is anchored on the first of that month: the earliest the obligation can fall.",
        "The mirror carries the 14(b)(2) inactivity clock but NOT the expiry of any extension granted against it, so those wells are listed as already past the clock with no date rather than given one this record cannot support.",
        "The P-5 renewal is the last filing date plus the twelve-month term. That is the Commission's cycle, not a date printed on the record.",
        "Permit expirations are only those already in the file. A permit issued tomorrow is not here.",
        NO_PRICE,
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [
  acquisitionScreen,
  distressSignal,
  idleWithReserves,
  reentryScreen,
  boltOn,
  transactionHistory,
  operatorExit,
  estateMap,
  packageValueDrivers,
  liabilityCheck,
  whySelling,
  sellerAsymmetry,
  obligationCalendar,
];
