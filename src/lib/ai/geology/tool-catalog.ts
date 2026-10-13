/**
 * The petrophysics catalog, as the model reads it.
 *
 * `tool-catalog.json` is generated from the Python package by
 * `scripts/build-geology-catalog.py` — 113 tools with their real signatures,
 * regenerated rather than written, because a catalog that drifts from the
 * functions behind it is a tool the model calls wrong every time with no way to
 * notice.
 *
 * ## Why a list and not schemas
 *
 * These reach the model through one dispatcher (`petrophysics`), not as 149
 * registered tools. Registered, their argument schemas would cost roughly 50k
 * tokens on every call, nearly all of it irrelevant to any one question. As a
 * list it costs about 35k characters, and a call with the wrong arguments comes
 * back naming the signature it expected. One wrong call is cheaper than the
 * schemas, every turn.
 *
 * Types are the short forms `num`, `str`, `bool`, `int`, `obj`, `num[]`, `obj[]`,
 * with `?` for nullable — enough for something writing JSON, at a quarter the
 * width of the Python annotations they come from.
 */
import catalog from "./tool-catalog.json";

export interface CatalogEntry {
  name: string;
  group: string;
  module: string;
  signature: string;
  required: string[];
  optional: string[];
  summary: string;
}

export const CATALOG_ENTRIES: readonly CatalogEntry[] = catalog.tools;

/** Every name the dispatcher will answer to. Used to check a call before it goes. */
export function catalogNames(): Set<string> {
  return new Set(CATALOG_ENTRIES.map((t) => t.name));
}

export function findTool(name: string): CatalogEntry | undefined {
  return CATALOG_ENTRIES.find((t) => t.name === name);
}

/**
 * One catalog line: a NAME and what it answers. No parameters.
 *
 * This has been all three ways round, so the history is worth keeping.
 *
 * v1 listed required names with no types, and it cost a wasted model step every
 * time a tool took an optional argument: `datum_resolve` takes `header` and the
 * model sent `las_header`, `subsea_convert` takes `kb` and it sent
 * `reference_elevation_ft`. Neither was on the list, so neither was guessable.
 *
 * v2 fixed that by listing required and optional arguments with their types, and
 * paid for it in size. Measured at 149 tools, arguments were 70% of the catalog:
 * 34.6k characters with them, 13.0k without. `squeeze_recommend` alone was 701.
 *
 * v3 drops them entirely, which is v1's saving without v1's failure, because the
 * missing piece was never the types: it was that a wrong call has to come back
 * ANSWERABLE. `dispatch.call` raises with `signature_text(fn)`, so a call with no
 * arguments at all is met with the real signature and the next call is right.
 * One round trip on a miss beats 21k characters on every turn, which is the same
 * argument the module header makes about registering schemas.
 *
 * The name always stays. A catalog is a menu before it is a reference, and a
 * model cannot choose a tool it was never told exists. That failure, unlike a
 * wrong argument list, is silent.
 */
function line(tool: CatalogEntry): string {
  return `${tool.name}: ${tool.summary}`;
}

/**
 * The block that goes in the system prompt.
 *
 * Built at module load, once. Grouped by nothing: the catalog's own order is
 * the order the tools were specified in, which runs file ingest → normalization
 * → geometry → petrophysics → pressure → completion, and that is roughly the
 * order an evaluation needs them.
 */
export const PETROPHYSICS_CATALOG = CATALOG_ENTRIES.map(line).join("\n");
