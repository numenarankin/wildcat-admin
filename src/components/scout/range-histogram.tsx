"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  barHeights,
  barInBand,
  bandCount,
  histogramField,
  nearestEdgeIndex,
  thumbPosition,
  type Histogram,
  type HistogramField,
} from "@/lib/scout/histogram";
import { cn } from "@/lib/utils";

/**
 * The population behind a range filter, with the band drawn over it.
 *
 * This does NOT replace the Min/Max boxes it sits above. The boxes are how you
 * enter 8,437; this is how you find out that 8,000 to 10,000 is 72,711 wells and
 * that there is a tail past 16,000 worth looking at. Both write the same two
 * values, so there is one filter state and two ways into it.
 *
 * The thumbs SNAP to the bars. A slider over a long-tailed domain that moves
 * continuously lands on numbers nobody meant (8,437 feet is not a question
 * anyone asks), and snapping is also what lets the count below be exact rather
 * than nearly right: a band that stops part-way through a bar has no answer in
 * this data, and `bandCount` returns null rather than inventing one.
 */

/*
 * Fetched once per field per page load, and shared by every mount.
 *
 * The route caches server-side too, but that does not stop this component from
 * asking again on every open of the filter group. The promise is the cache: a
 * second mount joins the first request rather than starting another.
 */
const loaded = new Map<HistogramField, Promise<Histogram | null>>();

function load(field: HistogramField): Promise<Histogram | null> {
  const hit = loaded.get(field);
  if (hit) return hit;
  const req = fetch(`/api/scout/histogram?field=${field}`)
    .then((r) => (r.ok ? (r.json() as Promise<Histogram>) : null))
    .catch(() => null);
  loaded.set(field, req);
  return req;
}

/**
 * One end of the band. Module scope, not a closure inside the render: a
 * component redeclared per render is a new type every time, and React throws its
 * state (and the pointer capture mid-drag) away with the old one.
 */
function Thumb({
  which,
  at,
  label,
  edges,
  value,
  onDown,
  onMove,
  onUp,
  onStep,
}: {
  which: "min" | "max";
  /** Fraction across the track. */
  at: number;
  label: string;
  edges: number[];
  value: number | null;
  onDown: (which: "min" | "max", e: React.PointerEvent) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: (e: React.PointerEvent) => void;
  onStep: (by: number) => void;
}) {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={`${which === "min" ? "Minimum" : "Maximum"} ${label}`}
      aria-valuemin={edges[0]}
      aria-valuemax={edges[edges.length - 1]}
      aria-valuenow={value ?? undefined}
      onPointerDown={(e) => onDown(which, e)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onStep(-1);
        else if (e.key === "ArrowRight") onStep(1);
        else return;
        e.preventDefault();
      }}
      className="absolute top-0 z-10 h-full w-3 -translate-x-1/2 cursor-ew-resize touch-none focus:outline-none"
      style={{ left: `${at * 100}%` }}
    >
      <div className="mx-auto h-full w-0.5 rounded bg-foreground/70" />
    </div>
  );
}

export function RangeHistogram({
  field,
  min,
  max,
  onChange,
  label,
}: {
  field: HistogramField;
  min: number | null;
  max: number | null;
  /** Both ends at once: dragging one thumb past the other swaps them. */
  onChange: (min: number | null, max: number | null) => void;
  /** Screen-reader name for the pair; the visible one is the bar's field label. */
  label: string;
}) {
  const [data, setData] = useState<Histogram | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"min" | "max" | null>(null);

  useEffect(() => {
    let live = true;
    load(field).then((h) => {
      if (live) setData(h);
    });
    return () => {
      live = false;
    };
  }, [field]);

  const { edges } = histogramField(field);
  const heights = useMemo(() => (data ? barHeights(data.buckets) : []), [data]);
  const inBand = data?.buckets.length ?? 0;

  /*
   * Thumb positions are bar BOUNDARIES, not values on a number line.
   *
   * Edge i opens bar i + 1, so it sits at (i + 1) / bars across the track. An
   * unbounded end sits hard against the edge of the track, which is what "no
   * floor" looks like.
   */
  const posOf = (v: number | null, openAt: 0 | 1) =>
    thumbPosition(field, inBand, v, openAt);

  const valueAt = (fraction: number): number | null => {
    // Fraction of the track back to an edge, with both ends of the track
    // meaning unbounded rather than "the first bar".
    const i = Math.round(fraction * inBand) - 1;
    if (i < 0) return null;
    if (i >= edges.length) return edges[edges.length - 1];
    return edges[i];
  };

  const moveTo = (clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || !dragging.current) return;
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const v = valueAt(f);
    const next: [number | null, number | null] =
      dragging.current === "min" ? [v, max] : [min, v];
    // Dragged past the other thumb: the band is still the band, so the values
    // swap rather than the drag stopping at a wall.
    if (next[0] !== null && next[1] !== null && next[0] > next[1]) {
      onChange(next[1], next[0]);
      dragging.current = dragging.current === "min" ? "max" : "min";
      return;
    }
    onChange(next[0], next[1]);
  };

  const onThumbDown = useCallback(
    (which: "min" | "max", e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = which;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    []
  );
  const onThumbMove = (e: React.PointerEvent) => {
    if (dragging.current) moveTo(e.clientX);
  };
  const onThumbUp = (e: React.PointerEvent) => {
    dragging.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const step = (which: "min" | "max", by: number) => {
    const current = which === "min" ? min : max;
    const i = current === null ? (which === "min" ? -1 : edges.length) : nearestEdgeIndex(edges, current);
    const next = i + by;
    const v = next < 0 || next >= edges.length ? null : edges[next];
    if (which === "min") onChange(v, max);
    else onChange(min, v);
  };

  if (!data || data.total === 0) return null;

  const count = bandCount(field, data.buckets, min, max);
  const minPos = posOf(min, 0);
  const maxPos = posOf(max, 1);

  return (
    <div className="w-full select-none">
      <div ref={trackRef} className="relative h-10 w-full">
        <div className="flex h-full w-full items-end gap-px">
          {data.buckets.map((b, i) => (
            <div
              key={i}
              title={`${b.label}: ${b.count.toLocaleString("en-US")}`}
              className={cn(
                "flex-1 rounded-t-[1px]",
                barInBand(b, min, max) ? "bg-foreground/60" : "bg-muted-foreground/20"
              )}
              style={{ height: `${Math.max(heights[i] * 100, b.count > 0 ? 4 : 0)}%` }}
            />
          ))}
        </div>
        <Thumb
          which="min"
          at={minPos}
          label={label}
          edges={edges}
          value={min}
          onDown={onThumbDown}
          onMove={onThumbMove}
          onUp={onThumbUp}
          onStep={(by) => step("min", by)}
        />
        <Thumb
          which="max"
          at={maxPos}
          label={label}
          edges={edges}
          value={max}
          onDown={onThumbDown}
          onMove={onThumbMove}
          onUp={onThumbUp}
          onStep={(by) => step("max", by)}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{data.buckets[1]?.label}</span>
        <span>
          {(count ?? data.total).toLocaleString("en-US")} wells
        </span>
        <span>{data.buckets[data.buckets.length - 1]?.label}</span>
      </div>
    </div>
  );
}
