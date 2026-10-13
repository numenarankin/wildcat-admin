"use client";

/**
 * The survey/abstract grid — Scout's property lines — as one attachable layer.
 *
 * Four maps want it now (the page map, the well location map, and the lease and
 * operator dossier maps), and the rules are the same on all of them: draw only
 * when close enough to read, load only what the viewport needs, and colour for
 * the basemap underneath. That logic lives here once instead of being copied
 * per map, which is also what keeps the thresholds from drifting apart.
 *
 * The data is `/api/scout/surveys`, which serves GeoJSON for a bounding box and
 * refuses windows wider than 0.6 degrees. See `rrc.survey_polygon`.
 */

import type mapboxgl from "mapbox-gl";

export const SURVEY_SOURCE = "survey-src";
export const SURVEY_LAYERS = ["survey-lines", "survey-labels"];

/**
 * Zoom at which the grid starts being drawn AND fetched.
 *
 * The median tract is 370 acres, about 1.2 km across, which is ~45 px at z12
 * and a legible parcel; at z11 the same grid is thousands of hairlines and
 * reads as noise. The main map switches wells from clusters to individual dots
 * at this same zoom, so the two arrive together.
 */
export const SURVEY_MIN_ZOOM = 12;
/** Labels need more room than lines, so they arrive two levels later. */
export const SURVEY_LABEL_MIN_ZOOM = 14;

/** How far past the viewport to fetch, and the cap the route will serve. */
const PAD = 0.25;
const MAX_SPAN = 0.55;

type Box = [number, number, number, number];

/**
 * Paint for the basemap underneath.
 *
 * Dark amber reads well on the light basemap and vanishes into satellite
 * imagery, which is itself brown. On satellite the lines go bright and the
 * labels invert their halo.
 */
function paint(satellite: boolean) {
  return {
    line: satellite ? "#fbbf24" : "#b45309",
    lineOpacity: satellite ? 0.85 : 0.55,
    text: satellite ? "#fde68a" : "#92400e",
    halo: satellite ? "rgba(0,0,0,0.75)" : "#ffffff",
  };
}

export interface SurveyLayer {
  /** Add source + layers. Call inside `load` / `style.load`. */
  add(): void;
  /** Re-apply basemap-dependent paint (after a style swap, or a toggle). */
  repaint(satellite: boolean): void;
  /** Fetch for the current viewport if it is not already covered. */
  refresh(): void;
  /** Empty the source and forget what was loaded. */
  clear(): void;
  /** Stop listening and abort anything in flight. */
  destroy(): void;
}

/**
 * Attach the grid to a map.
 *
 * The returned handle owns its own `moveend` listener, in-flight request and
 * "what is already loaded" box — so a caller only decides WHEN it is on, never
 * how it loads.
 */
export function attachSurveyLayer(
  map: mapboxgl.Map,
  opts: { satellite: boolean } = { satellite: false }
): SurveyLayer {
  let loadedBox: Box | null = null;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dead = false;

  const source = () =>
    map.getSource(SURVEY_SOURCE) as mapboxgl.GeoJSONSource | undefined;

  const clear = () => {
    loadedBox = null;
    source()?.setData({ type: "FeatureCollection", features: [] });
  };

  const refresh = () => {
    if (dead || !map.getLayer("survey-lines")) return;
    if (map.getZoom() < SURVEY_MIN_ZOOM) {
      clear();
      return;
    }
    const b = map.getBounds();
    if (!b) return;
    const view: Box = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

    // Already inside what was loaded last time.
    if (
      loadedBox &&
      view[0] >= loadedBox[0] && view[1] >= loadedBox[1] &&
      view[2] <= loadedBox[2] && view[3] <= loadedBox[3]
    ) {
      return;
    }

    // Pad, then clamp around the centre so an oversized window still gets the
    // middle of the screen instead of a 422 from the route.
    const cx = (view[0] + view[2]) / 2;
    const cy = (view[1] + view[3]) / 2;
    const halfX = Math.min((view[2] - view[0]) * (0.5 + PAD), MAX_SPAN / 2);
    const halfY = Math.min((view[3] - view[1]) * (0.5 + PAD), MAX_SPAN / 2);
    const box: Box = [cx - halfX, cy - halfY, cx + halfX, cy + halfY];

    ctrl?.abort();
    ctrl = new AbortController();
    fetch(`/api/scout/surveys?bbox=${box.join(",")}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (dead || !data) return;
        const src = source();
        if (!src) return;
        src.setData(data);
        loadedBox = box;
      })
      .catch((err) => {
        if ((err as Error)?.name !== "AbortError") {
          console.error("survey load failed", err);
        }
      });
  };

  const onMoveEnd = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  };

  const add = () => {
    const c = paint(opts.satellite);
    if (!map.getSource(SURVEY_SOURCE)) {
      map.addSource(SURVEY_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        // Default simplification tolerance, deliberately: a smoothed property
        // line is a wrong property line.
      } as unknown as mapboxgl.SourceSpecification);
    }
    if (!map.getLayer("survey-lines")) {
      map.addLayer({
        id: "survey-lines",
        type: "line",
        source: SURVEY_SOURCE,
        minzoom: SURVEY_MIN_ZOOM,
        paint: {
          "line-color": c.line,
          "line-opacity": c.lineOpacity,
          // Hairline when the grid appears, firmer once a tract fills the
          // screen, so the lines never fight the wells for attention.
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 16, 1.6],
        },
      } as unknown as mapboxgl.LayerSpecification);
    }
    if (!map.getLayer("survey-labels")) {
      map.addLayer({
        id: "survey-labels",
        type: "symbol",
        source: SURVEY_SOURCE,
        minzoom: SURVEY_LABEL_MIN_ZOOM,
        layout: {
          // The abstract label ("A-64") is how a tract is named on a lease; the
          // survey name and acreage stay in the data for callers that want them.
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": c.text,
          "text-halo-color": c.halo,
          "text-halo-width": 1.2,
        },
      } as unknown as mapboxgl.LayerSpecification);
    }
    // A fresh style means a fresh, empty source: whatever was loaded before is
    // gone, so the cache has to forget it or the refetch gets skipped.
    loadedBox = null;
  };

  const repaint = (satellite: boolean) => {
    opts = { satellite };
    const c = paint(satellite);
    if (map.getLayer("survey-lines")) {
      map.setPaintProperty("survey-lines", "line-color", c.line);
      map.setPaintProperty("survey-lines", "line-opacity", c.lineOpacity);
    }
    if (map.getLayer("survey-labels")) {
      map.setPaintProperty("survey-labels", "text-color", c.text);
      map.setPaintProperty("survey-labels", "text-halo-color", c.halo);
    }
  };

  map.on("moveend", onMoveEnd);

  return {
    add,
    repaint,
    refresh,
    clear,
    destroy() {
      dead = true;
      ctrl?.abort();
      if (timer) clearTimeout(timer);
      map.off("moveend", onMoveEnd);
    },
  };
}
