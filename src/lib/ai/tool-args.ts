/**
 * One vocabulary for tool arguments, enforced at call time.
 *
 * ## The failure this exists for
 *
 * A model called `rank({ kind: "wells" })`. The argument is `cohort`. It picked
 * `kind` because `select_entities` — the tool it used one step earlier, in the
 * same turn — spells that argument `kind`, and the word carried over. The call
 * was refused, the model retried, and the user watched a pause.
 *
 * That is not a bug in `rank`. It is a bug in the SET: two tools naming one
 * concept two ways, with a model in between that has to remember which is which.
 * The codebase has more of these — `since`/`from`, `until`/`to`, `top`/`limit`,
 * `well_id`/`wellId`, `entity`/`handle` — spread across tools written months
 * apart. Fixing each one as it surfaces is whack-a-mole, and every miss is a
 * failed turn in front of a user.
 *
 * So the fix is here, once, and every tool call goes through it.
 *
 * ## Why this cannot corrupt a correct call
 *
 * A synonym is only rewritten when ALL of these hold:
 *
 *   1. the tool's own schema declares the blessed name,
 *   2. the caller did not supply the blessed name,
 *   3. the tool's schema does NOT declare the synonym.
 *
 * Rule 3 is what makes it safe. A tool that genuinely has both `from` and
 * `since`, meaning different things, is untouched, because `since` is one of its
 * real arguments. Nothing is ever renamed onto a key the caller already set, and
 * nothing is renamed for a tool that does not want it.
 *
 * Pure and dependency-free.
 */

/** Blessed name → the spellings a model reaches for instead. */
export const ARG_SYNONYMS: Record<string, readonly string[]> = {
  cohort: ["kind", "group", "population", "set"],
  kind: ["cohort", "type"],
  handle: ["entity", "entityId", "target", "ref"],
  from: ["since", "start", "startDate", "after", "fromDate"],
  to: ["until", "end", "endDate", "before", "toDate"],
  limit: ["top", "max", "count", "n"],
  wellId: ["well_id", "wellID", "well"],
  leaseId: ["lease_id", "lease"],
  operator_no: ["operatorNo", "operator"],
  api: ["api_number", "apiNumber", "apiWellNo"],
  metric: ["stream", "measure"],
  // The depth window on the population screens. Measured live: the model wrote
  // `depth_from_ft` / `depth_to_ft` on two consecutive calls, was refused both
  // times, and the turn spent 18 tool calls and 2.7 minutes getting there. The
  // `from`/`to` pair above already teaches it that vocabulary, so the screens
  // inherited a wrong guess from a right habit.
  depth_top_ft: ["depth_from_ft", "top_ft", "depthTopFt", "depth_start_ft", "from_ft"],
  depth_bottom_ft: ["depth_to_ft", "bottom_ft", "depthBottomFt", "depth_end_ft", "to_ft"],
};

/**
 * Every alias that maps onto a blessed name, for the audit test.
 *
 * A synonym appearing in a real tool's schema and NOT listed here is an argument
 * a model can get wrong with nothing to catch it.
 */
export function knownSynonyms(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(ARG_SYNONYMS)) for (const s of list) out.add(s);
  return out;
}

/**
 * Rewrite the synonyms a schema can accept, and leave everything else alone.
 *
 * `declared` is the set of argument names the tool actually takes. Callers that
 * cannot cheaply produce it should pass `null`, which disables rewriting rather
 * than guessing — an alias applied to a tool that never wanted it would turn a
 * clear "wrong arguments" refusal into a silently wrong call, which is worse.
 */
export function normalizeToolArgs(
  args: Record<string, unknown>,
  declared: ReadonlySet<string> | null
): Record<string, unknown> {
  if (!declared || declared.size === 0) return args;

  let out: Record<string, unknown> | null = null;
  for (const [blessed, synonyms] of Object.entries(ARG_SYNONYMS)) {
    if (!declared.has(blessed)) continue;
    if (blessed in args) continue;
    for (const synonym of synonyms) {
      if (!(synonym in args)) continue;
      // The tool declares this synonym itself, so it means something here.
      if (declared.has(synonym)) continue;
      out ??= { ...args };
      out[blessed] = out[synonym];
      delete out[synonym];
      break;
    }
  }
  return out ?? args;
}

/** The argument names a Zod object schema declares. Empty for anything else. */
export function declaredArgs(schema: unknown): Set<string> {
  const shape = (schema as { shape?: Record<string, unknown> })?.shape;
  return new Set(shape ? Object.keys(shape) : []);
}

/**
 * Snap a near-miss enum value onto the option the schema actually allows.
 *
 * Observed live, on the first question ever asked of the catalog:
 * `rank({ metric: "oil_production" })`. The legal values are `oil`, `gas` and
 * `water`. The model was not guessing wildly, it was being descriptive, and the
 * call was refused for a word ending.
 *
 * Matching is deliberately narrow: case-insensitive, and after stripping
 * non-alphanumerics, an option matches when it equals the value or the value
 * begins with the option followed by a separator. So `oil_production` and
 * `Oil` both reach `oil`, while `oilfield` does not reach `oil` by accident and
 * an ambiguous value that matches two options is left alone to be refused.
 *
 * Returns null when nothing matches cleanly, so the caller keeps the original
 * and the dispatcher's refusal still names the real signature.
 */
export function coerceEnumValue(value: unknown, options: readonly string[]): string | null {
  if (typeof value !== "string" || options.length === 0) return null;
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(value);
  if (options.some((o) => norm(o) === target)) {
    return options.find((o) => norm(o) === target) ?? null;
  }
  const prefixed = options.filter((o) => {
    const on = norm(o);
    // The value must CONTINUE past the option at a word boundary in the
    // original, which is what separates "oil_production" from "oilfield".
    return (
      target.startsWith(on) && /[^a-z0-9]/i.test(value.charAt(o.length))
    );
  });
  return prefixed.length === 1 ? prefixed[0] : null;
}

/** The literal options of an enum schema, unwrapping optional/default. */
export function enumOptions(schema: unknown): string[] {
  const def = (schema as { _zod?: { def?: { type?: string; innerType?: unknown; entries?: Record<string, unknown> } } })
    ?._zod?.def;
  if (!def) return [];
  if (["optional", "default", "nullable"].includes(def.type ?? "")) {
    return enumOptions(def.innerType);
  }
  return def.type === "enum" ? Object.keys(def.entries ?? {}) : [];
}

/**
 * Coerce every enum argument a schema declares, leaving the rest untouched.
 *
 * Applied at the dispatchers, where the schema is in hand. A value that cannot be
 * matched cleanly is left as the caller wrote it, so the refusal still names the
 * real signature rather than silently substituting something the user did not ask
 * for.
 */
export function coerceEnumArgs(
  schema: unknown,
  args: Record<string, unknown>
): Record<string, unknown> {
  const shape = (schema as { shape?: Record<string, unknown> })?.shape;
  if (!shape) return args;

  let out: Record<string, unknown> | null = null;
  for (const [key, sub] of Object.entries(shape)) {
    if (!(key in args)) continue;
    const options = enumOptions(sub);
    if (options.length === 0) continue;
    const raw = args[key];
    if (typeof raw !== "string" || options.includes(raw)) continue;
    const fixed = coerceEnumValue(raw, options);
    if (fixed === null) continue;
    out ??= { ...args };
    out[key] = fixed;
  }
  return out ?? args;
}
