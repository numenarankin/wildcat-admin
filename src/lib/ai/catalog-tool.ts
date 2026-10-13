import { z } from "zod";

/**
 * One deterministic analysis reached through a DISPATCHER rather than registered
 * on its own.
 *
 * Two catalogs use this shape: the Texas public record (`rrc_analyze`) and the
 * company's own records (`company_analyze`). Both make the same trade
 * `petrophysics` makes on the geology side. Registering a hundred argument
 * schemas would cost tens of thousands of tokens on every call, nearly all of it
 * irrelevant to any one question, and a wrong call answered with the real
 * signature is cheaper than that, every turn.
 *
 * A tool is a name, a one-line summary, a Zod shape, and a function. Nothing
 * else. The signature the model reads is DERIVED from the shape rather than
 * written alongside it, because a catalog that drifts from the function behind
 * it is a tool the model calls wrong every time with no way to notice.
 */
export interface CatalogTool {
  name: string;
  /** One line. This is the whole description the model gets. */
  summary: string;
  args: z.ZodObject<z.ZodRawShape>;
  run: (args: never) => Promise<unknown> | unknown;
}

/**
 * Declare a tool.
 *
 * Takes the raw shape rather than a built object so `run` infers its argument
 * type without a second declaration.
 */
export function defineTool<S extends z.ZodRawShape>(
  name: string,
  summary: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown
): CatalogTool {
  return {
    name,
    summary,
    args: z.object(shape) as unknown as z.ZodObject<z.ZodRawShape>,
    run: run as (args: never) => Promise<unknown> | unknown,
  };
}

/** Zod internals we read to render a signature. Narrow on purpose. */
interface ZodDef {
  type?: string;
  innerType?: unknown;
  element?: unknown;
  entries?: Record<string, unknown>;
}
function def(schema: unknown): ZodDef {
  return ((schema as { _zod?: { def?: ZodDef } })?._zod?.def ?? {}) as ZodDef;
}

/**
 * One token a model can act on, in the same short forms the petrophysics
 * catalog uses: `str`, `num`, `int`, `bool`, `obj`, `num[]`, with `?` for
 * anything that may be omitted.
 */
export function shortType(schema: unknown): string {
  const d = def(schema);
  if (d.type === "optional" || d.type === "default" || d.type === "nullable") {
    return `${shortType(d.innerType)}?`;
  }
  switch (d.type) {
    case "string":
      return "str";
    case "number":
      return "num";
    case "int":
      return "int";
    case "boolean":
      return "bool";
    case "array":
      return `${shortType(d.element)}[]`;
    case "enum":
      return Object.keys(d.entries ?? {}).join("|") || "str";
    default:
      return "obj";
  }
}

/** Required parameters first, then optional ones in brackets. */
export function signature(tool: CatalogTool): string {
  const required: string[] = [];
  const optional: string[] = [];
  for (const [key, schema] of Object.entries(tool.args.shape)) {
    const type = shortType(schema);
    (type.endsWith("?") ? optional : required).push(`${key}: ${type}`);
  }
  const req = required.join(", ");
  const opt = optional.length ? `${req ? ", " : ""}[${optional.join(", ")}]` : "";
  return `${tool.name}(${req}${opt})`;
}

/**
 * Arguments that change WHAT THE MODEL CAN REACH, as opposed to how it phrases
 * the question.
 *
 * These are rendered even though they are free-form, which is the one exception
 * to the rule below, and it was bought with a failure. `limit` and `radius_mi`
 * were invisible, so a screen of Texas ran against the nearest 60 wells and the
 * model never learned it could ask for more: it cannot raise a ceiling it has
 * not been told is there. `apis` is here for the same reason in the other
 * direction: it is how an analysis is pointed at a population that was already
 * screened, and a model that cannot see it re-derives the population by anchor
 * and gets a different one.
 *
 * The list stays SHORT deliberately. Every name added costs characters on every
 * tool that has it, on every turn. Measured over the 144-tool RRC catalog:
 * 27,698 characters with enum arguments alone, 29,311 with these three as well.
 * 1,613 characters, against a statewide screen that could not be asked for.
 */
const APERTURE_ARGS = new Set(["limit", "radius_mi", "apis"]);

/**
 * Every enum argument, rendered as `arg: a|b|c`, plus the aperture arguments
 * above.
 *
 * Other free-form arguments stay out. A model that has to guess `from` writes a
 * date and is right; a model that has to guess `metric` writes `oil_production`
 * and is refused, because only three strings are legal and it was never shown
 * them. Closed sets are exactly where guessing fails and exactly where the
 * value list is short enough to be free.
 */
function enumArgs(tool: CatalogTool): string {
  const parts: string[] = [];
  for (const [key, schema] of Object.entries(tool.args.shape)) {
    const type = shortType(schema);
    const bare = type.endsWith("?") ? type.slice(0, -1) : type;
    if (bare.includes("|") || APERTURE_ARGS.has(key)) parts.push(`${key}: ${bare}`);
  }
  return parts.join(", ");
}

/**
 * The catalog line the model reads: a name, its closed-set arguments, and what
 * it answers.
 *
 * Most free-form arguments are deliberately absent. They were the majority of
 * the catalog's size, they are guessable (a date is a date), and both
 * dispatchers answer a bad call by naming the real signature. Measured on the
 * petrophysics catalog, which uses the same form: 34.6k characters with every
 * parameter, 13.0k without. The exceptions are the aperture arguments above,
 * which are not guessable in the way a date is: a default the model cannot see
 * is a default it cannot decide to change.
 *
 * The ENUM values are not in that trade, and leaving them out was measured
 * costing a wrong call on the very first question asked of it: with the names
 * alone the model called `rank(metric: "oil_production")`, which is refused, and
 * invented a `window` argument that does not exist. A model cannot pick from a
 * set it has not been shown, and unlike a missing date this failure is certain
 * rather than likely.
 *
 * What is NOT dropped is the name. Every tool stays visible, because a catalog is
 * a menu before it is a reference: a model cannot decide to call something it has
 * never been told exists, and that failure is silent.
 */
export function catalogLine(tool: CatalogTool): string {
  const enums = enumArgs(tool);
  return enums
    ? `${tool.name}(${enums}): ${tool.summary}`
    : `${tool.name}: ${tool.summary}`;
}

/**
 * Render a grouped catalog block for the system prompt.
 *
 * One line per tool under a heading, with empty groups dropped so a group that
 * has not been written yet costs nothing.
 */
export function renderCatalog(
  groups: { label: string; tools: readonly CatalogTool[] }[]
): string {
  return groups
    .filter((g) => g.tools.length > 0)
    .map((g) => `# ${g.label}\n${g.tools.map(catalogLine).join("\n")}`)
    .join("\n\n");
}
