import "server-only";

import { z } from "zod";

import { rrcQuery, rrcQueryOne } from "@/lib/scout/rrc-db";
import {
  findDisposal,
  findWells,
  getInjectionEdge,
  getWellInjection,
} from "@/lib/scout/rrc-queries";
import type { InjectionMonth, NearbyDisposal } from "@/lib/scout/rrc-types";
import { isDisposal } from "@/lib/scout/rrc-uic";
import { addMonths, daysInCycle, linearFit, sum } from "../math";
import { ENTITY_SHAPE, isError, resolveSeries, STREAMS, streamValues } from "../series";
import { defineTool, type RrcTool } from "../tool";

/**
 * Water: where it is legally allowed to go, where it went, and what it costs
 * when a well that takes it disappears.
 *
 * Three facts hold across every tool here and are attached to every result
 * rather than left in a comment, because each one is a wrong answer waiting to
 * happen if the reader does not have it:
 *
 *   1. H-10 FILING RUNS ABOUT A YEAR BEHIND, four times the production lag.
 *      A thin recent tail is late paperwork, not a well that stopped.
 *   2. A PERMIT IS A CEILING, NOT AN OFFER. Whether an operator will take your
 *      water and at what price is commercial, and the state record is silent.
 *   3. NO REPORTED VOLUME IS NOT ZERO VOLUME. It is new, idle, or late, and
 *      those three are not separable from the file.
 */

const LATE_FILING = (edge: string) =>
  `H-10 filing runs about a year behind. Everything here is measured through ${edge}; a thin recent tail is late filing, not a well that stopped.`;

const CEILING_NOT_OFFER =
  "Permitted volume is a legal ceiling, not an offer. Whether a well will accept your water, and at what price, is commercial and the public record says nothing about it.";

const NULL_IS_NOT_ZERO =
  "A well with no reported volume may be new, idle, or simply late filing. It is not counted as zero.";

/** Radius argument, shared by the four area tools. */
const AREA_SHAPE = {
  lat: z.number(),
  lon: z.number(),
  radius_mi: z.number().optional(),
  limit: z.number().int().optional(),
};

/**
 * Only disposal, spelled out here as well as in SQL.
 *
 * `findDisposal` already filters `inj_type in ('1','2')`, so this is redundant
 * against today's query. It stays because every number below is a "where can
 * this water GO" number, and type 3 injection goes back into a producing zone:
 * if that filter ever loosens, headroom silently doubles and nobody sees it.
 */
function disposalOnly(rows: NearbyDisposal[]): NearbyDisposal[] {
  return rows.filter((r) => isDisposal(r.inj_type));
}

/**
 * Barrels per day over the `months` cycles ENDING AT THE REPORTING EDGE, or
 * null when the well filed none of them.
 *
 * The window is calendar months, not the last `months` filings wherever they
 * fall. Taking the latest filings instead would quote a well that stopped
 * filing in 2021 as if that were its current rate, and `findDisposal` would
 * report the same well as unmeasured: two numbers for one question, with the
 * larger one attached to the word "recent".
 *
 * The divisor is the days actually filed, not the days in the window, which is
 * the definition `ratePerDay` in rrc-queries uses: a well that filed three of
 * the twelve is not averaged as if it sat idle for nine.
 */
function ratePerDay(monthly: InjectionMonth[], edge: string, months = 12): number | null {
  const from = addMonths(edge, -(months - 1));
  const win = monthly.filter((m) => m.reported && m.cycle >= from && m.cycle <= edge);
  if (!win.length) return null;
  const days = sum(win.map((m) => daysInCycle(m.cycle)));
  return days > 0 ? sum(win.map((m) => m.bbl)) / days : null;
}

/** The wellhead, for the tools that start from an API rather than a point. */
async function wellPoint(api: string): Promise<{ lat: number; lon: number } | null> {
  const row = await rrcQueryOne<{ lat: number | null; lon: number | null }>(
    `select lat, lon from rrc.well_location where api_number = $1`,
    [api]
  );
  return row?.lat != null && row?.lon != null ? { lat: row.lat, lon: row.lon } : null;
}

// ------------------------------------------------------------------ 20

const injectionTrend = defineTool(
  "rrc_injection_trend",
  "H-10 injected volume over time for one well, with utilisation against the permitted ceiling and months to full at the current ramp.",
  { api: z.string(), months: z.number().int().optional() },
  async ({ api, months }) => {
    const key = api.trim();
    if (!key) return { ok: false as const, error: "api is required." };
    const inj = await getWellInjection(key);
    if (!inj) return { ok: false as const, error: `No UIC permit for ${key}.` };

    const window = Math.min(120, Math.max(3, Math.floor(months ?? 24)));
    const reported = inj.monthly.filter((m) => m.reported);
    const series = reported.slice(-window).map((m) => ({
      cycle: m.cycle,
      bbl: m.bbl,
      bbl_per_day: m.bbl / daysInCycle(m.cycle),
      avg_pressure: m.avg_pressure,
    }));

    const permitted = inj.permittedBblPerDay;
    const recent = ratePerDay(inj.monthly, inj.reportedThrough);
    // Null recent volume stays null. Zero utilisation would say "this well is
    // empty, send it your water", which is the most expensive wrong answer here.
    const utilisation =
      recent != null && permitted != null && permitted > 0 ? recent / permitted : null;

    const fit = linearFit(series.map((p, i) => [i, p.bbl_per_day] as const));
    const ramp = fit?.slope ?? null;
    const monthsToFull =
      ramp != null && ramp > 0 && permitted != null && recent != null
        ? Math.max(0, (permitted - recent) / ramp)
        : null;

    const live = inj.permits.filter((p) => p.live);
    return {
      ok: true as const,
      api: key,
      reported_through: inj.reportedThrough,
      live_permits: live.length,
      // Type 3 is waterflood injection into a producing zone. It has a ceiling
      // and a utilisation like any other permit, but it is not somewhere a third
      // party's water can go, so the distinction is on the result.
      is_disposal: live.some((p) => isDisposal(p.inj_type)),
      inj_types: [...new Set(live.map((p) => p.inj_type).filter(Boolean))],
      permitted_bbl_per_day: permitted,
      recent_bbl_per_day: recent,
      recent_window_months: 12,
      utilisation,
      ramp_bbl_per_day_per_month: ramp,
      ramp_r2: fit?.r2 ?? null,
      months_to_full: monthsToFull,
      months_to_full_note:
        monthsToFull == null
          ? "Not ramping, or the ceiling or the current rate is unknown."
          : "Straight-line extrapolation of the fitted ramp from the current rate. Not a forecast.",
      series,
      truncated: reported.length > series.length,
      notes: [LATE_FILING(inj.reportedThrough), CEILING_NOT_OFFER, NULL_IS_NOT_ZERO],
    };
  }
);

// ------------------------------------------------------------------ 21

const disposalHeadroom = defineTool(
  "rrc_disposal_headroom",
  "Permitted minus reported barrels per day across live disposal wells within a radius, with a commercial-only filter.",
  { ...AREA_SHAPE, commercial_only: z.boolean().optional() },
  async ({ lat, lon, radius_mi, commercial_only, limit }) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ok: false as const, error: "lat and lon are required." };
    }
    const cap = Math.min(200, Math.max(1, Math.floor(limit ?? 50)));
    const [edge, found] = await Promise.all([
      getInjectionEdge(),
      findDisposal({
        lat,
        lon,
        radiusMi: radius_mi,
        commercialOnly: commercial_only,
        limit: cap,
      }),
    ]);
    const rows = disposalOnly(found);

    const known = rows.filter((r) => r.max_bbl_per_day != null && r.recentBblPerDay != null);
    const unknown = rows.filter((r) => r.max_bbl_per_day == null || r.recentBblPerDay == null);

    const permitted = sum(known.map((r) => r.max_bbl_per_day));
    const used = sum(known.map((r) => r.recentBblPerDay));

    return {
      ok: true as const,
      center: { lat, lon },
      radius_mi: radius_mi ?? 25,
      commercial_only: Boolean(commercial_only),
      reported_through: edge.reported,
      wells: rows.length,
      wells_measured: known.length,
      permitted_bbl_per_day: permitted,
      reported_bbl_per_day: used,
      headroom_bbl_per_day: permitted - used,
      // Held out rather than folded in at zero use. Their permitted volume is
      // real; their spare capacity is unknown, and adding it would overstate
      // headroom by exactly the amount nobody can verify.
      unmeasured: unknown.map((r) => ({
        uic_no: r.uic_no,
        api_number: r.api_number,
        operator_name: r.operator_name,
        distance_mi: r.distance_mi,
        max_bbl_per_day: r.max_bbl_per_day,
        recent_bbl_per_day: r.recentBblPerDay,
      })),
      unmeasured_permitted_bbl_per_day: sum(unknown.map((r) => r.max_bbl_per_day)),
      wells_detail: known.map((r) => ({
        uic_no: r.uic_no,
        api_number: r.api_number,
        operator_name: r.operator_name,
        lease_name: r.lease_name,
        distance_mi: r.distance_mi,
        is_commercial: r.is_commercial,
        max_bbl_per_day: r.max_bbl_per_day,
        recent_bbl_per_day: r.recentBblPerDay,
        utilisation: r.utilisation,
        headroom_bbl_per_day: (r.max_bbl_per_day ?? 0) - (r.recentBblPerDay ?? 0),
      })),
      truncated: found.length >= cap,
      notes: [
        CEILING_NOT_OFFER,
        LATE_FILING(edge.reported),
        NULL_IS_NOT_ZERO,
        "Enhanced-recovery injection (type 3) is excluded: it goes back into a producing zone, not away.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 22

const DEFAULT_LAGS = [0, 1, 3, 6];
/** Below this a fit is noise, and reporting r for four points invites a story. */
const MIN_PAIRS = 6;

const injectionResponse = defineTool(
  "rrc_injection_response",
  "Correlate one injector's monthly volumes against offset production at several lags, for flood response or interference.",
  {
    injector_api: z.string(),
    ...ENTITY_SHAPE,
    stream: z.enum(STREAMS).optional(),
    lags: z.array(z.number().int()).optional(),
  },
  async (args) => {
    const key = args.injector_api.trim();
    if (!key) return { ok: false as const, error: "injector_api is required." };

    const inj = await getWellInjection(key);
    if (!inj) return { ok: false as const, error: `No UIC permit for ${key}.` };
    const series = await resolveSeries(args);
    if (isError(series)) return { ok: false as const, error: series.error };

    const stream = args.stream ?? "oil";
    const { cycles, values } = streamValues(series.points, stream);
    const production = new Map(cycles.map((c, i) => [c, values[i]]));
    const injected = inj.monthly.filter((m) => m.reported);

    const lags = (args.lags?.length ? args.lags : DEFAULT_LAGS)
      .filter((l) => Number.isInteger(l) && l >= 0 && l <= 24)
      .slice(0, 12);
    if (!lags.length) return { ok: false as const, error: "lags must be whole months 0 to 24." };

    const results = lags.map((lag) => {
      const pairs: (readonly [number, number])[] = [];
      for (const m of injected) {
        const y = production.get(addMonths(m.cycle, lag));
        if (y != null) pairs.push([m.bbl, y] as const);
      }
      const fit = linearFit(pairs);
      const r2 = fit?.r2 ?? null;
      return {
        lag_months: lag,
        n: pairs.length,
        // Sign comes from the slope: r2 alone cannot tell a flood response from
        // a well being pushed off.
        r: r2 == null || fit == null ? null : Math.sign(fit.slope) * Math.sqrt(r2),
        r2,
        slope_production_per_bbl_injected: fit?.slope ?? null,
        sufficient: pairs.length >= MIN_PAIRS,
      };
    });

    const usable = results.filter((r) => r.sufficient && r.r != null);
    const best = usable.length
      ? usable.reduce((a, b) => (Math.abs(b.r!) > Math.abs(a.r!) ? b : a))
      : null;

    return {
      ok: true as const,
      injector_api: key,
      offset: series.label,
      stream,
      injection_reported_through: inj.reportedThrough,
      production_reported_through: series.reportedThrough,
      overlap_months: results.find((r) => r.lag_months === 0)?.n ?? 0,
      by_lag: results,
      best_lag_months: best?.lag_months ?? null,
      best_r: best?.r ?? null,
      notes: [
        "Correlation, not causation. Injection and production move together for many reasons that are not connectivity: field-wide activity, price, operator behaviour, and the shared calendar itself.",
        "The lag is tested, not established. Reported here so a claimed response cannot hide which lag produced it.",
        LATE_FILING(inj.reportedThrough),
        `Production is lease-grain and lags about three months; injection lags about a year. The overlap window is shorter than either series.`,
      ],
    };
  }
);

// ------------------------------------------------------------------ 85

/**
 * Depth bands, feet of permitted injection bottom.
 *
 * The concern is injection into or near crystalline basement, which is what
 * gets a disposal well curtailed or shut by an RRC seismic-response area. The
 * file does NOT carry basement depth, and basement runs from a few thousand
 * feet in parts of the state to over twenty thousand in the Delaware. So this
 * is a SCREENING threshold, not a geologic finding: it says which wells are
 * worth checking against the local basement pick, not which ones are into it.
 */
const DEPTH_BANDS = [
  { band: "shallow", min: 0, max: 5000 },
  { band: "intermediate", min: 5000, max: 8000 },
  { band: "deep", min: 8000, max: 10000 },
  { band: "very deep", min: 10000, max: Infinity },
];
const DEEP_FT = 8000;

function bandOf(bottomFt: number | null): string {
  if (bottomFt == null) return "unknown";
  return DEPTH_BANDS.find((b) => bottomFt >= b.min && bottomFt < b.max)?.band ?? "unknown";
}

const seismicExposure = defineTool(
  "rrc_seismic_exposure",
  "Cumulative injected barrels by permitted depth band within a radius, flagging deep injection that carries curtailment risk.",
  { ...AREA_SHAPE, commercial_only: z.boolean().optional() },
  async ({ lat, lon, radius_mi, commercial_only, limit }) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ok: false as const, error: "lat and lon are required." };
    }
    const cap = Math.min(200, Math.max(1, Math.floor(limit ?? 50)));
    const [edge, found] = await Promise.all([
      getInjectionEdge(),
      findDisposal({
        lat,
        lon,
        radiusMi: radius_mi,
        commercialOnly: commercial_only,
        limit: cap,
      }),
    ]);
    const rows = disposalOnly(found);
    if (!rows.length) {
      return {
        ok: true as const,
        center: { lat, lon },
        radius_mi: radius_mi ?? 25,
        reported_through: edge.reported,
        wells: 0,
        by_band: [],
        truncated: false,
        notes: [LATE_FILING(edge.reported)],
      };
    }

    // Bounded by the permit list this radius already returned, so the (uic_no,
    // cycle) index is probed at most `cap` times. Never a scan of uic_h10.
    const totals = await rrcQuery<{ uic_no: string; bbl: number; first_cycle: string }>(
      `select uic_no,
              coalesce(sum(volume_bbl), 0)::bigint as bbl,
              to_char(min(cycle), 'YYYY-MM')       as first_cycle
         from rrc.uic_h10
        where uic_no = any($1)
          and cycle <= to_date($2, 'YYYY-MM')
        group by uic_no`,
      [rows.map((r) => r.uic_no), edge.reported]
    );
    const byId = new Map(totals.map((t) => [t.uic_no.trim(), t]));

    const wells = rows.map((r) => {
      const t = byId.get(r.uic_no.trim());
      return {
        uic_no: r.uic_no,
        api_number: r.api_number,
        operator_name: r.operator_name,
        lease_name: r.lease_name,
        distance_mi: r.distance_mi,
        is_commercial: r.is_commercial,
        top_inj_zone: r.top_inj_zone,
        bot_inj_zone: r.bot_inj_zone,
        band: bandOf(r.bot_inj_zone),
        deep: r.bot_inj_zone != null && r.bot_inj_zone >= DEEP_FT,
        cumulative_bbl: t?.bbl ?? null,
        first_reported: t?.first_cycle ?? null,
        max_bbl_per_day: r.max_bbl_per_day,
      };
    });

    const cumulative = sum(wells.map((w) => w.cumulative_bbl));
    const bands = [...DEPTH_BANDS.map((b) => b.band), "unknown"].map((band) => {
      const inBand = wells.filter((w) => w.band === band);
      return {
        band,
        depth_ft:
          band === "unknown"
            ? null
            : (() => {
                const b = DEPTH_BANDS.find((d) => d.band === band)!;
                return { from: b.min, to: Number.isFinite(b.max) ? b.max : null };
              })(),
        wells: inBand.length,
        cumulative_bbl: sum(inBand.map((w) => w.cumulative_bbl)),
        permitted_bbl_per_day: sum(inBand.map((w) => w.max_bbl_per_day)),
      };
    }).filter((b) => b.wells > 0);

    const deepBbl = sum(wells.filter((w) => w.deep).map((w) => w.cumulative_bbl));
    return {
      ok: true as const,
      center: { lat, lon },
      radius_mi: radius_mi ?? 25,
      commercial_only: Boolean(commercial_only),
      reported_through: edge.reported,
      wells: wells.length,
      cumulative_bbl: cumulative,
      deep_threshold_ft: DEEP_FT,
      deep_wells: wells.filter((w) => w.deep).length,
      deep_cumulative_bbl: deepBbl,
      deep_share: cumulative > 0 ? deepBbl / cumulative : null,
      by_band: bands,
      wells_detail: wells,
      truncated: found.length >= cap,
      notes: [
        `Depth is the PERMITTED injection bottom, not a measured one, and the mirror carries no basement pick. "Deep" here means at or below ${DEEP_FT} ft: a flag to check against the local basement depth and any RRC seismic-response area, not a finding that a well is injecting into basement.`,
        "Cumulative volume is every H-10 on file for these permits, so a long-lived well outranks a busy new one. That is the intended reading: induced seismicity tracks total mass injected, not this year's rate.",
        LATE_FILING(edge.reported),
        NULL_IS_NOT_ZERO,
      ],
    };
  }
);

// ------------------------------------------------------------------ 86

const pressureInterference = defineTool(
  "rrc_pressure_interference",
  "One injector's reported pressure and volume against offset producers whose completions overlap the injection interval.",
  {
    api: z.string(),
    radius_mi: z.number().optional(),
    well_type: z.string().optional(),
    limit: z.number().int().optional(),
    months: z.number().int().optional(),
  },
  async ({ api, radius_mi, well_type, limit, months }) => {
    const key = api.trim();
    if (!key) return { ok: false as const, error: "api is required." };
    const inj = await getWellInjection(key);
    if (!inj) return { ok: false as const, error: `No UIC permit for ${key}.` };
    const point = await wellPoint(key);
    if (!point) {
      return { ok: false as const, error: `No surface location on file for ${key}.` };
    }

    const live = inj.permits.filter((p) => p.live);
    const tops = live.map((p) => p.top_inj_zone).filter((n): n is number => n != null);
    const bots = live.map((p) => p.bot_inj_zone).filter((n): n is number => n != null);
    const top = tops.length ? Math.min(...tops) : null;
    const bot = bots.length ? Math.max(...bots) : null;

    const window = Math.min(60, Math.max(3, Math.floor(months ?? 24)));
    const series = inj.monthly
      .filter((m) => m.reported)
      .slice(-window)
      .map((m) => ({
        cycle: m.cycle,
        bbl: m.bbl,
        bbl_per_day: m.bbl / daysInCycle(m.cycle),
        avg_pressure: m.avg_pressure,
        max_pressure: m.max_pressure,
      }));
    const permittedPressure = live
      .map((p) => p.max_inj_pressure)
      .filter((n): n is number => n != null);
    const observedMax = Math.max(
      ...series.map((s) => s.max_pressure ?? Number.NEGATIVE_INFINITY)
    );

    const cap = Math.min(100, Math.max(1, Math.floor(limit ?? 25)));
    const radius = radius_mi ?? 1;
    const filter = well_type ?? "PRODUCING";
    const offsets = (
      await findWells({
        lat: point.lat,
        lon: point.lon,
        radiusMi: radius,
        wellType: filter,
        limit: cap,
      })
    ).filter((w) => w.api_number !== key);

    // Perforations belong to a FILING, not to a well, so a recompleted hole has
    // several sets. The union across filings is the right question here: has
    // this wellbore ever been open to the injection interval.
    const perfs = offsets.length
      ? await rrcQuery<{ api_number: string; top_ft: number | null; bottom_ft: number | null }>(
          `select api_number, min(top_ft) as top_ft, max(bottom_ft) as bottom_ft
             from rrc.wb_perf
            where api_number = any($1)
              and top_ft > 0
            group by api_number`,
          [offsets.map((w) => w.api_number)]
        )
      : [];
    const perfBy = new Map(perfs.map((p) => [p.api_number.trim(), p]));

    const rows = offsets.map((w) => {
      const p = perfBy.get(w.api_number.trim());
      const overlap =
        top != null && bot != null && p?.top_ft != null && p?.bottom_ft != null
          ? Math.max(0, Math.min(bot, p.bottom_ft) - Math.max(top, p.top_ft))
          : null;
      return {
        api_number: w.api_number,
        lease_name: w.lease_name,
        well_no: w.well_no,
        operator_name: w.operator_name,
        well_type: w.well_type_name,
        distance_mi: w.distance_mi,
        perf_top_ft: p?.top_ft ?? null,
        perf_bottom_ft: p?.bottom_ft ?? null,
        overlap_ft: overlap,
        same_interval: overlap != null ? overlap > 0 : null,
      };
    });
    rows.sort((a, b) => (a.distance_mi ?? 0) - (b.distance_mi ?? 0));

    return {
      ok: true as const,
      api: key,
      center: point,
      radius_mi: radius,
      well_type_filter: filter,
      reported_through: inj.reportedThrough,
      injection_interval_ft: { top, bottom: bot },
      permitted_max_pressure_psig: permittedPressure.length
        ? Math.max(...permittedPressure)
        : null,
      permitted_pressure_note: live.map((p) => p.max_inj_pressure_note).filter(Boolean)[0] ?? null,
      observed_max_pressure_psig: Number.isFinite(observedMax) ? observedMax : null,
      recent_bbl_per_day: ratePerDay(inj.monthly, inj.reportedThrough),
      permitted_bbl_per_day: inj.permittedBblPerDay,
      series,
      offsets: rows,
      offsets_same_interval: rows.filter((r) => r.same_interval === true).length,
      offsets_unknown_interval: rows.filter((r) => r.same_interval === null).length,
      truncated: offsets.length >= cap,
      notes: [
        "A shared interval is a hypothesis, not communication. Perforation depths and a permitted injection interval say the two wells are open to the same feet of section; they say nothing about permeability, faulting, or whether pressure actually travels.",
        "H-10 pressure is surface injection pressure as reported by the operator, monthly. It is not a bottomhole pressure and not a measured reservoir pressure.",
        top == null || bot == null
          ? "The permit carries no injection interval, so no overlap could be computed."
          : `Injection interval taken as the outer envelope of ${live.length} live permit(s).`,
        LATE_FILING(inj.reportedThrough),
      ],
    };
  }
);

// ------------------------------------------------------------------ 87

const disposalFragility = defineTool(
  "rrc_disposal_fragility",
  "Which disposal wells an area cannot afford to lose, ranked by the barrels per day that would have nowhere to go if each were removed.",
  { ...AREA_SHAPE, commercial_only: z.boolean().optional() },
  async ({ lat, lon, radius_mi, commercial_only, limit }) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ok: false as const, error: "lat and lon are required." };
    }
    const cap = Math.min(200, Math.max(1, Math.floor(limit ?? 50)));
    const [edge, found] = await Promise.all([
      getInjectionEdge(),
      findDisposal({
        lat,
        lon,
        radiusMi: radius_mi,
        commercialOnly: commercial_only,
        limit: cap,
      }),
    ]);
    const rows = disposalOnly(found);

    // Only wells whose reported volume is known can displace a known amount.
    // The rest are listed, not scored: "unknown" ranked as zero would put a
    // well that never files at the bottom of a risk list.
    const scored = rows.filter((r) => r.recentBblPerDay != null);
    const total = sum(scored.map((r) => r.recentBblPerDay));

    const ranked = scored
      .map((r) => {
        const displaced = r.recentBblPerDay!;
        // Spare capacity everywhere else, counting only wells where both the
        // ceiling and the current rate are known, and never counting a
        // negative (an over-permitted well does not lend capacity back).
        const elsewhere = rows
          .filter((o) => o.uic_no !== r.uic_no)
          .filter((o) => o.max_bbl_per_day != null && o.recentBblPerDay != null)
          .reduce((s, o) => s + Math.max(0, o.max_bbl_per_day! - o.recentBblPerDay!), 0);
        return {
          uic_no: r.uic_no,
          api_number: r.api_number,
          operator_name: r.operator_name,
          lease_name: r.lease_name,
          distance_mi: r.distance_mi,
          is_commercial: r.is_commercial,
          max_bbl_per_day: r.max_bbl_per_day,
          displaced_bbl_per_day: displaced,
          share_of_area: total > 0 ? displaced / total : null,
          remaining_headroom_bbl_per_day: elsewhere,
          shortfall_bbl_per_day: Math.max(0, displaced - elsewhere),
        };
      })
      .sort((a, b) => b.displaced_bbl_per_day - a.displaced_bbl_per_day);

    return {
      ok: true as const,
      center: { lat, lon },
      radius_mi: radius_mi ?? 25,
      commercial_only: Boolean(commercial_only),
      reported_through: edge.reported,
      wells: rows.length,
      wells_scored: scored.length,
      area_bbl_per_day: total,
      ranked,
      unscored: rows
        .filter((r) => r.recentBblPerDay == null)
        .map((r) => ({
          uic_no: r.uic_no,
          api_number: r.api_number,
          operator_name: r.operator_name,
          max_bbl_per_day: r.max_bbl_per_day,
        })),
      truncated: found.length >= cap,
      notes: [
        "Ranked by barrels currently going into each well: the volume that would need another home if it were curtailed, plugged, or closed to third parties.",
        "Remaining headroom is permitted minus reported across the OTHER wells in the radius. It is a paper number: see the ceiling caveat.",
        CEILING_NOT_OFFER,
        LATE_FILING(edge.reported),
        NULL_IS_NOT_ZERO,
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [
  injectionTrend,
  disposalHeadroom,
  injectionResponse,
  seismicExposure,
  pressureInterference,
  disposalFragility,
];
