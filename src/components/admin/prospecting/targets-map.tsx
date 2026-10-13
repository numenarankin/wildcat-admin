"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { useTheme } from "@/components/theme-provider";
import {
  basemapStyle,
  DEFAULT_BASEMAP,
  isDarkGround,
  MapControls,
  type Basemap,
} from "@/components/scout/map-controls";
import { OperatorListPanel, type OperatorListItem } from "@/components/scout/operator-list-panel";
import type { TargetRow } from "@/lib/admin/target-types";

const SOURCE_ID = "targets-src";
const LAYER_ID = "targets";
const CLUSTER_LAYER_ID = "targets-clusters";
const CLUSTER_COUNT_LAYER_ID = "targets-cluster-count";
/** The open list panel's width (`OperatorListPanel`), for sliding the controls. */
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

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US");

interface ClickedFeature {
  id?: number;
  geometry: { type: string; coordinates: [number, number] };
  properties: Record<string, string | number | boolean> | null;
}

/** A plotted target as the cluster list shows it (`OperatorListItem`). */
function listItem(t: TargetRow): OperatorListItem {
  return {
    n: t.operatorNo,
    nm: t.name,
    a: t.address ?? "",
    c: t.city ?? "",
    s: t.state ?? "",
    z: 0,
    w: t.activeWells,
    wt: t.totalWells,
    wa: t.activeWells,
  };
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

/**
 * Where the targets are: one dot per target at its P-5 mailing address (the
 * operator points' ZIP-centroid placement, the same spot Recon's Operators
 * mode draws it), over county lines. `wells-map.tsx` is the pattern: a
 * Mapbox map that re-adds its layers on every style load, a hover popup,
 * and a click that opens the dossier.
 */
export function TargetsMap({
  targets,
  onSelect,
}: {
  /** The rows shown in the table: the map shows the same list. */
  targets: TargetRow[];
  onSelect: (operatorNo: number) => void;
}) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>(DEFAULT_BASEMAP);
  /**
   * The targets under a clicked cluster. Many operators share a mailing
   * address (one town's PO boxes land on one ZIP centroid), so a cluster is
   * not always something zooming splits; the list is how they are reached,
   * as Recon's Operators mode does it.
   */
  const [cluster, setCluster] = useState<{ title: string; items: OperatorListItem[] } | null>(null);
  const darkTheme = useTheme().theme === "dark";
  // Bound once at init; read through refs so the handlers see current values.
  const onSelectRef = useRef(onSelect);
  const targetsRef = useRef(targets);
  const groundRef = useRef(isDarkGround(DEFAULT_BASEMAP, darkTheme));
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // The targets as GeoJSON; only the placed ones can be drawn.
  const features = (rows: TargetRow[]) => ({
    type: "FeatureCollection" as const,
    features: rows
      .filter((t) => t.lng != null && t.lat != null)
      .map((t) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [t.lng!, t.lat!] },
        properties: {
          n: t.operatorNo,
          name: t.name,
          where: [t.address, [t.city, t.state].filter(Boolean).join(", ")].filter(Boolean).join("\n"),
          wells: t.activeWells,
          revenue: t.revenueUsd,
          sub: t.projectedUsd ?? -1,
        },
      })),
  });

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
        data: features(targetsRef.current),
        cluster: true,
        clusterRadius: 40,
        clusterMaxZoom: 14,
      });
      // Recon's operator clusters: a filled circle with the count on it.
      map.addLayer({
        id: CLUSTER_LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#16a34a",
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
          // Recon's operator dot: green, a white ring so it holds on any ground.
          "circle-color": "#16a34a",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 5, 12, 9],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as mapboxgl.LayerSpecification);

      // The county names go on LAST, over the dots and clusters: a cluster
      // that happens to sit on a name must not swallow it. The halo keeps the
      // text legible over a filled circle.
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
      const sub = Number(p.sub);
      el.innerText = [
        String(p.name),
        String(p.where ?? ""),
        `${count.format(Number(p.wells))} wells · ${usd.format(Number(p.revenue))}/mo` +
          (sub >= 0 ? ` · ${usd.format(sub)}/mo sub` : ""),
      ]
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
      onSelectRef.current(Number(feat.properties.n));
    };
    // A cluster opens its list. Not an expansion zoom: targets sharing a
    // mailing address sit on one point at every zoom, so zooming in would
    // leave the reader at the ground with the same cluster.
    const onClusterClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const feat = e.features?.[0] as unknown as ClickedFeature | undefined;
      const src = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
      if (!feat || feat.id == null || !src) return;
      src.getClusterLeaves(feat.id, 1000, 0, (err, leaves) => {
        if (err || !leaves) return;
        const nums = new Set(leaves.map((l) => Number((l.properties as { n: number }).n)));
        const items = targetsRef.current.filter((t) => nums.has(t.operatorNo)).map(listItem);
        const first = items[0];
        const title =
          first && (first.c || first.s)
            ? `Targets near ${[first.c, first.s].filter(Boolean).join(", ")}`
            : "Targets";
        setCluster({ title, items });
      });
    };
    const cursorOn = () => (map.getCanvas().style.cursor = "pointer");
    map.on("mouseenter", LAYER_ID, onEnter);
    map.on("mouseleave", LAYER_ID, onLeave);
    map.on("click", LAYER_ID, onClick);
    map.on("mouseenter", CLUSTER_LAYER_ID, cursorOn);
    map.on("mouseleave", CLUSTER_LAYER_ID, onLeave);
    map.on("click", CLUSTER_LAYER_ID, onClusterClick);

    // The pane is hidden (0×0) while another tab is open, and the map may
    // well be created in that state: a canvas of no size frames nothing, so
    // the opening view (Texas) is fitted the first time there is a size to
    // fit it to, and `resize()` keeps the canvas honest after that.
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

  // Feed the targets in whenever the list changes.
  useEffect(() => {
    targetsRef.current = targets;
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (src) src.setData(features(targets));
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
      {/* Recon's cluster list, over the map's right edge. No checkboxes: every
          row here is already a target. */}
      <div className="absolute right-0 top-0 z-10 flex h-full">
        {cluster && (
          <OperatorListPanel
            title={cluster.title}
            operators={cluster.items}
            onClose={() => setCluster(null)}
            onSelectOperator={(n) => onSelectRef.current(n)}
          />
        )}
      </div>
    </div>
  );
}
