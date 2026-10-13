import "server-only";

import { z } from "zod";

import { rrcQuery, rrcQueryOne } from "@/lib/scout/rrc-db";
import { RRC_TO_PDQ } from "@/lib/scout/rrc-districts";
import {
  getCycleEdge,
  getOperatorDossier,
  listPermits,
  resolveCounty,
} from "@/lib/scout/rrc-queries";
import { addMonths, median, monthsBetween, percentile } from "../math";
import { defineTool, type RrcTool } from "../tool";

/**
 * Operators as counterparties: how sound one looks, what it would cost to walk
 * away, what changed lately, how fast it turns a permit into a barrel, and one
 * general aggregate for the compositional questions the canned dossiers cannot
 * express.
 *
 * Four rules run through every tool here.
 *
 *  1. THE RRC RUNS ABOUT THREE MONTHS BEHIND and unfiled cycles sit in the
 *     mirror as zeros. Every production window below ends at
 *     `getCycleEdge().reported`, never at today. Anchored on the calendar, an
 *     operator that files normally reads as one that stopped producing.
 *  2. A WELL COUNT IS A SCHEDULE COUNT. `on_schedule = 'Y'` is the wells the RRC
 *     currently carries against that P-5, which is not the wells the operator
 *     has ever had, and not the wells they drilled. Every count says which.
 *  3. NO SQL IS EVER BUILT FROM CALLER TEXT. `rrc_aggregate` picks its group-by,
 *     its metric and its filter fragments out of fixed maps declared in this
 *     file, and every value the caller supplied is bound as a parameter. An
 *     off-allowlist key is a refusal, not a query.
 *  4. THE MIRROR HAS NO PRICES. `rrc_plugging_liability` derives physical
 *     quantities and refuses to convert them into money, per the same rule that
 *     keeps every other tool in this catalog out of valuation.
 */

const LAG_NOTE = (edge: string) =>
  `Production is measured through ${edge}, the last cycle the RRC has published. Later months are unfiled, not idle.`;

const SCHEDULE_NOTE =
  "Well counts are wellbores currently ON SCHEDULE to this operator (on_schedule = 'Y'), which is not the same as wells they have ever operated: a hole transferred away or dropped from the schedule is not here, and one inherited from a predecessor is.";

/** The largest list any one of these tools will send back. */
const ROW_CAP = 200;

function fail(error: string) {
  return { ok: false as const, error };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** 0 to 1, for a component score that must not run off either end. */
function unit(n: number): number {
  return clamp(n, 0, 1);
}

/** Barrels of oil equivalent from the four RRC streams, gas at 6:1. */
function boe(oil: number, gas: number, cond: number, csgd: number): number {
  return oil + cond + (gas + csgd) / 6;
}

// --------------------------------------------------------------------- scope

/**
 * The narrowing arguments shared by the three area tools.
 *
 * `district` is the district a person says: 01-06, 6E, 7B, 7C, 08, 8A, 09, 10.
 * The mirror carries TWO district codings and "08" is a valid, DIFFERENT
 * district in each, so accepting the internal PDQ code here would silently
 * answer for the wrong quarter of Texas. See `rrc-districts.ts`.
 */
const SCOPE_SHAPE = {
  operator_no: z.string().optional(),
  county: z.string().optional(),
  district: z.string().optional(),
};

interface Scope {
  operatorNo: string | null;
  countyNo: string | null;
  countyName: string | null;
  /** The label the wellbore and completion tapes use. */
  districtEwa: string | null;
  /** The internal code the production and permit tapes use. */
  districtPdq: string | null;
}

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
    return { error: "Needs at least one of operator_no, county or district." };
  }
  return { operatorNo, countyNo, countyName, districtEwa, districtPdq };
}

function isScopeError(s: Scope | { error: string }): s is { error: string } {
  return "error" in s;
}

/**
 * A parameterised where-clause builder.
 *
 * Fragments are literals written in this file; only values ever reach `params`.
 * Each `$?` in a fragment is rewritten to the real position, the same trick
 * `listPermits` uses, so a fragment cannot carry a hardcoded parameter number
 * that goes stale when the caller supplies a different set of filters.
 */
function clauses() {
  const where: string[] = [];
  const params: unknown[] = [];
  return {
    where,
    params,
    /** One fragment and its values, in the order its `$?` markers appear. */
    add(fragment: string, ...values: unknown[]) {
      let out = fragment;
      for (const value of values) {
        params.push(value);
        out = out.replace("$?", `$${params.length}`);
      }
      where.push(out);
    },
    /** A value bound outside the where clause. Returns its placeholder. */
    bind(value: unknown): string {
      params.push(value);
      return `$${params.length}`;
    },
    sql(prefix = "where") {
      return where.length ? `${prefix} ${where.join(" and ")}` : "";
    },
  };
}

// ------------------------------------------------------------------------ 30

/**
 * The composite weights. ASSERTED, NOT FITTED.
 *
 * Nothing in this file learned these numbers from outcomes: no backtest says a
 * 14(b)(2) flag rate is worth five halves of a P-5 status. They encode one
 * judgement, that the two things which cost a buyer money (wells the state had
 * to plug, wells the operator cannot legally produce) should outweigh the two
 * that are merely paperwork. Tool 61 in the expansion plan (`rrc_backtest`)
 * exists precisely so these can be earned rather than declared, and until it
 * does the result carries every component separately so a reader can disagree
 * with the weighting and rescore by hand.
 */
const HEALTH_WEIGHTS = {
  flag_14b2: 0.25,
  h15_delinquency: 0.2,
  plugged_share: 0.15,
  state_funded_plugs: 0.2,
  p5_status: 0.1,
  production_trend: 0.1,
} as const;

type HealthComponent = keyof typeof HEALTH_WEIGHTS;

/**
 * The value at which each component scores zero. Also asserted.
 *
 * A floor rather than a curve because a curve implies a distribution nobody
 * measured. Read them as "this much is as bad as it gets for scoring purposes",
 * not as "this much is the industry norm".
 */
const HEALTH_FLOORS = {
  /** Share of the fleet flagged under 14(b)(2). */
  flag_rate: 0.25,
  /** Share of H-15 tested wells whose most recent filing is delinquent. */
  h15_rate: 0.25,
  /** Share of the schedule already plugged. */
  plugged_share: 0.6,
  /** Wells the STATE had to plug. Three is a pattern, not an accident. */
  state_funded_wells: 3,
  /** Trailing-12 production change against the prior 12. */
  production_change: -0.5,
} as const;

/**
 * P-5 status to a score. 'A' is an active organisation report, 'D' delinquent.
 * Everything else ('I' inactive, 'X', 'S', 'H', 'R') scores the middle: it is
 * not a red flag on its own and not a clean bill either.
 */
function p5Score(status: string | null): number {
  const s = (status ?? "").trim().toUpperCase();
  if (s === "A") return 1;
  if (s === "D") return 0;
  return 0.5;
}

const operatorHealth = defineTool(
  "rrc_operator_health",
  "Composite counterparty score for one operator from 14(b)(2) flags, H-15 delinquency, plugged share, state-funded plugs, P-5 status and production trend, with every component reported separately.",
  { operator_no: z.string() },
  async ({ operator_no }) => {
    const key = operator_no.trim();
    if (!key) return fail("operator_no is required.");

    const dossier = await getOperatorDossier(key);
    if (!dossier) return fail(`No operator ${key}.`);

    // Attributed through the schedule, which is the only join the mirror
    // offers: wb_plug_summary carries no operator. So this is "wells the state
    // plugged that are on THIS operator's schedule today", which can credit a
    // successor with a predecessor's orphans. Stated on the result.
    const plugRow = await rrcQueryOne<{ state_funded: number; plugged: number }>(
      `select count(*) filter (where s.state_funded)::int as state_funded,
              count(*)::int                               as plugged
         from rrc.wb_plug_summary s
         join rrc.wellbore w on w.api_number = s.api_number
        where w.operator_number = $1 and w.on_schedule = 'Y'`,
      [key]
    );
    const stateFunded = plugRow?.state_funded ?? 0;

    const onSchedule = dossier.wells.total;
    const tested = dossier.h15.wellsTested;

    // Anchored on the reported edge rather than the calendar: the last three
    // cycles in the mirror are zeros for everyone, and a trend fitted through
    // them says every operator in Texas is collapsing.
    const reported = dossier.monthly.filter((m) => m.reported);
    const window = (from: number, count: number) =>
      from < 0
        ? null
        : reported
            .slice(from, from + count)
            .reduce(
              (a, m) =>
                a +
                boe(
                  m.oil_prod_vol ?? 0,
                  m.gas_prod_vol ?? 0,
                  m.cond_prod_vol ?? 0,
                  m.csgd_prod_vol ?? 0
                ),
              0
            );
    const last12 = window(reported.length - 12, 12);
    const prior12 = window(reported.length - 24, 12);
    const trend = last12 !== null && prior12 ? last12 / prior12 - 1 : null;

    const flagRate = onSchedule > 0 ? dossier.wells.flagged14b2 / onSchedule : null;
    const h15Rate = tested > 0 ? dossier.h15.delinquent / tested : null;
    const pluggedShare = onSchedule > 0 ? dossier.wells.plugged / onSchedule : null;

    /** 1 is clean, 0 is at or past the floor. Null when there is nothing to score. */
    const scores: Record<HealthComponent, { raw: number | null; score: number | null }> = {
      flag_14b2: {
        raw: flagRate,
        score: flagRate === null ? null : 1 - unit(flagRate / HEALTH_FLOORS.flag_rate),
      },
      h15_delinquency: {
        raw: h15Rate,
        score: h15Rate === null ? null : 1 - unit(h15Rate / HEALTH_FLOORS.h15_rate),
      },
      plugged_share: {
        raw: pluggedShare,
        score:
          pluggedShare === null ? null : 1 - unit(pluggedShare / HEALTH_FLOORS.plugged_share),
      },
      state_funded_plugs: {
        raw: stateFunded,
        score: 1 - unit(stateFunded / HEALTH_FLOORS.state_funded_wells),
      },
      p5_status: { raw: null, score: p5Score(dossier.record.p5_status) },
      production_trend: {
        raw: trend,
        score: trend === null ? null : unit(1 + trend / -HEALTH_FLOORS.production_change),
      },
    };

    // Renormalised over the components that could be scored. An unscored
    // component held at zero would punish an operator for a table being empty,
    // and held at one would flatter them for the same thing.
    const components = (Object.keys(HEALTH_WEIGHTS) as HealthComponent[]).map((name) => ({
      component: name,
      weight: HEALTH_WEIGHTS[name],
      raw: scores[name].raw,
      score: scores[name].score,
    }));
    const scored = components.filter((c) => c.score !== null);
    const weightUsed = scored.reduce((a, c) => a + c.weight, 0);
    const composite =
      weightUsed > 0
        ? (scored.reduce((a, c) => a + c.weight * (c.score as number), 0) / weightUsed) * 100
        : null;

    return {
      ok: true as const,
      operator_no: key,
      operator_name: dossier.record.operator_name,
      p5_status: dossier.record.p5_status,
      reported_through: reported.at(-1)?.cycle ?? null,
      wells_on_schedule: onSchedule,
      h15_wells_tested: tested,
      composite_score: composite,
      scale: "0 to 100, higher is cleaner. Not a probability and not a rating.",
      weight_used: weightUsed,
      components,
      weights: HEALTH_WEIGHTS,
      floors: HEALTH_FLOORS,
      inputs: {
        flagged_14b2_wells: dossier.wells.flagged14b2,
        h15_delinquent_wells: dossier.h15.delinquent,
        plugged_wells_on_schedule: dossier.wells.plugged,
        state_funded_plugs: stateFunded,
        w3_plugging_jobs_on_schedule: plugRow?.plugged ?? 0,
        boe_last_12: last12,
        boe_prior_12: prior12,
        production_change: trend,
      },
      notes: [
        "The weights are ASSERTED, not fitted: no backtest earned them. They are returned with the score so the composite can be argued with, and every component is reported raw so it can be reweighted by hand.",
        SCHEDULE_NOTE,
        "H-15 delinquency is counted per WELL by its most recent filing, not per filing. A well delinquent in 2019 and current since is not a liability today.",
        "State-funded plugs are attributed through the schedule, because the plugging record carries no operator. A hole inherited from a predecessor counts against whoever holds it now.",
        "A high plugged share is ambiguous: an operator who plugs its own wells is doing the right thing. It scores as risk here because it also marks a shrinking fleet.",
        "plugged_wells_on_schedule and w3_plugging_jobs_on_schedule are DIFFERENT counts and will not agree. The first is the schedule's own plugged marker (wellbore.plug_date), which is what the operator screen shows and what the plugged-share component scores. The second is filed W-3 jobs on those same holes, which includes plug-backs and holes later re-entered, so a well can carry a job and no plug date.",
        "Trailing 12 months against the prior 12, both ending at the reported edge, never at today.",
      ],
    };
  }
);

// ------------------------------------------------------------------------ 31

/**
 * Depth bands for plugging comparables, feet.
 *
 * Depth is the axis the physical job actually scales on: a deeper hole needs
 * more plugs, more sacks, and more rig time. The bands are wide because the
 * comparables are statewide and a narrow band would trade sample size for a
 * precision the source does not support.
 */
const PLUG_BANDS = [
  { band: "0-2500", min: 0, max: 2500 },
  { band: "2500-5000", min: 2500, max: 5000 },
  { band: "5000-7500", min: 5000, max: 7500 },
  { band: "7500-10000", min: 7500, max: 10000 },
  { band: "10000+", min: 10000, max: Infinity },
] as const;

/** How far back a completed job still counts as comparable. */
const COMPARABLE_SINCE = "2010-01-01";

/**
 * The band CASE, generated from the constant above so the SQL buckets and the
 * JS buckets cannot drift apart. Every number here is coerced, and none of it
 * comes from a caller.
 */
function bandCase(column: string): string {
  const arms = PLUG_BANDS.filter((b) => Number.isFinite(b.max)).map(
    (b) => `when ${column} < ${Number(b.max)} then '${b.band}'`
  );
  return `case ${arms.join(" ")} else '${PLUG_BANDS[PLUG_BANDS.length - 1].band}' end`;
}

function bandOf(depthFt: number | null): string | null {
  if (depthFt === null || !Number.isFinite(depthFt) || depthFt <= 0) return null;
  return PLUG_BANDS.find((b) => depthFt >= b.min && depthFt < b.max)?.band ?? null;
}

const pluggingLiability = defineTool(
  "rrc_plugging_liability",
  "Physical plugging burden for an operator's inactive unplugged wells: well count, footage, cement plugs and cement sacks from comparable completed jobs by depth band. Returns no cost.",
  { operator_no: z.string(), inactive_years: z.number().int().nonnegative().optional() },
  async ({ operator_no, inactive_years }) => {
    const key = operator_no.trim();
    if (!key) return fail("operator_no is required.");
    // One year is the 14(b)(2) trigger: past twelve months of inactivity a well
    // needs an extension to stay unplugged, so that is where the burden starts.
    const threshold = clamp(Math.floor(inactive_years ?? 1), 0, 99);

    const dossier = await getOperatorDossier(key);
    if (!dossier) return fail(`No operator ${key}.`);

    // Its OWN query, not `dossier.wellRows`. That list is capped, so filtering
    // it would count the inactive wells among the first 2,000 holes by API and
    // report the result as the operator's whole burden. Undercounting a
    // liability quietly is the one direction this tool must not fail in, and
    // the filter is narrow enough that asking the database is cheaper anyway.
    const inactive = await rrcQuery<{ api_depth: number | null }>(
      `select nullif(api_depth,'')::bigint as api_depth
         from rrc.wellbore
        where operator_number = $1
          and on_schedule = 'Y'
          and nullif(plug_date,'') is null
          and coalesce(nullif(curr_inact_yrs,'')::bigint, 0) >= $2`,
      [key, threshold]
    );

    // Statewide comparables, no join: wb_plug_summary carries depth, plug count
    // and cement sacks on its own, and restricting to the operator's own
    // districts costs a 1.37M-row scan to buy a smaller sample.
    const comparables = await rrcQuery<{
      band: string;
      jobs: number;
      median_plugs: number | null;
      median_sacks: number | null;
      median_depth: number | null;
    }>(
      `select ${bandCase("total_depth")} as band,
              count(*)::int as jobs,
              percentile_cont(0.5) within group (order by plugs)        as median_plugs,
              percentile_cont(0.5) within group (order by cement_sacks) as median_sacks,
              percentile_cont(0.5) within group (order by total_depth)  as median_depth
         from rrc.wb_plug_summary
        where plug_date >= $1::date and total_depth > 0
        group by 1`,
      [COMPARABLE_SINCE]
    );
    const byBand = new Map(comparables.map((c) => [c.band, c]));

    const bands = PLUG_BANDS.map((b) => {
      const wells = inactive.filter((w) => bandOf(w.api_depth) === b.band);
      const c = byBand.get(b.band);
      const plugs = c?.median_plugs ?? null;
      const sacks = c?.median_sacks ?? null;
      return {
        band: b.band,
        depth_ft: { from: b.min, to: Number.isFinite(b.max) ? b.max : null },
        wells: wells.length,
        median_well_depth_ft: median(
          wells.map((w) => w.api_depth).filter((d): d is number => d != null)
        ),
        comparable_jobs: c?.jobs ?? 0,
        median_plugs_per_job: plugs,
        median_cement_sacks_per_job: sacks,
        estimated_plugs: plugs === null ? null : plugs * wells.length,
        estimated_cement_sacks: sacks === null ? null : sacks * wells.length,
      };
    }).filter((b) => b.wells > 0);

    const unknownDepth = inactive.filter((w) => bandOf(w.api_depth) === null);
    const total = (pick: (b: (typeof bands)[number]) => number | null) =>
      bands.reduce((a, b) => a + (pick(b) ?? 0), 0);

    return {
      ok: true as const,
      operator_no: key,
      operator_name: dossier.record.operator_name,
      inactive_years_threshold: threshold,
      wells_on_schedule: dossier.wells.total,
      inactive_unplugged_wells: inactive.length,
      wells_scored: inactive.length - unknownDepth.length,
      wells_without_depth: unknownDepth.length,
      by_band: bands,
      totals: {
        wells: inactive.length - unknownDepth.length,
        estimated_plugs: total((b) => b.estimated_plugs),
        estimated_cement_sacks: total((b) => b.estimated_cement_sacks),
        total_footage_ft: inactive.reduce((a, w) => a + (w.api_depth ?? 0), 0),
      },
      comparables_since: COMPARABLE_SINCE,
      comparables_scope: "statewide",
      // The refusal, as a value. Named plainly so a reader who scanned only the
      // keys still sees that no money was produced here.
      dollars: null,
      cost_estimate_refused:
        "The Texas RRC publishes NO plugging cost data: not a contractor invoice, not a bond draw, not a state expenditure per well. Converting these quantities into dollars would require a rate card this tool does not have and the public record cannot supply, so it returns physical quantities only. Price them against your own contractor bids.",
      notes: [
        "Plugs and cement sacks are MEDIANS of completed jobs in the same depth band, applied to the well count. They size the job; they are not an engineering design and no plugging plan should be written from them.",
        "Comparables are statewide. Cement volume varies with hole size, casing left in place and usable-water depth, none of which is matched here.",
        SCHEDULE_NOTE,
        "Inactivity is the RRC's own clock (curr_inact_yrs). A well with no depth on file is counted in the well total and left out of the quantity estimate rather than guessed at.",
      ],
      truncated: false,
    };
  }
);

// ------------------------------------------------------------------------ 32

/** Per-class caps. Each list says separately whether it was cut. */
const DIFF_CAP = 100;

const P4_CHANGE_COLUMNS = [
  { col: "chg_operator", label: "Operator" },
  { col: "chg_purchaser", label: "Purchaser" },
  { col: "chg_gatherer", label: "Gatherer" },
  { col: "chg_purch_system", label: "Purchaser system" },
] as const;

const activityDiff = defineTool(
  "rrc_activity_diff",
  "What changed for an operator, county or district between two dates: new permits, P-4 operator transfers, purchaser changes, first production and new plugging jobs.",
  { ...SCOPE_SHAPE, since: z.string(), until: z.string().optional() },
  async (args) => {
    const scope = resolveScope(args);
    if (isScopeError(scope)) return fail(scope.error);

    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const since = args.since.trim();
    if (!DATE.test(since)) return fail("since must be YYYY-MM-DD.");
    const until = (args.until ?? new Date().toISOString().slice(0, 10)).trim();
    if (!DATE.test(until)) return fail("until must be YYYY-MM-DD.");
    if (until < since) return fail("until must not precede since.");

    const edge = await getCycleEdge();

    // 1. Permits. Reuses the existing filter path so a permit listed here and a
    // permit listed on the operator dossier are the same query, not two.
    const permits = await listPermits({
      operatorNo: scope.operatorNo ?? undefined,
      county: scope.countyNo ?? undefined,
      district: scope.districtEwa ?? undefined,
      since,
      until,
      limit: DIFF_CAP,
    });

    // 2 and 3. P-4 filings: transfers and purchaser changes come off the same
    // read, split in JS. The tape carries no county, so a county-only scope
    // cannot ask this question and says so rather than returning an empty list.
    const p4Scope = scope.operatorNo || scope.districtPdq;
    const p4 = p4Scope
      ? await (async () => {
          const c = clauses();
          c.add("f.record_type <> 'D'");
          c.add("f.effective_date >= $?::date", since);
          c.add("f.effective_date <= $?::date", until);
          if (scope.operatorNo) c.add("f.operator_no = $?", scope.operatorNo);
          if (scope.districtPdq) c.add("f.district = $?", scope.districtPdq);
          c.add(
            `(${P4_CHANGE_COLUMNS.map((x) => `f.${x.col} = 'Y'`).join(" or ")})`
          );
          const cap = c.bind(DIFF_CAP + 1);
          return rrcQuery<{
            effective_date: string | null;
            oil_gas_code: string;
            district: string;
            lease_no: string;
            operator_no: string | null;
            operator_name: string | null;
            chg_operator: string | null;
            chg_purchaser: string | null;
            chg_gatherer: string | null;
            chg_purch_system: string | null;
          }>(
            `select to_char(f.effective_date, 'YYYY-MM-DD') as effective_date,
                    f.oil_gas_code, f.district, f.lease_no, f.operator_no,
                    o.operator_name,
                    ${P4_CHANGE_COLUMNS.map((x) => `f.${x.col}`).join(", ")}
               from rrc.p4_filing f
               left join rrc.operators o on o.operator_number = f.operator_no
              ${c.sql()}
              order by f.effective_date desc
              limit ${cap}`,
            c.params
          );
        })()
      : [];

    const p4Rows = p4.slice(0, DIFF_CAP).map((r) => ({
      effective_date: r.effective_date,
      lease: `${r.oil_gas_code}/${r.district}/${r.lease_no}`,
      operator_no: r.operator_no?.trim() ?? null,
      operator_name: r.operator_name,
      changes: P4_CHANGE_COLUMNS.filter(
        (x) => (r as unknown as Record<string, string | null>)[x.col] === "Y"
      ).map((x) => x.label),
    }));

    // 4. First production. Two steps on purpose: the window read is bounded by
    // cycle so Timescale prunes to recent chunks, and only the leases it
    // returned are checked against their whole history, one indexed probe each.
    // Bounded at the reported edge, because a lease whose first cycle has not
    // been published yet has not "started" as far as this file knows.
    const prodUntil = `${edge.reported}-01` < until ? `${edge.reported}-01` : until;
    const firstProd =
      prodUntil >= since
        ? await (async () => {
            const c = clauses();
            c.add("p.cycle >= $?::date", since);
            c.add("p.cycle <= $?::date", prodUntil);
            c.add("(p.cnty_lse_oil_prod_vol > 0 or p.cnty_lse_gas_prod_vol > 0)");
            if (scope.operatorNo) c.add("p.operator_no = $?", scope.operatorNo);
            if (scope.countyNo) c.add("p.county_no = $?", scope.countyNo);
            if (scope.districtPdq) c.add("p.district_no = $?", scope.districtPdq);
            const candidateCap = c.bind(DIFF_CAP + 1);
            const firstAfter = c.bind(since);
            return rrcQuery<{
              oil_gas_code: string;
              district_no: string;
              lease_no: string;
              lease_name: string | null;
              operator_name: string | null;
              first_cycle: string | null;
            }>(
              `with candidate as (
                 select p.oil_gas_code, p.district_no, p.lease_no,
                        max(p.lease_name)    as lease_name,
                        max(p.operator_name) as operator_name
                   from rrc.county_lease_cycle p
                  ${c.sql()}
                  group by 1,2,3
                  limit ${candidateCap}
               )
               select c.oil_gas_code, c.district_no, c.lease_no, c.lease_name,
                      c.operator_name, to_char(f.first_cycle, 'YYYY-MM') as first_cycle
                 from candidate c
                 join lateral (
                   select min(lp.cycle) as first_cycle
                     from rrc.lease_production lp
                    where lp.oil_gas_code = c.oil_gas_code
                      and lp.district_no  = c.district_no
                      and lp.lease_no     = c.lease_no
                      and (lp.oil_prod_vol > 0 or lp.gas_prod_vol > 0)
                 ) f on true
                where f.first_cycle >= ${firstAfter}::date
                order by f.first_cycle desc`,
              c.params
            );
          })()
        : [];

    // 5. Plugging jobs. Attributed through the schedule, same caveat as tool 30.
    const plugC = clauses();
    plugC.add("s.plug_date >= $?::date", since);
    plugC.add("s.plug_date <= $?::date", until);
    if (scope.operatorNo) plugC.add("w.operator_number = $?", scope.operatorNo);
    if (scope.countyNo) plugC.add("w.county_code = $?", scope.countyNo);
    if (scope.districtEwa) plugC.add("w.district = $?", scope.districtEwa);
    const plugCap = plugC.bind(DIFF_CAP + 1);
    const plugs = await rrcQuery<{
      api_number: string;
      plug_date: string | null;
      lease_name: string | null;
      operator_name: string | null;
      total_depth: number | null;
      state_funded: boolean;
    }>(
      `select s.api_number, to_char(s.plug_date, 'YYYY-MM-DD') as plug_date,
              w.lease_name, w.operator_name, s.total_depth, s.state_funded
         from rrc.wb_plug_summary s
         join rrc.wellbore w on w.api_number = s.api_number
        ${plugC.sql()}
        order by s.plug_date desc
        limit ${plugCap}`,
      plugC.params
    );

    const transfers = p4Rows.filter((r) => r.changes.includes("Operator"));
    const purchasers = p4Rows.filter((r) =>
      r.changes.some((ch) => ch !== "Operator")
    );

    return {
      ok: true as const,
      scope: {
        operator_no: scope.operatorNo,
        county: scope.countyName,
        county_no: scope.countyNo,
        district: scope.districtEwa,
      },
      since,
      until,
      reported_through: edge.reported,
      new_permits: {
        count: permits.length,
        truncated: permits.length >= DIFF_CAP,
        rows: permits.map((p) => ({
          permit_number: p.permit_number,
          issued_date: p.issued_date,
          lease_name: p.lease_name,
          well_number: p.well_number,
          county_name: p.county_name,
          operator_name: p.operator_name,
          total_depth: p.total_depth,
        })),
      },
      operator_transfers: {
        count: transfers.length,
        truncated: p4.length > DIFF_CAP,
        rows: transfers,
      },
      purchaser_changes: {
        count: purchasers.length,
        truncated: p4.length > DIFF_CAP,
        rows: purchasers,
      },
      first_production: {
        count: firstProd.length,
        truncated: firstProd.length >= DIFF_CAP,
        measured_through: prodUntil,
        rows: firstProd.map((r) => ({
          lease: `${r.oil_gas_code}/${r.district_no}/${r.lease_no}`,
          lease_name: r.lease_name,
          operator_name: r.operator_name,
          first_cycle: r.first_cycle,
        })),
      },
      new_plugs: {
        count: Math.min(plugs.length, DIFF_CAP),
        truncated: plugs.length > DIFF_CAP,
        state_funded: plugs.slice(0, DIFF_CAP).filter((p) => p.state_funded).length,
        rows: plugs.slice(0, DIFF_CAP),
      },
      truncated:
        permits.length >= DIFF_CAP ||
        p4.length > DIFF_CAP ||
        firstProd.length >= DIFF_CAP ||
        plugs.length > DIFF_CAP,
      notes: [
        LAG_NOTE(edge.reported),
        "Permits, P-4 filings and plugging jobs are dated by FILING, so their window is the calendar one you asked for. First production is dated by production cycle and stops at the reported edge.",
        p4Scope
          ? "P-4 filings are matched on the filing's own operator and district."
          : "P-4 filings were NOT read: the P-4 tape carries no county, so a county-only scope cannot ask for transfers or purchaser changes. Add operator_no or district.",
        "First production means the lease's earliest reported producing cycle in the whole mirror falls inside the window. A new well on an existing lease does not appear: Texas publishes volumes at lease grain, so it has no first month of its own.",
        SCHEDULE_NOTE,
      ],
    };
  }
);

// ------------------------------------------------------------------------ 33

/** How many permits the first-production lag is measured over. */
const LAG_SAMPLE = 200;
/** How far back the lag sample reaches. */
const LAG_LOOKBACK_MONTHS = 60;

const permitCycle = defineTool(
  "rrc_permit_cycle",
  "Permit rate trailing 12 against prior 12, permit to first production lag, and spud to completion days for an operator, county or district.",
  { ...SCOPE_SHAPE },
  async (args) => {
    const scope = resolveScope(args);
    if (isScopeError(scope)) return fail(scope.error);

    const [edge, edgeRow] = await Promise.all([
      getCycleEdge(),
      // The PERMIT tape's own edge, not the production edge. Permits are issued
      // and loaded within days, so anchoring them on the three-month production
      // lag would throw away a quarter of real activity.
      rrcQueryOne<{ permit_edge: string | null }>(
        `select to_char(max(issued_date), 'YYYY-MM') as permit_edge from rrc.permit`
      ),
    ]);
    const permitEdge = edgeRow?.permit_edge ?? null;
    if (!permitEdge) return fail("No issued permits in the mirror.");

    // Monthly counts, not a pair of totals: 24 rows is nothing to send, the
    // trailing and prior windows are then arithmetic rather than SQL, and the
    // months themselves show whether a change is a trend or one busy quarter.
    const permitC = clauses();
    permitC.add("p.issued_date is not null");
    // Inclusive of the first day of the month 23 back and of every day in the
    // edge month: the two twelve-month windows must tile exactly, or the split
    // silently drops a month at the seam.
    permitC.add(
      "p.issued_date >= (to_date($?, 'YYYY-MM') - interval '23 months')",
      permitEdge
    );
    permitC.add(
      "p.issued_date < (to_date($?, 'YYYY-MM') + interval '1 month')",
      permitEdge
    );
    if (scope.operatorNo) permitC.add("p.operator_number = $?", scope.operatorNo);
    if (scope.countyNo) permitC.add("p.county_code = $?", scope.countyNo);
    if (scope.districtPdq) permitC.add("p.district = $?", scope.districtPdq);
    const monthly = await rrcQuery<{ cycle: string; permits: number }>(
      `select to_char(date_trunc('month', p.issued_date), 'YYYY-MM') as cycle,
              count(*)::int as permits
         from rrc.permit p
        ${permitC.sql()}
        group by 1
        order by 1`,
      permitC.params
    );

    // Trailing 12 is the twelve months ENDING at the permit edge, inclusive.
    // Prior 12 is the twelve before that. Months with no permit are absent from
    // the read and count as zero here, which for a filing date is correct: a
    // month nobody filed in really is a month of no permits.
    const inWindow = (cycle: string, from: number, to: number) => {
      const back = monthsBetween(cycle, permitEdge);
      return back >= from && back <= to;
    };
    const countIn = (from: number, to: number) =>
      monthly.filter((m) => inWindow(m.cycle, from, to)).reduce((a, m) => a + m.permits, 0);
    const trailing12 = countIn(0, 11);
    const prior12 = countIn(12, 23);

    // Lag: permit -> the lease's first reported producing cycle. Linked through
    // rrc.wellbore.recent_permit, which is the only permit-to-lease join the
    // mirror carries, and zero-padded to the permit tape's seven digits.
    const lagC = clauses();
    lagC.add("p.issued_date is not null");
    lagC.add(
      "p.issued_date >= (to_date($?, 'YYYY-MM') - make_interval(months => $?::int))",
      permitEdge,
      LAG_LOOKBACK_MONTHS
    );
    if (scope.operatorNo) lagC.add("p.operator_number = $?", scope.operatorNo);
    if (scope.countyNo) lagC.add("p.county_code = $?", scope.countyNo);
    if (scope.districtPdq) lagC.add("p.district = $?", scope.districtPdq);
    const lagCap = lagC.bind(LAG_SAMPLE);

    const lagRows = await rrcQuery<{
      permit_number: string;
      issued_cycle: string;
      first_cycle: string | null;
      had_prior_production: boolean;
    }>(
      `with linked as (
         select distinct on (p.permit_number)
                p.permit_number, p.issued_date, w.oil_gas_code, w.lease_number,
                case w.district
                  ${Object.entries(RRC_TO_PDQ)
                    .map(([ewa, pdq]) => `when '${ewa}' then '${pdq}'`)
                    .join(" ")}
                  else w.district end as district_no
           from rrc.permit p
           join rrc.wellbore w on lpad(w.recent_permit, 7, '0') = p.permit_number
          ${lagC.sql()}
          order by p.permit_number, p.issued_date desc
          limit ${lagCap}
       )
       select l.permit_number,
              to_char(l.issued_date, 'YYYY-MM')  as issued_cycle,
              to_char(f.first_cycle, 'YYYY-MM')  as first_cycle,
              coalesce(pr.existed, false)        as had_prior_production
         from linked l
         left join lateral (
           select min(lp.cycle) as first_cycle
             from rrc.lease_production lp
            where lp.oil_gas_code = l.oil_gas_code
              and lp.district_no  = l.district_no
              and lp.lease_no     = l.lease_number
              and lp.cycle >= l.issued_date
              and (lp.oil_prod_vol > 0 or lp.gas_prod_vol > 0)
         ) f on true
         left join lateral (
           select true as existed
             from rrc.lease_production lp
            where lp.oil_gas_code = l.oil_gas_code
              and lp.district_no  = l.district_no
              and lp.lease_no     = l.lease_number
              and lp.cycle < l.issued_date
              and (lp.oil_prod_vol > 0 or lp.gas_prod_vol > 0)
            limit 1
         ) pr on true`,
      lagC.params
    );

    // Only permits on a lease that had NEVER produced before the permit issued.
    // On a lease already producing, "first cycle after the permit" is next
    // month by construction and measures nothing.
    const newLease = lagRows.filter((r) => !r.had_prior_production);
    const lags = newLease
      .filter((r) => r.first_cycle)
      .map((r) => monthsBetween(r.issued_cycle, r.first_cycle as string));
    const pending = newLease.filter((r) => !r.first_cycle).length;

    // Spud to completion, from the W-2/G-1 completion report. Its district is
    // the real-world label and its county the numeric code, so both scope keys
    // differ from the permit tape's.
    const cmplC = clauses();
    cmplC.add(String.raw`c.spud_dt ~ '^\d{2}/\d{2}/\d{4}$'`);
    cmplC.add(String.raw`c.cmpl_or_recmpl_date ~ '^\d{2}/\d{2}/\d{4}$'`);
    cmplC.add(
      "to_date(c.cmpl_or_recmpl_date, 'MM/DD/YYYY') >= to_date(c.spud_dt, 'MM/DD/YYYY')"
    );
    if (scope.operatorNo) cmplC.add("c.operator_no = $?", scope.operatorNo);
    if (scope.countyNo) cmplC.add("c.county = $?", scope.countyNo);
    if (scope.districtEwa) cmplC.add("c.district = $?", scope.districtEwa);
    const spud = await rrcQueryOne<{
      jobs: number;
      p10: number | null;
      median_days: number | null;
      p90: number | null;
      first: string | null;
      last: string | null;
    }>(
      `select count(*)::int as jobs,
              percentile_cont(0.1) within group (order by d) as p10,
              percentile_cont(0.5) within group (order by d) as median_days,
              percentile_cont(0.9) within group (order by d) as p90,
              to_char(min(cmpl), 'YYYY-MM') as first,
              to_char(max(cmpl), 'YYYY-MM') as last
         from (
           select to_date(c.cmpl_or_recmpl_date, 'MM/DD/YYYY') - to_date(c.spud_dt, 'MM/DD/YYYY') as d,
                  to_date(c.cmpl_or_recmpl_date, 'MM/DD/YYYY') as cmpl
             from rrc.completion c
            ${cmplC.sql()}
         ) t`,
      cmplC.params
    );

    return {
      ok: true as const,
      scope: {
        operator_no: scope.operatorNo,
        county: scope.countyName,
        county_no: scope.countyNo,
        district: scope.districtEwa,
      },
      permit_edge: permitEdge,
      production_reported_through: edge.reported,
      permits: {
        trailing_12: trailing12,
        prior_12: prior12,
        change: prior12 > 0 ? trailing12 / prior12 - 1 : null,
        monthly: monthly.filter((m) => inWindow(m.cycle, 0, 23)),
      },
      permit_to_first_production: {
        permits_linked: lagRows.length,
        on_new_leases: newLease.length,
        measured: lags.length,
        awaiting_production: pending,
        median_months: median(lags),
        p10_months: percentile(lags, 0.1),
        p90_months: percentile(lags, 0.9),
        sample_cap: LAG_SAMPLE,
        lookback_months: LAG_LOOKBACK_MONTHS,
      },
      spud_to_completion: {
        jobs: spud?.jobs ?? 0,
        median_days: spud?.median_days ?? null,
        p10_days: spud?.p10 ?? null,
        p90_days: spud?.p90 ?? null,
        first_completion: spud?.first ?? null,
        last_completion: spud?.last ?? null,
      },
      truncated: lagRows.length >= LAG_SAMPLE,
      notes: [
        `Permit windows are anchored on the permit tape's own edge (${permitEdge}), not on the calendar and not on the production edge: permits load within days, production runs about three months behind.`,
        LAG_NOTE(edge.reported),
        "The lag is RIGHT-CENSORED and reads short. Only permits whose lease has already reported production can be measured; the ones still waiting are counted separately in awaiting_production and left out of the median.",
        "The lag is measured only on permits whose lease had never produced before the permit issued. An infill on a producing lease has no first month of its own, because Texas publishes volumes at lease grain.",
        "Permits link to leases through rrc.wellbore.recent_permit, which is the most recent permit on that hole. A wellbore permitted twice contributes only its latest.",
        "Spud and completion dates come from the operator's own W-2/G-1 filing and include recompletions, which have no spud of their own and can read as very long or very short jobs.",
      ],
    };
  }
);

// ------------------------------------------------------------------------ 34

/**
 * The whole of `rrc_aggregate`'s SQL surface: three maps of fixed fragments.
 *
 * Nothing a caller sends is ever concatenated into a query. `group_by`,
 * `metric` and each filter name are LOOKED UP in these maps and refused when
 * absent; the values that come with them are bound as parameters. That is the
 * entire security model here, and it is why this is a lookup table rather than
 * a query builder: a builder has to be audited, a table can be read.
 *
 * The fact table is `rrc.county_lease_cycle`, the RRC's own county-by-lease
 * cycle tape. It is the only production grain in the mirror that carries the
 * county, the district, the field, the operator and the lease at once, which is
 * what makes one template answer compositional questions.
 */
const AGG_DIMENSIONS = {
  operator: { key: "p.operator_no", label: "max(p.operator_name)" },
  field: { key: "p.field_no", label: "max(p.field_name)" },
  county: { key: "p.county_no", label: "max(p.county_name)" },
  district: { key: "p.district_no", label: "max(p.district_name)" },
  lease: {
    key: "p.oil_gas_code || '/' || p.district_no || '/' || p.lease_no",
    label: "max(p.lease_name)",
  },
} as const;

const AGG_METRICS = {
  oil_bbl: "sum(coalesce(p.cnty_lse_oil_prod_vol, 0))",
  gas_mcf: "sum(coalesce(p.cnty_lse_gas_prod_vol, 0))",
  cond_bbl: "sum(coalesce(p.cnty_lse_cond_prod_vol, 0))",
  csgd_mcf: "sum(coalesce(p.cnty_lse_csgd_prod_vol, 0))",
  boe: `(sum(coalesce(p.cnty_lse_oil_prod_vol, 0)) + sum(coalesce(p.cnty_lse_cond_prod_vol, 0))
        + (sum(coalesce(p.cnty_lse_gas_prod_vol, 0)) + sum(coalesce(p.cnty_lse_csgd_prod_vol, 0))) / 6.0)`,
  leases: "count(distinct (p.oil_gas_code, p.district_no, p.lease_no))",
  operators: "count(distinct p.operator_no)",
  lease_months: "count(*)",
} as const;

/**
 * Filters, each one fragment plus at most one bound value.
 *
 * The two `exists` filters correlate on the OPERATOR, so they read "this
 * lease-month belongs to an operator who also holds X". They are the reason
 * this tool can answer "operators in this county with a 2024 permit and a
 * commercial disposal well" in one call.
 */
const AGG_FILTERS = {
  county: "p.county_no = $?",
  district: "p.district_no = $?",
  operator_no: "p.operator_no = $?",
  field_no: "p.field_no = $?",
  oil_gas_code: "p.oil_gas_code = $?",
  permit_since:
    "exists (select 1 from rrc.permit x where x.operator_number = p.operator_no and x.issued_date >= $?::date)",
  has_commercial_disposal:
    "exists (select 1 from rrc.uic_live_permit u where u.operator_no = p.operator_no and u.is_commercial and u.inj_type in ('1','2'))",
  has_disposal:
    "exists (select 1 from rrc.uic_live_permit u where u.operator_no = p.operator_no and u.inj_type in ('1','2'))",
} as const;

/**
 * Filters that actually narrow the scan. At least one is required.
 *
 * `rrc.county_lease_cycle` is 76.5M rows behind a 5 s statement timeout, and
 * the `exists` filters do not narrow it: they test each surviving row, they do
 * not stop it being read. A statewide group-by is also rarely the question, so
 * the refusal is cheap to satisfy and saves an answer nobody wanted.
 */
const AGG_NARROWING = ["county", "district", "operator_no", "field_no"] as const;

const AGG_MAX_MONTHS = 240;

const aggregate = defineTool(
  "rrc_aggregate",
  "Group Texas production by operator, field, county, district or lease over a chosen metric, trailing window and filters, including 'has a permit since' and 'has a commercial disposal well'. Needs at least one of county, district, operator_no or field_no; formation is refused because the production tape does not carry one.",
  {
    group_by: z.enum(["operator", "field", "county", "district", "lease", "formation"]),
    metric: z.enum([
      "oil_bbl",
      "gas_mcf",
      "cond_bbl",
      "csgd_mcf",
      "boe",
      "leases",
      "operators",
      "lease_months",
    ]),
    months: z.number().int().positive().optional(),
    county: z.string().optional(),
    district: z.string().optional(),
    operator_no: z.string().optional(),
    field_no: z.string().optional(),
    oil_gas_code: z.enum(["O", "G"]).optional(),
    permit_since: z.string().optional(),
    has_commercial_disposal: z.boolean().optional(),
    has_disposal: z.boolean().optional(),
    min_value: z.number().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    // The mirror carries no formation on the production tape. Accepted as a
    // value and refused with the alternative, rather than left out of the enum
    // to come back as a schema error the model cannot act on.
    if (args.group_by === "formation") {
      return fail(
        "The RRC production tape carries no formation: volumes are reported by lease and field, and formation appears only on completion filings (rrc.completion_formation), at a different grain. Group by 'field' instead, which in Texas usually names the producing formation."
      );
    }

    // Looked up, never built. The Zod enum already rejects an off-allowlist
    // name at the dispatcher; this is the same check where the SQL is, so the
    // guarantee holds for any caller that reaches `run` directly.
    const dims: Record<string, { key: string; label: string } | undefined> = AGG_DIMENSIONS;
    const metrics: Record<string, string | undefined> = AGG_METRICS;
    const dim = dims[args.group_by];
    if (!dim) {
      return fail(
        `Unknown group_by. Allowed: ${Object.keys(AGG_DIMENSIONS).join(", ")}.`
      );
    }
    const metric = metrics[args.metric];
    if (!metric) {
      return fail(`Unknown metric. Allowed: ${Object.keys(AGG_METRICS).join(", ")}.`);
    }

    const narrowing = AGG_NARROWING.filter((k) => {
      const v = args[k];
      return typeof v === "string" && v.trim() !== "";
    });
    if (!narrowing.length) {
      return fail(
        `An unfiltered statewide aggregate is refused: rrc.county_lease_cycle is 76.5M rows behind a 5 s timeout. Supply at least one of ${AGG_NARROWING.join(", ")}.`
      );
    }

    let countyNo: string | null = null;
    let countyName: string | null = null;
    if (args.county?.trim()) {
      const c = resolveCounty(args.county);
      if (!c) return fail(`Not a Texas county: "${args.county}".`);
      countyNo = c.county_no;
      countyName = c.county_name;
    }

    let districtPdq: string | null = null;
    if (args.district?.trim()) {
      const label = args.district.trim().toUpperCase();
      districtPdq = RRC_TO_PDQ[label] ?? null;
      if (!districtPdq) {
        return fail(
          `Not an RRC district: "${args.district}". Use the district label: ${Object.keys(RRC_TO_PDQ).join(", ")}.`
        );
      }
    }

    if (args.permit_since && !/^\d{4}-\d{2}-\d{2}$/.test(args.permit_since.trim())) {
      return fail("permit_since must be YYYY-MM-DD.");
    }

    const months = clamp(Math.floor(args.months ?? 12), 1, AGG_MAX_MONTHS);
    const limit = clamp(Math.floor(args.limit ?? 25), 1, ROW_CAP);
    const { reported } = await getCycleEdge();
    if (!reported) return fail("The mirror has no published production cycle.");

    // Anchored on the reported edge, never on now(): the last cycles in the
    // file are zeros because nobody has filed, and a trailing window that
    // includes them scores every operator in Texas as collapsing.
    const c = clauses();
    c.add(
      "p.cycle > ($?::date - make_interval(months => $?::int))",
      `${reported}-01`,
      months
    );
    c.add("p.cycle <= $?::date", `${reported}-01`);

    if (countyNo) c.add(AGG_FILTERS.county, countyNo);
    if (districtPdq) c.add(AGG_FILTERS.district, districtPdq);
    if (args.operator_no?.trim()) c.add(AGG_FILTERS.operator_no, args.operator_no.trim());
    if (args.field_no?.trim()) c.add(AGG_FILTERS.field_no, args.field_no.trim());
    if (args.oil_gas_code) c.add(AGG_FILTERS.oil_gas_code, args.oil_gas_code);
    if (args.permit_since?.trim()) c.add(AGG_FILTERS.permit_since, args.permit_since.trim());
    if (args.has_commercial_disposal) c.add(AGG_FILTERS.has_commercial_disposal);
    if (args.has_disposal) c.add(AGG_FILTERS.has_disposal);

    const having =
      args.min_value !== undefined && Number.isFinite(args.min_value)
        ? `having ${metric} >= ${c.bind(args.min_value)}`
        : "";
    const rowCap = c.bind(limit + 1);

    const rows = await rrcQuery<{ key: string; label: string | null; value: number }>(
      `select ${dim.key} as key, ${dim.label} as label, ${metric} as value
         from rrc.county_lease_cycle p
        ${c.sql()}
        group by 1
        ${having}
        order by value desc nulls last
        limit ${rowCap}`,
      c.params
    );

    return {
      ok: true as const,
      group_by: args.group_by,
      metric: args.metric,
      months,
      // The first cycle actually included, not the anchor: `cycle >` excludes
      // the month `months` back, so the window opens the month after it.
      window: { from: addMonths(reported, -(months - 1)), through: reported },
      reported_through: reported,
      filters: {
        county: countyName,
        county_no: countyNo,
        district: args.district?.trim().toUpperCase() ?? null,
        operator_no: args.operator_no?.trim() ?? null,
        field_no: args.field_no?.trim() ?? null,
        oil_gas_code: args.oil_gas_code ?? null,
        permit_since: args.permit_since?.trim() ?? null,
        has_commercial_disposal: Boolean(args.has_commercial_disposal),
        has_disposal: Boolean(args.has_disposal),
        min_value: args.min_value ?? null,
      },
      groups: rows.slice(0, limit).map((r) => ({
        key: r.key?.trim() ?? r.key,
        label: r.label,
        value: r.value,
      })),
      truncated: rows.length > limit,
      notes: [
        LAG_NOTE(reported),
        "The population is lease-months that REPORTED production in the window. An operator with a permit and a disposal well but no production in the window is not here, because the tape this reads is the production tape.",
        "permit_since and the disposal filters correlate on the OPERATOR, not on the lease: they select every group whose operator holds such a permit anywhere in Texas, not one attached to this lease.",
        "Volumes are the RRC's county-by-lease grain, so a lease straddling a county line appears once per county. Summing across county groups double-counts nothing; summing a county group and a district group does.",
        "boe converts gas at 6 Mcf to the barrel. That is an energy convention, not a price.",
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [
  operatorHealth,
  pluggingLiability,
  activityDiff,
  permitCycle,
  aggregate,
];
