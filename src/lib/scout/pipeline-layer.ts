"use client";

/**
 * The pipeline network — Scout's midstream layer — as one attachable layer.
 *
 * Built on the same bones as `survey-layer.ts`: fetch what the viewport needs,
 * paint for the basemap underneath, and keep the rules in one place so the maps
 * that use it cannot drift apart.
 *
 * The data is `/api/scout/pipelines`, which serves GeoJSON for a bounding box
 * and a minimum diameter. See `rrc.pipeline` — 470,554 segments, 350,305 miles.
 *
 * THE OPPOSITE RULE TO SURVEYS. Property lines are noise until you are zoomed
 * in, so that layer has a minimum zoom. A 30-inch trunk line is exactly what
 * you want to see from across the state, so this layer draws at EVERY zoom and
 * controls volume with a diameter floor instead: statewide you get the trunk
 * network, zoomed in you get the gathering stubs as well.
 */

import type mapboxgl from "mapbox-gl";

export const PIPELINE_SOURCE = "pipeline-src";
export const PIPELINE_LAYERS = ["pipeline-lines", "pipeline-dead"];

/**
 * Minimum outside diameter drawn at each zoom, in inches.
 *
 * Diameters are OUTSIDE measurements, so nominal 6" is 6.63 and nominal 12" is
 * 12.75 — the thresholds sit just under the nominal size they mean to admit.
 * Below zoom 9 only transmission-scale pipe; by 12 everything.
 *
 * The floor shapes WHAT is drawn, not how much: the route caps at 4,000
 * segments ordered by diameter descending, so a statewide view returns the
 * 4,000 biggest bores either way. That cap is what keeps the payload bounded;
 * this is what keeps the answer meaningful.
 */
function minDiameterFor(zoom: number): number {
  if (zoom < 7) return 16;
  if (zoom < 9) return 10;
  if (zoom < 11) return 6;
  if (zoom < 12) return 3;
  return 0;
}

/**
 * Which simplification bucket a zoom falls in. Must mirror `toleranceFor` in
 * the route: the client caches by it, so if the two disagree the map holds
 * geometry thinned for the wrong zoom.
 */
function zoomBucket(zoom: number): number {
  if (zoom >= 13) return 3;
  if (zoom >= 11) return 2;
  if (zoom >= 9) return 1;
  return 0;
}

/** How far past the viewport to fetch, in degrees. */
const PAD = 0.15;

type Box = [number, number, number, number];

/**
 * Paint for the basemap underneath.
 *
 * Cyan on satellite, teal on the light basemap: pipelines have to read as
 * infrastructure rather than as another well colour, and neither reads as
 * oil (green), gas (red) or disposal (blue) on the layers beside them.
 */
function paint(satellite: boolean) {
  return {
    line: satellite ? "#22d3ee" : "#0e7490",
    opacity: satellite ? 0.9 : 0.7,
  };
}

export interface PipelineLayer {
  add(): void;
  repaint(satellite: boolean): void;
  refresh(): void;
  setVisible(v: boolean): void;
  destroy(): void;
}

export function attachPipelineLayer(
  map: mapboxgl.Map,
  opts: { satellite: boolean }
): PipelineLayer {
  let lastBox: Box | null = null;
  let lastMin = -1;
  let lastBucket = -1;
  let visible = false;
  let inFlight: AbortController | null = null;

  const src = () =>
    map.getSource(PIPELINE_SOURCE) as mapboxgl.GeoJSONSource | undefined;

  function add() {
    if (!map.getSource(PIPELINE_SOURCE)) {
      map.addSource(PIPELINE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      } as unknown as mapboxgl.SourceSpecification);
    }
    const p = paint(opts.satellite);

    if (!map.getLayer("pipeline-dead")) {
      // Abandoned and revoked pipe, dashed and dimmed. 56,994 segments — one in
      // eight — and the TPMS spec keeps them in the data until the steel comes
      // out of the ground. Drawn like live pipe they would offer a connection
      // that does not exist.
      map.addLayer({
        id: "pipeline-dead",
        type: "line",
        source: PIPELINE_SOURCE,
        filter: ["==", ["get", "dead"], 1],
        layout: { visibility: "none", "line-cap": "round" },
        paint: {
          "line-color": p.line,
          "line-opacity": 0.3,
          "line-dasharray": [1, 2],
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 12, 1.5],
        },
      } as unknown as mapboxgl.LayerSpecification);
    }

    if (!map.getLayer("pipeline-lines")) {
      map.addLayer({
        id: "pipeline-lines",
        type: "line",
        source: PIPELINE_SOURCE,
        filter: ["==", ["get", "dead"], 0],
        layout: { visibility: "none", "line-cap": "round" },
        paint: {
          "line-color": p.line,
          "line-opacity": p.opacity,
          // Width tracks BORE as well as zoom, so the trunk network reads as
          // the trunk network instead of every line being one hairline.
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            ["interpolate", ["linear"], ["get", "dia"], 0, 0.4, 30, 2.2],
            12,
            ["interpolate", ["linear"], ["get", "dia"], 0, 1, 30, 6],
          ],
        },
      } as unknown as mapboxgl.LayerSpecification);
    }
  }

  function repaint(satellite: boolean) {
    const p = paint(satellite);
    if (map.getLayer("pipeline-lines")) {
      map.setPaintProperty("pipeline-lines", "line-color", p.line);
      map.setPaintProperty("pipeline-lines", "line-opacity", p.opacity);
    }
    if (map.getLayer("pipeline-dead")) {
      map.setPaintProperty("pipeline-dead", "line-color", p.line);
    }
  }

  function setVisible(v: boolean) {
    visible = v;
    for (const id of PIPELINE_LAYERS) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
      }
    }
    if (v) refresh();
  }

  function refresh() {
    if (!visible) return;
    const b = map.getBounds();
    if (!b) return;
    const box: Box = [
      b.getWest() - PAD,
      b.getSouth() - PAD,
      b.getEast() + PAD,
      b.getNorth() + PAD,
    ];
    const min = minDiameterFor(map.getZoom());

    // Skip the fetch when the new viewport is inside the one already loaded AND
    // the diameter floor has not dropped. A pan inside the padded box, or a
    // zoom IN that does not admit thinner pipe, is already answered.
    // The zoom bucket is part of the cache key: zooming in inside the same box
    // has to re-fetch, or the map keeps drawing geometry simplified for a zoom
    // you have left.
    const bucket = zoomBucket(map.getZoom());
    if (
      lastBox &&
      bucket === lastBucket &&
      min >= lastMin &&
      box[0] >= lastBox[0] &&
      box[1] >= lastBox[1] &&
      box[2] <= lastBox[2] &&
      box[3] <= lastBox[3]
    ) {
      return;
    }

    inFlight?.abort();
    const ctrl = new AbortController();
    inFlight = ctrl;
    fetch(
      `/api/scout/pipelines?bbox=${box.join(",")}&min=${min}` +
        `&zoom=${Math.round(map.getZoom())}`,
      {
        signal: ctrl.signal,
      }
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((fc) => {
        if (ctrl.signal.aborted || !fc) return;
        lastBox = box;
        lastMin = min;
        lastBucket = bucket;
        src()?.setData(fc);
      })
      .catch(() => {
        /* an aborted or failed fetch leaves the previous lines drawn */
      });
  }

  // Same hookup the survey layer uses: the map tells the layer it moved, the
  // layer decides whether that means a fetch.
  const onMoveEnd = () => refresh();
  map.on("moveend", onMoveEnd);

  function destroy() {
    inFlight?.abort();
    map.off("moveend", onMoveEnd);
  }

  return { add, repaint, refresh, setVisible, destroy };
}
