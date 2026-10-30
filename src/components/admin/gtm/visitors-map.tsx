"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { useTheme } from "@/components/theme-provider";
import { basemapStyle, DEFAULT_BASEMAP, isDarkGround, MapControls, type Basemap } from "@/components/scout/map-controls";
import { count, fmtDateTime } from "@/lib/admin/gtm/format";
import type { MapPoint } from "@/lib/admin/gtm/types";

const SOURCE_ID = "visitors-src";
const LAYER_ID = "visitors";
const CLUSTER_LAYER_ID = "visitors-clusters";
const CLUSTER_COUNT_LAYER_ID = "visitors-cluster-count";
/** The open list panel's width, for sliding the controls (the Prospecting map's). */
const PANEL_WIDTH_PX = 576;
const COUNTY_SOURCE = "tx-counties-src";
const COUNTY_LINE_LAYER = "tx-county-lines";
const COUNTY_LABEL_LAYER = "tx-county-labels";
/** Texas counties, the Census cartographic boundaries (public/tx-counties.json). */
const COUNTY_URL = "/tx-counties.json";
const TEXAS_BOUNDS: mapboxgl.LngLatBoundsLike = [
  [-106.9, 25.5],
  [-93.2, 36.7],
];
/** The visitor dot. */
const BLUE = "#2563eb";

interface ClickedFeature {
  id?: number;
  geometry: { type: string; coordinates: [number, number] };
  properties: Record<string, string | number | boolean> | null;
}

/** County lines and labels for the ground under them (the Recon overlays' rule). */
function countyPaint(dark: boolean) {
  return {
    line: dark ? "#e5e7eb" : "#4b5563",
    lineOpacity: dark ? 0.45 : 0.4,
    text: dark ? "#d1d5db" : "#374151",
    halo: dark ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.85)",
  };
}

const label = (p: MapPoint) => p.company ?? "Anonymous visitor";

function features(points: MapPoint[]) {
  return {
    type: "FeatureCollection" as const,
    features: points.map((p) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      properties: {
        id: p.visitorId,
        name: label(p),
        where: p.location ?? "",
        visits: p.visits,
        last: fmtDateTime(p.lastSeenAt),
      },
    })),
  };
}

/**
 * Where the landing's visitors are: one blue dot per visitor at their latest
 * visit's location (city-level, from the IP address), over Texas county
 * lines. The Prospecting map (`targets-map.tsx`) with visitors for targets:
 * same basemaps, clusters and hover card. A dot opens the visitor; a cluster
 * lists its visitors, since visitors from one city share a point at every zoom.
 */
export function VisitorsMap({ points, onSelect }: { points: MapPoint[]; onSelect: (visitorId: string) => void }) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>(DEFAULT_BASEMAP);
  const [cluster, setCluster] = useState<{ title: string; items: MapPoint[] } | null>(null);
  const darkTheme = useTheme().theme === "dark";
  const onSelectRef = useRef(onSelect);
  const pointsRef = useRef(points);
  const groundRef = useRef(isDarkGround(DEFAULT_BASEMAP, darkTheme));
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: basemapStyle(DEFAULT_BASEMAP, groundRef.current),
      bounds: TEXAS_BOUNDS,
      fitBoundsOptions: { padding: 24 },
    });
    mapRef.current = map;
    map.once("idle", () => setDrawn(true));

    // Every style load, since a basemap swap throws the layers away.
    map.on("style.load", () => {
      const c = countyPaint(groundRef.current);
      map.addSource(COUNTY_SOURCE, { type: "geojson", data: COUNTY_URL });
      map.addLayer({
        id: COUNTY_LINE_LAYER,
        type: "line",
        source: COUNTY_SOURCE,
        paint: { "line-color": c.line, "line-width": 1, "line-opacity": c.lineOpacity },
      });
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: features(pointsRef.current),
        cluster: true,
        clusterRadius: 40,
        clusterMaxZoom: 14,
      });
      map.addLayer({
        id: CLUSTER_LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": BLUE,
          "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 12, 20, 18, 100, 24],
          "circle-opacity": 0.85,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as mapboxgl.LayerSpecification);
      map.addLayer({
        id: CLUSTER_COUNT_LAYER_ID,
        type: "symbol",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11 },
        paint: { "text-color": "#ffffff" },
      } as unknown as mapboxgl.LayerSpecification);
      map.addLayer({
        id: LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": BLUE,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 5, 12, 9],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as mapboxgl.LayerSpecification);
      // County names last, over the dots, as on the Prospecting map.
      map.addLayer({
        id: COUNTY_LABEL_LAYER,
        type: "symbol",
        source: COUNTY_SOURCE,
        minzoom: 6,
        layout: {
          "text-field": ["get", "name"],
          "text-size": 11,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.08,
        },
        paint: { "text-color": c.text, "text-halo-color": c.halo, "text-halo-width": 1 },
      } as unknown as mapboxgl.LayerSpecification);
    });

    const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
    const onEnter = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      const p = feat.properties;
      const el = document.createElement("div");
      el.style.whiteSpace = "pre-line";
      el.style.fontSize = "12px";
      el.style.lineHeight = "1.35";
      const visits = Number(p.visits);
      el.innerText = [String(p.name), String(p.where ?? ""), `${count.format(visits)} visit${visits === 1 ? "" : "s"} · last ${p.last}`]
        .filter(Boolean)
        .join("\n");
      popup.setLngLat(feat.geometry.coordinates).setDOMContent(el).addTo(map);
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      popup.remove();
      map.getCanvas().style.cursor = "";
    };
    const onClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      if (!feat?.properties) return;
      onSelectRef.current(String(feat.properties.id));
    };
    const onClusterClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      const src = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
      if (!feat || feat.id == null || !src) return;
      src.getClusterLeaves(feat.id, 1000, 0, (err, leaves) => {
        if (err || !leaves) return;
        const ids = new Set(leaves.map((l) => String((l.properties as { id: string }).id)));
        const items = pointsRef.current.filter((p) => ids.has(p.visitorId));
        const where = items[0]?.location;
        setCluster({ title: where ? `Visitors near ${where}` : "Visitors", items });
      });
    };
    const cursorOn = () => (map.getCanvas().style.cursor = "pointer");
    map.on("mouseenter", LAYER_ID, onEnter);
    map.on("mouseleave", LAYER_ID, onLeave);
    map.on("click", LAYER_ID, onClick);
    map.on("mouseenter", CLUSTER_LAYER_ID, cursorOn);
    map.on("mouseleave", CLUSTER_LAYER_ID, onLeave);
    map.on("click", CLUSTER_LAYER_ID, onClusterClick);

    // Framed on Texas the first time the pane has a size (see targets-map.tsx).
    let framed = false;
    const ro = new ResizeObserver(([entry]) => {
      map.resize();
      if (!framed && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        framed = true;
        map.fitBounds(TEXAS_BOUNDS, { padding: 24, duration: 0 });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      setDrawn(false);
    };
  }, [token]);

  // Feed the points in whenever the range changes them.
  useEffect(() => {
    pointsRef.current = points;
    const src = mapRef.current?.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (src) src.setData(features(points));
  });

  // The basemap follows the toggle and the theme, as Recon's does.
  const appliedStyleRef = useRef(basemapStyle(DEFAULT_BASEMAP, darkTheme));
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    groundRef.current = isDarkGround(basemap, darkTheme);
    const style = basemapStyle(basemap, darkTheme);
    if (appliedStyleRef.current === style) return;
    appliedStyleRef.current = style;
    map.setStyle(style);
  }, [basemap, darkTheme]);

  if (!token) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8 text-sm text-muted-foreground">
        Set NEXT_PUBLIC_MAPBOX_TOKEN to show the map.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {!drawn && (
        <div className="absolute inset-0 z-20">
          <LoadingScreen />
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
      <MapControls
        basemap={basemap}
        onBasemap={setBasemap}
        onZoomIn={() => mapRef.current?.zoomIn()}
        onZoomOut={() => mapRef.current?.zoomOut()}
        rightInset={cluster ? PANEL_WIDTH_PX : 0}
      />
      {cluster && (
        <div className="absolute right-0 top-0 z-10 flex h-full">
          {/* The Prospecting map's cluster list, with visitors for operators. */}
          <div className="no-scrollbar flex h-full w-[36rem] shrink-0 flex-col overflow-y-auto border-l bg-background shadow-xl">
            <div className="sticky top-0 border-b bg-background/95 px-4 py-3 backdrop-blur">
              <div className="flex items-start justify-between gap-2">
                <div className="truncate font-heading text-lg font-semibold tracking-tight">{cluster.title}</div>
                <Button variant="ghost" size="icon" onClick={() => setCluster(null)} aria-label="Close">
                  <X className="size-4" />
                </Button>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {count.format(cluster.items.length)} visitor{cluster.items.length === 1 ? "" : "s"}
              </div>
            </div>
            <ul className="flex flex-col divide-y">
              {cluster.items.map((p) => (
                <li key={p.visitorId}>
                  <button
                    onClick={() => onSelectRef.current(p.visitorId)}
                    className="flex w-full min-w-0 items-center justify-between gap-2 px-4 py-2 text-left hover:bg-muted"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-primary">{label(p)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{p.location ?? ""}</span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-muted-foreground">
                      <span className="block">
                        {count.format(p.visits)} visit{p.visits === 1 ? "" : "s"}
                      </span>
                      <span className="block">{fmtDateTime(p.lastSeenAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
