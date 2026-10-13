/**
 * The MAP contract between Orion and Scout — the write half of the page context.
 *
 * Orion already SEES the map (`buildScoutViewportSlice`, `buildScoutFilterSlice`).
 * This is how it TOUCHES one: the agent supplies a directive of filters and a
 * camera, `normalizeScoutView` bounds it server-side, and the map applies the
 * clean result. Exactly the `chart-spec.ts` shape — the agent supplies content,
 * the normaliser decides what is legal, and the client never trusts the model.
 *
 * WHAT THE NORMALISER IS FOR. Three failures, each of which has a rule here:
 *
 *   1. A filter that does not exist. The agent writes `wellStatus` because that
 *      is what the word sounds like, the merge writes a key nothing reads, and
 *      the map does not move while the chat says it did. Unknown keys are
 *      REJECTED BY NAME and reported, never merged.
 *   2. A filter that exists but means nothing here. A depth band in permits mode
 *      is the case `switchMode` already calls out: carrying it across "silently
 *      narrowed the new mode to a subset nobody asked for". Same rule, enforced
 *      before it is ever set.
 *   3. A camera the map cannot fly to. The mirror is Texas and only Texas, so a
 *      bbox over Oklahoma is a blank screen with no explanation on it.
 *
 * NOTHING IS PARTIALLY APPLIED. A rejected key is dropped and named in
 * `rejected`; the keys that survive are in `filters` with the values the UI's
 * own controls would have written, so a directive and a hand-set filter bar end
 * up at the same `Filters` object.
 *
 * PURE + FRAMEWORK-FREE, like `chart-spec.ts`: the type comes from the filter
 * bar (`import type` erases, so the server never pulls the client component in),
 * every value table lives here, and it unit-tests without a DB or a browser.
 */

import { COUNTY_OPTIONS } from "@/lib/scout/counties";
import { carryAcrossMode, type ModeCarry } from "@/lib/scout/filter-focus";
import type { Filters, MapMode } from "@/components/scout/map-filters";

/** Where the map registers its handler; where the chat looks for one. */
export const SCOUT_VIEW_ACTION = "scout.setView";

/**
 * The RRC's well-type vocabulary, as `Filters.wellType` carries it.
 *
 * A COPY of `WELL_TYPES` in `map-filters.tsx`, values only. It cannot be
 * imported: that module is a client component and this one is loaded by the
 * tool on the server, so importing the value would pull the whole filter bar
 * into the server bundle. `scout-view-spec.test.ts` reads the component's source
 * and fails if the two lists ever disagree, which is the part that matters —
 * a value that is not byte-identical to `well_type_name` matches nothing.
 */
export const WELL_TYPE_VALUES = [
  "PRODUCING",
  "SHUT IN",
  "TEMP ABANDONED",
  "INJECTION",
  "NO PRODUCTION",
  "SWR-10-WELL",
  "PARTIAL PLUG",
  "WATER SUPPLY",
  "NOT ELIGIBLE FOR ALLOWABLE",
  "OBSERVATION",
  "SHUT IN-MULTI-COMPL",
  "LPG STORAGE",
  "GAS STRG-INJECTION",
  "DOMESTIC USE WELL",
  "PROD FACTOR WELL",
  "GAS STRG-WITHDRAWAL",
  "BRINE MINING",
  "ABANDONED",
  "GAS STRG-SALT FORMATION",
  "OTHER TYPE SERVICE",
  "GEOTHERMAL WELL",
  "SEALED",
] as const;

export const MAP_MODES = ["wells", "permits", "operators"] as const;

/**
 * Zoom bounds. Below 4 Texas no longer fills the screen and the answer is a
 * picture of the Gulf; above 16 the well layer has stopped resolving anything
 * new and the user is looking at rooftops.
 */
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 16;

/** Feet. Bounds a typed depth, not a real well: the deepest Texas hole is ~31k. */
const MAX_DEPTH_FT = 60_000;
/** Matches `EARLIEST_COMPLETION_YEAR` in the filter bar. */
const EARLIEST_COMPLETION_YEAR = 1900;
/**
 * Bounds a typed per-well rate, not a real well: the biggest single well in the
 * mirror makes ~30,000 bbl or ~100,000 MCF a month, so a million is far past
 * anything on the map while still catching a model that wrote a phone number.
 * Oil in bbl per month, gas in MCF per month.
 */
const MAX_WELL_RATE = 1_000_000;

export interface ScoutBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Where to point the map. Two forms because the two questions are different:
 * "show me this county" is an extent, "centre on this well" is a point.
 */
export type ScoutCamera =
  | { kind: "bbox"; bbox: ScoutBbox }
  | { kind: "point"; lat: number; lon: number; zoom: number };

/** What the agent produces. Loosely typed on purpose; normalize tightens it. */
export interface RawScoutView {
  filters?: Record<string, unknown> | null;
  camera?: {
    bbox?: Partial<ScoutBbox> | null;
    lat?: unknown;
    lon?: unknown;
    zoom?: unknown;
  } | null;
}

/** The clean directive. Safe to merge into `Filters` and hand to Mapbox. */
export interface ScoutViewDirective {
  /** Only keys that exist, mean something in this mode, and coerced cleanly. */
  filters: Partial<Filters>;
  camera: ScoutCamera | null;
  /** One phrase per accepted setting, for the line the chat says out loud. */
  applied: string[];
  /** One phrase per dropped setting, with the reason it was dropped. */
  rejected: string[];
}

export interface NormalizeOpts {
  /**
   * The mode the map is in RIGHT NOW, when the directive does not set one.
   * Without it a depth band sent while the user is looking at permits would be
   * judged against "wells" and let through.
   */
  mode?: MapMode;
}

// ---------------------------------------------------------------- coercion

type Coerced = { ok: true; value: unknown } | { ok: false; why: string };

const good = (value: unknown): Coerced => ({ ok: true, value });
const bad = (why: string): Coerced => ({ ok: false, why });

/**
 * A number out of whatever the model wrote. Models emit "8,000", "8000 ft" and
 * "$25,000" for numbers, and all three mean the number; "deep" does not, and
 * turning it into 0 (the chart normaliser's rule, where a bad cell is one blank
 * bar) would filter the map to nothing and report success.
 */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[,$\s]/g, "").replace(/(ft|feet|bbl|mcf|usd)$/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Nullable whole number in a range, clamped. `null` clears the bound. */
function bounded(lo: number, hi: number) {
  return (v: unknown): Coerced => {
    if (v == null) return good(null);
    const n = toNumber(v);
    if (n == null) return bad(`"${String(v)}" is not a number`);
    return good(Math.round(clamp(n, lo, hi)));
  };
}

/** A closed vocabulary, matched case-insensitively but stored verbatim. */
function oneOf(values: readonly string[], label: string) {
  return (v: unknown): Coerced => {
    if (typeof v !== "string") return bad(`expects one of ${values.join(", ")}`);
    const hit = values.find((o) => o.toLowerCase() === v.trim().toLowerCase());
    return hit ? good(hit) : bad(`"${v}" is not a ${label} (${values.join(", ")})`);
  };
}

function toBool(v: unknown): Coerced {
  if (typeof v === "boolean") return good(v);
  if (v === "true") return good(true);
  if (v === "false") return good(false);
  return bad("expects true or false");
}

/**
 * A county, by RRC code or by name. The agent talks in names ("Andrews") and the
 * filter is a code (3), and resolving that here is what makes the directive land
 * on the same value the county picker writes.
 */
function toCounty(v: unknown): Coerced {
  if (v == null || v === "all") return good("all");
  const n = toNumber(v);
  if (n != null) {
    const code = Math.round(n);
    return COUNTY_OPTIONS.some((c) => c.code === code)
      ? good(code)
      : bad(`${code} is not an RRC county code`);
  }
  if (typeof v !== "string") return bad("expects a county name or RRC code");
  const wanted = v.trim().toLowerCase().replace(/\s+county$/, "");
  const hit = COUNTY_OPTIONS.find((c) => c.name.toLowerCase() === wanted);
  return hit ? good(hit.code) : bad(`no Texas county named "${v}"`);
}

/** District 1..14, or "all". The bar offers exactly those. */
function toDistrict(v: unknown): Coerced {
  if (v == null || v === "all") return good("all");
  const n = toNumber(v);
  if (n == null) return bad(`"${String(v)}" is not a district number`);
  const d = Math.round(n);
  return d >= 1 && d <= 14 ? good(d) : bad(`district ${d} does not exist (1-14)`);
}

/**
 * The RRC's own spelling of the well type, or null for any. Case and hyphens are
 * forgiven ("shut-in" -> "SHUT IN") because the model writes English; anything
 * outside the vocabulary is refused rather than passed through, since a value
 * the column never holds matches no wells and reads as "there are none".
 */
function toWellType(v: unknown): Coerced {
  if (v == null || v === "all") return good(null);
  if (typeof v !== "string") return bad("expects a well type name");
  const wanted = v.trim().toUpperCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
  const hit = WELL_TYPE_VALUES.find(
    (t) => t.toUpperCase().replace(/[-_]/g, " ") === wanted
  );
  return hit ? good(hit) : bad(`"${v}" is not an RRC well type`);
}

/** A trimmed name, or null to clear. */
function toText(v: unknown): Coerced {
  if (v == null) return good(null);
  if (typeof v !== "string") return bad("expects a name");
  const t = v.trim();
  return good(t === "" ? null : t);
}

/**
 * The operator filter, which is an object rather than an id: the bar's chip
 * shows `operator_name`, so a number with no name attached sets a filter the
 * user cannot see or clear. `rrc_search` returns both, so requiring both costs
 * the agent nothing.
 */
function toOperator(v: unknown): Coerced {
  if (v == null) return good(null);
  if (typeof v !== "object") return bad("expects { operator_number, operator_name }");
  const o = v as { operator_number?: unknown; operator_name?: unknown };
  const num = toNumber(o.operator_number);
  const name = typeof o.operator_name === "string" ? o.operator_name.trim() : "";
  if (num == null) return bad("needs an operator_number");
  if (name === "")
    return bad("needs operator_name too, or the filter chip has nothing to show");
  return good({ operator_number: Math.round(num), operator_name: name });
}

/**
 * ONE VALUE, OR SEVERAL — the multi-select fields, coerced item by item.
 *
 * A single value stays a BARE value rather than becoming a one-element list.
 * That is not tidiness: it is the shape the filter bar's own controls have
 * always written and the shape `scout_set_view` has always returned, so
 * "county: Andrews" lands on exactly the `Filters` it did before multi-select
 * existed, and only a genuine "Andrews or Martin" produces a list. `chosen()`
 * in `@/lib/scout/focus-where` is what reads all three shapes back.
 *
 * A list that coerces to nothing (`[]`, or entries that all cleared) is the
 * cleared filter, NOT a filter matching nobody: the agent asking for no
 * counties in particular means every county, and an empty answer here would
 * blank the map while the chat reported success.
 */
function several(one: (v: unknown) => Coerced, cleared: unknown) {
  return (v: unknown): Coerced => {
    if (!Array.isArray(v)) return one(v);
    const out: unknown[] = [];
    for (const item of v) {
      const c = one(item);
      if (!c.ok) return c;
      if (c.value == null || c.value === "all") continue;
      if (!out.includes(c.value)) out.push(c.value);
    }
    if (out.length === 0) return good(cleared);
    return good(out.length === 1 ? out[0] : out);
  };
}

/** `"Andrews or Martin"`, for the line the chat says out loud. */
function saySeveral(v: unknown, label: (x: unknown) => string): string {
  return (Array.isArray(v) ? v : [v]).map(label).join(" or ");
}

/** Filing purposes, verbatim strings from the permit payload. [] = every one. */
function toPurposes(v: unknown): Coerced {
  if (v == null) return good([]);
  const list = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") return bad("expects filing-purpose strings");
    const t = item.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return good(out);
}

// ------------------------------------------------------------- field table

interface FieldSpec {
  /** Modes whose bar actually offers this control. */
  modes: readonly MapMode[];
  coerce: (v: unknown) => Coerced;
  /** What the chat says was set, given the coerced value. */
  say: (v: unknown) => string;
}

const ALL_MODES = MAP_MODES;
const WELLS = ["wells"] as const;
const PERMITS = ["permits"] as const;
const OPERATORS = ["operators"] as const;

const num = (v: unknown) => Number(v).toLocaleString("en-US");

/** Ranges say the pair, not the end, so "8,000 ft and deeper" reads as one fact. */
function range(label: string, lo: unknown, hi: unknown, unit = ""): string {
  const u = unit ? ` ${unit}` : "";
  if (lo != null && hi != null) return `${label} ${num(lo)} to ${num(hi)}${u}`;
  if (lo != null) return `${label} ${num(lo)}${u} and above`;
  if (hi != null) return `${label} up to ${num(hi)}${u}`;
  return `${label} cleared`;
}

/**
 * Every filter the agent may set, in the order the chat reports them.
 *
 * `Partial<Record<keyof Filters, ...>>` on purpose: the key names are checked
 * against the real type (a typo here does not compile) without the table having
 * to be exhaustive, so a new control added to the bar tomorrow is simply not
 * agent-settable until someone adds it here. Silence beats a half-understood
 * filter the agent can move.
 */
const FIELDS: Partial<Record<keyof Filters, FieldSpec>> = {
  mode: {
    modes: ALL_MODES,
    coerce: oneOf(MAP_MODES, "map mode"),
    say: (v) => `map mode: ${String(v)}`,
  },
  oilGas: {
    modes: WELLS,
    coerce: oneOf(["all", "O", "G"], "commodity"),
    say: (v) => `commodity: ${v === "O" ? "oil" : v === "G" ? "gas" : "all"}`,
  },
  status: {
    modes: WELLS,
    coerce: several(oneOf(["all", "active", "inactive", "plugged"], "well status"), "all"),
    say: (v) => `status: ${saySeveral(v, String)}`,
  },
  district: {
    modes: WELLS,
    coerce: several(toDistrict, "all"),
    say: (v) =>
      v === "all" ? "district: all" : `district ${saySeveral(v, String)}`,
  },
  county: {
    modes: ALL_MODES,
    coerce: several(toCounty, "all"),
    say: (v) =>
      v === "all"
        ? "county: all"
        : `county: ${saySeveral(
            v,
            (c) => COUNTY_OPTIONS.find((o) => o.code === c)?.name ?? String(c)
          )}`,
  },
  wellType: {
    modes: WELLS,
    coerce: several(toWellType, null),
    say: (v) => (v == null ? "well type: any" : `well type: ${saySeveral(v, String)}`),
  },
  minDepth: {
    modes: WELLS,
    coerce: bounded(0, MAX_DEPTH_FT),
    say: (v) => range("depth", v, undefined, "ft"),
  },
  maxDepth: {
    modes: WELLS,
    coerce: bounded(0, MAX_DEPTH_FT),
    say: (v) => range("depth", undefined, v, "ft"),
  },
  minCompletionYear: {
    modes: WELLS,
    coerce: bounded(EARLIEST_COMPLETION_YEAR, new Date().getUTCFullYear()),
    say: (v) => (v == null ? "completed: any year" : `completed ${v} or later`),
  },
  maxCompletionYear: {
    modes: WELLS,
    coerce: bounded(EARLIEST_COMPLETION_YEAR, new Date().getUTCFullYear()),
    say: (v) => (v == null ? "completed: any year" : `completed ${v} or earlier`),
  },
  /*
   * The WELL's own production per month, wells mode only — operator mode's
   * `minOil12` pair below asks the same question of a company. Ordinary numeric
   * bands, coerced exactly as the depth band is, so "over 500 bbl" and 500 both
   * land on 500.
   */
  minOilRate: {
    modes: WELLS,
    coerce: bounded(0, MAX_WELL_RATE),
    say: (v) => range("well oil", v, undefined, "bbl/month"),
  },
  maxOilRate: {
    modes: WELLS,
    coerce: bounded(0, MAX_WELL_RATE),
    say: (v) => range("well oil", undefined, v, "bbl/month"),
  },
  minGasRate: {
    modes: WELLS,
    coerce: bounded(0, MAX_WELL_RATE),
    say: (v) => range("well gas", v, undefined, "MCF/month"),
  },
  maxGasRate: {
    modes: WELLS,
    coerce: bounded(0, MAX_WELL_RATE),
    say: (v) => range("well gas", undefined, v, "MCF/month"),
  },
  permitPurpose: {
    modes: PERMITS,
    coerce: toPurposes,
    say: (v) =>
      Array.isArray(v) && v.length > 0
        ? `filing purpose: ${v.join(", ")}`
        : "filing purpose: all",
  },
  operator: {
    modes: ALL_MODES,
    coerce: toOperator,
    say: (v) => {
      const o = v as { operator_name?: string; operator_number?: number } | null;
      return o ? `operator: ${o.operator_name} (${o.operator_number})` : "operator: any";
    },
  },
  person: {
    modes: ALL_MODES,
    coerce: toText,
    say: (v) => (v == null ? "person: any" : `person: ${String(v)}`),
  },
  minWells: {
    modes: OPERATORS,
    coerce: bounded(0, 1_000_000),
    say: (v) => range("wells operated", v, undefined),
  },
  maxWells: {
    modes: OPERATORS,
    coerce: bounded(0, 1_000_000),
    say: (v) => range("wells operated", undefined, v),
  },
  minOil12: {
    modes: OPERATORS,
    coerce: bounded(0, 1_000_000_000),
    say: (v) => range("oil", v, undefined, "bbl/month"),
  },
  maxOil12: {
    modes: OPERATORS,
    coerce: bounded(0, 1_000_000_000),
    say: (v) => range("oil", undefined, v, "bbl/month"),
  },
  minGas12: {
    modes: OPERATORS,
    coerce: bounded(0, 1_000_000_000),
    say: (v) => range("gas", v, undefined, "MCF/month"),
  },
  maxGas12: {
    modes: OPERATORS,
    coerce: bounded(0, 1_000_000_000),
    say: (v) => range("gas", undefined, v, "MCF/month"),
  },
  minRevenue: {
    modes: OPERATORS,
    coerce: bounded(0, 1_000_000_000),
    say: (v) => range("estimated revenue", v, undefined, "$/month"),
  },
  maxRevenue: {
    modes: OPERATORS,
    coerce: bounded(0, 1_000_000_000),
    say: (v) => range("estimated revenue", undefined, v, "$/month"),
  },
  excludePlugged: {
    modes: ALL_MODES,
    coerce: toBool,
    say: (v) => (v ? "hiding plugged wells" : "showing plugged wells"),
  },
  showSurveys: {
    modes: ALL_MODES,
    coerce: toBool,
    say: (v) => (v ? "survey lines on" : "survey lines off"),
  },
  showPipelines: {
    modes: ALL_MODES,
    coerce: toBool,
    say: (v) => (v ? "pipelines on" : "pipelines off"),
  },
};

/** Names of every settable filter, for the tool's own description. */
export const SETTABLE_FILTERS = Object.keys(FIELDS) as (keyof Filters)[];

/**
 * Real controls on this map that the agent is nonetheless REFUSED, with the
 * reason the user gets told.
 *
 * Distinct from the keys that are simply absent from `FIELDS`. Those are
 * answered "not a Recon filter", which is true of `wellStatus` and a lie about
 * `shapes` — it is a filter, it is the strongest one on the map, and saying it
 * does not exist would send the agent looking for another spelling of it.
 *
 * `shapes` is refused because a drawn area is a set of COORDINATES the user has
 * not seen. Every other filter here is a value they can read back off the bar
 * and undo in one click ("county: Andrews"); a polygon the model invented
 * arrives as a ring of numbers, silently narrows the map to a box nobody drew,
 * and reads exactly like a search that found nothing. The overlay that would
 * make it reviewable -- shapes listed, removable, corners draggable -- exists
 * now, but it shows what the USER drew; until the same surface can show an
 * agent's proposal BEFORE it filters, the honest answer is to ask them to draw
 * it. Orion can still say "draw a box around the field and I will read it",
 * because `buildScoutFilterSlice` reports the area that is in force.
 */
const REFUSED: Partial<Record<keyof Filters, string>> = {
  shapes: "a drawn area cannot be set from chat; draw it on the map and it applies to everything else",
};

// -------------------------------------------------------------- geography

/**
 * Texas, coarsely — ~20 vertices around the state line, west to east.
 *
 * A bounding RECTANGLE is not a test: the Texas box spans 25.5N to 36.7N and
 * 106.9W to 93.2W, which swallows most of Oklahoma, half of Louisiana and a
 * corner of New Mexico, so "outside Texas" would have let Oklahoma City through.
 * The outline is simplified to the point where the Rio Grande is a few straight
 * runs; it is a sanity gate on a camera, not a boundary survey.
 */
const TEXAS_OUTLINE: [number, number][] = [
  [-103.04, 36.5],
  [-100.0, 36.5],
  [-100.0, 34.56],
  [-99.2, 34.56],
  [-96.9, 33.87],
  [-95.15, 33.94],
  [-94.04, 33.55],
  [-94.04, 31.1],
  [-93.5, 30.3],
  [-93.84, 29.7],
  [-95.1, 29.1],
  [-96.8, 28.2],
  [-97.35, 26.9],
  [-97.15, 25.95],
  [-99.1, 26.4],
  [-100.4, 28.15],
  [-101.4, 29.77],
  [-102.3, 29.87],
  [-103.1, 28.98],
  [-104.5, 29.7],
  [-106.53, 31.78],
  [-106.62, 31.91],
  [-103.04, 31.99],
];

/** Ray casting, the standard even-odd test. */
export function inTexas(lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = TEXAS_OUTLINE.length - 1; i < TEXAS_OUTLINE.length; j = i++) {
    const [xi, yi] = TEXAS_OUTLINE[i];
    const [xj, yj] = TEXAS_OUTLINE[j];
    const straddles = yi > lat !== yj > lat;
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The camera, or a reason. The CENTRE has to be in Texas — not the corners: a
 * legitimate view of El Paso or Texarkana runs past the state line, and demanding
 * four corners inside would refuse half the border counties.
 */
function toCamera(raw: RawScoutView["camera"]): {
  camera: ScoutCamera | null;
  applied: string[];
  rejected: string[];
} {
  if (!raw) return { camera: null, applied: [], rejected: [] };

  const b = raw.bbox;
  if (b) {
    const west = toNumber(b.west);
    const south = toNumber(b.south);
    const east = toNumber(b.east);
    const north = toNumber(b.north);
    if (west == null || south == null || east == null || north == null)
      return {
        camera: null,
        applied: [],
        rejected: ["camera: bbox needs numeric west, south, east and north"],
      };
    // Ends the right way round, so a transposed pair is a view rather than an
    // error the user has to hear about.
    const bbox: ScoutBbox = {
      west: Math.min(west, east),
      east: Math.max(west, east),
      south: Math.min(south, north),
      north: Math.max(south, north),
    };
    const lon = (bbox.west + bbox.east) / 2;
    const lat = (bbox.south + bbox.north) / 2;
    if (!inTexas(lon, lat))
      return {
        camera: null,
        applied: [],
        rejected: [
          `camera: that bbox is centred outside Texas (${lat.toFixed(2)}, ${lon.toFixed(2)}), and the map only holds Texas`,
        ],
      };
    return {
      camera: { kind: "bbox", bbox },
      applied: ["moved the map to that area"],
      rejected: [],
    };
  }

  const lat = toNumber(raw.lat);
  const lon = toNumber(raw.lon);
  if (lat == null || lon == null)
    return {
      camera: null,
      applied: [],
      rejected: ["camera: needs a bbox, or lat and lon"],
    };
  if (!inTexas(lon, lat))
    return {
      camera: null,
      applied: [],
      rejected: [
        `camera: (${lat.toFixed(2)}, ${lon.toFixed(2)}) is outside Texas, and the map only holds Texas`,
      ],
    };
  // No zoom is a legitimate directive ("centre on this well"), and 11 is what
  // `handleSelectWell` already flies to for one well.
  const zoom = clamp(toNumber(raw.zoom) ?? 11, MIN_ZOOM, MAX_ZOOM);
  return {
    camera: { kind: "point", lat, lon, zoom },
    applied: [`centred on ${lat.toFixed(3)}, ${lon.toFixed(3)} at zoom ${zoom}`],
    rejected: [],
  };
}

// -------------------------------------------------------------- normalize

/**
 * Turn a loose directive into one the map can apply. Never throws: a bad
 * directive comes back empty with its reasons attached, because the agent has to
 * be able to tell the user WHY nothing moved.
 */
export function normalizeScoutView(
  raw: RawScoutView,
  opts: NormalizeOpts = {}
): ScoutViewDirective {
  const rawFilters = raw?.filters ?? {};
  const filters: Record<string, unknown> = {};
  const applied: string[] = [];
  const rejected: string[] = [];

  /*
   * The mode decides which filters are legal, so it is resolved FIRST — from the
   * directive if it sets one, otherwise from the mode the map is in. A depth
   * band sent while the user is looking at permits is judged against permits.
   */
  const askedMode = FIELDS.mode!.coerce((rawFilters as Record<string, unknown>).mode);
  const mode: MapMode =
    "mode" in rawFilters && askedMode.ok
      ? (askedMode.value as MapMode)
      : (opts.mode ?? "wells");

  for (const [key, spec] of Object.entries(FIELDS) as [keyof Filters, FieldSpec][]) {
    if (!(key in rawFilters)) continue;
    const value = (rawFilters as Record<string, unknown>)[key];
    if (!spec.modes.includes(mode)) {
      rejected.push(`${key}: not a filter in ${mode} mode`);
      continue;
    }
    const coerced = spec.coerce(value);
    if (!coerced.ok) {
      rejected.push(`${key}: ${coerced.why}`);
      continue;
    }
    filters[key] = coerced.value;
    applied.push(spec.say(coerced.value));
  }

  // Everything the agent sent that it may not set. Named rather than ignored:
  // "there is no such filter" is the answer the user needs — and for the
  // handful that ARE filters but are not the agent's to set, the reason is,
  // since "no such filter" would be false.
  for (const key of Object.keys(rawFilters)) {
    if (key in FIELDS) continue;
    const refusal = REFUSED[key as keyof Filters];
    rejected.push(`${key}: ${refusal ?? "not a Recon filter"}`);
  }

  // A range typed backwards ("between 8,000 and 4,000") is an order-of-words
  // slip, not a request for an empty map.
  swapIfInverted(filters, "minDepth", "maxDepth");
  swapIfInverted(filters, "minCompletionYear", "maxCompletionYear");
  swapIfInverted(filters, "minOilRate", "maxOilRate");
  swapIfInverted(filters, "minGasRate", "maxGasRate");
  swapIfInverted(filters, "minWells", "maxWells");
  swapIfInverted(filters, "minOil12", "maxOil12");
  swapIfInverted(filters, "minGas12", "maxGas12");
  swapIfInverted(filters, "minRevenue", "maxRevenue");

  const camera = toCamera(raw?.camera);

  return {
    filters: filters as Partial<Filters>,
    camera: camera.camera,
    applied: [...applied, ...camera.applied],
    rejected: [...rejected, ...camera.rejected],
  };
}

function swapIfInverted(
  filters: Record<string, unknown>,
  lo: string,
  hi: string
): void {
  const a = filters[lo];
  const b = filters[hi];
  if (typeof a === "number" && typeof b === "number" && a > b) {
    filters[lo] = b;
    filters[hi] = a;
  }
}

/**
 * Merge a directive's filters into the bar's current state.
 *
 * MODE IS A RESET, exactly as the bar's own `switchMode` is: the modes ask
 * different questions of different records, so a filter set for one carries a
 * different meaning into the next. What survives is `carryAcrossMode`'s list and
 * nothing else — the gear-menu settings and the drawn area — and it is imported
 * rather than restated so a directive and a click cannot make different cuts.
 *
 * Generic over the filter type rather than importing `DEFAULT_FILTERS` (a value
 * in a client component) so this stays server-safe and unit-testable.
 */
export function applyScoutView<F extends ModeCarry>(
  current: F,
  patch: Partial<F>,
  defaults: F
): F {
  const base: F =
    patch.mode != null && patch.mode !== current.mode
      ? carryAcrossMode(current, patch.mode, defaults)
      : current;
  return { ...base, ...patch };
}
