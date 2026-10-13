"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { attachSurveyLayer, type SurveyLayer } from "@/lib/scout/survey-layer";
import type { WellLocation } from "@/lib/scout/rrc-types";

const SOURCE = "well-loc-src";
const LINE_SOURCE = "well-lat-src";

/*
 * ===========================================================================
 * WELL LOCATION MAP — the Location tab of the well modal.
 * ===========================================================================
 *
 * DATA IT NEEDS: a `WellLocation` — lat/lon (surface), bottom_lat/bottom_lon,
 * plus the descriptive fields the modal shows beside it.
 *
 * WIRING NOTES
 *   - Surface <- `wells_surface` LAT83/LONG83 for the api_number. Bottomhole <-
 *     `wells_bottom`. Use NAD83; the NAD27 pair in the same file is ~100 m off.
 *   - Both tables can have several rows per API; take one (they agree) or the
 *     most reliable by RELIAB.
 *   - Nulls are expected and handled: 3,345 wells currently on schedule have no
 *     coordinates at all, and the component renders an explanatory box rather
 *     than an empty map.
 *   - Needs NEXT_PUBLIC_MAPBOX_TOKEN, same as the main Scout map.
 */

/**
 * One wellbore on a map: the surface hole, the bottomhole, and the path between
 * them.
 *
 * The path is the point of it. 166,988 of the 1,015,887 wells carrying both
 * coordinates are deviated or horizontal, and a coordinate pair in a table
 * tells you nothing about which way a lateral runs or how far it reaches under
 * the neighbouring lease.
 */
export function WellLocationMap({ location }: { location: WellLocation }) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const surveyRef = useRef<SurveyLayer | null>(null);
  const [drawn, setDrawn] = useState(false);

  const { lat, lon, bottom_lat, bottom_lon } = location;
  const hasSurface = lat != null && lon != null;
  const hasBottom = bottom_lat != null && bottom_lon != null;
  const deviated =
    hasSurface &&
    hasBottom &&
    (Math.abs(lat - bottom_lat) > 0.0002 || Math.abs(lon - bottom_lon) > 0.0002);

  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current || !hasSurface) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [lon, lat],
      zoom: deviated ? 13.5 : 14.5,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl(), "bottom-right");
    map.once("idle", () => setDrawn(true));

    map.on("load", () => {
      /*
       * The tract this well sits on, under everything else.
       *
       * This map opens at z13.5-14.5, past the grid's threshold, so a well
       * dossier shows its survey lines immediately — which is the question a
       * location tab is usually being asked: whose land is this on, and how
       * far does that lateral reach under the neighbour.
       */
      surveyRef.current ??= attachSurveyLayer(map, { satellite: true });
      surveyRef.current.add();
      surveyRef.current.refresh();

      // The lateral, drawn first so the markers sit on top of it.
      if (deviated) {
        map.addSource(LINE_SOURCE, {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [lon, lat],
                [bottom_lon as number, bottom_lat as number],
              ],
            },
          },
        } as unknown as mapboxgl.SourceSpecification);
        map.addLayer({
          id: "lateral",
          type: "line",
          source: LINE_SOURCE,
          paint: {
            "line-color": "#f59e0b",
            "line-width": 3,
            "line-dasharray": [2, 1],
          },
        } as unknown as mapboxgl.LayerSpecification);
      }

      map.addSource(SOURCE, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { kind: "surface", label: "Surface" },
              geometry: { type: "Point", coordinates: [lon, lat] },
            },
            ...(hasBottom && deviated
              ? [
                  {
                    type: "Feature" as const,
                    properties: { kind: "bottom", label: "Bottomhole" },
                    geometry: {
                      type: "Point" as const,
                      coordinates: [bottom_lon as number, bottom_lat as number],
                    },
                  },
                ]
              : []),
          ],
        },
      } as unknown as mapboxgl.SourceSpecification);

      map.addLayer({
        id: "well-points",
        type: "circle",
        source: SOURCE,
        paint: {
          "circle-color": [
            "match",
            ["get", "kind"],
            "surface",
            "#16a34a",
            "#f59e0b",
          ],
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as mapboxgl.LayerSpecification);

      map.addLayer({
        id: "well-labels",
        type: "symbol",
        source: SOURCE,
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#000000",
          "text-halo-width": 1.2,
        },
      } as unknown as mapboxgl.LayerSpecification);

      if (deviated) {
        const b = new mapboxgl.LngLatBounds();
        b.extend([lon, lat]);
        b.extend([bottom_lon as number, bottom_lat as number]);
        map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 0 });
      }
    });

    return () => {
      surveyRef.current?.destroy();
      surveyRef.current = null;
      map.remove();
      mapRef.current = null;
      setDrawn(false);
    };
  }, [token, lat, lon, bottom_lat, bottom_lon, hasSurface, hasBottom, deviated]);

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center rounded-[0.15rem] border p-6 text-center text-sm text-muted-foreground">
        Set <code className="mx-1 font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> to
        view the location.
      </div>
    );
  }

  if (!hasSurface) {
    return (
      <div className="flex h-full items-center justify-center rounded-[0.15rem] border p-6 text-center text-sm text-muted-foreground">
        No surface coordinates on file for this wellbore. 3,345 current wells are
        in the register without them.
      </div>
    );
  }

  return (
    <div className="relative min-h-48 flex-1 overflow-hidden rounded-[0.15rem] border">
      <div ref={containerRef} className="h-full w-full" />
      {!drawn && (
        <div className="absolute inset-0 z-10 flex bg-background">
          <LoadingScreen label="Loading location" />
        </div>
      )}
    </div>
  );
}
