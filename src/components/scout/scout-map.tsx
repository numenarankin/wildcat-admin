"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import mapboxgl from "mapbox-gl";
import { formatRate, useWellRates } from "./use-well-rates";
import "mapbox-gl/dist/mapbox-gl.css";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { useTheme } from "@/components/theme-provider";
import { ScoutWellModal } from "./scout-well-modal";
import { ScoutLeaseModal } from "./scout-lease-modal";
import { OperatorModal } from "./operator-modal";
import { PrincipalDetailPanel } from "./principal-detail-panel";
import { ScoutOwnerModal } from "./scout-owner-modal";
import { OperatorListPanel, type OperatorListItem } from "./operator-list-panel";
import { PermitPanel } from "./permit-panel";
import { PermitLegend } from "./permit-legend";
import {
  MapFilters,
  DEFAULT_FILTERS,
  type Filters,
  type MapMode,
} from "./map-filters";
import {
  basemapStyle,
  DEFAULT_BASEMAP,
  isDarkGround,
  MapControls,
  type Basemap,
} from "./map-controls";
import { fmtVol, perMonth, partyName } from "@/lib/scout/format";
import { monthlyRevenue } from "@/lib/scout/revenue";
import type { CommodityPrices } from "@/lib/analytics/types";
import { getCountyOperators, getFocusWells } from "@/lib/scout/queries";
import { getPersonOperators } from "@/lib/scout/rrc-people";
import type { OwnerKey } from "@/lib/scout/cad-owners";
import { loadOperatorPoints } from "@/lib/scout/operator-points";
import {
  filterPermitFeatures,
  purposeCounts,
  type PurposeOption,
} from "@/lib/scout/permit-filter";
import {
  attachPipelineLayer,
  PIPELINE_LAYERS,
  type PipelineLayer,
} from "@/lib/scout/pipeline-layer";
import {
  attachSurveyLayer,
  SURVEY_LAYERS,
  SURVEY_MIN_ZOOM,
  type SurveyLayer,
} from "@/lib/scout/survey-layer";
import {
  attachShapeLayer,
  ringAround,
  type DrawTool,
  type ShapeLayerHandle,
} from "@/lib/scout/shape-layer";
import { ShapePanel } from "./shape-panel";
import type { PdqLeaseKey } from "@/lib/scout/lease-key";
import type { FocusWell, OperatorPoint } from "@/lib/scout/types";
import { chosen } from "@/lib/scout/focus-where";
import {
  describeShapes,
  needsFocusLayer,
  toFocusOpts,
} from "@/lib/scout/filter-focus";
import {
  pointInShape,
  wellsInShapes,
  type Shape,
} from "@/lib/scout/geo-shapes";
import { COUNTY_NAMES } from "@/lib/scout/counties";
import type { ReconLink } from "@/lib/recon-alerts/types";
import type { TargetInput } from "@/lib/admin/target-types";
import { getReconAlertCounties } from "@/lib/recon-alerts/actions";
import { ReconAlertsModal } from "./recon-alerts-modal";
import { usePageAction, usePageContextSlice } from "@/lib/ai/use-ai-context";
import {
  SCOUT_VIEW_ACTION,
  applyScoutView,
  type ScoutViewDirective,
} from "@/lib/ai/scout-view-spec";
import {
  buildScoutFilterSlice,
  buildScoutModalSlice,
  buildScoutViewportSlice,
  type Bbox,
} from "@/lib/ai/context-slices";

/**
 * Startup trace for the map: every step from mount to first paint, plus every
 * Mapbox error. `console.warn` because Next forwards browser warnings to the
 * dev server's terminal by default, so a blank map can be diagnosed from the
 * terminal without opening devtools. Times are ms since navigation.
 */
function trace(msg: string, extra?: unknown) {
  const at = Math.round(performance.now());
  if (extra === undefined) console.warn(`[recon] +${at}ms ${msg}`);
  else console.warn(`[recon] +${at}ms ${msg}`, extra);
}
/** Tile requests traced per page load: enough to see the opening view. */
const TRACE_TILES = 40;

const FOCUS_SOURCE = "focus-src";
const OPERATOR_TRACT_SOURCE = "operator-tract-src";

const OPERATOR_SOURCE = "operator-src";
const PMTILES_LAYERS = ["clusters", "cluster-count", "wells"];
const FOCUS_LAYERS = ["focus-clusters", "focus-cluster-count", "focus-wells"];
const OPERATOR_LAYERS = ["op-clusters", "op-cluster-count", "op-points"];
const PERMIT_SOURCE = "permit-src";
const PERMIT_HISTORY_SOURCE = "permit-history-src";
const PERMIT_LAYERS = [
  "permit-clusters", "permit-cluster-count",
  "permit-history-halo", "permit-history",
  "permit-pending-clusters", "permit-pending-count",
  "permit-halo", "permit-points",
];

/*
 * Cluster geometry, shared with the well and operator layers.
 *
 * Same steps and the same radii as `clusters` above, deliberately: three modes
 * on one map that bubble at three different rates read as three bugs. The first
 * version of this used 25/100/500 and made a 400-permit cluster the size the
 * well layer reserves for 10,000, which is what a bubble scale is FOR.
 */
const CLUSTER_RADIUS: Expr = [
  "step", ["get", "point_count"], 12, 100, 16, 1000, 22, 10000, 30,
] as unknown as Expr;
const WELL_LAYERS = [...PMTILES_LAYERS, ...FOCUS_LAYERS];

const SOURCE_ID = "wells-src";
const SOURCE_LAYER = "wells";
const TEXAS_BOUNDS: mapboxgl.LngLatBoundsLike = [
  [-106.9, 25.5],
  [-93.2, 36.7],
];

/** The four stacking dossiers. Order of opening decides which one is raised. */
type Dossier = "well" | "operator" | "lease" | "owner";

/** One dossier in the history: which kind, and which record it shows. */
type DossierEntry =
  | { kind: "well"; api: number }
  | { kind: "operator"; operatorNumber: number }
  | { kind: "lease"; key: PdqLeaseKey }
  | { kind: "owner"; key: OwnerKey & { name?: string | null } };

/** The newest entry of one kind in the history, or null. */
function newestOf<K extends Dossier>(
  stack: DossierEntry[],
  kind: K
): Extract<DossierEntry, { kind: K }> | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].kind === kind) return stack[i] as Extract<DossierEntry, { kind: K }>;
  }
  return null;
}

/** Deepest history kept; past it the oldest entry falls off. */
const DOSSIER_HISTORY_CAP = 30;

// Minimal shape of a clicked tile feature (avoids the @types/geojson namespace).
interface ClickedFeature {
  geometry: { type: string; coordinates: [number, number] };
  properties: Record<string, string | number | boolean> | null;
}

type Expr = mapboxgl.ExpressionSpecification;
const baseRadius: Expr = [
  "interpolate",
  ["linear"],
  ["zoom"],
  6,
  2,
  13,
  5,
] as unknown as Expr;

/**
 * Colour individual wells; shared by the tile + focus layers.
 *
 * Saltwater disposal is tested FIRST and wins over oil/gas, because a disposal
 * well usually still carries an oil or gas code from whatever it was drilled
 * as. Ordering it second would paint every one of them green or red and the
 * layer would show no disposal at all.
 *
 * "Disposal" here means a live UIC class 2 permit with inj_type 1 or 2, the
 * same test `findDisposal` uses. Injection for secondary recovery (inj_type 3)
 * is deliberately NOT blue: it is a flood, not a saltwater disposal well.
 */
/**
 * WHAT THE HOLE IS DOING, not what commodity it was filed under.
 *
 * Oil-vs-gas is a record-keeping split: a well routinely makes both, and the
 * RRC's `oil_gas_code` says which schedule it sits on rather than what comes out
 * of it. Colouring by that painted producing gas wells red, which reads as a
 * problem. Blue injects, red has stopped, green is running.
 *
 * STOPPED WINS OVER INJECTING. API 50336281 has been shut in since 2022-12 and
 * still holds a live disposal permit, so injection-first painted it blue while
 * its own page said "Shut In". What the hole is doing today is the question the
 * colour answers; what it is permitted to do is not.
 *
 * One definition, used by both the tile layer and the focus layer, so a well
 * cannot change colour when a search narrows onto it.
 */
/*
 * One size and one glow for every permit dot, whatever its state.
 *
 * The three states differ by COLOUR alone. Sizing them differently would encode
 * a second variable nobody asked a question about, and it made an approved
 * permit look like a lesser event than a pending one when it is the same event
 * a week later.
 *
 * The glow used to fade over 30 days on the pending layer, which read as "this
 * permit is decaying" rather than "this one is new" -- and left the other two
 * states with no glow at all.
 */
const PERMIT_DOT_RADIUS: Expr = [
  "interpolate", ["linear"], ["zoom"], 5, 3, 12, 7,
] as unknown as Expr;
const PERMIT_HALO_RADIUS: Expr = [
  "interpolate", ["linear"], ["zoom"], 5, 8, 12, 22,
] as unknown as Expr;
const PERMIT_HALO_OPACITY = 0.28;

/** The one mode admin's Prospecting map draws. */
const MAP_MODE: MapMode = "operators";

const wellColor: Expr = [
  "case",
  ["any", ["==", ["get", "dead"], 1], ["==", ["get", "plug"], 1]],
  "#ef4444",
  ["==", ["get", "swd"], 1],
  "#38bdf8",
  "#16a34a",
] as unknown as Expr;

/**
 * Filter for the tile-based individual-well layer (broad category filters only).
 * County and operator are NOT here — those switch the map to the Supabase-backed
 * focus layer so it shows ONLY the matching wells (see the focus effect).
 */
function wellsFilter(f: Filters): mapboxgl.FilterSpecification {
  const parts: unknown[] = ["all", ["!", ["has", "point_count"]]];
  if (f.oilGas !== "all") parts.push(["==", ["get", "og"], f.oilGas]);
  // The global "exclude plugged" setting hides plugged wells everywhere; it
  // takes precedence over the per-mode status control.
  if (f.excludePlugged) parts.push(["!=", ["get", "st"], ST.plugged]);
  const st = statusCodes(f);
  // One value keeps the `==` form the tiles have always been filtered with; a
  // list needs `in`. Same rule the SQL builder follows for the focus layer.
  if (st) parts.push(matchesOne("st", st));
  const districts = chosen(f.district);
  if (districts) parts.push(matchesOne("dist", districts));
  return parts as unknown as mapboxgl.FilterSpecification;
}

/** `["==", …]` for one value, `["in", …]` for several. */
function matchesOne(prop: string, values: number[]): unknown {
  return values.length === 1
    ? ["==", ["get", prop], values[0]]
    : ["in", ["get", prop], ["literal", values]];
}

/**
 * `st` in the tiles, matching `WellActivity` — see `well-activity.ts` for what
 * puts a well in each bucket.
 */
const ST = { active: 0, inactive: 1, plugged: 2 } as const;

/** The buckets the Status control is asking for, or null for "all". */
function statusCodes(f: Filters): number[] | null {
  return chosen(f.status)?.map((s) => ST[s]) ?? null;
}

/**
 * How many wells in a bubble the Status filter would keep.
 *
 * A Mapbox filter cannot look inside a cluster, so a bubble would otherwise
 * keep reporting the wells the filter just hid — the complaint that started
 * this: plugged wells "showing up" under Active were mostly bubbles counting
 * them. The tiler tallies each bucket per cluster (`na`/`ni`/`np`), and these
 * two pick the tally the current filter asks for. Several buckets is the SUM of
 * their tallies, which is exact: the three are disjoint.
 */
const CLUSTER_COUNT_KEY = { active: "na", inactive: "ni", plugged: "np" } as const;

/** `["+", ["get","na"], …]`, or the single `get` when there is only one. */
function sumOf(keys: string[]): Expr {
  if (keys.length === 1) return ["get", keys[0]] as Expr;
  return ["+", ...keys.map((k) => ["get", k])] as unknown as Expr;
}

function clusterCount(f: Filters): Expr {
  const status = chosen(f.status);
  if (status) return sumOf(status.map((s) => CLUSTER_COUNT_KEY[s]));
  // "Exclude plugged" is still a filter, just a coarser one.
  if (f.excludePlugged) {
    return ["+", ["get", "na"], ["get", "ni"]] as unknown as Expr;
  }
  return ["get", "point_count"] as Expr;
}

function clusterLabel(f: Filters): Expr {
  const status = chosen(f.status);
  if (status?.length === 1) {
    return ["to-string", ["get", `${CLUSTER_COUNT_KEY[status[0]]}_a`]] as unknown as Expr;
  }
  // No abbreviated form for a sum, and none needed: it is only reached with the
  // buckets added up or the plugged wells peeled off a count that was already
  // abbreviated.
  if (status || f.excludePlugged) {
    return ["to-string", clusterCount(f)] as unknown as Expr;
  }
  return ["get", "point_count_abbreviated"] as Expr;
}

/** Which bubbles to draw: those holding at least one well the filter wants. */
function clusterFilter(f: Filters): mapboxgl.FilterSpecification {
  // Drop bubbles that hold nothing the filter wants, rather than drawing a "0".
  const all: unknown =
    chosen(f.status) === null && !f.excludePlugged
      ? ["has", "point_count"]
      : ["all", ["has", "point_count"], [">", clusterCount(f), 0]];
  return all as mapboxgl.FilterSpecification;
}

function clusterColor(f: Filters): Expr {
  return [
    "step",
    clusterCount(f),
    "#93c5fd",
    100,
    "#60a5fa",
    1000,
    "#3b82f6",
    10000,
    "#1d4ed8",
  ] as unknown as Expr;
}

function clusterRadius(f: Filters): Expr {
  return [
    "step",
    clusterCount(f),
    12,
    100,
    16,
    1000,
    22,
    10000,
    30,
  ] as unknown as Expr;
}

/** A multi-value filter as the phrase a person would say. Null when unset. */
function describe<T extends string | number>(
  values: T[] | null,
  label: (v: T) => string
): string | null {
  if (values === null || values.length === 0) return null;
  return values.map(label).join(" or ");
}

/** County code -> the name the bar shows. */
function countyName(code: number): string {
  return COUNTY_NAMES[code] ?? String(code);
}

export function ScoutMap({
  prices,
  tileVersion,
  link = {},
  onAddTargets,
  targetNumbers,
  filtersHost = null,
}: {
  prices: CommodityPrices;
  /** Cache key for the tile URL — see `tileVersion()` in live-tiler.ts. */
  tileVersion: string;
  /** A deep link to open on arrival (a Recon alert email's links). */
  link?: ReconLink;
  /** Adds checked operators from a cluster's list to the Targets table. */
  onAddTargets?: (targets: TargetInput[]) => void;
  /** Operators already on the Targets list, for the cluster list's checkboxes. */
  targetNumbers?: ReadonlySet<number>;
  /**
   * Where to put the filter bar instead of above the map: the admin
   * Prospecting toolbar's right side. Null keeps it over the map.
   */
  filtersHost?: HTMLElement | null;
}) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  // Hover rates, in a ref because the map effect runs once and closes over it.
  const rates = useWellRates();
  const ratesRef = useRef(rates);
  useEffect(() => {
    ratesRef.current = rates;
  }, [rates]);
  const [ready, setReady] = useState(false);
  // `ready` means the style loaded and the layers exist; it does NOT mean any
  // wells are on screen yet. The route's `loading.tsx` boundary resolves as soon
  // as the server component returns, which is almost immediately (one cached
  // quote), so without this the spinner disappears onto a blank container while
  // Mapbox boots and the vector tiles stream in. `drawn` tracks the real thing:
  // the map's first `idle`, which fires once every tile requested for the
  // opening view has loaded and rendered.
  const [drawn, setDrawn] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>(DEFAULT_BASEMAP);

  /*
   * How much of the canvas the right-hand panel stack is covering, so the map
   * controls can step out from under it.
   *
   * MEASURED, not counted. The offset could be derived from which panels are
   * open times their width, but that is the panels' width written down a second
   * time in a component that does not render them — the day one of them stops
   * being 24rem, the controls slide under it again. The stack collapses to zero
   * width when every panel is closed, which is exactly the "no offset" case.
   */
  const panelStackRef = useRef<HTMLDivElement | null>(null);
  const [panelInset, setPanelInset] = useState(0);
  useEffect(() => {
    const el = panelStackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setPanelInset(entry.contentRect.width)
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /*
   * Bumped every time a style finishes loading.
   *
   * `setStyle` discards every source and layer the app added, so they are
   * re-created below on `style.load`. The two GeoJSON sources (focus wells,
   * operator points) come back EMPTY, though — their data is pushed in by the
   * filter effect, which has no reason to re-run just because the basemap
   * changed. This is that reason: it is in that effect's dependencies, so a
   * style swap refills them.
   */
  const [styleEpoch, setStyleEpoch] = useState(0);
  /** The admin theme; the drawn basemap follows it. */
  const darkTheme = useTheme().theme === "dark";
  /** The same, for the map-init effect, which must not re-run on a toggle. */
  const darkThemeRef = useRef(darkTheme);
  useEffect(() => {
    darkThemeRef.current = darkTheme;
  }, [darkTheme]);
  /** The style currently applied to the map, so a swap fires exactly once. */
  const appliedStyleRef = useRef<string>(basemapStyle(DEFAULT_BASEMAP, darkTheme));
  const [selectedPrincipal, setSelectedPrincipal] = useState<string | null>(null);
  /*
   * The dossier HISTORY, oldest first: every dossier opened, in order, with the
   * record it showed.
   *
   * Well, operator, lease and owner are all modals, and each opens the others,
   * so none can own a fixed z-index. The last entry is the one being read: its
   * modal gets the raised z-index and the others stay mounted underneath.
   *
   * ENTRIES, not kinds. There is one modal per kind, and it shows the NEWEST
   * entry of its kind. Back pops one entry, so well A -> operator -> well B ->
   * Back -> Back lands on well A again: popping B makes A the newest well, and
   * the well modal shows it underneath the operator until the operator goes.
   * A stack of kinds could not do that; opening well B overwrote well A.
   *
   * A `?well=` deep link opens on that well's dossier; see the link effect.
   */
  const [stack, setStack] = useState<DossierEntry[]>(
    link.well ? [{ kind: "well", api: Number(link.well) }] : []
  );
  const top = stack[stack.length - 1]?.kind ?? null;
  const selectedApi = newestOf(stack, "well")?.api ?? null;
  const selectedOperator = newestOf(stack, "operator")?.operatorNumber ?? null;
  const selectedLease = newestOf(stack, "lease")?.key ?? null;
  const selectedOwner = newestOf(stack, "owner")?.key ?? null;
  const [operatorList, setOperatorList] = useState<{
    title: string;
    items: OperatorListItem[];
  } | null>(null);
  // Admin's Prospecting map is Operators only: every write lands in that mode,
  // whatever asked for another (a deep link, an alert, a saved view), so no
  // path can bring the Wells or Permits layers up.
  const [filters, setFiltersRaw] = useState<Filters>({ ...DEFAULT_FILTERS, mode: MAP_MODE });
  const setFilters = useCallback(
    (next: Filters | ((prev: Filters) => Filters)) =>
      setFiltersRaw((prev) => ({
        ...(typeof next === "function" ? next(prev) : next),
        mode: MAP_MODE,
      })),
    []
  );
  /** The Recon alerts manager; opened by the bar's Alerts button or `?alerts=1`. */
  const [alertsOpen, setAlertsOpen] = useState(link.alerts === true);
  const [noProductionData, setNoProductionData] = useState(false);
  /** The pending-permit payload, fetched once per session. */
  const permitFetchRef = useRef<AbortController | null>(null);
  /** The resolved payload, kept so the key can re-count on every pan. */
  const permitDataRef = useRef<{
    pending: GeoJSON.FeatureCollection;
    history: GeoJSON.FeatureCollection;
  } | null>(null);
  const [permitCounts, setPermitCounts] = useState<{
    total: number;
    approved: number;
    drilled: number;
  } | null>(null);
  /**
   * The filing purposes the loaded payload carries, for the bar's menu.
   *
   * Counted off the UNFILTERED payload, so ticking a purpose never removes the
   * boxes that would bring the others back.
   */
  const [permitPurposes, setPermitPurposes] = useState<PurposeOption[]>([]);
  const [permit, setPermit] = useState<Record<string, unknown> | null>(null);

  /*
   * THE DRAWN AREA — the tool that is armed, and the radius the ring tool uses.
   *
   * The shapes themselves are NOT here: they live in `filters.shapes`, because
   * they are a filter like any other. That is what makes them survive a mode
   * switch, reach the query, and show in Orion's slice without a second
   * pathway. What is local is the gesture in progress.
   */
  const [drawTool, setDrawTool] = useState<DrawTool>("off");
  const [ringMiles, setRingMiles] = useState(5);
  // Read by the well-click handler, which is bound once inside the map-init
  // effect and would otherwise close over the first value forever, the same
  // reason `appliedStyleRef` does.
  const drawToolRef = useRef<DrawTool>("off");
  const ringMilesRef = useRef(5);
  useEffect(() => {
    drawToolRef.current = drawTool;
    ringMilesRef.current = ringMiles;
  }, [drawTool, ringMiles]);
  const shapeLayerRef = useRef<ShapeLayerHandle | null>(null);
  /**
   * A finished box or lasso, into the filter.
   *
   * Identity-stable (`setFilters` is), because the draw layer is attached once
   * on the first `style.load` and holds this callback for the life of the map.
   *
   * THE TOOL DISARMS ITSELF. One gesture makes one shape, so the drag after it
   * pans the map again — the convention every draw tool follows, and the
   * alternative is a second box every time somebody moves the map to look at
   * the first. The ring tool is the exception and stays armed: "one or several
   * wells" is the ask, and each well is a click.
   */
  const commitDrawnShape = useCallback((shape: Shape) => {
    setFilters((f) => ({ ...f, shapes: [...f.shapes, shape] }));
    setDrawTool("off");
  }, [setFilters]);
  /** A vertex drag, committed on mouse-up: the whole list as it now stands. */
  const replaceShapes = useCallback((shapes: Shape[]) => {
    setFilters((f) => ({ ...f, shapes }));
  }, [setFilters]);
  /** True when the focus query hit its cap, so the map is showing a sample. */
  const [focusCapped, setFocusCapped] = useState(false);
  /**
   * The focus result, kept.
   *
   * It used to go straight into the GeoJSON source and be forgotten, which is
   * fine for drawing and useless for saying what is on screen. Orion's viewport
   * slice is filtered from this; the tile layer has no equivalent, and the slice
   * says so rather than implying the map is empty.
   */
  const [focusWells, setFocusWells] = useState<FocusWell[]>([]);
  /**
   * WHERE or WHOSE the current search is — the three fields that name a place
   * or a party, as opposed to the ones that narrow which wells qualify. Only a
   * change here earns a camera move; see the fit in the focus effect.
   */
  const focusSubject = useMemo(
    () =>
      [
        // Every county the bar names, so adding a second one is a new subject
        // and the camera opens out to cover both.
        (chosen(filters.county) ?? []).map((c) => `c${c}`).join(","),
        filters.operator ? `o${filters.operator.operator_number}` : "",
        filters.person ? `p${filters.person}` : "",
      ]
        .filter(Boolean)
        .join("|"),
    [filters.county, filters.operator, filters.person]
  );
  /** The subject the camera was last moved for. */
  const fittedSubjectRef = useRef("");
  /**
   * Whether wells mode is drawing the query-backed focus layer instead of the
   * vector tiles: true whenever a filter is set that the tiles cannot answer,
   * a DRAWN AREA included.
   *
   * The rule itself is `needsFocusLayer` in `@/lib/scout/filter-focus`, beside
   * the mapping that builds the query, because the two have to agree: a
   * predicate one counts and the other drops is either a filter that silently
   * does nothing or a blank map.
   *
   * Derived on every render rather than memoised: it is a boolean, so the
   * effects that depend on it compare by value, and a stale "showing a sample"
   * warning has to disappear the moment the map goes back to the tile layer.
   */
  const focusActive = needsFocusLayer(filters);
  // Identity-stable prices so the operator-mode effect re-filters when a quote
  // actually moves, not on every render of a fresh props object.
  const { oilPerBbl, gasPerMcf } = prices;
  const priceModel = useMemo<CommodityPrices>(
    () => ({ oilPerBbl, gasPerMcf }),
    [oilPerBbl, gasPerMcf]
  );
  // The hover popup lives inside the map-init effect, which must NOT re-run when
  // a price ticks (that would tear down and rebuild the map), so it reads the
  // latest prices through a ref instead.
  const pricesRef = useRef(priceModel);
  // Same treatment, same reason: the map-init effect must not re-run, and the
  // tile version is fixed for the life of the page (it is server-rendered from
  // the points file on disk).
  const tileVersionRef = useRef(tileVersion);
  useEffect(() => {
    pricesRef.current = priceModel;
  }, [priceModel]);
  const prevModeRef = useRef<MapMode>("wells");
  // Authoritative operator points (by number) for enriching cluster-leaf rows;
  // cluster-leaf properties don't reliably carry every field.
  const opPointsRef = useRef<Map<number, OperatorPoint>>(new Map());
  // county code -> the operators with a wellbore in it. Cached as the in-flight
  // promise so two rapid re-runs share one lookup instead of racing two.
  const countyOpsRef = useRef<Map<number, Promise<Set<number>>>>(new Map());
  // The survey grid, which owns its own viewport loading (see survey-layer.ts).
  const surveyRef = useRef<SurveyLayer | null>(null);
  const pipelineRef = useRef<PipelineLayer | null>(null);

  // Stable identities: the map-init effect closes over these, and it must never
  // re-run (that would tear down and rebuild the map).
  /** Open a dossier on top of the history (unless it is already on top). */
  const push = useCallback(
    (e: DossierEntry) =>
      setStack((s) => {
        const last = s[s.length - 1];
        if (last && JSON.stringify(last) === JSON.stringify(e)) return s;
        return [...s, e].slice(-DOSSIER_HISTORY_CAP);
      }),
    []
  );
  const openWell = useCallback((api: number) => push({ kind: "well", api }), [push]);
  const openOperator = useCallback(
    (operatorNumber: number) => push({ kind: "operator", operatorNumber }),
    [push]
  );
  /**
   * The operators one principal is listed on, or null when nobody is picked.
   *
   * This is what a person search MEANS on a map of wells: people don't hold
   * wellbores, operating companies do, so the person resolves to their P-5
   * companies and the map draws those. Read from the RRC mirror (the same
   * lookup the principal panel renders, cached per name in `rrc-people.ts`), so
   * the panel's list and the map's dots can never disagree.
   */
  const personOperators = useCallback(
    (name: string | null): Promise<number[] | null> =>
      name ? getPersonOperators(name) : Promise.resolve(null),
    []
  );

  const openLease = useCallback(
    (key: PdqLeaseKey) => push({ kind: "lease", key }),
    [push]
  );
  /** A mineral owner's dossier, from the owner panel, a Minerals tab or a co-owner row. */
  const openOwnerDossier = useCallback(
    (key: OwnerKey, name?: string | null) => push({ kind: "owner", key: { ...key, name } }),
    [push]
  );

  /**
   * Close one dossier, but only from the top of the stack.
   *
   * Every mounted modal hears Escape, and the ones underneath are behind the
   * top one's backdrop so their close button cannot be reached either. Refusing
   * a close from anywhere but the top is what makes Escape peel one layer.
   */
  const closeDossier = useCallback((k: Dossier) => {
    setStack((s) => (s[s.length - 1]?.kind === k ? s.slice(0, -1) : s));
  }, []);

  /*
   * The X on any dossier: out of all of them at once. Back (and Escape, and the
   * backdrop) peels one with `closeDossier`; this is for a reader done with the
   * whole chain who would otherwise close it a layer at a time.
   */
  const closeAllDossiers = useCallback(() => setStack([]), []);

  /*
   * A principal opens a side PANEL, which lives under the modal layer.
   *
   * Leaving the dossiers up would leave the click looking like it did nothing.
   * Standing them down is the honest reading anyway: following a principal is
   * leaving this well for the person behind it.
   */
  const openPrincipal = useCallback((name: string) => {
    setSelectedPrincipal(name);
    setStack([]);
  }, []);

  // Selecting a well from the operator panel jumps the map + well detail to it.
  /*
   * The drawn shapes onto the map.
   *
   * `styleEpoch` for the same reason the pin's ring carries it: `setStyle`
   * empties every source the app added, so a basemap toggle would otherwise
   * leave the area filtering the query with nothing on screen to show for it.
   */
  useEffect(() => {
    if (!ready) return;
    shapeLayerRef.current?.setShapes(filters.shapes);
  }, [filters.shapes, ready, styleEpoch]);

  /** Which gesture the canvas is armed for. Survives a style swap untouched:
   *  the pointer handlers belong to the map, not to the style. */
  useEffect(() => {
    if (ready) shapeLayerRef.current?.setTool(drawTool);
  }, [drawTool, ready]);

  const handleSelectWell = (api: number, lng: number | null, lat: number | null) => {
    openWell(api);
    if (lng != null && lat != null && mapRef.current) {
      mapRef.current.flyTo({
        center: [lng, lat],
        zoom: Math.max(mapRef.current.getZoom(), 11),
      });
    }
  };

  // Initialize the map once.
  useEffect(() => {
    if (mapRef.current) return;
    if (!token || !containerRef.current) {
      trace(`map NOT created: ${!token ? "NEXT_PUBLIC_MAPBOX_TOKEN is empty in the browser bundle" : "container not mounted"}`);
      return;
    }
    const box = containerRef.current.getBoundingClientRect();
    trace(
      `creating map: container ${Math.round(box.width)}x${Math.round(box.height)}, style ${basemapStyle(DEFAULT_BASEMAP, darkThemeRef.current)}, webgl ${mapboxgl.supported?.() === false ? "UNSUPPORTED" : "ok"}`
    );
    mapboxgl.accessToken = token;
    /*
     * Mapbox does all loading (tiles, glyphs, even an empty geojson source) in
     * web workers. If none of its sources ever load, the workers are the
     * suspect, so check that this page can run a worker at all and log any
     * worker or page error, which Next would not otherwise forward.
     */
    const mb = mapboxgl as unknown as { workerCount?: number; workerUrl?: string };
    trace(`mapbox ${mapboxgl.version}, workerCount ${mb.workerCount}, workerUrl ${mb.workerUrl || "(bundled blob)"}`);
    try {
      const probe = new Worker(
        URL.createObjectURL(new Blob(["postMessage('pong')"], { type: "text/javascript" }))
      );
      const t0 = performance.now();
      const dead = window.setTimeout(() => console.error("[recon] worker probe: NO reply in 3s, web workers are not running on this page"), 3_000);
      probe.onmessage = () => {
        window.clearTimeout(dead);
        trace(`worker probe: blob worker replied in ${Math.round(performance.now() - t0)}ms`);
        probe.terminate();
      };
      probe.onerror = (e) => {
        window.clearTimeout(dead);
        console.error(`[recon] worker probe FAILED: ${e.message || "error event"}`);
      };
    } catch (err) {
      console.error("[recon] worker probe could not start a Worker:", err);
    }
    const onPageError = (e: ErrorEvent) =>
      console.error(`[recon] page error: ${e.message} (${e.filename}:${e.lineno})`);
    const onRejection = (e: PromiseRejectionEvent) =>
      console.error("[recon] unhandled rejection:", e.reason);
    window.addEventListener("error", onPageError);
    window.addEventListener("unhandledrejection", onRejection);
    let tilesTraced = 0;
    /*
     * Every request Mapbox makes (style, sprite, glyphs, basemap and well
     * tiles), keyed by URL without the token, and whether it has finished. A
     * request finishes when the browser records its resource timing entry.
     * The stall trace lists whatever is still open.
     */
    const requests = new Map<string, { type: string; at: number; done: boolean }>();
    const keyOf = (url: string) => url.replace(/([?&])access_token=[^&]*/, "$1").replace(/[?&]$/, "");
    const resources = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const r = requests.get(keyOf(e.name));
        if (r && !r.done) {
          r.done = true;
          const res = e as PerformanceResourceTiming;
          if (res.responseStatus >= 400) {
            console.error(`[recon] request FAILED ${res.responseStatus}: ${r.type} ${keyOf(e.name)}`);
          }
        }
      }
    });
    resources.observe({ type: "resource", buffered: true });
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: basemapStyle(DEFAULT_BASEMAP, darkThemeRef.current),
      bounds: TEXAS_BOUNDS,
      fitBoundsOptions: { padding: 24 },
      transformRequest: (url, type) => {
        const k = keyOf(url);
        if (!requests.has(k)) requests.set(k, { type: String(type ?? "?"), at: Math.round(performance.now()), done: false });
        if (url.includes("/api/scout/tiles/") && tilesTraced < TRACE_TILES) {
          tilesTraced++;
          trace(`tile requested ${url.split("/api/scout/tiles/")[1]?.split("?")[0]}`);
        }
        return { url };
      },
    });
    mapRef.current = map;
    trace("map created");
    map.on("error", (e) => {
      const src = (e as { sourceId?: string }).sourceId;
      console.error(`[recon] mapbox error${src ? ` (source ${src})` : ""}: ${e.error?.message ?? String(e)}`);
    });
    map.once("load", () => trace("map load (style + first resources)"));
    map.on("webglcontextlost", () => console.error("[recon] WebGL context lost"));
    let wellsSourceLoaded = false;
    map.on("sourcedata", (e) => {
      if (wellsSourceLoaded || e.sourceId !== SOURCE_ID || !e.isSourceLoaded) return;
      wellsSourceLoaded = true;
      trace("wells source loaded (every tile for the view is in)");
    });
    // The loading pill waits on the first idle. If it never comes, say what
    // the map is still waiting on rather than spinning silently.
    const stall = window.setTimeout(() => {
      const open = [...requests.entries()].filter(([, r]) => !r.done);
      const sources = Object.keys(map.getStyle()?.sources ?? {}).filter((id) => !map.isSourceLoaded(id));
      trace(
        `STILL NOT IDLE after 15s: style loaded ${map.isStyleLoaded()}, tiles loaded ${map.areTilesLoaded()}, sources not loaded [${sources.join(", ")}], ${requests.size} requests made, ${open.length} still open`
      );
      for (const [url, r] of open.slice(0, 30)) trace(`  OPEN since +${r.at}ms: ${r.type} ${url}`);
    }, 15_000);
    // No `NavigationControl`: the controls are `MapControls`, rendered over the
    // canvas bottom-right so they can sit in one horizontal bar alongside the
    // basemap toggle. Mapbox's own group only stacks vertically.

    // `once`, deliberately: the indicator is for the FIRST paint. `idle` fires
    // again after every pan and zoom, and re-showing it then would flash a
    // loading pill over a map the user is already reading. Not timed out — if
    // tiles are genuinely still coming, saying so is better than hiding it.
    map.once("idle", () => {
      window.clearTimeout(stall);
      trace(`first idle: opening view drawn (${map.queryRenderedFeatures({ layers: PMTILES_LAYERS.filter((l) => map.getLayer(l)) }).length} well features on screen)`);
      setDrawn(true);
    });

    /*
     * `style.load`, not `load`.
     *
     * `load` fires once. Every source and layer below belongs to the STYLE, and
     * `setStyle` (the basemap toggle) throws all of them away — so this has to
     * run again after each swap or the map comes back as a bare basemap with no
     * wells on it.
     */
    map.on("style.load", () => {
      trace("style.load: adding sources and layers");
      try {
      /*
       * Survey/abstract tracts — the property lines.
       *
       * Added before the well layers so the grid sits UNDER the dots: it is
       * context for the wells, never the thing being read.
       */
      // Seeded from the SAME default the style is, so the grid is not painted
      // for the light basemap on a map that opened on imagery. The paint effect
      // below repaints it on every later swap.
      surveyRef.current ??= attachSurveyLayer(map, {
        satellite: isDarkGround(DEFAULT_BASEMAP, darkThemeRef.current),
      });
      surveyRef.current.add();
      pipelineRef.current ??= attachPipelineLayer(map, {
        satellite: isDarkGround(DEFAULT_BASEMAP, darkThemeRef.current),
      });
      pipelineRef.current.add();
      /*
       * The drawn area. Attached once — its pointer handlers belong to the map,
       * not to the style — but `add()` runs after every style load, because
       * `setStyle` throws away the sources it draws into. Hand-rolled rather
       * than `@mapbox/mapbox-gl-draw` precisely because that library does not
       * survive this line; see the module's header.
       */
      shapeLayerRef.current ??= attachShapeLayer(map, {
        satellite: isDarkGround(DEFAULT_BASEMAP, darkThemeRef.current),
        onCreate: commitDrawnShape,
        onEdit: replaceShapes,
      });
      map.addSource(SOURCE_ID, {
        type: "vector",
        tiles: [
          `${window.location.origin}/api/scout/tiles/{z}/{x}/{y}?v=${tileVersionRef.current}`,
        ],
        minzoom: 0,
        maxzoom: 13,
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: SOURCE_ID,
        "source-layer": SOURCE_LAYER,
        filter: clusterFilter(DEFAULT_FILTERS),
        paint: {
          "circle-color": clusterColor(DEFAULT_FILTERS),
          "circle-radius": clusterRadius(DEFAULT_FILTERS),
          "circle-opacity": 0.85,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: SOURCE_ID,
        "source-layer": SOURCE_LAYER,
        filter: clusterFilter(DEFAULT_FILTERS),
        layout: {
          "text-field": clusterLabel(DEFAULT_FILTERS),
          "text-size": 12,
        },
        paint: { "text-color": "#ffffff" },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "wells",
        type: "circle",
        source: SOURCE_ID,
        "source-layer": SOURCE_LAYER,
        filter: wellsFilter(DEFAULT_FILTERS),
        paint: {
          "circle-color": wellColor,
          "circle-radius": baseRadius,
          "circle-stroke-width": 0,
          "circle-stroke-color": "#f59e0b",
          "circle-opacity": 0.9,
        },
      } as unknown as mapboxgl.LayerSpecification);

      /*
       * The focused operator's footprint: the survey tracts its wells sit in,
       * drawn UNDER the dots.
       *
       * The RRC publishes no lease boundaries, so this is the same
       * approximation `/leases` makes for one lease, and it is painted the same
       * amber so the two pages agree about what a property line looks like. A
       * tract is bigger than the lease inside it.
       */
      map.addSource(OPERATOR_TRACT_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "operator-tract-fill",
        type: "fill",
        source: OPERATOR_TRACT_SOURCE,
        paint: { "fill-color": "#fbbf24", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "operator-tract-line",
        type: "line",
        source: OPERATOR_TRACT_SOURCE,
        paint: {
          "line-color": "#fbbf24",
          "line-width": 1.5,
          "line-opacity": 0.9,
        },
      });

      // Focus layer: a Supabase-backed GeoJSON source, natively clustered, that
      // shows ONLY the wells matching a county/operator search. Hidden until a
      // narrow search is active.
      map.addSource(FOCUS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterRadius: 50,
        // One below SURVEY_MIN_ZOOM, matching the tile index in live-tiler.ts:
        // past this the focus layer is one dot per well, not a bubble.
        clusterMaxZoom: SURVEY_MIN_ZOOM - 1,
      } as unknown as mapboxgl.SourceSpecification);

      map.addLayer({
        id: "focus-clusters",
        type: "circle",
        source: FOCUS_SOURCE,
        filter: ["has", "point_count"],
        layout: { visibility: "none" },
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#93c5fd",
            100,
            "#60a5fa",
            1000,
            "#3b82f6",
            10000,
            "#1d4ed8",
          ],
          "circle-radius": ["step", ["get", "point_count"], 12, 100, 16, 1000, 22, 10000, 30],
          "circle-opacity": 0.85,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "focus-cluster-count",
        type: "symbol",
        source: FOCUS_SOURCE,
        filter: ["has", "point_count"],
        layout: {
          visibility: "none",
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
        },
        paint: { "text-color": "#ffffff" },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "focus-wells",
        type: "circle",
        source: FOCUS_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: { visibility: "none" },
        paint: {
          "circle-color": wellColor,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3, 13, 6],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.95,
        },
      } as unknown as mapboxgl.LayerSpecification);

      // Operator mode: operators placed at their mailing-ZIP centroid, natively
      // clustered (many share a ZIP). Violet to distinguish from the wells.
      map.addSource(OPERATOR_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterRadius: 45,
        clusterMaxZoom: 11,
      } as unknown as mapboxgl.SourceSpecification);

      map.addLayer({
        id: "op-clusters",
        type: "circle",
        source: OPERATOR_SOURCE,
        filter: ["has", "point_count"],
        layout: { visibility: "none" },
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#c4b5fd",
            50,
            "#a78bfa",
            200,
            "#8b5cf6",
            1000,
            "#6d28d9",
          ],
          "circle-radius": ["step", ["get", "point_count"], 14, 50, 18, 200, 24, 1000, 32],
          "circle-opacity": 0.85,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "op-cluster-count",
        type: "symbol",
        source: OPERATOR_SOURCE,
        filter: ["has", "point_count"],
        layout: {
          visibility: "none",
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
        },
        paint: { "text-color": "#ffffff" },
      } as unknown as mapboxgl.LayerSpecification);

      /*
       * PENDING DRILLING PERMITS.
       *
       * A plain GeoJSON source, not tiles: the live queue is ~500 applications
       * statewide, so the whole thing is one small payload and a tiling
       * pipeline for it would be machinery around nothing.
       *
       * Two layers, because the point of this mode is NOTICING. A halo scaled
       * by how recently the permit was filed puts the last fortnight's activity
       * forward without hiding the rest, which a single uniform dot cannot do.
       */
      map.addSource(PERMIT_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterRadius: 45,
        clusterMaxZoom: 11,
      } as unknown as mapboxgl.SourceSpecification);

      /*
       * ALREADY-DECIDED permits: approved, and approved-and-drilled.
       *
       * CLUSTERED, because there are ~10,500 of them and drawing every one at
       * every zoom is what made this mode slow to load. Pending permits live in
       * their own unclustered source above -- see the route.
       *
       * `clusterProperties` counts the drilled ones inside each cluster, so the
       * bubble can be coloured by what it actually contains rather than being a
       * uniform grey blob that hides the split.
       */
      map.addSource(PERMIT_HISTORY_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterRadius: 45,
        clusterMaxZoom: 11,
        clusterProperties: {
          drilled: ["+", ["case", ["==", ["get", "kind"], "drilled"], 1, 0]],
        },
      } as unknown as mapboxgl.SourceSpecification);

      map.addLayer({
        id: "permit-clusters",
        type: "circle",
        source: PERMIT_HISTORY_SOURCE,
        filter: ["has", "point_count"],
        layout: { visibility: "none" },
        paint: {
          // Green where most of the cluster was drilled, gray where most was
          // not: the mix is the interesting part at this zoom.
          "circle-color": [
            "case",
            [">", ["*", 2, ["get", "drilled"]], ["get", "point_count"]],
            "#16a34a",
            "#9ca3af",
          ],
          "circle-radius": CLUSTER_RADIUS,
          "circle-opacity": 0.85,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "permit-cluster-count",
        type: "symbol",
        source: PERMIT_HISTORY_SOURCE,
        filter: ["has", "point_count"],
        layout: {
          visibility: "none",
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
        },
        paint: { "text-color": "#ffffff" },
      } as unknown as mapboxgl.LayerSpecification);

      // Same glow the pending dots get, in each state's own colour, so the
      // three read as one family of marks rather than as two layers that
      // happen to share a screen.
      map.addLayer({
        id: "permit-history-halo",
        type: "circle",
        source: PERMIT_HISTORY_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: { visibility: "none" },
        paint: {
          "circle-color": [
            "case", ["==", ["get", "kind"], "drilled"], "#16a34a", "#9ca3af",
          ],
          "circle-radius": PERMIT_HALO_RADIUS,
          "circle-opacity": PERMIT_HALO_OPACITY,
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "permit-history",
        type: "circle",
        source: PERMIT_HISTORY_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: { visibility: "none" },
        paint: {
          "circle-color": [
            "case", ["==", ["get", "kind"], "drilled"], "#16a34a", "#9ca3af",
          ],
          "circle-radius": PERMIT_DOT_RADIUS,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.9,
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "permit-pending-clusters",
        type: "circle",
        source: PERMIT_SOURCE,
        filter: ["has", "point_count"],
        layout: { visibility: "none" },
        paint: {
          "circle-color": "#f59e0b",
          "circle-radius": CLUSTER_RADIUS,
          "circle-opacity": 0.85,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "permit-pending-count",
        type: "symbol",
        source: PERMIT_SOURCE,
        filter: ["has", "point_count"],
        layout: {
          visibility: "none",
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
        },
        paint: { "text-color": "#ffffff" },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "permit-halo",
        type: "circle",
        source: PERMIT_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: { visibility: "none" },
        paint: {
          "circle-color": "#f59e0b",
          "circle-radius": PERMIT_HALO_RADIUS,
          "circle-opacity": PERMIT_HALO_OPACITY,
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "permit-points",
        type: "circle",
        source: PERMIT_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: { visibility: "none" },
        paint: {
          // Horizontal wells are the ones worth spotting at a glance.
          "circle-color": [
            "case", ["==", ["get", "horiz"], 1], "#b45309", "#f59e0b",
          ],
          "circle-radius": PERMIT_DOT_RADIUS,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.95,
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "op-points",
        type: "circle",
        source: OPERATOR_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: { visibility: "none" },
        paint: {
          "circle-color": "#7c3aed",
          "circle-radius": ["interpolate", ["linear"], ["get", "w"], 1, 4, 50, 8, 500, 13, 5000, 20],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.9,
        },
      } as unknown as mapboxgl.LayerSpecification);
      // The drawn area goes on LAST, so its outline and its corner handles sit
      // over every dot rather than under them: a handle you cannot see is a
      // handle you cannot grab, and the whole point of the vertices is that the
      // shape stays editable after it is drawn.
      shapeLayerRef.current?.add();
        trace(`layers added: ${map.getStyle()?.layers?.length ?? 0} in style, wells source ${map.getSource(SOURCE_ID) ? "present" : "MISSING"}`);
      } catch (err) {
        console.error("[recon] map layer setup FAILED; no wells will draw", err);
      }

      setReady(true);
      setStyleEpoch((n) => n + 1);
    });

    const onClusterClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat || feat.geometry.type !== "Point") return;
      map.easeTo({
        center: feat.geometry.coordinates as [number, number],
        zoom: Math.min(map.getZoom() + 2.5, 14),
      });
    };
    const onWellClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      /*
       * WHILE THE RING TOOL IS ARMED, A WELL IS AN ANCHOR, NOT A DOSSIER.
       *
       * This is the producer the radius pin cannot be: the pin is one free
       * point at one radius and answers a side panel, while these are rings
       * around WELLS, as many as you click, unioned into the filter. The tool
       * stays armed so "these four wells and everything within two miles of
       * them" is four clicks rather than four round trips through the toolbar.
       */
      if (drawToolRef.current === "ring" && feat.geometry.type === "Point") {
        const [lon, lat] = feat.geometry.coordinates;
        setFilters((f) => ({
          ...f,
          shapes: [...f.shapes, ringAround(lat, lon, ringMilesRef.current)],
        }));
        return;
      }
      openWell(Number(feat.properties.api));
    };
    const onOpPointClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      openOperator(Number(feat.properties.n));
    };
    const onOpClusterClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      const clusterId = feat.properties.cluster_id as number;
      const src = map.getSource(OPERATOR_SOURCE) as mapboxgl.GeoJSONSource | undefined;
      if (!src) return;
      src.getClusterLeaves(clusterId, 1000, 0, (err, leaves) => {
        if (err || !leaves) return;
        const items: OperatorListItem[] = leaves.map((l) => {
          const p = (l.properties ?? {}) as Record<string, unknown>;
          const n = Number(p.n);
          // Counts come from the authoritative operator cache; the displayed `w`
          // stays the effective (toggle-aware) value shown on the map.
          const op = opPointsRef.current.get(n);
          const wt = op?.w ?? Number(p.wt ?? p.w ?? 0);
          const wa = op?.wa ?? op?.w ?? Number(p.wa ?? p.w ?? 0);
          return {
            n,
            nm: String(p.nm ?? op?.nm ?? ""),
            a: String(p.a ?? op?.a ?? ""),
            c: String(p.c ?? op?.c ?? ""),
            s: String(p.s ?? op?.s ?? ""),
            z: Number(p.z ?? op?.z ?? 0),
            w: Number(p.w ?? wt),
            wt,
            wa,
          };
        });
        const first = items[0];
        const title =
          first && (first.c || first.s)
            ? `Operators near ${[first.c, first.s].filter(Boolean).join(", ")}`
            : "Operators";
        setOperatorList({ title, items });
      });
    };
    const cursorOn = () => (map.getCanvas().style.cursor = "pointer");
    const cursorOff = () => (map.getCanvas().style.cursor = "");

    // Operator address popup on hover.
    const opPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
    });
    const onOpEnter = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      const p = feat.properties;
      const el = document.createElement("div");
      el.style.whiteSpace = "pre-line";
      el.style.fontSize = "12px";
      el.style.lineHeight = "1.35";
      el.innerText = [
        partyName(String(p.nm)),
        p.a ? String(p.a) : "",
        [p.c, p.s, p.z].filter(Boolean).map(String).join(" "),
        `${p.w} wells operated`,
        // The lease footprint as a monthly rate + what it's worth at today's
        // prices; only shown when there is production on file.
        Number(p.o12) || Number(p.g12)
          ? `${fmtVol(Math.round(perMonth(Number(p.o12), Number(p.m12))))} bbl/mo · ` +
            `${fmtVol(Math.round(perMonth(Number(p.g12), Number(p.m12))))} MCF/mo\n` +
            `~$${fmtVol(
              Math.round(
                monthlyRevenue(
                  perMonth(Number(p.o12), Number(p.m12)),
                  perMonth(Number(p.g12), Number(p.m12)),
                  pricesRef.current
                )
              )
            )}/mo est.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      opPopup.setLngLat(feat.geometry.coordinates as [number, number]).setDOMContent(el).addTo(map);
    };
    const onOpLeave = () => opPopup.remove();

    /*
     * Pipelines get a hover popup rather than a panel.
     *
     * A line is not an entity you open a dossier on -- what you want is what it
     * carries, how big it is and whose it is, read off without losing your
     * place. The operator IS clickable from there, which is the route into the
     * dossier for anyone who wants it.
     */
    const pipePopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 8,
      className: "scout-popup",
    });
    const onPipeEnter = (e: mapboxgl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const p = f?.properties as Record<string, unknown> | undefined;
      if (!p) return;
      const el = document.createElement("div");
      el.className = "px-2 py-1.5 text-xs leading-snug";
      const dia = p.dia ? `${Number(p.dia).toFixed(2)}"` : "size n/a";
      const dead = p.dead === 1 ? ` · ${String(p.status)}` : "";
      el.innerHTML =
        `<div class="font-medium">${String(p.desc ?? "Pipeline")} · ${dia}${dead}</div>` +
        `<div class="text-muted-foreground">${String(p.op ?? "operator not named")}</div>` +
        (p.sys ? `<div class="text-muted-foreground">${String(p.sys)}</div>` : "");
      pipePopup.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
    };
    const onPipeLeave = () => pipePopup.remove();
    const onPipeClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as Record<string, unknown> | undefined;
      const no = p?.opNo ? String(p.opNo) : null;
      if (no) openOperator(Number(no));
    };
    for (const id of PIPELINE_LAYERS) {
      map.on("mousemove", id, onPipeEnter);
      map.on("mouseenter", id, cursorOn);
      map.on("mouseleave", id, onPipeLeave);
      map.on("mouseleave", id, cursorOff);
      map.on("click", id, onPipeClick);
    }

    const onPermitClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const f = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (f?.properties) setPermit(f.properties as Record<string, unknown>);
    };
    map.on("click", "permit-points", onPermitClick);
    map.on("click", "permit-history", onPermitClick);
    map.on("click", "permit-clusters", onClusterClick);
    map.on("click", "permit-pending-clusters", onClusterClick);

    map.on("click", "clusters", onClusterClick);
    map.on("click", "wells", onWellClick);
    map.on("click", "focus-clusters", onClusterClick);
    map.on("click", "focus-wells", onWellClick);
    map.on("click", "op-clusters", onOpClusterClick);
    map.on("click", "op-points", onOpPointClick);
    for (const id of [
      "clusters",
      "wells",
      "focus-clusters",
      "focus-wells",
      "op-clusters",
      "op-points",
      "permit-points",
      "permit-history",
      "permit-clusters",
      "permit-pending-clusters",
    ]) {
      map.on("mouseenter", id, cursorOn);
      map.on("mouseleave", id, cursorOff);
    }
    map.on("mouseenter", "op-points", onOpEnter);
    map.on("mouseleave", "op-points", onOpLeave);

    /*
     * What is this hole making? The dots carry an API and nothing else, so the
     * rate is fetched for the one under the cursor and cached
     * (`./use-well-rates`). The popup shows the API immediately and gains the
     * rate when it lands.
     */
    const wellPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
    });
    const onWellEnter = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      const api = String(feat.properties.api ?? "");
      ratesRef.current.request(api);
      const el = document.createElement("div");
      el.style.whiteSpace = "pre-line";
      el.style.fontSize = "12px";
      el.style.lineHeight = "1.35";
      const paint = () => {
        const r = ratesRef.current.rateFor(api);
        el.innerText = [r?.name ?? "", `API ${api}`, formatRate(r) ?? ""]
          .filter(Boolean)
          .join("\n");
      };
      paint();
      const t = setTimeout(paint, 400);
      wellPopup.once("close", () => clearTimeout(t));
      wellPopup
        .setLngLat(feat.geometry.coordinates as [number, number])
        .setDOMContent(el)
        .addTo(map);
    };
    const onWellLeave = () => wellPopup.remove();
    for (const id of ["wells", "focus-wells"]) {
      map.on("mouseenter", id, onWellEnter);
      map.on("mouseleave", id, onWellLeave);
    }

    /*
     * Warm the rates for what is on screen once the map stops moving, so a
     * hover reads an answer that is already in hand rather than opening a
     * request and looking slow.
     *
     * `idle` fires after the map has finished rendering, and the prefetch
     * itself runs in an idle callback in capped batches, so this never competes
     * with panning or tile loading.
     */
    const onIdle = () => {
      const layers = ["wells", "focus-wells"].filter((id) => map.getLayer(id));
      if (layers.length === 0) return;
      const feats = map.queryRenderedFeatures({ layers });
      if (feats.length === 0) return;
      ratesRef.current.prefetch(
        feats.map((f) => String(f.properties?.api ?? "")).filter(Boolean)
      );
    };
    map.on("idle", onIdle);

    /*
     * Keep the canvas the size of its container.
     *
     * Mapbox sizes the canvas once at construction and thereafter only on the
     * WINDOW's resize event. Collapsing the app sidebar does not resize the
     * window — it widens this container inside an unchanged viewport — so the
     * canvas stayed at its old width and the new space rendered as blank page
     * behind it. Same for the detail panels opening and closing beside it.
     *
     * A ResizeObserver on the container is the thing that actually observes
     * what matters. `map.resize()` is a no-op when the size has not changed, so
     * the observer's initial synchronous call costs nothing.
     */
    let resizes = 0;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && resizes++ < 5) trace(`container resized to ${Math.round(r.width)}x${Math.round(r.height)}`);
      map.resize();
    });
    ro.observe(containerRef.current);

    return () => {
      trace("map removed (component unmounted)");
      window.clearTimeout(stall);
      resources.disconnect();
      window.removeEventListener("error", onPageError);
      window.removeEventListener("unhandledrejection", onRejection);
      ro.disconnect();
      surveyRef.current?.destroy();
      surveyRef.current = null;
      pipelineRef.current?.destroy();
      pipelineRef.current = null;
      shapeLayerRef.current?.destroy();
      shapeLayerRef.current = null;
      map.remove();
      mapRef.current = null;
      setReady(false);
      setDrawn(false);
    };
    // `openWell`/`openOperator` are `useCallback(..., [])`, so listing them
    // cannot re-run this effect and rebuild the map.
  }, [token, openWell, openOperator, commitDrawnShape, replaceShapes, setFilters]);

  /*
   * ORION'S VIEW OF THIS MAP.
   *
   * Three slices, because there are three separate things on the screen: the
   * dossier being read, what the map is drawing, and the filters that shaped it.
   * The builders are pure and live in `@/lib/ai/context-slices`, so all of this
   * is testable without a canvas; the only thing here is the wiring.
   *
   * The viewport is read on `moveend`, never per frame. A slice that rewrote the
   * store on every animation tick would cost a store write per frame for a value
   * nobody reads until a turn is sent.
   */
  const [viewport, setViewport] = useState<{ bbox: Bbox; zoom: number } | null>(
    null
  );
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const read = () => {
      const b = map.getBounds();
      if (!b) return;
      setViewport({
        bbox: {
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
        },
        zoom: map.getZoom(),
      });
    };
    read();
    map.on("moveend", read);
    return () => {
      map.off("moveend", read);
    };
  }, [ready]);

  // Gated on `focusActive` rather than on the array being emptied when a search
  // is cleared. Emptying it meant a setState in the filter effect's body, which
  // is a cascading render for a value nobody reads until a turn is sent; the
  // last search's wells simply stop being READ the moment focus is off.
  const wellsInView = useMemo(() => {
    const b = viewport?.bbox;
    if (!b || !focusActive) return [];
    const op = filters.operator?.operator_number ?? undefined;
    return focusWells
      .filter(
        (w) =>
          w.lng >= b.west && w.lng <= b.east && w.lat >= b.south && w.lat <= b.north
      )
      .map((w) => ({
        api: w.api,
        operator: filters.operator?.operator_name ?? undefined,
        operatorNumber: op,
      }));
  }, [viewport, focusWells, filters.operator, focusActive]);

  /*
   * THE SELECTION: the wells the drawn area holds.
   *
   * `wellsInShapes` rather than "whatever the query returned", even though the
   * shape predicate already ran server-side and the two agree well for well
   * (`geo-shapes-check.test.ts` pins that). Two reasons it is still computed
   * here: the shapes are a UNION, so a well inside two of them has to be
   * counted once, and this is the number the panel puts on screen — reading it
   * off the same geometry the browser drew is what makes the count and the
   * outline impossible to disagree.
   *
   * Empty in the other two modes and off the tile layer, because neither can
   * say which wells are under a shape: no shapes selects NOTHING, which is the
   * asymmetry `geo-shapes.ts` documents.
   */
  const selection = useMemo(
    () =>
      filters.mode === "wells" && focusActive
        ? wellsInShapes(focusWells, filters.shapes)
        : [],
    [filters.mode, filters.shapes, focusWells, focusActive]
  );

  usePageContextSlice(
    "scout.viewport",
    useMemo(
      () =>
        buildScoutViewportSlice({
          mode: filters.mode,
          bbox: viewport?.bbox ?? null,
          zoom: viewport?.zoom ?? 0,
          wellsInView,
          // The focus layer is the only one that knows WHICH wells are drawn;
          // the statewide tile layer is a picture, not a list. Saying so is the
          // point, so Orion asks the mirror rather than answering from nothing.
          focused: focusActive && focusWells.length > 0,
          capped: focusCapped,
          permits: permitCounts,
        }),
      [filters.mode, viewport, wellsInView, focusActive, focusWells.length, focusCapped, permitCounts]
    )
  );

  usePageContextSlice(
    "scout.modal",
    useMemo(() => {
      if (top === "well" && selectedApi != null)
        return buildScoutModalSlice({ kind: "well", id: selectedApi });
      if (top === "operator" && selectedOperator != null)
        return buildScoutModalSlice({ kind: "operator", id: selectedOperator });
      if (top === "lease" && selectedLease)
        return buildScoutModalSlice({
          kind: "lease",
          id: `${selectedLease.oil_gas_code}-${selectedLease.district_no}-${selectedLease.lease_no}`,
          facts: [
            `oil_gas_code: ${selectedLease.oil_gas_code}`,
            `district_no (PDQ): ${selectedLease.district_no}`,
            `lease_no: ${selectedLease.lease_no}`,
          ],
        });
      if (top === "owner" && selectedOwner)
        return buildScoutModalSlice({
          kind: "mineral owner",
          id: `${selectedOwner.county_no}-${selectedOwner.tax_year}-${selectedOwner.owner_id}`,
          name: selectedOwner.name ?? undefined,
          facts: [
            `county_no: ${selectedOwner.county_no}`,
            `tax_year: ${selectedOwner.tax_year}`,
            `owner_id: ${selectedOwner.owner_id}`,
          ],
        });
      return null;
    }, [top, selectedApi, selectedOperator, selectedLease, selectedOwner])
  );

  usePageContextSlice(
    "scout.filters",
    useMemo(
      () =>
        buildScoutFilterSlice({
          // Lists read as "Andrews or Martin" rather than as an array literal:
          // this is prose the model reads, and every one of these fields can now
          // hold several values.
          county: describe(chosen(filters.county), (c) => countyName(c)),
          district: describe(chosen(filters.district), (d) => `District ${d}`),
          operator: filters.operator
            ? `${filters.operator.operator_name ?? "unnamed"} (${filters.operator.operator_number})`
            : null,
          person: filters.person,
          "oil/gas": filters.oilGas,
          status: describe(chosen(filters.status), (v) => v),
          "well type": describe(chosen(filters.wellType), (v) => v),
          "min depth ft": filters.minDepth,
          "max depth ft": filters.maxDepth,
          "min completion year": filters.minCompletionYear,
          "max completion year": filters.maxCompletionYear,
          /*
           * The production band, in the same words the tool sets it by.
           *
           * It has to be HERE and not only in the tool: Orion sets a filter and
           * then reads this slice back to say what the map is showing, so a
           * band it could set but not see would have it report a map that has
           * one as a map that does not. Allocated per month over the last 12
           * filed months, which is what `wildcat.well_rate` stores and what the
           * hover label shows.
           */
          "min oil bbl/mo": filters.minOilRate,
          "max oil bbl/mo": filters.maxOilRate,
          "min gas mcf/mo": filters.minGasRate,
          "max gas mcf/mo": filters.maxGasRate,
          // Permits mode's date range: filed for pending, issued for approved.
          "permits from": filters.permitSince,
          "permits to": filters.permitUntil,
          "excluding plugged": filters.excludePlugged,
          // The area is where the search is being made, so it is stated as a
          // constraint rather than as geometry: a ring of 64 coordinates would
          // outweigh every other line here and tell the model nothing it can
          // act on. `scout_set_view` refuses to SET this key for the matching
          // reason -- see `REFUSED` in `scout-view-spec.ts`.
          "drawn area": describeShapes(filters.shapes),
          "wells in the drawn area": selection.length || null,
        }),
      [filters, selection.length]
    )
  );

  /*
   * ORION'S HAND ON THIS MAP — the write half of the view above.
   *
   * The slices say what is on screen; this is how Orion changes it. The drawer
   * is mounted once in the app shell and cannot see this page, so the handler is
   * published to the same store the slices go to and the chat invokes it by key
   * once `scout_set_view` returns (`usePageActionDispatch`).
   *
   * What arrives is already normalised and already refused if any part of it was
   * wrong (`normalizeScoutView`), so there is nothing to validate here. Two
   * rules this end keeps:
   *
   *   - THE FILTERS ARE ORDINARY FILTERS. They go through the same `setFilters`
   *     the bar writes, so they show in the bar and the user clears them by
   *     hand. Nothing here is a private "AI filter" the UI cannot express.
   *   - A MODE CHANGE IS THE BAR'S MODE CHANGE, side effects and all — the
   *     dossier stack and the operator list drop exactly as they do when the
   *     mode buttons are clicked, or a well modal outlives the layer it belongs
   *     to.
   */
  usePageAction<ScoutViewDirective>(SCOUT_VIEW_ACTION, (directive) => {
    const patch = directive.filters;
    if (Object.keys(patch).length > 0) {
      if (patch.mode && patch.mode !== filters.mode) {
        setOperatorList(null);
        setStack((s) => s.filter((x) => x.kind !== "well"));
      }
      setFilters((prev) => applyScoutView(prev, patch, DEFAULT_FILTERS));
    }

    const map = mapRef.current;
    const camera = directive.camera;
    if (!map || !camera) return;
    // Same easing as every other programmatic move on this map (the operator
    // fit, the well fly-to), so a camera Orion set is not visually a different
    // kind of event from one the user caused.
    if (camera.kind === "bbox") {
      map.fitBounds(
        [
          [camera.bbox.west, camera.bbox.south],
          [camera.bbox.east, camera.bbox.north],
        ],
        { padding: 40, maxZoom: 13, duration: 800 }
      );
    } else {
      map.flyTo({ center: [camera.lon, camera.lat], zoom: camera.zoom, duration: 800 });
    }
  });

  /** Frame a set of counties (permits mode has no focus layer to do it). */
  const fitCounties = useCallback((codes: number[]) => {
    if (!codes.length) return;
    fetch(`/api/scout/rrc/county-bounds?codes=${codes.join(",")}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { west: number; south: number; east: number; north: number } | null) => {
        const map = mapRef.current;
        if (!map || !b) return;
        map.fitBounds(
          [
            [b.west, b.south],
            [b.east, b.north],
          ],
          { padding: 40, maxZoom: 13, duration: 800 }
        );
      })
      .catch(() => {
        /* stay where the map is */
      });
  }, []);

  /*
   * Permits mode frames the counties the bar names, as wells mode's focus
   * layer does. Only on a change of WHICH counties: a purpose toggle or a pan
   * must not snap the camera back.
   */
  const permitFitRef = useRef("");
  useEffect(() => {
    if (!ready || filters.mode !== "permits") {
      permitFitRef.current = "";
      return;
    }
    const counties = chosen(filters.county) ?? [];
    const key = counties.join(",");
    if (key === permitFitRef.current) return;
    permitFitRef.current = key;
    if (counties.length) fitCounties(counties);
  }, [ready, filters.mode, filters.county, fitCounties]);

  /*
   * The deep link, once the map is up. `?well=` and the permit links already
   * chose their dossier and mode in the initial state above; this moves the
   * camera, loads the permit into its panel, and resolves `?alert=` to its
   * counties. Then the URL is put back to a bare /recon, so a refresh is the
   * plain map rather than the same record reopening.
   */
  const linkHandledRef = useRef(false);
  useEffect(() => {
    if (!ready || linkHandledRef.current) return;
    linkHandledRef.current = true;
    const { well, permit: doc, permitNo, alert } = link;
    if (!well && !doc && !permitNo && !alert) return;
    window.history.replaceState(null, "", "/recon");

    if (well) {
      fetch(`/api/scout/rrc/well/${well}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { location?: { lat: number | null; lon: number | null } } | null) => {
          const map = mapRef.current;
          const lat = d?.location?.lat;
          const lon = d?.location?.lon;
          if (map && lat != null && lon != null) {
            map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 12), duration: 800 });
          } else {
            // A new well is often not in the GIS layer yet: land on its county,
            // which is the API's leading three digits.
            fitCounties([Number(well.slice(0, 3))]);
          }
        })
        .catch(() => {});
      return;
    }

    if (doc || permitNo) {
      const url = doc
        ? `/api/scout/rrc/permit/${encodeURIComponent(doc)}`
        : `/api/scout/rrc/permit/${permitNo}?by=number`;
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then(
          (p: {
            properties: Record<string, unknown>;
            lat: number | null;
            lon: number | null;
            countyCode: number | null;
          } | null) => {
            if (!p) return;
            setPermit(p.properties);
            const map = mapRef.current;
            if (map && p.lat != null && p.lon != null && (p.lat !== 0 || p.lon !== 0)) {
              map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 12), duration: 800 });
            } else if (p.countyCode) {
              fitCounties([p.countyCode]);
            }
          }
        )
        .catch(() => {});
      return;
    }

    if (alert) {
      getReconAlertCounties(alert)
        .then((codes) => {
          if (!codes?.length) return;
          // The bar's mode change, side effects and all (as `scout_set_view`).
          setOperatorList(null);
          setStack((st) => st.filter((x) => x.kind !== "well"));
          setFilters((prev) => ({ ...prev, mode: "permits", county: codes }));
        })
        .catch(() => {});
    }
    // Once per page load, against the link the page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Narrow searches (county / operator) switch to the Supabase-backed focus
  // layer that shows ONLY those wells (natively clustered) and zooms to them.
  // Broad category filters (oil/gas, status, district) apply to the tile layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const setVis = (ids: string[], v: "visible" | "none") =>
      ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", v));

    /*
     * PERMITS MODE: W-1 applications the RRC has not yet acted on.
     *
     * The only forward-looking layer on this map. Everything else draws what
     * has already happened; this draws what somebody is about to do, days to
     * weeks before the approved permit exists.
     *
     * Fetched once and kept: the queue is ~500 rows behind a nightly sync, so
     * re-querying on a mode toggle would buy nothing.
     */
    if (filters.mode === "permits") {
      setVis([...WELL_LAYERS, ...OPERATOR_LAYERS], "none");
      setVis([...PERMIT_LAYERS, ...SURVEY_LAYERS], "visible");
      prevModeRef.current = "permits";
      let cancelled = false;

      /*
       * Refetched as the viewport moves, not once per session.
       *
       * The pending queue in the response is always the whole state (~515) and
       * always drawn; the decided history is scoped to what is on screen, since
       * it is heading for ~51,000 permits once the full history lands. So a pan
       * has to go back for the decided set even though the pending one is
       * already complete.
       */
      const load = () => {
        const m = mapRef.current;
        if (!m) return;
        const b = m.getBounds();
        if (!b) return;
        const pad = 0.2;
        const box = [
          b.getWest() - pad, b.getSouth() - pad,
          b.getEast() + pad, b.getNorth() + pad,
        ];
        permitFetchRef.current?.abort();
        const ctrl = new AbortController();
        permitFetchRef.current = ctrl;
        // The date range goes to the server too: the approved history comes
        // back newest-first under a cap, so an older range cut from that
        // sample would be a fraction of the answer.
        const range = new URLSearchParams({ bbox: box.join(",") });
        if (filters.permitSince) range.set("since", filters.permitSince);
        if (filters.permitUntil) range.set("until", filters.permitUntil);
        fetch(`/api/scout/rrc/pending?${range.toString()}`, {
          signal: ctrl.signal,
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((fc) => {
            if (ctrl.signal.aborted || cancelled || !mapRef.current || !fc) return;
            permitDataRef.current = fc;
            // Options first: the menu offers what the payload carries, and the
            // count beside each one is of the payload, not of what is drawn.
            setPermitPurposes(purposeCounts(fc));
            draw();
          })
          .catch(() => {
            /* leave the previous permits drawn */
          });
      };
      /*
       * The key counts what is ON SCREEN, not what the state holds.
       *
       * Counted from the raw features rather than with queryRenderedFeatures:
       * both layers cluster, so a rendered query returns bubbles and the counts
       * would collapse to the number of bubbles as you zoom out. The payload is
       * ~11,000 points and already in memory, so a bounds test per point on
       * moveend is cheaper than the query would have been anyway.
       */
      const recount = (view: {
        pending: GeoJSON.FeatureCollection;
        history: GeoJSON.FeatureCollection;
      }) => {
        const m = mapRef.current;
        if (!m) return;
        const b = m.getBounds();
        if (!b) return;
        let total = 0;
        let approved = 0;
        let drilled = 0;
        const tally = (col: GeoJSON.FeatureCollection) => {
          for (const f of col.features) {
            const g = f.geometry;
            if (g.type !== "Point") continue;
            const [lon, lat] = g.coordinates as [number, number];
            if (!b.contains([lon, lat])) continue;
            const kind = f.properties?.kind;
            if (kind === "pending") total++;
            else if (kind === "drilled") {
              drilled++;
              approved++;
            } else approved++;
          }
        };
        // Counted from what is DRAWN, not from what was fetched, so the key and
        // the bar agree with the dots under a purpose filter.
        tally(view.pending);
        tally(view.history);
        setPermitCounts({ total, approved, drilled });
      };

      /*
       * The purpose filter, applied by RE-SETTING THE SOURCE DATA.
       *
       * Not `map.setFilter`: both permit sources cluster, and clustering happens
       * at the source, so a layer filter hides dots while the bubbles over them
       * keep counting the permits it hid. Rebuilding the collections from the
       * payload already in `permitDataRef` is what makes the clusters recount —
       * and it costs nothing, since it is a pass over ~11,000 points in memory
       * rather than another trip to the mirror.
       */
      const draw = () => {
        const m = mapRef.current;
        const fc = permitDataRef.current;
        if (!m || !fc) return;
        const byPurpose = filterPermitFeatures(fc, filters.permitPurpose);
        /*
         * The drawn area, applied the same way the purpose is: by rebuilding
         * the collections, never by `setFilter`, because these sources cluster
         * and a layer filter leaves the bubbles counting what it hid.
         *
         * A permit's position is its surface location, which is the only point
         * it has; `location_source` on the payload says how well it is known.
         */
        const inArea = (f: GeoJSON.Feature) => {
          if (f.geometry.type !== "Point") return false;
          const [lon, lat] = f.geometry.coordinates;
          return filters.shapes.some((sh) => pointInShape(sh, lon, lat));
        };
        /*
         * The county filter, on the same terms. Matched by NAME because that
         * is what the payload carries (`shapePermit` names the code), and a
         * permit with no county on file fails it rather than passing.
         */
        const counties = chosen(filters.county);
        const countyNames = counties
          ? new Set(counties.map((c) => COUNTY_NAMES[c]).filter(Boolean))
          : null;
        const inCounty = (f: GeoJSON.Feature) =>
          countyNames == null || countyNames.has(String(f.properties?.county ?? ""));
        /*
         * The date range, on `submitted`: the filing date on a pending permit,
         * the issue date on a decided one (see `getApprovedPermits`). Applied
         * here as well as on the server so the pending queue, which is served
         * whole, honours it, and so the dots change the moment the range does
         * rather than when the refetch lands. An undated permit fails a set
         * bound.
         */
        const { permitSince: since, permitUntil: until } = filters;
        const inDates = (f: GeoJSON.Feature) => {
          if (!since && !until) return true;
          const d = String(f.properties?.submitted ?? "").slice(0, 10);
          if (!d) return false;
          return (!since || d >= since) && (!until || d <= until);
        };
        const cut = (c: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection =>
          filters.shapes.length === 0 && countyNames == null && !since && !until
            ? c
            : {
                ...c,
                features: c.features.filter(
                  (f) =>
                    (filters.shapes.length === 0 || inArea(f)) && inCounty(f) && inDates(f)
                ),
              };
        const view = { pending: cut(byPurpose.pending), history: cut(byPurpose.history) };
        (m.getSource(PERMIT_SOURCE) as mapboxgl.GeoJSONSource | undefined)
          ?.setData(view.pending);
        (m.getSource(PERMIT_HISTORY_SOURCE) as
          | mapboxgl.GeoJSONSource
          | undefined)?.setData(view.history);
        recount(view);
      };

      // Drawn from the payload in hand BEFORE the fetch, so toggling a purpose
      // redraws at once instead of waiting on a round trip that will return the
      // same permits.
      draw();
      load();
      const onMove = () => {
        load();
        draw();
      };
      map.on("moveend", onMove);
      return () => {
        cancelled = true;
        permitFetchRef.current?.abort();
        map.off("moveend", onMove);
      };
    }

    // OPERATOR MODE: operators placed by mailing ZIP, clustered, filtered by
    // well count. Click a point -> profile; click a cluster -> operator list.
    if (filters.mode === "operators") {
      setVis([...WELL_LAYERS, ...PERMIT_LAYERS], "none");
      setVis([...OPERATOR_LAYERS, ...SURVEY_LAYERS], "visible");
      const entering = prevModeRef.current !== "operators";
      prevModeRef.current = "operators";
      let cancelled = false;
      /*
       * County, on the operator map, means "has a wellbore here".
       *
       * The points sit at MAILING addresses, so this does not gather them into
       * the county — an operator drilling in Reeves is usually pinned in
       * Houston. The set is resolved once per county and cached, because it is
       * ~30 paged reads at the far end (see `getCountyOperators`) and the other
       * filters in this effect re-run on every keystroke in a Min/Max box.
       */
      const counties = chosen(filters.county);
      // Several counties are a UNION: an operator working in either one is an
      // operator working in the area asked about. Resolved per county so the
      // cache above still hits when one is added to a pair.
      const countyOperators =
        counties == null
          ? Promise.resolve(null)
          : Promise.all(
              counties.map(
                (code) =>
                  countyOpsRef.current.get(code) ??
                  (() => {
                    const p = getCountyOperators(code).then((ns) => new Set(ns));
                    countyOpsRef.current.set(code, p);
                    return p;
                  })()
              )
            ).then((sets) => new Set(sets.flatMap((set) => [...set])));

      Promise.all([
        loadOperatorPoints(),
        countyOperators,
        personOperators(filters.person),
      ])
        .then(([all, inCounty, personOps]) => {
          if (cancelled || !mapRef.current) return;
          // A person narrows the map to the operators they are listed on. An
          // empty set is a real answer (nobody on file), not "no filter".
          const byPerson = personOps ? new Set(personOps) : null;
          opPointsRef.current = new Map(all.map((o) => [o.n, o]));
          const src = map.getSource(OPERATOR_SOURCE) as mapboxgl.GeoJSONSource | undefined;
          if (!src) return;
          const lo = filters.minWells ?? 0;
          const hi = filters.maxWells ?? Infinity;
          const oilLo = filters.minOil12 ?? 0;
          const oilHi = filters.maxOil12 ?? Infinity;
          const gasLo = filters.minGas12 ?? 0;
          const gasHi = filters.maxGas12 ?? Infinity;
          const revLo = filters.minRevenue ?? 0;
          const revHi = filters.maxRevenue ?? Infinity;
          // An operator points file synced before production was added would
          // read as all-zeros and blank the map under any production filter, so
          // say so in the panel instead of silently showing nothing.
          setNoProductionData(!all.some((o) => o.o12 || o.g12));
          // Effective well count: drop plugged wells when the global setting is on
          // (falls back to the all-wells count if the active count isn't present).
          const wc = (o: typeof all[number]) =>
            filters.excludePlugged ? o.wa ?? o.w : o.w;
          const pts = all.filter((o) => {
            // The name search picks one operator, so in this mode it narrows
            // the map to them rather than only opening their dossier.
            if (filters.operator && o.n !== filters.operator.operator_number) {
              return false;
            }
            if (inCounty && !inCounty.has(o.n)) return false;
            if (byPerson && !byPerson.has(o.n)) return false;
            const w = wc(o);
            if (filters.excludePlugged && w === 0) return false;
            // The drawn area. An operator's dot sits at its mailing-ZIP
            // centroid, not at its wells, so a shape here selects operators
            // BASED there rather than operating there. Said in the panel's
            // count, which stays null outside wells mode.
            if (
              filters.shapes.length > 0 &&
              !filters.shapes.some((sh) => pointInShape(sh, o.lng, o.lat))
            ) {
              return false;
            }
            if (w < lo || w > hi) return false;
            // Absent production means none on file, i.e. zero — so a Min above 0
            // drops those operators rather than letting them through untested.
            // Compared per month, because that is the unit the panel's inputs
            // are labelled in; the points file still carries the 12-mo sums.
            const oil = perMonth(o.o12, o.m12);
            const gas = perMonth(o.g12, o.m12);
            if (oil < oilLo || oil > oilHi || gas < gasLo || gas > gasHi) {
              return false;
            }
            const rev = monthlyRevenue(oil, gas, priceModel);
            return rev >= revLo && rev <= revHi;
          });
          src.setData({
            type: "FeatureCollection" as const,
            features: pts.map((o) => ({
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [o.lng, o.lat] },
              properties: {
                n: o.n,
                nm: o.nm,
                a: o.a,
                c: o.c,
                s: o.s,
                z: o.z,
                w: wc(o),
                wt: o.w,
                wa: o.wa ?? o.w,
                o12: o.o12 ?? 0,
                g12: o.g12 ?? 0,
                m12: o.m12 ?? 0,
              },
            })),
          });
          if (entering) map.fitBounds(TEXAS_BOUNDS, { padding: 24, duration: 600 });
        })
        .catch((err) => console.error("operator load failed", err));
      return () => {
        cancelled = true;
      };
    }

    // WELLS MODE
    prevModeRef.current = "wells";
    setVis([...OPERATOR_LAYERS, ...PERMIT_LAYERS], "none");
    // Survey lines are context in both map modes; their own `minzoom` decides
    // whether they actually draw.
    setVis(SURVEY_LAYERS, "visible");
    const focusSrc = () => map.getSource(FOCUS_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (!focusActive) {
      map.setFilter("wells", wellsFilter(filters));
      // The bubbles answer the same question as the dots. Repainted with the
      // dots, never separately, so the two can never be showing different
      // filters at the same zoom.
      for (const id of ["clusters", "cluster-count"]) {
        map.setFilter(id, clusterFilter(filters));
      }
      map.setPaintProperty("clusters", "circle-color", clusterColor(filters));
      map.setPaintProperty("clusters", "circle-radius", clusterRadius(filters));
      map.setLayoutProperty("cluster-count", "text-field", clusterLabel(filters));
      setVis(FOCUS_LAYERS, "none");
      setVis(PMTILES_LAYERS, "visible");
      focusSrc()?.setData({ type: "FeatureCollection" as const, features: [] });
      fittedSubjectRef.current = "";
      return;
    }

    // Switch to focus mode IMMEDIATELY (hide the full map / clear the busy
    // background) so the only wells shown are the search result, even before
    // the query returns. The focus source then fills in.
    setVis(PMTILES_LAYERS, "none");
    setVis(FOCUS_LAYERS, "visible");
    focusSrc()?.setData({ type: "FeatureCollection" as const, features: [] });

    let cancelled = false;
    personOperators(filters.person)
      .then((personOps) => {
        // Cleared here rather than in the effect body: a synchronous setState in
        // an effect cascades a render, and this only has to be false before the
        // new answer lands, not before the old layer is hidden.
        setFocusCapped(false);
        // Person AND operator are an intersection, not a union: asking for one
        // operator while a person is chosen means "their wells at that company",
        // and if they are not on it the honest answer is none.
        const picked = filters.operator?.operator_number ?? null;
        const operatorNumbers =
          personOps && picked != null
            ? personOps.filter((n) => n === picked)
            : personOps
              ? personOps
              : picked != null
                ? [picked]
                : null;

        // `toFocusOpts` is the one mapping from what the bar holds to what the
        // query asks, and it is unit-tested by hand.
        return getFocusWells(toFocusOpts(filters, operatorNumbers));
      })
      .then(({ wells, capped }) => {
        if (cancelled || !mapRef.current) return;
        // A depth band with no place attached matches six figures of wells
        // statewide, well past the query's cap — and the cap keeps the LOWEST
        // API numbers, which is county order, so the sample is a slice of east
        // Texas rather than a spread. Silently drawing it would read as "these
        // are the matches"; the bar says it is a sample instead.
        setFocusCapped(capped);
        setFocusWells(wells);
        const src = focusSrc();
        if (!src) return;
        src.setData({
          type: "FeatureCollection" as const,
          features: wells.map((w) => ({
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [w.lng, w.lat] },
            properties: { api: w.api, og: w.og, swd: w.swd, dead: w.dead },
          })),
        });
        /*
         * Recentre only when the SUBJECT of the search changed.
         *
         * This used to fit to the result on every focus query, which meant
         * every keystroke in a depth box and every pick in the well-type or
         * completion dropdown yanked the camera to the bounds of the new answer
         * — usually the whole state, since a refinement without a place attached
         * spans Texas. Refining a search is not asking to go somewhere else: the
         * user is looking at an area and narrowing what is drawn on it.
         *
         * So the fit belongs to the three fields that say WHERE or WHOSE
         * (`focusSubject`), not to the ones that say WHICH. Changing county,
         * operator or person still flies there; changing depth, type or year
         * redraws in place.
         */
        if (wells.length && focusSubject && focusSubject !== fittedSubjectRef.current) {
          const b = new mapboxgl.LngLatBounds();
          for (const w of wells) b.extend([w.lng, w.lat] as [number, number]);
          map.fitBounds(b, { padding: 60, maxZoom: 13, duration: 800 });
        }
        // Tracked even when nothing was fitted (an empty subject, or no
        // results), so re-picking the same county after clearing it flies there
        // again rather than being mistaken for the search already on screen.
        fittedSubjectRef.current = focusSubject;
      })
      .catch((err) => {
        console.error("focus query failed", err);
      });
    return () => {
      cancelled = true;
    };
    // `styleEpoch` is here, not because the basemap changes what is plotted, but
    // because `setStyle` empties the GeoJSON sources this effect fills.
  }, [
    filters,
    focusActive,
    focusSubject,
    ready,
    priceModel,
    personOperators,
    styleEpoch,
  ]);

  /*
   * Basemap swap.
   *
   * Its own effect, deliberately: putting `basemap` in the map-init effect's
   * dependencies would tear the whole map down and rebuild it on every toggle.
   * `setStyle` keeps the camera and swaps only the style, then `style.load`
   * re-adds the layers and bumps `styleEpoch` to refill them.
   */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // Tracked in a ref rather than sniffed off `map.getStyle()`: that returns
    // undefined mid-swap and its sprite URL is not a contract. The ref is the
    // only thing that knows what was last APPLIED, so it is what stops the
    // effect re-issuing `setStyle` on its own `styleEpoch` re-render.
    // The style, not the basemap: a theme switch swaps the drawn map too.
    const style = basemapStyle(basemap, darkTheme);
    if (appliedStyleRef.current === style) return;
    appliedStyleRef.current = style;
    map.setStyle(style);
  }, [basemap, darkTheme, ready]);

  /*
   * The focused operator's tracts, fetched once per operator.
   *
   * Only for an OPERATOR search: "every well in Young County" is not a fleet
   * and outlining the surveys under it would say something the data does not.
   * The request is a whole fleet in one go rather than per viewport, because
   * tract count barely grows with well count (Texas's largest operator is 2,308
   * tracts for 22,038 wells) and a per-pan version would redraw the same
   * shapes.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = () =>
      map.getSource(OPERATOR_TRACT_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    const clear = () =>
      src()?.setData({ type: "FeatureCollection", features: [] });

    const operatorNumber = filters.operator?.operator_number ?? null;
    if (!operatorNumber) {
      clear();
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/scout/operator-tracts?op=${encodeURIComponent(operatorNumber)}`
        );
        const json = (await res.json()) as GeoJSON.FeatureCollection;
        if (cancelled) return;
        src()?.setData(json);
      } catch {
        // The dots still answer the question without the highlight.
        if (!cancelled) clear();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters.operator, ready, styleEpoch]);


  /*
   * Survey lines follow the toggle; the layer itself decides when to load.
   */
  useEffect(() => {
    const survey = surveyRef.current;
    if (!ready || !survey) return;
    if (filters.showSurveys) survey.refresh();
    else survey.clear();
  }, [ready, styleEpoch, filters.showSurveys]);

  /*
   * Pipelines follow their own toggle. The layer decides when to fetch; this
   * only says whether it should be on screen at all.
   */
  useEffect(() => {
    const pipes = pipelineRef.current;
    if (!ready || !pipes) return;
    pipes.setVisible(filters.showPipelines);
  }, [ready, styleEpoch, filters.showPipelines]);

  /*
   * Paint that depends on the basemap under it.
   *
   * Satellite imagery is dark, busy and brown. Two things stop reading against
   * it that were fine on the light basemap: the survey grid's dark amber, and
   * the well dots, which are flat colour with no outline and disappear into
   * vegetation and ploughed field alike. The focus layer and the operator
   * points already carry a white 1px stroke for exactly this reason — this
   * gives the tile-based well layer the same treatment, but only where it is
   * needed, since on the light basemap an outline just fattens a million dots.
   *
   * Kept apart from the survey fetch effect deliberately: that one returns
   * early when the layer is switched off, and the well dots still need their
   * outline.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const satellite = basemap === "satellite";
    // The property name is a literal union in the Mapbox types, so borrow the
    // signature rather than widening it to string.
    type PaintProp = Parameters<mapboxgl.Map["setPaintProperty"]>[1];
    type PaintValue = Parameters<mapboxgl.Map["setPaintProperty"]>[2];
    const set = (layer: string, prop: PaintProp, value: PaintValue) => {
      if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
    };

    set("wells", "circle-stroke-width", satellite ? 1 : 0);
    set("wells", "circle-stroke-color", satellite ? "#ffffff" : "#f59e0b");

    // The overlays follow the ground's darkness, not imagery as such: the
    // dark map wants the same bright palette satellite does.
    const dark = isDarkGround(basemap, darkTheme);
    surveyRef.current?.repaint(dark);
    pipelineRef.current?.repaint(dark);
    shapeLayerRef.current?.repaint(dark);
    // `styleEpoch`: a style swap rebuilds every layer with its declared paint,
    // so these have to be re-applied afterwards, not just when `basemap` flips.
  }, [ready, styleEpoch, basemap, darkTheme]);

  if (!token) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border bg-muted/30 p-6 text-center">
          <h2 className="font-heading text-lg font-semibold">Mapbox token needed</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Set <code className="font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> in
            <code className="font-mono"> .env</code> (a public,
            URL-restricted token) and reload to view the well map.
          </p>
        </div>
      </div>
    );
  }

  // The controls are a bar in the layout flow rather than a card floating over
  // the map: the map keeps its whole area, and the bar's own dropdowns (county /
  // operator results) hang over the map below it, which is why it carries the
  // higher z-index. Everything under it — canvas, loader, and the right-hand
  // detail panels — is positioned against the map area, not the
  // page, so the panels stop at the bar instead of running under it.
  const filterBar = (
      <MapFilters
        bare={filtersHost != null}
        filters={filters}
        prices={prices}
        onSelectOperator={openOperator}
        onSelectPrincipal={openPrincipal}
        noProductionData={noProductionData}
        focusCapped={focusCapped && focusActive}
        permitCounts={permitCounts}
        permitPurposes={permitPurposes}
        modes={[MAP_MODE]}
        onChange={(f) => {
          if (f.mode !== filters.mode) {
            setOperatorList(null);
            // Switching map mode drops the well selection, so it has to leave
            // the stack too or the layer beneath it never comes back to the top.
            setStack((s) => s.filter((x) => x.kind !== "well"));
          }
          setFilters(f);
        }}
      />
  );

  return (
    <div className="flex h-full w-full flex-col">
      {filtersHost ? createPortal(filterBar, filtersHost) : filterBar}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
        {drawn && (
          <MapControls
            rightInset={panelInset}
            basemap={basemap}
            onBasemap={setBasemap}
            onZoomIn={() => mapRef.current?.zoomIn()}
            onZoomOut={() => mapRef.current?.zoomOut()}
            /*
             * EVERY MODE. A drawn area used to be wells-only, because only the
             * focus query answered a polygon. Permits and operators are both
             * drawn from collections already in the browser, so their shapes
             * are cut in memory instead: same `filters.shapes`, three layers
             * that read it. The shapes survive a mode switch, so an area drawn
             * around a field keeps meaning that when you flip to its permits.
             */
            drawTool={drawTool}
            onDrawTool={setDrawTool}
          />
        )}

        {/* The area's own surface: what is drawn, and the way back out of it.
            Up while a tool is armed as well as while shapes exist, so the ring
            tool's radius is set before the first click rather than after. */}
        {drawn && (filters.shapes.length > 0 || drawTool !== "off") && (
          <ShapePanel
            // The permit legend owns the bottom-left corner in its own mode,
            // and the shapes stay on screen across a mode switch, so this steps
            // up over it rather than landing on top of it.
            raised={filters.mode === "permits"}
            shapes={filters.shapes}
            selected={filters.mode === "wells" && focusActive ? selection.length : null}
            tool={drawTool}
            ringMiles={ringMiles}
            onRingMiles={setRingMiles}
            onRemove={(i) =>
              setFilters((f) => ({
                ...f,
                shapes: f.shapes.filter((_, n) => n !== i),
              }))
            }
            onClear={() => setFilters((f) => ({ ...f, shapes: [] }))}
          />
        )}
        {/* The app's one page-level loader (`src/app/loading.tsx` renders the same
            component), so the route boundary handing off to the map is a single
            continuous spinner rather than one loader swapping for another. Opaque,
            because the thing it covers is a blank container until Mapbox paints. */}
        {!drawn && (
          <div className="absolute inset-0 z-10 flex bg-background">
            <LoadingScreen label={ready ? "Loading wells" : "Loading map"} />
          </div>
        )}
        {filters.mode === "permits" && drawn && (
          <PermitLegend counts={permitCounts} />
        )}
        <div
          ref={panelStackRef}
          className="absolute right-0 top-0 z-10 flex h-full"
        >
          {operatorList && (
            <OperatorListPanel
              title={operatorList.title}
              operators={operatorList.items}
              onClose={() => setOperatorList(null)}
              onSelectOperator={openOperator}
              excludePlugged={filters.excludePlugged}
              prices={prices}
              onAddTargets={onAddTargets}
              targetNumbers={targetNumbers}
            />
          )}
          <PermitPanel
            permit={filters.mode === "permits" ? permit : null}
            // The map's own rate cache, not a second one: the panel asks for
            // the drilled hole's API and reads the same answer the hover popup
            // and the well dossier show.
            wellRate={
              typeof permit?.api === "string" || typeof permit?.api === "number"
                ? rates.rateFor(String(permit.api))
                : null
            }
            onNeedWellRate={rates.request}
            onClose={() => setPermit(null)}
            onSelectOperator={(no) => openOperator(Number(no))}
            onSelectWell={(api) => handleSelectWell(Number(api), null, null)}
          />
          <PrincipalDetailPanel
            name={selectedPrincipal}
            onClose={() => setSelectedPrincipal(null)}
            onSelectOperator={openOperator}
          />
        </div>
      </div>

      {/* The three dossiers are modals, not side panels: they portal to the body
          over a blurred backdrop, so they cover the map and the remaining panels
          rather than adding another column to them. `topModal` decides which is
          raised, since any of them can open the other two. */}
      <OperatorModal
        operatorNumber={selectedOperator}
        prices={priceModel}
        onClose={closeAllDossiers}
        onBack={() => closeDossier("operator")}
        onSelectWell={handleSelectWell}
        onSelectPrincipal={openPrincipal}
        onSelectLease={openLease}
        elevated={top === "operator"}
      />
      <ScoutWellModal
        api={selectedApi}
        onClose={closeAllDossiers}
        onBack={() => closeDossier("well")}
        onSelectOperator={openOperator}
        onSelectPrincipal={openPrincipal}
        onSelectLease={openLease}
        elevated={top === "well"}
      />
      <ScoutLeaseModal
        leaseKey={selectedLease}
        onClose={closeAllDossiers}
        onBack={() => closeDossier("lease")}
        onSelectOperator={openOperator}
        onSelectWell={openWell}
        onSelectOwner={openOwnerDossier}
        elevated={top === "lease"}
      />
      <ScoutOwnerModal
        ownerKey={selectedOwner}
        name={selectedOwner?.name}
        onClose={closeAllDossiers}
        onBack={() => closeDossier("owner")}
        onSelectLease={openLease}
        onSelectOwner={openOwnerDossier}
        onSelectOperator={openOperator}
        onSelectWell={openWell}
        elevated={top === "owner"}
      />
      <ReconAlertsModal
        open={alertsOpen}
        onClose={() => setAlertsOpen(false)}
        currentCounties={chosen(filters.county) ?? []}
      />
    </div>
  );
}
