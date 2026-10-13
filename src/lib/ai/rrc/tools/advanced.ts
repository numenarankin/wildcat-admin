import "server-only";

import { z } from "zod";

import { rrcQuery } from "@/lib/scout/rrc-db";
import {
  findDisposal,
  getCountyProfile,
  getCycleEdge,
  getFieldProfile,
  getLeaseDossier,
  getOperatorDossier,
  getOperatorNetwork,
  getProductionTrend,
  listPermits,
  resolveCounty,
} from "@/lib/scout/rrc-queries";
import type { LeaseMonth } from "@/lib/scout/rrc-types";
import { fitDecline, type MonthlyRate } from "@/lib/wells/arps";
import {
  addMonths,
  clean,
  daysInCycle,
  distanceMiles,
  hhi,
  linearFit,
  mean,
  median,
  monthsBetween,
  percentile,
  seeded,
  stddev,
  sum,
} from "../math";
import { offsetWellbores } from "../offsets";
import {
  dailyRate,
  ENTITY_SHAPE,
  isError,
  reportedOnly,
  resolveSeries,
  streamValues,
  type EntityArgs,
} from "../series";
import { defineTool, type RrcTool } from "../tool";

/**
 * Statistical method over data the rest of the catalog already fetches.
 *
 * Nothing here reaches a new dataset for its own sake: these are nowcasting,
 * reconciliation, matched comparison, survival, geostatistics, clustering and
 * market structure applied to the same mirror every other tool reads.
 *
 * ## The rule this file exists under
 *
 * AN ESTIMATE MUST NEVER PASS AS A FILING. `rrc_nowcast`, `rrc_impute_gaps` and
 * `rrc_recovery_proxy` emit numbers shaped exactly like reported volumes, and a
 * reader three steps downstream cannot tell them apart by looking. So every
 * such number carries `basis`, and any total that touches both kinds reports
 * them SEPARATELY through `splitTotal`, which has no combined field to read.
 * Adding one would undo the whole file.
 *
 * ## Two more that decide whether an answer is real
 *
 *   1. Report n and fit quality on everything fitted. A regression on four
 *      points and one on four hundred are different answers, and the model
 *      cannot tell unless we say so.
 *   2. Refuse below the population a method needs. A refusal is a value; a
 *      Kaplan-Meier curve over three wells is not.
 *
 * Sampling is seeded, always, with the seed returned. The platform's unseeded
 * generator does not appear in this file, and a test asserts that, because the
 * one part of this system carrying error bars must not be the one part nobody
 * can reproduce.
 */

// --------------------------------------------------------------- primitives

function fail(error: string) {
  return { ok: false as const, error };
}

/** Clamp an optional integer argument into a range the queries can afford. */
function cap(value: number | undefined, lo: number, hi: number, fallback: number): number {
  const n = Math.floor(value ?? fallback);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** RRC dates arrive as 8-digit text on the wellbore tables: "19780914". */
function date8(raw: string | null | undefined): { iso: string; year: number; months: number } | null {
  const s = (raw ?? "").replace(/[^0-9]/g, "");
  if (s.length !== 8) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  if (year < 1900 || year > 2100 || month < 1 || month > 12) return null;
  return { iso: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, year, months: year * 12 + (month - 1) };
}

/** A `YYYY-MM` cycle as an absolute month index, for durations. */
function cycleMonths(cycle: string): number {
  const [y, m] = cycle.split("-").map(Number);
  return y * 12 + (m - 1);
}

const FILED = "filed" as const;
const ESTIMATED = "estimated" as const;

/**
 * Filed and estimated volumes, side by side and never added.
 *
 * There is no combined field ON PURPOSE. A caller that wants one has to write
 * the addition itself, in the open, which is the point: this shape makes the
 * mistake visible instead of convenient.
 */
function splitTotal(filed: number, estimated: number) {
  return {
    filed,
    filed_basis: FILED,
    estimated,
    estimated_basis: ESTIMATED,
    combined: null,
    note: "Filed and estimated volumes are reported separately and are never summed. Quoting the two as one number would present an estimate as a filing.",
  };
}

// ------------------------------------------------------------------ statistics

/**
 * Kaplan-Meier product-limit estimator over (duration, event) pairs.
 *
 * Exported so the curve can be checked directly against a hand-computed one.
 * The tools that use it refuse below twenty wells, and a survival estimator is
 * worth verifying on the six-well case a refusal will never let through.
 */
export function kaplanMeier(rows: readonly { t: number; event: boolean }[]) {
  const eventTimes = [...new Set(rows.filter((r) => r.event).map((r) => r.t))].sort((a, b) => a - b);
  let s = 1;
  const curve: { t: number; at_risk: number; events: number; survival: number }[] = [];
  for (const t of eventTimes) {
    const atRisk = rows.filter((r) => r.t >= t).length;
    const events = rows.filter((r) => r.event && r.t === t).length;
    if (atRisk === 0) continue;
    s *= 1 - events / atRisk;
    curve.push({ t, at_risk: atRisk, events, survival: s });
  }
  return curve;
}

/** Survival at time t: the last step at or before t, 1 before the first event. */
function survivalAt(curve: readonly { t: number; survival: number }[], t: number): number {
  let s = 1;
  for (const p of curve) {
    if (p.t <= t) s = p.survival;
    else break;
  }
  return s;
}

/** First time the curve reaches 50%, or null when it never does. */
function medianSurvival(curve: readonly { t: number; survival: number }[]): number | null {
  return curve.find((p) => p.survival <= 0.5)?.t ?? null;
}

/**
 * Percentile bootstrap. Deterministic given `seed`, and the seed is returned by
 * every caller so a number with error bars can be reproduced exactly.
 */
function bootstrap(
  values: readonly number[],
  stat: (sample: number[]) => number | null,
  iterations: number,
  seed: number
) {
  const rnd = seeded(seed);
  const draws: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample = values.map(() => values[Math.floor(rnd() * values.length)]);
    const s = stat(sample);
    if (s !== null && Number.isFinite(s)) draws.push(s);
  }
  draws.sort((a, b) => a - b);
  return {
    p05: percentile(draws, 0.05),
    p50: percentile(draws, 0.5),
    p95: percentile(draws, 0.95),
    draws: draws.length,
    iterations,
    seed,
  };
}

/** One-way variance decomposition: the share of variance a factor explains. */
function etaSquared(rows: readonly { group: string; y: number }[]) {
  if (rows.length < 3) return null;
  const grand = mean(rows.map((r) => r.y));
  if (grand === null) return null;
  const ssTot = rows.reduce((a, r) => a + (r.y - grand) ** 2, 0);
  if (ssTot === 0) return null;
  const groups = new Map<string, number[]>();
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r.y]);
  let ssBetween = 0;
  for (const ys of groups.values()) {
    const m = mean(ys);
    if (m !== null) ssBetween += ys.length * (m - grand) ** 2;
  }
  return { r2: ssBetween / ssTot, groups: groups.size, n: rows.length };
}

/** Gaussian elimination with partial pivoting. Null when the system is singular. */
function solve(a: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** Exponential semivariogram. `range` is the practical range (95% of sill). */
interface Variogram {
  nugget: number;
  sill: number;
  range_mi: number;
}
function gamma(model: Variogram, h: number): number {
  if (h <= 0) return 0;
  return model.nugget + (model.sill - model.nugget) * (1 - Math.exp((-3 * h) / model.range_mi));
}

interface SpatialPoint {
  api_number: string;
  lat: number;
  lon: number;
  value: number;
}

/** Binned experimental semivariogram: 0.5 * mean squared difference per lag. */
function experimentalVariogram(points: readonly SpatialPoint[], bins: number, maxLagMi: number) {
  const width = maxLagMi / bins;
  const acc = Array.from({ length: bins }, () => ({ sum: 0, pairs: 0, dist: 0 }));
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const h = distanceMiles(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
      if (h <= 0 || h > maxLagMi) continue;
      const b = Math.min(bins - 1, Math.floor(h / width));
      acc[b].sum += (points[i].value - points[j].value) ** 2;
      acc[b].pairs += 1;
      acc[b].dist += h;
    }
  }
  return acc
    .map((a, i) => ({
      lag_mi: a.pairs ? a.dist / a.pairs : (i + 0.5) * width,
      gamma: a.pairs ? a.sum / (2 * a.pairs) : null,
      pairs: a.pairs,
    }))
    .filter((b) => b.pairs > 0);
}

/** Fit range and nugget by a deterministic grid search over the binned curve. */
function fitVariogram(
  bins: readonly { lag_mi: number; gamma: number | null; pairs: number }[],
  sill: number,
  maxLagMi: number
): { model: Variogram; sse: number } | null {
  const usable = bins.filter((b): b is { lag_mi: number; gamma: number; pairs: number } => b.gamma !== null);
  if (usable.length < 3) return null;
  let best: { model: Variogram; sse: number } | null = null;
  for (let r = 1; r <= 40; r++) {
    const range = (maxLagMi * r) / 40;
    for (let k = 0; k <= 4; k++) {
      const model = { nugget: (sill * k) / 8, sill, range_mi: range };
      const sse = usable.reduce((a, b) => a + b.pairs * (b.gamma - gamma(model, b.lag_mi)) ** 2, 0);
      if (!best || sse < best.sse) best = { model, sse };
    }
  }
  return best;
}

/**
 * Ordinary kriging over a LOCAL neighbourhood.
 *
 * Local because a global solve is an n x n system for every target and Texas
 * well counts make that both slow and numerically miserable; 16 neighbours is
 * the standard working choice and keeps the matrix trivially solvable. Falls
 * back to inverse distance when the system is singular (repeated coordinates),
 * and says so rather than returning a number with a hidden method.
 */
function krigeAt(
  points: readonly SpatialPoint[],
  target: { lat: number; lon: number },
  model: Variogram,
  k: number
) {
  const near = [...points]
    .map((p) => ({ p, d: distanceMiles(p.lat, p.lon, target.lat, target.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k);
  if (!near.length) return null;
  const n = near.length;
  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      row.push(gamma(model, distanceMiles(near[i].p.lat, near[i].p.lon, near[j].p.lat, near[j].p.lon)));
    }
    row.push(1);
    A.push(row);
  }
  A.push([...Array(n).fill(1), 0]);
  const b = [...near.map((x) => gamma(model, x.d)), 1];
  const w = solve(A, b);
  if (!w) {
    const total = near.reduce((a, x) => a + 1 / Math.max(1e-6, x.d), 0);
    const value = near.reduce((a, x) => a + (x.p.value / Math.max(1e-6, x.d)) / total, 0);
    return { value, variance: null, method: "idw_fallback" as const, neighbours: n, nearest_mi: near[0].d };
  }
  const value = near.reduce((a, x, i) => a + w[i] * x.p.value, 0);
  const variance = near.reduce((a, x, i) => a + w[i] * gamma(model, x.d), 0) + w[n];
  return {
    value,
    variance: Math.max(0, variance),
    method: "ordinary_kriging" as const,
    neighbours: n,
    nearest_mi: near[0].d,
  };
}

// ---------------------------------------------------------------- mirror reads

interface WellKey {
  api: string;
  /** The real district label (7B, 8A), which is what W-10 keys on. */
  district: string | null;
  oil_gas_code: string | null;
  lease_no: string | null;
  well_no: string | null;
  field_name: string | null;
  well_type: string | null;
  /** ORIGINAL completion where filed: a recompletion date would misdate the hole. */
  completion_date: string | null;
  plug_date: string | null;
  shut_in_date: string | null;
}

/**
 * The schedule row behind each API, in one round trip.
 *
 * `distinct on (api_number) order by on_schedule desc` takes the CURRENT
 * assignment: `rrc.wellbore` is one row per well x lease x field and a historic
 * row points at a lease this hole has left.
 */
async function wellKeys(apis: readonly string[]): Promise<Map<string, WellKey>> {
  if (!apis.length) return new Map();
  const rows = await rrcQuery<Record<string, string | null>>(
    `select distinct on (api_number)
            trim(api_number) as api, district, oil_gas_code, lease_number, well_no,
            field_name, well_type_name, completion_date, orig_completion_dt,
            plug_date, wb_shut_in_date
       from rrc.wellbore
      where api_number = any($1::bpchar[])
      order by api_number, on_schedule desc nulls last`,
    [apis]
  );
  return new Map(
    rows.map((r) => [
      r.api ?? "",
      {
        api: r.api ?? "",
        district: r.district?.trim() || null,
        oil_gas_code: r.oil_gas_code?.trim() || null,
        lease_no: r.lease_number?.trim() || null,
        well_no: r.well_no?.trim() || null,
        field_name: r.field_name?.trim() || null,
        well_type: r.well_type_name?.trim() || null,
        completion_date: r.orig_completion_dt || r.completion_date || null,
        plug_date: r.plug_date || null,
        shut_in_date: r.wb_shut_in_date || null,
      },
    ])
  );
}

interface OilTest {
  api: string;
  test_date: string | null;
  daily_oil: number | null;
  daily_water: number | null;
  daily_gas: number | null;
  gas_oil_ratio: number | null;
}

const MAX_TEST_ROWS = 4000;

/**
 * W-10 tests for a population in one round trip.
 *
 * The join is district + lease + well because that is how Texas keys oil, and
 * it goes through `rrc.wellbore` because that is the only table carrying both
 * those keys and an API. `on_schedule = 'Y'` matters: a historic row would
 * attach another lease's tests to this hole.
 */
async function oilTests(apis: readonly string[], latestOnly: boolean): Promise<OilTest[]> {
  if (!apis.length) return [];
  return rrcQuery<OilTest>(
    `select ${latestOnly ? "distinct on (w.api_number)" : ""}
            trim(w.api_number) as api,
            to_char(t.test_date, 'YYYY-MM-DD') as test_date,
            t.daily_oil, t.daily_water, t.daily_gas, t.gas_oil_ratio
       from rrc.wellbore w
       join rrc.w10_test t
         on t.district = w.district and t.lease_no = w.lease_number and t.well_no = w.well_no
      where w.api_number = any($1::bpchar[])
        and w.oil_gas_code = 'O' and w.on_schedule = 'Y'
        and t.test_date is not null
      order by w.api_number, t.test_date desc nulls last
      limit ${MAX_TEST_ROWS}`,
    [apis]
  );
}

/** One well's surface hole, for the tools that start from an API. */
async function wellPoint(api: string): Promise<{ lat: number; lon: number } | null> {
  const rows = await rrcQuery<{ lat: number | null; lon: number | null }>(
    `select lat, lon from rrc.well_location where api_number = $1`,
    [api]
  );
  const r = rows[0];
  return r?.lat != null && r?.lon != null ? { lat: r.lat, lon: r.lon } : null;
}

// ------------------------------------------------------------------- cohorts

interface CohortWell {
  api_number: string;
  operator_name: string | null;
  lease_name: string | null;
  field_name: string | null;
  well_type: string | null;
  lat: number;
  lon: number;
  distance_mi: number;
  total_depth_ft: number | null;
  perf_top_ft: number | null;
  perf_bottom_ft: number | null;
  perf_length_ft: number | null;
  formation_top_ft: number | null;
  completion_date: string | null;
  completion_year: number | null;
  completion_months: number | null;
  /** Nearest other hole in this cohort, feet. The only spacing the file has. */
  spacing_ft: number | null;
  test_date: string | null;
  oil_bbl_per_day: number | null;
  gas_mcf_per_day: number | null;
  water_bbl_per_day: number | null;
  gor: number | null;
}

const FEET_PER_MILE = 5280;

/**
 * Every wellbore in a radius with the attributes the comparison tools need.
 *
 * Three round trips whatever the well count: the radius (which is itself three,
 * inside `offsetWellbores`), the schedule rows, and the latest W-10 per hole. A
 * per-well loop over 50 offsets against a 5 s statement timeout is the failure
 * this shape exists to avoid.
 */
async function wellCohort(opts: {
  lat: number;
  lon: number;
  radiusMi: number;
  limit: number;
  fieldFilter?: string;
  formationTop?: string;
  withTests?: boolean;
}): Promise<{ wells: CohortWell[]; truncated: boolean }> {
  const found = await offsetWellbores({
    lat: opts.lat,
    lon: opts.lon,
    radiusMi: opts.radiusMi,
    limit: opts.limit,
    formation: opts.fieldFilter,
  });
  if (!found.wells.length) return { wells: [], truncated: found.truncated };

  const apis = found.wells.map((w) => w.api_number);
  const [keys, tests] = await Promise.all([
    wellKeys(apis),
    opts.withTests === false ? Promise.resolve<OilTest[]>([]) : oilTests(apis, true),
  ]);
  const testBy = new Map(tests.map((t) => [t.api, t]));
  const want = opts.formationTop?.trim().toUpperCase();

  const wells: CohortWell[] = found.wells.map((w) => {
    const key = keys.get(w.api_number);
    const completed = date8(key?.completion_date);
    const t = testBy.get(w.api_number);
    const tops = w.perforations.map((p) => p.topFt).filter((n): n is number => n != null && n > 0);
    const bottoms = w.perforations.map((p) => p.bottomFt).filter((n): n is number => n != null && n > 0);
    const top = tops.length ? Math.min(...tops) : null;
    const bottom = bottoms.length ? Math.max(...bottoms) : null;
    const formationTop = want
      ? w.formationTops.find((f) => f.formation.toUpperCase().includes(want))?.depthFt ?? null
      : null;
    return {
      api_number: w.api_number,
      operator_name: w.operator_name,
      lease_name: w.lease_name,
      field_name: key?.field_name ?? null,
      well_type: key?.well_type ?? null,
      lat: w.lat,
      lon: w.lon,
      distance_mi: w.distanceMi,
      total_depth_ft: w.totalDepthFt,
      perf_top_ft: top,
      perf_bottom_ft: bottom,
      perf_length_ft: top != null && bottom != null && bottom > top ? bottom - top : null,
      formation_top_ft: formationTop,
      completion_date: completed?.iso ?? null,
      completion_year: completed?.year ?? null,
      completion_months: completed?.months ?? null,
      spacing_ft: null,
      test_date: t?.test_date ?? null,
      oil_bbl_per_day: t?.daily_oil ?? null,
      gas_mcf_per_day: t?.daily_gas ?? null,
      water_bbl_per_day: t?.daily_water ?? null,
      gor: t?.gas_oil_ratio ?? null,
    };
  });

  // Spacing is nearest-neighbour WITHIN this cohort, so it is bounded by the
  // radius asked for: a well whose true neighbour sits outside the circle reads
  // as further apart than it is.
  for (const w of wells) {
    const others = wells.filter((o) => o.api_number !== w.api_number);
    if (!others.length) continue;
    const nearest = Math.min(...others.map((o) => distanceMiles(w.lat, w.lon, o.lat, o.lon)));
    w.spacing_ft = Number.isFinite(nearest) ? nearest * FEET_PER_MILE : null;
  }

  return { wells, truncated: found.truncated };
}

/** `oil_gas_code/district_no/lease_no`, the one lease key a model can type. */
const LEASE_KEY = /^\s*([OGog])\s*\/\s*([^/]+?)\s*\/\s*([^/]+?)\s*$/;

function parseLeaseKey(key: string): { oil_gas_code: "O" | "G"; district_no: string; lease_no: string } | null {
  const m = LEASE_KEY.exec(key);
  if (!m) return null;
  return { oil_gas_code: m[1].toUpperCase() as "O" | "G", district_no: m[2], lease_no: m[3] };
}

interface LoadedLease {
  key: string;
  name: string;
  field_no: string | null;
  operator_no: string | null;
  wells: number;
  months: LeaseMonth[];
}

const MAX_LEASES = 24;

/** Load several leases at once, from explicit keys or a county's top leases. */
async function loadLeases(keys: readonly string[], limit: number) {
  const capped = keys.slice(0, limit);
  const settled = await Promise.all(
    capped.map(async (key) => {
      const parsed = parseLeaseKey(key);
      if (!parsed) return { key, error: `Not a lease key: "${key}". Use "O/08/12345".` };
      const lease = await getLeaseDossier(parsed.oil_gas_code, parsed.district_no, parsed.lease_no);
      if (!lease) return { key, error: `No lease ${key}.` };
      return {
        key,
        loaded: {
          key,
          name: lease.lease_name ?? key,
          field_no: lease.field_no,
          operator_no: lease.operator_no,
          wells: lease.wells?.length ?? 0,
          months: lease.monthly ?? [],
        } satisfies LoadedLease,
      };
    })
  );
  const leases: LoadedLease[] = [];
  const failures: { key: string; error: string }[] = [];
  for (const row of settled) {
    if ("loaded" in row && row.loaded) leases.push(row.loaded);
    else failures.push({ key: row.key, error: ("error" in row && row.error) || "Could not load." });
  }
  return { leases, failures, truncated: keys.length > capped.length };
}

/** Reported months only, as a daily-rate series a fit can eat. */
function leaseRates(months: readonly LeaseMonth[], stream: "oil" | "gas"): MonthlyRate[] {
  return months
    .filter((m) => m.reported)
    .map((m) => ({
      month: m.cycle,
      rate: dailyRate(stream === "oil" ? m.oil_prod_vol : m.gas_prod_vol, m.cycle),
    }));
}

/** Lease-grain months for an entity, when that entity has them. */
async function loadMonths(
  args: EntityArgs
): Promise<{ error: string } | { label: string; months: LeaseMonth[]; reportedThrough: string }> {
  const r = await resolveSeries(args);
  if (isError(r)) return { error: r.error };
  if (!r.months) {
    return { error: `${args.entity} is a pre-aggregated rollup with no lease-grain months. Use entity lease, well or operator.` };
  }
  return { label: r.label, months: r.months, reportedThrough: r.reportedThrough };
}

// ------------------------------------------------------------------ 120

/**
 * One operator's filing rows per cycle, which is what a lag curve is made of.
 *
 * Filtered by operator and bounded by cycle, so Timescale prunes to the recent
 * chunks. Never an unfiltered read of the 78.6M-row table.
 */
async function operatorFilingRows(operatorNo: string, months: number) {
  return rrcQuery<{ cycle: string; leases: number; filed: number; oil: number; gas: number }>(
    `select to_char(cycle, 'YYYY-MM') as cycle,
            count(*)::int as leases,
            count(*) filter (where prod_report_filed = 'Y')::int as filed,
            coalesce(sum(oil_prod_vol), 0)::bigint as oil,
            coalesce(sum(gas_prod_vol), 0)::bigint as gas
       from rrc.lease_production
      where operator_no = $1
        and cycle > (date_trunc('month', now()) - interval '1 month' * $2::int)
      group by 1
      order by 1`,
    [operatorNo, months]
  );
}

/** Cycles older than this are treated as settled: their filings are all in. */
const MATURE_AGE_MONTHS = 12;
const MIN_LAG_HISTORY = 18;

const nowcast = defineTool(
  "rrc_nowcast",
  "Estimate one operator's unreported production tail from its own filing-lag curve, keeping filed and estimated volumes apart.",
  {
    operator_no: z.string(),
    stream: z.enum(["oil", "gas"]).optional(),
    months: z.number().int().optional(),
  },
  async ({ operator_no, stream, months }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const which = stream ?? "oil";
    const window = cap(months, 24, 120, 48);

    const [edge, rows] = await Promise.all([getCycleEdge(), operatorFilingRows(op, window)]);
    if (rows.length < MIN_LAG_HISTORY) {
      return fail(
        `Only ${rows.length} cycles on file for operator ${op}; a filing-lag curve needs ${MIN_LAG_HISTORY}.`
      );
    }

    const withAge = rows.map((r) => ({ ...r, age_months: monthsBetween(r.cycle, edge.loaded) }));
    // The baseline is the operator's settled lease count. Filing completeness is
    // measured against how many leases they file in a normal month, not against
    // how many rows the mirror happens to hold for a half-filed one.
    const settled = withAge.filter((r) => r.age_months >= MATURE_AGE_MONTHS);
    const baseline = median(settled.map((r) => r.filed));
    if (!baseline || baseline <= 0) {
      return fail(`Operator ${op} has no settled months with filings; there is no lag to model.`);
    }

    const lagCurve = withAge
      .filter((r) => r.age_months < MATURE_AGE_MONTHS)
      .map((r) => ({
        age_months: r.age_months,
        cycle: r.cycle,
        filed_leases: r.filed,
        completeness: Math.min(1, r.filed / baseline),
      }))
      .sort((a, b) => a.age_months - b.age_months);

    const tail = lagCurve
      .filter((r) => r.completeness < 0.99)
      .map((r) => {
        const row = withAge.find((w) => w.cycle === r.cycle)!;
        const filedVolume = which === "oil" ? row.oil : row.gas;
        // Below this the divisor amplifies one lease into a whole operator, so
        // the honest answer is that the month cannot be nowcast yet.
        const usable = r.completeness >= 0.05;
        const estimated = usable ? filedVolume / r.completeness : null;
        return {
          cycle: r.cycle,
          age_months: r.age_months,
          filed_leases: r.filed_leases,
          settled_leases: baseline,
          completeness: r.completeness,
          filed_volume: filedVolume,
          filed_basis: FILED,
          estimated_volume: estimated,
          estimated_uplift: estimated === null ? null : estimated - filedVolume,
          estimated_basis: ESTIMATED,
          too_early: !usable,
        };
      })
      // Chronological, because a tail is read forward even though the lag curve
      // behind it is indexed by age.
      .sort((a, b) => a.cycle.localeCompare(b.cycle));

    const filedTail = sum(tail.map((t) => t.filed_volume));
    const uplift = sum(tail.map((t) => t.estimated_uplift));

    return {
      ok: true as const,
      operator_no: op,
      stream: which,
      reported_through: edge.reported,
      loaded_through: edge.loaded,
      settled_lease_count: baseline,
      lag_curve: lagCurve,
      tail,
      tail_total: splitTotal(filedTail, uplift),
      method:
        "Completeness is the operator's filed lease count for a cycle over its settled median. The estimate divides the filed volume by that completeness, so it assumes the leases that have not filed yet produce like the ones that have.",
      notes: [
        "Every estimated volume carries basis 'estimated' and is reported apart from the filed figure. It is a nowcast of what the RRC will eventually publish, not something the RRC has published.",
        "One snapshot of the mirror cannot see revisions to already-filed months, so this models the arrival of missing filings and nothing else.",
        `Completeness is measured against cycles at least ${MATURE_AGE_MONTHS} months old, which is where this operator's filing curve flattens.`,
      ],
    };
  }
);

// ------------------------------------------------------------------ 121

const imputeGaps = defineTool(
  "rrc_impute_gaps",
  "Fill a lease's unfiled months from its own bracketing filings, or its operator's shape, with imputed volume never added to the filed total.",
  {
    oil_gas_code: z.enum(["O", "G"]),
    district_no: z.string(),
    lease_no: z.string(),
    stream: z.enum(["oil", "gas"]).optional(),
    months: z.number().int().optional(),
  },
  async (args) => {
    const which = args.stream ?? "oil";
    const lease = await getLeaseDossier(args.oil_gas_code, args.district_no, args.lease_no);
    if (!lease) return fail(`No lease ${args.oil_gas_code}/${args.district_no}/${args.lease_no}.`);

    const window = cap(args.months, 12, 600, 120);
    const all = lease.monthly.filter((m) => m.reported);
    const rows = all.slice(Math.max(0, all.length - window));
    if (rows.length < 12) return fail(`Only ${rows.length} reported months on this lease; imputation needs 12.`);

    const vol = (m: LeaseMonth) => (which === "oil" ? m.oil_prod_vol : m.gas_prod_vol);
    // 'N' is the RRC's own marker for a month nobody filed. The zero beside it
    // is an absence, and averaging through it is how a lease looks dead.
    const isGap = (m: LeaseMonth) => m.prod_report_filed !== "Y";
    const filed = rows.filter((m) => !isGap(m));
    if (filed.length < 6) return fail(`Only ${filed.length} filed months in the window; there is nothing to impute from.`);

    // The operator's own shape is the neighbour signal for a gap with no filed
    // month on one side, which is exactly where interpolation has nothing to do.
    const operatorSeries = lease.operator_no
      ? await resolveSeries({ entity: "operator", operator_no: lease.operator_no })
      : null;
    const opRate = new Map<string, number>();
    if (operatorSeries && !isError(operatorSeries)) {
      const { cycles, values } = streamValues(operatorSeries.points, which);
      cycles.forEach((c, i) => opRate.set(c, dailyRate(values[i], c)));
    }

    const gaps = rows.filter(isGap).map((m) => {
      const before = [...filed].reverse().find((f) => f.cycle < m.cycle);
      const after = filed.find((f) => f.cycle > m.cycle);
      let rate: number | null = null;
      let method: string = "none";
      if (before && after) {
        const span = monthsBetween(before.cycle, after.cycle);
        const at = monthsBetween(before.cycle, m.cycle);
        const a = dailyRate(vol(before), before.cycle);
        const b = dailyRate(vol(after), after.cycle);
        rate = span > 0 ? a + ((b - a) * at) / span : a;
        method = "bracket";
      } else {
        const anchor = before ?? after;
        const anchorRate = anchor ? dailyRate(vol(anchor), anchor.cycle) : null;
        const here = opRate.get(m.cycle);
        const there = anchor ? opRate.get(anchor.cycle) : undefined;
        if (anchorRate != null && here != null && there != null && there > 0) {
          rate = anchorRate * (here / there);
          method = "operator_index";
        } else if (anchorRate != null) {
          rate = anchorRate;
          method = "carry_forward";
        }
      }
      return {
        cycle: m.cycle,
        filed_flag: m.prod_report_filed,
        recorded_volume: vol(m),
        estimated_volume: rate === null ? null : rate * daysInCycle(m.cycle),
        estimated_daily_rate: rate,
        method,
        basis: ESTIMATED,
      };
    });

    const filedTotal = sum(filed.map(vol));
    const imputed = sum(gaps.map((g) => g.estimated_volume));

    return {
      ok: true as const,
      lease: `${args.oil_gas_code}/${args.district_no}/${args.lease_no}`,
      lease_name: lease.lease_name,
      stream: which,
      months_in_window: rows.length,
      filed_months: filed.length,
      gap_months: gaps.length,
      missing_share: gaps.length / rows.length,
      gaps,
      unimputed: gaps.filter((g) => g.estimated_volume === null).length,
      window_total: splitTotal(filedTotal, imputed),
      notes: [
        "A gap is a month the RRC marks unfiled (prod_report_filed <> 'Y'). The zero recorded against it is an absence, not a measurement.",
        "Bracketed gaps interpolate this lease's own daily rate; unbracketed ones scale the nearest filed month by the operator's month-over-month shape, which is a weaker basis and is labelled per row.",
        "Imputed volume is reported apart from the filed total on purpose. It must not enter a figure quoted as production.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 122

const massBalance = defineTool(
  "rrc_mass_balance",
  "Test beginning balance plus production minus disposition against ending balance per cycle, and list the months that do not close.",
  {
    ...ENTITY_SHAPE,
    stream: z.enum(["oil", "cond"]).optional(),
    months: z.number().int().optional(),
    tolerance_pct: z.number().optional(),
  },
  async (args) => {
    const which = args.stream ?? "oil";
    const loaded = await loadMonths(args);
    if ("error" in loaded) return fail(loaded.error);

    const window = cap(args.months, 6, 600, 60);
    const tolPct = Math.min(1, Math.max(0.001, args.tolerance_pct ?? 0.02));
    const rows = loaded.months.filter((m) => m.reported);
    const recent = rows.slice(Math.max(0, rows.length - window));
    if (recent.length < 3) return fail(`Only ${recent.length} reported months; a balance needs at least 3.`);

    const prod = (m: LeaseMonth) => (which === "oil" ? m.oil_prod_vol : m.cond_prod_vol);
    const disp = (m: LeaseMonth) => (which === "oil" ? m.oil_tot_disp : m.cond_tot_disp);
    const bal = (m: LeaseMonth) => (which === "oil" ? m.oil_ending_bal : m.cond_ending_bal);

    const checks: {
      cycle: string;
      beginning_balance: number;
      production: number;
      disposition: number;
      ending_balance: number;
      residual: number;
      tolerance: number;
      balanced: boolean;
    }[] = [];
    let skipped = 0;
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1];
      const m = recent[i];
      // Null is "not reported" on these columns, and a null read as zero would
      // manufacture an imbalance the size of the month.
      if (bal(prev) == null || bal(m) == null || disp(m) == null) {
        skipped += 1;
        continue;
      }
      const begin = bal(prev) as number;
      const end = bal(m) as number;
      const d = disp(m) as number;
      const residual = begin + prod(m) - d - end;
      const tolerance = Math.max(1, prod(m) * tolPct);
      checks.push({
        cycle: m.cycle,
        beginning_balance: begin,
        production: prod(m),
        disposition: d,
        ending_balance: end,
        residual,
        tolerance,
        balanced: Math.abs(residual) <= tolerance,
      });
    }
    if (!checks.length) return fail("No month in the window carries both an ending balance and a disposition total.");

    const off = checks.filter((c) => !c.balanced).sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
    return {
      ok: true as const,
      entity: loaded.label,
      stream: which,
      reported_through: loaded.reportedThrough,
      months_checked: checks.length,
      months_skipped: skipped,
      months_out_of_balance: off.length,
      out_of_balance_share: off.length / checks.length,
      tolerance_pct: tolPct,
      total_absolute_residual: sum(checks.map((c) => Math.abs(c.residual))),
      worst: off.slice(0, 12),
      truncated: off.length > 12,
      notes: [
        "The identity is beginning balance plus production minus disposition equals ending balance, where beginning balance is the previous cycle's ending balance.",
        "A residual is a finding about the filing, not an error in the arithmetic: stock adjustments, amended filings and transfers between leases all land here.",
        `${skipped} month(s) were skipped for a missing balance or disposition. A missing value is not zero, so those cycles are not scored.`,
      ],
    };
  }
);

// ------------------------------------------------------------------ 123

const rollupReconcile = defineTool(
  "rrc_rollup_reconcile",
  "Compare a published rollup against the sum of its parts: operator against its leases, county against its leases, statewide against districts.",
  {
    scope: z.enum(["operator", "county", "statewide"]),
    operator_no: z.string().optional(),
    county: z.string().optional(),
    months: z.number().int().optional(),
  },
  async ({ scope, operator_no, county, months }) => {
    const window = cap(months, 3, 120, 12);

    if (scope === "operator") {
      const op = operator_no?.trim();
      if (!op) return fail("scope 'operator' needs operator_no.");
      const dossier = await getOperatorDossier(op);
      if (!dossier) return fail(`No operator ${op}.`);
      const reported = dossier.monthly.filter((m) => m.reported);
      const last12 = reported.slice(Math.max(0, reported.length - 12));
      const parentOil = sum(last12.map((m) => m.oil_prod_vol));
      const parentGas = sum(last12.map((m) => m.gas_prod_vol));
      const childOil = sum(dossier.leases.map((l) => l.oil_last12));
      const childGas = sum(dossier.leases.map((l) => l.gas_last12));
      return {
        ok: true as const,
        scope,
        operator_no: op,
        operator_name: dossier.record.operator_name,
        window_months: last12.length,
        oil: { parent: parentOil, children: childOil, difference: parentOil - childOil, share: parentOil > 0 ? (parentOil - childOil) / parentOil : null },
        gas: { parent: parentGas, children: childGas, difference: parentGas - childGas, share: parentGas > 0 ? (parentGas - childGas) / parentGas : null },
        lease_count: dossier.leases.length,
        notes: [
          "Parent is rrc.operator_production, the RRC's own operator rollup. Children are the operator's CURRENT lease list, so leases they have since sold sit in the parent and not in the children.",
          "A difference is a question, not a defect: the two are built from different grains and the lease list is bounded to the recent window.",
        ],
      };
    }

    if (scope === "county") {
      const ref = county?.trim();
      if (!ref) return fail("scope 'county' needs county.");
      const resolved = resolveCounty(ref);
      if (!resolved) return fail(`Not a Texas county: ${ref}.`);
      const [profile, children] = await Promise.all([
        getCountyProfile(resolved.county_no, window + 6),
        rrcQuery<{ cycle: string; oil: number; gas: number }>(
          `select to_char(cycle, 'YYYY-MM') as cycle,
                  coalesce(sum(cnty_lse_oil_prod_vol), 0)::bigint as oil,
                  coalesce(sum(cnty_lse_gas_prod_vol), 0)::bigint as gas
             from rrc.county_lease_cycle
            where county_no = $1
              and cycle > (date_trunc('month', now()) - interval '1 month' * $2::int)
            group by 1
            order by 1`,
          [resolved.county_no, window + 6]
        ),
      ]);
      if (!profile) return fail(`No county profile for ${ref}.`);
      const byCycle = new Map(children.map((c) => [c.cycle, c]));
      const rows = reportedOnly(profile.monthly)
        .slice(-window)
        .map((p) => {
          const child = byCycle.get(p.cycle);
          return {
            cycle: p.cycle,
            parent_oil: p.oil,
            children_oil: child?.oil ?? null,
            oil_difference: child ? p.oil - child.oil : null,
            parent_gas: p.gas,
            children_gas: child?.gas ?? null,
            gas_difference: child ? p.gas - child.gas : null,
          };
        });
      const matched = rows.filter((r) => r.oil_difference !== null);
      return {
        ok: true as const,
        scope,
        county: profile.county_name,
        cycles: rows.length,
        cycles_matched: matched.length,
        total_oil_difference: sum(matched.map((r) => r.oil_difference)),
        total_gas_difference: sum(matched.map((r) => r.gas_difference)),
        by_cycle: rows,
        notes: [
          "Parent is rrc.county_cycle, the RRC's county rollup. Children are rrc.county_lease_cycle, the same production at lease grain.",
          "Both are the RRC's own aggregates of the same filings, so a persistent gap is a filing that lands in one and not the other.",
        ],
      };
    }

    const [state, districts] = await Promise.all([
      getProductionTrend("statewide", window + 6, "monthly"),
      getProductionTrend("districts", window + 6, "monthly"),
    ]);
    const parent = state[0];
    if (!parent) return fail("No statewide series in the mirror.");
    const childByCycle = new Map<string, { oil: number; gas: number }>();
    for (const d of districts) {
      for (const p of d.points) {
        if (!p.reported) continue;
        const acc = childByCycle.get(p.cycle) ?? { oil: 0, gas: 0 };
        childByCycle.set(p.cycle, { oil: acc.oil + p.oil, gas: acc.gas + p.gas });
      }
    }
    const rows = reportedOnly(parent.points)
      .slice(-window)
      .map((p) => {
        const child = childByCycle.get(p.cycle);
        return {
          cycle: p.cycle,
          parent_oil: p.oil,
          children_oil: child?.oil ?? null,
          oil_difference: child ? p.oil - child.oil : null,
          parent_gas: p.gas,
          children_gas: child?.gas ?? null,
          gas_difference: child ? p.gas - child.gas : null,
        };
      });
    const matched = rows.filter((r) => r.oil_difference !== null);
    return {
      ok: true as const,
      scope,
      cycles: rows.length,
      cycles_matched: matched.length,
      total_oil_difference: sum(matched.map((r) => r.oil_difference)),
      total_gas_difference: sum(matched.map((r) => r.gas_difference)),
      districts: districts.length,
      by_cycle: rows,
      notes: [
        "Parent is rrc.statewide_production_monthly; children are the district rollup summed per cycle.",
        "Offshore and unassigned district codes are the usual source of a standing gap.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 124

const MIN_WATER_WELLS = 5;

const waterBalance = defineTool(
  "rrc_water_balance",
  "Produced water from W-10 tests against injected water from H-10 filings for a radius, with the two bases reported apart.",
  {
    lat: z.number(),
    lon: z.number(),
    radius_mi: z.number().optional(),
    limit: z.number().int().optional(),
  },
  async ({ lat, lon, radius_mi, limit }) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail("lat and lon are required.");
    const radius = Math.min(25, Math.max(0.5, radius_mi ?? 5));
    const wellCap = cap(limit, 5, 100, 60);

    const [cohort, disposal] = await Promise.all([
      wellCohort({ lat, lon, radiusMi: radius, limit: wellCap }),
      findDisposal({ lat, lon, radiusMi: radius, limit: 100 }),
    ]);

    const tested = cohort.wells.filter((w) => w.water_bbl_per_day != null);
    if (tested.length < MIN_WATER_WELLS) {
      return fail(
        `Only ${tested.length} well(s) in ${radius} mi have a W-10 water rate; a water balance needs ${MIN_WATER_WELLS}.`
      );
    }
    const producers = cohort.wells.filter((w) => w.well_type === "PRODUCING");
    const producedTested = sum(tested.map((w) => w.water_bbl_per_day));
    const perWell = producedTested / tested.length;
    // Scaling one test day across untested holes is the only way to size the
    // area, and it is an estimate: it rides on the tested wells being typical.
    const scaled = perWell * Math.max(tested.length, producers.length);

    const injectors = disposal.filter((d) => d.recentBblPerDay != null);
    const injected = sum(injectors.map((d) => d.recentBblPerDay));

    return {
      ok: true as const,
      center: { lat, lon },
      radius_mi: radius,
      wells_in_radius: cohort.wells.length,
      producing_wells: producers.length,
      wells_with_water_test: tested.length,
      produced_bbl_per_day_tested: producedTested,
      produced_basis: "w10_test",
      produced_bbl_per_day_area_estimate: scaled,
      produced_area_basis: ESTIMATED,
      disposal_wells: disposal.length,
      disposal_wells_measured: injectors.length,
      injected_bbl_per_day: injected,
      injected_basis: FILED,
      ratio_injected_over_produced_tested: producedTested > 0 ? injected / producedTested : null,
      median_water_cut: median(
        clean(
          tested.map((w) =>
            (w.water_bbl_per_day ?? 0) + (w.oil_bbl_per_day ?? 0) > 0
              ? (w.water_bbl_per_day ?? 0) / ((w.water_bbl_per_day ?? 0) + (w.oil_bbl_per_day ?? 0))
              : null
          )
        )
      ),
      truncated: cohort.truncated || disposal.length >= 100,
      notes: [
        "Produced water is a W-10 TEST rate: one measured day per well, not a filed monthly volume. Injected water is an H-10 filed volume averaged over the reported months. The two are different measurements and are never netted here.",
        "The area estimate scales the tested wells' average across the producing holes in the radius and carries basis 'estimated'.",
        "H-10 filing runs about a year behind production filing, so the injected side is measured to an older edge than the produced side.",
        "Water can leave the area by truck and arrive from outside it. A ratio far from 1 is a question about where the water goes, not a proof of anything.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 125

const MIN_MATCHES = 5;

const matchedPairs = defineTool(
  "rrc_matched_pairs",
  "Benchmark one well against offsets matched on field, depth, vintage and spacing rather than against a field average.",
  {
    api: z.string(),
    radius_mi: z.number().optional(),
    depth_tolerance_pct: z.number().optional(),
    vintage_tolerance_years: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async ({ api, radius_mi, depth_tolerance_pct, vintage_tolerance_years, limit }) => {
    const key = api.trim();
    if (!key) return fail("api is required.");
    const point = await wellPoint(key);
    if (!point) return fail(`No surface location on file for ${key}.`);

    const radius = Math.min(25, Math.max(0.5, radius_mi ?? 5));
    const depthTol = Math.min(1, Math.max(0.02, depth_tolerance_pct ?? 0.15));
    const vintageTol = cap(vintage_tolerance_years, 1, 40, 10);
    const cohort = await wellCohort({ lat: point.lat, lon: point.lon, radiusMi: radius, limit: cap(limit, 10, 100, 60) });

    const target = cohort.wells.find((w) => w.api_number === key);
    if (!target) return fail(`${key} has no wellbore row inside its own radius; nothing to match against.`);
    if (target.oil_bbl_per_day == null) {
      return fail(`${key} has no W-10 oil test, so there is no measured rate to benchmark.`);
    }

    const depth = target.total_depth_ft;
    const vintage = target.completion_year;
    const matches = cohort.wells.filter((w) => {
      if (w.api_number === key || w.oil_bbl_per_day == null) return false;
      if (depth != null && w.total_depth_ft != null && Math.abs(w.total_depth_ft - depth) / depth > depthTol) return false;
      if (vintage != null && w.completion_year != null && Math.abs(w.completion_year - vintage) > vintageTol) return false;
      if (target.field_name && w.field_name && w.field_name !== target.field_name) return false;
      return true;
    });
    if (matches.length < MIN_MATCHES) {
      return fail(
        `Only ${matches.length} matched offset(s) inside ${radius} mi at +/-${Math.round(depthTol * 100)}% depth and +/-${vintageTol} years. A comparison needs ${MIN_MATCHES}; widen the tolerances or the radius.`
      );
    }

    const rates = matches.map((m) => m.oil_bbl_per_day as number);
    const sorted = [...rates].sort((a, b) => a - b);
    const below = sorted.filter((r) => r < (target.oil_bbl_per_day as number)).length;

    return {
      ok: true as const,
      api: key,
      target: {
        lease_name: target.lease_name,
        operator_name: target.operator_name,
        field_name: target.field_name,
        total_depth_ft: target.total_depth_ft,
        completion_year: target.completion_year,
        spacing_ft: target.spacing_ft,
        test_date: target.test_date,
        oil_bbl_per_day: target.oil_bbl_per_day,
        gas_mcf_per_day: target.gas_mcf_per_day,
        water_bbl_per_day: target.water_bbl_per_day,
      },
      match_rule: {
        radius_mi: radius,
        depth_tolerance_pct: depthTol,
        vintage_tolerance_years: vintageTol,
        same_field: Boolean(target.field_name),
      },
      n_matched: matches.length,
      percentile: below / matches.length,
      cohort_oil_bbl_per_day: {
        p10: percentile(sorted, 0.1),
        median: median(sorted),
        p90: percentile(sorted, 0.9),
        mean: mean(sorted),
      },
      ratio_to_median: (() => {
        const m = median(sorted);
        return m && m > 0 ? (target.oil_bbl_per_day as number) / m : null;
      })(),
      median_spacing_ft: median(clean(matches.map((m) => m.spacing_ft))),
      matches: matches
        .map((m) => ({
          api_number: m.api_number,
          operator_name: m.operator_name,
          lease_name: m.lease_name,
          distance_mi: m.distance_mi,
          total_depth_ft: m.total_depth_ft,
          completion_year: m.completion_year,
          spacing_ft: m.spacing_ft,
          test_date: m.test_date,
          oil_bbl_per_day: m.oil_bbl_per_day,
        }))
        .sort((a, b) => (b.oil_bbl_per_day ?? 0) - (a.oil_bbl_per_day ?? 0)),
      truncated: cohort.truncated,
      notes: [
        "The rate is a W-10 test: one measured day per well, and the newest one on file. Test dates differ between wells, so a young well is being compared at a different point on its own decline.",
        "Spacing is the nearest hole INSIDE this radius, so a well near the edge of the circle reads as further from its neighbours than it is.",
        "Wells with no test are excluded rather than counted at zero, which biases the cohort toward holes an operator bothered to test.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 126

const MIN_ATTRIBUTION = 20;

const attribution = defineTool(
  "rrc_attribution",
  "Decompose well performance in a radius into rock, depth, operator and vintage, each with the variance share it explains and a bootstrap interval.",
  {
    lat: z.number(),
    lon: z.number(),
    radius_mi: z.number().optional(),
    limit: z.number().int().optional(),
    seed: z.number().int(),
    iterations: z.number().int().optional(),
  },
  async ({ lat, lon, radius_mi, limit, seed, iterations }) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail("lat and lon are required.");
    const radius = Math.min(25, Math.max(1, radius_mi ?? 10));
    const iters = cap(iterations, 50, 2000, 300);
    const cohort = await wellCohort({ lat, lon, radiusMi: radius, limit: cap(limit, 20, 100, 100) });

    // Log space, because rate is multiplicative: a factor that doubles a well
    // is one number here whether the well makes 5 bbl/d or 500.
    const rows = cohort.wells
      .filter((w) => (w.oil_bbl_per_day ?? 0) > 0)
      .map((w) => ({
        api: w.api_number,
        y: Math.log(w.oil_bbl_per_day as number),
        field: w.field_name ?? "(unknown field)",
        operator: w.operator_name ?? "(unknown operator)",
        vintage: w.completion_year == null ? "(unknown vintage)" : `${Math.floor(w.completion_year / 10) * 10}s`,
        depth:
          w.total_depth_ft == null ? "(unknown depth)" : `${Math.floor(w.total_depth_ft / 1000)}-${Math.floor(w.total_depth_ft / 1000) + 1}k ft`,
      }));
    if (rows.length < MIN_ATTRIBUTION) {
      return fail(`Only ${rows.length} tested wells inside ${radius} mi; attribution needs ${MIN_ATTRIBUTION}.`);
    }

    const factors = (["field", "depth", "operator", "vintage"] as const).map((factor) => {
      const pairs = rows.map((r) => ({ group: r[factor], y: r.y }));
      const fit = etaSquared(pairs);
      // Bootstrap over rows, refitting the same decomposition each draw, so the
      // interval reflects how much of this answer is the sample.
      const idx = rows.map((_, i) => i);
      const ci = bootstrap(
        idx,
        (sample) => etaSquared(sample.map((i) => pairs[i]))?.r2 ?? null,
        iters,
        seed
      );
      const groups = new Map<string, number[]>();
      for (const p of pairs) groups.set(p.group, [...(groups.get(p.group) ?? []), p.y]);
      return {
        factor,
        r2_one_way: fit?.r2 ?? null,
        groups: fit?.groups ?? 0,
        n: rows.length,
        ci_p05: ci.p05,
        ci_p95: ci.p95,
        top_groups: [...groups.entries()]
          .map(([group, ys]) => ({ group, wells: ys.length, median_bbl_per_day: Math.exp(median(ys) ?? 0) }))
          .sort((a, b) => b.median_bbl_per_day - a.median_bbl_per_day)
          .slice(0, 5),
      };
    });

    return {
      ok: true as const,
      center: { lat, lon },
      radius_mi: radius,
      n: rows.length,
      response: "log of the latest W-10 oil rate, bbl/d",
      seed,
      iterations: iters,
      factors: factors.sort((a, b) => (b.r2_one_way ?? 0) - (a.r2_one_way ?? 0)),
      truncated: cohort.truncated,
      notes: [
        "Each share is a ONE-WAY decomposition: the variance that factor explains on its own. Operators cluster in fields and vintages cluster in depths, so the shares overlap and do not add to 1.",
        "This ranks candidate explanations. It does not separate a good operator from good acreage when the same operator holds all of one field, and no amount of arithmetic on this data can.",
        "Intervals are a percentile bootstrap over wells at the stated seed; the same seed gives the same interval.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 127

const MIN_OUTLIER_COHORT = 12;

const outliers = defineTool(
  "rrc_outliers",
  "Wells that beat or trail their matched cohort by a robust margin, in both directions, with the cohort stated.",
  {
    lat: z.number(),
    lon: z.number(),
    radius_mi: z.number().optional(),
    limit: z.number().int().optional(),
    z_threshold: z.number().optional(),
  },
  async ({ lat, lon, radius_mi, limit, z_threshold }) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail("lat and lon are required.");
    const radius = Math.min(25, Math.max(1, radius_mi ?? 10));
    const threshold = Math.min(6, Math.max(1, z_threshold ?? 2));
    const cohort = await wellCohort({ lat, lon, radiusMi: radius, limit: cap(limit, 12, 100, 100) });

    const tested = cohort.wells.filter((w) => (w.oil_bbl_per_day ?? 0) > 0);
    if (tested.length < MIN_OUTLIER_COHORT) {
      return fail(`Only ${tested.length} tested wells inside ${radius} mi; an outlier test needs ${MIN_OUTLIER_COHORT}.`);
    }

    const logs = tested.map((w) => Math.log(w.oil_bbl_per_day as number));
    const centre = median(logs) ?? 0;
    // Median absolute deviation, not standard deviation: the outliers we are
    // hunting would otherwise inflate the yardstick that is meant to find them.
    const mad = median(logs.map((v) => Math.abs(v - centre))) ?? 0;
    const scale = mad > 0 ? mad * 1.4826 : stddev(logs) ?? 0;
    if (scale <= 0) return fail("Every tested well in this cohort reports the same rate; there is no spread to score against.");

    const scored = tested
      .map((w, i) => ({
        api_number: w.api_number,
        operator_name: w.operator_name,
        lease_name: w.lease_name,
        field_name: w.field_name,
        completion_year: w.completion_year,
        total_depth_ft: w.total_depth_ft,
        spacing_ft: w.spacing_ft,
        test_date: w.test_date,
        oil_bbl_per_day: w.oil_bbl_per_day,
        robust_z: (logs[i] - centre) / scale,
      }))
      .sort((a, b) => b.robust_z - a.robust_z);

    return {
      ok: true as const,
      center: { lat, lon },
      radius_mi: radius,
      n: tested.length,
      cohort_median_bbl_per_day: Math.exp(centre),
      robust_scale_log: scale,
      z_threshold: threshold,
      overperformers: scored.filter((s) => s.robust_z >= threshold),
      underperformers: scored.filter((s) => s.robust_z <= -threshold).reverse(),
      truncated: cohort.truncated,
      notes: [
        "Scored in log space against the cohort median with a MAD scale, so a handful of very good wells cannot hide the rest.",
        "The cohort is everything in the radius with a W-10 test, matched only by geography. For a like-for-like comparison on depth and vintage, use rrc_matched_pairs.",
        "An underperformer is a candidate for something broken. It is equally often an old well, a different zone, or a test taken on a bad day.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 128

const MIN_SURVIVAL = 20;
const SURVIVAL_HORIZONS = [1, 5, 10, 20, 30];

const wellSurvival = defineTool(
  "rrc_well_survival",
  "Kaplan-Meier survival of wells completed in a county, optionally by field and depth band, against plugging or shut-in.",
  {
    county: z.string(),
    field_name: z.string().optional(),
    operator_no: z.string().optional(),
    min_depth_ft: z.number().optional(),
    max_depth_ft: z.number().optional(),
    endpoint: z.enum(["plugged", "stopped"]).optional(),
    limit: z.number().int().optional(),
  },
  async (args) => {
    const resolved = resolveCounty(args.county.trim());
    if (!resolved) return fail(`Not a Texas county: ${args.county}.`);
    const endpoint = args.endpoint ?? "plugged";
    const rowCap = cap(args.limit, 100, 20000, 8000);

    const params: unknown[] = [resolved.county_no];
    const where: string[] = ["county_code = $1", "on_schedule = 'Y'"];
    if (args.field_name?.trim()) {
      params.push(`%${args.field_name.trim()}%`);
      where.push(`field_name ilike $${params.length}`);
    }
    if (args.operator_no?.trim()) {
      params.push(args.operator_no.trim());
      where.push(`operator_number = $${params.length}`);
    }
    params.push(rowCap);

    const [edge, rows] = await Promise.all([
      getCycleEdge(),
      rrcQuery<Record<string, string | null>>(
        `select distinct on (api_number)
                trim(api_number) as api, field_name, well_type_name,
                completion_date, orig_completion_dt, plug_date, wb_shut_in_date,
                api_depth
           from rrc.wellbore
          where ${where.join(" and ")}
          order by api_number, on_schedule desc nulls last
          limit $${params.length}`,
        params
      ),
    ]);

    const asOf = cycleMonths(edge.loaded || "2000-01");
    const minDepth = args.min_depth_ft ?? null;
    const maxDepth = args.max_depth_ft ?? null;

    const population = rows
      .map((r) => {
        const completed = date8(r.orig_completion_dt || r.completion_date);
        if (!completed) return null;
        const depth = r.api_depth ? Number(String(r.api_depth).replace(/[^0-9.]/g, "")) : null;
        if (minDepth != null && (depth == null || depth < minDepth)) return null;
        if (maxDepth != null && (depth == null || depth > maxDepth)) return null;
        const plugged = date8(r.plug_date);
        const shutIn = date8(r.wb_shut_in_date);
        const event = endpoint === "plugged" ? plugged : plugged ?? shutIn;
        const end = event ? event.months : asOf;
        const years = (end - completed.months) / 12;
        if (!Number.isFinite(years) || years < 0) return null;
        return { t: Math.round(years * 10) / 10, event: Boolean(event), depth };
      })
      .filter((r): r is { t: number; event: boolean; depth: number | null } => r !== null);

    if (population.length < MIN_SURVIVAL) {
      return fail(
        `Only ${population.length} wells in ${resolved.county_name} carry a completion date under these filters; a survival curve needs ${MIN_SURVIVAL}.`
      );
    }

    const curve = kaplanMeier(population);
    return {
      ok: true as const,
      county: resolved.county_name,
      field_name: args.field_name ?? null,
      operator_no: args.operator_no ?? null,
      depth_band_ft: { min: minDepth, max: maxDepth },
      endpoint,
      as_of: edge.loaded,
      n: population.length,
      events: population.filter((p) => p.event).length,
      censored: population.filter((p) => !p.event).length,
      median_life_years: medianSurvival(curve),
      survival: SURVIVAL_HORIZONS.map((years) => ({ years, surviving: survivalAt(curve, years) })),
      curve: curve.slice(0, 200),
      truncated: rows.length >= rowCap || curve.length > 200,
      notes: [
        "Completion date is the ORIGINAL completion where the RRC filed one, so a recompleted hole is aged from the first bit, not the last.",
        endpoint === "plugged"
          ? "The event is a W-3 plugging date. A shut-in well is still alive by this definition."
          : "The event is a plugging date, or a shut-in date where no plugging is filed. Shut-in is reversible, so this curve is a floor on producing life, not a death certificate.",
        "Wells with no event are censored at the mirror's last loaded cycle, which is the correct treatment and the reason late years carry few wells at risk.",
        "Only wells on the current schedule are visible here. A hole whose operator never re-filed carries blank status columns and drops out, which biases the population toward wells somebody still claims.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 129

const MIN_WATER_HISTORY = 10;

const timeToWater = defineTool(
  "rrc_time_to_water",
  "Kaplan-Meier time from completion to a water cut threshold, and to shut-in, for the wells around a point.",
  {
    lat: z.number(),
    lon: z.number(),
    radius_mi: z.number().optional(),
    water_cut: z.number().optional(),
    limit: z.number().int().optional(),
  },
  async ({ lat, lon, radius_mi, water_cut, limit }) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail("lat and lon are required.");
    const radius = Math.min(25, Math.max(0.5, radius_mi ?? 5));
    const threshold = Math.min(0.99, Math.max(0.05, water_cut ?? 0.5));
    const wellCap = cap(limit, 10, 100, 60);

    const [edge, found] = await Promise.all([
      getCycleEdge(),
      offsetWellbores({ lat, lon, radiusMi: radius, limit: wellCap }),
    ]);
    if (!found.wells.length) return fail(`No wellbores within ${radius} mi.`);

    const apis = found.wells.map((w) => w.api_number);
    const [keys, tests] = await Promise.all([wellKeys(apis), oilTests(apis, false)]);

    const byWell = new Map<string, OilTest[]>();
    for (const t of tests) byWell.set(t.api, [...(byWell.get(t.api) ?? []), t]);

    const asOf = cycleMonths(edge.loaded || "2000-01");
    const water: { t: number; event: boolean }[] = [];
    const shut: { t: number; event: boolean }[] = [];
    const perWell: {
      api_number: string;
      completion_date: string | null;
      tests: number;
      months_to_water: number | null;
      last_water_cut: number | null;
      shut_in_date: string | null;
    }[] = [];

    for (const api of apis) {
      const key = keys.get(api);
      const completed = date8(key?.completion_date);
      if (!completed) continue;
      // Oldest first: "first time above the threshold" is a question about the
      // start of the history, and the query hands them back newest first.
      const history = (byWell.get(api) ?? [])
        .slice()
        .sort((a, b) => (a.test_date ?? "").localeCompare(b.test_date ?? ""));
      const cut = (t: OilTest) => {
        const w = t.daily_water ?? 0;
        const o = t.daily_oil ?? 0;
        return w + o > 0 ? w / (w + o) : null;
      };
      const first = history.find((t) => (cut(t) ?? 0) >= threshold);
      const last = history[history.length - 1];
      const monthsOf = (iso: string | null | undefined) => {
        const d = date8(iso?.replace(/-/g, ""));
        return d ? d.months : null;
      };
      if (history.length) {
        const at = first ? monthsOf(first.test_date) : monthsOf(last?.test_date);
        if (at != null) {
          const t = Math.max(0, (at - completed.months) / 12);
          water.push({ t: Math.round(t * 10) / 10, event: Boolean(first) });
        }
      }
      const shutIn = date8(key?.shut_in_date);
      const end = shutIn ? shutIn.months : asOf;
      const years = (end - completed.months) / 12;
      if (Number.isFinite(years) && years >= 0) {
        shut.push({ t: Math.round(years * 10) / 10, event: Boolean(shutIn) });
      }
      perWell.push({
        api_number: api,
        completion_date: completed.iso,
        tests: history.length,
        months_to_water: first ? (monthsOf(first.test_date) ?? 0) - completed.months : null,
        last_water_cut: last ? cut(last) : null,
        shut_in_date: shutIn?.iso ?? null,
      });
    }

    if (water.length < MIN_WATER_HISTORY) {
      return fail(
        `Only ${water.length} well(s) in ${radius} mi carry both a completion date and a W-10 history; this needs ${MIN_WATER_HISTORY}.`
      );
    }

    const waterCurve = kaplanMeier(water);
    const shutCurve = kaplanMeier(shut);
    return {
      ok: true as const,
      center: { lat, lon },
      radius_mi: radius,
      water_cut_threshold: threshold,
      as_of: edge.loaded,
      water_to_threshold: {
        n: water.length,
        events: water.filter((w) => w.event).length,
        median_years: medianSurvival(waterCurve),
        survival: SURVIVAL_HORIZONS.map((years) => ({ years, dry_fraction: survivalAt(waterCurve, years) })),
      },
      shut_in: {
        n: shut.length,
        events: shut.filter((s) => s.event).length,
        median_years: medianSurvival(shutCurve),
        survival: SURVIVAL_HORIZONS.map((years) => ({ years, still_open: survivalAt(shutCurve, years) })),
      },
      wells: perWell,
      truncated: found.truncated || tests.length >= MAX_TEST_ROWS,
      notes: [
        "Water cut here is W-10 water over water plus oil on a single test day. Tests are annual at best, so the crossing is located to the nearest test, never to the month it happened.",
        "A well that never crosses the threshold is censored at its LAST test, not at today: the record stops when the testing does.",
        "W-10 is an oil-well form. Gas wells file G-10 and do not appear in the water curve.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 130

const MIN_OPERATOR_SURVIVAL = 25;

const operatorSurvival = defineTool(
  "rrc_operator_survival",
  "Kaplan-Meier on P-5 registration life for the operators active in a county: the fitted version of a distress weighting.",
  {
    county: z.string(),
    limit: z.number().int().optional(),
  },
  async ({ county, limit }) => {
    const resolved = resolveCounty(county.trim());
    if (!resolved) return fail(`Not a Texas county: ${county}.`);
    const opCap = cap(limit, 25, 1000, 400);

    const fleet = await rrcQuery<{ operator_number: string; wells: number }>(
      `select operator_number, count(distinct api_number)::int as wells
         from rrc.wellbore
        where county_code = $1 and on_schedule = 'Y' and operator_number is not null
        group by 1
        order by wells desc
        limit $2`,
      [resolved.county_no, opCap]
    );
    if (fleet.length < MIN_OPERATOR_SURVIVAL) {
      return fail(
        `Only ${fleet.length} operators on schedule in ${resolved.county_name}; a survival fit needs ${MIN_OPERATOR_SURVIVAL}.`
      );
    }

    const [edge, records] = await Promise.all([
      getCycleEdge(),
      rrcQuery<{ operator_number: string; operator_name: string | null; p5_status: string | null; org_date: string | null; last_p5_date: string | null }>(
        `select operator_number, operator_name, p5_status,
                to_char(org_date, 'YYYY-MM-DD') as org_date,
                to_char(last_p5_date, 'YYYY-MM-DD') as last_p5_date
           from rrc.operators
          where operator_number = any($1)`,
        [fleet.map((f) => f.operator_number)]
      ),
    ]);

    const asOf = cycleMonths(edge.loaded || "2000-01");
    const months = (iso: string | null) => {
      const d = date8(iso?.replace(/-/g, ""));
      return d ? d.months : null;
    };
    const population = records
      .map((r) => {
        const start = months(r.org_date);
        if (start == null) return null;
        // 'A' is an active P-5. Anything else is a registration that lapsed,
        // was cancelled, or is in a hold state, which is the event here.
        const lapsed = (r.p5_status ?? "").trim().toUpperCase() !== "A";
        const end = lapsed ? months(r.last_p5_date) ?? asOf : asOf;
        const years = (end - start) / 12;
        if (!Number.isFinite(years) || years < 0) return null;
        return {
          operator_number: r.operator_number,
          operator_name: r.operator_name,
          p5_status: r.p5_status,
          t: Math.round((years * 10)) / 10,
          event: lapsed,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (population.length < MIN_OPERATOR_SURVIVAL) {
      return fail(`Only ${population.length} of those operators carry an organisation date; a fit needs ${MIN_OPERATOR_SURVIVAL}.`);
    }

    const curve = kaplanMeier(population);
    const events = population.filter((p) => p.event);
    // Hazard by decade of registration life, which is the shape a distress
    // score should be weighted from rather than by assertion.
    const hazard = [0, 5, 10, 20, 30].map((from, i, arr) => {
      const to = arr[i + 1] ?? Infinity;
      const atRisk = population.filter((p) => p.t >= from).length;
      const died = events.filter((e) => e.t >= from && e.t < to).length;
      return { from_years: from, to_years: Number.isFinite(to) ? to : null, at_risk: atRisk, lapsed: died, hazard: atRisk ? died / atRisk : null };
    });

    return {
      ok: true as const,
      county: resolved.county_name,
      n: population.length,
      events: events.length,
      censored: population.length - events.length,
      median_life_years: medianSurvival(curve),
      survival: SURVIVAL_HORIZONS.map((years) => ({ years, still_active: survivalAt(curve, years) })),
      hazard_by_age: hazard,
      curve: curve.slice(0, 200),
      lapsed_examples: events
        .sort((a, b) => b.t - a.t)
        .slice(0, 10)
        .map((e) => ({ operator_number: e.operator_number, operator_name: e.operator_name, p5_status: e.p5_status, years: e.t })),
      truncated: fleet.length >= opCap,
      notes: [
        "Survival is P-5 REGISTRATION life: organisation date to last P-5 filing for a lapsed operator, censored at the mirror's edge for an active one. It is not a bankruptcy record and the RRC publishes none.",
        "The population is operators holding wells in this county today, so operators that disappeared before the current schedule was written are invisible and the curve is optimistic.",
        "This is the fitted counterpart to the asserted weights in rrc_distress_signal: use the hazard table to calibrate them rather than guessing.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 131

/** Attributes a spatial tool can read off a wellbore cohort. */
const SPATIAL_ATTRS = [
  "total_depth_ft",
  "perf_top_ft",
  "perf_length_ft",
  "formation_top_ft",
  "oil_bbl_per_day",
  "gas_mcf_per_day",
  "water_cut",
  "gor",
] as const;
type SpatialAttr = (typeof SPATIAL_ATTRS)[number];

function attrValue(w: CohortWell, attr: SpatialAttr): number | null {
  switch (attr) {
    case "total_depth_ft":
      return w.total_depth_ft;
    case "perf_top_ft":
      return w.perf_top_ft;
    case "perf_length_ft":
      return w.perf_length_ft;
    case "formation_top_ft":
      return w.formation_top_ft;
    case "oil_bbl_per_day":
      return w.oil_bbl_per_day;
    case "gas_mcf_per_day":
      return w.gas_mcf_per_day;
    case "water_cut": {
      const water = w.water_bbl_per_day;
      const oil = w.oil_bbl_per_day;
      return water != null && oil != null && water + oil > 0 ? water / (water + oil) : null;
    }
    case "gor":
      return w.gor;
  }
}

const SPATIAL_SHAPE = {
  lat: z.number(),
  lon: z.number(),
  attribute: z.enum(SPATIAL_ATTRS),
  radius_mi: z.number().optional(),
  formation: z.string().optional(),
  limit: z.number().int().optional(),
};

async function spatialPoints(args: {
  lat: number;
  lon: number;
  attribute: SpatialAttr;
  radius_mi?: number;
  formation?: string;
  limit?: number;
}) {
  const radius = Math.min(25, Math.max(0.5, args.radius_mi ?? 10));
  const cohort = await wellCohort({
    lat: args.lat,
    lon: args.lon,
    radiusMi: radius,
    limit: cap(args.limit, 10, 100, 100),
    formationTop: args.attribute === "formation_top_ft" ? args.formation : undefined,
    withTests: args.attribute === "oil_bbl_per_day" || args.attribute === "gas_mcf_per_day" || args.attribute === "water_cut" || args.attribute === "gor",
  });
  const points: SpatialPoint[] = [];
  for (const w of cohort.wells) {
    const value = attrValue(w, args.attribute);
    if (value == null || !Number.isFinite(value)) continue;
    points.push({ api_number: w.api_number, lat: w.lat, lon: w.lon, value });
  }
  return { points, radius, truncated: cohort.truncated, wells: cohort.wells.length };
}

const MIN_SPATIAL = 12;

const variogram = defineTool(
  "rrc_variogram",
  "How far can I project what I know before it stops being true? The spatial correlation length of a well attribute: the binned semivariogram and a fitted exponential range, which is the empirical answer to how wide a screen should look.",
  { ...SPATIAL_SHAPE, bins: z.number().int().optional() },
  async (args) => {
    if (!Number.isFinite(args.lat) || !Number.isFinite(args.lon)) return fail("lat and lon are required.");
    const { points, radius, truncated, wells } = await spatialPoints(args);
    if (points.length < MIN_SPATIAL) {
      return fail(`Only ${points.length} of ${wells} wells carry ${args.attribute}; a variogram needs ${MIN_SPATIAL}.`);
    }
    const bins = cap(args.bins, 4, 20, 10);
    const maxLag = radius; // Beyond the radius there are no pairs to bin.
    const experimental = experimentalVariogram(points, bins, maxLag);
    const values = points.map((p) => p.value);
    const sd = stddev(values);
    const sill = sd === null ? 0 : sd * sd;
    if (sill <= 0) return fail(`${args.attribute} is constant across this cohort; there is no variance to structure.`);
    const fit = fitVariogram(experimental, sill, maxLag);
    if (!fit) return fail("Too few populated distance bins to fit a model; widen the radius or reduce bins.");

    /*
     * The radius that was ASKED for is not the radius that was measured.
     *
     * The cohort behind this is the NEAREST N wells to the point, capped at 100
     * by the feeder, so a 40 mile request in a dense area returns the same
     * hundred wells a 15 mile request does and the outer bins are empty. Fitted
     * on that, the range comes back short and the whole thing reads as a
     * geological dead end when it is a sampling artefact.
     *
     * So the span the cohort actually covers is measured and reported beside the
     * radius, and the projection distance handed on is bounded by it. A
     * correlation length cannot be read past the farthest pair that produced it.
     */
    const spannedMi = Math.max(
      ...points.map((p) => distanceMiles(args.lat, args.lon, p.lat, p.lon))
    );
    const capped = truncated && spannedMi < radius * 0.9;

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radius,
      /** How far the wells actually reach. The real aperture of this fit. */
      spanned_mi: Math.round(spannedMi * 10) / 10,
      attribute: args.attribute,
      formation: args.formation ?? null,
      n: points.length,
      sample_variance: sill,
      bins: experimental,
      model: { type: "exponential", ...fit.model, sse: fit.sse },
      /** The lag where the model reaches 95% of the sill. */
      correlation_length_mi: fit.model.range_mi,
      nugget_share: sill > 0 ? fit.model.nugget / sill : null,
      /**
       * How wide a screen around this point is defensible, in miles.
       *
       * This is the number the whole tool exists to produce. Nobody should be
       * inventing a six or a ten mile radius by feel when the wells will say.
       */
      use_this_radius_mi: Math.round(Math.min(fit.model.range_mi, spannedMi) * 10) / 10,
      truncated,
      cohort_capped: capped,
      notes: [
        "The sill is fixed at the sample variance and only the range and nugget are fitted, which keeps the fit stable on the well counts this data actually offers.",
        "A nugget share near 1 means neighbouring wells tell you nothing about each other at this scale: measurement noise, mixed zones, or the wrong attribute.",
        capped
          ? `THE COHORT IS CAPPED, NOT THE RADIUS. You asked for ${radius} mi and the ${points.length} wells returned span ${Math.round(spannedMi * 10) / 10} mi, because the feeder takes the NEAREST wells and stops. This fit describes that inner span only, and the correlation length cannot be read beyond it. A short range here is not evidence that the rock stops correlating; widen by screening a real population with rrc_well_screen instead of by raising the radius.`
          : `Lags beyond the ${radius} mi search radius have no pairs and are not estimated.`,
        `Use ${Math.round(Math.min(fit.model.range_mi, spannedMi) * 10) / 10} mi as the projection distance around this point. Past the correlation length two wells are independent, so a contact, a top or a rate carried further than that is being asserted rather than measured.`,
      ],
    };
  }
);

// ------------------------------------------------------------------ 132

const krige = defineTool(
  "rrc_krige",
  "Interpolate a well attribute to one or more targets by ordinary kriging over a local neighbourhood, with an uncertainty per target.",
  {
    ...SPATIAL_SHAPE,
    targets: z.array(z.object({ lat: z.number(), lon: z.number() })).optional(),
    neighbours: z.number().int().optional(),
    range_mi: z.number().optional(),
    nugget: z.number().optional(),
  },
  async (args) => {
    if (!Number.isFinite(args.lat) || !Number.isFinite(args.lon)) return fail("lat and lon are required.");
    const { points, radius, truncated, wells } = await spatialPoints(args);
    if (points.length < MIN_SPATIAL) {
      return fail(`Only ${points.length} of ${wells} wells carry ${args.attribute}; kriging needs ${MIN_SPATIAL} control points.`);
    }
    const values = points.map((p) => p.value);
    const sd = stddev(values);
    const sill = sd === null ? 0 : sd * sd;
    if (sill <= 0) return fail(`${args.attribute} is constant across this cohort; there is nothing to interpolate.`);

    const fitted = fitVariogram(experimentalVariogram(points, 10, radius), sill, radius);
    const model: Variogram = {
      nugget: Math.max(0, Math.min(sill, args.nugget ?? fitted?.model.nugget ?? 0)),
      sill,
      range_mi: Math.max(0.05, args.range_mi ?? fitted?.model.range_mi ?? radius / 2),
    };
    const k = cap(args.neighbours, 4, 32, 16);
    const targets = (args.targets?.length ? args.targets : [{ lat: args.lat, lon: args.lon }]).slice(0, 25);

    const estimates = targets.map((t) => {
      const r = krigeAt(points, t, model, k);
      return {
        lat: t.lat,
        lon: t.lon,
        estimate: r?.value ?? null,
        stdev: r?.variance == null ? null : Math.sqrt(r.variance),
        method: r?.method ?? null,
        neighbours_used: r?.neighbours ?? 0,
        nearest_control_mi: r?.nearest_mi ?? null,
        basis: ESTIMATED,
      };
    });

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radius,
      attribute: args.attribute,
      formation: args.formation ?? null,
      control_points: points.length,
      neighbourhood: k,
      model: { type: "exponential", ...model },
      estimates,
      truncated: truncated || (args.targets?.length ?? 0) > 25,
      notes: [
        "Ordinary kriging over the nearest control points, solved locally. With a zero nugget the estimator reproduces a control point exactly, which is the check that it is honouring its own data.",
        "Every estimate carries basis 'estimated'. It is an interpolation of filed values, not a filed value.",
        "The standard deviation is the kriging standard error under the fitted model. It measures distance to data, not whether the model is right.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 133

const residualMap = defineTool(
  "rrc_residual_map",
  "Remove the regional trend in latitude and longitude from a well attribute and rank what is left.",
  SPATIAL_SHAPE,
  async (args) => {
    if (!Number.isFinite(args.lat) || !Number.isFinite(args.lon)) return fail("lat and lon are required.");
    const { points, radius, truncated, wells } = await spatialPoints(args);
    if (points.length < MIN_SPATIAL) {
      return fail(`Only ${points.length} of ${wells} wells carry ${args.attribute}; a trend surface needs ${MIN_SPATIAL}.`);
    }

    // Plane fit by normal equations. Two predictors and an intercept is all the
    // structure a well cohort this size can support without inventing one.
    const n = points.length;
    const x = points.map((p) => p.lon - args.lon);
    const y = points.map((p) => p.lat - args.lat);
    const z = points.map((p) => p.value);
    const A = [
      [n, sum(x), sum(y)],
      [sum(x), sum(x.map((v) => v * v)), sum(x.map((v, i) => v * y[i]))],
      [sum(y), sum(x.map((v, i) => v * y[i])), sum(y.map((v) => v * v))],
    ];
    const b = [sum(z), sum(z.map((v, i) => v * x[i])), sum(z.map((v, i) => v * y[i]))];
    const coef = solve(A, b);
    if (!coef) return fail("The wells in this cohort are collinear; a trend surface cannot be fitted.");

    const zbar = mean(z) ?? 0;
    const rows = points.map((p, i) => {
      const trend = coef[0] + coef[1] * x[i] + coef[2] * y[i];
      return { api_number: p.api_number, lat: p.lat, lon: p.lon, value: p.value, trend, residual: p.value - trend };
    });
    const ssRes = rows.reduce((a, r) => a + r.residual ** 2, 0);
    const ssTot = z.reduce((a, v) => a + (v - zbar) ** 2, 0);
    const sd = stddev(rows.map((r) => r.residual));

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radius,
      attribute: args.attribute,
      n,
      trend: {
        intercept_at_center: coef[0],
        per_degree_lon: coef[1],
        per_degree_lat: coef[2],
        r2: ssTot > 0 ? 1 - ssRes / ssTot : null,
      },
      residual_sd: sd,
      above_trend: [...rows].sort((a, b) => b.residual - a.residual).slice(0, 10),
      below_trend: [...rows].sort((a, b) => a.residual - b.residual).slice(0, 10),
      truncated,
      notes: [
        "The trend is a plane in latitude and longitude: the part of the attribute your address explains. The residual is what the well did on top of it.",
        "A plane is the right model for structural dip over a few miles and the wrong one over a basin. Read the r2 before trusting the residual.",
        "A high residual is a well that beat its location. Whether that is the operator, the completion or the zone is rrc_attribution's question.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 134

const hotspots = defineTool(
  "rrc_hotspots",
  "Getis-Ord Gi* clusters and global Moran's I on a well attribute, with a seeded permutation test.",
  { ...SPATIAL_SHAPE, band_mi: z.number().optional(), seed: z.number().int(), permutations: z.number().int().optional() },
  async (args) => {
    if (!Number.isFinite(args.lat) || !Number.isFinite(args.lon)) return fail("lat and lon are required.");
    const { points, radius, truncated, wells } = await spatialPoints(args);
    if (points.length < MIN_SPATIAL) {
      return fail(`Only ${points.length} of ${wells} wells carry ${args.attribute}; a cluster test needs ${MIN_SPATIAL}.`);
    }
    const n = points.length;
    const dist = points.map((p) => points.map((q) => distanceMiles(p.lat, p.lon, q.lat, q.lon)));

    // A band with no neighbours makes every statistic undefined, so the default
    // is the distance at which a typical well has four of them.
    const band =
      args.band_mi != null && args.band_mi > 0
        ? args.band_mi
        : median(dist.map((row) => [...row].sort((a, b) => a - b)[Math.min(4, n - 1)])) ?? radius / 4;

    const w: number[][] = dist.map((row) => row.map((d) => (d <= band ? 1 : 0)));
    const values = points.map((p) => p.value);
    const xbar = mean(values) ?? 0;
    const s = Math.sqrt(sum(values.map((v) => v * v)) / n - xbar * xbar);
    if (s <= 0) return fail(`${args.attribute} is constant across this cohort; there are no clusters to find.`);

    const moran = (vals: readonly number[]) => {
      const m = mean(vals) ?? 0;
      let num = 0;
      let W = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          num += w[i][j] * (vals[i] - m) * (vals[j] - m);
          W += w[i][j];
        }
      }
      const den = vals.reduce((a, v) => a + (v - m) ** 2, 0);
      return W > 0 && den > 0 ? (n / W) * (num / den) : null;
    };

    const observed = moran(values);
    if (observed === null) return fail(`No well has a neighbour inside ${band.toFixed(2)} mi; widen band_mi.`);

    // Permutation rather than a normal approximation: the approximation assumes
    // a spatial layout Texas wells do not have.
    const perms = cap(args.permutations, 49, 999, 199);
    const rnd = seeded(args.seed);
    let atLeastAsExtreme = 0;
    for (let p = 0; p < perms; p++) {
      const shuffled = [...values];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const m = moran(shuffled);
      if (m !== null && Math.abs(m) >= Math.abs(observed)) atLeastAsExtreme += 1;
    }

    const gi = points.map((p, i) => {
      // Gi* includes the point itself, which is what makes it a hot SPOT rather
      // than a statement about its neighbours only.
      const wi = w[i].reduce((a, v) => a + v, 0);
      const wsq = w[i].reduce((a, v) => a + v * v, 0);
      const local = values.reduce((a, v, j) => a + w[i][j] * v, 0);
      const denom = s * Math.sqrt((n * wsq - wi * wi) / (n - 1));
      const z = denom > 0 ? (local - xbar * wi) / denom : null;
      return {
        api_number: p.api_number,
        lat: p.lat,
        lon: p.lon,
        value: p.value,
        neighbours: wi - 1,
        gi_z: z,
        cluster: z == null ? "undefined" : z >= 1.96 ? "hot" : z <= -1.96 ? "cold" : "none",
      };
    });

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radius,
      attribute: args.attribute,
      n,
      band_mi: band,
      seed: args.seed,
      permutations: perms,
      morans_i: observed,
      expected_i: -1 / (n - 1),
      pseudo_p: (atLeastAsExtreme + 1) / (perms + 1),
      hot: gi.filter((g) => g.cluster === "hot").sort((a, b) => (b.gi_z ?? 0) - (a.gi_z ?? 0)),
      cold: gi.filter((g) => g.cluster === "cold").sort((a, b) => (a.gi_z ?? 0) - (b.gi_z ?? 0)),
      points: gi,
      truncated,
      notes: [
        "Gi* is scored at the 1.96 threshold per point with no multiplicity correction, so on a hundred wells a couple of hot points are expected by chance. Moran's I with its permutation p is the test for whether the pattern as a whole is real.",
        "The neighbour rule is a fixed distance band. Change band_mi and the clusters change: that is a property of the method, not a bug.",
        "Both statistics are seeded and reproduce exactly for a given seed.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 135

interface LeaseFeature {
  key: string;
  name: string;
  field_no: string | null;
  operator_no: string | null;
  wells: number;
  first_cycle: string | null;
  months_on: number | null;
  current_rate: number | null;
  gor: number | null;
  di: number | null;
  b: number | null;
}

/** The feature vector both the analog search and the decline clusters read. */
function leaseFeatures(lease: LoadedLease): LeaseFeature {
  const reported = lease.months.filter((m) => m.reported);
  const producing = reported.filter((m) => m.oil_prod_vol > 0 || m.gas_prod_vol > 0);
  const first = producing[0]?.cycle ?? null;
  const last = producing[producing.length - 1]?.cycle ?? null;
  const recent = producing.slice(-12);
  const oil = sum(recent.map((m) => m.oil_prod_vol));
  const gas = sum(recent.map((m) => m.gas_prod_vol));
  const days = sum(recent.map((m) => daysInCycle(m.cycle)));
  const fit = fitDecline(leaseRates(lease.months, "oil"));
  return {
    key: lease.key,
    name: lease.name,
    field_no: lease.field_no,
    operator_no: lease.operator_no,
    wells: lease.wells,
    first_cycle: first,
    months_on: first && last ? monthsBetween(first, last) + 1 : null,
    current_rate: days > 0 ? oil / days : null,
    gor: oil > 0 ? (gas * 1000) / oil : null,
    di: fit?.Di ?? null,
    b: fit?.b ?? null,
  };
}

/** Z-score a feature across the cohort; null when it has no spread. */
function zScores(values: readonly (number | null)[]): (number | null)[] {
  const present = clean(values);
  const m = mean(present);
  const sd = stddev(present);
  if (m === null || sd === null || sd === 0) return values.map(() => null);
  return values.map((v) => (v == null ? null : (v - m) / sd));
}

const ANALOG_FEATURES = ["current_rate", "gor", "months_on", "wells", "di", "b"] as const;

const analogSearch = defineTool(
  "rrc_analog_search",
  "Nearest neighbours to a target lease on a standardised feature vector of rate, GOR, vintage, well count and decline shape.",
  {
    target: z.string(),
    candidates: z.array(z.string()).optional(),
    county: z.string().optional(),
    limit: z.number().int().optional(),
  },
  async ({ target, candidates, county, limit }) => {
    if (!parseLeaseKey(target)) return fail(`target must be a lease key like "O/08/12345".`);
    const wanted = cap(limit, 4, MAX_LEASES, 12);

    let keys = candidates?.filter((k) => k !== target) ?? [];
    if (!keys.length) {
      if (!county?.trim()) return fail("Give candidates, or a county to draw them from.");
      const resolved = resolveCounty(county.trim());
      if (!resolved) return fail(`Not a Texas county: ${county}.`);
      const profile = await getCountyProfile(resolved.county_no, 12);
      if (!profile) return fail(`No county profile for ${county}.`);
      keys = profile.topLeases
        .map((l) => `${l.oil_gas_code}/${l.district_no}/${l.lease_no}`)
        .filter((k) => k !== target);
    }

    const loaded = await loadLeases([target, ...keys], MAX_LEASES);
    const targetLease = loaded.leases.find((l) => l.key === target);
    if (!targetLease) return fail(`Could not load target lease ${target}.`);
    const pool = loaded.leases.filter((l) => l.key !== target);
    if (pool.length < 3) return fail(`Only ${pool.length} candidate lease(s) loaded; a search needs 3.`);

    const features = [targetLease, ...pool].map(leaseFeatures);
    const z = Object.fromEntries(
      ANALOG_FEATURES.map((f) => [f, zScores(features.map((x) => x[f]))])
    ) as Record<(typeof ANALOG_FEATURES)[number], (number | null)[]>;

    const ranked = pool
      .map((_, i) => {
        const idx = i + 1;
        let ss = 0;
        const used: string[] = [];
        for (const f of ANALOG_FEATURES) {
          const a = z[f][0];
          const b = z[f][idx];
          if (a == null || b == null) continue;
          ss += (a - b) ** 2;
          used.push(f);
        }
        // A different field is a real difference, worth about one standard
        // deviation of any single feature.
        const sameField = features[idx].field_no != null && features[idx].field_no === features[0].field_no;
        if (!sameField) ss += 1;
        return {
          ...features[idx],
          same_field: sameField,
          features_used: used,
          distance: used.length ? Math.sqrt(ss / (used.length + 1)) : null,
        };
      })
      .filter((r) => r.distance !== null)
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
      .slice(0, wanted);

    return {
      ok: true as const,
      target: { ...features[0] },
      candidates_considered: pool.length,
      analogs: ranked,
      failures: loaded.failures,
      truncated: loaded.truncated || pool.length > ranked.length,
      notes: [
        "Distance is Euclidean over standardised features, so it is only meaningful WITHIN this candidate set: the same lease scored against a different pool gets a different number.",
        "Depth is not in the vector. The RRC files production per lease and depth per wellbore, and there is no lease-grain depth to standardise.",
        "Decline shape comes from the same Arps fit the rest of the app uses, on reported months only. A lease with too little post-peak history contributes no shape and is compared on the rest.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 136

const CLUSTER_FEATURES = ["di", "b", "current_rate", "months_on"] as const;

const declineClusters = defineTool(
  "rrc_decline_clusters",
  "Group leases by the shape of their decline rather than by geography, with seeded k-means over standardised curve features.",
  {
    leases: z.array(z.string()).optional(),
    county: z.string().optional(),
    k: z.number().int().optional(),
    seed: z.number().int(),
    limit: z.number().int().optional(),
  },
  async ({ leases, county, k, seed, limit }) => {
    let keys = leases ?? [];
    if (!keys.length) {
      if (!county?.trim()) return fail("Give leases, or a county to draw them from.");
      const resolved = resolveCounty(county.trim());
      if (!resolved) return fail(`Not a Texas county: ${county}.`);
      const profile = await getCountyProfile(resolved.county_no, 12);
      if (!profile) return fail(`No county profile for ${county}.`);
      keys = profile.topLeases.map((l) => `${l.oil_gas_code}/${l.district_no}/${l.lease_no}`);
    }

    const groups = cap(k, 2, 6, 3);
    const loaded = await loadLeases(keys, cap(limit, 6, MAX_LEASES, MAX_LEASES));
    const features = loaded.leases.map(leaseFeatures).filter((f) => f.di != null && f.b != null);
    if (features.length < groups * 3) {
      return fail(
        `Only ${features.length} lease(s) carry a decline fit; ${groups} clusters need ${groups * 3}. Fewer clusters or more leases.`
      );
    }

    const z = CLUSTER_FEATURES.map((f) => zScores(features.map((x) => x[f])));
    const vectors = features.map((_, i) => CLUSTER_FEATURES.map((_f, j) => z[j][i] ?? 0));

    // Seeded k-means. Deterministic start, fixed iteration count: the same seed
    // must give the same grouping or the clusters are not a finding.
    const rnd = seeded(seed);
    const centroids: number[][] = [];
    const taken = new Set<number>();
    while (centroids.length < groups) {
      const pick = Math.floor(rnd() * vectors.length);
      if (taken.has(pick)) continue;
      taken.add(pick);
      centroids.push([...vectors[pick]]);
    }
    let assignment = vectors.map(() => 0);
    for (let iter = 0; iter < 25; iter++) {
      assignment = vectors.map((v) => {
        let best = 0;
        let bestD = Infinity;
        centroids.forEach((c, ci) => {
          const d = c.reduce((a, x, i) => a + (x - v[i]) ** 2, 0);
          if (d < bestD) {
            bestD = d;
            best = ci;
          }
        });
        return best;
      });
      for (let ci = 0; ci < groups; ci++) {
        const members = vectors.filter((_, i) => assignment[i] === ci);
        if (!members.length) continue;
        centroids[ci] = centroids[ci].map((_x, j) => mean(members.map((m) => m[j])) ?? 0);
      }
    }

    return {
      ok: true as const,
      k: groups,
      seed,
      n: features.length,
      features: CLUSTER_FEATURES,
      clusters: Array.from({ length: groups }, (_v, ci) => {
        const members = features.filter((_f, i) => assignment[i] === ci);
        return {
          cluster: ci,
          size: members.length,
          median_di: median(clean(members.map((m) => m.di))),
          median_b: median(clean(members.map((m) => m.b))),
          median_rate_bbl_per_day: median(clean(members.map((m) => m.current_rate))),
          median_months_on: median(clean(members.map((m) => m.months_on))),
          members: members.map((m) => ({ key: m.key, name: m.name, di: m.di, b: m.b, current_rate: m.current_rate })),
        };
      }),
      excluded: loaded.leases.length - features.length,
      failures: loaded.failures,
      truncated: loaded.truncated,
      notes: [
        "Clusters are relative to this cohort: standardisation and the k-means start both depend on which leases were passed, so the same lease can land in a different cluster in a different set.",
        "Leases with no post-peak decline are excluded rather than clustered at zero, and the count is reported.",
        "k-means is seeded and runs a fixed 25 iterations, so the grouping is reproducible from the seed alone.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 138

const MIN_SEASONAL_MONTHS = 36;

const seasonality = defineTool(
  "rrc_seasonality",
  "Split a production series into trend, calendar-month seasonality and residual, and rank the freeze-off months.",
  { ...ENTITY_SHAPE, stream: z.enum(["oil", "gas"]).optional(), months: z.number().int().optional() },
  async (args) => {
    const which = args.stream ?? "gas";
    const resolved = await resolveSeries(args);
    if (isError(resolved)) return fail(resolved.error);
    const { cycles, values } = streamValues(resolved.points, which);
    const window = cap(args.months, MIN_SEASONAL_MONTHS, 600, 240);
    const from = Math.max(0, cycles.length - window);
    const series = cycles.slice(from).map((cycle, i) => ({ cycle, rate: dailyRate(values[from + i], cycle) }));
    if (series.length < MIN_SEASONAL_MONTHS) {
      return fail(`Only ${series.length} reported months; a seasonal decomposition needs ${MIN_SEASONAL_MONTHS}.`);
    }

    // Centred 12-month moving average: the standard trend for monthly data, and
    // the only one that cannot leak a seasonal peak into the trend it removes.
    const trend = series.map((_p, i) => {
      if (i < 6 || i > series.length - 7) return null;
      return mean(series.slice(i - 6, i + 6).map((p) => p.rate));
    });
    const detrended = series.map((p, i) => (trend[i] == null || trend[i] === 0 ? null : p.rate - (trend[i] as number)));

    const byMonth = new Map<string, number[]>();
    series.forEach((p, i) => {
      const d = detrended[i];
      if (d == null) return;
      const m = p.cycle.slice(5);
      byMonth.set(m, [...(byMonth.get(m) ?? []), d]);
    });
    const seasonal = [...byMonth.entries()]
      .map(([month, vals]) => ({ month, index_bbl_per_day: mean(vals), years: vals.length }))
      .sort((a, b) => a.month.localeCompare(b.month));
    const indexBy = new Map(seasonal.map((s) => [s.month, s.index_bbl_per_day ?? 0]));

    const residuals = series.map((p, i) => {
      const d = detrended[i];
      return d == null ? null : { cycle: p.cycle, residual: d - (indexBy.get(p.cycle.slice(5)) ?? 0), rate: p.rate, trend: trend[i] };
    });
    const present = residuals.filter((r): r is NonNullable<typeof r> => r !== null);
    const sd = stddev(present.map((r) => r.residual));

    const winter = present.filter((r) => ["01", "02", "03"].includes(r.cycle.slice(5)));
    const freezeOff = winter
      .filter((r) => r.residual < 0)
      .sort((a, b) => a.residual - b.residual)
      .slice(0, 10)
      .map((r) => ({
        cycle: r.cycle,
        residual: r.residual,
        z: sd && sd > 0 ? r.residual / sd : null,
        share_of_trend: r.trend ? r.residual / r.trend : null,
      }));

    return {
      ok: true as const,
      entity: resolved.label,
      stream: which,
      reported_through: resolved.reportedThrough,
      months: series.length,
      seasonal_index: seasonal,
      residual_sd: sd,
      worst_months: [...present].sort((a, b) => a.residual - b.residual).slice(0, 6).map((r) => ({ cycle: r.cycle, residual: r.residual })),
      freeze_off_candidates: freezeOff,
      february_2021: present.find((r) => r.cycle === "2021-02") ?? null,
      notes: [
        "Additive decomposition on daily rates: monthly volumes are already normalised for month length, so a 28-day February is not read as a 10% drop.",
        "The seasonal index is the average deviation from trend for each calendar month across the window, so it mixes weather with the operational calendar and cannot separate them.",
        "February 2021 is Winter Storm Uri. It is in the residual, not the seasonal index, which is why it is reported on its own line.",
        "The first and last six months carry no centred trend and therefore no residual.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 139

const vintageCurves = defineTool(
  "rrc_vintage_curves",
  "Average lease curves grouped by first-production year at equal months on production.",
  {
    leases: z.array(z.string()).optional(),
    county: z.string().optional(),
    stream: z.enum(["oil", "gas"]).optional(),
    months: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async ({ leases, county, stream, months, limit }) => {
    const which = stream ?? "oil";
    let keys = leases ?? [];
    if (!keys.length) {
      if (!county?.trim()) return fail("Give leases, or a county to draw them from.");
      const resolved = resolveCounty(county.trim());
      if (!resolved) return fail(`Not a Texas county: ${county}.`);
      const profile = await getCountyProfile(resolved.county_no, 12);
      if (!profile) return fail(`No county profile for ${county}.`);
      keys = profile.topLeases.map((l) => `${l.oil_gas_code}/${l.district_no}/${l.lease_no}`);
    }
    const horizon = cap(months, 6, 120, 60);
    const loaded = await loadLeases(keys, cap(limit, 4, MAX_LEASES, MAX_LEASES));
    if (loaded.leases.length < 2) return fail(`Only ${loaded.leases.length} lease(s) loaded; a cohort curve needs 2.`);

    const members = loaded.leases
      .map((lease) => {
        const rates = leaseRates(lease.months, which).filter((r) => r.rate > 0);
        const first = rates[0];
        if (!first) return null;
        return {
          key: lease.key,
          name: lease.name,
          vintage: Number(first.month.slice(0, 4)),
          first_cycle: first.month,
          points: rates
            .map((r) => ({ month_on: monthsBetween(first.month, r.month), rate: r.rate }))
            .filter((p) => p.month_on >= 0 && p.month_on < horizon),
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    if (!members.length) return fail("No lease in this set has a producing month to anchor months-on.");

    const vintages = [...new Set(members.map((m) => m.vintage))].sort((a, b) => a - b);
    return {
      ok: true as const,
      stream: which,
      horizon_months: horizon,
      leases: members.length,
      cohorts: vintages.map((vintage) => {
        const group = members.filter((m) => m.vintage === vintage);
        return {
          vintage,
          leases: group.length,
          keys: group.map((g) => g.key),
          curve: Array.from({ length: horizon }, (_v, i) => {
            const at = clean(group.map((g) => g.points.find((p) => p.month_on === i)?.rate ?? null));
            return at.length ? { month_on: i, n: at.length, median_rate: median(at), mean_rate: mean(at) } : null;
          }).filter((p): p is NonNullable<typeof p> => p !== null),
        };
      }),
      failures: loaded.failures,
      truncated: loaded.truncated,
      notes: [
        "Month zero is each lease's FIRST reported producing month in the mirror, which for an old lease is where the RRC's electronic record starts rather than where the lease started.",
        "Curves are lease-grain. A lease that added wells later shows as a rising curve, which is a real thing that happened and not a better well.",
        "Every point reports how many leases are still contributing, because a cohort curve thins out fast at the right-hand end.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 140

const MIN_LEAD_LAG = 24;

const leadLag = defineTool(
  "rrc_lead_lag",
  "Fit the lag from permits to county production, then project the next months from permits already issued.",
  {
    county: z.string(),
    max_lag_months: z.number().int().optional(),
    history_months: z.number().int().optional(),
  },
  async ({ county, max_lag_months, history_months }) => {
    const resolved = resolveCounty(county.trim());
    if (!resolved) return fail(`Not a Texas county: ${county}.`);
    const history = cap(history_months, 36, 240, 120);
    const maxLag = cap(max_lag_months, 3, 36, 24);

    const since = addMonths(`${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`, -history);
    const [profile, permits] = await Promise.all([
      getCountyProfile(resolved.county_no, history),
      listPermits({ county: resolved.county_no, since: `${since}-01`, limit: 500 }),
    ]);
    if (!profile) return fail(`No county profile for ${county}.`);

    const permitsByCycle = new Map<string, number>();
    for (const p of permits) {
      const cycle = (p.issued_date ?? "").slice(0, 7);
      if (cycle.length === 7) permitsByCycle.set(cycle, (permitsByCycle.get(cycle) ?? 0) + 1);
    }
    const production = reportedOnly(profile.monthly);
    if (production.length < MIN_LEAD_LAG) {
      return fail(`Only ${production.length} reported cycles for ${resolved.county_name}; a lead-lag fit needs ${MIN_LEAD_LAG}.`);
    }

    const byLag = Array.from({ length: maxLag + 1 }, (_v, lag) => {
      const pairs: (readonly [number, number])[] = [];
      for (const p of production) {
        const permitsAt = permitsByCycle.get(addMonths(p.cycle, -lag));
        if (permitsAt != null) pairs.push([permitsAt, p.oil] as const);
      }
      const fit = linearFit(pairs);
      const r2 = fit?.r2 ?? null;
      return {
        lag_months: lag,
        n: pairs.length,
        r: r2 == null || fit == null ? null : Math.sign(fit.slope) * Math.sqrt(r2),
        r2,
        bbl_per_permit: fit?.slope ?? null,
        sufficient: pairs.length >= MIN_LEAD_LAG,
      };
    });
    const usable = byLag.filter((l) => l.sufficient && l.r != null);
    if (!usable.length) {
      return fail(`No lag has ${MIN_LEAD_LAG} overlapping months of permits and production in ${resolved.county_name}.`);
    }
    const best = usable.reduce((a, b) => (Math.abs(b.r ?? 0) > Math.abs(a.r ?? 0) ? b : a));

    // Projection only where the fit is real. A slope with an r2 of 0.05 is a
    // number, and quoting it forward is how a guess becomes a forecast.
    const lastCycle = production[production.length - 1].cycle;
    const projection =
      best.r2 != null && best.r2 >= 0.25 && best.bbl_per_permit != null
        ? Array.from({ length: 12 }, (_v, i) => {
            const cycle = addMonths(lastCycle, i + 1);
            const driver = permitsByCycle.get(addMonths(cycle, -best.lag_months));
            return driver == null
              ? null
              : {
                  cycle,
                  permits_at_lag: driver,
                  estimated_oil: driver * (best.bbl_per_permit as number),
                  basis: ESTIMATED,
                };
          }).filter((p): p is NonNullable<typeof p> => p !== null)
        : [];

    return {
      ok: true as const,
      county: resolved.county_name,
      permits_considered: permits.length,
      production_cycles: production.length,
      reported_through: production[production.length - 1].cycle,
      by_lag: byLag,
      best_lag_months: best.lag_months,
      best_r: best.r,
      best_r2: best.r2,
      bbl_per_permit_at_best_lag: best.bbl_per_permit,
      projection,
      projection_withheld: projection.length === 0,
      truncated: permits.length >= 500,
      notes: [
        "The lag is SELECTED by fit across 0 to maxLag months, so the best r is optimistic by construction. Read the whole by_lag table, not just the winner.",
        "A permit is not a well. Many are never drilled, and the fitted barrels per permit absorbs that drop-out rate along with everything else that moved with drilling.",
        "Projections are only issued when the selected lag explains at least a quarter of the variance, and every projected month carries basis 'estimated'.",
        "Permits are capped at 500 by the permit query; a busier county is truncated and the early history thins first.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 141

const concentration = defineTool(
  "rrc_concentration",
  "Herfindahl-Hirschman concentration for a field's operators, a county's operators, a lease set's purchasers, or a radius of disposal.",
  {
    scope: z.enum(["field", "county", "purchaser", "disposal"]),
    field_no: z.string().optional(),
    county: z.string().optional(),
    leases: z.array(z.string()).optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    radius_mi: z.number().optional(),
    months: z.number().int().optional(),
  },
  async (args) => {
    const window = cap(args.months, 3, 120, 12);

    if (args.scope === "field") {
      const fieldNo = args.field_no?.trim();
      if (!fieldNo) return fail("scope 'field' needs field_no.");
      const profile = await getFieldProfile(fieldNo, window);
      if (!profile) return fail(`No field ${fieldNo}.`);
      const total = sum(reportedOnly(profile.monthly).slice(-window).map((p) => p.oil));
      const listed = sum(profile.topOperators.map((o) => o.oil));
      const shares = profile.topOperators.map((o) => ({
        operator_no: o.operator_no,
        operator_name: o.operator_name,
        oil: o.oil,
        share: total > 0 ? o.oil / total : null,
      }));
      const covered = total > 0 ? listed / total : null;
      const listedHhi = hhi(profile.topOperators.map((o) => o.oil));
      return {
        ok: true as const,
        scope: args.scope,
        field_no: profile.field_no,
        field_name: profile.field_name,
        basis: "oil volume",
        window_months: window,
        operators_listed: shares.length,
        share_covered: covered,
        hhi_of_listed: listedHhi,
        hhi_lower_bound:
          total > 0 ? sum(profile.topOperators.map((o) => ((o.oil / total) * 100) ** 2)) : null,
        shares,
        // The operator list is a top-N by construction, so any field whose
        // listed operators do not account for all of it is a cut list.
        truncated: covered == null || covered < 0.999,
        notes: [
          "The field profile lists its top operators, not all of them. hhi_of_listed treats those as the whole market; hhi_lower_bound uses the true field total as the denominator and therefore cannot overstate concentration.",
          "share_covered says how much of the field the listed operators account for. Below about 0.9 the two numbers diverge and only the lower bound is safe to quote.",
        ],
      };
    }

    if (args.scope === "county") {
      const resolved = resolveCounty(args.county?.trim() ?? "");
      if (!resolved) return fail("scope 'county' needs a Texas county.");
      const rows = await rrcQuery<{ operator_number: string; operator_name: string | null; wells: number }>(
        `select w.operator_number, max(w.operator_name) as operator_name,
                count(distinct w.api_number)::int as wells
           from rrc.wellbore w
          where w.county_code = $1 and w.on_schedule = 'Y' and w.operator_number is not null
          group by 1
          order by wells desc
          limit 200`,
        [resolved.county_no]
      );
      if (!rows.length) return fail(`No wells on schedule in ${resolved.county_name}.`);
      const total = sum(rows.map((r) => r.wells));
      return {
        ok: true as const,
        scope: args.scope,
        county: resolved.county_name,
        basis: "well count",
        operators: rows.length,
        wells: total,
        hhi: hhi(rows.map((r) => r.wells)),
        top: rows.slice(0, 20).map((r) => ({ ...r, share: total > 0 ? r.wells / total : null })),
        truncated: rows.length >= 200,
        notes: [
          "Concentration by WELL COUNT, not by volume: the county rollup carries no operator column, so counting holes is the honest county-grain answer.",
          "A county where one operator holds most of the wells and another holds most of the production will read differently here than a volume HHI would.",
        ],
      };
    }

    if (args.scope === "purchaser") {
      let keys = args.leases ?? [];
      if (!keys.length) {
        const resolved = resolveCounty(args.county?.trim() ?? "");
        if (!resolved) return fail("scope 'purchaser' needs leases, or a county to draw them from.");
        const profile = await getCountyProfile(resolved.county_no, window);
        if (!profile) return fail(`No county profile for ${args.county}.`);
        keys = profile.topLeases.map((l) => `${l.oil_gas_code}/${l.district_no}/${l.lease_no}`);
      }
      const capped = keys.slice(0, 12);
      const dossiers = await Promise.all(
        capped.map(async (key) => {
          const parsed = parseLeaseKey(key);
          if (!parsed) return null;
          const d = await getLeaseDossier(parsed.oil_gas_code, parsed.district_no, parsed.lease_no);
          return d ? { key, dossier: d } : null;
        })
      );
      const found = dossiers.filter((d): d is NonNullable<typeof d> => d !== null);
      if (!found.length) return fail("No lease in this set resolved.");
      const weights = new Map<string, { name: string | null; oil: number; leases: number }>();
      let unattributed = 0;
      for (const { dossier } of found) {
        const reported = dossier.monthly.filter((m) => m.reported).slice(-window);
        const oil = sum(reported.map((m) => m.oil_prod_vol));
        // 'H' is the purchaser role on the P-4. A gatherer moves the product;
        // it does not buy it, and mixing the two answers a different question.
        const buyers = dossier.p4.connections.filter((c) => c.type_code === "H");
        if (!buyers.length) {
          unattributed += oil;
          continue;
        }
        for (const b of buyers) {
          const key = b.gpn_no ?? b.operator_name ?? "(unnamed)";
          const prior = weights.get(key) ?? { name: b.operator_name, oil: 0, leases: 0 };
          weights.set(key, {
            name: b.operator_name ?? prior.name,
            oil: prior.oil + oil * (b.actual_percent ?? 1 / buyers.length),
            leases: prior.leases + 1,
          });
        }
      }
      const rows = [...weights.entries()].map(([gpn_no, v]) => ({ gpn_no, ...v })).sort((a, b) => b.oil - a.oil);
      if (!rows.length) return fail("No P-4 purchaser connection on any lease in this set.");
      const total = sum(rows.map((r) => r.oil));
      return {
        ok: true as const,
        scope: args.scope,
        leases_considered: found.length,
        basis: "oil volume weighted by P-4 share",
        window_months: window,
        hhi: hhi(rows.map((r) => r.oil)),
        unattributed_oil: unattributed,
        purchasers: rows.map((r) => ({ ...r, share: total > 0 ? r.oil / total : null })),
        truncated: keys.length > capped.length,
        notes: [
          "The P-4 says who is AUTHORISED to take the product, not what they paid or how much they actually took. Volume is attributed by the filing's stated percentage, or split evenly when it states none.",
          "Leases with no purchaser connection are held out as unattributed rather than dropped, so the denominator stays honest.",
        ],
      };
    }

    if (!Number.isFinite(args.lat ?? NaN) || !Number.isFinite(args.lon ?? NaN)) {
      return fail("scope 'disposal' needs lat and lon.");
    }
    const found = await findDisposal({
      lat: args.lat,
      lon: args.lon,
      radiusMi: Math.min(50, Math.max(1, args.radius_mi ?? 25)),
      limit: 200,
    });
    if (!found.length) return fail("No live disposal permits in that radius.");
    const byOperator = new Map<string, { name: string | null; permitted: number; reported: number; wells: number }>();
    for (const d of found) {
      const key = d.operator_no ?? d.operator_name ?? "(unnamed)";
      const prior = byOperator.get(key) ?? { name: d.operator_name, permitted: 0, reported: 0, wells: 0 };
      byOperator.set(key, {
        name: d.operator_name ?? prior.name,
        permitted: prior.permitted + (d.max_bbl_per_day ?? 0),
        reported: prior.reported + (d.recentBblPerDay ?? 0),
        wells: prior.wells + 1,
      });
    }
    const rows = [...byOperator.entries()].map(([operator_no, v]) => ({ operator_no, ...v })).sort((a, b) => b.permitted - a.permitted);
    const totalPermitted = sum(rows.map((r) => r.permitted));
    return {
      ok: true as const,
      scope: args.scope,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: args.radius_mi ?? 25,
      basis: "permitted bbl/day, with reported alongside",
      operators: rows.length,
      wells: found.length,
      hhi_permitted: hhi(rows.map((r) => r.permitted)),
      hhi_reported: hhi(rows.map((r) => r.reported)),
      shares: rows.map((r) => ({ ...r, permitted_share: totalPermitted > 0 ? r.permitted / totalPermitted : null })),
      truncated: found.length >= 200,
      notes: [
        "Permitted volume is a legal ceiling, not an offer, so a permitted HHI measures who holds the paper rather than who takes the water.",
        "The reported HHI is the same market measured through H-10 filings, which run about a year behind.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 142

const MAX_GRAPH_NODES = 60;

const graphMetrics = defineTool(
  "rrc_graph_metrics",
  "Degree and betweenness centrality plus label-propagation communities on the officer-shared operator graph around one operator.",
  { operator_no: z.string(), hops: z.number().int().optional(), max_nodes: z.number().int().optional() },
  async ({ operator_no, hops, max_nodes }) => {
    const seed = operator_no.trim();
    if (!seed) return fail("operator_no is required.");
    const depth = cap(hops, 1, 2, 1);
    const nodeCap = cap(max_nodes, 10, MAX_GRAPH_NODES, 40);

    const names = new Map<string, string | null>();
    const edges = new Map<string, Set<string>>();
    const via = new Map<string, string[]>();
    const visited = new Set<string>();
    let frontier = [seed];
    let truncated = false;

    for (let h = 0; h <= depth; h++) {
      const next: string[] = [];
      for (const node of frontier) {
        if (visited.has(node) || visited.size >= nodeCap) {
          if (visited.size >= nodeCap) truncated = true;
          continue;
        }
        visited.add(node);
        const net = await getOperatorNetwork(node);
        if (!net) continue;
        names.set(node, net.operator_name);
        for (const r of net.related) {
          const other = r.operator_number;
          names.set(other, r.operator_name);
          for (const [a, b] of [
            [node, other],
            [other, node],
          ]) {
            const set = edges.get(a) ?? new Set<string>();
            set.add(b);
            edges.set(a, set);
          }
          const key = [node, other].sort().join("|");
          via.set(key, [...new Set([...(via.get(key) ?? []), r.officer_name])]);
          if (!visited.has(other)) next.push(other);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }

    const nodes = [...visited].filter((n) => edges.has(n) || n === seed).sort();
    if (nodes.length < 2) return fail(`Operator ${seed} shares no named officer with any other P-5 operator.`);
    const index = new Map(nodes.map((n, i) => [n, i]));
    const adjacency = nodes.map((n) => [...(edges.get(n) ?? [])].filter((m) => index.has(m)).map((m) => index.get(m) as number));

    // Brandes betweenness on an unweighted graph. The node cap is what keeps
    // this O(nm) rather than a problem.
    const betweenness = new Array(nodes.length).fill(0);
    for (let s = 0; s < nodes.length; s++) {
      const stack: number[] = [];
      const preds: number[][] = nodes.map(() => []);
      const sigma = new Array(nodes.length).fill(0);
      const dist = new Array(nodes.length).fill(-1);
      sigma[s] = 1;
      dist[s] = 0;
      const queue = [s];
      while (queue.length) {
        const v = queue.shift() as number;
        stack.push(v);
        for (const w of adjacency[v]) {
          if (dist[w] < 0) {
            dist[w] = dist[v] + 1;
            queue.push(w);
          }
          if (dist[w] === dist[v] + 1) {
            sigma[w] += sigma[v];
            preds[w].push(v);
          }
        }
      }
      const delta = new Array(nodes.length).fill(0);
      while (stack.length) {
        const w = stack.pop() as number;
        for (const v of preds[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
        if (w !== s) betweenness[w] += delta[w];
      }
    }

    // Label propagation, iterated in sorted order with the lowest label winning
    // ties, so communities are deterministic without a seed.
    const labels = nodes.map((_n, i) => i);
    for (let iter = 0; iter < 20; iter++) {
      let changed = false;
      for (let i = 0; i < nodes.length; i++) {
        const counts = new Map<number, number>();
        for (const j of adjacency[i]) counts.set(labels[j], (counts.get(labels[j]) ?? 0) + 1);
        if (!counts.size) continue;
        const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
        if (best !== labels[i]) {
          labels[i] = best;
          changed = true;
        }
      }
      if (!changed) break;
    }

    const communities = [...new Set(labels)].map((label) => ({
      community: label,
      members: nodes.filter((_n, i) => labels[i] === label).map((n) => ({ operator_number: n, operator_name: names.get(n) ?? null })),
    }));

    return {
      ok: true as const,
      seed_operator: seed,
      hops: depth,
      nodes: nodes.length,
      edges: [...via.keys()].length,
      centrality: nodes
        .map((n, i) => ({
          operator_number: n,
          operator_name: names.get(n) ?? null,
          degree: adjacency[i].length,
          betweenness: betweenness[i] / 2,
          expanded: visited.has(n),
        }))
        .sort((a, b) => b.betweenness - a.betweenness || b.degree - a.degree),
      communities: communities.sort((a, b) => b.members.length - a.members.length),
      shared_officers: [...via.entries()].slice(0, 100).map(([pair, officers]) => ({ pair: pair.split("|"), officers })),
      truncated: truncated || via.size > 100,
      notes: [
        "An edge is a NAMED OFFICER on both P-5 records. Two men called James Smith make an edge here and are not the same person, so treat an edge as a lead rather than a relationship.",
        "Only expanded nodes have their full neighbourhood loaded; degree for a node at the frontier counts the edges seen from inside the crawl and understates the rest.",
        "Betweenness is halved for the undirected graph and is comparable only within this subgraph.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 143

const CI_QUANTITIES = ["mean_daily_rate", "trend_slope", "decline_di", "decline_b"] as const;
const MIN_CI_MONTHS = 12;
const BLOCK_MONTHS = 6;

const uncertaintyCi = defineTool(
  "rrc_uncertainty_ci",
  "Bootstrap confidence interval for a mean, trend or other summary statistic on one entity's series, from an explicit seed that is returned with the answer. For decline parameters specifically, use rrc_decline_ci.",
  {
    ...ENTITY_SHAPE,
    quantity: z.enum(CI_QUANTITIES),
    stream: z.enum(["oil", "gas"]).optional(),
    seed: z.number().int(),
    iterations: z.number().int().optional(),
    months: z.number().int().optional(),
  },
  async (args) => {
    const which = args.stream ?? "oil";
    const resolved = await resolveSeries(args);
    if (isError(resolved)) return fail(resolved.error);
    const { cycles, values } = streamValues(resolved.points, which);
    const window = cap(args.months, MIN_CI_MONTHS, 600, 120);
    const from = Math.max(0, cycles.length - window);
    const series: MonthlyRate[] = cycles.slice(from).map((cycle, i) => ({ cycle, rate: dailyRate(values[from + i], cycle) })).map((p) => ({ month: p.cycle, rate: p.rate }));
    if (series.length < MIN_CI_MONTHS) {
      return fail(`Only ${series.length} reported months; an interval needs ${MIN_CI_MONTHS}.`);
    }
    const iterations = cap(args.iterations, 50, 2000, 500);

    const estimate = (rows: readonly MonthlyRate[]): number | null => {
      switch (args.quantity) {
        case "mean_daily_rate":
          return mean(rows.map((r) => r.rate));
        case "trend_slope":
          return linearFit(rows.map((r, i) => [i, r.rate] as const))?.slope ?? null;
        case "decline_di":
          return fitDecline(rows as MonthlyRate[])?.Di ?? null;
        case "decline_b":
          return fitDecline(rows as MonthlyRate[])?.b ?? null;
      }
    };

    const point = estimate(series);
    if (point === null) {
      return fail(`${args.quantity} could not be estimated on the observed series, so there is nothing to put an interval around.`);
    }

    // A MOVING-BLOCK bootstrap, not an i.i.d. one. Production months are not
    // exchangeable: shuffling them destroys the decline the fit is measuring.
    // Blocks preserve local shape, and the original cycle labels are reapplied
    // in order so every resample is a series a fit can read.
    const rnd = seeded(args.seed);
    const blocks = Math.ceil(series.length / BLOCK_MONTHS);
    const draws: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const rebuilt: number[] = [];
      for (let b = 0; b < blocks; b++) {
        const start = Math.floor(rnd() * Math.max(1, series.length - BLOCK_MONTHS));
        for (let k = 0; k < BLOCK_MONTHS && rebuilt.length < series.length; k++) {
          rebuilt.push(series[Math.min(series.length - 1, start + k)].rate);
        }
      }
      const sample = series.map((s, k) => ({ month: s.month, rate: rebuilt[k] }));
      const value = estimate(sample);
      if (value !== null && Number.isFinite(value)) draws.push(value);
    }
    draws.sort((a, b) => a - b);

    return {
      ok: true as const,
      entity: resolved.label,
      stream: which,
      quantity: args.quantity,
      reported_through: resolved.reportedThrough,
      n_months: series.length,
      estimate: point,
      p05: percentile(draws, 0.05),
      p50: percentile(draws, 0.5),
      p95: percentile(draws, 0.95),
      converged_draws: draws.length,
      iterations,
      seed: args.seed,
      block_months: BLOCK_MONTHS,
      notes: [
        "Moving-block bootstrap over reported months: blocks keep the local shape of the curve, which an ordinary resample would destroy.",
        "The interval measures sampling variability in this history alone. It says nothing about whether the model is the right one, and a wide interval on a bad model is still a bad model.",
        "Deterministic in the seed: the same seed returns the same interval, and a different seed returns a different one.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 144

const reportingReliability = defineTool(
  "rrc_reporting_reliability",
  "Per-operator filing reliability: unfiled lease-months, how fast the recent cycles fill in, permit amendments and H-15 delinquency.",
  { operator_no: z.string(), months: z.number().int().optional() },
  async ({ operator_no, months }) => {
    const op = operator_no.trim();
    if (!op) return fail("operator_no is required.");
    const window = cap(months, 24, 120, 48);

    const [edge, rows, dossier, permits] = await Promise.all([
      getCycleEdge(),
      operatorFilingRows(op, window),
      getOperatorDossier(op),
      listPermits({ operatorNo: op, limit: 500 }),
    ]);
    if (!dossier) return fail(`No operator ${op}.`);
    if (rows.length < MIN_LAG_HISTORY) {
      return fail(`Only ${rows.length} cycles on file for ${op}; a reliability score needs ${MIN_LAG_HISTORY}.`);
    }

    const withAge = rows.map((r) => ({ ...r, age: monthsBetween(r.cycle, edge.loaded) }));
    const settled = withAge.filter((r) => r.age >= MATURE_AGE_MONTHS);
    const settledLeaseMonths = sum(settled.map((r) => r.leases));
    const settledFiled = sum(settled.map((r) => r.filed));
    const unfiledShare = settledLeaseMonths > 0 ? 1 - settledFiled / settledLeaseMonths : null;

    const baseline = median(settled.map((r) => r.filed)) ?? 0;
    const atAge = (age: number) => {
      const row = withAge.find((r) => r.age === age);
      return row && baseline > 0 ? Math.min(1, row.filed / baseline) : null;
    };
    const completenessAt3 = atAge(3);

    const amended = permits.filter((p) => {
      const seq = Number(p.permit_seq);
      return Number.isFinite(seq) && seq < 99;
    }).length;
    const amendmentRate = permits.length ? amended / permits.length : null;

    const h15 = dossier.h15;
    const delinquentShare = h15.wellsTested > 0 ? h15.delinquent / h15.wellsTested : null;

    // Asserted weights, stated in the open. rrc_operator_survival is the fitted
    // counterpart; nothing here pretends this composite was estimated.
    const components = [
      { component: "settled months filed", weight: 0.4, value: unfiledShare == null ? null : 1 - unfiledShare },
      { component: "three-month completeness", weight: 0.3, value: completenessAt3 },
      { component: "permits without amendment", weight: 0.15, value: amendmentRate == null ? null : 1 - amendmentRate },
      { component: "H-15 not delinquent", weight: 0.15, value: delinquentShare == null ? null : 1 - delinquentShare },
    ];
    const scored = components.filter((c) => c.value != null);
    const weight = sum(scored.map((c) => c.weight));
    const score = weight > 0 ? (sum(scored.map((c) => c.weight * (c.value as number))) / weight) * 100 : null;

    return {
      ok: true as const,
      operator_no: op,
      operator_name: dossier.record.operator_name,
      loaded_through: edge.loaded,
      window_months: window,
      score,
      components,
      components_missing: components.filter((c) => c.value == null).map((c) => c.component),
      detail: {
        settled_lease_months: settledLeaseMonths,
        settled_filed: settledFiled,
        unfiled_share: unfiledShare,
        completeness_by_age: [0, 1, 2, 3, 6].map((age) => ({ age_months: age, completeness: atAge(age) })),
        permits_considered: permits.length,
        permits_amended: amended,
        amendment_rate: amendmentRate,
        h15_wells_tested: h15.wellsTested,
        h15_delinquent: h15.delinquent,
      },
      truncated: permits.length >= 500,
      notes: [
        "The weights are ASSERTED, not fitted, and they are printed so a reader can disagree with them. rrc_operator_survival is the fitted view of the same question.",
        "An amendment on a permit is often routine (a corrected location, a deeper target) and is a data-quality signal rather than a misconduct signal.",
        "A small operator scores on very few lease-months, so read `settled_lease_months` before acting on the score.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 145

const recoveryProxy = defineTool(
  "rrc_recovery_proxy",
  "Rough cumulative oil per acre-foot for a field, from permitted tract acres and perforated interval. Labelled rough on every call.",
  { field_no: z.string(), sample_limit: z.number().int().optional() },
  async ({ field_no, sample_limit }) => {
    const fieldNo = field_no.trim();
    if (!fieldNo) return fail("field_no is required.");
    const sampleCap = cap(sample_limit, 10, 200, 100);

    const [profile, reports] = await Promise.all([
      getFieldProfile(fieldNo, 12),
      rrcQuery<{ api_no: string | null; total_acres: string | null }>(
        `select c.api_no, c.total_acres
           from rrc.completion c
          where c.field_no = $1 and nullif(btrim(c.total_acres), '') is not null
          order by c.approved_dt desc nulls last
          limit $2`,
        [fieldNo, sampleCap]
      ),
    ]);
    if (!profile) return fail(`No field ${fieldNo}.`);
    if (reports.length < 5) {
      return fail(`Only ${reports.length} completion report(s) in field ${fieldNo} state tract acres; this proxy needs 5.`);
    }

    const apis = reports.map((r) => (r.api_no ?? "").trim()).filter(Boolean);
    const [perfs, fleet] = await Promise.all([
      rrcQuery<{ api_number: string; top_ft: number | null; bottom_ft: number | null }>(
        `select api_number, min(top_ft) as top_ft, max(bottom_ft) as bottom_ft
           from rrc.wb_perf
          where api_number = any($1::bpchar[]) and top_ft > 0
          group by api_number`,
        [apis]
      ),
      rrcQuery<{ wells: number }>(
        `select count(distinct api_number)::int as wells
           from rrc.wellbore
          where field_number = $1 and on_schedule = 'Y'`,
        [fieldNo]
      ),
    ]);
    const perfBy = new Map(perfs.map((p) => [p.api_number.trim(), p]));

    const sample = reports
      .map((r) => {
        const api = (r.api_no ?? "").trim();
        const acres = Number((r.total_acres ?? "").replace(/[^0-9.]/g, ""));
        const perf = perfBy.get(api);
        const pay = perf?.top_ft != null && perf?.bottom_ft != null ? perf.bottom_ft - perf.top_ft : null;
        return {
          api_number: api,
          acres: Number.isFinite(acres) && acres > 0 ? acres : null,
          gross_pay_ft: pay != null && pay > 0 ? pay : null,
        };
      })
      .filter((s) => s.acres != null && s.gross_pay_ft != null);
    if (sample.length < 5) {
      return fail(`Only ${sample.length} well(s) in field ${fieldNo} carry both tract acres and a perforated interval.`);
    }

    const sampledAcreFeet = sum(sample.map((s) => (s.acres as number) * (s.gross_pay_ft as number)));
    const wells = fleet[0]?.wells ?? sample.length;
    // Scaled by well count because the sample is only the wells that filed a
    // completion report with acreage, which is a minority of any old field.
    const scaledAcreFeet = (sampledAcreFeet / sample.length) * Math.max(sample.length, wells);
    const cumulative = profile.lifetime.oil;

    return {
      ok: true as const,
      rough: true,
      basis: ESTIMATED,
      field_no: profile.field_no,
      field_name: profile.field_name,
      cumulative_oil_bbl: cumulative,
      cumulative_basis: FILED,
      wells_on_schedule: wells,
      sampled_wells: sample.length,
      median_acres: median(clean(sample.map((s) => s.acres))),
      median_gross_pay_ft: median(clean(sample.map((s) => s.gross_pay_ft))),
      sampled_acre_feet: sampledAcreFeet,
      estimated_field_acre_feet: scaledAcreFeet,
      bbl_per_acre_foot: scaledAcreFeet > 0 ? cumulative / scaledAcreFeet : null,
      truncated: reports.length >= sampleCap,
      notes: [
        "ROUGH BY CONSTRUCTION, and the label travels with the number. Four things are approximations: tract acres are what the operator stated on the permit rather than drained area, perforated interval is GROSS completed feet rather than net pay, the sample is only wells that filed a completion report with acreage, and overlapping tracts are counted once per well.",
        "Cumulative oil is filed and carries basis 'filed'. Acre-feet is estimated and carries basis 'estimated'. The ratio inherits the weaker of the two.",
        "The RRC publishes no lease boundaries and no porosity or saturation, so this is a screening comparison between fields, never a volumetric.",
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [
  nowcast,
  imputeGaps,
  massBalance,
  rollupReconcile,
  waterBalance,
  matchedPairs,
  attribution,
  outliers,
  wellSurvival,
  timeToWater,
  operatorSurvival,
  variogram,
  krige,
  residualMap,
  hotspots,
  analogSearch,
  declineClusters,
  seasonality,
  vintageCurves,
  leadLag,
  concentration,
  graphMetrics,
  uncertaintyCi,
  reportingReliability,
  recoveryProxy,
];
