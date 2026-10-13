/**
 * What the state knows about a HOLE, for the wells an import is about to create.
 *
 * `operator-fleet.ts` answers "which wells does this operator have" and runs on
 * the review screen while somebody watches it. This answers "and what is in
 * them", and runs inside the import, after the user has confirmed — four
 * queries over the whole selected fleet, never one per well. See
 * docs/plans/rrc-seeding-well-record.md.
 *
 * ## The decoders are pure and they are the point
 *
 * Every value that reaches a well page goes through one of the exported pure
 * functions below, so the thing under test is the thing that ships. Three of
 * them encode a trap that is invisible in the output if you get it wrong:
 *
 *  - `decodeProfile`: RRC code 1 is HORIZONTAL and code 3 is VERTICAL
 *    (completion_manual.pdf p.5). Code 1 is also the most common code in the
 *    file, so inferring the mapping from frequency labels every horizontal well
 *    in Texas vertical, and nothing downstream looks wrong.
 *  - `topOfCement`: the source column is TEXT and 'SURFACE' / 'SURF' are
 *    ordinary values. `Number("SURFACE")` is NaN, and "NaN ft" is what reaches
 *    the page.
 *  - `casingSize`: the size is split across three integer columns, (8, 5, 8)
 *    meaning 8 5/8". The decimal column next to them says 8.625, which is the
 *    same number and not what anybody writes on a tally.
 *
 * ## Blank stays blank
 *
 * A field with no source produces NO row. Not an empty row, not "Unknown", not
 * zero. An unfilled slot on the Info tab already reads as "nobody has said";
 * writing "Unknown" into it converts our silence into an assertion, and an
 * operator acts on a casing depth without re-checking it.
 *
 * No authorization here; the caller guards. Same contract as `rrc-*` throughout.
 */
import { rrcQuery } from "@/lib/scout/rrc-db";

/** Wellbore geometry, as `wells.wellbore_profile` stores it. */
export type WellboreProfile =
  | "vertical"
  | "horizontal"
  | "directional"
  | "sidetrack";

/** One casing string as filed, from the newest filing on the wellbore. */
export interface CasingRow {
  sizeInch: number | null;
  sizeNum: number | null;
  sizeDenom: number | null;
  sizeDecimal: number | null;
  weightLbFt: number | null;
  depthSet: number | null;
  /** TEXT in the source: a number, or 'SURFACE', or blank. */
  topOfCement: string | null;
}

/** One perforated interval, from the newest filing on the wellbore. */
export interface PerfInterval {
  topFt: number | null;
  bottomFt: number | null;
}

/** A formation the hole encountered, per the newest completion packet. */
export interface FormationTop {
  name: string;
  topFt: number | null;
  tvdFt: number | null;
}

/** Everything the mirror holds about one wellbore, undecoded. */
export interface WellRecord {
  apiNumber: string;
  /** W-10 producing method code, and the free-text "other" beside it. */
  producingMethodCode: string | null;
  producingMethodOther: string | null;
  /** Newest filing's strings, shallowest first. */
  casing: CasingRow[];
  /** Newest filing's perforated intervals. */
  perforations: PerfInterval[];
  /** 0, 1 or 2 plug-back depths from the newest wellbore filing. */
  plugBackFt: number[];
  elevationFt: number | null;
  /** KB / GL / GR / DF / RT ... The datum the elevation is measured to. */
  elevationDatum: string | null;
  /** Raw RRC wellbore-profile code. Decode with `decodeProfile`. */
  profileCode: string | null;
  formations: FormationTop[];
  /** Spud date as the completion packet filed it, MM/DD/YYYY. */
  spudDate: string | null;
  /** The wellbore's completion date from EWA, CCYYMMDD. */
  completionDate: string | null;
  /** Surface location from the mirror's shapefile-derived table. */
  surfaceLat: number | null;
  surfaceLon: number | null;
}

// ---------------------------------------------------------------- decoders

/**
 * W-10 producing method.
 *
 * Codes present in the mirror today, with their row counts: P pumping
 * (160,031), G gas lift (36,884), F flowing (12,255), B swab (155). The layout
 * also defines V vacuum, S steam, H heat, C CO2 and O other, none of which
 * currently occur; they are decoded anyway because "currently" is a property of
 * this month's file.
 *
 * An UNKNOWN code returns null, not the raw letter and not "Other". A letter in
 * the Producing method slot is worse than an empty slot: it looks like a value.
 */
export function producingMethod(
  code: string | null | undefined,
  other?: string | null
): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!c) return null;
  if (c === "O") return (other ?? "").trim() || null;
  const table: Record<string, string> = {
    P: "Pumping",
    G: "Gas lift",
    F: "Flowing",
    B: "Swab",
    V: "Vacuum",
    S: "Steam",
    H: "Heat",
    C: "CO2",
  };
  return table[c] ?? null;
}

/**
 * Feet with thousands separators, e.g. `4,210 ft`.
 *
 * ZERO IS NOT A DEPTH. Every fixed-width column this module reads pads an absent
 * number with zeros rather than leaving it blank, so 0 means "not filed" in all
 * of them: a 0 ft elevation, a 0 ft shoe and a 0 ft plug-back are the same
 * absence wearing a number. Rendering it would put "0 ft" in a slot an operator
 * reads as measured.
 */
export function feet(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return `${Math.round(value).toLocaleString("en-US")} ft`;
}

/**
 * A number with no trailing zeros: 24, 9.5, 8.625.
 *
 * Three decimals, not two. Casing sizes are eighths and sixteenths of an inch,
 * so 8 5/8" is exactly 8.625 and rounding to 2dp prints 8.63" — a size that does
 * not exist and that no supplier's catalogue lists.
 */
function trimNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * Casing size as a driller writes it.
 *
 * The source splits it: `size_inch` is the whole number and `size_num` /
 * `size_denom` are the fraction, so (8, 5, 8) is `8 5/8"`. `size_in` carries the
 * same value as a decimal and is the fallback only — nobody calls it 8.625"
 * casing.
 */
export function casingSize(
  inch: number | null,
  num: number | null,
  denom: number | null,
  decimal: number | null = null
): string | null {
  if (inch != null && Number.isFinite(inch) && inch > 0) {
    if (num != null && denom != null && num > 0 && denom > 0) {
      return `${inch} ${num}/${denom}"`;
    }
    return `${inch}"`;
  }
  if (decimal != null && Number.isFinite(decimal) && decimal > 0) {
    return `${trimNumber(decimal)}"`;
  }
  return null;
}

/** `8 5/8" 24#` — the size and its weight, which is how a string is named. */
export function casingLabel(row: CasingRow): string | null {
  const size = casingSize(
    row.sizeInch,
    row.sizeNum,
    row.sizeDenom,
    row.sizeDecimal
  );
  if (!size) return null;
  const weight =
    row.weightLbFt != null && Number.isFinite(row.weightLbFt) && row.weightLbFt > 0
      ? ` ${trimNumber(row.weightLbFt)}#`
      : "";
  return `${size}${weight}`;
}

/**
 * Top of cement, which is TEXT in the source and frequently not a number.
 *
 * `SURFACE` and `SURF` are the common non-numeric values and they mean
 * something precise (cement circulated to surface), so they are rendered as
 * filed. A numeric value is formatted as feet. Anything else is passed through
 * verbatim rather than being coerced, because a coercion here produces `NaN ft`.
 */
export function topOfCement(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n > 0 ? feet(n) : null;
  }
  return text;
}

/**
 * Elevation, carrying its datum into the value.
 *
 * The datum is usually NOT KB: across the mirror it is GR on 360,806 rows, GL
 * on 337,211 and KB on only 95,079. The Info tab's slot is labelled KB, so a
 * ground-level elevation written into it without saying so is a 20 ft error in
 * every depth an operator computes from it. A row with no datum claims none.
 */
export function elevationValue(
  ft: number | null | undefined,
  datum: string | null | undefined
): string | null {
  const value = feet(ft);
  if (!value) return null;
  const code = (datum ?? "").trim().toUpperCase();
  return code ? `${value} ${code}` : value;
}

/**
 * RRC wellbore-profile code -> our enum.
 *
 * 1 Horizontal, 2 Directional, 3 Vertical, 4 Sidetrack, 999 Unknown, per
 * manuals/completion_manual.pdf p.5. READ THAT AGAIN BEFORE "FIXING" IT: code 1
 * is horizontal and is also the most common code in the file (132,428 rows
 * against 54,735 for vertical), so the mapping looks backwards and is not.
 *
 * 999 and anything unrecognised return null, which is what the column stores for
 * unknown.
 */
export function decodeProfile(
  code: string | null | undefined
): WellboreProfile | null {
  switch ((code ?? "").trim()) {
    case "1":
      return "horizontal";
    case "2":
      return "directional";
    case "3":
      return "vertical";
    case "4":
      return "sidetrack";
    default:
      return null;
  }
}

/**
 * How many intervals are listed one by one before the field summarises instead.
 *
 * Statewide the mean is 1.48 intervals and the 99th percentile is 8, so this
 * lists the whole string for all but the tail. The tail is real though — one
 * wellbore carries 39 — and a 39-interval string is not a field an operator can
 * read at a glance.
 */
const PERF_LIST_LIMIT = 6;

/**
 * The perforated interval, as `wells.perforations` holds it.
 *
 * `top-bottom` in feet (en dash), which is the format the column already
 * documents (`Well.perforations` in wells.ts) and what an operator writes on a
 * ticket. Several intervals are comma-separated, shallowest first.
 *
 * PAST THE LIMIT IT SUMMARISES RATHER THAN TRUNCATES. A list cut off at six with
 * the rest dropped reads as the whole completion and is wrong about where the
 * well is open; the enclosing span plus a count is shorter, true, and says
 * plainly that there is more to it.
 *
 * A row needs BOTH ends to be an interval. The source files rows with one end
 * missing — API 36333396 has a 1985 row with a bottom and no top — and half an
 * interval is not a depth range, it is a filing error.
 */
export function perforationText(rows: PerfInterval[]): string | null {
  const intervals = rows
    .filter(
      (r): r is { topFt: number; bottomFt: number } =>
        r.topFt != null &&
        r.bottomFt != null &&
        Number.isFinite(r.topFt) &&
        Number.isFinite(r.bottomFt) &&
        r.topFt > 0 &&
        r.bottomFt > 0
    )
    // Filed the wrong way round on a handful of rows; the shallower number is
    // the top whatever order it arrived in.
    .map((r) => ({
      top: Math.min(r.topFt, r.bottomFt),
      bottom: Math.max(r.topFt, r.bottomFt),
    }))
    .sort((a, b) => a.top - b.top);

  const unique = intervals.filter(
    (r, i) =>
      i === 0 ||
      r.top !== intervals[i - 1].top ||
      r.bottom !== intervals[i - 1].bottom
  );
  if (unique.length === 0) return null;

  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  if (unique.length <= PERF_LIST_LIMIT) {
    return unique.map((r) => `${n(r.top)}\u2013${n(r.bottom)}`).join(", ");
  }
  const top = unique[0].top;
  const bottom = Math.max(...unique.map((r) => r.bottom));
  return `${n(top)}\u2013${n(bottom)} (${unique.length} intervals)`;
}

/**
 * The date to show as "Drilled", and the two sources it can come from.
 *
 * SPUD WINS. `completion.spud_dt` is literally the day the bit went in the
 * ground, which is what the field is called and what an operator means by it.
 * It is only on wells with a completion packet in the mirror, which is roughly a
 * sixth of a typical fleet.
 *
 * `wellbore.completion_date` is the fallback, and it is NOT the same fact: it is
 * the day the well was completed, weeks to months after spud. It is used anyway
 * because it is on ~86% of wells and is within a season of the truth, whereas a
 * blank tells the operator nothing at all. What is NOT used is `w2_g1_date`, the
 * day the completion PAPERWORK was filed, which has better coverage still and is
 * routinely years out: one Sky Resources well completed 1984-10-04 filed its W-2
 * in 1988.
 *
 * Both are normalised to ISO, because `wells.date_drilled` is a date column and
 * the two sources disagree about format as well as meaning: spud is MM/DD/YYYY
 * and completion is CCYYMMDD.
 */
export function dateDrilled(
  spud: string | null | undefined,
  completion: string | null | undefined
): string | null {
  const s = (spud ?? "").trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[1]}-${m[2]}`;
    if (isPlausibleDate(iso)) return iso;
  }
  const c = (completion ?? "").trim();
  if (/^\d{8}$/.test(c)) {
    const iso = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`;
    if (isPlausibleDate(iso)) return iso;
  }
  return null;
}

/**
 * A date that could belong to a Texas well.
 *
 * Both source columns are fixed-width and pad an absent value with zeros, so
 * '00000000' parses cleanly into the year 0 and would be stored as a real date.
 * The lower bound is the Corsicana discovery; the upper is today plus a year,
 * because a filing dated in the future is a typo rather than a schedule.
 */
function isPlausibleDate(iso: string): boolean {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const year = Number(iso.slice(0, 4));
  return year >= 1866 && year <= new Date().getUTCFullYear() + 1;
}

/**
 * Surface coordinates in the free-form shape `wells.coordinates` holds.
 *
 * "lat, lng" to five decimals — about a metre, which is finer than a location
 * the RRC derived from a county shapefile deserves and coarse enough not to
 * imply survey accuracy. The format is dictated by `parseCoordinates` in
 * `wells-map.tsx`, which is what plots the column.
 *
 * Bounds-checked against Texas rather than merely against the globe: a pair that
 * lands outside the state is a bad row, and plotting it drags the map to
 * somewhere the operator has never been.
 */
export function coordinateText(
  lat: number | null | undefined,
  lon: number | null | undefined
): string | null {
  if (lat == null || lon == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < 25.79 || lat > 36.55 || lon < -106.7 || lon > -93.46) return null;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** Which casing strings a well's newest filing describes. */
export interface PickedCasing {
  surface: CasingRow | null;
  production: CasingRow | null;
}

/**
 * Surface and production strings out of one filing's rows.
 *
 * Ordered by depth: the shallowest string is the surface casing and the deepest
 * is the production string. Intermediate strings are dropped — the Info sheet
 * has no slot for them, and there is no honest way to name "the middle one".
 *
 * A filing with exactly ONE string yields a production string and no surface
 * casing. A lone string on a well is the one the well produces through; calling
 * it surface casing would put a 4,210 ft shoe in a slot operators read as
 * "how deep is my surface pipe".
 *
 * Sorts its own input, so the caller's ordering cannot change the answer.
 */
export function pickCasing(rows: CasingRow[]): PickedCasing {
  const withDepth = rows
    .filter((r) => r.depthSet != null && Number.isFinite(r.depthSet))
    .sort((a, b) => (a.depthSet ?? 0) - (b.depthSet ?? 0));
  if (withDepth.length === 0) return { surface: null, production: null };
  if (withDepth.length === 1) {
    return { surface: null, production: withDepth[0] };
  }
  return {
    surface: withDepth[0],
    production: withDepth[withDepth.length - 1],
  };
}

/** The plug-back value, and whether the source contradicted itself. */
export interface PlugBack {
  value: string | null;
  /** True when a depth was thrown away for being deeper than the hole. */
  rejected: boolean;
}

/**
 * Plug-back depth, checked against the well's total depth.
 *
 * A plug-back is by definition ABOVE total depth. Where the filed number is
 * below it the two sources disagree, and storing the deeper one tells an
 * operator they can work at a depth the hole does not reach. The value is
 * dropped and the rejection is counted, so a systematic disagreement shows up as
 * a number rather than as silence.
 *
 * Both depths are rendered when the filing carried two, because a well can be
 * plugged back twice and the pair is the history.
 */
export function plugBackValue(
  depths: (number | null)[],
  totalDepthFt: number | null
): PlugBack {
  const usable = depths.filter(
    (d): d is number => d != null && Number.isFinite(d) && d > 0
  );
  if (usable.length === 0) return { value: null, rejected: false };

  const limit =
    totalDepthFt != null && Number.isFinite(totalDepthFt) && totalDepthFt > 0
      ? totalDepthFt
      : null;
  const kept = limit == null ? usable : usable.filter((d) => d <= limit);
  const rejected = kept.length < usable.length;
  if (kept.length === 0) return { value: null, rejected };

  const unique = [...new Set(kept)].sort((a, b) => a - b);
  return { value: unique.map((d) => feet(d)).join(" / "), rejected };
}

/**
 * Formation tops, cleaned and ordered.
 *
 * Sorted shallowest first, blank names dropped, and one row per name kept: a
 * packet that lists the same formation twice is describing one top, and
 * `well_formations` is unique on (well_id, name) so the second would collide on
 * insert anyway. Rows with no depth sort last rather than being dropped — the
 * name alone is worth something.
 */
export function formationTops(rows: FormationTop[]): FormationTop[] {
  const seen = new Set<string>();
  const out: FormationTop[] = [];
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (!name) continue;
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, topFt: row.topFt, tvdFt: row.tvdFt });
  }
  return out.sort((a, b) => {
    if (a.topFt == null && b.topFt == null) return a.name.localeCompare(b.name);
    if (a.topFt == null) return 1;
    if (b.topFt == null) return -1;
    return a.topFt - b.topFt;
  });
}

// ------------------------------------------------------- the rows we insert

/** The Info-sheet labels this module writes. Must match the template exactly. */
export const RECORD_LABELS = {
  producingMethod: "Producing method",
  surfaceCasing: "Surface casing",
  surfaceCasingDepth: "Surface casing depth",
  casing: "Casing",
  casingDepth: "Casing depth",
  topOfCement: "Top of cement",
  plugBack: "Plug back or bridge plugs",
  elevation: "KB",
} as const;

/** One `well_equipment` row, before it has a well id. */
export interface RecordField {
  label: string;
  value: string;
}

export interface RecordFields {
  fields: RecordField[];
  profile: WellboreProfile | null;
  /** ISO `YYYY-MM-DD` for `wells.date_drilled`, or null. */
  dateDrilled: string | null;
  /** `"lat, lng"` for `wells.coordinates`, or null. */
  coordinates: string | null;
  /** `top-bottom` feet for `wells.perforations`, or null. */
  perforations: string | null;
  /** A plug-back depth was dropped for exceeding total depth. */
  rejectedPlugBack: boolean;
}

/**
 * Turn one mirror record into exactly the rows that get written.
 *
 * Pure, so the insert payload is what the unit tests assert. Every value is
 * dropped when its source is absent, which is why this returns a short list on
 * most wells and an empty one on a well the state has nothing on.
 *
 * `injection` suppresses the producing method: an injection well does not
 * produce, its Info template has no such slot, and a row whose label matches no
 * slot renders as an "additional field" below the sheet.
 */
export function wellRecordFields(
  record: WellRecord,
  opts: { totalDepthFt?: number | null; injection?: boolean } = {}
): RecordFields {
  const fields: RecordField[] = [];
  const push = (label: string, value: string | null) => {
    if (value) fields.push({ label, value });
  };

  if (!opts.injection) {
    push(
      RECORD_LABELS.producingMethod,
      producingMethod(record.producingMethodCode, record.producingMethodOther)
    );
  }

  const { surface, production } = pickCasing(record.casing);
  if (surface) {
    push(RECORD_LABELS.surfaceCasing, casingLabel(surface));
    push(RECORD_LABELS.surfaceCasingDepth, feet(surface.depthSet));
  }
  if (production) {
    push(RECORD_LABELS.casing, casingLabel(production));
    push(RECORD_LABELS.casingDepth, feet(production.depthSet));
    push(RECORD_LABELS.topOfCement, topOfCement(production.topOfCement));
  }

  const plugBack = plugBackValue(
    record.plugBackFt,
    opts.totalDepthFt ?? null
  );
  push(RECORD_LABELS.plugBack, plugBack.value);
  push(
    RECORD_LABELS.elevation,
    elevationValue(record.elevationFt, record.elevationDatum)
  );

  return {
    fields,
    profile: decodeProfile(record.profileCode),
    dateDrilled: dateDrilled(record.spudDate, record.completionDate),
    coordinates: coordinateText(record.surfaceLat, record.surfaceLon),
    perforations: perforationText(record.perforations),
    rejectedPlugBack: plugBack.rejected,
  };
}

// ------------------------------------------------------------------- loader

interface MethodRow {
  api_number: string;
  producing_method: string | null;
  method_other: string | null;
  completion_date: string | null;
}
interface PerfRow {
  api_number: string;
  top_ft: number | null;
  bottom_ft: number | null;
}
interface LocationRow {
  api: string;
  lat: number | null;
  lon: number | null;
}
interface CasingSqlRow {
  api_number: string;
  size_inch: number | null;
  size_num: number | null;
  size_denom: number | null;
  size_in: number | null;
  weight_lb_ft: number | null;
  depth_set: number | null;
  top_of_cement: string | null;
}
interface FilingRow {
  api_number: string;
  plug_back_depth1: number | null;
  plug_back_depth2: number | null;
  elevation: number | null;
  elevation_code: string | null;
}
interface PacketRow {
  api_no: string;
  wellbore_profile: string | null;
  spud_dt: string | null;
  formation: string | null;
  depth: string | null;
  depth_tmd: string | null;
}

/** Text -> number, for the completion tables where every column is text. */
function textNumber(raw: string | null): number | null {
  const text = (raw ?? "").trim();
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function blank(record: WellRecord | undefined, api: string): WellRecord {
  return (
    record ?? {
      apiNumber: api,
      producingMethodCode: null,
      producingMethodOther: null,
      casing: [],
      perforations: [],
      plugBackFt: [],
      elevationFt: null,
      elevationDatum: null,
      profileCode: null,
      formations: [],
      spudDate: null,
      completionDate: null,
      surfaceLat: null,
      surfaceLon: null,
    }
  );
}

/**
 * Load the state's record for a set of API numbers.
 *
 * Four queries over the whole list, not four per well: a 500-well import is four
 * round trips to the mirror rather than two thousand. Each returns the newest
 * filing per well, because a wellbore accumulates filings and mixing two of them
 * produces a casing string that never existed (a 1985 re-file of one well in the
 * mirror carries 2.5 lb/ft where the 1988 filing says 24.0).
 *
 * Wells with nothing on file come back as empty records rather than being
 * absent, so the caller never has to distinguish "no data" from "not asked".
 */
export async function loadWellRecords(
  apiNumbers: string[]
): Promise<Map<string, WellRecord>> {
  const apis = [...new Set(apiNumbers.filter(Boolean))];
  const out = new Map<string, WellRecord>();
  if (apis.length === 0) return out;

  const ensure = (api: string): WellRecord => {
    const found = out.get(api);
    if (found) return found;
    const fresh = blank(undefined, api);
    out.set(api, fresh);
    return fresh;
  };
  for (const api of apis) ensure(api);

  const [methods, casing, perfs, filings, packets, locations] =
    await Promise.all([
    /*
     * W-10 carries NO API NUMBER. It is keyed (district, lease_no, well_no), and
     * the district on it is the REAL-WORLD label (7B, 8A) — the same one
     * `rrc.wellbore` prints. Running it through `toPdqDistrict` first would land
     * on a different district entirely and return another operator's tests.
     *
     * The key row per API is chosen with the same ordering `operator-fleet.ts`
     * uses, so the test we attach is the test for the completion we imported the
     * well under. Any other ordering here would silently pair a well's Info tab
     * with a different lease's test.
     */
    rrcQuery<MethodRow>(
      `with keys as (
         select distinct on (api_number)
                api_number, district, lease_number, well_no,
                nullif(completion_date, '') as completion_date
           from rrc.wellbore
          where api_number = any($1::text[]) and on_schedule = 'Y'
          order by api_number,
                   nullif(completion_date, '') desc nulls last,
                   oil_gas_code, lease_number
       )
       select k.api_number,
              k.completion_date,
              t.producing_method,
              t.method_other
         from keys k
         left join lateral (
                select producing_method, method_other
                  from rrc.w10_test w
                 where w.district = k.district
                   and w.lease_no = k.lease_number
                   and w.well_no  = k.well_no
                   and w.producing_method is not null
                 order by w.test_date desc nulls last
                 limit 1
              ) t on true`,
      [apis]
    ),
    // Newest filing only. `rank()` rather than `distinct on` because a filing
    // has SEVERAL rows (one per string) and all of them must survive.
    rrcQuery<CasingSqlRow>(
      `select api_number, size_inch, size_num, size_denom, size_in,
              weight_lb_ft, depth_set, top_of_cement
         from (
           select c.*,
                  rank() over (partition by api_number
                               order by file_date desc nulls last) as rk
             from rrc.wb_casing c
            where c.api_number = any($1::text[])
         ) t
        where rk = 1
        order by api_number, depth_set`,
      [apis]
    ),
    /*
     * Perforated intervals, newest filing only, for the same reason the casing
     * is: a hole recompleted three times carries three sets, and merging them
     * describes a well that was never open in all of those places at once.
     * `rank()` again rather than `distinct on`, because a filing has SEVERAL
     * intervals and all of them must survive.
     */
    rrcQuery<PerfRow>(
      `select api_number, top_ft, bottom_ft
         from (
           select p.*,
                  rank() over (partition by api_number
                               order by file_date desc nulls last) as rk
             from rrc.wb_perf p
            where p.api_number = any($1::text[])
         ) t
        where rk = 1
        order by api_number, top_ft`,
      [apis]
    ),
    rrcQuery<FilingRow>(
      `select distinct on (api_number)
              api_number, plug_back_depth1, plug_back_depth2,
              elevation, elevation_code
         from rrc.wb_filing
        where api_number = any($1::text[])
        order by api_number, file_date desc nulls last`,
      [apis]
    ),
    /*
     * `completion_formation` keys on TRACKING_NO, not on an API, so the packet
     * is the join. `tracking_no` is text holding a number, which is why it is
     * cast before ordering: '9' sorts after '86257' as text.
     *
     * The packet dates cannot be used to pick the newest. `approved_dt` is empty
     * on most rows and `submit_dt` is text carrying junk (values in that column
     * range from '01/01/2022' to '3450.0'). The tracking number is issued in
     * filing order, so descending it is both newest-first and deterministic.
     */
    rrcQuery<PacketRow>(
      `with pk as (
         select distinct on (api_no)
                api_no, tracking_no, wellbore_profile,
                nullif(spud_dt, '') as spud_dt
           from rrc.completion
          where api_no = any($1::text[])
          order by api_no,
                   (case when tracking_no ~ '^[0-9]+$'
                         then tracking_no::bigint else 0 end) desc
       )
       select pk.api_no, pk.wellbore_profile, pk.spud_dt,
              cf.formation, cf.depth, cf.depth_tmd
         from pk
         left join rrc.completion_formation cf
                on cf.tracking_no = pk.tracking_no
        order by pk.api_no`,
      [apis]
    ),
    /*
     * Surface coordinates.
     *
     * `distinct on` + `order by reliability` is the mirror's OWN rule for
     * choosing among the several locations a wellbore can have, and it is copied
     * verbatim from `leases/map-data.ts` rather than re-invented — those two
     * plot the same wells on two different maps, and a second rule here would
     * put the same well in two places.
     *
     * `well_location` holds 1,378,966 rows over 1,016,052 distinct APIs, so the
     * duplicates are real and the tiebreak is doing work.
     */
    rrcQuery<LocationRow>(
      `select distinct on (api_number)
              btrim(api_number) as api, lat, lon
         from rrc.well_location
        where api_number = any($1::text[])
          and lat is not null and lon is not null
        order by api_number, reliability`,
      [apis]
    ),
  ]);

  for (const row of methods) {
    const rec = ensure(row.api_number.trim());
    rec.producingMethodCode = row.producing_method;
    rec.producingMethodOther = row.method_other;
    rec.completionDate = row.completion_date;
  }

  for (const row of locations) {
    const rec = ensure(row.api.trim());
    rec.surfaceLat = row.lat;
    rec.surfaceLon = row.lon;
  }

  for (const row of casing) {
    ensure(row.api_number.trim()).casing.push({
      sizeInch: row.size_inch,
      sizeNum: row.size_num,
      sizeDenom: row.size_denom,
      sizeDecimal: row.size_in,
      weightLbFt: row.weight_lb_ft,
      depthSet: row.depth_set,
      topOfCement: row.top_of_cement,
    });
  }

  for (const row of perfs) {
    ensure(row.api_number.trim()).perforations.push({
      topFt: row.top_ft,
      bottomFt: row.bottom_ft,
    });
  }

  for (const row of filings) {
    const rec = ensure(row.api_number.trim());
    rec.plugBackFt = [row.plug_back_depth1, row.plug_back_depth2].filter(
      (d): d is number => d != null
    );
    rec.elevationFt = row.elevation;
    rec.elevationDatum = row.elevation_code;
  }

  const tops = new Map<string, FormationTop[]>();
  for (const row of packets) {
    const api = row.api_no.trim();
    const rec = ensure(api);
    rec.profileCode = row.wellbore_profile;
    rec.spudDate = row.spud_dt;
    if (!row.formation) continue;
    const list = tops.get(api) ?? [];
    list.push({
      name: row.formation,
      topFt: textNumber(row.depth),
      tvdFt: textNumber(row.depth_tmd),
    });
    tops.set(api, list);
  }
  for (const [api, list] of tops) ensure(api).formations = formationTops(list);

  return out;
}
