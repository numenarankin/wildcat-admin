import { z } from "zod";

import type { SeriesPoint } from "@/lib/scout/rrc-queries";
import type { LeaseMonth } from "@/lib/scout/rrc-types";
import {
  fitDecline,
  forward12moDecline,
  project,
  type DeclineFit,
  type MonthlyRate,
} from "@/lib/wells/arps";
import { clean, daysInCycle, linearFit, mean, monthsBetween, percentile, seeded } from "../math";
import {
  dailyRate,
  ENTITY_SHAPE,
  isError,
  reportedOnly,
  resolveSeries,
  streamValues,
  STREAMS,
  type EntityArgs,
  type Stream,
} from "../series";
import { defineTool, type RrcTool } from "../tool";

/**
 * Time-series analysis over the RRC production mirror: series, decline, cohorts.
 *
 * Two invariants run through every tool here, and both exist because breaking
 * them produces an answer that looks right.
 *
 * 1. The unreported tail is dropped before ANY arithmetic. The RRC runs about
 *    three cycles behind and unfiled months sit in the mirror as zeros, so a fit
 *    through them reports a collapse that is not happening. `reportedOnly` does
 *    it and every result carries `reportedThrough` so the reader can see where
 *    the record actually stops.
 * 2. Monthly volumes become DAILY rates before any decline or trend math. A
 *    28-day February against a 31-day January is a 10% artefact in a fitted Di.
 *
 * The decline model itself is `@/lib/wells/arps`, unchanged and unduplicated:
 * the production overhaul already specifies it, and a second Arps in this file
 * would be two answers to one question with no way to tell which is the app's.
 */

const STREAM_ARG = { stream: z.enum(STREAMS).default("oil") };

/** Enough history for any Texas lease, short enough not to flood a context. */
const MAX_POINTS = 600;
const MAX_COHORT = 50;
const MAX_HORIZON = 240;
const MAX_EVENTS = 60;
/** Forward-projection horizon for a remaining-reserves integral. */
const EUR_MONTHS = 600;
const DAYS_PER_MONTH = 365.25 / 12;

function fail(error: string) {
  return { ok: false as const, error };
}

/** Keep the most recent `n`, and say so when that cut anything. */
function tail<T>(rows: readonly T[], n: number): { rows: T[]; truncated: boolean } {
  return n >= rows.length
    ? { rows: [...rows], truncated: false }
    : { rows: rows.slice(rows.length - n), truncated: true };
}

interface Loaded {
  label: string;
  /** Reported cycles only. Everything downstream reads this. */
  points: SeriesPoint[];
  /** Every cycle including the unpublished tail, for reporting the tail itself. */
  all: SeriesPoint[];
  months: LeaseMonth[] | null;
  reportedThrough: string;
}

async function load(args: EntityArgs): Promise<Loaded | { error: string }> {
  const r = await resolveSeries(args);
  if (isError(r)) return r;
  return {
    label: r.label,
    points: reportedOnly(r.points),
    all: r.points,
    months: r.months,
    reportedThrough: r.reportedThrough,
  };
}

/** A stream as the monthly DAILY-rate series every fit and trend consumes. */
function rates(points: readonly SeriesPoint[], stream: Stream): MonthlyRate[] {
  const { cycles, values } = streamValues(points, stream);
  return cycles.map((cycle, i) => ({ month: cycle, rate: dailyRate(values[i], cycle) }));
}

// ------------------------------------------------------------------ cohorts

/** `oil_gas_code/district_no/lease_no`, the one key a model can type. */
const LEASE_KEY = /^\s*([OGog])\s*\/\s*([^/]+?)\s*\/\s*([^/]+?)\s*$/;

function parseLeaseKey(key: string): EntityArgs | null {
  const m = LEASE_KEY.exec(key);
  if (!m) return null;
  return {
    entity: "lease",
    oil_gas_code: m[1].toUpperCase() as "O" | "G",
    district_no: m[2],
    lease_no: m[3],
  };
}

interface CohortMember {
  key: string;
  loaded: Loaded;
}

async function loadCohort(keys: readonly string[]) {
  const capped = keys.slice(0, MAX_COHORT);
  const settled = await Promise.all(
    capped.map(async (key) => {
      const args = parseLeaseKey(key);
      if (!args) return { key, error: `Not a lease key: "${key}". Use "O/08/12345".` };
      const loaded = await load(args);
      return "error" in loaded ? { key, error: loaded.error } : { key, loaded };
    })
  );
  const members: CohortMember[] = [];
  const failures: { key: string; error: string }[] = [];
  for (const row of settled) {
    if (row.loaded !== undefined) members.push({ key: row.key, loaded: row.loaded });
    else failures.push({ key: row.key, error: row.error ?? "Could not load." });
  }
  return { members, failures, truncated: keys.length > capped.length };
}

// ------------------------------------------------------------------ decline

/**
 * Coefficient of determination in LOG-rate space, which is the space the fit
 * minimises in. An r2 on raw rates would flatter every fit by letting the high
 * early months carry the variance.
 */
function fitR2(fit: DeclineFit, series: readonly MonthlyRate[]): number | null {
  const post = series.filter((r) => r.month >= fit.startMonth && r.rate > 0);
  if (post.length < 2) return null;
  const obs = post.map((r) => Math.log(r.rate));
  const m = mean(obs);
  if (m === null) return null;
  let ssRes = 0;
  let ssTot = 0;
  post.forEach((r, i) => {
    const pred = project(fit, monthsBetween(fit.startMonth, r.month) / 12);
    if (pred > 0) ssRes += (obs[i] - Math.log(pred)) ** 2;
    ssTot += (obs[i] - m) ** 2;
  });
  return ssTot === 0 ? null : 1 - ssRes / ssTot;
}

/**
 * Forward integral of the fitted curve from the END of the fitting window, so
 * this is REMAINING reserves and never original EUR (see the arps.ts header).
 */
function remaining(fit: DeclineFit, limit: number) {
  let eur = 0;
  let monthsToLimit: number | null = null;
  for (let k = 1; k <= EUR_MONTHS; k++) {
    const q = project(fit, fit.spanYears + k / 12);
    if (limit > 0 && q < limit) {
      monthsToLimit = k - 1;
      break;
    }
    eur += q * DAYS_PER_MONTH;
  }
  return {
    remainingEur: eur,
    yearsToLimit: monthsToLimit === null ? null : monthsToLimit / 12,
    horizonYears: EUR_MONTHS / 12,
  };
}

function describeFit(fit: DeclineFit, series: readonly MonthlyRate[], limit: number) {
  return {
    qi: fit.qi,
    Di: fit.Di,
    b: fit.b,
    dMin: fit.dMin,
    tSwitchYears: fit.tSwitch,
    startMonth: fit.startMonth,
    monthsFitted: fit.months,
    spanYears: fit.spanYears,
    r2Log: fitR2(fit, series),
    forward12moDecline: forward12moDecline(fit),
    currentRate: project(fit, fit.spanYears),
    ...remaining(fit, limit),
  };
}

/** Why a fit was refused, in the terms an operator would ask about. */
function noFitReason(series: readonly MonthlyRate[]): string {
  const producing = series.filter((r) => r.rate > 0).length;
  if (producing < 6) return `Only ${producing} reported producing months; a fit needs 6.`;
  return "No sustained post-peak decline in the reported window (flat or rising).";
}

// -------------------------------------------------------------------- tools

export const TOOLS: RrcTool[] = [
  defineTool(
    "rrc_series",
    "Full monthly volume and daily-rate history for one entity and stream, with the unpublished tail listed separately.",
    { ...ENTITY_SHAPE, ...STREAM_ARG, months: z.number().int().positive().optional() },
    async (args) => {
      const s = await load(args);
      if ("error" in s) return fail(s.error);
      const { cycles, values } = streamValues(s.points, args.stream);
      const all = cycles.map((cycle, i) => ({
        cycle,
        volume: values[i],
        dailyRate: dailyRate(values[i], cycle),
      }));
      const { rows, truncated } = tail(all, Math.min(args.months ?? MAX_POINTS, MAX_POINTS));
      return {
        ok: true,
        label: s.label,
        stream: args.stream,
        reportedThrough: s.reportedThrough,
        reportedMonths: all.length,
        points: rows,
        /** Cycles the RRC has not published. Zeros here mean unfiled, not idle. */
        unpublishedTail: s.all.filter((p) => !p.reported).map((p) => p.cycle),
        truncated,
      };
    }
  ),

  defineTool(
    "rrc_cohort_series",
    'Monthly daily-rate history for several leases in one call; each key is "oil_gas_code/district_no/lease_no", e.g. "O/08/12345".',
    {
      leases: z.array(z.string()).min(1),
      ...STREAM_ARG,
      months: z.number().int().positive().default(60),
    },
    async (args) => {
      const cohort = await loadCohort(args.leases);
      if (!cohort.members.length) {
        return fail(`No lease resolved. ${cohort.failures.map((f) => f.error).join(" ")}`);
      }
      let cut = cohort.truncated;
      const series = cohort.members.map((m) => {
        const r = rates(m.loaded.points, args.stream);
        const { rows, truncated } = tail(r, Math.min(args.months, MAX_POINTS));
        if (truncated) cut = true;
        return {
          key: m.key,
          label: m.loaded.label,
          reportedThrough: m.loaded.reportedThrough,
          points: rows.map((p) => ({ cycle: p.month, dailyRate: p.rate })),
        };
      });
      return {
        ok: true,
        stream: args.stream,
        leases: series,
        unresolved: cohort.failures,
        truncated: cut,
      };
    }
  ),

  defineTool(
    "rrc_decline",
    "Fit a modified-Arps decline to one entity's reported history: qi, Di, b, fit quality, remaining reserves and years to an economic limit.",
    {
      ...ENTITY_SHAPE,
      ...STREAM_ARG,
      economic_limit: z.number().nonnegative().default(0),
      d_min: z.number().positive().optional(),
    },
    async (args) => {
      const s = await load(args);
      if ("error" in s) return fail(s.error);
      const series = rates(s.points, args.stream);
      const fit = fitDecline(series, args.d_min ? { dMinAnnual: args.d_min } : {});
      return {
        ok: true,
        label: s.label,
        stream: args.stream,
        reportedThrough: s.reportedThrough,
        economicLimit: args.economic_limit,
        fit: fit ? describeFit(fit, series, args.economic_limit) : null,
        reason: fit ? null : noFitReason(series),
      };
    }
  ),

  defineTool(
    "rrc_series_stats",
    "Trailing rates, month-over-month, year-over-year, CAGR, peak, months since peak, producing-month count and intermittency for one entity.",
    { ...ENTITY_SHAPE, ...STREAM_ARG },
    async (args) => {
      const s = await load(args);
      if ("error" in s) return fail(s.error);
      const series = rates(s.points, args.stream);
      const { cycles, values } = streamValues(s.points, args.stream);
      if (!series.length) return fail(`No reported ${args.stream} history for ${s.label}.`);

      const n = series.length;
      const avgRate = (k: number) =>
        n >= k ? mean(series.slice(n - k).map((r) => r.rate)) : null;
      const volume = (from: number, count: number) =>
        from >= 0 ? values.slice(from, from + count).reduce((a, b) => a + b, 0) : null;

      const last12 = volume(n - 12, 12);
      const prior12 = volume(n - 24, 12);
      const first12 = n >= 24 ? volume(0, 12) : null;

      let peak = 0;
      for (let i = 1; i < n; i++) if (series[i].rate > series[peak].rate) peak = i;

      const producing = values.filter((v) => v > 0).length;
      const firstProd = values.findIndex((v) => v > 0);
      // Idle months BETWEEN the first and last producing month. Counting the
      // pre-production lead-in would call every young lease intermittent.
      const lastProd = values.length - 1 - [...values].reverse().findIndex((v) => v > 0);
      const spanMonths = firstProd < 0 ? 0 : lastProd - firstProd + 1;
      const idle = spanMonths - producing;

      return {
        ok: true,
        label: s.label,
        stream: args.stream,
        reportedThrough: s.reportedThrough,
        reportedMonths: n,
        firstCycle: cycles[0],
        lastCycle: cycles[n - 1],
        dailyRate: {
          last1: avgRate(1),
          last3: avgRate(3),
          last6: avgRate(6),
          last12: avgRate(12),
        },
        momPct:
          n >= 2 && series[n - 2].rate > 0
            ? (series[n - 1].rate / series[n - 2].rate - 1) * 100
            : null,
        yoyPct: last12 !== null && prior12 ? (last12 / prior12 - 1) * 100 : null,
        // Compounded between the first and last full reported year of volume.
        cagrPct:
          first12 && last12 !== null && n >= 24
            ? (Math.pow(last12 / first12, 12 / (n - 12)) - 1) * 100
            : null,
        peak: { cycle: series[peak].month, dailyRate: series[peak].rate },
        monthsSincePeak: n - 1 - peak,
        producingMonths: producing,
        idleMonths: idle,
        intermittency: spanMonths > 0 ? idle / spanMonths : null,
      };
    }
  ),

  defineTool(
    "rrc_changepoint",
    "Shut-ins, restarts and sustained step changes in one entity's reported rate history.",
    { ...ENTITY_SHAPE, ...STREAM_ARG, threshold: z.number().positive().default(0.35) },
    async (args) => {
      const s = await load(args);
      if ("error" in s) return fail(s.error);
      const series = rates(s.points, args.stream);
      const events: {
        cycle: string;
        type: "shutin" | "restart" | "step_up" | "step_down";
        before: number | null;
        after: number | null;
        changePct: number | null;
      }[] = [];

      for (let i = 1; i < series.length; i++) {
        const prev = series[i - 1].rate;
        const cur = series[i].rate;
        if (prev > 0 && cur === 0) {
          events.push({ cycle: series[i].month, type: "shutin", before: prev, after: 0, changePct: -100 });
        } else if (prev === 0 && cur > 0) {
          events.push({ cycle: series[i].month, type: "restart", before: 0, after: cur, changePct: null });
        }
      }

      // A step is a shift in the 3-month mean either side of a boundary. Steps
      // are held 3 months apart so one shift is one event, not a run of them.
      let lastStep = -99;
      for (let i = 3; i + 2 < series.length; i++) {
        const before = mean(series.slice(i - 3, i).map((r) => r.rate));
        const after = mean(series.slice(i, i + 3).map((r) => r.rate));
        if (!before || !after) continue;
        const change = after / before - 1;
        if (Math.abs(change) < args.threshold || i - lastStep < 3) continue;
        lastStep = i;
        events.push({
          cycle: series[i].month,
          type: change > 0 ? "step_up" : "step_down",
          before,
          after,
          changePct: change * 100,
        });
      }

      events.sort((a, b) => (a.cycle < b.cycle ? -1 : 1));
      const { rows, truncated } = tail(events, MAX_EVENTS);
      return {
        ok: true,
        label: s.label,
        stream: args.stream,
        reportedThrough: s.reportedThrough,
        threshold: args.threshold,
        reportedMonths: series.length,
        events: rows,
        truncated,
      };
    }
  ),

  defineTool(
    "rrc_type_curve",
    "P10/P50/P90 rate bands for a lease cohort normalized to months from first production (p10 is the HIGH case, the reserves convention).",
    {
      leases: z.array(z.string()).min(2),
      ...STREAM_ARG,
      months: z.number().int().positive().default(60),
    },
    async (args) => {
      const cohort = await loadCohort(args.leases);
      if (cohort.members.length < 2) {
        return fail(
          `A type curve needs at least 2 leases; ${cohort.members.length} resolved. ${cohort.failures
            .map((f) => f.error)
            .join(" ")}`
        );
      }
      // Normalize: drop everything before each lease's first producing month, so
      // month 0 is first production and not a shared calendar date.
      const normalized = cohort.members.map((m) => {
        const r = rates(m.loaded.points, args.stream);
        const start = r.findIndex((p) => p.rate > 0);
        return {
          key: m.key,
          label: m.loaded.label,
          firstProduction: start < 0 ? null : r[start].month,
          rates: start < 0 ? [] : r.slice(start).map((p) => p.rate),
        };
      });
      const contributing = normalized.filter((l) => l.rates.length > 0);
      if (contributing.length < 2) return fail("Fewer than 2 leases have any reported production.");

      const horizon = Math.min(
        args.months,
        MAX_HORIZON,
        Math.max(...contributing.map((l) => l.rates.length))
      );
      const curve = [];
      for (let t = 0; t < horizon; t++) {
        const vals = clean(contributing.map((l) => (t < l.rates.length ? l.rates[t] : null)));
        if (!vals.length) break;
        curve.push({
          month: t,
          n: vals.length,
          p10: percentile(vals, 0.9),
          p50: percentile(vals, 0.5),
          p90: percentile(vals, 0.1),
          mean: mean(vals),
        });
      }
      return {
        ok: true,
        stream: args.stream,
        convention: "p10 is the high case (exceeded by 10% of the cohort), p90 the low case",
        leases: contributing.map((l) => ({
          key: l.key,
          label: l.label,
          firstProduction: l.firstProduction,
          months: l.rates.length,
        })),
        // The band thins as the cohort ages out, so `n` per month is the caveat.
        curve,
        unresolved: cohort.failures,
        truncated: cohort.truncated || horizon < Math.max(...contributing.map((l) => l.rates.length)),
      };
    }
  ),

  defineTool(
    "rrc_peer_rank",
    "Percentile rank of one entity against a peer cohort of leases on cumulative, trailing-12-month, peak rate, decline or producing months.",
    {
      ...ENTITY_SHAPE,
      peers: z.array(z.string()).min(1),
      ...STREAM_ARG,
      metric: z.enum(["cum", "last12", "peak_rate", "decline", "months_producing"]).default("last12"),
    },
    async (args) => {
      const s = await load(args);
      if ("error" in s) return fail(s.error);
      const metric = (points: readonly SeriesPoint[]): number | null => {
        const { values } = streamValues(points, args.stream);
        const r = rates(points, args.stream);
        switch (args.metric) {
          case "cum":
            return values.reduce((a, b) => a + b, 0);
          case "last12":
            return values.length ? values.slice(-12).reduce((a, b) => a + b, 0) : null;
          case "peak_rate":
            return r.length ? Math.max(...r.map((p) => p.rate)) : null;
          case "decline": {
            const fit = fitDecline(r);
            return fit ? forward12moDecline(fit) : null;
          }
          case "months_producing":
            return values.filter((v) => v > 0).length;
        }
      };

      const subject = metric(s.points);
      if (subject === null) return fail(`No reported ${args.stream} history for ${s.label}.`);
      const cohort = await loadCohort(args.peers);
      const scored = cohort.members
        .map((m) => ({ key: m.key, label: m.loaded.label, value: metric(m.loaded.points) }))
        .filter((p): p is { key: string; label: string; value: number } => p.value !== null);
      if (!scored.length) return fail("No peer had a value for that metric.");

      const below = scored.filter((p) => p.value < subject).length;
      return {
        ok: true,
        label: s.label,
        stream: args.stream,
        metric: args.metric,
        reportedThrough: s.reportedThrough,
        value: subject,
        peerCount: scored.length,
        betterThan: below,
        percentileRank: (below / scored.length) * 100,
        peerMedian: percentile(scored.map((p) => p.value), 0.5),
        peers: scored.sort((a, b) => b.value - a.value),
        unresolved: cohort.failures,
        truncated: cohort.truncated,
      };
    }
  ),

  defineTool(
    "rrc_ratios",
    "GOR, condensate yield per MMcf and casinghead share month by month for one entity, with their trends.",
    { ...ENTITY_SHAPE, months: z.number().int().positive().default(120) },
    async (args) => {
      const s = await load(args);
      if ("error" in s) return fail(s.error);
      const all = s.points.map((p) => {
        const gas = p.gas + p.csgd;
        const liquid = p.oil + p.cond;
        return {
          cycle: p.cycle,
          // One formula for both lease types: an oil lease carries its gas in
          // csgd and its liquid in oil, a gas lease in gas and cond.
          gorScfPerBbl: liquid > 0 ? (gas * 1000) / liquid : null,
          condYieldBblPerMMcf: gas > 0 ? (p.cond * 1000) / gas : null,
          casingheadShare: gas > 0 ? p.csgd / gas : null,
        };
      });
      const trend = (pick: (row: (typeof all)[number]) => number | null) => {
        const pts = all
          .map((row, i) => [i, pick(row)] as const)
          .filter((p): p is readonly [number, number] => p[1] !== null);
        const f = linearFit(pts);
        return f ? { slopePerMonth: f.slope, r2: f.r2, n: f.n } : null;
      };
      const { rows, truncated } = tail(all, Math.min(args.months, MAX_POINTS));
      return {
        ok: true,
        label: s.label,
        reportedThrough: s.reportedThrough,
        monthly: rows,
        trend: {
          gor: trend((r) => r.gorScfPerBbl),
          condYield: trend((r) => r.condYieldBblPerMMcf),
          casinghead: trend((r) => r.casingheadShare),
        },
        // Not a gap we can fill by inference: the monthly filings carry no
        // produced-water volume at all. Water appears only on W-10 and G-10
        // tests, which are single-day spot rates on the well tools.
        waterCut: null,
        waterCutNote: "RRC monthly production filings carry no produced water; use the W-10/G-10 well tests.",
        truncated,
      };
    }
  ),

  defineTool(
    "rrc_ip",
    "IP30, IP90 and IP180 plus time to peak for one entity, normalized to its first reported producing month.",
    { ...ENTITY_SHAPE, ...STREAM_ARG },
    async (args) => {
      const s = await load(args);
      if ("error" in s) return fail(s.error);
      const { cycles, values } = streamValues(s.points, args.stream);
      const start = values.findIndex((v) => v > 0);
      if (start < 0) return fail(`No reported ${args.stream} production for ${s.label}.`);

      // Volume over calendar days, not volume over 30, so a 28-day February in
      // the window does not inflate the rate.
      const ip = (months: number) => {
        if (start + months > values.length) return null;
        let vol = 0;
        let days = 0;
        for (let i = start; i < start + months; i++) {
          vol += values[i];
          days += daysInCycle(cycles[i]);
        }
        return days > 0 ? vol / days : null;
      };

      const r = rates(s.points, args.stream).slice(start);
      let peak = 0;
      for (let i = 1; i < r.length; i++) if (r[i].rate > r[peak].rate) peak = i;

      return {
        ok: true,
        label: s.label,
        stream: args.stream,
        reportedThrough: s.reportedThrough,
        firstProduction: cycles[start],
        monthsOfHistory: values.length - start,
        ip30: ip(1),
        ip90: ip(3),
        ip180: ip(6),
        peak: { cycle: r[peak].month, dailyRate: r[peak].rate },
        monthsToPeak: peak,
        note: "IP30 is the first calendar month, which is partial whenever the lease came on mid-month, so it understates.",
      };
    }
  ),

  defineTool(
    "rrc_portfolio_roll",
    'Sum several leases into one series with an explicit unfiled-month policy: "skip" drops months that are not complete, "zero" counts an unfiled lease as zero.',
    {
      leases: z.array(z.string()).min(1),
      ...STREAM_ARG,
      missing: z.enum(["skip", "zero"]),
      months: z.number().int().positive().default(120),
    },
    async (args) => {
      const cohort = await loadCohort(args.leases);
      if (!cohort.members.length) {
        return fail(`No lease resolved. ${cohort.failures.map((f) => f.error).join(" ")}`);
      }
      // A lease-month counts only when the RRC has BOTH published the cycle and
      // the operator has filed it. `prod_report_filed = 'N'` on 18% of
      // lease-months, and a zero there means unfiled, never idle. Null is
      // unknown, which we take as filed rather than punish the lease for.
      const filed = cohort.members.map((m) => {
        const byCycle = new Map<string, number>();
        const unfiled = new Set<string>();
        const monthly = m.loaded.months;
        if (monthly) {
          for (const row of monthly) {
            if (!row.reported) continue;
            if (row.prod_report_filed === "N") unfiled.add(row.cycle);
            else byCycle.set(row.cycle, streamOf(row, args.stream));
          }
        } else {
          for (const p of m.loaded.points) byCycle.set(p.cycle, p[args.stream] ?? 0);
        }
        return { key: m.key, label: m.loaded.label, byCycle, unfiled };
      });

      const universe = [...new Set(filed.flatMap((l) => [...l.byCycle.keys()]))].sort();
      const series: { cycle: string; total: number; reporting: number; missing: number }[] = [];
      let affectedMonths = 0;
      let missingLeaseMonths = 0;
      let skippedMonths = 0;

      for (const cycle of universe) {
        const present = filed.filter((l) => l.byCycle.has(cycle));
        const gap = filed.length - present.length;
        if (gap > 0) {
          affectedMonths++;
          missingLeaseMonths += gap;
          if (args.missing === "skip") {
            skippedMonths++;
            continue;
          }
        }
        series.push({
          cycle,
          total: present.reduce((a, l) => a + (l.byCycle.get(cycle) ?? 0), 0),
          reporting: present.length,
          missing: gap,
        });
      }

      const { rows, truncated } = tail(series, Math.min(args.months, MAX_POINTS));
      return {
        ok: true,
        stream: args.stream,
        policy: args.missing,
        leaseCount: filed.length,
        reportedThrough: cohort.members[0].loaded.reportedThrough,
        cyclesInUniverse: universe.length,
        affectedMonths,
        missingLeaseMonths,
        skippedMonths,
        series: rows,
        leases: filed.map((l) => ({
          key: l.key,
          label: l.label,
          filedMonths: l.byCycle.size,
          unfiledMonths: l.unfiled.size,
        })),
        unresolved: cohort.failures,
        // Either end can cut this: the series was trimmed to `months`, or the
        // cohort itself was capped. A portfolio total quietly missing leases is
        // the one answer here nobody could catch by reading it.
        truncated: truncated || cohort.truncated,
      };
    }
  ),

  defineTool(
    "rrc_flow_regime",
    "Classify an entity's flow regime from log-log rate against time and rate against cumulative, and name the month boundary-dominated decline starts.",
    { ...ENTITY_SHAPE, ...STREAM_ARG },
    async (args) => {
      const s = await load(args);
      if ("error" in s) return fail(s.error);
      const { cycles, values } = streamValues(s.points, args.stream);
      const start = values.findIndex((v) => v > 0);
      if (start < 0) return fail(`No reported ${args.stream} production for ${s.label}.`);

      // t at the MIDPOINT of each month since first production, so month 0 has a
      // finite log and every point sits at the time its rate averages over.
      const pts: { cycle: string; t: number; q: number; np: number }[] = [];
      let cum = 0;
      for (let i = start; i < values.length; i++) {
        cum += values[i];
        const q = dailyRate(values[i], cycles[i]);
        if (q > 0) pts.push({ cycle: cycles[i], t: i - start + 0.5, q, np: cum });
      }
      if (pts.length < 6) return fail(`Only ${pts.length} producing months; a regime read needs 6.`);

      const logFit = linearFit(pts.map((p) => [Math.log(p.t), Math.log(p.q)] as const));
      const cumFit = linearFit(pts.map((p) => [p.np, p.q] as const));

      // Earliest start whose rate-vs-cumulative line is straight and falling:
      // past that point the reservoir is depleting against its boundary and an
      // Arps fit is legitimate. Anything earlier is transient and would fit a
      // decline that the well is not on yet.
      let bdfStart: string | null = null;
      for (let i = 0; i + 6 <= pts.length; i++) {
        const seg = linearFit(pts.slice(i).map((p) => [p.np, p.q] as const));
        if (seg && seg.slope < 0 && (seg.r2 ?? 0) >= 0.9) {
          bdfStart = pts[i].cycle;
          break;
        }
      }

      const m = logFit?.slope ?? null;
      const boundary = cumFit !== null && cumFit.slope < 0 && (cumFit.r2 ?? 0) >= 0.9;
      const regime =
        m === null
          ? "unknown"
          : boundary
            ? "boundary_dominated"
            : m > -0.15
              ? "flat_or_rising"
              : m >= -0.35
                ? "bilinear"
                : m >= -0.65
                  ? "linear"
                  : "transitional";

      return {
        ok: true,
        label: s.label,
        stream: args.stream,
        reportedThrough: s.reportedThrough,
        producingMonths: pts.length,
        regime,
        logLogSlope: m,
        logLogR2: logFit?.r2 ?? null,
        rateVsCumSlope: cumFit?.slope ?? null,
        rateVsCumR2: cumFit?.r2 ?? null,
        bdfStart,
        note: "Slopes near -1/4 read bilinear, near -1/2 linear; a straight falling rate against cumulative is boundary-dominated and is what an Arps fit assumes.",
      };
    }
  ),

  defineTool(
    "rrc_decline_ci",
    "Bootstrap confidence bands on the DECLINE parameters specifically (qi, Di, b, remaining reserves) from an explicit integer seed, so the numbers reproduce exactly. For an interval on any other fitted quantity, use rrc_uncertainty_ci.",
    {
      ...ENTITY_SHAPE,
      ...STREAM_ARG,
      seed: z.number().int(),
      iterations: z.number().int().min(20).max(1000).default(200),
      economic_limit: z.number().nonnegative().default(0),
    },
    async (args) => {
      const s = await load(args);
      if ("error" in s) return fail(s.error);
      const series = rates(s.points, args.stream);
      const base = fitDecline(series);
      if (!base) {
        return {
          ok: true,
          label: s.label,
          stream: args.stream,
          // The edge belongs on this branch too: without it "no fit" reads as a
          // dead lease rather than as a record that stops three months back.
          reportedThrough: s.reportedThrough,
          seed: args.seed,
          fit: null,
          reason: noFitReason(series),
        };
      }

      // Residual bootstrap in log space: resample the fit's own log residuals
      // onto the SAME month grid. Resampling months instead would duplicate
      // cycles and hand the despike and peak search a series no lease can have.
      const post = series.filter((r) => r.month >= base.startMonth && r.rate > 0);
      const fitted = post.map((r) => project(base, monthsBetween(base.startMonth, r.month) / 12));
      const resid = post.map((r, i) => Math.log(r.rate) - Math.log(fitted[i]));
      const rand = seeded(args.seed);

      const draws: { qi: number; Di: number; b: number; eur: number }[] = [];
      for (let it = 0; it < args.iterations; it++) {
        const sample = post.map((r, i) => ({
          month: r.month,
          rate: fitted[i] * Math.exp(resid[Math.floor(rand() * resid.length)]),
        }));
        const f = fitDecline(sample);
        if (f) draws.push({ qi: f.qi, Di: f.Di, b: f.b, eur: remaining(f, args.economic_limit).remainingEur });
      }
      const band = (pick: (d: (typeof draws)[number]) => number) => {
        const vals = draws.map(pick);
        return {
          lo: percentile(vals, 0.1),
          median: percentile(vals, 0.5),
          hi: percentile(vals, 0.9),
        };
      };

      return {
        ok: true,
        label: s.label,
        stream: args.stream,
        reportedThrough: s.reportedThrough,
        seed: args.seed,
        iterations: args.iterations,
        converged: draws.length,
        fit: describeFit(base, series, args.economic_limit),
        // lo/hi are the 10th and 90th PERCENTILES of the bootstrap draws, so
        // `lo` is the low value. Not the reserves p10/p90, which invert.
        ci: draws.length
          ? { qi: band((d) => d.qi), Di: band((d) => d.Di), b: band((d) => d.b), remainingEur: band((d) => d.eur) }
          : null,
      };
    }
  ),
];

/** One stream off a lease-grain month. Nulls are unreported, so they read 0 here. */
function streamOf(row: LeaseMonth, stream: Stream): number {
  switch (stream) {
    case "oil":
      return row.oil_prod_vol ?? 0;
    case "gas":
      return row.gas_prod_vol ?? 0;
    case "cond":
      return row.cond_prod_vol ?? 0;
    case "csgd":
      return row.csgd_prod_vol ?? 0;
  }
}
