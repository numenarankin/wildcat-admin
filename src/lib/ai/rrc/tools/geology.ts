import "server-only";

import { z } from "zod";

import { rrcQuery, rrcQueryOne } from "@/lib/scout/rrc-db";
import { toPdqDistrict } from "@/lib/scout/rrc-districts";
import {
  getCycleEdge,
  getWellConstruction,
  type SeriesPoint,
} from "@/lib/scout/rrc-queries";
import { fitDecline, type MonthlyRate } from "@/lib/wells/arps";
import { addMonths, clean, linearFit, median, percentile } from "../math";
import {
  datumNote,
  NO_DATUM,
  placeOnDatum,
  type DatumSet,
  type ElevationSource,
} from "../datum";
import { offsetWellbores, type OffsetWellbore } from "../offsets";
import { reportedOnly } from "../series";
import { defineTool, type RrcTool } from "../tool";

/**
 * Where a log question and the public record meet.
 *
 * These reach both Orion and the Fable geology agent, and they exist because the
 * offsets around a well are a POPULATION. A population question is arithmetic,
 * and answering it by reading rows out loud is how a confident wrong number
 * reaches an operator.
 *
 * ## Subsea is the whole game
 *
 * A depth on a filing is measured from THAT FILING'S OWN datum. Two wells a
 * quarter mile apart can differ by 200 ft of surface elevation, so comparing
 * their filed depths directly invents structure that is not there and hides
 * structure that is. Everything structural here converts first:
 *
 *     subsea = kbElevationFt - measuredDepthFt
 *
 * A well with no filed elevation CANNOT be placed in subsea. It is excluded and
 * counted, never defaulted to zero, and every result says how many went. A
 * silently mixed datum produces a structure map that is confidently wrong, which
 * is the worst output this system can produce.
 *
 * ## Nothing is merged across wells
 *
 * Picks and perforations belong to the API they were filed under. A formation is
 * assigned to a perforation using THAT WELL'S own tops, in that well's own
 * measured depth, so no datum conversion is involved and none is applied.
 *
 * ## These query wide on purpose
 *
 * `MAX_OFFSETS` (25) in `@/lib/ai/geology/contracts` is a CONTEXT BUDGET for
 * handing raw offsets to a model. It is not inherited here. These tools return a
 * fitted result rather than the wells, so a 25-well truncation meant for
 * something else would bias every fit. The population size and its truncation
 * are on every result instead.
 */

// ------------------------------------------------------------------ shared

/** Wider than the geology harness's 1 mile: a fit wants the whole neighbourhood. */
const DEFAULT_RADIUS_MI = 2;
const DEFAULT_LIMIT = 60;
/** The feeder's own ceiling. Asking for more silently gets this. */
const MAX_LIMIT = 100;

/**
 * Four points, not three.
 *
 * Three points define a plane exactly: the residuals are zero and r-squared is 1
 * by construction, so a three-well fit reports perfect confidence in a surface
 * nothing tested. The fourth point is the first one that can disagree.
 */
const MIN_PLANE = 4;
/** Below this a regression is an anecdote with a slope on it. */
const MIN_FIT = 5;
/** 69 statute miles to a degree of latitude, the constant the feeder uses. */
const FT_PER_DEG_LAT = 69.0 * 5280;
/** Typical Texas formation brine. Fresh water is 0.433. */
const NORMAL_GRADIENT_PSI_PER_FT = 0.465;
/** Guards a population read from turning into a table scan's worth of rows. */
const MAX_TEST_ROWS = 8000;
const MAX_LEASES = 40;

const SUBSEA_NOTE =
  "Subsea is each well's own elevation minus its own filed depth. What that elevation MEASURES is the RRC's elevation_code: 697,000 filings are ground referenced and 158,600 are referenced to the rig floor, so ground ones are raised by the measured median derrick height of 11 ft before anything is subtracted, and they carry plus or minus 11 ft from there. A well with no elevation at all cannot be placed in subsea and is excluded, never treated as zero.";
const DEVIATED_NOTE =
  "A filed formation top is the depth on the operator's form. Where the hole is deviated that depth may be measured rather than true vertical, and subtracting it from KB then places the pick too deep.";
const TEST_READS_HIGH =
  "A W-10 is one day's metered test filed to set an allowable, not a month of production. Measured across 14,663 leases the sum of a lease's latest tests runs a median 1.64x its reported daily volume, so treat these as relative weights, not as rates.";
const LEASE_GRAIN =
  "Texas files oil by LEASE. Any production figure here covers every well on the lease, not the one well named.";
const NO_LOG_DATA =
  "The mirror carries no logs: no porosity, no water saturation, no resistivity. Every cutoff here is a depth or a rate, and the petrophysical cutoffs must come from the log itself.";

const AREA_SHAPE = {
  lat: z.number().optional(),
  lon: z.number().optional(),
  /**
   * A well to centre on, instead of coordinates.
   *
   * Measured live: asked for the failure map around Repass 2, the model passed
   * `api` with `radius_mi`, was refused for missing lat/lon, and spent a step
   * fetching coordinates. Nobody holds a latitude for a well they can name.
   */
  api: z.string().optional(),
  radius_mi: z.number().optional(),
  limit: z.number().int().optional(),
  /**
   * Narrows the population by RRC FIELD name, which is the only thing a wellbore
   * carries that names a target. Distinct from `formation`, which everywhere in
   * this file means the pick name on a completion form.
   */
  field_name: z.string().optional(),
  /**
   * Where each well's datum is allowed to come from.
   *
   * An enum rather than a boolean so it renders in the catalog line the model
   * reads: a knob it cannot see is a default it cannot decide to change, which
   * is exactly how the radius argument went unused for so long.
   *
   * `filed_and_derived` is the DEFAULT, and the default was flipped after
   * watching it fail live. Asked where else a thin-column recompletion could be
   * repeated, the answer came back saying only 26 of 60 offsets carried a filed
   * elevation and that the producing subsea window could not be derived at all,
   * so the structural half of the question went unanswered while the argument
   * that would have answered it sat unused. An opt-in that the model does not
   * know to reach for is an opt-in that never happens: 58% of wells locally file
   * no elevation, which means the conservative default silently made the
   * structural tools unusable in exactly the area they were built for.
   *
   * Nothing about the honesty changes. A FILED elevation still wins wherever
   * there is one, every derived value carries its band and is counted
   * separately on the result, and anything inside the band is too close to
   * call. `filed_only` is still there for a caller who wants the filings alone.
   */
  datum: z.enum(["filed_only", "filed_and_derived"]).optional(),
  /**
   * An explicit population, in place of the circle.
   *
   * Hand `rrc_well_screen`'s api list straight in and these tools analyse THAT
   * set instead of the nearest N to a point. Without it the two halves of one
   * answer were about different wells: a screen reporting 399 candidates across
   * eight miles, and a contact fit beside it running on the nearest 60 and
   * saying it could not place them. When this is supplied, lat and lon are
   * optional and no distance is invented.
   */
  apis: z.array(z.string()).optional(),
};

/**
 * Every tool here needs a population, and there are exactly two ways to have
 * one. Refusing without either is the honest failure; refusing when an api list
 * was supplied, purely because no circle was drawn, was the defect.
 */
function noPopulation(a: { lat?: number; lon?: number; api?: string; apis?: string[] }): string | null {
  if (a.apis?.length) return null;
  if (a.api?.trim()) return null;
  if (Number.isFinite(a.lat) && Number.isFinite(a.lon)) return null;
  return "Give lat and lon, or an api to centre on, or apis for a population that has already been screened (rrc_well_screen returns one).";
}

/**
 * The surface location of one well, so a circle can be named rather than
 * plotted. Null when the state has no coordinates on file for it.
 */
async function anchorOf(api: string): Promise<{ lat: number; lon: number } | null> {
  const p = await rrcQueryOne<{ lat: number | null; lon: number | null }>(
    `select lat, lon from rrc.well_location where api_number = $1`,
    [api.trim()]
  );
  return p?.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon } : null;
}

/**
 * The first line of every guidance block in this file.
 *
 * These arrays were called `notes` and read as prose, and the model relayed
 * them: an answer to "which wells could I buy" opened with three sentences
 * about what could not be placed in subsea, lifted almost verbatim from a
 * result. The caveats are real and they are for the MODEL, so it knows what the
 * numbers will and will not support. Naming the audience on the first line is
 * what stops them becoming the answer.
 */
const INTERNAL_ONLY =
  "INTERNAL. Act on these, never quote or paraphrase one, and never open an answer with one.";

function fail(error: string) {
  return { ok: false as const, error };
}

/**
 * A refusal caused by the RECORD being thin, not by a bad call.
 *
 * These fire constantly in north-central Texas: 5.7% of wells carry a formation
 * top and 42% carry an elevation, so anything that needs a pick or a datum
 * refuses far more often than it answers. Measured live, the model read two of
 * them in a row and concluded there was no base rate at all, then said so to the
 * user, when the mechanical screen computes one from perforation depths and
 * plugging dates and needs neither.
 *
 * A refusal that names what DOES work is a redirect. One that does not is a dead
 * end the model reports as a property of the world.
 */
function failThinRecord(error: string) {
  return {
    ok: false as const,
    error,
    instead:
      "This needs filed tops or datums that most wells here do not carry. rrc_analog_screen answers the same question mechanically, from perforation depths and plugging dates, over the whole population: the base rate for anyone who shot a depth window and the wells that never did. rrc_well_screen gives the population alone. Neither needs a formation pick.",
  };
}

/** An offset with its datum resolved, which is the only form these tools use. */
type PlacedWellbore = OffsetWellbore & {
  /** Plus or minus, in feet. Zero only where the filing was already rig-floor. */
  datumBandFt: number;
  datumSource: ElevationSource;
};

/**
 * The offsets a tool works from, with the knobs already clamped and every well
 * PLACED ON ONE DATUM.
 *
 * The placement is not optional and it is a correction, not a feature. A filed
 * elevation means whatever `elevation_code` says it means, and 697,000 filings
 * across the mirror are ground-referenced against 158,600 referenced to the rig
 * floor. Every tool below computes `kbElevationFt - depth` and calls the result
 * subsea, so on four wells in five that arithmetic was quietly short by the
 * height of the derrick: a measured median of 11 ft, in a file whose whole
 * argument was about an 11 ft standoff. `placeOnDatum` converts each well to
 * its rig-floor equivalent and carries the band, so the fix lands at every one
 * of the twenty call sites without any of them changing.
 */
async function population(a: {
  lat?: number;
  lon?: number;
  api?: string;
  radius_mi?: number;
  limit?: number;
  field_name?: string;
  datum?: "filed_only" | "filed_and_derived";
  apis?: string[];
}) {
  const radiusMi = Math.min(25, Math.max(0.1, a.radius_mi ?? DEFAULT_RADIUS_MI));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(a.limit ?? DEFAULT_LIMIT)));
  // One code path for a circle, whether it was named by a well or by a point.
  const centre =
    Number.isFinite(a.lat) && Number.isFinite(a.lon)
      ? { lat: a.lat as number, lon: a.lon as number }
      : a.api?.trim()
        ? await anchorOf(a.api)
        : null;
  const { wells: raw, truncated } = await offsetWellbores({
    lat: centre?.lat ?? Number.NaN,
    lon: centre?.lon ?? Number.NaN,
    radiusMi,
    limit,
    formation: a.field_name,
    apis: a.apis,
    // Worth the unindexed read here and nowhere else: a structure map wants the
    // point where the hole actually PENETRATED the formation, which on a
    // deviated well is the bottomhole and not the surface location. These tools
    // are a deliberate follow-up call, not part of the harness's concurrent
    // Stage 1 fan-out, so they can afford the second that `offsets_within_radius`
    // cannot.
    includeBottomhole: true,
  });

  const set = await placeOnDatum(
    raw.map((w) => ({
      api_number: w.api_number,
      lat: w.lat,
      lon: w.lon,
      elevationFt: w.kbElevationFt,
      elevationCode: w.elevationCode,
    })),
    { derive: a.datum !== "filed_only", radiusMi: Math.max(radiusMi, 5) }
  );

  const wells: PlacedWellbore[] = raw.map((w) => {
    const d = set.byApi.get(w.api_number) ?? NO_DATUM;
    return {
      ...w,
      kbElevationFt: d.elevationFt,
      datumBandFt: d.bandFt,
      datumSource: d.source,
    };
  });

  return { wells, truncated, radiusMi, limit, datum: set, centre };
}

/** Subsea elevation of one depth on one well. Null means "cannot be placed". */
function subsea(kbFt: number | null, mdFt: number | null | undefined): number | null {
  if (kbFt == null || mdFt == null || !Number.isFinite(mdFt)) return null;
  return kbFt - mdFt;
}

/** The population split on whether it has a datum at all. */
function byDatum(wells: readonly PlacedWellbore[]) {
  const placed = wells.filter((w) => w.kbElevationFt != null);
  const excluded = wells.filter((w) => w.kbElevationFt == null).map((w) => w.api_number);
  return { placed, excluded };
}

/**
 * What every structural result says about the wells it could not use, and about
 * how firm the ground under the ones it did use actually is.
 *
 * `datum` is here rather than buried per well because the band governs how the
 * whole answer may be read: a contact fitted over wells carrying plus or minus
 * 26 ft cannot settle an 11 ft standoff, and the only way a reader knows that
 * is if the widest band travels with the result.
 */
function datumReport(
  wells: readonly PlacedWellbore[],
  excluded: readonly string[],
  set?: DatumSet
) {
  return {
    wells_in_radius: wells.length,
    placed_in_subsea: wells.length - excluded.length,
    excluded_no_datum: excluded.length,
    excluded_apis: [...excluded],
    ...(set
      ? {
          datum: {
            filed: set.filed,
            derived: set.derived,
            widest_band_ft: set.widestBandFt,
            note: datumNote(set),
          },
        }
      : {}),
  };
}

/** This well's perforated envelope, in ITS measured depth. Never merged. */
function perfEnvelope(w: OffsetWellbore): { top: number; bottom: number } | null {
  const tops = clean(w.perforations.map((p) => p.topFt)).filter((n) => n > 0);
  const bottoms = clean(w.perforations.map((p) => p.bottomFt)).filter((n) => n > 0);
  if (!tops.length || !bottoms.length) return null;
  return { top: Math.min(...tops), bottom: Math.max(...bottoms) };
}

/** Net perforated feet: the intervals summed, not the envelope. */
function perfNetFt(w: OffsetWellbore): number | null {
  const spans = w.perforations
    .map((p) => (p.topFt != null && p.bottomFt != null ? p.bottomFt - p.topFt : null))
    .filter((n): n is number => n != null && n > 0);
  return spans.length ? spans.reduce((a, b) => a + b, 0) : null;
}

/**
 * The formation a depth sits in, per THIS well's own picks.
 *
 * Both numbers come off the same well's filings, so this is the one depth
 * comparison in the file that needs no datum conversion, and it gets none.
 */
function formationAt(w: OffsetWellbore, mdFt: number): string | null {
  let best: { formation: string; depthFt: number } | null = null;
  for (const t of w.formationTops) {
    if (t.depthFt == null || t.depthFt > mdFt) continue;
    if (!best || t.depthFt > best.depthFt) best = { formation: t.formation, depthFt: t.depthFt };
  }
  return best?.formation ?? null;
}

/** That well's pick for one formation, matched loosely on name. */
function pickOf(w: OffsetWellbore, formation: string): number | null {
  const want = formation.trim().toUpperCase();
  for (const t of w.formationTops) {
    const name = t.formation.trim().toUpperCase();
    if (t.depthFt != null && (name === want || name.includes(want) || want.includes(name))) {
      return t.depthFt;
    }
  }
  return null;
}

/**
 * Local feet east and north of an origin.
 *
 * ONE scale factor for the whole patch, taken at the origin latitude. Scaling
 * each well by its own cosine shears the grid and rotates the fitted azimuth,
 * which is a silent error in the one number the tool exists to produce.
 */
function localFeet(originLat: number, originLon: number, lat: number, lon: number) {
  return {
    x: (lon - originLon) * FT_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180),
    y: (lat - originLat) * FT_PER_DEG_LAT,
  };
}

interface PlanePoint {
  x: number;
  y: number;
  z: number;
}

export interface PlaneFit {
  /** z = a*x + b*y + c, x east feet, y north feet, z subsea feet. */
  a: number;
  b: number;
  c: number;
  dipDeg: number;
  /** Compass bearing of steepest DESCENT. */
  dipAzimuthDeg: number;
  dipFtPerMile: number;
  r2: number | null;
  rmseFt: number;
  n: number;
}

/**
 * Least squares plane through subsea picks.
 *
 * Centred before solving, which turns the 3x3 normal equations into a 2x2 and
 * keeps the determinant meaningful: a set of wells strung along one road is
 * collinear, cannot constrain a dip direction, and returns null here rather than
 * an azimuth pulled out of rounding error.
 */
function fitPlane(points: readonly PlanePoint[]): PlaneFit | null {
  const n = points.length;
  if (n < MIN_PLANE) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const mz = points.reduce((s, p) => s + p.z, 0) / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  let szz = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    const dz = p.z - mz;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxz += dx * dz;
    syz += dy * dz;
    szz += dz * dz;
  }
  const det = sxx * syy - sxy * sxy;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9 * Math.max(1, sxx * syy)) return null;

  const a = (sxz * syy - syz * sxy) / det;
  const b = (syz * sxx - sxz * sxy) / det;
  const c = mz - a * mx - b * my;

  let ssres = 0;
  for (const p of points) ssres += (p.z - (a * p.x + b * p.y + c)) ** 2;
  const grad = Math.hypot(a, b);
  return {
    a,
    b,
    c,
    dipDeg: (Math.atan(grad) * 180) / Math.PI,
    // The gradient points uphill, so downdip is its negative. atan2(east, north)
    // is a compass bearing, not the mathematical convention.
    dipAzimuthDeg: ((Math.atan2(-a, -b) * 180) / Math.PI + 360) % 360,
    dipFtPerMile: grad * 5280,
    r2: szz === 0 ? null : 1 - ssres / szz,
    rmseFt: Math.sqrt(ssres / n),
    n,
  };
}

function planeAt(fit: PlaneFit, p: { x: number; y: number }): number {
  return fit.a * p.x + fit.b * p.y + fit.c;
}

/** EWA dates are CCYYMMDD text. "0" and "" mean not recorded, never year zero. */
function date8(raw: string | null | undefined): { iso: string; year: number; months: number } | null {
  const s = (raw ?? "").replace(/[^0-9]/g, "");
  if (s.length !== 8) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  if (year < 1900 || year > 2100 || month < 1 || month > 12) return null;
  return { iso: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, year, months: year * 12 + (month - 1) };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** Percentiles of a sample, reported the same way everywhere in this file. */
function spread(values: readonly number[]) {
  return {
    n: values.length,
    pct10: percentile(values, 0.1),
    median: median(values),
    pct90: percentile(values, 0.9),
  };
}

// --------------------------------------------------------------- mirror reads

interface WellKey {
  api: string;
  /** The real-world district label (7B, 8A), which is what W-10 and G-10 use. */
  district: string | null;
  oil_gas_code: string | null;
  lease_no: string | null;
  well_no: string | null;
  field_name: string | null;
  well_type: string | null;
  /** ORIGINAL completion where filed: a recompletion date would misdate the hole. */
  completion_date: string | null;
  plug_date: string | null;
}

/**
 * The schedule row behind each API, in one round trip.
 *
 * `distinct on (api_number) order by on_schedule desc` takes the CURRENT
 * assignment, the rule `getWellDossier` follows: the grain of `rrc.wellbore` is
 * well x lease x field, and a historic row points at a lease this hole left.
 */
async function wellKeys(apis: readonly string[]): Promise<Map<string, WellKey>> {
  if (!apis.length) return new Map();
  const rows = await rrcQuery<Record<string, string | null>>(
    `select distinct on (api_number)
            trim(api_number) as api, district, oil_gas_code, lease_number, well_no,
            field_name, well_type_name, completion_date, orig_completion_dt, plug_date
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
  producing_method: string | null;
}

/**
 * W-10 tests for a whole population in ONE round trip, newest first.
 *
 * The join is district + lease + well, which is how Texas keys oil, and it goes
 * through `rrc.wellbore` because that is the only table carrying both those keys
 * and an API. `on_schedule = 'Y'` matters: a historic row would attach some
 * other lease's tests to this hole.
 */
async function oilTests(apis: readonly string[], latestOnly: boolean): Promise<OilTest[]> {
  if (!apis.length) return [];
  return rrcQuery<OilTest>(
    `select ${latestOnly ? "distinct on (w.api_number)" : ""}
            trim(w.api_number) as api,
            to_char(t.test_date, 'YYYY-MM-DD') as test_date,
            t.daily_oil, t.daily_water, t.daily_gas, t.gas_oil_ratio, t.producing_method
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

interface GasTest {
  api: string;
  gas_id: string | null;
  test_date: string | null;
  daily_gas: number | null;
  daily_cond: number | null;
  daily_water: number | null;
  siwh_press: number | null;
  flow_press: number | null;
  bhp: number | null;
  gas_gravity: number | null;
  gas_liquid_ratio: number | null;
  potential: number | null;
}

/**
 * G-10 deliverability tests for a population, newest first.
 *
 * G-10 carries no API. The route that works is `rrc.wellbore` on district plus
 * the six-digit gas id it keeps in `lease_number` for gas rows. One hole can
 * carry several gas ids (one per gas reservoir), so the grain here is
 * (api, gas_id) and callers must not sum across it without saying so.
 */
async function gasTests(apis: readonly string[], latestOnly: boolean): Promise<GasTest[]> {
  if (!apis.length) return [];
  return rrcQuery<GasTest>(
    `select ${latestOnly ? "distinct on (w.api_number, t.gas_id)" : ""}
            trim(w.api_number) as api, trim(t.gas_id) as gas_id,
            to_char(t.test_date, 'YYYY-MM-DD') as test_date,
            t.daily_gas, t.daily_cond, t.daily_water, t.siwh_press, t.flow_press,
            t.bhp, t.gas_gravity, t.gas_liquid_ratio, t.potential
       from rrc.wellbore w
       join rrc.g10_test t
         on t.district = w.district and t.gas_id = w.lease_number
      where w.api_number = any($1::bpchar[])
        and w.oil_gas_code = 'G' and w.on_schedule = 'Y'
        and t.test_date is not null
      order by w.api_number, t.gas_id, t.test_date desc nulls last,
               t.corrected desc nulls last
      limit ${MAX_TEST_ROWS}`,
    [apis]
  );
}

interface LeaseSeries {
  /** Key is `O/08/12345`, PDQ district. Reported cycles only, oldest first. */
  byLease: Map<string, SeriesPoint[]>;
  /** Which APIs in the population sit on each lease. */
  apisByLease: Map<string, string[]>;
  reportedThrough: string;
  leases: number;
  truncated: boolean;
}

/**
 * Lease production for a population, in one round trip.
 *
 * THE DISTRICT IS TRANSLATED. `rrc.wellbore` carries the real label (7B, 8A);
 * `rrc.lease_production` is a PDQ table keyed on the internal code. Joining them
 * raw lands on a different district's lease and reports another operator's oil.
 */
async function leaseSeries(keys: readonly WellKey[]): Promise<LeaseSeries> {
  const apisByLease = new Map<string, string[]>();
  const uniq = new Map<string, { og: string; dist: string; lease: string }>();
  for (const k of keys) {
    const pdq = toPdqDistrict(k.district);
    if (!k.oil_gas_code || !pdq || !k.lease_no) continue;
    const id = `${k.oil_gas_code}/${pdq}/${k.lease_no}`;
    uniq.set(id, { og: k.oil_gas_code, dist: pdq, lease: k.lease_no });
    apisByLease.set(id, [...(apisByLease.get(id) ?? []), k.api]);
  }
  const list = [...uniq.entries()].slice(0, MAX_LEASES);
  const empty: LeaseSeries = {
    byLease: new Map(),
    apisByLease,
    reportedThrough: "",
    leases: uniq.size,
    truncated: uniq.size > list.length,
  };
  if (!list.length) return empty;

  const [{ reported }, rows] = await Promise.all([
    getCycleEdge(),
    rrcQuery<{
      oil_gas_code: string;
      district_no: string;
      lease_no: string;
      cycle: string;
      oil: number | null;
      gas: number | null;
      cond: number | null;
      csgd: number | null;
    }>(
      `select p.oil_gas_code, p.district_no, p.lease_no,
              to_char(p.cycle, 'YYYY-MM') as cycle,
              p.oil_prod_vol as oil, p.gas_prod_vol as gas,
              p.cond_prod_vol as cond, p.csgd_prod_vol as csgd
         from rrc.lease_production p
         join unnest($1::text[], $2::text[], $3::text[]) as k(og, dist, lease)
           on p.oil_gas_code = k.og and p.district_no = k.dist and p.lease_no = k.lease
        order by p.cycle`,
      [
        list.map(([, v]) => v.og),
        list.map(([, v]) => v.dist),
        list.map(([, v]) => v.lease),
      ]
    ),
  ]);

  const byLease = new Map<string, SeriesPoint[]>();
  for (const r of rows) {
    const id = `${r.oil_gas_code.trim()}/${r.district_no.trim()}/${r.lease_no.trim()}`;
    const list2 = byLease.get(id) ?? [];
    list2.push({
      cycle: r.cycle,
      oil: r.oil ?? 0,
      gas: r.gas ?? 0,
      cond: r.cond ?? 0,
      csgd: r.csgd ?? 0,
      // The RRC runs about three cycles behind and the unfiled tail sits in the
      // mirror as zeros. Marked here, dropped by `reportedOnly` below.
      reported: r.cycle <= reported,
    });
    byLease.set(id, list2);
  }
  for (const [id, pts] of byLease) byLease.set(id, reportedOnly(pts));

  return { byLease, apisByLease, reportedThrough: reported, leases: uniq.size, truncated: empty.truncated };
}

/** The wellhead, for tools that start from an API rather than a point. */
async function wellPoint(api: string): Promise<{ lat: number; lon: number } | null> {
  const row = await rrcQueryOne<{ lat: number | null; lon: number | null }>(
    `select lat, lon from rrc.well_location where api_number = $1 limit 1`,
    [api]
  );
  return row?.lat != null && row?.lon != null ? { lat: row.lat, lon: row.lon } : null;
}

/** Daily rate of a stream, from a lease's monthly volumes. */
function dailyOil(points: readonly SeriesPoint[]): MonthlyRate[] {
  return points.map((p) => {
    const [y, m] = p.cycle.split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { month: p.cycle, rate: days > 0 ? (p.oil + p.cond) / days : 0 };
  });
}

/** Water cut from a W-10, or null when the test cannot say. */
function waterCut(t: OilTest): number | null {
  const oil = t.daily_oil ?? 0;
  const water = t.daily_water ?? 0;
  if (t.daily_oil == null && t.daily_water == null) return null;
  const total = oil + water;
  return total > 0 ? water / total : null;
}

/** Gas-oil ratio in cubic feet per barrel: as filed, else from the rates. */
function gorOf(t: OilTest): number | null {
  if (t.gas_oil_ratio != null && t.gas_oil_ratio > 0) return t.gas_oil_ratio;
  if (t.daily_gas != null && t.daily_oil != null && t.daily_oil > 0) {
    return (t.daily_gas * 1000) / t.daily_oil;
  }
  return null;
}

// ------------------------------------------------------------------ 92

const reservoirInputs = defineTool(
  "rrc_reservoir_inputs",
  "What pressure and fluid does this well actually have? Shut-in and flowing pressure, gas gravity, gas-liquid ratio and condensate yield for one well, from the nearest filed G-10 and W-10 tests.",
  { api: z.string(), radius_mi: z.number().optional() },
  async ({ api, radius_mi }) => {
    const key = api.trim();
    if (!key) return fail("api is required.");
    const point = await wellPoint(key);
    if (!point) return fail(`No surface location on file for ${key}, so no offsets can be found.`);

    const { wells, radiusMi } = await population({ ...point, radius_mi, limit: 40 });
    const apis = [key, ...wells.map((w) => w.api_number).filter((a) => a !== key)];
    const distance = new Map(wells.map((w) => [w.api_number, w.distanceMi]));
    distance.set(key, 0);

    const [oil, gas] = await Promise.all([oilTests(apis, true), gasTests(apis, true)]);
    // Nearest first, and the subject well itself is at zero.
    const near = <T extends { api: string }>(rows: T[], usable: (r: T) => boolean) =>
      rows
        .filter(usable)
        .sort((a, b) => (distance.get(a.api) ?? 99) - (distance.get(b.api) ?? 99))[0] ?? null;

    const g = near(gas, (r) => r.siwh_press != null || r.flow_press != null || r.gas_gravity != null);
    const o = near(oil, (r) => r.daily_oil != null || r.gas_oil_ratio != null);

    const yieldBblPerMMcf =
      g?.daily_cond != null && g.daily_gas != null && g.daily_gas > 0
        ? g.daily_cond / (g.daily_gas / 1000)
        : null;

    return {
      ok: true as const,
      api: key,
      radius_mi: radiusMi,
      gas_test:
        g == null
          ? null
          : {
              source_api: g.api,
              distance_mi: distance.get(g.api) ?? null,
              gas_id: g.gas_id,
              test_date: g.test_date,
              shut_in_wellhead_psi: g.siwh_press,
              flowing_pressure_psi: g.flow_press,
              bottomhole_pressure_psi: g.bhp,
              gas_gravity: g.gas_gravity,
              gas_liquid_ratio_cf_per_bbl: g.gas_liquid_ratio,
              daily_gas_mcf: g.daily_gas,
              daily_cond_bbl: g.daily_cond,
              condensate_yield_bbl_per_mmcf: yieldBblPerMMcf,
            },
      oil_test:
        o == null
          ? null
          : {
              source_api: o.api,
              distance_mi: distance.get(o.api) ?? null,
              test_date: o.test_date,
              daily_oil_bbl: o.daily_oil,
              daily_water_bbl: o.daily_water,
              daily_gas_mcf: o.daily_gas,
              gas_oil_ratio_cf_per_bbl: gorOf(o),
              water_cut: waterCut(o),
              producing_method: o.producing_method,
            },
      from_subject_well: { gas: g?.api === key, oil: o?.api === key },
      guidance: [
        INTERNAL_ONLY,
        "SIWH is a WELLHEAD pressure. Reservoir pressure is higher by the weight of the fluid column, and correcting for it needs a gas gravity and a datum depth, which this tool reports but does not apply.",
        "Bottomhole pressure is filed on a minority of G-10s. Null means not filed, not zero.",
        TEST_READS_HIGH,
        g != null && g.api !== key
          ? `No usable G-10 on ${key}: the gas numbers come from ${g.api}, ${(distance.get(g.api) ?? 0).toFixed(2)} mi away.`
          : "Gas numbers are this well's own G-10.",
        o != null && o.api !== key
          ? `No usable W-10 on ${key}: the oil numbers come from ${o.api}, ${(distance.get(o.api) ?? 0).toFixed(2)} mi away.`
          : "Oil numbers are this well's own W-10.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 93

const fluidProperties = defineTool(
  "rrc_fluid_properties",
  "What is the fluid around here, oil or gas or condensate, and how wet? Gravity, gas-liquid ratio, condensate yield and water cut across an area, plus the fluid analysis the state record does not carry.",
  AREA_SHAPE,
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const { wells, truncated, radiusMi } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const apis = wells.map((w) => w.api_number);
    const [oil, gas] = await Promise.all([oilTests(apis, true), gasTests(apis, true)]);

    const gravity = clean(gas.map((g) => g.gas_gravity)).filter((v) => v > 0.4 && v < 2);
    const glr = clean(gas.map((g) => g.gas_liquid_ratio)).filter((v) => v > 0);
    const yields = gas
      .map((g) =>
        g.daily_cond != null && g.daily_gas != null && g.daily_gas > 0
          ? g.daily_cond / (g.daily_gas / 1000)
          : null
      )
      .filter((v): v is number => v != null && v > 0);
    const cuts = oil.map(waterCut).filter((v): v is number => v != null);
    const wor = oil
      .map((t) =>
        t.daily_water != null && t.daily_oil != null && t.daily_oil > 0 ? t.daily_water / t.daily_oil : null
      )
      .filter((v): v is number => v != null);

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      field_name: args.field_name ?? null,
      wells_in_radius: wells.length,
      gas_wells_tested: new Set(gas.map((g) => g.api)).size,
      oil_wells_tested: new Set(oil.map((o) => o.api)).size,
      gas_gravity: spread(gravity),
      gas_liquid_ratio_cf_per_bbl: spread(glr),
      condensate_yield_bbl_per_mmcf: spread(yields),
      water_cut: spread(cuts),
      water_oil_ratio: spread(wor),
      // Named and nulled rather than omitted: a caller asking for sour gas needs
      // to be told the record is silent, not handed a quiet absence it can read
      // as "no H2S here".
      co2_mol_pct: null,
      h2s_ppm: null,
      water_salinity_ppm: null,
      not_carried: ["CO2 content", "H2S content", "produced water salinity"],
      truncated,
      guidance: [
        INTERNAL_ONLY,
        "CO2, H2S and produced water salinity are NOT in this mirror in any form. There is no gas analysis and no water analysis dataset in the RRC public tapes loaded here, so this tool cannot answer a sourness or a brine question, and a null above is an absent record rather than a clean gas or a fresh brine.",
        "The only CO2 and H2S in the mirror are permitted-injection fluid flags on UIC disposal permits, which say what an operator may put down a well, not what a reservoir produces. They are deliberately not reported here.",
        "Gas gravity and gas-liquid ratio are G-10 fields, so they exist only for wells the RRC classes as gas wells. An oil well's casinghead gas has neither.",
        TEST_READS_HIGH,
      ],
    };
  }
);

// ------------------------------------------------------------------ 94

function impliedFluid(gradient: number): string {
  if (gradient <= 0) return "not a fluid gradient: pressure does not increase with depth in this population";
  if (gradient < 0.15) return "gas";
  if (gradient < 0.25) return "gas or a light oil with gas in solution";
  if (gradient < 0.4) return "oil";
  if (gradient <= 0.52) return "water";
  return "overpressured, or not one continuous fluid column";
}

const pressureRegime = defineTool(
  "rrc_pressure_regime",
  "Is this interval pressured up or drawn down, and what does the gradient say the fluid is? Shut-in pressures across an area against subsea depth.",
  AREA_SHAPE,
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const { wells, truncated, radiusMi, datum: datumSet } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const { placed, excluded } = byDatum(wells);
    const gas = await gasTests(placed.map((w) => w.api_number), true);
    const latest = new Map<string, GasTest>();
    for (const g of gas) if (!latest.has(g.api)) latest.set(g.api, g);

    // A depth for a pressure is the middle of what is open to the reservoir.
    const rows = placed.flatMap((w) => {
      const g = latest.get(w.api_number);
      const env = perfEnvelope(w);
      const mid = env ? (env.top + env.bottom) / 2 : null;
      const ss = subsea(w.kbElevationFt, mid);
      if (!g || ss == null) return [];
      return [
        {
          api: w.api_number,
          operator: w.operator_name,
          test_date: g.test_date,
          perf_mid_subsea_ft: ss,
          depth_below_sea_ft: -ss,
          siwh_psi: g.siwh_press,
          bhp_psi: g.bhp,
        },
      ];
    });

    // Never fitted together. A wellhead pressure and a bottomhole pressure differ
    // by the whole fluid column, so one line through both is a gradient of the
    // mix of forms filed, not of the reservoir.
    const bhp = rows.filter((r) => r.bhp_psi != null && r.bhp_psi > 0);
    const siwh = rows.filter((r) => r.siwh_psi != null && r.siwh_psi > 0);
    const useBhp = bhp.length >= siwh.length && bhp.length >= MIN_FIT;
    const used = useBhp ? bhp : siwh;
    const measure = useBhp ? "bottomhole (G-10 BHP)" : "wellhead (G-10 SIWH)";
    const pressureOf = (r: (typeof rows)[number]) => (useBhp ? r.bhp_psi : r.siwh_psi) as number;

    if (used.length < MIN_FIT) {
      return {
        ...fail(
          `Only ${used.length} well(s) in this radius carry both a filed shut-in pressure and a datum. ${MIN_FIT} are needed before a gradient means anything.`
        ),
        wells_in_radius: wells.length,
        excluded_no_datum: excluded.length,
        with_pressure: rows.length,
      };
    }

    const fit = linearFit(used.map((r) => [r.depth_below_sea_ft, pressureOf(r)] as const));
    const gradient = fit?.slope ?? null;
    const drawn = used.map((r) => ({
      api: r.api,
      test_date: r.test_date,
      perf_mid_subsea_ft: r.perf_mid_subsea_ft,
      pressure_psi: pressureOf(r),
      normal_hydrostatic_psi: r.depth_below_sea_ft * NORMAL_GRADIENT_PSI_PER_FT,
      ratio_to_normal:
        r.depth_below_sea_ft > 0
          ? pressureOf(r) / (r.depth_below_sea_ft * NORMAL_GRADIENT_PSI_PER_FT)
          : null,
    }));
    const ratios = clean(drawn.map((d) => d.ratio_to_normal));

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      field_name: args.field_name ?? null,
      population: { ...datumReport(wells, excluded, datumSet), with_pressure: rows.length, truncated },
      measure,
      measure_counts: { bhp_filed: bhp.length, siwh_filed: siwh.length },
      fit: {
        n: fit?.n ?? 0,
        gradient_psi_per_ft: gradient,
        surface_intercept_psi: fit?.intercept ?? null,
        r2: fit?.r2 ?? null,
      },
      implied_fluid: gradient == null ? null : impliedFluid(gradient),
      normal_gradient_psi_per_ft: NORMAL_GRADIENT_PSI_PER_FT,
      ratio_to_normal: spread(ratios),
      drawn_down_wells: drawn.filter((d) => d.ratio_to_normal != null && d.ratio_to_normal < 0.75).length,
      wells_detail: drawn,
      guidance: [
        INTERNAL_ONLY,
        SUBSEA_NOTE,
        `Depth is the middle of each well's own perforated envelope, converted with that well's own elevation. ${excluded.length} well(s) had no filed elevation and are excluded from the fit.`,
        useBhp
          ? "Fitted on filed bottomhole pressures."
          : "Fitted on SHUT-IN WELLHEAD pressure, which understates reservoir pressure by the weight of the fluid column: expect a gradient flatter than the true one, and read the fluid call as a hypothesis.",
        "A single gradient assumes these wells share one continuous fluid column. Several stacked reservoirs in one radius produce a straight line through unrelated points, and r-squared will not warn you.",
        "Below about 0.75 of normal hydrostatic reads as drawn down. That is a screen, not a material balance.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 95

/** Which datum an RRC elevation code names. Null codes are the majority. */
const KB_CODES = new Set(["KB", "DF", "RT"]);
const GL_CODES = new Set(["GL", "GR"]);

const depthReconcile = defineTool(
  "rrc_depth_reconcile",
  "Is this log hung on the right datum? Its stated TD, KB and ground level against the RRC's filed total depth and elevation, to catch a depth shift before anything is computed from it.",
  {
    api: z.string(),
    log_td_ft: z.number().optional(),
    log_kb_ft: z.number().optional(),
    log_gl_ft: z.number().optional(),
    tolerance_ft: z.number().optional(),
    td_tolerance_ft: z.number().optional(),
  },
  async (args) => {
    const key = args.api.trim();
    if (!key) return fail("api is required.");
    if (args.log_td_ft == null && args.log_kb_ft == null && args.log_gl_ft == null) {
      return fail("Give at least one of log_td_ft, log_kb_ft, log_gl_ft to reconcile against.");
    }
    const built = await getWellConstruction(key);
    if (!built) return fail(`The Well Bore Database has no record for ${key}.`);

    const tol = Math.max(0, args.tolerance_ft ?? 10);
    const tdTol = Math.max(0, args.td_tolerance_ft ?? 50);
    const newest = built.filings[0] ?? null;
    const code = newest?.elevation_code?.trim() || null;
    const elevations = clean(built.filings.map((f) => f.elevation));
    const conflicts: {
      field: string;
      log_value: number | null;
      rrc_value: number | null;
      difference_ft: number | null;
      tolerance_ft: number;
      note: string;
    }[] = [];

    if (args.log_td_ft != null && built.total_depth != null) {
      const diff = args.log_td_ft - built.total_depth;
      if (Math.abs(diff) > tdTol) {
        conflicts.push({
          field: "total_depth_ft",
          log_value: args.log_td_ft,
          rrc_value: built.total_depth,
          difference_ft: diff,
          tolerance_ft: tdTol,
          note:
            diff > 0
              ? "The log reaches DEEPER than the filed total depth. A logger's TD is normally shallower than the driller's, so this direction is the alarming one: the log is probably not on this hole's datum, or not this hole."
              : "The log stops above the filed total depth, which is ordinary if the difference is small: logging tools rarely reach the bottom of the hole.",
        });
      }
    }

    const filed = newest?.elevation ?? null;
    if (filed != null && code != null) {
      const against = KB_CODES.has(code) ? args.log_kb_ft : GL_CODES.has(code) ? args.log_gl_ft : null;
      const label = KB_CODES.has(code) ? "log_kb_ft" : "log_gl_ft";
      if (against != null) {
        const diff = against - filed;
        if (Math.abs(diff) > tol) {
          conflicts.push({
            field: `elevation_ft (${code})`,
            log_value: against,
            rrc_value: filed,
            difference_ft: diff,
            tolerance_ft: tol,
            note: `The filing's elevation code is ${code}, so it is compared against ${label}. Every subsea depth computed from this well shifts by this amount.`,
          });
        }
      }
    } else if (filed != null && code == null) {
      conflicts.push({
        field: "elevation_code",
        log_value: args.log_kb_ft ?? args.log_gl_ft ?? null,
        rrc_value: filed,
        difference_ft: null,
        tolerance_ft: tol,
        note: "The filing carries an elevation but NO code, so what it is measured from is unrecorded. It cannot be reconciled against a KB or a GL, and using it as either risks a derrick height of error in every subsea depth.",
      });
    }

    if (elevations.length > 1 && Math.max(...elevations) - Math.min(...elevations) > tol) {
      conflicts.push({
        field: "elevation_ft (between filings)",
        log_value: null,
        rrc_value: newest?.elevation ?? null,
        difference_ft: Math.max(...elevations) - Math.min(...elevations),
        tolerance_ft: tol,
        note: "This hole's own filings disagree about its elevation. The newest is used everywhere else in this catalog.",
      });
    }

    const derrick =
      args.log_kb_ft != null && args.log_gl_ft != null ? args.log_kb_ft - args.log_gl_ft : null;
    if (derrick != null && (derrick < 0 || derrick > 80)) {
      conflicts.push({
        field: "kb_minus_gl_ft",
        log_value: derrick,
        rrc_value: null,
        difference_ft: null,
        tolerance_ft: tol,
        note: "KB minus ground level is a derrick height. Outside roughly 0 to 80 ft the log header is misread or one of the two is not what it says.",
      });
    }

    return {
      ok: true as const,
      api: key,
      rrc: {
        total_depth_ft: built.total_depth,
        elevation_ft: filed,
        elevation_code: code,
        filings: built.filings.length,
        shallowest_perf_ft: built.shallowest_perf,
        deepest_perf_ft: built.deepest_perf,
      },
      log: {
        td_ft: args.log_td_ft ?? null,
        kb_ft: args.log_kb_ft ?? null,
        gl_ft: args.log_gl_ft ?? null,
        kb_minus_gl_ft: derrick,
      },
      agrees: conflicts.length === 0,
      conflicts,
      guidance: [
        INTERNAL_ONLY,
        "A null RRC value is an unfiled one. It cannot confirm the log and it cannot contradict it.",
        "Depths on both sides are measured depth from each source's own datum. This tool reconciles the DATUMS; it does not correct the log.",
        code == null && filed != null
          ? "This well's elevation has no code, which is the common case in the mirror. Treat every subsea depth derived from it as carrying a derrick height of uncertainty."
          : "The elevation code names what the filed elevation is measured from.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 96

const PAY_SHAPE = {
  api: z.string(),
  pay: z.array(
    z.object({ top_ft: z.number(), bottom_ft: z.number(), name: z.string().optional() })
  ),
  tolerance_ft: z.number().optional(),
};

const perfVsLog = defineTool(
  "rrc_perf_vs_log",
  // The shape of `pay` is spelled out here because the derived signature can
  // only say `obj[]`, and a model cannot guess the keys of an object.
  "Did they shoot where the log says the pay is? Where the operator actually perforated against the intervals a log calls pay (pay: [{top_ft, bottom_ft, name?}]), flagged when they disagree by more than a stated tolerance.",
  PAY_SHAPE,
  async ({ api, pay, tolerance_ft }) => {
    const key = api.trim();
    if (!key) return fail("api is required.");
    const intervals = pay
      .map((p) => ({ ...p, top_ft: Math.min(p.top_ft, p.bottom_ft), bottom_ft: Math.max(p.top_ft, p.bottom_ft) }))
      .filter((p) => Number.isFinite(p.top_ft) && Number.isFinite(p.bottom_ft) && p.bottom_ft > p.top_ft);
    if (!intervals.length) return fail("pay must carry at least one interval with bottom_ft below top_ft.");

    const built = await getWellConstruction(key);
    if (!built) return fail(`The Well Bore Database has no record for ${key}.`);
    // The newest filing is the current completion. Older filings are kept
    // separate rather than unioned in: a 1978 completion blended with a 2019 one
    // reads as a well shot over 4,000 ft of section.
    const newest = built.filings.find((f) => f.perforations.length > 0) ?? null;
    if (!newest) return fail(`No perforation record on file for ${key}.`);
    const shot = newest.perforations
      .filter((p) => p.top_ft != null && p.bottom_ft != null && p.bottom_ft > p.top_ft)
      .map((p) => ({ top: p.top_ft as number, bottom: p.bottom_ft as number, open_hole: p.open_hole }));
    if (!shot.length) return fail(`Filing ${newest.file_date ?? "(undated)"} on ${key} carries no usable perforation depths.`);

    const tol = Math.max(0, tolerance_ft ?? 20);
    const overlapFt = (a: { top: number; bottom: number }, b: { top_ft: number; bottom_ft: number }) =>
      Math.max(0, Math.min(a.bottom, b.bottom_ft) - Math.max(a.top, b.top_ft));

    const byPay = intervals.map((p) => {
      const covered = shot.reduce((s, i) => s + overlapFt(i, p), 0);
      const thickness = p.bottom_ft - p.top_ft;
      return {
        name: p.name ?? null,
        top_ft: p.top_ft,
        bottom_ft: p.bottom_ft,
        thickness_ft: thickness,
        perforated_ft: covered,
        unshot_ft: thickness - covered,
        fraction_shot: thickness > 0 ? covered / thickness : null,
        disagrees: thickness - covered > tol,
      };
    });
    const byPerf = shot.map((i) => {
      const inPay = intervals.reduce((s, p) => s + overlapFt(i, p), 0);
      return {
        top_ft: i.top,
        bottom_ft: i.bottom,
        open_hole: i.open_hole,
        length_ft: i.bottom - i.top,
        in_pay_ft: inPay,
        outside_pay_ft: i.bottom - i.top - inPay,
        disagrees: i.bottom - i.top - inPay > tol,
      };
    });

    return {
      ok: true as const,
      api: key,
      filing_date: newest.file_date,
      filings_on_hole: built.filings.length,
      tolerance_ft: tol,
      pay_intervals: byPay,
      perforations: byPerf,
      total_pay_ft: byPay.reduce((s, p) => s + p.thickness_ft, 0),
      total_perforated_ft: byPerf.reduce((s, p) => s + p.length_ft, 0),
      unshot_pay_ft: byPay.reduce((s, p) => s + p.unshot_ft, 0),
      perforated_outside_pay_ft: byPerf.reduce((s, p) => s + p.outside_pay_ft, 0),
      open_hole_completion: byPerf.some((p) => p.open_hole),
      agrees: !byPay.some((p) => p.disagrees) && !byPerf.some((p) => p.disagrees),
      guidance: [
        INTERNAL_ONLY,
        "Both sides are MEASURED DEPTH. The perforations are from the operator's own filing on this hole and the pay is from the log, and if the two are not hung on the same datum every number here is shifted by the difference. Run rrc_depth_reconcile first.",
        `Only the newest filing carrying perforations is used (${newest.file_date ?? "undated"}). This hole has ${built.filings.length} filing(s); an older completion is a different interval, not more of this one.`,
        byPerf.some((p) => p.open_hole)
          ? "This completion includes open hole, where there is nothing to shoot: unshot pay against an open-hole interval is not a missed zone."
          : "All intervals are cased and perforated.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 97

const pickReconcile = defineTool(
  "rrc_pick_reconcile",
  "Is my pick where the neighbours say it should be? A formation top picked on a log against what the offsets filed for the same formation, projected onto the fitted dip at this well.",
  {
    api: z.string(),
    formation: z.string(),
    log_pick_ft: z.number(),
    kb_ft: z.number().optional(),
    radius_mi: z.number().optional(),
    limit: z.number().int().optional(),
    field_name: z.string().optional(),
  },
  async (args) => {
    const key = args.api.trim();
    if (!key) return fail("api is required.");
    if (!args.formation.trim()) return fail("formation is required.");
    const point = await wellPoint(key);
    if (!point) return fail(`No surface location on file for ${key}.`);

    // The subject's own datum, which is what the log pick has to be hung on.
    let kb = args.kb_ft ?? null;
    if (kb == null) {
      const built = await getWellConstruction(key);
      kb = built?.filings.find((f) => f.elevation != null)?.elevation ?? null;
    }
    if (kb == null) {
      return fail(
        `No filed elevation for ${key} and no kb_ft given, so the log pick cannot be placed in subsea. Every comparison below would be a datum error, so none is made.`
      );
    }

    const { wells, truncated, radiusMi, datum: datumSet } = await population({ ...point, ...args });
    const others = wells.filter((w) => w.api_number !== key);
    const { placed, excluded } = byDatum(others);
    const points = placed.flatMap((w) => {
      const pick = pickOf(w, args.formation);
      const ss = subsea(w.kbElevationFt, pick);
      if (pick == null || ss == null) return [];
      const local = localFeet(point.lat, point.lon, w.bottomLat ?? w.lat, w.bottomLon ?? w.lon);
      return [
        {
          api: w.api_number,
          lease: w.lease_name,
          distance_mi: w.distanceMi,
          pick_ft: pick,
          kb_ft: w.kbElevationFt,
          subsea_ft: ss,
          ...local,
          z: ss,
        },
      ];
    });

    const logSubsea = kb - args.log_pick_ft;
    const fit = fitPlane(points);
    const projected = fit ? planeAt(fit, { x: 0, y: 0 }) : null;
    const flat = points.length ? (median(points.map((p) => p.subsea_ft)) as number) : null;
    const reference = projected ?? flat;

    return {
      ok: true as const,
      api: key,
      formation: args.formation,
      radius_mi: radiusMi,
      log: { pick_ft: args.log_pick_ft, kb_ft: kb, subsea_ft: logSubsea },
      offsets: {
        ...datumReport(others, excluded, datumSet),
        with_this_pick: points.length,
        truncated,
      },
      fit: fit
        ? {
            n: fit.n,
            r2: fit.r2,
            rmse_ft: fit.rmseFt,
            dip_deg: fit.dipDeg,
            dip_azimuth_deg: fit.dipAzimuthDeg,
            dip_ft_per_mile: fit.dipFtPerMile,
            projected_subsea_ft: projected,
          }
        : null,
      // A flat median is what is left when the offsets cannot constrain a dip.
      // Reported as a fallback, and labelled as one.
      fallback_median_subsea_ft: fit ? null : flat,
      residual_ft: reference == null ? null : logSubsea - reference,
      reads: reference == null ? null : logSubsea > reference ? "structurally HIGH to the offsets" : "structurally LOW to the offsets",
      offsets_detail: points.map((p) => ({
        api: p.api,
        lease_name: p.lease,
        distance_mi: p.distance_mi,
        filed_pick_ft: p.pick_ft,
        kb_ft: p.kb_ft,
        subsea_ft: p.subsea_ft,
        residual_to_plane_ft: fit ? p.subsea_ft - planeAt(fit, p) : null,
      })),
      guidance: [
        INTERNAL_ONLY,
        SUBSEA_NOTE,
        fit
          ? `Projected on a plane fitted to ${fit.n} offset picks, r2 ${fit.r2 == null ? "undefined" : fit.r2.toFixed(3)}, RMSE ${fit.rmseFt.toFixed(0)} ft. The residual is only as good as that surface.`
          : `Fewer than ${MIN_PLANE} usable offset picks, or they are collinear, so no dip could be fitted and the comparison is against a flat median. Structural position is NOT accounted for.`,
        "Each offset's depth is its own filing's, converted with its own elevation. Nothing is merged across wells.",
        DEVIATED_NOTE,
        "Formation names are matched loosely on the RRC's free-text pick names, so a nearby but different pick can enter the population. The per-offset list is there to be read.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 98

const structureSurface = defineTool(
  "rrc_structure_surface",
  "Which way does this formation dip and how deep will it be at a point I have not drilled? Fits a plane to the offsets' filed tops in subsea and projects it to a target.",
  {
    ...AREA_SHAPE,
    formation: z.string(),
    target_lat: z.number().optional(),
    target_lon: z.number().optional(),
    target_kb_ft: z.number().optional(),
  },
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    if (!args.formation.trim()) return fail("formation is required.");
    const { wells, truncated, radiusMi, datum: datumSet, centre } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat ?? args.api}.`);
    // A fitted plane needs an ORIGIN, and every local coordinate below is
    // measured from it. The resolved centre rather than the raw argument,
    // because the circle may have been named by a well rather than a point.
    if (!centre) return fail("No location on file to centre this fit on.");
    const origin = centre;

    const { placed, excluded } = byDatum(wells);
    const points = placed.flatMap((w) => {
      const pick = pickOf(w, args.formation);
      const ss = subsea(w.kbElevationFt, pick);
      if (pick == null || ss == null) return [];
      const local = localFeet(origin.lat, origin.lon, w.bottomLat ?? w.lat, w.bottomLon ?? w.lon);
      return [
        {
          api: w.api_number,
          operator_name: w.operator_name,
          lease_name: w.lease_name,
          distance_mi: w.distanceMi,
          filed_pick_ft: pick,
          kb_ft: w.kbElevationFt,
          subsea_ft: ss,
          ...local,
          z: ss,
        },
      ];
    });

    const report = { ...datumReport(wells, excluded, datumSet), with_this_pick: points.length, truncated };
    if (points.length < MIN_PLANE) {
      return {
        ...fail(
          `Only ${points.length} offset(s) filed a "${args.formation}" pick AND a datum inside ${radiusMi} mi. A plane needs ${MIN_PLANE}: three points fit exactly and would report r2 of 1 for a surface nothing tested.`
        ),
        population: report,
        usable_apis: points.map((p) => p.api),
      };
    }
    const fit = fitPlane(points);
    if (!fit) {
      return {
        ...fail(
          "These offsets are collinear, so they fix a dip magnitude along one line but no dip direction. Widen the radius until the population has width."
        ),
        population: report,
      };
    }

    const tLat = args.target_lat ?? origin.lat;
    const tLon = args.target_lon ?? origin.lon;
    const target = localFeet(origin.lat, origin.lon, tLat, tLon);
    const targetSubsea = planeAt(fit, target);
    const deviated = placed.filter(
      (w) => w.bottomLat != null && w.bottomLon != null && (Math.abs(w.bottomLat - w.lat) > 0.002 || Math.abs(w.bottomLon - w.lon) > 0.002)
    ).length;

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      formation: args.formation,
      field_name: args.field_name ?? null,
      population: report,
      fit: {
        n: fit.n,
        r2: fit.r2,
        rmse_ft: fit.rmseFt,
        dip_deg: fit.dipDeg,
        dip_azimuth_deg: fit.dipAzimuthDeg,
        dip_ft_per_mile: fit.dipFtPerMile,
      },
      target: {
        lat: tLat,
        lon: tLon,
        subsea_ft: targetSubsea,
        // Only offered when the caller supplies the target's own datum. Handing
        // back a measured depth against somebody else's KB is the exact error
        // this file exists to prevent.
        measured_depth_ft: args.target_kb_ft != null ? args.target_kb_ft - targetSubsea : null,
      },
      points: points.map((p) => ({
        api: p.api,
        operator_name: p.operator_name,
        lease_name: p.lease_name,
        distance_mi: p.distance_mi,
        filed_pick_ft: p.filed_pick_ft,
        kb_ft: p.kb_ft,
        subsea_ft: p.subsea_ft,
        residual_ft: p.subsea_ft - planeAt(fit, p),
      })),
      guidance: [
        INTERNAL_ONLY,
        SUBSEA_NOTE,
        `Fitted through ${fit.n} wells. RMSE ${fit.rmseFt.toFixed(0)} ft is the scatter about the plane: read it before the dip, because a 2 degree dip with 150 ft of residual is not a surface.`,
        "Dip azimuth is the compass bearing of steepest descent, so it points DOWNDIP.",
        deviated > 0
          ? `${deviated} of these wells have a bottomhole away from their surface hole and are placed at the bottomhole. A top picked on the way down was not made there.`
          : "All wells are placed at their surface hole; none files a distinct bottomhole.",
        DEVIATED_NOTE,
      ],
    };
  }
);

// ------------------------------------------------------------------ 99

/** Default: a majority-water test is what "this lease made water" means. */
const WET_CUT = 0.5;

interface ContactRow {
  api: string;
  lease_name: string | null;
  perf_top_subsea_ft: number;
  perf_bottom_subsea_ft: number;
  water_cut: number | null;
  daily_oil: number | null;
  daily_water: number | null;
  test_date: string | null;
  wet: boolean | null;
}

/** The rows both the contact tool and the coning tool are built on. */
function contactRows(wells: readonly OffsetWellbore[], tests: Map<string, OilTest>, threshold: number): ContactRow[] {
  return wells.flatMap((w) => {
    const env = perfEnvelope(w);
    const top = subsea(w.kbElevationFt, env?.top);
    const bottom = subsea(w.kbElevationFt, env?.bottom);
    if (top == null || bottom == null) return [];
    const t = tests.get(w.api_number);
    const cut = t ? waterCut(t) : null;
    return [
      {
        api: w.api_number,
        lease_name: w.lease_name,
        perf_top_subsea_ft: top,
        perf_bottom_subsea_ft: bottom,
        water_cut: cut,
        daily_oil: t?.daily_oil ?? null,
        daily_water: t?.daily_water ?? null,
        test_date: t?.test_date ?? null,
        wet: cut == null ? null : cut >= threshold,
      },
    ];
  });
}

/** The bracket the contact has to lie in, or the overlap saying there isn't one. */
function crossover(rows: readonly ContactRow[]) {
  const dry = rows.filter((r) => r.wet === false);
  const wet = rows.filter((r) => r.wet === true);
  if (!dry.length || !wet.length) return null;
  // Subsea gets more negative downward: the deepest dry base is the MINIMUM.
  const deepestDryBase = Math.min(...dry.map((r) => r.perf_bottom_subsea_ft));
  const shallowestWetTop = Math.max(...wet.map((r) => r.perf_top_subsea_ft));
  const clean_ = shallowestWetTop < deepestDryBase;
  return {
    dry: dry.length,
    wet: wet.length,
    deepest_dry_perf_subsea_ft: deepestDryBase,
    shallowest_wet_perf_subsea_ft: shallowestWetTop,
    clean: clean_,
    contact_subsea_ft: clean_ ? (deepestDryBase + shallowestWetTop) / 2 : null,
    // Positive feet of section where a wet perforation sits ABOVE a dry one.
    // Subsea decreases downward, so the wet top is the larger number here.
    overlap_ft: clean_ ? 0 : shallowestWetTop - deepestDryBase,
  };
}

const contactFromOffsets = defineTool(
  "rrc_contact_from_offsets",
  "How deep can I perforate before I am in water? Infers the oil-water contact from every offset's perforated interval in subsea, split on whether that well tested water.",
  { ...AREA_SHAPE, water_cut_threshold: z.number().optional() },
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const threshold = Math.min(0.99, Math.max(0.01, args.water_cut_threshold ?? WET_CUT));
    const { wells, truncated, radiusMi, datum: datumSet } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const { placed, excluded } = byDatum(wells);
    const tests = await oilTests(placed.map((w) => w.api_number), true);
    const latest = new Map<string, OilTest>();
    for (const t of tests) if (!latest.has(t.api)) latest.set(t.api, t);

    const rows = contactRows(placed, latest, threshold);
    const classified = rows.filter((r) => r.wet != null);
    if (classified.length < MIN_FIT) {
      return {
        ...failThinRecord(
          `Only ${classified.length} offset(s) have both a perforated interval in subsea and a W-10 that says whether they made water. ${MIN_FIT} are needed before a contact is anything but two wells.`
        ),
        population: { ...datumReport(wells, excluded, datumSet), with_perfs_and_test: classified.length },
      };
    }
    const cross = crossover(rows);
    /*
     * The bracket against the datum it was measured on.
     *
     * A contact is the midpoint of a gap between the deepest dry perforation and
     * the shallowest wet one, and every one of those depths was placed in subsea
     * through an elevation that carries a band. When the gap is narrower than the
     * band, the wells have not resolved a contact, they have agreed to within
     * their own error, and a midpoint quoted off that gap is a number with no
     * information in it. That is the third bucket: above, below, and TOO CLOSE
     * TO CALL.
     */
    const bandFt = datumSet.widestBandFt;
    const bracketFt =
      cross && cross.deepest_dry_perf_subsea_ft != null && cross.shallowest_wet_perf_subsea_ft != null
        ? Math.abs(cross.deepest_dry_perf_subsea_ft - cross.shallowest_wet_perf_subsea_ft)
        : null;
    const resolved = bracketFt != null && bracketFt > bandFt;

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      field_name: args.field_name ?? null,
      water_cut_threshold: threshold,
      population: {
        ...datumReport(wells, excluded, datumSet),
        with_perfs_in_subsea: rows.length,
        classified: classified.length,
        unclassified_no_test: rows.length - classified.length,
        truncated,
      },
      contact_subsea_ft: cross?.contact_subsea_ft ?? null,
      /** Plus or minus, from the datum the wells were placed on. */
      contact_band_ft: bandFt,
      /** False means the bracket is inside the datum error. See the note. */
      contact_resolved: resolved,
      bracket: cross
        ? {
            deepest_dry_perf_subsea_ft: cross.deepest_dry_perf_subsea_ft,
            shallowest_wet_perf_subsea_ft: cross.shallowest_wet_perf_subsea_ft,
            clean_crossover: cross.clean,
            overlap_ft: cross.overlap_ft,
          }
        : null,
      dry_wells: cross?.dry ?? 0,
      wet_wells: cross?.wet ?? 0,
      wells_detail: rows,
      guidance: [
        INTERNAL_ONLY,
        SUBSEA_NOTE,
        "The contact is the midpoint of the bracket between the deepest dry perforation and the shallowest wet one. It is a bracket, not a measurement: no well here logged a contact.",
        cross == null
          ? "Every classified well fell on one side, so there is no crossover to bracket. That usually means the radius is inside one fluid."
          : cross.clean
            ? "Clean crossover: no dry well is perforated below a wet one."
            : `The sets OVERLAP by ${Math.round(cross.overlap_ft)} ft, so no single contact fits these wells. Either the wells are in separate compartments, or a wet well is making water from a channel or a bad cement job rather than from below a contact.`,
        bracketFt != null && !resolved
          ? `THE CONTACT IS NOT RESOLVED. The bracket between the deepest dry perforation and the shallowest wet one is ${Math.round(bracketFt)} ft, and the datum these wells sit on carries plus or minus ${bandFt} ft. Everything in that range is TOO CLOSE TO CALL: the contact can sort a population, and it cannot pick a perforation depth. Use it to rank candidates, not to decide where to shoot one.`
          : `The bracket is ${bracketFt == null ? "not established" : Math.round(bracketFt)} ft against a datum band of plus or minus ${bandFt} ft, so the crossover is wider than the error in placing it.`,
        `"Made water" here is a W-10 water cut at or above ${threshold}. A test is one day, and a pumping well's cut moves with how hard it is pumped.`,
        "Gas wells are not classified: G-10 water volumes are not comparable to a W-10 water cut, so they are counted as untested rather than assumed dry.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 100

const coningEvidence = defineTool(
  "rrc_coning_evidence",
  "Will this well cone water if I shoot it low? Offsets' water cut trajectory against how far their perforations stand off the contact.",
  { ...AREA_SHAPE, contact_subsea_ft: z.number().optional(), water_cut_threshold: z.number().optional() },
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const threshold = Math.min(0.99, Math.max(0.01, args.water_cut_threshold ?? WET_CUT));
    const { wells, truncated, radiusMi, datum: datumSet } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const { placed, excluded } = byDatum(wells);
    const history = await oilTests(placed.map((w) => w.api_number), false);
    const byApi = groupBy(history, (t) => t.api);
    const latest = new Map<string, OilTest>();
    for (const t of history) if (!latest.has(t.api)) latest.set(t.api, t);

    let contact = args.contact_subsea_ft ?? null;
    let contactSource = "given by the caller";
    if (contact == null) {
      const cross = crossover(contactRows(placed, latest, threshold));
      contact = cross?.contact_subsea_ft ?? null;
      contactSource = cross?.clean
        ? "inferred from this same population's dry and wet perforations"
        : "could not be inferred: the dry and wet perforations overlap";
    }
    if (contact == null) {
      return {
        ...fail(
          `No contact to measure standoff from: none was given and none could be inferred here (${contactSource}). Run rrc_contact_from_offsets, or pass contact_subsea_ft.`
        ),
        population: datumReport(wells, excluded, datumSet),
      };
    }

    const rows = placed.flatMap((w) => {
      const env = perfEnvelope(w);
      const bottom = subsea(w.kbElevationFt, env?.bottom);
      const tests = (byApi.get(w.api_number) ?? []).slice().reverse(); // oldest first
      const points = tests
        .map((t) => ({ date: t.test_date, cut: waterCut(t) }))
        .filter((p): p is { date: string; cut: number } => p.date != null && p.cut != null);
      if (bottom == null || points.length < 3) return [];
      const start = points[0].date.slice(0, 7);
      const fit = linearFit(
        points.map((p) => {
          const [y, m] = p.date.slice(0, 7).split("-").map(Number);
          const [sy, sm] = start.split("-").map(Number);
          return [(y - sy) * 12 + (m - sm), p.cut] as const;
        })
      );
      return [
        {
          api: w.api_number,
          lease_name: w.lease_name,
          perf_bottom_subsea_ft: bottom,
          // Positive: the perforations stop above the contact.
          standoff_ft: bottom - (contact as number),
          tests: points.length,
          first_test: points[0].date,
          last_test: points[points.length - 1].date,
          first_water_cut: points[0].cut,
          last_water_cut: points[points.length - 1].cut,
          water_cut_rise_per_year: fit ? fit.slope * 12 : null,
          trend_r2: fit?.r2 ?? null,
        },
      ];
    });

    if (rows.length < MIN_FIT) {
      return {
        ...fail(
          `Only ${rows.length} offset(s) have a datum, a perforated interval and at least three W-10 tests. ${MIN_FIT} are needed to relate a water trend to standoff.`
        ),
        contact_subsea_ft: contact,
        population: datumReport(wells, excluded, datumSet),
      };
    }

    const against = linearFit(
      rows
        .filter((r) => r.water_cut_rise_per_year != null)
        .map((r) => [r.standoff_ft, r.water_cut_rise_per_year as number] as const)
    );

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      contact_subsea_ft: contact,
      contact_source: contactSource,
      population: { ...datumReport(wells, excluded, datumSet), with_trend: rows.length, truncated },
      fit: {
        n: against?.n ?? 0,
        slope_cut_per_year_per_ft_standoff: against?.slope ?? null,
        r2: against?.r2 ?? null,
      },
      reads:
        against == null
          ? null
          : against.slope < 0
            ? "Water rises FASTER in wells perforated closer to the contact, which is what coning looks like."
            : "Water does not rise faster near the contact in this population, so the water is more likely coming along the interval than up from below.",
      wells_detail: rows.sort((a, b) => a.standoff_ft - b.standoff_ft),
      guidance: [
        INTERNAL_ONLY,
        SUBSEA_NOTE,
        "Standoff is the base of the perforations above the contact, positive upward. A negative standoff means the well is perforated below the contact, where water is not coning, it is simply there.",
        "A rising water cut across a decade of W-10 tests is consistent with coning and with a dozen other things: an encroaching flood, a casing leak, a lease going to pump. The correlation with standoff is the only part that argues for coning.",
        TEST_READS_HIGH,
      ],
    };
  }
);

// ------------------------------------------------------------------ 101

const depletionMap = defineTool(
  "rrc_depletion_map",
  "How much of this reservoir is already gone? Shut-in pressures across an area by test year and by well vintage, showing how far it has drawn down.",
  AREA_SHAPE,
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const { wells, truncated, radiusMi } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const apis = wells.map((w) => w.api_number);
    const [history, keys] = await Promise.all([gasTests(apis, false), wellKeys(apis)]);
    const usable = history.filter((t) => t.siwh_press != null && t.siwh_press > 0 && t.test_date);
    if (usable.length < MIN_FIT) {
      return {
        ...fail(
          `Only ${usable.length} G-10 shut-in pressure(s) on file inside ${radiusMi} mi. ${MIN_FIT} are needed before a depletion trend means anything. G-10 covers gas wells only.`
        ),
        wells_in_radius: wells.length,
      };
    }

    // Depth per well, for the psi-per-foot normalisation. A field with wells on
    // two different intervals otherwise shows a "pressure trend" that is only
    // the depth mix changing.
    const depth = new Map<string, number>();
    for (const w of wells) {
      const env = perfEnvelope(w);
      const ss = subsea(w.kbElevationFt, env ? (env.top + env.bottom) / 2 : null);
      if (ss != null) depth.set(w.api_number, -ss);
    }

    const byYear = groupBy(usable, (t) => (t.test_date as string).slice(0, 4));
    const years = [...byYear.entries()]
      .map(([year, rows]) => {
        const norm = rows
          .map((r) => (depth.get(r.api) ? (r.siwh_press as number) / (depth.get(r.api) as number) : null))
          .filter((v): v is number => v != null);
        return {
          year: Number(year),
          tests: rows.length,
          wells: new Set(rows.map((r) => r.api)).size,
          median_siwh_psi: median(clean(rows.map((r) => r.siwh_press))),
          median_psi_per_ft: median(norm),
          normalised_tests: norm.length,
        };
      })
      .sort((a, b) => a.year - b.year);

    const overTime = linearFit(
      years.filter((y) => y.median_psi_per_ft != null).map((y) => [y.year, y.median_psi_per_ft as number] as const)
    );

    // The vintage signal: each well's FIRST filed pressure against the year it
    // was completed. A field draining shows later wells arriving to less.
    const firstTest = new Map<string, GasTest>();
    for (const t of usable) firstTest.set(t.api, t); // rows arrive newest first
    const vintage = [...firstTest.entries()].flatMap(([api, t]) => {
      const completed = date8(keys.get(api)?.completion_date);
      const d = depth.get(api);
      if (!completed) return [];
      return [
        {
          api,
          completion_year: completed.year,
          first_test_date: t.test_date,
          siwh_psi: t.siwh_press,
          psi_per_ft: d ? (t.siwh_press as number) / d : null,
        },
      ];
    });
    const byVintage = linearFit(
      vintage.filter((v) => v.psi_per_ft != null).map((v) => [v.completion_year, v.psi_per_ft as number] as const)
    );

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      field_name: args.field_name ?? null,
      wells_in_radius: wells.length,
      wells_with_pressure: new Set(usable.map((t) => t.api)).size,
      tests: usable.length,
      wells_without_depth: wells.length - depth.size,
      by_test_year: years,
      trend_over_time: {
        n: overTime?.n ?? 0,
        psi_per_ft_per_year: overTime?.slope ?? null,
        r2: overTime?.r2 ?? null,
      },
      by_vintage: vintage.sort((a, b) => a.completion_year - b.completion_year),
      trend_by_vintage: {
        n: byVintage?.n ?? 0,
        psi_per_ft_per_completion_year: byVintage?.slope ?? null,
        r2: byVintage?.r2 ?? null,
      },
      truncated,
      guidance: [
        INTERNAL_ONLY,
        "SIWH is a shut-in WELLHEAD pressure, not a reservoir pressure. It tracks depletion well and states its level badly.",
        "Normalised by each well's own perforation midpoint below sea level, so wells on different intervals can sit in one trend. Wells with no filed elevation have no depth and appear only in the raw median.",
        "Two different questions: by test year is the field losing pressure over calendar time; by vintage is each new well arriving to less pressure than the last. They can disagree, and the disagreement is informative.",
        "G-10 is a GAS well form. An area of oil wells has no pressure history here at all, and that is an absence of filings, not an absence of depletion.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 102

const payCalibration = defineTool(
  "rrc_pay_calibration",
  "What subsea window actually pays around here? The interval offset perforations produced from against the interval that did not, as an empirical depth cutoff.",
  { ...AREA_SHAPE, oil_cutoff_bopd: z.number().optional(), gas_cutoff_mcfd: z.number().optional() },
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const oilCut = Math.max(0, args.oil_cutoff_bopd ?? 5);
    const gasCut = Math.max(0, args.gas_cutoff_mcfd ?? 50);
    const { wells, truncated, radiusMi, datum: datumSet } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const { placed, excluded } = byDatum(wells);
    const apis = placed.map((w) => w.api_number);
    const [oil, gas] = await Promise.all([oilTests(apis, true), gasTests(apis, true)]);
    const oilBy = new Map<string, OilTest>();
    for (const t of oil) if (!oilBy.has(t.api)) oilBy.set(t.api, t);
    const gasBy = new Map<string, GasTest>();
    for (const t of gas) if (!gasBy.has(t.api)) gasBy.set(t.api, t);

    const rows = placed.flatMap((w) => {
      const env = perfEnvelope(w);
      const top = subsea(w.kbElevationFt, env?.top);
      const bottom = subsea(w.kbElevationFt, env?.bottom);
      if (top == null || bottom == null) return [];
      const o = oilBy.get(w.api_number);
      const g = gasBy.get(w.api_number);
      const bopd = o?.daily_oil ?? null;
      const mcfd = g?.daily_gas ?? null;
      const produced =
        bopd == null && mcfd == null ? null : (bopd ?? 0) >= oilCut || (mcfd ?? 0) >= gasCut;
      return [
        {
          api: w.api_number,
          lease_name: w.lease_name,
          perf_top_subsea_ft: top,
          perf_bottom_subsea_ft: bottom,
          perf_mid_subsea_ft: (top + bottom) / 2,
          net_perf_ft: perfNetFt(w),
          formation_at_perf_top: env ? formationAt(w, env.top) : null,
          daily_oil_bbl: bopd,
          daily_gas_mcf: mcfd,
          produced,
        },
      ];
    });

    const producers = rows.filter((r) => r.produced === true);
    const duds = rows.filter((r) => r.produced === false);
    if (producers.length < MIN_FIT) {
      return {
        ...fail(
          `Only ${producers.length} offset(s) in this radius have a datum, perforations and a test above the cutoff. ${MIN_FIT} are needed before a producing window is a window.`
        ),
        population: { ...datumReport(wells, excluded, datumSet), with_perfs_in_subsea: rows.length },
      };
    }

    const pTop = spread(producers.map((r) => r.perf_top_subsea_ft));
    const pBase = spread(producers.map((r) => r.perf_bottom_subsea_ft));
    const dMid = spread(duds.map((r) => r.perf_mid_subsea_ft));

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      field_name: args.field_name ?? null,
      cutoffs: { oil_bopd: oilCut, gas_mcfd: gasCut },
      population: {
        ...datumReport(wells, excluded, datumSet),
        with_perfs_in_subsea: rows.length,
        producers: producers.length,
        non_producers: duds.length,
        untested: rows.filter((r) => r.produced == null).length,
        truncated,
      },
      producing_window_subsea_ft: {
        // The middle 80% of producing tops and bases: the empirical target.
        top_pct10: pTop.pct10,
        top_median: pTop.median,
        top_pct90: pTop.pct90,
        base_pct10: pBase.pct10,
        base_median: pBase.median,
        base_pct90: pBase.pct90,
      },
      non_producer_midpoints_subsea_ft: dMid,
      producer_net_perf_ft: spread(clean(producers.map((r) => r.net_perf_ft))),
      wells_detail: rows.sort((a, b) => b.perf_mid_subsea_ft - a.perf_mid_subsea_ft),
      guidance: [
        INTERNAL_ONLY,
        SUBSEA_NOTE,
        NO_LOG_DATA,
        "This is a STRUCTURAL cutoff: the subsea window that produced around here. It says nothing about porosity or saturation, and a well can sit inside the window and still be wet or tight.",
        "Non-producers are a biased sample. Wells drilled outside the window mostly were not completed at all, so they never appear as a perforated interval that failed.",
        TEST_READS_HIGH,
      ],
    };
  }
);

// ------------------------------------------------------------------ 103

const analogTypeCurve = defineTool(
  "rrc_analog_type_curve",
  "What should a well completed in this interval make? Rate and cumulative distributions for the leases of offsets completed in the same formation and subsea window.",
  {
    ...AREA_SHAPE,
    formation: z.string().optional(),
    interval_top_subsea_ft: z.number().optional(),
    interval_bottom_subsea_ft: z.number().optional(),
    months: z.number().int().optional(),
  },
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const months = Math.min(240, Math.max(12, Math.floor(args.months ?? 60)));
    const { wells, truncated, radiusMi, datum: datumSet } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const { placed, excluded } = byDatum(wells);
    const wanted = placed.filter((w) => {
      const env = perfEnvelope(w);
      if (!env) return false;
      if (args.formation?.trim()) {
        // The zone the perforations are IN, per this well's own picks.
        const at = formationAt(w, env.top);
        if (!at || !at.toUpperCase().includes(args.formation.trim().toUpperCase())) return false;
      }
      const mid = subsea(w.kbElevationFt, (env.top + env.bottom) / 2);
      if (mid == null) return false;
      if (args.interval_top_subsea_ft != null && mid > args.interval_top_subsea_ft) return false;
      if (args.interval_bottom_subsea_ft != null && mid < args.interval_bottom_subsea_ft) return false;
      return true;
    });
    if (!wanted.length) {
      return {
        ...fail("No offset in this radius has a datum, perforations and matches the formation or interval given."),
        population: datumReport(wells, excluded, datumSet),
      };
    }

    const keys = await wellKeys(wanted.map((w) => w.api_number));
    const series = await leaseSeries([...keys.values()]);
    if (series.byLease.size < 3) {
      return {
        ...fail(
          `Only ${series.byLease.size} lease(s) behind these offsets have reported production. A type curve from fewer than 3 is one lease with error bars drawn on it.`
        ),
        population: datumReport(wells, excluded, datumSet),
        leases: series.byLease.size,
      };
    }

    // Normalised to each lease's own first producing month, which is the only
    // start a type curve can share.
    const curves = [...series.byLease.entries()].map(([lease, points]) => {
      const rates = dailyOil(points);
      const firstIdx = rates.findIndex((r) => r.rate > 0);
      const from = firstIdx < 0 ? [] : rates.slice(firstIdx, firstIdx + months);
      // Cumulatives come off the filed monthly VOLUMES, not off the daily rates
      // times an average month, so a lease's cumulative here equals the sum of
      // its reported months exactly.
      const volumes = firstIdx < 0 ? [] : points.slice(firstIdx, firstIdx + months);
      return {
        lease,
        wells_on_lease: series.apisByLease.get(lease)?.length ?? 0,
        months: from.length,
        rates: from.map((r) => r.rate),
        cum_12mo: volumes.slice(0, 12).reduce((s, p) => s + p.oil + p.cond, 0),
        cum_total: volumes.reduce((s, p) => s + p.oil + p.cond, 0),
        fit: fitDecline(from),
      };
    }).filter((c) => c.months > 0);

    const width = Math.max(...curves.map((c) => c.months));
    const curve = Array.from({ length: Math.min(width, months) }, (_, i) => {
      const at = clean(curves.map((c) => (i < c.rates.length ? c.rates[i] : null)));
      return {
        month: i + 1,
        leases: at.length,
        pct10: percentile(at, 0.1),
        median: median(at),
        pct90: percentile(at, 0.9),
      };
    });
    // fitDecline wants real cycles; only the SPACING matters for a normalised
    // curve, so the calendar here is a placeholder and is not reported.
    const medianCurve: MonthlyRate[] = curve
      .filter((c) => c.median != null)
      .map((c, i) => ({ month: addMonths("2000-01", i), rate: c.median as number }));
    const medianFit = fitDecline(medianCurve);

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      formation: args.formation ?? null,
      interval_subsea_ft: {
        top: args.interval_top_subsea_ft ?? null,
        bottom: args.interval_bottom_subsea_ft ?? null,
      },
      population: {
        ...datumReport(wells, excluded, datumSet),
        matching_offsets: wanted.length,
        leases: curves.length,
        leases_found: series.leases,
        leases_truncated: series.truncated,
        truncated,
      },
      reported_through: series.reportedThrough,
      curve,
      cumulative_bbl: {
        first_12_months: spread(curves.map((c) => c.cum_12mo)),
        to_date: spread(curves.map((c) => c.cum_total)),
      },
      decline: {
        leases_fitted: curves.filter((c) => c.fit).length,
        di_per_year: spread(clean(curves.map((c) => c.fit?.Di ?? null))),
        b: spread(clean(curves.map((c) => c.fit?.b ?? null))),
        median_curve_fit: medianFit
          ? { qi: medianFit.qi, Di: medianFit.Di, b: medianFit.b, months: medianFit.months }
          : null,
      },
      leases_detail: curves.map((c) => ({
        lease: c.lease,
        wells_on_lease: c.wells_on_lease,
        months: c.months,
        cum_12mo_bbl: c.cum_12mo,
        cum_total_bbl: c.cum_total,
        di_per_year: c.fit?.Di ?? null,
        b: c.fit?.b ?? null,
      })),
      guidance: [
        INTERNAL_ONLY,
        LEASE_GRAIN,
        "Each curve is a LEASE, and leases carry different well counts. `wells_on_lease` is on every row for exactly that reason: a six-well lease is not a type well.",
        "pct90 is the high case in the ordinary statistical sense. Industry P10 means the same curve.",
        "Rates are oil plus condensate, per calendar day of the reporting month.",
        `Measured through ${series.reportedThrough}; the unfiled tail is dropped, not fitted.`,
        "The decline model is the app's own Arps fit, so a number here and a number on a well page cannot disagree.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 104

const completionResponse = defineTool(
  "rrc_completion_response",
  "Does shooting more feet actually make more oil here? Offset test rate regressed against perforated length, perforated interval and completion vintage, one driver at a time.",
  AREA_SHAPE,
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const { wells, truncated, radiusMi, datum: datumSet } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const { placed, excluded } = byDatum(wells);
    const apis = placed.map((w) => w.api_number);
    const [oil, gas, keys] = await Promise.all([
      oilTests(apis, true),
      gasTests(apis, true),
      wellKeys(apis),
    ]);
    const oilBy = new Map<string, OilTest>();
    for (const t of oil) if (!oilBy.has(t.api)) oilBy.set(t.api, t);
    const gasBy = new Map<string, GasTest>();
    for (const t of gas) if (!gasBy.has(t.api)) gasBy.set(t.api, t);

    const rows = placed.flatMap((w) => {
      const env = perfEnvelope(w);
      const net = perfNetFt(w);
      const mid = subsea(w.kbElevationFt, env ? (env.top + env.bottom) / 2 : null);
      const o = oilBy.get(w.api_number);
      const g = gasBy.get(w.api_number);
      const rate = o?.daily_oil ?? null;
      const gasRate = g?.daily_gas ?? null;
      if (net == null || mid == null || (rate == null && gasRate == null)) return [];
      const completed = date8(keys.get(w.api_number)?.completion_date);
      return [
        {
          api: w.api_number,
          lease_name: w.lease_name,
          net_perf_ft: net,
          perf_intervals: w.perforations.length,
          perf_mid_subsea_ft: mid,
          open_hole: w.perforations.some((p) => p.openHole),
          completion_year: completed?.year ?? null,
          daily_oil_bbl: rate,
          daily_gas_mcf: gasRate,
          bopd_per_perf_ft: rate != null && net > 0 ? rate / net : null,
        },
      ];
    });
    const withOil = rows.filter((r) => r.daily_oil_bbl != null);
    if (withOil.length < MIN_FIT) {
      return {
        ...fail(
          `Only ${withOil.length} offset(s) have a datum, a perforation record and a W-10 rate. ${MIN_FIT} are needed before a regression is worth reading.`
        ),
        population: { ...datumReport(wells, excluded, datumSet), with_rate_and_perfs: rows.length },
      };
    }

    const driver = (name: string, x: (r: (typeof withOil)[number]) => number | null) => {
      const pairs = withOil
        .map((r) => [x(r), r.daily_oil_bbl as number] as const)
        .filter((p): p is readonly [number, number] => p[0] != null);
      const fit = linearFit(pairs);
      return {
        driver: name,
        n: pairs.length,
        slope_bopd_per_unit: fit?.slope ?? null,
        r2: fit?.r2 ?? null,
      };
    };

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      field_name: args.field_name ?? null,
      population: { ...datumReport(wells, excluded, datumSet), with_rate_and_perfs: rows.length, truncated },
      drivers: [
        driver("net_perforated_ft", (r) => r.net_perf_ft),
        driver("perforated_intervals", (r) => r.perf_intervals),
        driver("perf_mid_subsea_ft", (r) => r.perf_mid_subsea_ft),
        driver("completion_year", (r) => r.completion_year),
      ],
      bopd_per_perf_ft: spread(clean(withOil.map((r) => r.bopd_per_perf_ft))),
      shots_per_ft: null,
      not_carried: ["shot density", "charge type", "stimulation volume", "proppant"],
      wells_detail: rows,
      guidance: [
        INTERNAL_ONLY,
        "SHOT DENSITY IS NOT IN THE RECORD. rrc.wb_perf carries a top, a bottom and an open-hole flag and nothing else: no shots per foot, no gun size, no stimulation. Perforated length is the closest the public file gets, and it is not the same variable.",
        "One driver at a time. These are univariate fits on a small confounded population: deeper wells are also newer wells and are also longer completions, and no slope here separates them.",
        TEST_READS_HIGH,
        SUBSEA_NOTE,
      ],
    };
  }
);

// ------------------------------------------------------------------ 105

interface PerfFiling {
  api: string;
  file_date: string | null;
  top_ft: number | null;
  bottom_ft: number | null;
  intervals: number;
}

const recompletionOutcomes = defineTool(
  "rrc_recompletion_outcomes",
  "Did recompletions in this zone work? Offsets that re-shot it, with each lease's production before and after the filing that did it.",
  {
    ...AREA_SHAPE,
    zone_top_ft: z.number().optional(),
    zone_bottom_ft: z.number().optional(),
    months: z.number().int().optional(),
  },
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const window = Math.min(36, Math.max(3, Math.floor(args.months ?? 12)));
    const { wells, truncated, radiusMi } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const apis = wells.map((w) => w.api_number);
    // Perforations by FILING for the whole population in one round trip. The
    // filing grain is the point: a second set of perforations under a later date
    // IS the recompletion, and unioning them would erase the event.
    const filings = await rrcQuery<PerfFiling>(
      `select trim(api_number) as api, to_char(file_date, 'YYYY-MM-DD') as file_date,
              min(top_ft) as top_ft, max(bottom_ft) as bottom_ft, count(*)::int as intervals
         from rrc.wb_perf
        where api_number = any($1::bpchar[]) and top_ft > 0
        group by api_number, file_date
        order by api_number, file_date`,
      [apis]
    );
    const byApi = groupBy(filings, (f) => f.api);
    const events = [...byApi.entries()].flatMap(([api, rows]) => {
      const dated = rows.filter((r) => r.file_date);
      if (dated.length < 2) return [];
      const previous = dated[dated.length - 2];
      const latest = dated[dated.length - 1];
      if (args.zone_top_ft != null && (latest.bottom_ft ?? 0) < args.zone_top_ft) return [];
      if (args.zone_bottom_ft != null && (latest.top_ft ?? 1e9) > args.zone_bottom_ft) return [];
      return [{ api, previous, latest, filings: dated.length }];
    });
    if (!events.length) {
      return {
        ...fail(
          `No well inside ${radiusMi} mi carries perforations under two different filing dates${args.zone_top_ft != null || args.zone_bottom_ft != null ? " in the zone given" : ""}, so there is no recompletion to measure.`
        ),
        wells_in_radius: wells.length,
        wells_with_perf_filings: byApi.size,
      };
    }

    const keys = await wellKeys(events.map((e) => e.api));
    const series = await leaseSeries([...keys.values()]);
    const leaseOf = new Map<string, string>();
    for (const [lease, list] of series.apisByLease) for (const api of list) leaseOf.set(api, lease);

    const rows = events.map((e) => {
      const lease = leaseOf.get(e.api);
      const points = lease ? series.byLease.get(lease) ?? [] : [];
      const at = (e.latest.file_date as string).slice(0, 7);
      const rates = dailyOil(points);
      const before = rates.filter((r) => r.month < at && r.month >= addMonths(at, -window));
      const after = rates.filter((r) => r.month >= at && r.month < addMonths(at, window));
      const avg = (rs: MonthlyRate[]) => (rs.length ? rs.reduce((s, r) => s + r.rate, 0) / rs.length : null);
      const b = avg(before);
      const a = avg(after);
      return {
        api: e.api,
        lease: lease ?? null,
        wells_on_lease: lease ? series.apisByLease.get(lease)?.length ?? null : null,
        perf_filings: e.filings,
        previous_filing: { date: e.previous.file_date, top_ft: e.previous.top_ft, bottom_ft: e.previous.bottom_ft },
        recompletion_filing: { date: e.latest.file_date, top_ft: e.latest.top_ft, bottom_ft: e.latest.bottom_ft },
        moved_uphole:
          e.latest.top_ft != null && e.previous.top_ft != null ? e.latest.top_ft < e.previous.top_ft : null,
        months_before: before.length,
        months_after: after.length,
        before_bopd: b,
        after_bopd: a,
        change_bopd: b != null && a != null ? a - b : null,
        ratio: b != null && a != null && b > 0 ? a / b : null,
      };
    });
    const measured = rows.filter((r) => r.ratio != null);

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      window_months: window,
      zone_ft: { top: args.zone_top_ft ?? null, bottom: args.zone_bottom_ft ?? null },
      reported_through: series.reportedThrough,
      wells_in_radius: wells.length,
      recompletions: rows.length,
      measured: measured.length,
      improved: measured.filter((r) => (r.ratio as number) > 1).length,
      median_ratio: median(measured.map((r) => r.ratio as number)),
      wells_detail: rows,
      truncated,
      guidance: [
        INTERNAL_ONLY,
        LEASE_GRAIN,
        "This is the strongest caveat in the tool: the before and after are the LEASE's oil, so a lease with six wells shows one well's recompletion diluted six ways, and another well's workover in the same window lands in the same number. `wells_on_lease` is on every row.",
        "A recompletion is inferred from a second set of perforations filed under a later date on the same hole. A refiled or corrected form looks the same and is not an event.",
        "Depths are measured depth on that hole's own filings, uncorrected, because both sides come from the same well.",
        `Measured through ${series.reportedThrough}; a recompletion inside the last few cycles has no "after" yet.`,
      ],
    };
  }
);

// ------------------------------------------------------------------ 106

const zoneFailureMap = defineTool(
  "rrc_zone_failure_map",
  "Where do completions here FAIL? Formations that offsets logged, shot and then plugged quickly. This is the base rate: call it before recommending a zone.",
  { ...AREA_SHAPE, quick_years: z.number().optional() },
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const quickYears = Math.min(40, Math.max(1, args.quick_years ?? 5));
    const { wells, truncated, radiusMi } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const keys = await wellKeys(wells.map((w) => w.api_number));
    // Formation assignment happens inside each well, in its own measured depth,
    // so this tool needs no datum and excludes nobody for lacking one.
    const rows = wells.flatMap((w) => {
      const env = perfEnvelope(w);
      if (!env) return [];
      const formation = formationAt(w, env.top);
      if (!formation) return [];
      const k = keys.get(w.api_number);
      const completed = date8(k?.completion_date);
      const plugged = date8(k?.plug_date);
      const life = completed && plugged ? (plugged.months - completed.months) / 12 : null;
      return [
        {
          api: w.api_number,
          lease_name: w.lease_name,
          formation,
          perf_top_ft: env.top,
          perf_bottom_ft: env.bottom,
          perf_top_subsea_ft: subsea(w.kbElevationFt, env.top),
          completion_date: completed?.iso ?? null,
          plug_date: plugged?.iso ?? null,
          years_to_plug: life,
          plugged_quickly: life != null ? life <= quickYears : null,
        },
      ];
    });
    if (!rows.length) {
      return {
        ...failThinRecord("No well in this radius carries both perforations and a formation pick above them, so no perforation can be attributed to a zone."),
        wells_in_radius: wells.length,
      };
    }

    const byFormation = [...groupBy(rows, (r) => r.formation).entries()]
      .map(([formation, list]) => {
        const lives = clean(list.map((r) => r.years_to_plug));
        const quick = list.filter((r) => r.plugged_quickly === true).length;
        return {
          formation,
          wells_shot: list.length,
          wells_plugged: list.filter((r) => r.plug_date != null).length,
          wells_plugged_quickly: quick,
          quick_share: list.length ? quick / list.length : null,
          median_years_to_plug: median(lives),
          still_unplugged: list.filter((r) => r.plug_date == null).length,
        };
      })
      .sort((a, b) => (b.quick_share ?? 0) - (a.quick_share ?? 0));

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      field_name: args.field_name ?? null,
      quick_years: quickYears,
      wells_in_radius: wells.length,
      wells_attributed: rows.length,
      by_formation: byFormation,
      wells_detail: rows,
      truncated,
      guidance: [
        INTERNAL_ONLY,
        "The formation is the deepest pick this well filed ABOVE its own shallowest perforation, taken from that well's own forms. Nothing is matched against another well's picks and no datum conversion is involved.",
        `"Quickly" is ${quickYears} year(s) from completion to plug.`,
        "A plug is an abandonment decision, not a verdict on rock. Operators plug good wells when a P-5 lapses, when 14(b)(2) compliance forces it, and when they go under. A high share here is a place to look, not a conclusion.",
        "Wells still producing are counted in `wells_shot` and not in `wells_plugged`, so a young formation looks better than an old one on the same rock.",
        "Formation names are the operator's own free text and are not normalised. TWO SPELLINGS OF ONE ZONE COUNT AS TWO ZONES.",
      ],
    };
  }
);

// ------------------------------------------------------------------ 107

const gorByDepth = defineTool(
  "rrc_gor_by_depth",
  "Is there a gas cap over this oil, and at what depth? Gas-oil ratio against subsea depth across an area.",
  { ...AREA_SHAPE, band_ft: z.number().optional() },
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const band = Math.min(2000, Math.max(50, args.band_ft ?? 250));
    const { wells, truncated, radiusMi, datum: datumSet } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const { placed, excluded } = byDatum(wells);
    const [oil, gas] = await Promise.all([
      oilTests(placed.map((w) => w.api_number), true),
      gasTests(placed.map((w) => w.api_number), true),
    ]);
    const oilBy = new Map<string, OilTest>();
    for (const t of oil) if (!oilBy.has(t.api)) oilBy.set(t.api, t);
    const gasBy = new Map<string, GasTest>();
    for (const t of gas) if (!gasBy.has(t.api)) gasBy.set(t.api, t);

    const rows = placed.flatMap((w) => {
      const env = perfEnvelope(w);
      const mid = subsea(w.kbElevationFt, env ? (env.top + env.bottom) / 2 : null);
      if (mid == null) return [];
      const o = oilBy.get(w.api_number);
      const gor = o ? gorOf(o) : null;
      if (gor == null || gor <= 0) return [];
      return [
        {
          api: w.api_number,
          lease_name: w.lease_name,
          perf_mid_subsea_ft: mid,
          gor_cf_per_bbl: gor,
          daily_oil_bbl: o?.daily_oil ?? null,
          daily_gas_mcf: o?.daily_gas ?? null,
          test_date: o?.test_date ?? null,
        },
      ];
    });
    if (rows.length < MIN_FIT) {
      return {
        ...fail(
          `Only ${rows.length} offset(s) have a datum, perforations and a W-10 that yields a gas-oil ratio. ${MIN_FIT} are needed before a depth trend is a trend.`
        ),
        population: { ...datumReport(wells, excluded, datumSet), with_gor: rows.length },
      };
    }

    // Fitted in log space: GOR spans orders of magnitude and a straight line
    // through raw values is one gassy well deciding the slope.
    const fit = linearFit(rows.map((r) => [r.perf_mid_subsea_ft, Math.log10(r.gor_cf_per_bbl)] as const));
    const fieldMedian = median(rows.map((r) => r.gor_cf_per_bbl)) as number;
    const bands = [...groupBy(rows, (r) => String(Math.floor(r.perf_mid_subsea_ft / band) * band)).entries()]
      .map(([floor, list]) => ({
        subsea_from_ft: Number(floor) + band,
        subsea_to_ft: Number(floor),
        wells: list.length,
        median_gor_cf_per_bbl: median(list.map((r) => r.gor_cf_per_bbl)),
      }))
      .sort((a, b) => b.subsea_to_ft - a.subsea_to_ft);

    // The gas cap reads as a shallow run of bands sitting well above the field.
    const gassy = bands.filter((b) => (b.median_gor_cf_per_bbl ?? 0) >= 3 * fieldMedian);
    const capBase = gassy.length ? Math.min(...gassy.map((b) => b.subsea_to_ft)) : null;

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      field_name: args.field_name ?? null,
      band_ft: band,
      population: { ...datumReport(wells, excluded, datumSet), with_gor: rows.length, truncated },
      median_gor_cf_per_bbl: fieldMedian,
      fit: {
        n: fit?.n ?? 0,
        log10_gor_per_ft_subsea: fit?.slope ?? null,
        r2: fit?.r2 ?? null,
      },
      // Positive slope on subsea (which increases upward) means gassier shallower.
      reads:
        fit == null
          ? null
          : fit.slope > 0
            ? "Gas-oil ratio rises upward, consistent with gas sitting above oil."
            : "Gas-oil ratio does not rise upward here, so this population shows no gas cap.",
      gas_cap_base_subsea_ft: capBase,
      gas_cap_threshold_cf_per_bbl: 3 * fieldMedian,
      by_band: bands,
      wells_detail: rows.sort((a, b) => b.perf_mid_subsea_ft - a.perf_mid_subsea_ft),
      guidance: [
        INTERNAL_ONLY,
        SUBSEA_NOTE,
        "Gas-oil ratio is the W-10's own figure where filed, else the test's gas over its oil. Gas wells file a G-10 gas-LIQUID ratio, which is a different quantity against condensate, and they are not mixed in here.",
        "A high shallow ratio is consistent with a gas cap and also with a well making gas from a shallower zone through bad cement. The band table is there so one well cannot carry the call.",
        "Depth is the perforation midpoint, so a well open across 400 ft is placed at a point it is not.",
        TEST_READS_HIGH,
      ],
    };
  }
);

// ------------------------------------------------------------------ 108

const productivityIndex = defineTool(
  "rrc_productivity_index",
  "Which formation gives the most oil per foot perforated? Tested rate per perforated foot by formation across the offsets, with the spread inside each.",
  AREA_SHAPE,
  async (args) => {
    const missing = noPopulation(args);
    if (missing) return fail(missing);
    const { wells, truncated, radiusMi } = await population(args);
    if (!wells.length) return fail(`No wells within ${radiusMi} mi of ${args.lat}, ${args.lon}.`);

    const apis = wells.map((w) => w.api_number);
    const [oil, gas] = await Promise.all([oilTests(apis, true), gasTests(apis, true)]);
    const oilBy = new Map<string, OilTest>();
    for (const t of oil) if (!oilBy.has(t.api)) oilBy.set(t.api, t);
    const gasBy = new Map<string, GasTest>();
    for (const t of gas) if (!gasBy.has(t.api)) gasBy.set(t.api, t);

    const rows = wells.flatMap((w) => {
      const env = perfEnvelope(w);
      const net = perfNetFt(w);
      if (!env || net == null || net <= 0) return [];
      const formation = formationAt(w, env.top);
      const o = oilBy.get(w.api_number);
      const g = gasBy.get(w.api_number);
      if (!o && !g) return [];
      return [
        {
          api: w.api_number,
          lease_name: w.lease_name,
          formation,
          net_perf_ft: net,
          perf_top_subsea_ft: subsea(w.kbElevationFt, env.top),
          daily_oil_bbl: o?.daily_oil ?? null,
          daily_gas_mcf: g?.daily_gas ?? o?.daily_gas ?? null,
          bopd_per_perf_ft: o?.daily_oil != null ? o.daily_oil / net : null,
          mcfd_per_perf_ft: g?.daily_gas != null ? g.daily_gas / net : null,
          test_date: o?.test_date ?? g?.test_date ?? null,
        },
      ];
    });
    if (!rows.length) {
      return {
        ...fail("No well in this radius has both a perforation record and a filed test, so nothing can be divided by anything."),
        wells_in_radius: wells.length,
      };
    }

    const byFormation = [...groupBy(rows, (r) => r.formation ?? "(no pick above the perforations)").entries()]
      .map(([formation, list]) => ({
        formation,
        wells: list.length,
        oil: spread(clean(list.map((r) => r.bopd_per_perf_ft))),
        gas: spread(clean(list.map((r) => r.mcfd_per_perf_ft))),
        median_net_perf_ft: median(clean(list.map((r) => r.net_perf_ft))),
        median_daily_oil_bbl: median(clean(list.map((r) => r.daily_oil_bbl))),
      }))
      .sort((a, b) => (b.oil.median ?? 0) - (a.oil.median ?? 0));

    return {
      ok: true as const,
      center: { lat: args.lat, lon: args.lon },
      radius_mi: radiusMi,
      field_name: args.field_name ?? null,
      wells_in_radius: wells.length,
      wells_measured: rows.length,
      by_formation: byFormation,
      wells_detail: rows,
      truncated,
      guidance: [
        INTERNAL_ONLY,
        "THIS IS NOT A PRODUCTIVITY INDEX IN THE RESERVOIR SENSE. A PI is rate per psi of drawdown, and the public record carries no flowing bottomhole pressure per well. This is rate per perforated foot: a completion-efficiency comparison between neighbours, nothing more.",
        "Net perforated feet is the sum of that well's own intervals, not the envelope, so a well shot in three 20 ft benches counts 60 ft and not 400.",
        "Formation is the deepest pick that well filed above its own perforations. Wells with no pick above them are grouped and named, not dropped.",
        TEST_READS_HIGH,
        NO_LOG_DATA,
      ],
    };
  }
);

export const TOOLS: RrcTool[] = [
  reservoirInputs,
  fluidProperties,
  pressureRegime,
  depthReconcile,
  perfVsLog,
  pickReconcile,
  structureSurface,
  contactFromOffsets,
  coningEvidence,
  depletionMap,
  payCalibration,
  analogTypeCurve,
  completionResponse,
  recompletionOutcomes,
  zoneFailureMap,
  gorByDepth,
  productivityIndex,
];
