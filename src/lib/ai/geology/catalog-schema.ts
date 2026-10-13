/**
 * Real argument schemas for the petrophysics catalog, generated from it.
 *
 * ## Why this exists
 *
 * The 153 calculations reached the model through one dispatcher whose `args` was
 * a free-form record, so nothing constrained what it could emit and the first
 * validation was a 422 from Python. In production that cost the analysis: Fable
 * called `matrix_density_sensitivity` with `matrices` instead of
 * `matrix_candidates`, and `density_porosity` with no `lithology`, then gave up
 * and wrote a caveat about the matrix question — which is precisely what those
 * two tools compute.
 *
 * Every fix short of a schema is a patch on a guess. The catalog was rendered
 * three different ways to try to make the model guess better (see
 * `tool-catalog.ts`), and the third gave up on argument names entirely and
 * relied on the model spending a round trip to read the signature out of the
 * error. It does not reliably spend it.
 *
 * With a schema the provider constrains decoding: a key outside the object
 * cannot be emitted and a required key cannot be omitted. The failure mode stops
 * being handled and starts being unrepresentable.
 *
 * ## Generated, never written
 *
 * `tool-catalog.json` is already built from the Python package by
 * `scripts/build-geology-catalog.py`, and already carries `required` and
 * `optional` with short type tags. These schemas come from those, so they cannot
 * drift from the functions any more than the catalog can.
 *
 * ## The cost, measured
 *
 * All 153 schemas are ~72.6k characters, about 18k tokens, against ~3.3k for the
 * name-only catalog they replace. That was the objection to registering them
 * before; it does not survive measurement now that Stage 3 sets
 * `cacheControl: ephemeral`, which puts the tool block in the cached prefix and
 * charges it once per window rather than once per step. A single well turn was
 * measured at 365k input tokens, so this is a few percent of one turn, cached.
 */
import { z } from "zod";
import { CATALOG_ENTRIES, type CatalogEntry } from "./tool-catalog";

/**
 * The catalog's short type tags, as `build-geology-catalog.py` emits them.
 *
 * `?` suffixes mean nullable and are stripped before lookup. Anything
 * unrecognised becomes a permissive value rather than an error: a tag this does
 * not know is a reason to accept the argument, not to make the tool uncallable.
 */
/**
 * Any JSON value except undefined.
 *
 * `z.unknown()` accepts undefined, so using it for a REQUIRED argument makes the
 * argument optional in practice — 52 of the catalog's 361 required arguments are
 * typed `obj`, and every one of them was silently omittable until this was
 * caught by the round-trip test below. The union keeps them permissive about
 * shape (the Python side has the real types) while still demanding they be
 * there, which is the entire job.
 */
const PRESENT: z.ZodTypeAny = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

function baseType(tag: string): z.ZodTypeAny {
  switch (tag.replace(/\?$/, "").trim()) {
    case "num":
      return z.number();
    case "int":
      return z.number().int();
    case "str":
      return z.string();
    case "bool":
      return z.boolean();
    case "num[]":
      return z.array(z.number());
    case "str[]":
      return z.array(z.string());
    case "obj[]":
      return z.array(z.unknown());
    case "obj":
    default:
      return PRESENT;
  }
}

/** `"rho_b: num"` → `["rho_b", "num"]`. */
function splitSpec(spec: string): [string, string] {
  const at = spec.indexOf(":");
  if (at === -1) return [spec.trim(), "obj"];
  return [spec.slice(0, at).trim(), spec.slice(at + 1).trim()];
}

/**
 * One calculation's argument object.
 *
 * Optionals are `.optional()` rather than `.nullable()`: the Python side
 * defaults them, and a model that emits an explicit `null` for a defaulted
 * argument gets a different answer than one that omits it.
 *
 * `.strict()` is deliberate and is the whole point — an unknown key is the exact
 * failure this file exists to make impossible, so it must be rejected rather
 * than dropped silently.
 */
export function schemaFor(entry: CatalogEntry): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const spec of entry.required) {
    const [name, tag] = splitSpec(spec);
    shape[name] = baseType(tag);
  }
  for (const spec of entry.optional) {
    const [name, tag] = splitSpec(spec);
    shape[name] = baseType(tag).optional();
  }
  return z.object(shape).strict();
}

/**
 * The description the model reads, which is the catalog line it used to read.
 *
 * Kept short on purpose: the arguments are now in the schema, where they are
 * enforced, so repeating them in prose would pay for them twice and give the
 * model a second, unenforced copy to disagree with.
 */
export function describeFor(entry: CatalogEntry): string {
  return entry.summary;
}

export interface PetrophysicsSchema {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
}

/** Every calculation, with the schema that makes a wrong call impossible. */
export function petrophysicsSchemas(): PetrophysicsSchema[] {
  return CATALOG_ENTRIES.map((entry) => ({
    name: entry.name,
    description: describeFor(entry),
    inputSchema: schemaFor(entry),
  }));
}
