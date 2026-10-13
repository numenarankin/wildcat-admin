"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { formatRate, useWellRates } from "./use-well-rates";
import "mapbox-gl/dist/mapbox-gl.css";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { attachSurveyLayer, type SurveyLayer } from "@/lib/scout/survey-layer";

const SOURCE_ID = "scout-wells-src";
const TRACT_SOURCE = "scout-tract-src";
const PERMIT_SOURCE = "scout-permits-src";
const LAYER_ID = "scout-wells";
const PERMIT_LAYER_ID = "scout-permits";
const TEXAS_BOUNDS: mapboxgl.LngLatBoundsLike = [
  [-106.9, 25.5],
  [-93.2, 36.7],
];

/** Stable identity: a fresh [] each render would re-run the data effect. */
const EMPTY_PERMITS: MapPermit[] = [];

// Minimal shape of a clicked feature (avoids the @types/geojson namespace).
interface ClickedFeature {
  geometry: { type: string; coordinates: [number, number] };
  properties: Record<string, string | number | boolean> | null;
}

/** One plotted hole. The caller flattens its own row shape into this. */
export interface MapWell {
  /** Passed back to `onSelectWell`; the 8-digit RRC form either way. */
  api: number;
  lng: number;
  lat: number;
  /** "O" | "G" | "" — the dot colour, matching the main Scout map. */
  og: string;
  plugged?: boolean;
  /**
   * `injection` or `inactive` when the hole's type says so, else undefined.
   * Overrides the commodity colour: what a hole IS beats what its lease sells.
   */
  status?: "injection" | "inactive";
  /** Popup heading, usually the API. */
  label: string;
  /** Popup second line: county, type, activity. */
  sub?: string;
}

/**
 * The RRC well type a dot should be coloured by, not the commodity.
 *
 * A hole that injects is not producing whatever its lease sells, and an idle
 * hole is not producing at all; both are more useful to see at a glance than
 * oil-vs-gas. Shared so the lease and operator dossiers colour by one rule.
 */
export function wellStatus(
  type: string | null | undefined
): "injection" | "inactive" | undefined {
  const t = (type ?? "").toUpperCase();
  // Stopped is checked FIRST: a hole typed "SHUT IN" that also holds a disposal
  // permit has stopped, and that is what the colour should say.
  if (
    t.includes("SHUT IN") ||
    t.includes("ABANDONED") ||
    t === "NO PRODUCTION" ||
    t === "PARTIAL PLUG" ||
    t === "SEALED" ||
    t === "NOT ELIGIBLE FOR ALLOWABLE"
  ) {
    return "inactive";
  }
  if (
    t.includes("INJECTION") ||
    t === "WATER SUPPLY" ||
    t.includes("STRG") ||
    t === "BRINE MINING" ||
    t === "OBSERVATION" ||
    t === "LPG STORAGE"
  ) {
    return "injection";
  }
  return undefined;
}

/**
 * One plotted drilling permit: a hole that does not exist yet.
 *
 * Deliberately NOT a `MapWell` with a different colour. A permit has no API,
 * nothing to click through to, and no production to hover for, and feeding it
 * through the well layer would have meant a dot that answers the well layer's
 * questions with blanks.
 */
export interface MapPermit {
  /** Any stable string; used as the React/feature key only. */
  id: string;
  lng: number;
  lat: number;
  /** Popup heading, usually the lease the permit names. */
  label: string;
  /** Popup second line: well number, issue date. */
  sub?: string;
  /**
   * The permit became a hole. Drilled ones ring the well they produced (the
   * well dot sits inside); undrilled ones are the whole mark, because there is
   * nothing underneath them to ring.
   */
  drilled?: boolean;
}

/**
 * A set of wells on satellite imagery — the "Map" tab on the operator and lease
 * dossiers.
 *
 * SATELLITE, not the page map's light basemap. These maps answer a different
 * question: the page map is for finding things across the state, where a plain
 * canvas keeps a hundred thousand dots legible, while a dossier map is already
 * down to one operator or one lease and the question becomes what is actually
 * out there — pads, roads, tank batteries, whether two wells share a location.
 * The imagery answers that and a road map cannot.
 *
 * Same encoding as the page map regardless: oil green, gas red, unknown grey,
 * plugged hollowed out. A separate instance rather than a reuse of the page map
 * because this plots ONE set with no tiles, clustering, or filters — teaching
 * that map a "just these" mode would have meant a second meaning for every
 * layer it already carries.
 */
export function ScoutWellsMap({
  wells,
  permits = EMPTY_PERMITS,
  onSelectWell,
  empty,
  note,
}: {
  wells: MapWell[];
  /**
   * Permits to draw alongside the wells: where the operator has been granted
   * permission to drill, against where they already have. Undrilled ones are
   * black dots, drilled ones amber rings around the well they became. Most
   * permits carry no position at all (the register holds none), so a caller
   * passing these should say how many were plotted; see `note`.
   */
  permits?: MapPermit[];
  /** Click-through to the well dossier. Omit for a non-interactive map. */
  onSelectWell?: (api: number, lng: number | null, lat: number | null) => void;
  /** Shown when nothing in the set carries coordinates. */
  empty: string;
  /**
   * A qualifier pinned over the map — for the count of wells that were NOT
   * plotted. The Wells tab and this map are two views of one set, so a map with
   * fewer pins than that tab has rows has to say why; otherwise the two
   * silently disagree and the map looks like the smaller truth.
   */
  note?: string;
}) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const surveyRef = useRef<SurveyLayer | null>(null);
  const [drawn, setDrawn] = useState(false);
  // The click handler is bound once, at map init, so it reads the current
  // callback through a ref rather than re-binding on every render.
  const onSelectRef = useRef(onSelectWell);
  // Held in a ref because the map effect runs once and closes over it, and
  // assigned in an effect rather than during render.
  const rates = useWellRates();
  const ratesRef = useRef(rates);
  useEffect(() => {
    ratesRef.current = rates;
  }, [rates]);
  useEffect(() => {
    onSelectRef.current = onSelectWell;
  }, [onSelectWell]);

  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      // `satellite-streets`, not bare `satellite`: the labels and road lines are
      // what turn imagery into something you can orient yourself in.
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      bounds: TEXAS_BOUNDS,
      fitBoundsOptions: { padding: 24 },
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl(), "bottom-right");
    map.once("idle", () => setDrawn(true));

    map.on("style.load", () => {
      /*
       * Property lines under the wells.
       *
       * Added before the well layer so the grid stays underneath, and it loads
       * itself once the map is close enough to read (see `survey-layer.ts`).
       * That threshold is what makes this safe on the OPERATOR dossier too:
       * a fleet spanning the state opens zoomed out, where the grid neither
       * draws nor fetches; zoom into a pad and it appears.
       */
      surveyRef.current ??= attachSurveyLayer(map, { satellite: true });
      surveyRef.current.add();

      /*
       * The tracts these wells sit in, under the dots.
       *
       * The RRC publishes no lease boundaries, so a footprint is drawn as the
       * land-grant survey/abstract tracts the wells fall inside — the same
       * approximation `/leases` makes, in the same amber, so the two pages agree
       * about what a property line looks like. A tract is bigger than the lease
       * inside it, which is why this is shading and not an outline of holdings.
       */
      map.addSource(TRACT_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "scout-tract-fill",
        type: "fill",
        source: TRACT_SOURCE,
        paint: { "fill-color": "#fbbf24", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "scout-tract-line",
        type: "line",
        source: TRACT_SOURCE,
        paint: {
          "line-color": "#fbbf24",
          "line-width": 1.5,
          "line-opacity": 0.9,
        },
      });

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      } as unknown as mapboxgl.SourceSpecification);

      map.addLayer({
        id: LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        paint: {
          /*
           * The page map's rule, so a well does not change meaning between the
           * two: blue injects, red has stopped, green is running. Oil-vs-gas is
           * a record-keeping split — a well routinely makes both — so it does
           * not decide the colour. Plugged keeps its own white, which is the
           * encoding these dossier maps already used and is stronger than "red".
           */
          "circle-color": [
            "case",
            ["get", "plug"],
            "#ffffff",
            // Stopped before injecting: a shut-in injector has stopped.
            ["==", ["get", "status"], "inactive"],
            "#ef4444",
            ["==", ["get", "status"], "injection"],
            "#38bdf8",
            "#16a34a",
          ],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.5, 13, 7],
          // A heavier ring than the page map carries: over imagery a hairline
          // stroke disappears into whatever happens to be under it.
          "circle-stroke-width": 2,
          "circle-stroke-color": ["case", ["get", "plug"], "#9ca3af", "#ffffff"],
          "circle-opacity": 1,
        },
      } as unknown as mapboxgl.LayerSpecification);

      /*
       * Permits, drawn under the wells so the hole stays the thing you hover
       * and click. Two marks, because they answer two different questions —
       * see the paint below.
       */
      map.addSource(PERMIT_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      } as unknown as mapboxgl.SourceSpecification);
      map.addLayer(
        {
          id: PERMIT_LAYER_ID,
          type: "circle",
          source: PERMIT_SOURCE,
          paint: {
            /*
             * NOT YET DRILLED IS A BLACK DOT, the same mark the page map's
             * Permits mode uses for one, so a permit means the same thing on
             * both maps: approved, and nothing there yet.
             *
             * A DRILLED permit is a hollow amber ring instead. The hole it
             * became is already on this map as a well dot, and painting a solid
             * mark over it would hide the thing that matters; the ring is wider
             * than a well so it reads as a halo around it.
             */
            "circle-color": ["case", ["get", "drilled"], "#f59e0b", "#111827"],
            "circle-opacity": ["case", ["get", "drilled"], 0, 0.9],
            "circle-radius": [
              "case",
              ["get", "drilled"],
              ["interpolate", ["linear"], ["zoom"], 4, 7, 13, 14],
              ["interpolate", ["linear"], ["zoom"], 4, 3.5, 13, 7],
            ],
            "circle-stroke-width": 2,
            "circle-stroke-color": [
              "case",
              ["get", "drilled"],
              "#f59e0b",
              "#ffffff",
            ],
            "circle-stroke-opacity": 0.95,
          },
        } as unknown as mapboxgl.LayerSpecification,
        LAYER_ID
      );
    });

    const popup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
    });
    const onEnter = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      const p = feat.properties;
      const api = String(p.api ?? "");
      // Ask for the rate on hover and paint it in when it lands; the popup is
      // already on screen by then and simply gains a line.
      ratesRef.current.request(api);
      const el = document.createElement("div");
      el.style.whiteSpace = "pre-line";
      el.style.fontSize = "12px";
      el.style.lineHeight = "1.35";
      const paint = () => {
        const r = ratesRef.current.rateFor(api);
        el.innerText = [
          // The caller's label is the well's name where it has one; the fetched
          // name is the fallback for a map built from APIs alone.
          String(p.label || r?.name || ""),
          String(p.sub ?? ""),
          formatRate(r) ?? "",
        ]
          .filter(Boolean)
          .join("\n");
      };
      paint();
      // One re-read shortly after, for the case where the fetch was still in
      // flight when the pointer arrived.
      const t = setTimeout(paint, 400);
      popup.once("close", () => clearTimeout(t));
      popup
        .setLngLat(feat.geometry.coordinates as [number, number])
        .setDOMContent(el)
        .addTo(map);
      map.getCanvas().style.cursor = onSelectRef.current ? "pointer" : "";
    };
    const onLeave = () => {
      popup.remove();
      map.getCanvas().style.cursor = "";
    };
    const onClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      const [lng, lat] = feat.geometry.coordinates;
      onSelectRef.current?.(Number(feat.properties.api), lng, lat);
    };
    // Permits get the label and nothing else: no rate to fetch, and no dossier
    // behind a hole that has not been drilled.
    const onPermitEnter = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      const el = document.createElement("div");
      el.style.whiteSpace = "pre-line";
      el.style.fontSize = "12px";
      el.style.lineHeight = "1.35";
      el.innerText = [
        String(feat.properties.label ?? ""),
        String(feat.properties.sub ?? ""),
        feat.properties.drilled ? "permitted, drilled" : "permitted, not drilled",
      ]
        .filter(Boolean)
        .join("\n");
      popup
        .setLngLat(feat.geometry.coordinates as [number, number])
        .setDOMContent(el)
        .addTo(map);
    };
    map.on("mouseenter", LAYER_ID, onEnter);
    map.on("mouseleave", LAYER_ID, onLeave);
    map.on("click", LAYER_ID, onClick);
    map.on("mouseenter", PERMIT_LAYER_ID, onPermitEnter);
    map.on("mouseleave", PERMIT_LAYER_ID, onLeave);

    return () => {
      surveyRef.current?.destroy();
      surveyRef.current = null;
      map.remove();
      mapRef.current = null;
      setDrawn(false);
    };
  }, [token]);

  // Feed the wells in and frame them.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: "FeatureCollection" as const,
        features: wells.map((w) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [w.lng, w.lat] },
          properties: {
            api: w.api,
            og: w.og,
            plug: Boolean(w.plugged),
            label: w.label,
            sub: w.sub ?? "",
            status: w.status ?? "",
          },
        })),
      });
      // A dossier map holds one lease or one operator, so the whole set is worth
      // warming up front: by the time a pointer lands, the rate is already in
      // hand. Capped and idle-scheduled inside the hook.
      if (wells.length) {
        ratesRef.current.prefetch(wells.map((w) => String(w.api)));
      }

      // The tracts under them, fetched for these wells' APIs.
      const tractSrc = map.getSource(TRACT_SOURCE) as
        | mapboxgl.GeoJSONSource
        | undefined;
      if (tractSrc) {
        if (wells.length === 0) {
          tractSrc.setData({ type: "FeatureCollection", features: [] });
        } else {
          const apis = wells
            .map((w) => String(w.api).replace(/\D/g, "").slice(-8))
            .filter((a) => a.length === 8);
          void (async () => {
            try {
              const res = await fetch(
                `/api/scout/operator-tracts?api=${apis.join(",")}`
              );
              const json = (await res.json()) as GeoJSON.FeatureCollection;
              // The map can be gone, or showing a different subject, by now.
              const live = mapRef.current?.getSource(TRACT_SOURCE) as
                | mapboxgl.GeoJSONSource
                | undefined;
              live?.setData(json);
            } catch {
              // Shading is context: the dots still answer the question.
            }
          })();
        }
      }
      const permitSrc = map.getSource(PERMIT_SOURCE) as
        | mapboxgl.GeoJSONSource
        | undefined;
      permitSrc?.setData({
        type: "FeatureCollection" as const,
        features: permits.map((p) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
          properties: {
            id: p.id,
            label: p.label,
            sub: p.sub ?? "",
            drilled: Boolean(p.drilled),
          },
        })),
      });

      // Framed on BOTH sets: a permit outside the fleet's footprint is the most
      // interesting thing on the map — it is where they are moving next — and
      // fitting the wells alone would leave it off screen.
      const b = new mapboxgl.LngLatBounds();
      for (const w of wells) b.extend([w.lng, w.lat]);
      for (const p of permits) b.extend([p.lng, p.lat]);
      if (wells.length || permits.length) {
        // `maxZoom` matters on a single-well lease: fitting one point otherwise
        // zooms to the imagery's limit and fills the pane with one blurred pad.
        map.fitBounds(b, { padding: 48, maxZoom: 15, duration: 0 });
      }
    };
    if (map.isStyleLoaded() && map.getSource(SOURCE_ID)) apply();
    else map.once("style.load", apply);
  }, [wells, permits]);

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Set <code className="mx-1 font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> to
        view the map.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {!drawn && (
        <div className="absolute inset-0 z-10 flex bg-background">
          <LoadingScreen label="Loading map" />
        </div>
      )}
      {note && wells.length > 0 && drawn && (
        <div className="absolute left-3 top-3 z-10 rounded-md border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
          {note}
        </div>
      )}
      {wells.length === 0 && drawn && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 p-6 text-center text-sm text-muted-foreground">
          {empty}
        </div>
      )}
    </div>
  );
}
