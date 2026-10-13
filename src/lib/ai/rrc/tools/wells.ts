import "server-only";

import { z } from "zod";

import { completionMonth, producesToLease, shutInMonth } from "@/lib/rrc/record-split";
import type { TestRow, WellRef } from "@/lib/rrc/well-share";
import { GAS_KEYS, OIL_KEYS, streamOf } from "@/lib/scout/allocate-months";
import { rrcQuery } from "@/lib/scout/rrc-db";
import { PDQ_TO_RRC, toPdqDistrict } from "@/lib/scout/rrc-districts";
import {
  getLeaseW10,
  getOperatorH15,
  getWellDossier,
  getWellG10,
  getWellH15,
} from "@/lib/scout/rrc-queries";
import type { G10Test, LeaseMonth, W10Test } from "@/lib/scout/rrc-types";
import { linearFit } from "../math";
import { defineTool, type RrcTool } from "../tool";
import {
  ALLOCATION_NOTES,
  rankLeaseWells,
  type LeaseVolumeMonth,
} from "../well-rank";

/**
 * One wellbore: what it made, and what its own tests say about it.
 *
 * Four facts hold across every tool here. Each is attached to the result rather
 * than left in a comment, because each one is a confident wrong answer waiting
 * to happen if the reader does not have it.
 *
 *   1. A PER-WELL VOLUME IS AN ESTIMATE. Texas files oil per LEASE, so the only
 *      per-well number anyone can produce is an allocation. Oil and gas take
 *      SEPARATE shares and are never collapsed into one: a well can carry most
 *      of a lease's oil and little of its gas.
 *   2. H-15 FILING RUNS ABOUT A YEAR BEHIND, far more than the ~3-month
 *      production lag. A thin recent tail is late paperwork, not a dead well.
 *   3. AN ABSENT G-10 POTENTIAL MEANS NOT REQUIRED. Open-flow potential is only
 *      filed where the field rules call for it. It is never "this well makes
 *      nothing", and it is never read as zero.
 *   4. A NULL DEPTH OR PRESSURE IS NOT RECORDED. The tape zero-fills unset
 *      numerics, so a 0 psi wellhead reading is a blank, not a measurement.
 */

const ALLOCATION_IS_ESTIMATE =
  "An ESTIMATE, and it must be said as one. Texas files oil per LEASE and there is no measured per-well volume anywhere in the public record; this is the lease's filed volume divided in the ratio of its wells' filed W-10 tests.";

const SEPARATE_SHARES =
  "Oil and gas take SEPARATE shares in every month. A well can carry most of a lease's oil and little of its gas, and weighting casinghead by the oil test would hand it gas it does not make.";

const GAS_SHARE_OVER_ONE =
  "A hole filed on both an oil lease and its own six-digit gas id draws gas from a record the lease series does not carry, so gas_share can read above 1. Quote the VOLUMES and treat the share as the cross-check.";

const H15_LATE_FILING =
  "H-15 filing runs about a year behind, far more than the ~3-month production lag. A thin recent tail is late filing, not a dead well.";

const G10_IS_ANNUAL =
  "The G-10 is an ANNUAL deliverability test, so the newest filing on a healthy well can be a year old. A gap is a filing interval, not a shut-in.";

const POTENTIAL_OPTIONAL =
  "G-10 open-flow potential is filed only where the field rules require it. Absent means NOT REQUIRED: it is reported here as null and never as zero, and it never means the well makes nothing.";

const NOT_RECORDED =
  "A null depth or pressure is 'not recorded', never zero. The tape zero-fills unset numerics, so a 0 psi reading is read as a blank.";

function fail(error: string) {
  return { ok: false as const, error };
}

/** Keep the most recent `n`, and say so when that cut anything. */
function tail<T>(rows: readonly T[], n: number): { rows: T[]; truncated: boolean } {
  return n >= rows.length
    ? { rows: [...rows], truncated: false }
    : { rows: rows.slice(rows.length - n), truncated: true };
}

/**
 * A measurement, or null.
 *
 * Zero is not a pressure, a depth or an open-flow potential: the source is a
 * fixed-width tape whose unset numeric fields are zero-filled, so a 0 here is a
 * field nobody wrote in. Reporting it as a number is how "not required" becomes
 * "makes nothing".
 */
function pos(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Years between two ISO dates, on the same 365.25 day-year every fit here uses. */
function yearsBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / (365.25 * 86_400_000);
}

// ------------------------------------------------------------------ 13

const MAX_MONTHS = 600;

/** One month of the well, its lease, and the ratio between them. */
function allocatedMonth(m: LeaseMonth, lease: LeaseMonth | undefined, weighted: boolean) {
  const oil = streamOf(m, OIL_KEYS);
  const gas = streamOf(m, GAS_KEYS);
  const leaseOil = lease ? streamOf(lease, OIL_KEYS) : null;
  const leaseGas = lease ? streamOf(lease, GAS_KEYS) : null;
  return {
    cycle: m.cycle,
    reported: m.reported,
    // Null rather than the lease figure when nothing could weight this hole:
    // repeating the lease volume in a column called `oil_bbl` is the exact
    // mistake this tool exists to prevent.
    oil_bbl: weighted ? oil : null,
    gas_mcf: weighted ? gas : null,
    lease_oil_bbl: leaseOil,
    lease_gas_mcf: leaseGas,
    // A month the lease filed as zero yields no ratio, so it stays null rather
    // than being reported as a zero share.
    oil_share: weighted && leaseOil ? oil / leaseOil : null,
    gas_share: weighted && leaseGas ? gas / leaseGas : null,
  };
}

const allocateWell = defineTool(
  "rrc_allocate_well",
  "One wellbore's W-10 test-weighted share of its lease's monthly oil and gas, with the two streams weighted separately.",
  { api: z.string(), months: z.number().int().positive().optional() },
  async ({ api, months }) => {
    const key = api.trim();
    if (!key) return fail("api is required.");
    const w = await getWellDossier(key);
    if (!w) return fail(`No wellbore ${key}.`);

    // `productionByTest` IS `allocatedByTest` already run for this hole
    // (rrc-queries.ts). Calling it again would repeat every lease read the
    // dossier has just done, to land on the identical series.
    const weighted = w.productionByTest.length > 0;
    const lease = new Map(w.production.map((m) => [m.cycle, m]));
    const rows = (weighted ? w.productionByTest : w.production).map((m) =>
      allocatedMonth(m, lease.get(m.cycle), weighted)
    );

    // The newest REPORTED month with a ratio in it: the one a person quotes.
    const at = [...rows]
      .reverse()
      .find((r) => r.reported && (r.oil_share !== null || r.gas_share !== null));

    const total = (pick: (r: (typeof rows)[number]) => number | null) =>
      rows.reduce((a, r) => a + (pick(r) ?? 0), 0);
    const cut = tail(rows, Math.min(months ?? 120, MAX_MONTHS));

    return {
      ok: true as const,
      api: key,
      label: `${w.header.lease_name ?? key} ${w.header.well_no ?? ""}`.trim(),
      operator_name: w.header.operator_name,
      lease: {
        oil_gas_code: w.header.oil_gas_code,
        district: w.header.district,
        lease_no: w.header.lease_number,
        field_name: w.header.field_name,
      },
      /** "well" once the months are this hole's share; "lease" when they are not. */
      grain: weighted ? "well" : "lease",
      // Same field names as the `allocation` block on the chat-side well payload
      // (src/lib/ai/rrc-tools.ts). One vocabulary for one quantity, so the two
      // surfaces cannot describe the same split in two ways.
      allocation: {
        method: weighted ? "well-test" : "even-split",
        thisWellTested: w.w10.length > 0 || w.g10.length > 0,
        asOfCycle: at?.cycle ?? null,
        oilShare: at?.oil_share ?? null,
        gasShare: at?.gas_share ?? null,
        evenSplitShare: w.allocationShare,
      },
      lifetime: {
        oil_bbl: weighted ? total((r) => r.oil_bbl) : null,
        gas_mcf: weighted ? total((r) => r.gas_mcf) : null,
        lease_oil_bbl: total((r) => r.lease_oil_bbl),
        lease_gas_mcf: total((r) => r.lease_gas_mcf),
      },
      months: cut.rows,
      truncated: cut.truncated,
      notes: [
        ALLOCATION_IS_ESTIMATE,
        SEPARATE_SHARES,
        GAS_SHARE_OVER_ONE,
        weighted
          ? "Each month is weighted by the test in effect THAT month, not by today's split: wells are drilled, water out and are recompleted."
          : "This hole is on no current schedule, so nothing could weight it. The months are LEASE totals; allocation.evenSplitShare is the only estimate on offer and it asserts every well on the lease is identical.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 14

/**
 * The W-10 governing a month: the most recent test on or before it.
 *
 * Months earlier than the well's first test use that first test, as the
 * earliest known statement of the well's character. That reach-backwards is the
 * rule the split itself uses (`@/lib/rrc/well-share`), and it matters: the
 * mirror's W-10 window opens in 2022 while `lease_production` runs back decades,
 * so almost every old month is weighted by a test filed long afterwards.
 */
function governingTest(ascending: readonly W10Test[], month: string): W10Test | null {
  if (!ascending.length) return null;
  let at = ascending[0];
  for (const t of ascending) {
    if ((t.test_date ?? "").slice(0, 7) <= month) at = t;
    else break;
  }
  return at;
}

/** Test-backed, or the head-count fallback. A rate of zero cannot weight anything. */
function basisOf(test: W10Test | null, rate: number | null | undefined) {
  return test && typeof rate === "number" && rate > 0
    ? ("well-test" as const)
    : ("head-count" as const);
}

const allocationBasis = defineTool(
  "rrc_allocation_basis",
  "The weights behind one wellbore's allocation month by month: which W-10 governed each month, and which months fell back to a head-count split.",
  { api: z.string(), months: z.number().int().positive().optional() },
  async ({ api, months }) => {
    const key = api.trim();
    if (!key) return fail("api is required.");
    const w = await getWellDossier(key);
    if (!w) return fail(`No wellbore ${key}.`);
    if (w.productionByTest.length === 0) {
      return fail(
        `${key} is on no current schedule, so there is no weighted allocation to explain. Its months are lease totals; see rrc_allocate_well.`
      );
    }

    // A GAS record is not split at all: the mirror's 138,962 gas records average
    // 1.00 wells, so the filed volume already belongs to this hole and no test
    // weights it. Asking for the lease's W-10 roster there would return nothing,
    // because the W-10 is the oil form.
    const gasRecord = w.header.oil_gas_code === "G";
    const leaseW10 =
      !gasRecord && w.header.district && w.header.lease_number
        ? await getLeaseW10(w.header.district, w.header.lease_number)
        : null;

    const ascending = [...w.w10]
      .filter((t) => t.test_date)
      .sort((a, b) => (a.test_date! < b.test_date! ? -1 : 1));
    const even = w.allocationShare;
    const lease = new Map(w.production.map((m) => [m.cycle, m]));

    const rows = w.productionByTest.map((m) => {
      const l = lease.get(m.cycle);
      const leaseOil = l ? streamOf(l, OIL_KEYS) : null;
      const leaseGas = l ? streamOf(l, GAS_KEYS) : null;
      const oilShare = leaseOil ? streamOf(m, OIL_KEYS) / leaseOil : null;
      const gasShare = leaseGas ? streamOf(m, GAS_KEYS) / leaseGas : null;
      const t = governingTest(ascending, m.cycle);
      return {
        cycle: m.cycle,
        reported: m.reported,
        oil_share: oilShare,
        gas_share: gasShare,
        // The W-10 carries both rates, so one test can weight this hole's oil
        // and fail to weight its gas in the same month.
        oil_basis: gasRecord ? ("sole-well" as const) : basisOf(t, t?.daily_oil),
        gas_basis: gasRecord ? ("sole-well" as const) : basisOf(t, t?.daily_gas),
        governing_test_date: gasRecord ? null : (t?.test_date ?? null),
        governing_test_oil_bbl_per_day: gasRecord ? null : (t?.daily_oil ?? null),
        governing_test_gas_mcf_per_day: gasRecord ? null : (t?.daily_gas ?? null),
        even_split_share: even,
        // The independent check on the label, and OIL only: gas can come off a
        // second record the lease series does not carry, so a gas share has no
        // even split to be compared with.
        oil_share_matches_even_split:
          even != null && oilShare != null ? Math.abs(oilShare - even) < 1e-6 : null,
      };
    });

    const cut = tail(rows, Math.min(months ?? 120, MAX_MONTHS));
    return {
      ok: true as const,
      api: key,
      label: `${w.header.lease_name ?? key} ${w.header.well_no ?? ""}`.trim(),
      method: "well-test",
      even_split_share: even,
      wells_on_schedule: even && even > 0 ? Math.round(1 / even) : null,
      this_well_tests: ascending
        .slice(-24)
        .reverse()
        .map((t) => ({
          test_date: t.test_date,
          daily_oil_bbl: t.daily_oil,
          daily_gas_mcf: t.daily_gas,
          producing_method: t.producing_method,
          type_flag: t.type_flag,
        })),
      /** The lease's latest test per well: the denominator every share divides by. */
      lease_tests: leaseW10
        ? {
            tested_bopd: leaseW10.testedBopd,
            untested_wells: leaseW10.untested,
            wells: leaseW10.wells,
          }
        : null,
      this_well_latest_share: w.w10Share,
      months: cut.rows,
      truncated: cut.truncated,
      notes: [
        ALLOCATION_IS_ESTIMATE,
        SEPARATE_SHARES,
        GAS_SHARE_OVER_ONE,
        "'well-test' means the governing W-10 reported a rate for that stream and the month was split in the ratio of the record's tested wells. 'head-count' means it did not: the hole takes the residual the tested wells did not account for, which collapses to a flat 1 / (wells on schedule) when no well on the record is tested at all.",
        gasRecord
          ? "'sole-well' means nothing was split. This is a GAS record, and Texas files gas per WELL: the filed volume already belongs to this hole."
          : "A well is not weighted before it was completed or after it was shut in, so a month's shares are shared out among the wells that were actually running.",
        "Test rates are one day's rate filed to set an allowable and read high: across 14,663 leases the sum of a lease's latest tests is a median 1.64x its actual daily production. The RATIO between two wells survives that bias; the rate itself is never what a well makes.",
      ],
    };
  }
);

// ------------------------------------------------------------- G-10 loading

const G10_ARGS = {
  api: z.string().optional(),
  district: z.string().optional(),
  gas_id: z.string().optional(),
};

type G10Args = { api?: string; district?: string; gas_id?: string };

/**
 * A gas wellbore's G-10 history, oldest first.
 *
 * By district + six-digit gas id when given, because that is the form's own key
 * and 1,501 apis carry more than one gas id (a hole completed in several gas
 * reservoirs files a G-10 per reservoir). By API it goes through the dossier,
 * which resolves the gas id off the CURRENT schedule row: one of them.
 */
async function loadG10(a: G10Args): Promise<{ key: string; tests: G10Test[] } | { error: string }> {
  if (a.district?.trim() && a.gas_id?.trim()) {
    const tests = await getWellG10(a.district.trim(), a.gas_id.trim());
    return { key: `${a.district.trim()}/${a.gas_id.trim()}`, tests: ascendingG10(tests) };
  }
  const key = a.api?.trim();
  if (!key) return { error: "Give an api, or a district and gas_id." };
  const w = await getWellDossier(key);
  if (!w) return { error: `No wellbore ${key}.` };
  if (!w.g10.length) {
    return {
      error:
        w.header.oil_gas_code === "O"
          ? `No G-10 for ${key}: it is an OIL completion, and the G-10 is the gas form. Its tests are W-10s.`
          : `No G-10 on file for ${key}.`,
    };
  }
  return { key, tests: ascendingG10(w.g10) };
}

function ascendingG10(tests: readonly G10Test[]): G10Test[] {
  return [...tests]
    .filter((t) => t.test_date)
    .sort((a, b) => (a.test_date! < b.test_date! ? -1 : 1));
}

// ------------------------------------------------------------------ 15

const MAX_TESTS = 120;

const deliverabilityTrend = defineTool(
  "rrc_deliverability_trend",
  "G-10 tested gas rate across test dates as a decline, with the shut-in and flowing wellhead pressure history behind it.",
  G10_ARGS,
  async (args) => {
    const loaded = await loadG10(args);
    if ("error" in loaded) return fail(loaded.error);
    if (!loaded.tests.length) return fail(`No G-10 with a test date for ${loaded.key}.`);

    // One point per TEST DATE. A multi-point back-pressure test files several
    // rows on one day at different chokes, and plotting those against time would
    // read as a same-day collapse. The largest rate is the deliverability.
    const byDate = new Map<string, G10Test>();
    for (const t of loaded.tests) {
      const at = byDate.get(t.test_date!);
      if (!at || (t.daily_gas ?? 0) > (at.daily_gas ?? 0)) byDate.set(t.test_date!, t);
    }
    const tests = [...byDate.values()];

    const series = tests.map((t) => ({
      test_date: t.test_date,
      daily_gas_mcf: t.daily_gas,
      daily_cond_bbl: t.daily_cond,
      daily_water_bbl: t.daily_water,
      // Never zero: absent means the field rules did not require the test.
      potential_mcf_per_day: pos(t.potential),
      shut_in_wellhead_psi: pos(t.siwh_press),
      flowing_wellhead_psi: pos(t.flow_press),
      bottomhole_psi: pos(t.bhp),
      shut_in: t.shut_in_flag === "Y",
      late_test: t.late_test === "Y",
      corrected: t.corrected === "Y",
    }));

    // A shut-in well tests at no rate because it was closed, not because it is
    // empty. Fitting those in would report a collapse the well is not in.
    const flowing = series.filter((s) => !s.shut_in && (s.daily_gas_mcf ?? 0) > 0);
    const t0 = flowing[0]?.test_date ?? null;
    const rateFit = t0
      ? linearFit(
          flowing.map(
            (s) => [yearsBetween(t0, s.test_date!), Math.log(s.daily_gas_mcf!)] as const
          )
        )
      : null;

    /** A pressure history's own straight line, psi per year. */
    const pressureFit = (pick: (s: (typeof series)[number]) => number | null) => {
      const pts = series
        .map((s) => [s.test_date!, pick(s)] as const)
        .filter((p): p is readonly [string, number] => p[1] !== null);
      if (pts.length < 2) return null;
      const from = pts[0][0];
      const f = linearFit(pts.map(([d, v]) => [yearsBetween(from, d), v] as const));
      return f
        ? { psi_per_year: f.slope, r2: f.r2, n: f.n, first: pts[0][1], last: pts[pts.length - 1][1] }
        : null;
    };

    const cut = tail(series, MAX_TESTS);
    return {
      ok: true as const,
      key: loaded.key,
      tests: series.length,
      first_test: series[0]?.test_date ?? null,
      last_test: series[series.length - 1]?.test_date ?? null,
      shut_in_tests: series.filter((s) => s.shut_in).length,
      decline: rateFit
        ? {
            // Exponential on the tested rate: log-rate against years, which is
            // the space the fit minimises in.
            nominal_per_year: -rateFit.slope,
            effective_pct_per_year: (1 - Math.exp(rateFit.slope)) * 100,
            r2: rateFit.r2,
            n: rateFit.n,
            first_mcf_per_day: flowing[0]?.daily_gas_mcf ?? null,
            last_mcf_per_day: flowing[flowing.length - 1]?.daily_gas_mcf ?? null,
          }
        : null,
      decline_reason:
        rateFit === null
          ? `Only ${flowing.length} flowing test(s) with a rate; a decline needs 2 on different dates.`
          : null,
      shut_in_pressure: pressureFit((s) => s.shut_in_wellhead_psi),
      flowing_pressure: pressureFit((s) => s.flowing_wellhead_psi),
      series: cut.rows,
      truncated: cut.truncated,
      notes: [
        G10_IS_ANNUAL,
        POTENTIAL_OPTIONAL,
        NOT_RECORDED,
        "Successive SHUT-IN wellhead pressures are the depletion signal: a falling shut-in pressure is reservoir energy leaving, and it shows here before it shows in lease production. A falling FLOWING pressure alone can be a choke change.",
        "Tests taken while the well was shut in are excluded from the decline and counted separately, because a closed well tests at no rate for a reason that is not decline.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 16

/** Below this there is nothing left over to check the fit against. */
const MIN_AOF_POINTS = 3;

const aof = defineTool(
  "rrc_aof",
  "Absolute open flow from a multi-point G-10 back-pressure test by Rawlins-Schellhardt least squares, or a refusal when only single-point tests exist.",
  { ...G10_ARGS, test_date: z.string().optional() },
  async (args) => {
    const loaded = await loadG10(args);
    if ("error" in loaded) return fail(loaded.error);
    if (!loaded.tests.length) return fail(`No G-10 with a test date for ${loaded.key}.`);

    const wanted = args.test_date?.trim();
    const byDate = new Map<string, G10Test[]>();
    for (const t of loaded.tests) {
      const at = byDate.get(t.test_date!);
      if (at) at.push(t);
      else byDate.set(t.test_date!, [t]);
    }

    /** The points of one test date: rate against the pressure-squared drawdown. */
    const pointsOf = (rows: G10Test[]) => {
      // One shut-in pressure per test, so the whole date shares the highest one
      // on file. Pr is the pressure the well was flowing AGAINST.
      const pr = Math.max(...rows.map((r) => pos(r.siwh_press) ?? 0));
      if (!(pr > 0)) return { pr: null, points: [] };
      const points = rows
        .map((r) => {
          const q = pos(r.daily_gas);
          const pwf = pos(r.flow_press);
          if (q === null || pwf === null) return null;
          const dp2 = pr * pr - pwf * pwf;
          return dp2 > 0 ? { q, pwf, dp2 } : null;
        })
        .filter((p): p is { q: number; pwf: number; dp2: number } => p !== null);
      return { pr, points };
    };

    const dates = [...byDate.keys()].sort();
    const chosen = wanted
      ? [wanted]
      : dates.filter((d) => pointsOf(byDate.get(d)!).points.length >= MIN_AOF_POINTS);
    const date = chosen.length ? chosen[chosen.length - 1] : null;
    const rows = date ? (byDate.get(date) ?? []) : [];
    const { pr, points } = rows.length
      ? pointsOf(rows)
      : { pr: null, points: [] as { q: number; pwf: number; dp2: number }[] };

    // The RRC's own filed open-flow number, whether or not a fit is possible.
    // Absent means the field rules did not require it: null, never zero.
    const filed = loaded.tests
      .map((t) => ({ test_date: t.test_date, potential_mcf_per_day: pos(t.potential) }))
      .filter((p) => p.potential_mcf_per_day !== null);

    const refusal =
      points.length >= MIN_AOF_POINTS
        ? null
        : wanted && !byDate.has(wanted)
          ? `No G-10 dated ${wanted} for ${loaded.key}.`
          : `A Rawlins-Schellhardt fit needs at least ${MIN_AOF_POINTS} flow points from ONE multi-point test; the best test here has ${points.length}. The RRC's G-10 file carries one flow point per filing (one rate, one flowing pressure, one shut-in pressure), so a well tested single-point cannot be fitted, and pooling points from different YEARS would fit one curve through several reservoir pressures. Use the filed open-flow potential instead where the field rules required one.`;

    if (refusal) {
      return {
        ok: true as const,
        key: loaded.key,
        test_date: date,
        points: points.length,
        fit: null,
        aof_mcf_per_day: null,
        refusal,
        filed_potential: filed.length ? filed[filed.length - 1] : null,
        filed_potential_note: filed.length ? null : POTENTIAL_OPTIONAL,
        notes: [POTENTIAL_OPTIONAL, NOT_RECORDED],
      };
    }

    // q = C (Pr^2 - Pwf^2)^n, so log q = log C + n log(Pr^2 - Pwf^2): a straight
    // line whose slope is n and whose intercept is log C.
    const fit = linearFit(points.map((p) => [Math.log(p.dp2), Math.log(p.q)] as const));
    if (!fit) {
      return {
        ok: true as const,
        key: loaded.key,
        test_date: date,
        points: points.length,
        fit: null,
        aof_mcf_per_day: null,
        refusal:
          "Every point was taken at the same drawdown, so the log-log line has no slope to fit.",
        filed_potential: filed.length ? filed[filed.length - 1] : null,
        filed_potential_note: null,
        notes: [POTENTIAL_OPTIONAL, NOT_RECORDED],
      };
    }

    const n = fit.slope;
    const c = Math.exp(fit.intercept);
    // AOF is the fitted rate at Pwf = 0, which is the whole reservoir pressure
    // as drawdown. It is an extrapolation past every measured point, by design.
    const aofMcf = c * Math.pow(pr! * pr!, n);

    return {
      ok: true as const,
      key: loaded.key,
      test_date: date,
      points: points.length,
      shut_in_wellhead_psi: pr,
      fit: {
        c,
        n,
        r2: fit.r2,
        points: points.map((p) => ({
          flowing_wellhead_psi: p.pwf,
          delta_p_squared: p.dp2,
          daily_gas_mcf: p.q,
        })),
      },
      aof_mcf_per_day: aofMcf,
      refusal: null,
      filed_potential: filed.length ? filed[filed.length - 1] : null,
      filed_potential_note: filed.length ? null : POTENTIAL_OPTIONAL,
      notes: [
        "Rawlins-Schellhardt q = C (Pr^2 - Pwf^2)^n, fitted by least squares on the log-log of rate against pressure-squared drawdown and evaluated at Pwf = 0. Pr is the SHUT-IN WELLHEAD pressure, not a measured bottomhole or reservoir pressure, so the answer is a wellhead-referenced open flow.",
        "n outside 0.5 to 1.0 means the points do not sit on a back-pressure curve: read the fit before quoting the number.",
        "AOF is an extrapolation beyond every measured point and no well is ever produced at it. It is a deliverability index, not a rate anyone should plan on.",
        POTENTIAL_OPTIONAL,
      ],
    };
  }
);

// ------------------------------------------------------------------ 17

/** GLR far above this classifies the well as a gas well, by statute. */
const GAS_WELL_GLR = 100_000;

const drawdown = defineTool(
  "rrc_drawdown",
  "Drawdown between shut-in and flowing wellhead pressure on a wellbore's latest G-10, with its gas-liquid ratio.",
  G10_ARGS,
  async (args) => {
    const loaded = await loadG10(args);
    if ("error" in loaded) return fail(loaded.error);
    if (!loaded.tests.length) return fail(`No G-10 with a test date for ${loaded.key}.`);

    const read = (t: G10Test) => {
      const siwh = pos(t.siwh_press);
      const flow = pos(t.flow_press);
      const gas = pos(t.daily_gas);
      const cond = pos(t.daily_cond);
      const filedGlr = pos(t.gas_liquid_ratio);
      // The RRC calculates GLR itself. Recomputing it from the same row is the
      // cheap check that the two agree; a disagreement is the finding.
      const computedGlr = gas !== null && cond !== null ? (gas * 1000) / cond : null;
      return {
        test_date: t.test_date,
        shut_in: t.shut_in_flag === "Y",
        shut_in_wellhead_psi: siwh,
        flowing_wellhead_psi: flow,
        bottomhole_psi: pos(t.bhp),
        drawdown_psi: siwh !== null && flow !== null ? siwh - flow : null,
        drawdown_fraction: siwh !== null && flow !== null && siwh > 0 ? (siwh - flow) / siwh : null,
        drawdown_reason:
          siwh === null
            ? "No shut-in wellhead pressure on this filing: not recorded, not zero."
            : flow === null
              ? "No flowing wellhead pressure on this filing: not recorded, not zero."
              : null,
        daily_gas_mcf: t.daily_gas,
        daily_cond_bbl: t.daily_cond,
        daily_water_bbl: t.daily_water,
        gas_liquid_ratio_filed: filedGlr,
        gas_liquid_ratio_computed: computedGlr,
        gas_liquid_ratio_agrees:
          filedGlr !== null && computedGlr !== null
            ? Math.abs(filedGlr - computedGlr) <= 0.02 * filedGlr
            : null,
        classifies_as_gas_well:
          filedGlr !== null ? filedGlr >= GAS_WELL_GLR : computedGlr !== null ? computedGlr >= GAS_WELL_GLR : null,
      };
    };

    const latest = read(loaded.tests[loaded.tests.length - 1]);
    // A latest filing with no pressures is common. The newest one that HAS both
    // is the only other honest answer, and it is offered rather than silently
    // substituted.
    const withPressure = latest.drawdown_psi === null
      ? ([...loaded.tests].reverse().map(read).find((r) => r.drawdown_psi !== null) ?? null)
      : null;

    return {
      ok: true as const,
      key: loaded.key,
      latest,
      latest_with_pressures: withPressure,
      tests_on_file: loaded.tests.length,
      notes: [
        "Drawdown here is SHUT-IN minus FLOWING wellhead pressure on one filing, which is a surface number. It is not a bottomhole drawdown and cannot be turned into one without a flowing gradient the mirror does not carry.",
        "A large fractional drawdown means the well is being pulled hard against its own pressure; a small one on a low rate is a well that is choked or that has nothing left to give. The two look identical in the rate alone.",
        NOT_RECORDED,
        `The gas-liquid ratio is cubic feet per barrel, and 100,000 is the statutory line between a gas well and an oil well. Filed and recomputed values are both shown: if they disagree, the row is suspect and neither should be quoted alone.`,
        G10_IS_ANNUAL,
      ],
    };
  }
);

// ------------------------------------------------------------------ 18

const fluidLevelTrend = defineTool(
  "rrc_fluid_level_trend",
  "H-15 top-of-fluid rise rate in feet per year for one inactive wellbore, and the projected time until fluid reaches surface.",
  { api: z.string() },
  async ({ api }) => {
    const key = api.trim();
    if (!key) return fail("api is required.");
    const all = await getWellH15(key);
    const rows = all
      .filter((t) => t.test_date && pos(t.top_of_fluid) !== null)
      .sort((a, b) => (a.test_date! < b.test_date! ? -1 : 1));

    if (rows.length < 2) {
      return {
        ok: true as const,
        api: key,
        tests: rows.length,
        h15_filings: all.length,
        fit: null,
        rise_ft_per_year: null,
        years_to_surface: null,
        refusal: `A rise rate needs two fluid-level tests with a depth; ${key} has ${rows.length}. ${H15_LATE_FILING}`,
        series: rows.map((t) => ({ test_date: t.test_date, top_of_fluid_ft: t.top_of_fluid })),
        notes: [H15_LATE_FILING, NOT_RECORDED],
      };
    }

    // x is years from the FIRST test, y the DEPTH to the top of the fluid
    // column. A rising column is a falling depth, so the rise rate is the
    // negated slope and only a negative slope projects to surface.
    const from = rows[0].test_date!;
    const points = rows.map(
      (t) => [yearsBetween(from, t.test_date!), t.top_of_fluid!] as const
    );
    const fit = linearFit(points);
    const last = points[points.length - 1];
    const surfaceAt = fit && fit.slope < 0 ? -fit.intercept / fit.slope : null;

    return {
      ok: true as const,
      api: key,
      tests: rows.length,
      h15_filings: all.length,
      first_test: from,
      last_test: rows[rows.length - 1].test_date,
      latest_top_of_fluid_ft: last[1],
      fit: fit ? { slope_ft_per_year: fit.slope, intercept_ft: fit.intercept, r2: fit.r2, n: fit.n } : null,
      /** Positive means the column is rising toward surface. */
      rise_ft_per_year: fit ? -fit.slope : null,
      years_to_surface: surfaceAt === null ? null : surfaceAt - last[0],
      years_to_surface_reason:
        surfaceAt !== null
          ? null
          : fit
            ? "The fitted column is falling or flat, so it does not project to surface."
            : "Every test was filed on the same day, so there is no rate to fit.",
      refusal: null,
      series: rows.map((t) => ({
        test_date: t.test_date,
        top_of_fluid_ft: t.top_of_fluid,
        test_type: t.test_type,
        fluid_method: t.fluid_method,
        status: t.status,
      })),
      notes: [
        H15_LATE_FILING,
        "Top of fluid is a DEPTH from surface, so a rising column reads as a shrinking number. The rise rate is the negated fit slope and time to surface is a straight-line extrapolation of it, not a forecast.",
        "The H-15 is the INACTIVE-well test, so only wells the RRC requires to prove themselves have this series at all. An empty result is usually an active well, not a missing filing.",
        "Fluid rising toward surface is the well loading up against its own column. It is what the test is for, and it is the number that decides whether a hole can be returned to production or has to be plugged.",
        NOT_RECORDED,
      ],
    };
  }
);

// ------------------------------------------------------------------ 19

const DAY_MS = 86_400_000;

/** "YYYY-MM" to the first of that month, UTC. */
function dueDate(cycle: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(cycle.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
}

const h15Clock = defineTool(
  "rrc_h15_clock",
  "Days to or past the next H-15 test due date for one wellbore, and the same operator's fleet-wide H-15 position.",
  {
    api: z.string().optional(),
    operator_no: z.string().optional(),
    as_of: z.string().optional(),
  },
  async ({ api, operator_no, as_of }) => {
    const key = api?.trim();
    const op = operator_no?.trim();
    if (!key && !op) return fail("Give an api, an operator_no, or both.");

    // Sliced to the date part so a full ISO timestamp works too, and pinned to
    // UTC midnight so the same as_of gives the same day count wherever it runs.
    const raw = as_of?.trim();
    const now = raw ? Date.parse(`${raw.slice(0, 10)}T00:00:00Z`) : Date.now();
    if (!Number.isFinite(now)) return fail(`as_of is not a date: ${as_of}.`);

    let well: Record<string, unknown> | null = null;
    let operatorNo = op ?? null;
    if (key) {
      const filings = await getWellH15(key);
      const latest = filings[0] ?? null;
      // The filing carries the operator that filed it, which is how an API alone
      // reaches the fleet rollup.
      if (!operatorNo && latest?.operator_no) operatorNo = latest.operator_no;
      const due = latest?.next_test_due ? dueDate(latest.next_test_due) : null;
      well = {
        api: key,
        h15_filings: filings.length,
        latest_test_date: latest?.test_date ?? null,
        status: latest?.status ?? null,
        delinquent: latest?.status === "D",
        test_type: latest?.test_type ?? null,
        top_of_fluid_ft: pos(latest?.top_of_fluid),
        next_test_due: latest?.next_test_due ?? null,
        /** Positive is days remaining; negative is days past due. */
        days_to_due: due === null ? null : Math.round((due - now) / DAY_MS),
        past_due: due === null ? null : due < now,
        reason: filings.length
          ? latest?.next_test_due
            ? null
            : "The latest filing states no next-test month, so this well has no clock. That is normal once a well is no longer required to test."
          : `No H-15 on file for ${key}. The H-15 is the inactive-well test, so an active well has none.`,
      };
    }

    const fleet = operatorNo ? await getOperatorH15(operatorNo) : null;

    return {
      ok: true as const,
      as_of: new Date(now).toISOString().slice(0, 10),
      well,
      operator: fleet
        ? {
            operator_no: operatorNo,
            wells_tested: fleet.wellsTested,
            delinquent: fleet.delinquent,
            due_within_90_days: fleet.dueSoon,
            last_test: fleet.lastTest,
          }
        : null,
      notes: [
        "A due date is a MONTH on the filing, taken as its first day: the same convention the operator rollup's own 90-day count uses, so the well figure and the fleet figure cannot disagree.",
        "The fleet counts run over each wellbore's MOST RECENT filing, not every filing ever. A well delinquent in 2019 and current since is not a liability today.",
        "operator.due_within_90_days is counted by the database against its own current date, not against as_of. Only the per-well day count moves with as_of.",
        H15_LATE_FILING,
        "Delinquency here is a filing status, not a well condition. It is a compliance signal about the OPERATOR, and it is the one that precedes an inactive-well enforcement.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 20

/**
 * Ranking WELLS, which is the question the lease grain cannot answer.
 *
 * Asked for an operator's best wells, everything else in this catalog answers
 * with leases, because leases are what Texas files. Substituting one for the
 * other silently is wrong in a way the reader cannot see: a 17,302 bbl lease
 * with eleven wells on it is not a 17,302 bbl well. These two tools do the split
 * the operator-facing well pages and Scout already do, so a well reads the same
 * number in all three places, and they say on every row that it is an estimate.
 */

/** Leases scored in one operator-wide call. Each adds nothing; the reads batch. */
const RANK_LEASE_CAP = 200;
/** Wells returned by the operator-wide tool before the caller's own limit. */
const RANK_ROW_CAP = 200;
/** The window, when the caller does not say. A year of filed months. */
const RANK_MONTHS = 12;

interface RankKey {
  oilGasCode: "O" | "G";
  /** The REAL district label, which `wellbore` and `w10_test` are keyed on. */
  district: string;
  leaseNo: string;
}

function rankKeyId(k: RankKey): string {
  return `${k.oilGasCode}/${k.district}/${k.leaseNo}`;
}

/**
 * Every well on a set of leases, whoever operates it.
 *
 * The denominator has to be the RECORD's wells and not one operator's, or every
 * well on a jointly-held lease is inflated. One query for the whole set, keyed
 * on the composite index `wellbore (oil_gas_code, district, lease_number)`.
 */
async function wellsOnLeases(keys: readonly RankKey[]) {
  if (!keys.length) return new Map<string, { refs: WellRef[]; apis: Map<string, string> }>();
  const rows = await rrcQuery<{
    oil_gas_code: string;
    district: string;
    lease_number: string;
    well_no: string;
    api_number: string | null;
    completion_date: string | null;
    well_type_name: string | null;
    shut_in_date: string | null;
  }>(
    `select w.oil_gas_code, w.district, w.lease_number, w.well_no,
            min(w.api_number)      as api_number,
            min(w.completion_date) as completion_date,
            min(w.well_type_name)  as well_type_name,
            min(coalesce(nullif(btrim(w.wl_shut_in_date), ''),
                         nullif(btrim(w.wb_shut_in_date), ''))) as shut_in_date
       from rrc.wellbore w
       join unnest($1::text[], $2::text[], $3::text[]) as k(og, dist, lease)
         on w.oil_gas_code = k.og and w.district = k.dist and w.lease_number = k.lease
      where w.on_schedule = 'Y' and w.well_no is not null
      group by 1, 2, 3, 4`,
    [
      keys.map((k) => k.oilGasCode),
      keys.map((k) => k.district),
      keys.map((k) => k.leaseNo),
    ]
  );

  const out = new Map<string, { refs: WellRef[]; apis: Map<string, string> }>();
  for (const r of rows) {
    const id = rankKeyId({
      oilGasCode: r.oil_gas_code as "O" | "G",
      district: r.district,
      leaseNo: r.lease_number,
    });
    const at = out.get(id) ?? { refs: [], apis: new Map<string, string>() };
    at.refs.push({
      wellNo: r.well_no,
      produces: producesToLease(r.well_type_name),
      completedMonth: completionMonth(r.completion_date),
      shutInMonth: shutInMonth(r.shut_in_date),
    });
    if (r.api_number) at.apis.set(r.well_no, r.api_number);
    out.set(id, at);
  }
  return out;
}

/** The whole W-10 history for a set of leases. Empty for gas records. */
async function testsOnLeases(keys: readonly RankKey[]) {
  const oil = keys.filter((k) => k.oilGasCode === "O");
  const out = new Map<string, TestRow[]>();
  if (!oil.length) return out;
  const rows = await rrcQuery<{
    district: string;
    lease_no: string;
    well_no: string;
    test_date: string | null;
    daily_oil: number | null;
    daily_gas: number | null;
  }>(
    `select t.district, t.lease_no, t.well_no,
            to_char(t.test_date, 'YYYY-MM-DD') as test_date,
            t.daily_oil, t.daily_gas
       from rrc.w10_test t
       join unnest($1::text[], $2::text[]) as k(dist, lease)
         on t.district = k.dist and t.lease_no = k.lease
      where t.test_date is not null
      order by t.well_no, t.test_date`,
    [oil.map((k) => k.district), oil.map((k) => k.leaseNo)]
  );
  for (const r of rows) {
    const id = rankKeyId({ oilGasCode: "O", district: r.district, leaseNo: r.lease_no });
    const at = out.get(id) ?? [];
    at.push({
      wellNo: r.well_no,
      testDate: r.test_date,
      dailyOil: r.daily_oil,
      dailyGas: r.daily_gas,
    });
    out.set(id, at);
  }
  return out;
}

/**
 * The filed months for a set of leases, newest `months` only.
 *
 * `prod_report_filed = 'Y'` is the whole guard against the RRC's ~3-month lag:
 * an unfiled month is stored as a zero, and averaging those in draws every lease
 * falling off a cliff at the right-hand edge.
 */
async function monthsOnLeases(keys: readonly RankKey[], months: number) {
  const out = new Map<string, LeaseVolumeMonth[]>();
  if (!keys.length) return out;
  const rows = await rrcQuery<{
    oil_gas_code: string;
    district_no: string;
    lease_no: string;
    month: string;
    oil: string | number | null;
    gas: string | number | null;
  }>(
    `select p.oil_gas_code, p.district_no, p.lease_no,
            to_char(p.cycle, 'YYYY-MM') as month,
            coalesce(p.oil_prod_vol, 0) + coalesce(p.cond_prod_vol, 0) as oil,
            coalesce(p.gas_prod_vol, 0) + coalesce(p.csgd_prod_vol, 0) as gas
       from rrc.lease_production p
       join unnest($1::text[], $2::text[], $3::text[]) as k(og, dist, lease)
         on p.oil_gas_code = k.og and p.district_no = k.dist and p.lease_no = k.lease
      where p.prod_report_filed = 'Y'
        and p.cycle > (date_trunc('month', now()) - interval '${Math.max(1, Math.floor(months)) + 4} months')
      order by p.cycle`,
    [
      keys.map((k) => k.oilGasCode),
      keys.map((k) => toPdqDistrict(k.district) ?? k.district),
      keys.map((k) => k.leaseNo),
    ]
  );

  // Keyed back on the REAL district, since that is what the well and test reads
  // use. Translating here rather than at every call site keeps one vocabulary.
  const backToRrc = new Map(
    keys.map((k) => [`${k.oilGasCode}/${toPdqDistrict(k.district) ?? k.district}/${k.leaseNo}`, rankKeyId(k)])
  );
  for (const r of rows) {
    const id = backToRrc.get(`${r.oil_gas_code}/${r.district_no}/${r.lease_no}`);
    if (!id) continue;
    const at = out.get(id) ?? [];
    at.push({ month: r.month, oil: Number(r.oil) || 0, gas: Number(r.gas) || 0 });
    out.set(id, at);
  }

  // The window is the newest `months` FILED months per lease, which is not the
  // newest `months` calendar months: leases file at different speeds, and a
  // calendar window would compare one lease's full year against another's ten
  // months and call the difference production.
  for (const [id, list] of out) {
    out.set(id, list.slice(-Math.max(1, Math.floor(months))));
  }
  return out;
}

/** One lease's wells, allocated and labelled. */
function rankOne(
  key: RankKey,
  loaded: { refs: WellRef[]; apis: Map<string, string> } | undefined,
  tests: TestRow[] | undefined,
  months: LeaseVolumeMonth[] | undefined
) {
  if (!loaded || !months?.length) return [];
  return rankLeaseWells(loaded.refs, tests ?? [], months).map((w) => ({
    ...w,
    api: loaded.apis.get(w.well_no) ?? null,
    oil_gas_code: key.oilGasCode,
    district: key.district,
    lease_no: key.leaseNo,
    months_counted: months.length,
    from_cycle: months[0].month,
    to_cycle: months[months.length - 1].month,
  }));
}

type RankedWell = ReturnType<typeof rankOne>[number];

/** Both streams matter, so the default order is the one the lease actually makes. */
function sortRanked(rows: RankedWell[], stream: "oil" | "gas" | undefined) {
  const by = (r: RankedWell) => (stream === "gas" ? r.gas_mcf : stream === "oil" ? r.oil_bbl : 0);
  return [...rows].sort((a, b) =>
    stream ? by(b) - by(a) : b.oil_bbl - a.oil_bbl || b.gas_mcf - a.gas_mcf
  );
}

const leaseWellRanking = defineTool(
  "rrc_lease_well_ranking",
  "Every well on one lease ranked by its W-10 test-weighted share of the lease's filed oil and gas, with each well's API so the answer chains onward. This is the only way to say what one WELL made; Texas files oil per lease.",
  {
    oil_gas_code: z.enum(["O", "G"]),
    district_no: z.string(),
    lease_no: z.string(),
    months: z.number().int().positive().optional(),
    stream: z.enum(["oil", "gas"]).optional(),
  },
  async (args) => {
    const leaseNo = args.lease_no.trim();
    if (!leaseNo) return fail("lease_no is required.");
    // Callers hold PDQ's INTERNAL district code, because that is what
    // `lease_production` and every lease key in this catalog use. The wellbore
    // and W-10 tables are keyed on the real label instead.
    const district = PDQ_TO_RRC[args.district_no.trim()] ?? args.district_no.trim();
    const key: RankKey = { oilGasCode: args.oil_gas_code, district, leaseNo };
    const window = Math.min(args.months ?? RANK_MONTHS, MAX_MONTHS);

    const [wells, tests, months] = await Promise.all([
      wellsOnLeases([key]),
      testsOnLeases([key]),
      monthsOnLeases([key], window),
    ]);
    const id = rankKeyId(key);
    const rows = rankOne(key, wells.get(id), tests.get(id), months.get(id));
    if (!rows.length) {
      return fail(
        `No filed production for ${args.oil_gas_code}/${args.district_no}/${leaseNo} in the last ${window} filed cycles, or no wells on its current schedule. Check the key with rrc_search; district_no is the RRC's INTERNAL code, not the district an operator says out loud.`
      );
    }

    const period = months.get(id)!;
    return {
      ok: true as const,
      lease: {
        oil_gas_code: args.oil_gas_code,
        district_no: args.district_no.trim(),
        district: district,
        lease_no: leaseNo,
      },
      window: {
        months_counted: period.length,
        from_cycle: period[0].month,
        to_cycle: period[period.length - 1].month,
      },
      lease_totals: {
        oil_bbl: period.reduce((a, m) => a + m.oil, 0),
        gas_mcf: period.reduce((a, m) => a + m.gas, 0),
      },
      wells_on_record: rows.length,
      wells: sortRanked(rows, args.stream),
      notes: [
        ...ALLOCATION_NOTES,
        "The wells here are EVERY well on the RRC lease record, whoever operates them. That is what makes each share true; narrowing the denominator to one operator's wells would inflate every one of them.",
        "The allocated volumes sum back to lease_totals, which is the check worth running on any figure quoted from this.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 21

const operatorWellRanking = defineTool(
  "rrc_operator_well_ranking",
  "An operator's most productive WELLS, allocating each of its leases' filed volumes by W-10 test. Use this for 'which of their wells are best'; every other tool answers at the lease grain, and a lease with eleven wells on it is not a well.",
  {
    operator_no: z.string(),
    months: z.number().int().positive().optional(),
    stream: z.enum(["oil", "gas"]).optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const op = args.operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const window = Math.min(args.months ?? RANK_MONTHS, MAX_MONTHS);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 25), 1), RANK_ROW_CAP);

    // The leases this operator is ON, from its own current schedule. Indexed:
    // `wellbore (operator_number) where on_schedule = 'Y'`.
    const leases = await rrcQuery<{
      oil_gas_code: string;
      district: string;
      lease_number: string;
      lease_name: string | null;
      field_name: string | null;
      ours: number;
    }>(
      `select oil_gas_code, district, lease_number,
              min(lease_name) as lease_name, min(field_name) as field_name,
              count(distinct well_no)::int as ours
         from rrc.wellbore
        where operator_number = $1 and on_schedule = 'Y'
          and oil_gas_code is not null and district is not null
          and lease_number is not null and well_no is not null
        group by 1, 2, 3
        order by ours desc
        limit ${RANK_LEASE_CAP + 1}`,
      [op]
    );
    if (!leases.length) return fail(`Operator ${op} has no wells on a current P-5 schedule.`);

    const truncatedLeases = leases.length > RANK_LEASE_CAP;
    const scoped = leases.slice(0, RANK_LEASE_CAP);
    const keys: RankKey[] = scoped.map((l) => ({
      oilGasCode: l.oil_gas_code as "O" | "G",
      district: l.district,
      leaseNo: l.lease_number,
    }));
    const labels = new Map(
      scoped.map((l, i) => [
        rankKeyId(keys[i]),
        { lease_name: l.lease_name, field_name: l.field_name, operator_wells: l.ours },
      ])
    );

    // Three reads for the whole fleet, whatever its size. The split itself is
    // arithmetic and costs nothing.
    const [wells, tests, months] = await Promise.all([
      wellsOnLeases(keys),
      testsOnLeases(keys),
      monthsOnLeases(keys, window),
    ]);

    const all: (RankedWell & {
      lease_name: string | null;
      field_name: string | null;
      operated_by_this_operator: boolean;
    })[] = [];
    for (const key of keys) {
      const id = rankKeyId(key);
      const label = labels.get(id);
      const loaded = wells.get(id);
      for (const row of rankOne(key, loaded, tests.get(id), months.get(id))) {
        all.push({
          ...row,
          lease_name: label?.lease_name ?? null,
          field_name: label?.field_name ?? null,
          // A jointly-held lease's other wells are in the DENOMINATOR but are
          // not this operator's. They are returned rather than hidden, flagged,
          // because dropping them would leave a ranking whose shares do not
          // reconcile to the lease.
          operated_by_this_operator: true,
        });
      }
    }
    if (!all.length) {
      return fail(
        `Operator ${op} holds ${leases.length} lease records but none of them filed production in the last ${window} cycles.`
      );
    }

    const ranked = sortRanked(all, args.stream) as typeof all;
    const totals = {
      oil_bbl: all.reduce((a, w) => a + w.oil_bbl, 0),
      gas_mcf: all.reduce((a, w) => a + w.gas_mcf, 0),
    };
    const cycles = [...new Set(all.map((w) => w.to_cycle))].sort();

    return {
      ok: true as const,
      operator_no: op,
      window: { months: window, latest_cycle_seen: cycles[cycles.length - 1] ?? null },
      lease_records: scoped.length,
      wells_ranked: all.length,
      // Every well's estimate summed. It equals the operator's filed total only
      // where it holds every well on every one of its leases.
      allocated_totals: totals,
      wells: ranked.slice(0, limit),
      truncated: ranked.length > limit || truncatedLeases,
      notes: [
        ...ALLOCATION_NOTES,
        "Ranked across every lease the operator is on. A well's estimate is its share of ITS OWN lease, so two wells here are comparable to each other even though nothing measured either of them.",
        truncatedLeases
          ? `Only the ${RANK_LEASE_CAP} lease records with the most wells were scored, of ${leases.length}. The tail is missing, so a small well could be absent.`
          : "Every lease record on the operator's current schedule was scored.",
        "Wells on a JOINTLY held lease are in the denominator, so this operator's wells there correctly take less than the whole lease.",
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [
  allocateWell,
  allocationBasis,
  leaseWellRanking,
  operatorWellRanking,
  deliverabilityTrend,
  aof,
  drawdown,
  fluidLevelTrend,
  h15Clock,
];
