import { join } from "node:path";

/**
 * Where Scout's synced RRC artifacts live.
 *
 * Deliberately NOT under `public/`: those two files are the whole map (every
 * well point, every operator with an address), and anything in `public/` is
 * served to anyone who guesses the URL — which would route around the
 * early-access gate. They sit in a gitignored build directory instead and are
 * served only through the gated routes under `/api/scout/*`.
 *
 * The two point files are produced by `scripts/scout-sync-data.mjs` and the
 * histogram file by `scripts/scout-sync-histograms.ts`, both reading the Tiger
 * mirror. Missing files make /scout 503 rather than render an empty map.
 */

const DIR = join(process.cwd(), ".scout-data");

/**
 * `[api, lon, lat, og, plug, dist, swd]` for every geocoded well.
 *
 * `swd` (1 when the well holds a live saltwater disposal permit) was appended
 * rather than inserted, so a points file written before it existed still reads
 * correctly and simply reports no disposal wells.
 */
export const SCOUT_WELL_POINTS_PATH = join(DIR, "wells-points.json");

/** Operator points placed at their mailing-ZIP centroid (OperatorPoint[]). */
export const SCOUT_OPERATORS_PATH = join(DIR, "operators.json");

/**
 * Gzipped twin of {@link SCOUT_OPERATORS_PATH}, written by the same sync script.
 * The raw file is ~4 MB and compresses to ~1 MB; the route serves this verbatim
 * with `Content-Encoding: gzip` so operator mode doesn't ship 4 MB uncompressed.
 */
export const SCOUT_OPERATORS_GZ_PATH = join(DIR, "operators.json.gz");

/**
 * Statewide populations behind the map's range filters, keyed by field
 * (`Record<HistogramField, Histogram>` plus a `builtAt` stamp).
 *
 * Precomputed rather than queried per request for the reason the sync script's
 * header measures out: the counting scan straddles the request pool's 5 s
 * statement timeout, and the answer is a constant between mirror reloads.
 */
export const SCOUT_HISTOGRAMS_PATH = join(DIR, "histograms.json");
