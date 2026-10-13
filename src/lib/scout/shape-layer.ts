"use client";

/**
 * The drawn area, as one attachable layer: what is on the map, and the pointer
 * work that puts it there.
 *
 * Same bones as `survey-layer.ts` and `pipeline-layer.ts` — `add()` re-creates
 * the sources and layers after a basemap swap throws them away, `repaint()`
 * follows the basemap, and every rule about how a shape is drawn or dragged
 * lives here rather than in the 2,300-line map component.
 *
 * ## Why this is hand-rolled and not `@mapbox/mapbox-gl-draw`
 *
 * Measured against the actual package (1.5.1, 13 packages, 2.2 MB installed)
 * rather than from memory:
 *
 *   - IT DOES NOT SURVIVE `setStyle`. Its `onAdd` calls `addSource`/`addLayer`
 *     once and it listens for no `styledata`, so the basemap toggle — which
 *     this map has, and which is exactly why every source here is rebuilt on
 *     `style.load` — would erase every drawn shape from the screen while its
 *     own store still held them. Model and screen disagreeing is the failure
 *     the ring's `styleEpoch` dependency was already written to prevent.
 *   - IT WOULD BE A SECOND SOURCE OF TRUTH. The shapes are a FILTER; they live
 *     in `Filters.shapes` and drive the query. Draw keeps its own feature store
 *     and emits change events, so every shape would exist twice and have to be
 *     reconciled in both directions.
 *   - IT COVERS ONE OF THE THREE PRODUCERS. No circle mode and no freehand, so
 *     the ring and the lasso are hand-rolled either way; the box is the only
 *     part it would have supplied.
 *   - ITS CONTROLS ARE MAPBOX'S CHROME, which `MapControls` exists to avoid.
 *
 * What it would genuinely have given us is vertex editing, which is the
 * `shape-vertices` layer plus the drag below.
 *
 * ## The three producers, one model
 *
 * A ring around a well, a dragged box and a freehand lasso differ only in how
 * the ring is produced. Two of them are `{kind:"polygon"}` the moment the mouse
 * comes up; the ring stays a CIRCLE in the model so "5 miles from this well"
 * survives as that statement (`geo-shapes.ts`). Freehand is a producer of
 * polygons, not a kind of shape: it samples the drag and hands the result to
 * `simplifyRing`, and after that nothing downstream can tell the two apart.
 */

import type mapboxgl from "mapbox-gl";
import {
  circleRing,
  milesBetween,
  polygonLiteral,
  shapeRing,
  simplifyRing,
  type LonLat,
  type Shape,
} from "@/lib/scout/geo-shapes";

export const SHAPE_SOURCE = "shape-src";
export const SHAPE_VERTEX_SOURCE = "shape-vertex-src";
export const SHAPE_DRAFT_SOURCE = "shape-draft-src";

/** Every layer this owns, in draw order. Named for the map's visibility sweeps. */
export const SHAPE_LAYERS = [
  "shape-fill",
  "shape-line",
  "shape-draft-fill",
  "shape-draft-line",
  "shape-vertices",
];

/**
 * Which tool the next pointer gesture belongs to.
 *
 * ARMED, exactly like the radius pin's button: every other click on this map is
 * layer-scoped, so a bare drag means "pan" until the user says otherwise. The
 * `ring` tool is armed here but SPENT ON A WELL CLICK, which the map component
 * owns because it is the only thing that knows which layers are wells.
 */
export type DrawTool = "off" | "box" | "lasso" | "ring";

/**
 * How far the pointer must travel before a drag is a shape, in pixels.
 *
 * A click while armed is a mis-click, and the shape it would make is a
 * degenerate ring that `polygonLiteral` refuses (fewer than three distinct
 * vertices). Refusing it here instead means the user gets nothing rather than a
 * failed query, and 6 px is past the wobble of a click but well under any
 * deliberate drag.
 *
 * It also has to stay ABOVE Mapbox's own `clickTolerance`, which is 3 px and
 * which is what stops a drag from also firing a `click` (`MapEventHandler` in
 * mapbox-gl 3.25: `click` is dropped when the pointer moved that far since
 * mousedown). Because 6 > 3, a drag that draws a box can never also open the
 * dossier of a well it happened to finish on top of.
 */
const MIN_DRAG_PX = 6;

/**
 * Sampled points kept for one lasso before further moves are ignored.
 *
 * A pointer fires up to one move per frame; a slow careful lasso around a
 * county is a few hundred, and 4,000 is a mouse left dragging for a minute.
 * `simplifyRing` collapses whatever arrives, so this is a bound on the gesture
 * rather than on the shape: past it the drag keeps going and the ring simply
 * stops gaining detail, which is the safe way to fail on a mouse that was left
 * held down.
 */
const MAX_LASSO_POINTS = 4000;

/**
 * How far from a corner handle a mousedown still grabs it, in pixels.
 *
 * The handle is drawn at radius 5, so this is that plus a little: a corner you
 * have to hit exactly is a corner that is not really draggable, and the two
 * gestures are unambiguous anyway (a miss starts a new shape or pans).
 */
const GRAB_PX = 8;

export interface ShapeLayerHandle {
  /** (Re)create the sources and layers. Safe to call after every style load. */
  add(): void;
  /** The shapes the filter now holds. Repaints the fill, outline and handles. */
  setShapes(shapes: readonly Shape[]): void;
  setTool(tool: DrawTool): void;
  repaint(satellite: boolean): void;
  /** Unbind the pointer handlers. The layers go with the style. */
  destroy(): void;
}

/**
 * Rose, because every other colour on this map is taken: wells are green and
 * blue, injectors blue, operators violet, permits amber and green, the radius
 * ring blue, the survey grid amber. An area has to be unmistakably not one of
 * those. Lightened over imagery for the same reason the well dots gain a white
 * stroke there.
 */
function paint(satellite: boolean) {
  return {
    line: satellite ? "#fda4af" : "#e11d48",
    fill: satellite ? "#fb7185" : "#f43f5e",
    fillOpacity: satellite ? 0.1 : 0.08,
  };
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Would this shape survive being turned into SQL?
 *
 * `polygonLiteral` throws on a ring with fewer than three distinct vertices or
 * with all of them on one line, and it is right to: such a polygon is valid
 * input that contains almost nothing, so "the query ran and found no wells" is
 * how a dropped coordinate would present itself. That refusal belongs at the
 * moment of the GESTURE, though, not three layers later inside a server action
 * — a scribble that was never a shape should make nothing, rather than making a
 * shape that breaks every query until it is found and removed.
 */
export function drawable(shape: Shape): boolean {
  try {
    polygonLiteral(shapeRing(shape));
    return true;
  } catch {
    return false;
  }
}

/** A ring as a closed GeoJSON polygon. Mapbox wants the first vertex repeated. */
function polygonFeature(ring: readonly LonLat[], props: Record<string, number> = {}) {
  const closed = [...ring.map(([x, y]) => [x, y] as [number, number])];
  if (closed.length > 0) closed.push([closed[0][0], closed[0][1]]);
  return {
    type: "Feature" as const,
    properties: props,
    geometry: { type: "Polygon" as const, coordinates: [closed] },
  };
}

export function attachShapeLayer(
  map: mapboxgl.Map,
  opts: {
    satellite: boolean;
    /** A finished box or lasso. The map decides where it goes in the filter. */
    onCreate: (shape: Shape) => void;
    /** A vertex was dragged and released: the whole list, as it now stands. */
    onEdit: (shapes: Shape[]) => void;
  }
): ShapeLayerHandle {
  let shapes: Shape[] = [];
  let tool: DrawTool = "off";
  let satellite = opts.satellite;

  /** The gesture in progress, if any. Null between gestures. */
  let drag:
    | { kind: "box"; from: LonLat; at: mapboxgl.Point }
    | { kind: "lasso"; points: LonLat[]; at: mapboxgl.Point }
    | { kind: "vertex"; shape: number; vertex: number }
    /**
     * The ring: a centre, dragged outward.
     *
     * It used to be click-only, which read as broken next to box and lasso.
     * Arming it and dragging just panned the map, because nothing claimed the
     * drag and Mapbox did.
     */
    | { kind: "radius"; center: LonLat; at: mapboxgl.Point }
    | null = null;

  const src = (id: string) =>
    map.getSource(id) as mapboxgl.GeoJSONSource | undefined;

  function add(): void {
    for (const id of [SHAPE_SOURCE, SHAPE_DRAFT_SOURCE, SHAPE_VERTEX_SOURCE]) {
      if (!map.getSource(id)) {
        map.addSource(id, {
          type: "geojson",
          data: EMPTY,
        } as unknown as mapboxgl.SourceSpecification);
      }
    }
    const p = paint(satellite);

    if (!map.getLayer("shape-fill")) {
      map.addLayer({
        id: "shape-fill",
        type: "fill",
        source: SHAPE_SOURCE,
        paint: { "fill-color": p.fill, "fill-opacity": p.fillOpacity },
      } as unknown as mapboxgl.LayerSpecification);
    }
    if (!map.getLayer("shape-line")) {
      map.addLayer({
        id: "shape-line",
        type: "line",
        source: SHAPE_SOURCE,
        paint: { "line-color": p.line, "line-width": 2 },
      } as unknown as mapboxgl.LayerSpecification);
    }
    if (!map.getLayer("shape-draft-fill")) {
      map.addLayer({
        id: "shape-draft-fill",
        type: "fill",
        source: SHAPE_DRAFT_SOURCE,
        paint: { "fill-color": p.fill, "fill-opacity": p.fillOpacity },
      } as unknown as mapboxgl.LayerSpecification);
    }
    if (!map.getLayer("shape-draft-line")) {
      // Dashed while it is still being drawn, solid once it is a filter, so the
      // two states are never the same picture.
      map.addLayer({
        id: "shape-draft-line",
        type: "line",
        source: SHAPE_DRAFT_SOURCE,
        paint: { "line-color": p.line, "line-width": 1.5, "line-dasharray": [2, 2] },
      } as unknown as mapboxgl.LayerSpecification);
    }
    if (!map.getLayer("shape-vertices")) {
      // The handles. Only polygons get them: a circle's 64 vertices are
      // GENERATED from its centre and radius, and dragging one would be editing
      // an approximation rather than the shape.
      map.addLayer({
        id: "shape-vertices",
        type: "circle",
        source: SHAPE_VERTEX_SOURCE,
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-stroke-color": p.line,
        },
      } as unknown as mapboxgl.LayerSpecification);
    }
    refresh();
  }

  /** Push the current shapes into the two committed sources. */
  function refresh(): void {
    src(SHAPE_SOURCE)?.setData({
      type: "FeatureCollection",
      features: shapes.map((s, i) => polygonFeature(shapeRing(s), { s: i })),
    } as GeoJSON.FeatureCollection);

    const handles: GeoJSON.Feature[] = [];
    shapes.forEach((s, i) => {
      if (s.kind !== "polygon") return;
      s.ring.forEach(([lon, lat], v) => {
        handles.push({
          type: "Feature",
          properties: { s: i, v },
          geometry: { type: "Point", coordinates: [lon, lat] },
        });
      });
    });
    src(SHAPE_VERTEX_SOURCE)?.setData({
      type: "FeatureCollection",
      features: handles,
    } as GeoJSON.FeatureCollection);
  }

  function setDraft(ring: readonly LonLat[] | null): void {
    src(SHAPE_DRAFT_SOURCE)?.setData(
      ring && ring.length >= 3
        ? ({
            type: "FeatureCollection",
            features: [polygonFeature(ring)],
          } as GeoJSON.FeatureCollection)
        : EMPTY
    );
  }

  /** The lat/lon rectangle between two corners, counter-clockwise from SW. */
  function boxRing(a: LonLat, b: LonLat): LonLat[] {
    const w = Math.min(a[0], b[0]);
    const e = Math.max(a[0], b[0]);
    const s = Math.min(a[1], b[1]);
    const n = Math.max(a[1], b[1]);
    return [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ];
  }

  function cursor(): void {
    map.getCanvas().style.cursor = tool === "off" ? "" : "crosshair";
  }

  /*
   * A DRAG THAT DRAWS MUST NOT ALSO PAN.
   *
   * `preventDefault` on the mousedown is Mapbox's own way of saying so (it is
   * how the draggable-marker example works); toggling `dragPan` off and on
   * instead leaves the map stuck if anything throws between the two.
   */
  const onDown = (e: mapboxgl.MapMouseEvent) => {
    if (drag) return;
    /*
     * A HANDLE WINS OVER A NEW SHAPE: the vertex layer is drawn last, so a
     * mousedown on one is an edit even while a tool is armed.
     *
     * Queried over a box rather than the exact pixel. The handles are 5 px
     * circles and this is the interaction the shape exists for — every corner
     * draggable after the fact — so asking for a hit within GRAB_PX makes them
     * catchable rather than a test of aim. Skipped entirely when nothing is
     * drawn, since this runs on every mousedown the map sees, panning included.
     */
    const onHandle =
      shapes.length > 0 && map.getLayer("shape-vertices")
        ? map.queryRenderedFeatures(
            [
              [e.point.x - GRAB_PX, e.point.y - GRAB_PX],
              [e.point.x + GRAB_PX, e.point.y + GRAB_PX],
            ],
            { layers: ["shape-vertices"] }
          )
        : [];
    const hit = onHandle[0]?.properties as { s?: number; v?: number } | undefined;
    if (hit && typeof hit.s === "number" && typeof hit.v === "number") {
      e.preventDefault();
      drag = { kind: "vertex", shape: hit.s, vertex: hit.v };
      map.getCanvas().style.cursor = "grabbing";
      return;
    }

    if (tool === "box") {
      e.preventDefault();
      drag = { kind: "box", from: [e.lngLat.lng, e.lngLat.lat], at: e.point };
    } else if (tool === "lasso") {
      e.preventDefault();
      drag = { kind: "lasso", points: [[e.lngLat.lng, e.lngLat.lat]], at: e.point };
    } else if (tool === "ring") {
      e.preventDefault();
      /*
       * SNAPPED TO THE WELL UNDER THE CURSOR, if there is one.
       *
       * "Everything within two miles of this well" is the question the tool
       * exists for, and a ring centred two pixels off the hole answers a
       * slightly different one. Off a well it still works, centred where the
       * drag began, because refusing to draw is worse than drawing what was
       * asked for.
       */
      const on = map
        .queryRenderedFeatures(e.point, {
          layers: ["wells", "focus-wells"].filter((id) => map.getLayer(id)),
        })
        .find((f) => f.geometry.type === "Point");
      const center: LonLat =
        on && on.geometry.type === "Point"
          ? [on.geometry.coordinates[0], on.geometry.coordinates[1]]
          : [e.lngLat.lng, e.lngLat.lat];
      drag = { kind: "radius", center, at: e.point };
    }
  };

  const onMove = (e: mapboxgl.MapMouseEvent) => {
    if (!drag) return;
    const here: LonLat = [e.lngLat.lng, e.lngLat.lat];
    last = { point: e.point, lngLat: here };

    if (drag.kind === "box") {
      setDraft(boxRing(drag.from, here));
      return;
    }
    if (drag.kind === "lasso") {
      if (drag.points.length < MAX_LASSO_POINTS) drag.points.push(here);
      setDraft(drag.points);
      return;
    }
    if (drag.kind === "radius") {
      const [lon, lat] = drag.center;
      setDraft(circleRing(lat, lon, milesBetween(lat, lon, here[1], here[0])));
      return;
    }
    /*
     * A VERTEX DRAG IS PAINTED, NOT COMMITTED, until the mouse comes up.
     *
     * Committing per move would run the focus query — a database round trip
     * against a GiST index — on every animation frame of the drag, and the map
     * would redraw its wells from an answer three frames stale. So the moved
     * ring goes straight into the source and React hears about it once, at the
     * end.
     */
    const d = drag;
    const s = shapes[d.shape];
    if (!s || s.kind !== "polygon") return;
    const ring = s.ring.map((pt, i) => (i === d.vertex ? here : pt));
    shapes = shapes.map((other, i) =>
      i === d.shape ? ({ kind: "polygon", ring } as Shape) : other
    );
    refresh();
  };

  /** The last position the pointer was seen at INSIDE the canvas. */
  let last: { point: mapboxgl.Point; lngLat: LonLat } | null = null;

  const onUp = (e: mapboxgl.MapMouseEvent) => {
    finish({ point: e.point, lngLat: [e.lngLat.lng, e.lngLat.lat] });
  };

  /*
   * RELEASING OUTSIDE THE CANVAS STILL ENDS THE GESTURE.
   *
   * Mapbox binds its own document-level mouseup, but routes it to its handlers
   * as `mouseupWindow` — `map.on("mouseup")` only ever fires for a release ON
   * the canvas. Dragging a box past the edge of the map and letting go over the
   * filter bar would otherwise leave the gesture open forever: the draft frozen
   * on screen, and every later mousedown swallowed by the `if (drag) return`
   * above. So the window hears it too, and finishes at the last point the
   * canvas saw.
   *
   * Both fire for an in-canvas release. The element's listener runs before the
   * document's, so the exact release position wins and this one finds nothing
   * left to do.
   */
  const onWindowUp = () => {
    if (drag && last) finish(last);
    else if (drag) cancel();
  };

  function cancel(): void {
    drag = null;
    last = null;
    setDraft(null);
    cursor();
  }

  function finish(at: { point: mapboxgl.Point; lngLat: LonLat }): void {
    const current = drag;
    if (!current) return;
    drag = null;
    last = null;
    cursor();

    if (current.kind === "vertex") {
      // A fresh array, so React sees a new identity and the query re-runs.
      opts.onEdit(shapes.map((s) => s));
      return;
    }

    setDraft(null);
    // Below the threshold this was a click, not a drag. Nothing is created and
    // the tool stays armed, so the next attempt needs no second click on the
    // button.
    const moved = Math.hypot(at.point.x - current.at.x, at.point.y - current.at.y);
    if (moved < MIN_DRAG_PX) return;

    const here = at.lngLat;
    if (current.kind === "radius") {
      const [lon, lat] = current.center;
      // A sub-tenth-of-a-mile ring is a click that wobbled, and the click path
      // already answers that by ringing the well at the panel's radius.
      const miles = Math.max(0.1, milesBetween(lat, lon, here[1], here[0]));
      opts.onCreate({ kind: "circle", lat, lon, miles });
      return;
    }
    if (current.kind === "box") {
      const box: Shape = { kind: "polygon", ring: boxRing(current.from, here) };
      if (drawable(box)) opts.onCreate(box);
      return;
    }
    // Douglas-Peucker at the module's default tolerance, which is relative to
    // the lasso's own size — see `SIMPLIFY_FRACTION`. A drag straight down the
    // screen simplifies to two points, and a hand that shook along one line to
    // a set of collinear ones; both are drawn gestures and neither is a shape.
    const lasso: Shape = { kind: "polygon", ring: simplifyRing([...current.points, here]) };
    if (drawable(lasso)) opts.onCreate(lasso);
  }

  map.on("mousedown", onDown);
  map.on("mousemove", onMove);
  map.on("mouseup", onUp);
  window.addEventListener("mouseup", onWindowUp);

  return {
    add,
    setShapes(next) {
      shapes = next.map((s) => s);
      refresh();
    },
    setTool(next) {
      tool = next;
      cursor();
    },
    repaint(next) {
      satellite = next;
      const p = paint(satellite);
      const set = (layer: string, prop: string, value: string | number) => {
        if (map.getLayer(layer)) {
          map.setPaintProperty(
            layer,
            prop as Parameters<mapboxgl.Map["setPaintProperty"]>[1],
            value as Parameters<mapboxgl.Map["setPaintProperty"]>[2]
          );
        }
      };
      set("shape-fill", "fill-color", p.fill);
      set("shape-fill", "fill-opacity", p.fillOpacity);
      set("shape-line", "line-color", p.line);
      set("shape-draft-fill", "fill-color", p.fill);
      set("shape-draft-fill", "fill-opacity", p.fillOpacity);
      set("shape-draft-line", "line-color", p.line);
      set("shape-vertices", "circle-stroke-color", p.line);
    },
    destroy() {
      map.off("mousedown", onDown);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
      window.removeEventListener("mouseup", onWindowUp);
    },
  };
}

/** A ring `miles` around a well, as the CIRCLE the model keeps. */
export function ringAround(lat: number, lon: number, miles: number): Shape {
  // Built through `circleRing` once here purely to fail loudly on a swapped
  // pair or an impossible radius at the moment of the click, rather than when
  // the query is built and the failure reads as "no wells here".
  circleRing(lat, lon, miles, 8);
  return { kind: "circle", lat, lon, miles };
}
