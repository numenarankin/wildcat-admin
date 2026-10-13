/**
 * The filter BAR read as the focus QUERY — the one translation between what the
 * user set and what the database is asked.
 *
 * It lived inside `scout-map.tsx` as three private helpers (the mapping, the
 * `focusActive` memo, and `switchMode`'s carve-out), which meant the two
 * decisions that actually shape the map could only be checked by opening a
 * browser. They are pure functions of a `Filters` object, so they are here, and
 * `filter-focus.test.ts` asserts them by hand.
 *
 * `Filters` is imported as a TYPE ONLY. It is declared in a client component
 * that pulls in server actions; the type erases, so nothing of that component
 * reaches this module's callers -- the same rule `scout-view-spec.ts` follows
 * for the same reason.
 *
 * THE TWO HALVES MUST AGREE. `needsFocusLayer` decides whether the query runs
 * at all and `toFocusOpts` decides what it asks. A predicate one of them counts
 * and the other drops is either a filter that silently does nothing (drawn
 * shape, tiles still showing) or a blank map (the layer switches and the query
 * has no predicates). That pairing is why they sit in one file.
 */

import type { Filters, MapMode } from "@/components/scout/map-filters";
import { chosen } from "@/lib/scout/focus-where";
import type { Shape } from "@/lib/scout/geo-shapes";
import type { FocusOpts } from "@/lib/scout/types";

/**
 * The whole bar as one focus query.
 *
 * The only real work is `chosen()`, which reads the bar's three spellings of a
 * value ("all", one, or a list) as the one shape the query wants — and keeps
 * `null` meaning "no filter" while an empty list means "resolved to nobody".
 *
 * `operatorNumbers` is passed in rather than read off `filters`, because the
 * bar holds an operator and a person while the query wants the operator NUMBERS
 * a person resolves to, and that resolution is a round trip the map owns.
 */
export function toFocusOpts(
  filters: Filters,
  operatorNumbers: number[] | null
): FocusOpts {
  return {
    operatorNumbers,
    excludePlugged: filters.excludePlugged,
    countyCodes: chosen(filters.county),
    districts: chosen(filters.district),
    oilGas: filters.oilGas === "all" ? null : filters.oilGas,
    statuses: chosen(filters.status),
    wellTypes: chosen(filters.wellType),
    minDepth: filters.minDepth,
    maxDepth: filters.maxDepth,
    minCompletionYear: filters.minCompletionYear,
    maxCompletionYear: filters.maxCompletionYear,
    minOilRate: filters.minOilRate,
    maxOilRate: filters.maxOilRate,
    minGasRate: filters.minGasRate,
    maxGasRate: filters.maxGasRate,
    shapes: filters.shapes,
    // The bar has no owner pick; only the Owner modal's map sets this.
    owner: null,
  };
}

/**
 * Is the map drawing the query-backed FOCUS layer instead of the vector tiles?
 *
 * The tiles carry api/og/plug/district and nothing else, so this is exactly the
 * list of things they cannot answer. Commodity, status and district are
 * DELIBERATELY ABSENT: those are tile filters, and counting them here would
 * trade a million-well statewide layer for a query capped at 30,000 rows every
 * time somebody clicked "Oil".
 *
 * A DRAWN SHAPE COUNTS, and it is the one that is easy to leave out. `pt <@
 * polygon` is a database predicate with no tile equivalent, so a box drawn with
 * nothing else set has to switch the layer or the shape appears on screen over a
 * map it did not narrow — which reads as the draw tool being broken rather than
 * as the filter never having run.
 *
 * THE PRODUCTION BAND COUNTS, on the same grounds as the depth band. A rate
 * lives in `wildcat.well_rate`, which the tiles know nothing about, so a band
 * set with nothing else would otherwise leave the whole statewide tile layer on
 * screen unnarrowed — the filter reading as broken rather than as never run.
 *
 * `excludePlugged` is deliberately absent too: it is a map setting rather than a
 * question, the tile layer answers it already, and counting it here would turn
 * an untouched bar into a statewide focus query capped at 30,000 wells.
 */
export function needsFocusLayer(filters: Filters): boolean {
  return (
    filters.operator != null ||
    filters.person != null ||
    chosen(filters.county) != null ||
    chosen(filters.wellType) != null ||
    filters.minDepth != null ||
    filters.maxDepth != null ||
    filters.minCompletionYear != null ||
    filters.maxCompletionYear != null ||
    filters.minOilRate != null ||
    filters.maxOilRate != null ||
    filters.minGasRate != null ||
    filters.maxGasRate != null ||
    filters.shapes.length > 0
  );
}

/**
 * What a filter set carries with it when the map MODE changes.
 *
 * Everything else resets, because the modes ask different questions of
 * different records and a filter set for one means something else in the next
 * (see `switchMode`). Two kinds of thing survive:
 *
 *   - THE GEAR-MENU SETTINGS. Surveys, pipelines and "exclude plugged" are how
 *     the user wants the map DRAWN, not what they are looking for.
 *   - THE DRAWN AREA, on exactly the same grounds. An area is WHERE you are
 *     looking; switching from wells to permits is still looking there. Losing
 *     the box on a mode toggle would mean drawing it again to ask the second
 *     half of one question.
 *
 * Both the bar's own `switchMode` and Orion's `applyScoutView` route through
 * here, so the two paths into a mode change cannot drift: an area that survives
 * a click and not a directive would be a rule that depends on who asked.
 */
export interface ModeCarry {
  mode: MapMode;
  excludePlugged: boolean;
  showSurveys: boolean;
  showPipelines: boolean;
  shapes: Shape[];
}

export function carryAcrossMode<F extends ModeCarry>(
  current: F,
  mode: MapMode,
  defaults: F
): F {
  return {
    ...defaults,
    mode,
    excludePlugged: current.excludePlugged,
    showSurveys: current.showSurveys,
    showPipelines: current.showPipelines,
    shapes: current.shapes,
  };
}

/**
 * The area as a phrase, for the line Orion reads. Null when nothing is drawn.
 *
 * Shapes are counted by KIND rather than listed as coordinates: a ring of 64
 * vertices spelled out is the whole context budget for a fact the model cannot
 * do anything with, and what it needs to know is that the map is restricted to
 * a drawn area and how big a one.
 */
export function describeShapes(shapes: readonly Shape[]): string | null {
  if (shapes.length === 0) return null;
  const circles = shapes.filter((s) => s.kind === "circle").length;
  const polygons = shapes.length - circles;
  const parts: string[] = [];
  if (polygons > 0) parts.push(`${polygons} drawn shape${polygons === 1 ? "" : "s"}`);
  if (circles > 0) parts.push(`${circles} radius ring${circles === 1 ? "" : "s"}`);
  return `${parts.join(" and ")} (the map is restricted to what they cover)`;
}
