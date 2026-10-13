import "server-only";

import { z } from "zod";

import { rrcQuery, rrcQueryOne } from "@/lib/scout/rrc-db";
import { toPdqDistrict } from "@/lib/scout/rrc-districts";
import {
  getOperatorDossier,
  getPipelines,
  getWellConstruction,
  getWellDossier,
} from "@/lib/scout/rrc-queries";
import type { LeaseMonth, WellConstruction } from "@/lib/scout/rrc-types";
import { distanceMiles, linearFit, mean, median, sum } from "../math";
import { offsetWellbores } from "../offsets";
import { defineTool, type RrcTool } from "../tool";

/**
 * Uphole recompletion: plugging back and shooting a shallower zone.
 *
 * A distinct workflow from drilling, and most of what kills a job here is
 * mechanical or regulatory rather than geological. Four rules hold across every
 * tool in this file, and each one is a confidently wrong answer waiting to be
 * produced:
 *
 *   1. NO COSTS. The RRC record carries no price, no AFE, no payout. The squeeze
 *      burden is COUNTED, never priced, and anything that would end in a dollar
 *      figure refuses instead.
 *   2. DEPTHS BELONG TO A FILING. Two filings on one hole were measured from
 *      whatever datum the operator used that year, and the elevation code is
 *      null on the majority of them. So perforations and casing are never merged
 *      across filings: a set at 2,000 to 2,100 on one filing and 5,000 to 5,100
 *      on another is NOT an open interval from 2,000 to 5,100, and treating it
 *      as one invents 2,900 ft of hole that was never shot.
 *   3. A NULL DEPTH IS NOT RECORDED. It is never zero, never surface, and never
 *      a reason to guess.
 *   4. `top_of_cement` IS FREE TEXT. Seven characters on the tape, holding
 *      "SURF", "CIRC", "2000 (E", "UNKNOWN" and worse. It is parsed only when it
 *      is unambiguous and refused otherwise, because a target above the cement
 *      top has no isolation and the job is a squeeze, not a recompletion.
 */

const NO_COSTS =
  "No cost, price or payout figure appears here and none can be derived: the RRC record carries none. Intervals are counted, not priced.";

const PER_FILING =
  "Perforations and casing are reported per FILING and are kept that way. Depths from two filings are not compared or merged, because each filing carries its own elevation and most carry no elevation code at all.";

const NULL_NOT_ZERO = "A null depth is not recorded. It is not zero.";

const LAG =
  "RRC production runs about three months behind. Unpublished cycles are excluded, never read as zeros.";

/** Tolerance when asking whether a formation top falls inside a shot interval. */
const DEFAULT_TOL_FT = 25;

// ------------------------------------------------------------------ parsing

/**
 * A depth in feet out of free text, refusing anything that is not plainly one.
 *
 * Deliberately stricter than the completion-report parser in `offsets.ts`, which
 * strips every non-digit and takes what is left. That is right for a formation
 * top written "9,550'". It is wrong here: it would turn "2000 (E" into 2000 and
 * "0 - SUR" into 0, and this file uses these numbers to decide whether a target
 * is isolated.
 */
function ft(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (!raw) return null;
  const t = raw.trim().replace(/[,'"]|\s+ft\.?$/gi, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Cement circulated to surface, spelled every way the tape spells it.
 *
 * An enumerated set rather than a prefix match, because the column is X(7) and
 * truncation makes prefixes lie: "SURF (C" and "SFC (CI" are surface, but
 * "CALC 60" starts nowhere useful and "GROUND" could be the head of anything.
 */
const SURFACE_TOC = new Set([
  "SURF", "SURF.", "SURFACE", "SFC", "SUR", "SRF", "SURFC",
  "CIRC", "CIRC.", "CIRCULATED", "CIRCULA",
]);

export type Toc =
  | { kind: "depth"; ft: number; raw: string }
  | { kind: "surface"; ft: 0; raw: string }
  | { kind: "unparsed"; ft: null; raw: string | null };

/** `top_of_cement` as one of three answers, the third of which is a refusal. */
function toc(raw: string | null): Toc {
  const t = (raw ?? "").trim().toUpperCase();
  if (!t) return { kind: "unparsed", ft: null, raw };
  if (SURFACE_TOC.has(t)) return { kind: "surface", ft: 0, raw: t };
  const d = ft(t);
  if (d != null) return { kind: "depth", ft: d, raw: t };
  return { kind: "unparsed", ft: null, raw: t };
}

// -------------------------------------------------------------- wellbore

/** The filings on a hole, newest first, or a refusal the model can act on. */
async function construction(
  api: string
): Promise<{ key: string; c: WellConstruction } | { error: string }> {
  const key = api.trim();
  if (!key) return { error: "api is required." };
  const c = await getWellConstruction(key);
  if (!c) return { error: `No Well Bore Database record for ${key}.` };
  return { key, c };
}

/** The operative filing: the newest one that actually describes the hole. */
function newestFiling(c: WellConstruction) {
  return (
    c.filings.find((f) => f.casing.length > 0 || f.perforations.length > 0) ??
    c.filings[0] ??
    null
  );
}

/**
 * Whether one depth was ever open, judged inside ONE filing at a time.
 *
 * The union across filings is the right question ("has this hole ever been shot
 * here"), but the union is taken over MEMBERSHIP, never over the intervals
 * themselves. Taking min(top) and max(bottom) across filings would answer yes
 * for every foot between two unrelated completions.
 */
function perforatedAt(c: WellConstruction, depthFt: number, tolFt: number): boolean {
  return c.filings.some((f) =>
    f.perforations.some(
      (p) =>
        p.top_ft != null &&
        p.bottom_ft != null &&
        depthFt >= p.top_ft - tolFt &&
        depthFt <= p.bottom_ft + tolFt
    )
  );
}

/** Each filing's own perforated envelope. One datum per row, by construction. */
function perfEnvelopes(c: WellConstruction) {
  return c.filings
    .map((f) => {
      const tops = f.perforations.map((p) => p.top_ft).filter((n): n is number => n != null);
      const bots = f.perforations.map((p) => p.bottom_ft).filter((n): n is number => n != null);
      return {
        file_date: f.file_date,
        elevation_ft: f.elevation,
        elevation_code: f.elevation_code,
        intervals: f.perforations.length,
        top_ft: tops.length ? Math.min(...tops) : null,
        bottom_ft: bots.length ? Math.max(...bots) : null,
        open_hole: f.perforations.some((p) => p.open_hole),
      };
    })
    .filter((e) => e.intervals > 0);
}

/** Are these filings even on one datum? Usually the honest answer is "unknown". */
function datum(c: WellConstruction) {
  const els = c.filings.map((f) => f.elevation).filter((n): n is number => n != null);
  const codes = [...new Set(c.filings.map((f) => f.elevation_code?.trim()).filter(Boolean))];
  const spread = els.length > 1 ? Math.max(...els) - Math.min(...els) : null;
  return {
    filings: c.filings.length,
    elevations_ft: [...new Set(els)],
    elevation_codes: codes,
    spread_ft: spread,
    /** True when more than one filing exists and they cannot be shown to share a datum. */
    mixed:
      c.filings.length > 1 && (els.length < c.filings.length || (spread ?? 0) > 0 || codes.length > 1),
  };
}

/** The interval a caller asked about, with a bottom that defaults to the top. */
function target(top: number, bottom?: number): { top: number; bottom: number } | null {
  if (!Number.isFinite(top) || top <= 0) return null;
  const b = bottom != null && Number.isFinite(bottom) && bottom > 0 ? bottom : top;
  return b >= top ? { top, bottom: b } : { top: b, bottom: top };
}

// -------------------------------------------------------- formation feeder

interface Penetration {
  api: string;
  formation: string;
  depthFt: number | null;
  isolated: string | null;
}

/**
 * What the bit went through, per wellbore, from the W-2 / G-1 formation record.
 *
 * ONE query for the whole fleet. `rrc.completion.api_no` is real `text`, so the
 * cast goes that way; `rrc.wb_*` keys on `character` and casts to `bpchar`.
 */
async function penetrations(apis: string[]): Promise<Map<string, Penetration[]>> {
  const out = new Map<string, Penetration[]>();
  if (!apis.length) return out;
  const rows = await rrcQuery<{
    api_no: string;
    formation: string | null;
    depth: string | null;
    depth_tmd: string | null;
    user_isolated: string | null;
  }>(
    `select c.api_no, cf.formation, cf.depth, cf.depth_tmd, cf.user_isolated
       from rrc.completion c
       join rrc.completion_formation cf on cf.tracking_no = c.tracking_no
      where c.api_no = any($1::text[])`,
    [apis]
  );
  for (const r of rows) {
    const name = r.formation?.trim();
    if (!name) continue;
    const api = r.api_no.trim();
    const list = out.get(api) ?? [];
    const depthFt = ft(r.depth) ?? ft(r.depth_tmd);
    // A hole with several completions re-reports the same tops on each packet.
    if (list.some((p) => p.formation === name && p.depthFt === depthFt)) continue;
    list.push({ api, formation: name, depthFt, isolated: r.user_isolated?.trim() || null });
    out.set(api, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a.depthFt ?? Infinity) - (b.depthFt ?? Infinity));
  }
  return out;
}

/** Perforations for a fleet, kept in their filings. */
async function fleetPerfs(apis: string[]) {
  const out = new Map<string, WellConstruction["filings"]>();
  if (!apis.length) return out;
  const rows = await rrcQuery<{
    api_number: string;
    file_date: string | null;
    top_ft: number | null;
    bottom_ft: number | null;
    open_hole_code: string | null;
  }>(
    `select api_number, to_char(file_date, 'YYYY-MM-DD') as file_date,
            top_ft, bottom_ft, open_hole_code
       from rrc.wb_perf
      where api_number = any($1::bpchar[])
      order by api_number, file_date desc nulls last, top_ft nulls last`,
    [apis]
  );
  for (const r of rows) {
    const api = r.api_number.trim();
    const list = out.get(api) ?? [];
    // A null file_date is its own bucket, not a reason to fold the row into the
    // newest filing: "which completion this belongs to is unrecorded" is a fact.
    const bucket =
      list.find((f) => f.file_date === r.file_date) ??
      (list.push({
        file_date: r.file_date,
        completion_date: null,
        plug_back_ft: null,
        elevation: null,
        elevation_code: null,
        casing: [],
        perforations: [],
      }),
      list[list.length - 1]);
    bucket.perforations.push({
      seq: null,
      top_ft: r.top_ft,
      bottom_ft: r.bottom_ft,
      open_hole: r.open_hole_code?.trim() === "OH",
    });
    out.set(api, list);
  }
  return out;
}

/** Formations penetrated and never shot, judged one filing at a time. */
function behindPipe(
  tops: Penetration[],
  filings: WellConstruction["filings"],
  tolFt: number
) {
  const c = { filings } as WellConstruction;
  const shallowest = perfEnvelopes(c)
    .map((e) => e.top_ft)
    .filter((n): n is number => n != null);
  const shallowestPerfTop = shallowest.length ? Math.min(...shallowest) : null;
  const zones = tops
    .filter((t) => t.depthFt != null && !perforatedAt(c, t.depthFt, tolFt))
    .map((t) => ({
      formation: t.formation,
      depth_ft: t.depthFt,
      isolated_per_operator: t.isolated,
      // The uphole question proper: is it above everything this hole was shot in.
      above_shallowest_perf: shallowestPerfTop != null && t.depthFt! < shallowestPerfTop,
    }));
  return {
    shallowest_perf_top_ft: shallowestPerfTop,
    unrecorded_depth_zones: tops.filter((t) => t.depthFt == null).map((t) => t.formation),
    zones,
  };
}

// ------------------------------------------------------------------ 109

/**
 * How many wellbores one call will EXAMINE, and where these two numbers come
 * from.
 *
 * The old default was 25, sliced off the head of the operator's well list BEFORE
 * anything was screened, so "25 of 288 wells examined, truncated" was a sample
 * presenting itself as a screen of the fleet. The cap was never a cost decision:
 * the per-well work is two batched reads over an api array, not a round trip per
 * hole. Measured against the live mirror on 2026-08-11, the pair ran 35 to 60 ms
 * over a real 2,000-well operator fleet, and 1.4 s over the 2,000 Texas wells
 * carrying the MOST completion-report formation rows (493,365 rows returned,
 * which is the densest population these two queries can be handed). Both sit
 * inside the pool's 5 s statement timeout, so `rrcQuerySlow` is not needed here.
 *
 * The ceiling is `OPERATOR_WELL_CAP`. Past 2,000 the dossier itself hands back a
 * PAGE of the fleet, and screening a page is the same defect one layer down. A
 * fleet larger than the cap is REFUSED rather than sampled.
 */
const DEFAULT_FLEET_CAP = 500;
const MAX_FLEET_CAP = 2000;

/**
 * Rows in the ranked list.
 *
 * Applied after the screen, never before it: every count on the result is over
 * everything examined and only the listing is shortened, which is the opposite
 * of what the old `limit` did.
 */
const MAX_LISTED = 100;

const upholeInventory = defineTool(
  "rrc_uphole_inventory",
  "Which of these holes has pay behind pipe? Ranks wellbores by formations the hole penetrated and never perforated, for one well, an explicit api list from rrc_well_screen, or an operator's whole fleet. A fleet larger than the cap is refused rather than sampled.",
  {
    operator_no: z.string().optional(),
    api: z.string().optional(),
    apis: z.array(z.string()).optional(),
    limit: z.number().int().optional(),
    tolerance_ft: z.number().optional(),
    radius_mi: z.number().optional(),
  },
  async ({ operator_no, api, apis: supplied, limit, tolerance_ft, radius_mi }) => {
    const one = api?.trim();
    const op = operator_no?.trim();
    const given = [...new Set((supplied ?? []).map((a) => a.trim()).filter(Boolean))];
    if (!one && !op && !given.length) {
      return {
        ok: false as const,
        error:
          "Give an api for one hole, apis for a population that a screen already produced, or an operator_no for a fleet.",
      };
    }
    const tol = Math.min(500, Math.max(0, tolerance_ft ?? DEFAULT_TOL_FT));
    const cap = Math.min(MAX_FLEET_CAP, Math.max(1, Math.floor(limit ?? DEFAULT_FLEET_CAP)));

    let apis: string[];
    let fleet = new Map<string, { lease: string | null; well: string | null; plugged: string | null }>();
    let total = 0;
    let mode: "well" | "supplied" | "operator";
    if (given.length) {
      // A supplied list IS the population. It came out of `rrc_well_screen`,
      // which already applied the county, depth and perforation-state cut and
      // reported its own true match count, so cutting it again here would
      // silently discard the part of the screen the caller chose to keep. Only
      // the hard ceiling applies, and it refuses rather than trimming.
      if (given.length > MAX_FLEET_CAP) {
        return {
          ok: false as const,
          error: `${given.length.toLocaleString()} apis supplied and this tool examines at most ${MAX_FLEET_CAP.toLocaleString()} in one call. Split the list into batches of ${MAX_FLEET_CAP.toLocaleString()} and call once per batch: each batch is complete on its own, so nothing is sampled.`,
          fleet_total: given.length,
          examined: 0,
          is_complete: false,
        };
      }
      apis = given;
      total = given.length;
      mode = "supplied";
    } else if (one) {
      apis = [one];
      total = 1;
      mode = "well";
    } else {
      const dossier = await getOperatorDossier(op!);
      if (!dossier) return { ok: false as const, error: `No operator ${op}.` };
      // The fleet size off the aggregate, never off the list: that list is
      // capped, and reading its length would report a 2,000-well ceiling as an
      // operator's whole fleet.
      total = dossier.wells.total;
      // The refusal this tool exists to make. "Which of their wells have pay
      // behind pipe" is a question about the fleet, and answering it from the
      // first `cap` rows of a well list is an arbitrary subset wearing a ranked
      // list's clothes. A caller who reads past a `truncated` flag acts on the
      // ranking; a caller handed no ranking at all cannot.
      if (total > cap) {
        const narrow =
          total <= MAX_FLEET_CAP
            ? `Or pass limit: ${total} to examine the whole fleet in one call.`
            : `The fleet is above this tool's ceiling of ${MAX_FLEET_CAP.toLocaleString()} wellbores per call, so raising limit will not reach it: it has to be cut by county, field or depth first.`;
        return {
          ok: false as const,
          error: `Operator ${op} holds ${total.toLocaleString()} wellbores and this call would examine ${cap.toLocaleString()}. Screening ${cap.toLocaleString()} of ${total.toLocaleString()} and ranking them would be a SAMPLE reported as a screen, so it is refused rather than returned. Narrow the population first: rrc_well_screen takes a depth window plus a county, district, field or bbox and returns an api list with the true match count, and that list goes straight into \`apis\` here. ${narrow}`,
          operator_no: op,
          fleet_total: total,
          examined: 0,
          is_complete: false,
        };
      }
      // Deduplicated, because a hole carries a well row per lease and field it
      // has been assigned to and `examined` has to count WELLBORES to be
      // comparable with the aggregate fleet count beside it.
      apis = [...new Set(dossier.wellRows.map((w) => w.api_number.trim()))];
      fleet = new Map(
        dossier.wellRows.map((w) => [
          w.api_number.trim(),
          { lease: w.lease_name, well: w.well_no, plugged: w.plug_date },
        ])
      );
      mode = "operator";
    }

    const [tops, perfs] = await Promise.all([penetrations(apis), fleetPerfs(apis)]);

    const wells = apis
      .map((a) => {
        const found = behindPipe(tops.get(a) ?? [], perfs.get(a) ?? [], tol);
        const meta = fleet.get(a);
        return {
          api_number: a,
          lease_name: meta?.lease ?? null,
          well_no: meta?.well ?? null,
          plug_date: meta?.plugged ?? null,
          formations_penetrated: (tops.get(a) ?? []).length,
          perforation_filings: (perfs.get(a) ?? []).length,
          ...found,
          behind_pipe_count: found.zones.length,
          uphole_count: found.zones.filter((z) => z.above_shallowest_perf).length,
        };
      })
      .sort((a, b) => b.uphole_count - a.uphole_count || b.behind_pipe_count - a.behind_pipe_count);

    // The offset cross-reference is single-well only: it is a radius query per
    // hole, and running it across a fleet is N round trips inside a user's wait.
    let offsetProof: unknown = null;
    if (one) {
      const point = await rrcQueryOne<{ lat: number | null; lon: number | null }>(
        `select lat, lon from rrc.well_location where api_number = $1`,
        [one]
      );
      if (point?.lat != null && point.lon != null) {
        const radius = Math.min(25, Math.max(0.25, radius_mi ?? 2));
        const { wells: offs } = await offsetWellbores({
          lat: point.lat,
          lon: point.lon,
          radiusMi: radius,
          limit: 50,
        });
        const names = new Set(wells[0]?.zones.map((z) => z.formation.toUpperCase()) ?? []);
        offsetProof = {
          radius_mi: radius,
          offsets: offs.length,
          // Each offset is judged ENTIRELY inside its own record: its own
          // formation top against its own perforations. No depth from this well
          // is ever compared with a depth from that one.
          by_formation: [...names].map((name) => {
            const hits = offs.filter((w) =>
              w.formationTops.some(
                (t) =>
                  t.formation.toUpperCase() === name &&
                  t.depthFt != null &&
                  w.perforations.some(
                    (p) =>
                      p.topFt != null &&
                      p.bottomFt != null &&
                      t.depthFt! >= p.topFt - tol &&
                      t.depthFt! <= p.bottomFt + tol
                  )
              )
            );
            return {
              formation: name,
              offsets_completed_in_zone: hits.length,
              nearest_mi: hits.length ? Math.min(...hits.map((h) => h.distanceMi)) : null,
              apis: hits.slice(0, 10).map((h) => h.api_number),
            };
          }),
        };
      }
    }

    // The listing is a ranking of a COMPLETE screen, so the counts beside it are
    // taken over every well examined rather than over the rows that fit.
    const listed = wells.slice(0, MAX_LISTED);
    const examined = apis.length;
    const complete = examined >= total;

    return {
      ok: true as const,
      mode,
      population_source:
        mode === "supplied"
          ? "the api list the caller supplied, examined in full"
          : mode === "operator"
            ? "the operator's whole fleet"
            : "one wellbore",
      operator_no: op ?? null,
      tolerance_ft: tol,
      /** The population this answer is about. */
      fleet_total: total,
      /** How many of it were actually screened. */
      examined,
      /** False means this is not an answer about the population. */
      is_complete: complete,
      wells_with_behind_pipe: wells.filter((w) => w.behind_pipe_count > 0).length,
      wells_with_uphole_zone: wells.filter((w) => w.uphole_count > 0).length,
      wells_listed: listed.length,
      wells: listed,
      offset_cross_reference: offsetProof,
      notes: [
        ...(complete
          ? []
          : [
              `ONLY ${examined} OF ${total} WELLS WERE SCREENED. The operator's aggregate well count is larger than the well list the dossier returned, so this is not an answer about the whole fleet: quote it as ${examined} wells, not as the operator's.`,
            ]),
        ...(listed.length < wells.length
          ? [
              `All ${examined} wells were screened and every count above is over all of them. The list is the top ${listed.length} by uphole zones, which is a ranking of a complete screen rather than a sample of the fleet.`,
            ]
          : []),
        "Behind-pipe means a formation top on the W-2 / G-1 record that no perforated interval covers. It is a SCREENING list: the state record says the bit went through it, not that it holds pay.",
        "The two sources are different filings. `rrc.completion` carries no elevation at all, so a formation top and a perforation depth on the same hole cannot be datum-reconciled from this mirror. The tolerance band is what stands in for that, and it is a guess by design.",
        PER_FILING,
        NULL_NOT_ZERO,
        "Formation coverage is thin by source: about 79,000 of 1.37M wells have a completion report. An empty list on an old hole means no report was filed, not that nothing was penetrated.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 110

/** Water cut and GOR from the filed well tests, oldest first. */
function testTrend(
  tests: { test_date: string | null; daily_oil: number | null; daily_water: number | null; daily_gas: number | null; gas_oil_ratio: number | null }[]
) {
  const rows = [...tests].reverse().filter((t) => t.test_date);
  const cut = rows
    .map((t, i) => {
      const oil = t.daily_oil ?? 0;
      const water = t.daily_water ?? 0;
      return oil + water > 0 ? ([i, water / (oil + water)] as const) : null;
    })
    .filter((p): p is readonly [number, number] => p != null);
  const gor = rows
    .map((t, i) => {
      const r = t.gas_oil_ratio ?? ((t.daily_gas ?? 0) > 0 && (t.daily_oil ?? 0) > 0 ? t.daily_gas! / t.daily_oil! : null);
      return r != null && r > 0 ? ([i, r] as const) : null;
    })
    .filter((p): p is readonly [number, number] => p != null);
  return {
    tests: rows.length,
    first_test: rows[0]?.test_date ?? null,
    last_test: rows[rows.length - 1]?.test_date ?? null,
    water_cut_latest: cut.length ? cut[cut.length - 1][1] : null,
    water_cut_slope_per_test: linearFit(cut)?.slope ?? null,
    gor_latest: gor.length ? gor[gor.length - 1][1] : null,
    gor_slope_per_test: linearFit(gor)?.slope ?? null,
    latest_oil_bpd: rows[rows.length - 1]?.daily_oil ?? null,
  };
}

const abandonmentReason = defineTool(
  "rrc_zone_abandonment_reason",
  "Why did this zone quit, and does that reason make coming uphole a bad idea? Read from water cut, GOR, H-15 fluid level and workover filings.",
  { api: z.string() },
  async ({ api }) => {
    const key = api.trim();
    if (!key) return { ok: false as const, error: "api is required." };
    const well = await getWellDossier(key);
    if (!well) return { ok: false as const, error: `No wellbore ${key}.` };

    const trend = testTrend(well.w10);
    const h15 = well.h15.slice(0, 5).map((t) => ({
      test_date: t.test_date,
      status: t.status,
      test_type: t.test_type,
      fluid_method: t.fluid_method,
      mech_method: t.mech_method,
      top_of_fluid_ft: t.top_of_fluid,
    }));
    const filings = (well.construction?.filings ?? []).map((f) => ({
      file_date: f.file_date,
      completion_date: f.completion_date,
      perforation_intervals: f.perforations.length,
      casing_strings: f.casing.length,
    }));
    // Every filing after the first is a re-entry on the hole: a recompletion, a
    // deepening or a workover. The count is the mechanical-intervention history.
    const workovers = Math.max(0, filings.length - 1);

    const reported = well.production.filter((m) => m.reported);
    const recent = reported.slice(-12);
    const prior = reported.slice(-24, -12);
    const oilNow = sum(recent.map((m) => m.oil_prod_vol));
    const oilThen = sum(prior.map((m) => m.oil_prod_vol));

    const reasons: string[] = [];
    if (trend.water_cut_slope_per_test != null && trend.water_cut_slope_per_test > 0.01) {
      reasons.push(
        `Water cut is rising across the filed tests (${(trend.water_cut_slope_per_test * 100).toFixed(1)} points per test, latest ${trend.water_cut_latest != null ? (trend.water_cut_latest * 100).toFixed(0) : "?"}%). That is the zone watering out, which is a reservoir answer.`
      );
    }
    if (trend.gor_slope_per_test != null && trend.gor_slope_per_test > 0) {
      reasons.push("GOR is rising across the filed tests, consistent with pressure depletion or gas breakout.");
    }
    if (workovers >= 2) {
      reasons.push(`${workovers} filings after the original completion: this hole has been worked over repeatedly.`);
    }
    const fluid = well.h15.find((t) => t.top_of_fluid != null);
    if (fluid) {
      reasons.push(
        `H-15 reports a fluid level at ${fluid.top_of_fluid} ft on ${fluid.test_date ?? "an undated test"}. Standing fluid says the zone still feeds the hole and the lift or the tubing is what is not working.`
      );
    }
    if (well.plugging.length) {
      reasons.push(`${well.plugging.length} W-3 plugging job(s) on file: part of this hole is already cemented off.`);
    }

    const wateringOut = (trend.water_cut_slope_per_test ?? 0) > 0.01;
    const mechanical = Boolean(fluid) || (workovers >= 2 && !wateringOut);
    const verdict = wateringOut ? "reservoir" : mechanical ? "mechanical" : "unclear";

    return {
      ok: true as const,
      api: key,
      lease_name: well.header.lease_name,
      field_name: well.header.field_name,
      well_type: well.status?.well_type_name ?? null,
      shut_in_date: well.status?.wl_shut_in_date ?? well.status?.wb_shut_in_date ?? null,
      inactive_years: well.status?.curr_inact_yrs ?? null,
      verdict,
      reasons,
      test_trend: trend,
      h15_recent: h15,
      filings,
      workovers,
      lease_oil_last_12: oilNow,
      lease_oil_prior_12: oilThen,
      lease_oil_change: oilThen > 0 ? oilNow / oilThen - 1 : null,
      uphole_advised:
        verdict === "mechanical"
          ? false
          : verdict === "reservoir"
            ? true
            : null,
      uphole_note:
        verdict === "mechanical"
          ? "THIS READS MECHANICAL. If the zone still feeds the hole and the problem is the pump, the rods, the tubing or a casing leak, coming up the hole is the WRONG answer: it abandons a zone that is not depleted and spends a rig on the wrong repair. Fix the well before you move it."
          : verdict === "reservoir"
            ? "The zone reads depleted or watered out on the filed tests, which is the case an uphole recompletion is for."
            : "The record does not separate a depleted zone from a broken well. Get a fluid level and a pressure survey before committing a rig.",
      notes: [
        "W-10 and G-10 tests are one day's rate filed to establish an allowable, not a monthly average. They are used here for their TREND, which is what they can honestly support.",
        "Texas reports oil per LEASE. The volumes here are the lease's, shared with every other well on it.",
        "There is no workover form in this mirror. `workovers` counts filings against the hole after the original completion, which is a floor, not a census.",
        LAG,
      ],
    };
  }
);

// ------------------------------------------------------------------ 111

const casingAtDepth = defineTool(
  "rrc_casing_at_depth",
  "Can I even perforate this interval, or is it open hole? Whether the target sits inside cased pipe, which string covers it, and at what weight and set depth.",
  { api: z.string(), top_ft: z.number(), bottom_ft: z.number().optional() },
  async ({ api, top_ft, bottom_ft }) => {
    const got = await construction(api);
    if ("error" in got) return { ok: false as const, error: got.error };
    const t = target(top_ft, bottom_ft);
    if (!t) return { ok: false as const, error: "top_ft must be a positive depth in feet." };

    const filing = newestFiling(got.c);
    if (!filing) return { ok: false as const, error: `No filings on ${got.key}.` };

    // The operative construction is the NEWEST filing's casing. Older filings are
    // reported beside it, never merged into it: a 1978 string and a 2019 string
    // are two different accounts of the hole, and the second one supersedes.
    const strings = filing.casing.map((s) => ({
      size_in: s.size_in,
      weight_lb_ft: s.weight_lb_ft,
      set_ft: s.depth_set,
      hole_size_in: s.hole_size_in,
      covers_target: s.depth_set != null && s.depth_set >= t.bottom,
    }));
    const covering = strings.filter((s) => s.covers_target);
    // The innermost pipe across the target is the shallowest-set string that
    // still reaches past it, which in a normal hole is also the smallest OD.
    const innermost = covering.length
      ? covering.reduce((a, b) => ((b.set_ft ?? Infinity) < (a.set_ft ?? Infinity) ? b : a))
      : null;
    const deepest = strings
      .map((s) => s.set_ft)
      .filter((n): n is number => n != null)
      .sort((a, b) => b - a)[0] ?? null;

    return {
      ok: true as const,
      api: got.key,
      target_ft: t,
      filing_date: filing.file_date,
      filing_elevation_ft: filing.elevation,
      filing_elevation_code: filing.elevation_code,
      cased: covering.length > 0 ? true : deepest != null ? false : null,
      innermost_string: innermost,
      strings,
      deepest_set_ft: deepest,
      open_hole_below_ft: deepest,
      total_depth_ft: got.c.total_depth,
      other_filings: got.c.filings
        .filter((f) => f !== filing)
        .map((f) => ({
          file_date: f.file_date,
          elevation_ft: f.elevation,
          casing_strings: f.casing.length,
          deepest_set_ft:
            f.casing.map((s) => s.depth_set).filter((n): n is number => n != null).sort((a, b) => b - a)[0] ??
            null,
        })),
      datum: datum(got.c),
      notes: [
        covering.length
          ? "A string set below the target means the target is inside pipe. It does not mean the pipe is sound: casing condition is not in the state record."
          : deepest != null
            ? `Nothing on this filing reaches ${t.bottom} ft. The deepest string is set at ${deepest} ft, so the target is below the shoe and in open hole.`
            : "No set depth is recorded on any string in this filing, so whether the target is cased cannot be answered.",
        "Casing here is the newest filing's account of the hole. Older filings are listed separately and NOT merged in.",
        PER_FILING,
        NULL_NOT_ZERO,
      ],
    };
  }
);

// ------------------------------------------------------------------ 112

const cementTopCheck = defineTool(
  "rrc_cement_top_check",
  "Is there cement behind the pipe at my target, or will I be shooting into an uncemented annulus? Refuses when the filed top-of-cement is free text rather than a depth.",
  { api: z.string(), top_ft: z.number(), bottom_ft: z.number().optional() },
  async ({ api, top_ft, bottom_ft }) => {
    const got = await construction(api);
    if ("error" in got) return { ok: false as const, error: got.error };
    const t = target(top_ft, bottom_ft);
    if (!t) return { ok: false as const, error: "top_ft must be a positive depth in feet." };

    const filing = newestFiling(got.c);
    if (!filing) return { ok: false as const, error: `No filings on ${got.key}.` };

    const strings = filing.casing.map((s) => {
      const parsed = toc(s.top_of_cement);
      return {
        size_in: s.size_in,
        set_ft: s.depth_set,
        top_of_cement_raw: s.top_of_cement,
        top_of_cement_kind: parsed.kind,
        top_of_cement_ft: parsed.ft,
        cement_amount: s.cement_amount,
        cement_measure: s.cement_measure,
        // Cement in the annulus covers the target only if the pipe reaches past
        // it AND the cement column starts above it.
        covers_target:
          s.depth_set != null && s.depth_set >= t.bottom && parsed.ft != null
            ? parsed.ft <= t.top
            : null,
      };
    });

    const governing = strings.filter((s) => s.set_ft != null && s.set_ft >= t.bottom);
    const unparsed = governing.filter((s) => s.top_of_cement_kind === "unparsed");
    const covering = governing.filter((s) => s.covers_target === true);

    // The refusal, and it is the whole point of this tool. `top_of_cement` is
    // X(7) free text: "SURF", "CIRC", "2000 (E", "UNKNOWN", "YES". Reading a
    // number out of the ones that merely start with digits would answer
    // "isolated" on a well nobody has isolated.
    const refused = covering.length === 0 && unparsed.length > 0;

    return {
      ok: true as const,
      api: got.key,
      target_ft: t,
      filing_date: filing.file_date,
      cemented: covering.length > 0 ? true : refused ? null : governing.length ? false : null,
      refused,
      refusal_reason: refused
        ? `The top of cement on the string(s) covering this target is filed as free text this tool will not read as a depth: ${unparsed.map((s) => JSON.stringify(s.top_of_cement_raw)).join(", ")}. Pull the cement record or run a bond log; do not assume isolation.`
        : null,
      governing_strings: governing.length,
      unparsed_values: unparsed.map((s) => s.top_of_cement_raw),
      strings,
      notes: [
        covering.length
          ? "Cement is filed above the target on a string set below it, so the interval reads isolated on paper. Paper is not a bond log."
          : governing.length && !refused
            ? "The cement column starts BELOW the target, so the target is above the top of cement. There is no annular isolation there: that job is a squeeze, not a recompletion."
            : "No string on this filing both reaches past the target and carries a readable cement top.",
        "`top_of_cement` is a seven-character free-text field in the source. Only a plain number, or one of a fixed set of surface codes (SURF, SURFACE, SFC, CIRC and their spellings), is read. Everything else refuses.",
        "Surface codes are read as a cement top of 0 ft, meaning cement circulated to surface.",
        PER_FILING,
      ],
    };
  }
);

// ------------------------------------------------------------------ 113

const plugbackFeasibility = defineTool(
  "rrc_plugback_feasibility",
  "Where do I set the plug to abandon the zone below? From filed plug-back depths, total depth and the current perforations.",
  { api: z.string(), target_top_ft: z.number().optional(), target_bottom_ft: z.number().optional() },
  async ({ api, target_top_ft, target_bottom_ft }) => {
    const got = await construction(api);
    if ("error" in got) return { ok: false as const, error: got.error };

    const envelopes = perfEnvelopes(got.c);
    const filing = newestFiling(got.c);
    const current = envelopes.find((e) => e.file_date === filing?.file_date) ?? envelopes[0] ?? null;
    const priorPlugBacks = got.c.filings
      .filter((f) => f.plug_back_ft != null)
      .map((f) => ({ file_date: f.file_date, plug_back_ft: f.plug_back_ft }));

    const t =
      target_top_ft != null ? target(target_top_ft, target_bottom_ft) : null;

    // The plug goes BELOW the new target and ABOVE the completion being
    // abandoned. Both ends come from the same filing, so this is one datum.
    const windowTop = t?.bottom ?? null;
    const windowBottom = current?.top_ft ?? null;
    const room =
      windowTop != null && windowBottom != null ? windowBottom - windowTop : null;

    return {
      ok: true as const,
      api: got.key,
      total_depth_ft: got.c.total_depth,
      current_completion: current,
      existing_plug_back_ft: filing?.plug_back_ft ?? null,
      prior_plug_backs: priorPlugBacks,
      target_ft: t,
      plug_window_ft: windowTop != null && windowBottom != null ? { top: windowTop, bottom: windowBottom } : null,
      room_ft: room,
      feasible: room == null ? null : room > 0,
      open_hole: current?.open_hole ?? false,
      notes: [
        room != null && room <= 0
          ? "The target overlaps or sits below the completion being abandoned. There is nowhere to set a plug between them, so this is not an uphole job."
          : room != null
            ? `About ${room} ft between the base of the target and the top of the completion below it. A cast-iron bridge plug plus a cement cap wants room; how much is a rig question, not a record question.`
            : "No target given, or the current completion has no recorded perforation top, so no window could be computed.",
        current?.open_hole
          ? "The lower completion is OPEN HOLE. There is no casing to set a plug in down there, and abandoning it means cement, not a bridge plug."
          : "A bridge plug has to land in casing. Check rrc_casing_at_depth at the intended setting depth before planning one.",
        got.c.total_depth != null
          ? "Total depth is the Well Bore Database's figure and the RRC does not revise it when a hole is deepened. Do not read a perforation below it as a contradiction."
          : "No total depth on record.",
        PER_FILING,
        NULL_NOT_ZERO,
      ],
    };
  }
);

// ------------------------------------------------------------------ 114

const squeezeBurden = defineTool(
  "rrc_squeeze_burden",
  "How much squeeze work stands between me and this zone? The existing perforated intervals sitting between the plug-back depth and the target that would have to be isolated.",
  {
    api: z.string(),
    target_top_ft: z.number(),
    target_bottom_ft: z.number().optional(),
    plug_back_ft: z.number().optional(),
  },
  async ({ api, target_top_ft, target_bottom_ft, plug_back_ft }) => {
    const got = await construction(api);
    if ("error" in got) return { ok: false as const, error: got.error };
    const t = target(target_top_ft, target_bottom_ft);
    if (!t) return { ok: false as const, error: "target_top_ft must be a positive depth in feet." };

    const filing = newestFiling(got.c);
    const floor =
      plug_back_ft != null && Number.isFinite(plug_back_ft) && plug_back_ft > 0
        ? plug_back_ft
        : filing?.plug_back_ft ?? got.c.total_depth ?? null;
    if (floor == null) {
      return {
        ok: false as const,
        error: `No plug-back depth or total depth on record for ${got.key}. Supply plug_back_ft to bound the count.`,
      };
    }
    if (floor <= t.bottom) {
      return {
        ok: false as const,
        error: `The plug-back depth (${floor} ft) is at or above the base of the target (${t.bottom} ft). Nothing lies between them to isolate.`,
      };
    }

    // Intervals BETWEEN the target and the plug-back floor. An interval counts
    // when any part of it falls in that band: a set straddling the boundary
    // still has to be squeezed.
    const between = got.c.filings.flatMap((f) =>
      f.perforations
        .filter(
          (p) =>
            p.top_ft != null &&
            p.bottom_ft != null &&
            p.bottom_ft > t.bottom &&
            p.top_ft < floor
        )
        .map((p) => ({
          file_date: f.file_date,
          top_ft: p.top_ft!,
          bottom_ft: p.bottom_ft!,
          open_hole: p.open_hole,
        }))
    );

    // Two filings routinely re-report the SAME interval, and counting it twice
    // doubles the burden. Deduplication is on an exact (top, bottom) match on
    // one hole, which compares nothing across datums: it recognises a repeated
    // row, it does not merge two different ones.
    const seen = new Set<string>();
    const distinct = between.filter((p) => {
      const k = `${p.top_ft}-${p.bottom_ft}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const byFiling = [...new Set(between.map((p) => p.file_date))].map((d) => ({
      file_date: d,
      intervals: between.filter((p) => p.file_date === d).length,
    }));

    return {
      ok: true as const,
      api: got.key,
      target_ft: t,
      plug_back_ft: floor,
      plug_back_source:
        plug_back_ft != null ? "supplied" : filing?.plug_back_ft != null ? "wb_filing" : "total_depth",
      intervals_to_isolate: distinct.length,
      feet_to_isolate: sum(distinct.map((p) => p.bottom_ft - p.top_ft)),
      intervals: distinct.sort((a, b) => a.top_ft - b.top_ft),
      rows_by_filing: byFiling,
      duplicate_rows_removed: between.length - distinct.length,
      open_hole_below: distinct.some((p) => p.open_hole),
      notes: [
        `${distinct.length} perforated interval(s) lie between ${t.bottom} ft and ${floor} ft. Each one is a set of holes in the pipe that has to be isolated before the target can be produced alone.`,
        distinct.some((p) => p.open_hole)
          ? "At least one of these is OPEN HOLE. Open hole cannot be squeezed shut: it is cemented off, which is a different and larger job."
          : "All of these are cased-hole perforations, which is the squeezable case.",
        NO_COSTS,
        PER_FILING,
        "An interval counts if any part of it falls in the band, including one straddling the boundary. Identical rows repeated across filings are counted once.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 115

/** "MM/DD/YYYY" on the completion tape, to a `YYYY-MM` cycle. */
function cycleOf(raw: string | null): string | null {
  const m = (raw ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}` : null;
}

/** Mean monthly oil and gas over the reported cycles inside a window. */
function windowRate(months: LeaseMonth[], from: string, to: string) {
  const win = months.filter((m) => m.reported && m.cycle >= from && m.cycle < to);
  return {
    months: win.length,
    oil_bbl_per_month: mean(win.map((m) => m.oil_prod_vol)),
    gas_mcf_per_month: mean(win.map((m) => m.gas_prod_vol)),
  };
}

function shiftCycle(cycle: string, months: number): string {
  const [y, m] = cycle.split("-").map(Number);
  const t = y * 12 + (m - 1) + months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

const upholeAnalogs = defineTool(
  "rrc_uphole_analogs",
  "Has anyone else made this exact move, field A up to field B? When they did it, what the rate did, and how many came back with nothing.",
  {
    from_field_no: z.string(),
    to_field_no: z.string(),
    limit: z.number().int().optional(),
    months: z.number().int().optional(),
  },
  async ({ from_field_no, to_field_no, limit, months }) => {
    const from = from_field_no.trim();
    const to = to_field_no.trim();
    if (!from || !to) return { ok: false as const, error: "from_field_no and to_field_no are required." };
    if (from === to) {
      return { ok: false as const, error: "from_field_no and to_field_no are the same field." };
    }
    const cap = Math.min(200, Math.max(1, Math.floor(limit ?? 50)));
    const win = Math.min(36, Math.max(3, Math.floor(months ?? 12)));

    const packets = await rrcQuery<{
      api_no: string;
      field_no: string;
      field_name: string | null;
      operator_no: string | null;
      cmpl_or_recmpl_date: string | null;
      lease_name: string | null;
      well_no: string | null;
    }>(
      `select api_no, field_no, field_name, operator_no,
              cmpl_or_recmpl_date, lease_name, well_no
         from rrc.completion
        where field_no = any($1)`,
      [[from, to]]
    );

    // A hole that filed in the deeper field and LATER filed in the shallower one
    // made the move. There is no recompletion flag in this mirror worth trusting
    // (`frmr_gas_id_or_oil_lse_no` is empty on all 214,337 packets), and the
    // field number is the RRC's own name for the reservoir, so the pair of
    // packets is the move.
    const byApi = new Map<string, typeof packets>();
    for (const p of packets) {
      const a = p.api_no?.trim();
      if (!a) continue;
      byApi.set(a, [...(byApi.get(a) ?? []), p]);
    }

    const moves: {
      api_number: string;
      operator_no: string | null;
      lease_name: string | null;
      well_no: string | null;
      from_cycle: string;
      to_cycle: string;
    }[] = [];
    for (const [a, rows] of byApi) {
      const f = rows
        .filter((r) => r.field_no === from)
        .map((r) => cycleOf(r.cmpl_or_recmpl_date))
        .filter((c): c is string => c != null)
        .sort();
      const t = rows
        .filter((r) => r.field_no === to)
        .map((r) => cycleOf(r.cmpl_or_recmpl_date))
        .filter((c): c is string => c != null)
        .sort();
      if (!f.length || !t.length) continue;
      const fromCycle = f[0];
      const toCycle = t.find((c) => c > fromCycle);
      if (!toCycle) continue;
      const row = rows.find((r) => r.field_no === to)!;
      moves.push({
        api_number: a,
        operator_no: row.operator_no?.trim() ?? null,
        lease_name: row.lease_name,
        well_no: row.well_no,
        from_cycle: fromCycle,
        to_cycle: toCycle,
      });
    }
    moves.sort((a, b) => b.to_cycle.localeCompare(a.to_cycle));
    const kept = moves.slice(0, cap);

    // Lease keys per field, so before and after are read off the right schedule.
    const wb = kept.length
      ? await rrcQuery<{
          api_number: string;
          oil_gas_code: string | null;
          district: string | null;
          lease_number: string | null;
          field_number: string | null;
        }>(
          `select api_number, oil_gas_code, district, lease_number, field_number
             from rrc.wellbore
            where api_number = any($1::bpchar[]) and field_number = any($2)`,
          [kept.map((m) => m.api_number), [from, to]]
        )
      : [];

    const keyOf = (r: (typeof wb)[number]) => {
      const pdq = toPdqDistrict(r.district?.trim() ?? null);
      if (!r.oil_gas_code || !pdq || !r.lease_number) return null;
      return { ogc: r.oil_gas_code.trim(), dist: pdq, lease: r.lease_number.trim() };
    };
    const keys = wb.map(keyOf).filter((k): k is NonNullable<typeof k> => k != null);
    const production = keys.length
      ? await rrcQuery<{
          oil_gas_code: string;
          district_no: string;
          lease_no: string;
          cycle: string;
          oil_prod_vol: number | null;
          gas_prod_vol: number | null;
        }>(
          `select lp.oil_gas_code, lp.district_no, lp.lease_no,
                  to_char(lp.cycle, 'YYYY-MM') as cycle,
                  lp.oil_prod_vol, lp.gas_prod_vol
             from rrc.lease_production lp
             join unnest($1::text[], $2::text[], $3::text[]) as k(ogc, dist, lease)
               on lp.oil_gas_code = k.ogc and lp.district_no = k.dist and lp.lease_no = k.lease`,
          [keys.map((k) => k.ogc), keys.map((k) => k.dist), keys.map((k) => k.lease)]
        )
      : [];

    const seriesFor = (ogc: string, dist: string, lease: string): LeaseMonth[] =>
      production
        .filter((p) => p.oil_gas_code.trim() === ogc && p.district_no.trim() === dist && p.lease_no.trim() === lease)
        .map((p) => ({
          cycle: p.cycle,
          oil_prod_vol: p.oil_prod_vol ?? 0,
          gas_prod_vol: p.gas_prod_vol ?? 0,
          // Only the two streams this tool reads are filled; the rest of the
          // LeaseMonth shape is not consulted here.
          reported: true,
        }) as LeaseMonth)
        .sort((a, b) => a.cycle.localeCompare(b.cycle));

    const analogs = kept.map((m) => {
      const fromRow = wb.find((r) => r.api_number.trim() === m.api_number && r.field_number?.trim() === from);
      const toRow = wb.find((r) => r.api_number.trim() === m.api_number && r.field_number?.trim() === to);
      const fk = fromRow ? keyOf(fromRow) : null;
      const tk = toRow ? keyOf(toRow) : null;
      const before = fk
        ? windowRate(seriesFor(fk.ogc, fk.dist, fk.lease), shiftCycle(m.to_cycle, -win), m.to_cycle)
        : null;
      const after = tk
        ? windowRate(seriesFor(tk.ogc, tk.dist, tk.lease), m.to_cycle, shiftCycle(m.to_cycle, win))
        : null;
      const failed =
        after != null && after.months > 0 && (after.oil_bbl_per_month ?? 0) <= 0 && (after.gas_mcf_per_month ?? 0) <= 0;
      return {
        api_number: m.api_number,
        operator_no: m.operator_no,
        lease_name: m.lease_name,
        well_no: m.well_no,
        moved_cycle: m.to_cycle,
        prior_completion_cycle: m.from_cycle,
        before,
        after,
        oil_delta_bbl_per_month:
          before?.oil_bbl_per_month != null && after?.oil_bbl_per_month != null
            ? after.oil_bbl_per_month - before.oil_bbl_per_month
            : null,
        gas_delta_mcf_per_month:
          before?.gas_mcf_per_month != null && after?.gas_mcf_per_month != null
            ? after.gas_mcf_per_month - before.gas_mcf_per_month
            : null,
        measurable: before != null && after != null && after.months > 0,
        failed,
      };
    });

    const measurable = analogs.filter((a) => a.measurable);
    const oilDeltas = measurable.map((a) => a.oil_delta_bbl_per_month).filter((n): n is number => n != null);
    const gasDeltas = measurable.map((a) => a.gas_delta_mcf_per_month).filter((n): n is number => n != null);

    return {
      ok: true as const,
      from_field_no: from,
      to_field_no: to,
      window_months: win,
      moves_found: moves.length,
      analogs,
      measurable: measurable.length,
      median_oil_delta_bbl_per_month: median(oilDeltas),
      median_gas_delta_mcf_per_month: median(gasDeltas),
      improved: oilDeltas.filter((d) => d > 0).length,
      failure_count: measurable.filter((a) => a.failed).length,
      failure_rate: measurable.length ? measurable.filter((a) => a.failed).length / measurable.length : null,
      truncated: moves.length > kept.length,
      notes: [
        "A move is a hole with a completion packet in the deeper field and a LATER one in the shallower field. That is what the mirror can see; there is no reliable recompletion flag on the tape.",
        "Before and after are LEASE volumes on two different schedules, shared with every other well on each lease. A single well's contribution is not separable, so read the delta as the lease's, not the wellbore's.",
        "A field number is the RRC's name for a reservoir, and the same rock carries several field numbers across the state. This pair is exactly the pair asked for, nothing broader.",
        NO_COSTS,
        LAG,
      ],
    };
  }
);

// ------------------------------------------------------------------ 116

const GAS_COMMODITY = /GAS/i;

/** Every coordinate in a GeoJSON geometry, however deeply nested. */
function coords(node: unknown, out: [number, number][] = []): [number, number][] {
  if (!Array.isArray(node)) return out;
  if (typeof node[0] === "number" && typeof node[1] === "number") {
    out.push([node[0] as number, node[1] as number]);
    return out;
  }
  for (const child of node) coords(child, out);
  return out;
}

const takeawayCheck = defineTool(
  "rrc_uphole_takeaway_check",
  "If this shallow zone comes in gassy, where does the gas go? Pipelines near the wellbore and whether the lease's gas is being taken at all today.",
  { api: z.string(), radius_mi: z.number().optional() },
  async ({ api, radius_mi }) => {
    const key = api.trim();
    if (!key) return { ok: false as const, error: "api is required." };
    const well = await getWellDossier(key);
    if (!well) return { ok: false as const, error: `No wellbore ${key}.` };
    const { lat, lon } = well.location;
    if (lat == null || lon == null) {
      return { ok: false as const, error: `No surface location on file for ${key}, so no distance to a line can be measured.` };
    }

    const radius = Math.min(25, Math.max(0.25, radius_mi ?? 5));
    const dLat = radius / 69.0;
    const dLon = radius / (69.0 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    const segments = await getPipelines(lon - dLon, lat - dLat, lon + dLon, lat + dLat, 0, 2000);

    const lines = segments
      .map((s) => {
        let nearest: number | null = null;
        try {
          const pts = coords(JSON.parse(s.geojson)?.coordinates);
          for (const [x, y] of pts) {
            const d = distanceMiles(lat, lon, y, x);
            if (nearest == null || d < nearest) nearest = d;
          }
        } catch {
          // A segment whose geometry will not parse has no measurable distance.
          nearest = null;
        }
        return {
          system_name: s.system_name,
          operator_name: s.operator_name,
          commodity: s.commodity_desc ?? s.commodity,
          diameter_in: s.diameter,
          status: s.status,
          distance_mi: nearest,
          gas: GAS_COMMODITY.test(s.commodity_desc ?? s.commodity ?? ""),
        };
      })
      .filter((l) => l.distance_mi != null && l.distance_mi <= radius)
      .sort((a, b) => (a.distance_mi ?? 0) - (b.distance_mi ?? 0));

    const gasLines = lines.filter((l) => l.gas);

    // A lease that produces gas but disposes of almost none of it is a lease
    // with nowhere to send it. Disposition is the RRC's own accounting of where
    // the volume went, so this is measured rather than assumed.
    const reported = well.production.filter((m) => m.reported).slice(-24);
    const gasProduced = sum(reported.map((m) => m.gas_prod_vol)) + sum(reported.map((m) => m.csgd_prod_vol));
    const gasDisposed = sum(reported.map((m) => m.gas_tot_disp)) + sum(reported.map((m) => m.csgd_tot_disp));

    return {
      ok: true as const,
      api: key,
      center: { lat, lon },
      radius_mi: radius,
      gas_lines_within_radius: gasLines.length,
      nearest_gas_line: gasLines[0] ?? null,
      largest_gas_line: gasLines.length
        ? gasLines.reduce((a, b) => ((b.diameter_in ?? 0) > (a.diameter_in ?? 0) ? b : a))
        : null,
      lines: lines.slice(0, 25),
      lease_gas_mcf_last_24: gasProduced,
      lease_gas_disposed_last_24: gasDisposed,
      lease_gas_disposed_share: gasProduced > 0 ? gasDisposed / gasProduced : null,
      takeaway:
        gasLines.length === 0
          ? "none_found"
          : gasProduced > 0 && gasDisposed / gasProduced < 0.5
            ? "line_present_lease_not_moving_gas"
            : "line_present",
      truncated: segments.length >= 2000,
      notes: [
        gasLines.length
          ? "A line on the map is not a connection and not a contract. Distance to the nearest gas segment says a tie-in is physically plausible; whether the operator of that system will take your gas, at what pressure and at what price, is commercial and the state record is silent on all three."
          : "No gas pipeline segment inside the radius. A recompletion into a shallower gassier zone here has nowhere to sell, which makes it a flare and a lease-use problem rather than revenue.",
        "Pipeline geometry is the RRC's public map layer, positioned to map accuracy, not survey accuracy.",
        "Disposition is the lease's, shared across every well on it, and gas disposition includes lease use and flaring, not only sales.",
        LAG,
      ],
    };
  }
);

// ------------------------------------------------------------------ 117

const regulatory = defineTool(
  "rrc_recompletion_regulatory",
  "What do I have to file to move this wellbore to another zone? Field rules, allowable basis, oil-to-gas reclassification, multiple completion and the form each one needs.",
  { api: z.string(), target_field_no: z.string().optional() },
  async ({ api, target_field_no }) => {
    const key = api.trim();
    if (!key) return { ok: false as const, error: "api is required." };
    const well = await getWellDossier(key);
    if (!well) return { ok: false as const, error: `No wellbore ${key}.` };

    const targetNo = target_field_no?.trim() || null;
    const currentNo = well.header.field_number?.trim() || null;
    const fields = await rrcQuery<{
      field_no: string;
      field_name: string | null;
      field_class: string | null;
      field_h2s_flag: string | null;
      wildcat_flag: string | null;
      o_derived_rule_type_code: string | null;
      g_derived_rule_type_code: string | null;
      o_discovery_dt: string | null;
      g_discovery_dt: string | null;
    }>(
      `select field_no, field_name, field_class, field_h2s_flag, wildcat_flag,
              o_derived_rule_type_code, g_derived_rule_type_code,
              o_discovery_dt, g_discovery_dt
         from rrc.field where field_no = any($1)`,
      [[currentNo, targetNo].filter(Boolean)]
    );
    const rec = (no: string | null) => (no ? fields.find((f) => f.field_no === no) ?? null : null);
    const cur = rec(currentNo);
    const tgt = rec(targetNo);
    if (targetNo && !tgt) return { ok: false as const, error: `No field ${targetNo} in the mirror.` };

    /** Which side of a field record is populated says whether it is oil or gas. */
    const sideOf = (f: typeof tgt) => {
      if (!f) return null;
      const oil = Boolean(f.o_derived_rule_type_code?.trim());
      const gas = Boolean(f.g_derived_rule_type_code?.trim());
      return oil && gas ? "both" : oil ? "O" : gas ? "G" : null;
    };

    const currentSide = well.header.oil_gas_code ?? null;
    const targetSide = sideOf(tgt);
    const fieldChanges = Boolean(targetNo && currentNo && targetNo !== currentNo);
    const reclass =
      fieldChanges && currentSide != null && targetSide != null && targetSide !== "both" && targetSide !== currentSide;

    const consequences: string[] = [];
    if (fieldChanges) {
      consequences.push(
        "NEW FIELD NUMBER. A different field is a different set of field rules and a different allowable formula. Nothing about the current allowable carries over."
      );
      consequences.push(
        "A new W-2 (oil) or G-1 (gas) completion report has to be filed for the new completion, with its own formation and casing record."
      );
    }
    if (reclass) {
      consequences.push(
        `RECLASSIFICATION from ${currentSide === "O" ? "oil" : "gas"} to ${targetSide === "O" ? "oil" : "gas"}. That issues a new ${targetSide === "G" ? "gas identification number" : "oil lease number"}, moves reporting to the other form, and changes the test the allowable is set from (W-10 for oil, G-10 for gas).`
      );
    }
    if (well.status?.multi_comp_flag?.trim() && well.status.multi_comp_flag.trim() !== "N") {
      consequences.push(
        `The hole already carries a multiple-completion flag (${well.status.multi_comp_flag.trim()}). Adding or dropping a completion changes that status and the commingling authority behind it.`
      );
    } else if (fieldChanges) {
      consequences.push(
        "If the lower zone stays open, this becomes a multiple completion and needs the RRC's approval for it. If the two zones share a wellbore stream, it needs commingling authority as well. Neither approval is in this mirror."
      );
    }
    if (tgt?.field_h2s_flag?.trim() === "Y") {
      consequences.push("The target field is flagged for H2S. That brings Rule 36 contingency planning and a different set of surface requirements.");
    }
    if (tgt?.wildcat_flag?.trim() === "Y") {
      consequences.push("The target is a wildcat field, so there are no established field rules to inherit.");
    }

    return {
      ok: true as const,
      api: key,
      current_field: cur
        ? { field_no: cur.field_no, field_name: cur.field_name, oil_gas_code: currentSide, rule_type_o: cur.o_derived_rule_type_code?.trim() || null, rule_type_g: cur.g_derived_rule_type_code?.trim() || null }
        : { field_no: currentNo, field_name: well.header.field_name, oil_gas_code: currentSide },
      target_field: tgt
        ? {
            field_no: tgt.field_no,
            field_name: tgt.field_name,
            field_class: tgt.field_class?.trim() || null,
            oil_gas_code: targetSide,
            rule_type_o: tgt.o_derived_rule_type_code?.trim() || null,
            rule_type_g: tgt.g_derived_rule_type_code?.trim() || null,
            h2s: tgt.field_h2s_flag?.trim() === "Y",
            wildcat: tgt.wildcat_flag?.trim() === "Y",
          }
        : null,
      field_changes: fieldChanges,
      reclassification: reclass,
      consequences,
      forms_implicated: fieldChanges ? (targetSide === "G" ? ["G-1", "P-4", "G-10"] : ["W-2", "P-4", "W-10"]) : [],
      not_in_this_mirror: [
        "The field rules themselves. `rrc.field` carries a rule TYPE code (SW statewide, SP special field rules) and nothing about spacing, density, or the allowable formula.",
        "Commingling and multiple-completion approvals, and any Rule 37 or Rule 38 exception.",
        "Whether the RRC will grant any of it. Every consequence above is what the record implies, not a determination.",
      ],
      notes: [
        !targetNo
          ? "No target_field_no given, so only the current assignment is described. Pass the target field to get the delta."
          : "Derived from the field records and the wellbore's current schedule. It is what the paperwork implies, not legal advice and not an RRC ruling.",
        NO_COSTS,
      ],
    };
  }
);

// ------------------------------------------------------------------ 118

const targetAllowable = defineTool(
  "rrc_target_allowable",
  "What will they let me produce in the target field? Refuses the per-well allowable, names what the mirror is missing, and reports the allowables leases in that field were actually assigned.",
  { field_no: z.string(), cycle: z.string().optional() },
  async ({ field_no, cycle }) => {
    const no = field_no.trim();
    if (!no) return { ok: false as const, error: "field_no is required." };

    const head = await rrcQueryOne<{
      field_no: string;
      field_name: string | null;
      field_class: string | null;
      o_derived_rule_type_code: string | null;
      g_derived_rule_type_code: string | null;
    }>(
      `select field_no, field_name, field_class,
              o_derived_rule_type_code, g_derived_rule_type_code
         from rrc.field where field_no = $1`,
      [no]
    );
    if (!head) return { ok: false as const, error: `No field ${no} in the mirror.` };

    const rule = (head.o_derived_rule_type_code?.trim() || head.g_derived_rule_type_code?.trim()) ?? null;

    // What CAN be read: the allowable each lease in the field was actually
    // assigned in one cycle. That is an outcome, not the rule that produced it,
    // and it is per LEASE, which is not the per-WELL number that was asked for.
    const at = /^\d{4}-\d{2}$/.test(cycle?.trim() ?? "") ? cycle!.trim() : null;
    const observed = await rrcQuery<{
      oil_gas_code: string;
      district_no: string;
      lease_no: string;
      cycle: string;
      oil_allow: number | null;
      gas_allow: number | null;
      oil_prod_vol: number | null;
      gas_prod_vol: number | null;
    }>(
      at
        ? `select oil_gas_code, district_no, lease_no, to_char(cycle,'YYYY-MM') as cycle,
                  oil_allow, gas_allow, oil_prod_vol, gas_prod_vol
             from rrc.lease_production
            where field_no = $1 and cycle = to_date($2, 'YYYY-MM')
            limit 500`
        : `select oil_gas_code, district_no, lease_no, to_char(cycle,'YYYY-MM') as cycle,
                  oil_allow, gas_allow, oil_prod_vol, gas_prod_vol
             from rrc.lease_production
            where field_no = $1
            order by cycle desc
            limit 500`,
      at ? [no, at] : [no]
    );
    const oilAllow = observed.map((r) => r.oil_allow).filter((n): n is number => n != null && n > 0);
    const gasAllow = observed.map((r) => r.gas_allow).filter((n): n is number => n != null && n > 0);

    // The refusal is the answer. Spending workover money against a number this
    // mirror cannot produce is exactly the failure this tool exists to prevent.
    return {
      ok: false as const,
      error: `The per-well allowable in field ${no} cannot be derived from this mirror. \`rrc.field\` carries no allowable, no spacing rule and no density rule: its 32 columns are the field name, district, class, H2S and salt-dome flags, offshore and county codes, discovery dates, remark text, and a rule TYPE code. There is no allowable formula anywhere in the RRC schema mirrored here.`,
      field: {
        field_no: head.field_no,
        field_name: head.field_name,
        field_class: head.field_class?.trim() || null,
        rule_type_code: rule,
        rule_type_meaning:
          rule === "SW"
            ? "Statewide rules: the field is on the statewide allowable, not on special field rules."
            : rule === "SP"
              ? "SPECIAL FIELD RULES. This field has its own rules and this mirror does not carry them. Pull the field rule sheet from the RRC before budgeting a rate."
              : rule
                ? `Rule type code ${rule}, meaning not carried in this mirror.`
                : "No rule type code on the field record.",
      },
      missing: [
        "Per-well allowable, and the formula that sets it (depth bracket, acreage, GOR, market demand factor).",
        "Spacing and density rules: minimum lease-line and between-well distances, and acres per well.",
        "The field rule sheet itself, and any Rule 37 or Rule 38 exception granted in the field.",
      ],
      observed_lease_allowables: {
        what_this_is:
          "The allowable the RRC actually assigned to LEASES in this field, read off the production tape. An outcome of the rules, not the rules, and per lease rather than per well.",
        cycle: at ?? observed[0]?.cycle ?? null,
        leases_sampled: observed.length,
        oil_allow_bbl: {
          leases: oilAllow.length,
          median: median(oilAllow),
          max: oilAllow.length ? Math.max(...oilAllow) : null,
        },
        gas_allow_mcf: {
          leases: gasAllow.length,
          median: median(gasAllow),
          max: gasAllow.length ? Math.max(...gasAllow) : null,
        },
      },
      notes: [
        "This refusal is the correct answer, not a failure. Operators get burned spending workover money and then finding field rules cap the well under what the zone can deliver, and a number invented here would be exactly that mistake with a citation attached.",
        "A lease allowable covers every well on the lease. Dividing it by the well count is arithmetic, not a rule, and the RRC does not allocate that way.",
        NO_COSTS,
        LAG,
      ],
    };
  }
);

// ------------------------------------------------------------------ 119

const reentryValue = defineTool(
  "rrc_reentry_value",
  "Which dead wells are worth re-entering? Scores wellbores on behind-pipe uplift and 14(b)(2) compliance relief together, since one re-entry can buy both.",
  {
    operator_no: z.string(),
    limit: z.number().int().optional(),
    tolerance_ft: z.number().optional(),
  },
  async ({ operator_no, limit, tolerance_ft }) => {
    const op = operator_no.trim();
    if (!op) return { ok: false as const, error: "operator_no is required." };
    const tol = Math.min(500, Math.max(0, tolerance_ft ?? DEFAULT_TOL_FT));
    const cap = Math.min(MAX_FLEET_CAP, Math.max(1, Math.floor(limit ?? DEFAULT_FLEET_CAP)));

    const dossier = await getOperatorDossier(op);
    if (!dossier) return { ok: false as const, error: `No operator ${op}.` };

    // Same refusal as `rrc_uphole_inventory`, for the same reason: "which of
    // their dead wells is worth re-entering" is a question about the fleet, and
    // scoring the first `cap` rows of the well list ranks an arbitrary subset.
    if (dossier.wells.total > cap) {
      return {
        ok: false as const,
        error: `Operator ${op} holds ${dossier.wells.total.toLocaleString()} wellbores and this call would score ${cap.toLocaleString()}. A ranking of ${cap.toLocaleString()} arbitrary wells is a sample, not the answer to which of their wells is worth re-entering, so it is refused. ${dossier.wells.total <= MAX_FLEET_CAP ? `Pass limit: ${dossier.wells.total} to score the whole fleet in one call.` : `Cut the population first with rrc_well_screen, then run rrc_uphole_inventory over the api list it returns.`}`,
        operator_no: op,
        fleet_total: dossier.wells.total,
        examined: 0,
        is_complete: false,
      };
    }

    // Plugged holes are out: a re-entry into a plugged wellbore is a different
    // and much larger job, and it buys no compliance relief because the
    // obligation it would clear is already discharged.
    const candidates = dossier.wellRows.filter((w) => !w.plug_date);
    const apis = candidates.map((w) => w.api_number.trim());
    const [tops, perfs] = await Promise.all([penetrations(apis), fleetPerfs(apis)]);

    const rows = candidates.map((w) => {
      const a = w.api_number.trim();
      const found = behindPipe(tops.get(a) ?? [], perfs.get(a) ?? [], tol);
      const uphole = found.zones.filter((z) => z.above_shallowest_perf).length;
      // Two components, on the same 0..1 scale, added rather than ranked
      // separately. Splitting them into two lists is what undervalues the well
      // that is BOTH the best behind-pipe candidate and an open plugging
      // obligation, and that well is the one worth doing first.
      const uplift = Math.min(1, uphole / 3);
      const inactive = w.curr_inact_yrs ?? 0;
      const relief = Math.min(1, (w.flagged14b2 ? 0.6 : 0) + Math.min(0.4, inactive / 10));
      return {
        api_number: a,
        lease_name: w.lease_name,
        well_no: w.well_no,
        county_name: w.county_name,
        well_type: w.well_type_name,
        inactive_years: w.curr_inact_yrs,
        flagged_14b2: w.flagged14b2,
        behind_pipe_count: found.zones.length,
        uphole_count: uphole,
        shallowest_behind_pipe_ft: found.zones.length
          ? Math.min(...found.zones.map((z) => z.depth_ft!).filter((n) => n != null))
          : null,
        uplift_score: uplift,
        compliance_relief_score: relief,
        score: uplift + relief,
        both: uphole > 0 && (w.flagged14b2 || inactive >= 5),
      };
    });
    rows.sort((a, b) => b.score - a.score || b.uphole_count - a.uphole_count);

    // Same shape as the inventory: the whole eligible population is scored and
    // only the listing is cut, so `both_count` is the fleet's count and not the
    // page's.
    const listed = rows.slice(0, MAX_LISTED);

    return {
      ok: true as const,
      operator_no: op,
      operator_name: dossier.record.operator_name,
      fleet_total: dossier.wells.total,
      examined: rows.length,
      is_complete: dossier.wellRows.length >= dossier.wells.total,
      unplugged_scored: rows.length,
      plugged_excluded: dossier.wellRows.length - candidates.length,
      flagged_14b2_fleetwide: dossier.wells.flagged14b2,
      scored_listed: listed.length,
      scored: listed,
      both_count: rows.filter((r) => r.both).length,
      notes: [
        ...(listed.length < rows.length
          ? [
              `All ${rows.length} unplugged wellbores were scored and every count above is over all of them. The list is the top ${listed.length} by score.`,
            ]
          : []),
        "Two components on one scale: uplift from unperforated formations the hole already penetrated, and relief from the 14(b)(2) inactive-well obligation the re-entry would discharge. Wells where BOTH are non-zero are flagged, because ranking the two separately buries exactly the wells worth doing first.",
        "The scores are ORDINAL. They rank candidates against each other on the public record; they are not probabilities, reserves, or a rate forecast, and they are deliberately not money.",
        NO_COSTS,
        "Plugged wellbores are excluded. Behind-pipe zones come from the completion report, so a hole with no report scores zero uplift for want of paperwork, not for want of rock.",
        NULL_NOT_ZERO,
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [
  upholeInventory,
  abandonmentReason,
  casingAtDepth,
  cementTopCheck,
  plugbackFeasibility,
  squeezeBurden,
  upholeAnalogs,
  takeawayCheck,
  regulatory,
  targetAllowable,
  reentryValue,
];
