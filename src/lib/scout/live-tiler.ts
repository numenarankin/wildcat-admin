import "server-only";

/**
 * Vector-tile generator for Scout's well dots.
 *
 * Archon serves these tiles from a static PMTiles archive built by its monthly
 * tippecanoe pipeline, falling back to on-the-fly clustering when the archive is
 * absent (archon `src/lib/wells/live-tiler.ts`). Wildcat has no archive and no
 * tiling pipeline, so it always takes that fallback path: supercluster over a
 * flat points file synced from Archon's `wells` table
 * (`scripts/scout-sync-data.mjs`).
 *
 * The emitted feature contract matches archon's tiles exactly, so the layer
 * definitions in `scout-map.tsx` port over unchanged:
 *   clusters   -> point_count, point_count_abbreviated
 *   individual -> api, og, plug, dist, swd, dead, st
 *
 * plus one addition of Wildcat's own: every cluster also carries `na` / `ni` /
 * `np`, how many of the wells inside it are active / inactive / plugged, and an
 * abbreviated string for each. A Mapbox filter cannot see inside a cluster, so
 * without these the bubbles keep counting wells the Status filter has hidden —
 * at z<=11 that is the whole map, and the filter looks broken because the only
 * thing on screen is bubbles.
 */

import Supercluster from "supercluster";
import vtpbf from "vt-pbf";
import { readFile, stat } from "node:fs/promises";
import { SCOUT_WELL_POINTS_PATH } from "@/lib/scout/data-files";

// Points file written by scripts/scout-sync-data.mjs:
//   [api, lon, lat, og, plug, dist, swd, dead, st]
// The trailing flags are optional: each was appended to an existing format, and
// a points file synced before one existed must still load rather than emit
// `undefined` into every tile.
type Row = [
  number,
  number,
  number,
  string,
  number,
  number,
  number?,
  number?,
  number?,
];

/** Activity buckets, as `st` encodes them. Mirrors `WellActivity`. */
const ST_ACTIVE = 0;
const ST_INACTIVE = 1;
const ST_PLUGGED = 2;

// MVT's conventional tile extent, and what tippecanoe emits. supercluster
// defaults to 512, so set it explicitly and scale the cluster radius by the
// same factor (40 @ 512 == 320 @ 4096) to keep the usual cluster spacing.
const EXTENT = 4096;
const RADIUS = 320;
/**
 * Last zoom at which wells are CLUSTERED.
 *
 * supercluster's `maxZoom` is the highest zoom it builds clusters for; above it
 * every well is its own point. Set to one below the survey-line threshold
 * (`SURVEY_MIN_ZOOM` = 12 in scout-map.tsx) so the two switch together: the
 * moment the property grid appears, the bubbles are gone and each dot is one
 * wellbore sitting on its tract. Below that the state has a million wells and
 * clusters are the only readable form.
 *
 * The vector source still declares maxzoom 13 in scout-map.tsx, and supercluster
 * happily serves tiles above its own maxZoom by clipping raw points — so z12 and
 * z13 tiles are individual wells, and Mapbox overzooms the z13 tile past 13.
 */
const CLUSTER_MAX_ZOOM = 11;

export const SOURCE_LAYER = "wells";

/**
 * Cache key for the tile URL.
 *
 * The tile route answers `immutable, max-age=86400`, which is right for a tile
 * whose contents never change — and wrong the moment they do. Re-syncing the
 * points file or changing the clustering above silently left every browser
 * showing day-old tiles: clusters kept appearing at zooms that had been
 * switched to individual wells, and no amount of reloading helped, because
 * `immutable` means the browser will not even revalidate.
 *
 * So the URL carries a token derived from the things that can change what a
 * tile contains — the points file's mtime and size, and the cluster settings.
 * New data or new settings produce a new URL, which is a cache miss by
 * construction; nothing else does.
 */
export async function tileVersion(): Promise<string> {
  try {
    const { mtimeMs, size } = await stat(SCOUT_WELL_POINTS_PATH);
    return `${Math.round(mtimeMs)}-${size}-${CLUSTER_MAX_ZOOM}-${RADIUS}-${FORMAT}`;
  } catch {
    return `none-${CLUSTER_MAX_ZOOM}-${RADIUS}-${FORMAT}`;
  }
}

/**
 * Bump when the emitted PROPERTIES change, not just the data.
 *
 * The points file's mtime covers new data, but adding `st` and the per-cluster
 * `na`/`ni`/`np` counts changes what a tile contains with the same file on
 * disk. Without this an `immutable` cached tile would keep answering a filter
 * that reads properties it does not carry, which draws nothing at all.
 */
const FORMAT = 2;

let indexPromise: Promise<Supercluster> | null = null;

async function build(): Promise<Supercluster> {
  const t0 = performance.now();
  const raw = await readFile(SCOUT_WELL_POINTS_PATH, "utf8");
  const rows: Row[] = JSON.parse(raw);

  const features = rows.map(([api, lon, lat, og, plug, dist, swd, dead, st]) => ({
    type: "Feature" as const,
    properties: {
      api,
      og,
      plug,
      dist,
      swd: swd ?? 0,
      dead: dead ?? plug,
      // A points file synced before `st` existed still has to filter sensibly:
      // plugged is knowable from `plug`, stopped from `dead`, and everything
      // else reads as active — the old behaviour, not a silently empty map.
      st: st ?? (plug ? ST_PLUGGED : (dead ?? 0) ? ST_INACTIVE : ST_ACTIVE),
    },
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
  }));

  const index = new Supercluster({
    radius: RADIUS,
    extent: EXTENT,
    maxZoom: CLUSTER_MAX_ZOOM,
    // Per-status tallies for every bubble. supercluster seeds an accumulator
    // from each point (`map`) and folds the children into it (`reduce`), so a
    // cluster knows its own composition and the Status filter can be applied to
    // bubbles as well as to dots.
    map: (props: Record<string, unknown>) => ({
      na: props.st === ST_ACTIVE ? 1 : 0,
      ni: props.st === ST_INACTIVE ? 1 : 0,
      np: props.st === ST_PLUGGED ? 1 : 0,
    }),
    reduce: (acc: Record<string, number>, props: Record<string, number>) => {
      acc.na += props.na;
      acc.ni += props.ni;
      acc.np += props.np;
    },
  });
  index.load(features);
  console.log(
    `[scout] indexed ${features.length} wells from ${SCOUT_WELL_POINTS_PATH} in ${Math.round(performance.now() - t0)} ms (read + parse + index)`
  );
  return index;
}

function getIndex(): Promise<Supercluster> {
  if (!indexPromise) {
    indexPromise = build().catch((err) => {
      // Don't cache a failed build — the next request should retry.
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

/**
 * Kick off the index build without waiting for it.
 *
 * The build reads a 39 MB file, parses it, and indexes ~961k points — ~1.8s on
 * the first tile request, once per process. The page calls this as it renders so
 * that work overlaps the map's own boot (Mapbox style + GL init) instead of
 * landing on the first tile. Errors are swallowed: the tile route rebuilds and
 * reports them properly.
 */
export function warmTileIndex(): void {
  void getIndex().catch(() => {});
}

/**
 * supercluster's own abbreviation, applied to our per-status counts.
 *
 * Copied from its `point_count_abbreviated` so a bubble reading "1.2k" with the
 * filter off and "1.2k" with it on is formatted by one rule. Done here rather
 * than in `reduce` because reduce runs per merge, and this is a display string
 * for the final value only.
 */
function abbreviate(n: number): string | number {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return n;
}

/** Returns a gzip-ready MVT buffer, or null for an empty tile. */
export async function liveTile(
  z: number,
  x: number,
  y: number
): Promise<Buffer | null> {
  const index = await getIndex();
  const tile = index.getTile(z, x, y);
  if (!tile || tile.features.length === 0) return null;
  for (const f of tile.features) {
    const tags = f.tags as Record<string, number | string> | undefined;
    if (!tags || tags.point_count === undefined) continue;
    tags.na_a = abbreviate(Number(tags.na ?? 0));
    tags.ni_a = abbreviate(Number(tags.ni ?? 0));
    tags.np_a = abbreviate(Number(tags.np ?? 0));
  }
  return Buffer.from(
    vtpbf.fromGeojsonVt({ [SOURCE_LAYER]: tile }, { version: 2, extent: EXTENT })
  );
}
