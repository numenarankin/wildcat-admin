/**
 * Slice builders, one per surface.
 *
 * Pure functions, exported, never inline in JSX. The component's only job is to
 * call one and hand the result to `usePageContextSlice`. That split is what
 * makes the whole feature testable without rendering a Mapbox canvas, which
 * matters because the canvas is the one thing the test suite cannot drive.
 *
 * Every builder obeys the three rules in `page-context.ts`: ids beside names,
 * the count on the first line, and the query beside the rows.
 */
import {
  MAX_LIST_ROWS,
  SLICE_PRIORITY,
  type ContextSlice,
} from "@/lib/ai/page-context";

/** A geographic box, west/south/east/north, as Mapbox reports it. */
export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export const fmtBbox = (b: Bbox): string =>
  `bbox: ${b.west.toFixed(4)},${b.south.toFixed(4)},${b.east.toFixed(4)},${b.north.toFixed(4)}`;

/* ------------------------------------------------------------------ scout */

export interface ScoutWellInView {
  api: number;
  /** Present on the focus layer; the statewide tile layer has no names. */
  name?: string;
  operator?: string;
  operatorNumber?: number;
}

export interface ScoutViewportInput {
  /** wells | operators | permits, straight off the map's filter state. */
  mode: string;
  bbox: Bbox | null;
  zoom: number;
  /**
   * The wells the map is actually drawing in view.
   *
   * Empty means the map is on the statewide tile layer with no filter applied,
   * which is a different statement from "no wells here" and is said as such.
   */
  wellsInView: readonly ScoutWellInView[];
  /** True when a focus query is driving the map, i.e. `wellsInView` is meaningful. */
  focused: boolean;
  /** The focus query hit its cap, so what is drawn is a sample. */
  capped?: boolean;
  permits?: { total: number; approved: number; drilled: number } | null;
}

/**
 * What the map is showing.
 *
 * The count leads, the query follows, the rows come last and are the only part
 * that may be truncated. Asked something the listed rows cannot answer, Orion
 * has the bbox and can go back to the mirror for the rest.
 */
export function buildScoutViewportSlice(
  input: ScoutViewportInput
): ContextSlice | null {
  if (!input.bbox) return null;
  const lines: string[] = [];

  if (input.mode === "permits" && input.permits) {
    lines.push(
      `${input.permits.total} pending permits in view, ` +
        `${input.permits.approved} approved, ${input.permits.drilled} drilled.`
    );
  } else if (input.focused) {
    const shown = Math.min(input.wellsInView.length, MAX_LIST_ROWS);
    lines.push(
      `${input.wellsInView.length} wells in view` +
        (input.wellsInView.length > shown ? ` (${shown} listed below)` : "") +
        (input.capped ? ", and the search hit its cap so this is a sample" : "") +
        "."
    );
  } else {
    lines.push(
      "No filter is applied, so the map is drawing the statewide well layer. " +
        "There is no list of what is in view; query the public record by bbox if the count matters."
    );
  }

  lines.push(fmtBbox(input.bbox), `zoom: ${input.zoom.toFixed(1)}`);

  if (input.focused && input.wellsInView.length > 0) {
    const operators = topOperators(input.wellsInView);
    if (operators) lines.push(`operators in view: ${operators}`);
    for (const w of input.wellsInView.slice(0, MAX_LIST_ROWS)) {
      lines.push(
        `- ${w.name ?? "unnamed"} (api ${w.api}` +
          (w.operatorNumber != null ? `, operator ${w.operatorNumber}` : "") +
          ")"
      );
    }
  }

  return {
    priority: SLICE_PRIORITY.contents,
    label: `Recon map (${input.mode} mode)`,
    lines,
  };
}

/** Operator names with their well counts, biggest first. Ids included. */
function topOperators(wells: readonly ScoutWellInView[]): string | null {
  const tally = new Map<number, { name: string; n: number }>();
  for (const w of wells) {
    if (w.operatorNumber == null) continue;
    const row = tally.get(w.operatorNumber) ?? { name: w.operator ?? "unnamed", n: 0 };
    row.n++;
    tally.set(w.operatorNumber, row);
  }
  if (tally.size === 0) return null;
  return [...tally.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 5)
    .map(([number, r]) => `${r.name} (${number}): ${r.n}`)
    .join(", ");
}

export interface ScoutModalInput {
  /**
   * What kind of thing is open: `operator`, `lease`, `well`, `tank`, whatever
   * the surface calls it. Free text rather than a union because every page has
   * its own vocabulary and the word goes straight into the prose the model
   * reads; a union here would only force each caller to lie about one of them.
   */
  kind: string;
  /** The id the tools take: api number, operator number, lease key, name. */
  id: string | number;
  name?: string;
  /** Headline facts already rendered on the card. */
  facts?: string[];
}

/**
 * The dossier the user is reading.
 *
 * Highest priority in the app: it is literally in front of everything else, and
 * the router only sees the first 200 characters, so this has to lead.
 */
export function buildScoutModalSlice(
  modal: ScoutModalInput | null
): ContextSlice | null {
  if (!modal) return null;
  const named = modal.name ? ` "${modal.name}"` : "";
  return {
    priority: SLICE_PRIORITY.modal,
    label: `Open dossier: ${modal.kind}${named}`,
    lines: [
      `${modal.kind} id: ${modal.id}`,
      `"this ${modal.kind}", "it", or an unqualified reference means this one.`,
      ...(modal.facts ?? []),
    ],
  };
}

/**
 * The filters that shaped what is drawn.
 *
 * Defaults are omitted entirely. A slice that says "county: all, district: all"
 * spends budget to say nothing, and it reads as a constraint when it is the
 * absence of one.
 */
export function buildScoutFilterSlice(
  active: Record<string, string | number | boolean | null | undefined>
): ContextSlice | null {
  const lines = Object.entries(active)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== "all" && v !== false)
    .map(([k, v]) => `${k}: ${v}`);
  if (lines.length === 0) return null;
  return {
    priority: SLICE_PRIORITY.controls,
    label: "Recon filters in force",
    lines,
  };
}

/* ------------------------------------------------------------------ wells */

export interface WellPageInput {
  id: string;
  name: string;
  /** Which tab is open. The single selection never carried this. */
  tab?: string;
  facts?: string[];
}

export function buildWellPageSlice(input: WellPageInput): ContextSlice {
  return {
    priority: SLICE_PRIORITY.selection,
    label: `Viewing well "${input.name}"`,
    lines: [
      `well id: ${input.id}`,
      ...(input.tab ? [`open tab: ${input.tab}`] : []),
      `If they say "this well", "the well", or ask about a well without naming ` +
        `one, they mean this one. Pass well id "${input.id}" to the well tools.`,
      ...(input.facts ?? []),
    ],
  };
}

/* ------------------------------------------------------------------ lists */

export interface RowListInput {
  label: string;
  /** Total matching rows, which is often the answer on its own. */
  total: number;
  /** Rendered rows, already including ids. The builder caps them. */
  rows: readonly string[];
  /** What produced this set: filters, search, sort. */
  query?: readonly string[];
  priority?: number;
}

/**
 * Any table or result list.
 *
 * One builder rather than one per page: a list of rows with a total and a query
 * is the same shape everywhere, and the pages differ only in how they render a
 * row, which is the caller's job.
 */
export function buildRowListSlice(input: RowListInput): ContextSlice | null {
  if (input.total === 0 && input.rows.length === 0) return null;
  const shown = Math.min(input.rows.length, MAX_LIST_ROWS);
  return {
    priority: input.priority ?? SLICE_PRIORITY.contents,
    label: input.label,
    lines: [
      `${input.total} rows` + (input.total > shown ? ` (${shown} listed below)` : "") + ".",
      ...(input.query ?? []),
      ...input.rows.slice(0, MAX_LIST_ROWS).map((r) => `- ${r}`),
    ],
  };
}
