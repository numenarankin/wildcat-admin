/**
 * Permit purpose: the options, and the filter.
 *
 * Pure on purpose. The map cannot apply this with `map.setFilter`: both permit
 * sources are CLUSTERED (`PERMIT_SOURCE`, `PERMIT_HISTORY_SOURCE` in
 * `scout-map.tsx`), and clustering happens at the SOURCE, so a layer filter
 * hides dots while the bubbles keep counting the features it hid. The only
 * honest way to filter a clustered source is to hand it a different
 * FeatureCollection, which is what this module builds from the payload already
 * in the browser.
 *
 * The property being filtered is `purpose`, emitted by
 * `/api/scout/rrc/pending` from `FILING_PURPOSE` in `rrc-queries.ts`: a LABEL
 * ("New drill", "Recompletion") for the codes that route knows, the RAW CODE
 * for the ones it does not, and null when the state record carries no code at
 * all. All three have to be reachable from the control, or a permit the user
 * can see on the map has no box that brings it back.
 */

/**
 * The bucket for a permit whose filing purpose is missing.
 *
 * Underscored so it cannot collide with a real value: `purpose` is whatever
 * string the mirror carries, and a plain "Other" would silently swallow a
 * permit the RRC really did label "Other".
 */
export const UNSTATED_PURPOSE = "__unstated__";

/**
 * An unmapped filing-purpose code, recognised by SHAPE rather than by a list.
 *
 * `FILING_PURPOSE` lives in `rrc-queries.ts`, which is server-side (it opens a
 * database connection) and cannot be imported into the filter bar. It falls
 * back to the raw code, and every RRC filing-purpose code is digits — so a
 * value that is all digits is one the route could not name. Checking the shape
 * keeps this module from carrying a second copy of the vocabulary that would
 * drift the moment a code is added to the first.
 */
const RAW_CODE = /^\d+$/;

export interface PermitCollections {
  pending: GeoJSON.FeatureCollection;
  history: GeoJSON.FeatureCollection;
}

export interface PurposeOption {
  /** What `Filters.permitPurpose` carries for this option. */
  value: string;
  /** What the menu shows. Raw codes show as themselves; see `RAW_CODE`. */
  label: string;
  /** Permits in the LOADED payload, unfiltered — the population, not the view. */
  count: number;
  /** True for the unstated bucket and unmapped codes: the "Other" group. */
  other: boolean;
}

/** The option a feature belongs to. Null / blank / non-string => unstated. */
export function purposeKey(purpose: unknown): string {
  if (typeof purpose !== "string") return UNSTATED_PURPOSE;
  const trimmed = purpose.trim();
  return trimmed === "" ? UNSTATED_PURPOSE : trimmed;
}

/**
 * The options to offer, counted from what is loaded.
 *
 * Derived, never hardcoded: the codes in the payload are the only codes the
 * user can be looking at, and a fixed list would offer purposes with nothing
 * behind them while hiding a code the state started filing last week.
 *
 * BOTH collections are counted together, so a purpose that only appears in the
 * decided history still gets a box — pending is ~515 rows and history is tens
 * of thousands, so most of the vocabulary only exists on the history side.
 *
 * Counted from the UNFILTERED payload on purpose. Counting the filtered view
 * would drop every unselected option to zero the moment one is ticked, which is
 * the one state in which the counts are useless.
 */
export function purposeCounts(
  collections: PermitCollections | null | undefined
): PurposeOption[] {
  const counts = new Map<string, number>();
  for (const col of [collections?.pending, collections?.history]) {
    for (const f of col?.features ?? []) {
      const key = purposeKey(f.properties?.purpose);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      count,
      label: value === UNSTATED_PURPOSE ? "Not stated" : value,
      other: value === UNSTATED_PURPOSE || RAW_CODE.test(value),
    }))
    /*
     * Named purposes first, biggest first; the "Other" pile last, and the
     * unstated bucket last of all. Ties break on the label so the menu does not
     * reshuffle itself between two payloads that carry the same counts.
     */
    .sort((a, b) => {
      if (a.other !== b.other) return a.other ? 1 : -1;
      const aLast = a.value === UNSTATED_PURPOSE;
      const bLast = b.value === UNSTATED_PURPOSE;
      if (aLast !== bLast) return aLast ? 1 : -1;
      if (a.count !== b.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });
}

/**
 * Both collections, narrowed to the selected purposes.
 *
 * An EMPTY selection means every purpose, not none: the filter is off until
 * somebody turns it on, and "no boxes ticked" must never blank the map.
 */
export function filterPermitFeatures(
  collections: PermitCollections,
  purposes: readonly string[]
): PermitCollections {
  if (purposes.length === 0) {
    return { pending: collections.pending, history: collections.history };
  }
  const wanted = new Set(purposes);
  const keep = (col: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection => ({
    ...col,
    features: col.features.filter((f) =>
      wanted.has(purposeKey(f.properties?.purpose))
    ),
  });
  return { pending: keep(collections.pending), history: keep(collections.history) };
}
