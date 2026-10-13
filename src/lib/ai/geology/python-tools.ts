/**
 * The deterministic tool layer, reachable from the harness.
 *
 * 149 tools, the LAS parse, the porosity and saturation math, the deliverability
 * and cement correlations — are Python, each citing the corpus segment its
 * equation came from. The harness is TypeScript. `api/geology.py` in this
 * repository is the seam: a Python function of this same deployment, not a
 * service somewhere else, which is why there is no host to keep alive and no
 * second thing to deploy.
 *
 * ## Four tools, not 149
 *
 * Three carry the Stage 0 contract and are registered with the schemas
 * `contracts.ts` declares, because the harness validates their shape and a
 * mismatch there is a parse failure here. The fourth, `petrophysics`, reaches
 * everything else by name.
 *
 * That last one is a deliberate trade. Registering 149 tool schemas would put
 * about 40k tokens of arguments in front of the model on every call, most of
 * them irrelevant to any one question; the catalog costs about 35k characters in the
 * prompt and the dispatcher answers a wrong call with the tool's real signature.
 * One wrong call is cheaper than the schemas, every turn, forever.
 *
 * ## The LAS travels as text
 *
 * `ToolContext.lasPath` is a Supabase file id, not a path on any disk the Python
 * function shares. The file's text is read here — from the same cache Orion's
 * own LAS reader uses — and posted with the call. The function stays stateless
 * and holds no storage credentials of its own.
 *
 * ## A refusal is a value
 *
 * Half these tools decline where the source does not support an answer: no unit
 * on the depth column, a mnemonic not in the dictionary, a crossplot outside its
 * calibrated range. That comes back as a result, not an error, and the harness
 * renders it as a finding. Only an unreachable function, an unknown name, or
 * arguments that do not fit are thrown.
 */
import { z } from "zod";
import {
  TOOL,
  curvesSchema,
  headerSchema,
  mnemonicSchema,
  noArgs,
} from "./contracts";
import { loadText } from "@/lib/kb/structured";
import { PETROPHYSICS_CATALOG, catalogNames } from "./tool-catalog";
import { petrophysicsSchemas } from "./catalog-schema";
import type { GeologyTool, ToolContext, ToolRegistry } from "./registry";

/** Parsing sits in the user's wait, so it gets a hard ceiling. */
const TIMEOUT_MS = 30_000;

/**
 * Where `api/geology.py` answers.
 *
 * In the deployment that is this same app, so the origin is its own. Vercel
 * names it in `VERCEL_URL` — the per-deployment host, which is the right one to
 * call: a preview must reach its own tools and not production's.
 * `GEOLOGY_TOOLS_URL` overrides for local work, where `next dev` serves no
 * Python and `scripts/geology-tools-dev.py` stands in.
 */
export function toolServiceUrl(): string {
  const named = process.env.GEOLOGY_TOOLS_URL?.replace(/\/$/, "");
  if (named) return named.endsWith("/api/geology") ? named : `${named}/api/geology`;
  const host = process.env.VERCEL_URL;
  if (host) return `https://${host}/api/geology`;
  return "http://127.0.0.1:8781/api/geology";
}

async function post<R>(body: Record<string, unknown>, signal?: AbortSignal): Promise<R> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // A protected preview deployment refuses its own unauthenticated requests, so
  // the call would 401 on exactly the deployments that most need testing.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;

  const res = await fetch(toolServiceUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // The function returns a plain reason on a failure; carry it rather than a
    // status code, because the reason is what the answer has to explain.
    const detail = await res.text().catch(() => "");
    let reason = detail.slice(0, 400);
    try {
      const parsed: unknown = JSON.parse(detail);
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        reason = String((parsed as { error: unknown }).error);
      }
    } catch {
      // Not JSON. The raw body is the better message than nothing.
    }
    throw new Error(`${String(body.op)} failed (${res.status}): ${reason}`);
  }
  return (await res.json()) as R;
}

/**
 * How the LAS text is fetched.
 *
 * Injectable because the default reaches Supabase, and a test of the parse
 * should not need a database to prove the tool layer returns the right header.
 */
export type ReadLas = (fileId: string) => Promise<{ name: string; text: string } | null>;

async function lasText(read: ReadLas, ctx: ToolContext): Promise<{ text: string; name: string }> {
  if (!ctx.lasPath) throw new Error("no LAS file in scope for this turn");
  const loaded = await read(ctx.lasPath);
  if (!loaded?.text) throw new Error(`file ${ctx.lasPath} has no readable text`);
  return { text: loaded.text, name: loaded.name };
}

/**
 * The dispatcher's arguments.
 *
 * `args` is a free-form record on purpose: it is 149 different signatures, the
 * catalog in the prompt names them, and the function validates the call against
 * the real one and says what it should have been. A zod union of 149 shapes
 * would be the same information at fifty times the cost.
 */
const dispatchSchema = z
  .object({
    tool: z.string().optional().describe("The tool's name, exactly as the catalog spells it."),
    /** Accepted because models reach for it about as often as `tool`. */
    name: z.string().optional(),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Keyword arguments for that tool. Omit any you have no value for."),
  })
  // Everything else is taken as the tool's arguments. Models routinely flatten
  // the call — `{tool: "vshale", gr_log: 75}` instead of nesting under `args` —
  // and a schema rejection there costs a whole round trip to say something the
  // shape already made obvious.
  .catchall(z.unknown());

interface DispatchArgs {
  tool?: string;
  name?: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Work out what was actually asked for.
 *
 * Throws rather than guessing when there is no name at all: a dispatcher that
 * picks a tool for the caller is worse than one that says what it needed.
 */
export function resolveDispatch(raw: DispatchArgs): { tool: string; args: Record<string, unknown> } {
  const name = raw.tool ?? raw.name;
  if (!name) {
    throw new Error(
      "no tool named. Call this as {tool: \"<name from the catalog>\", args: {...}} — " +
        "for example {tool: \"archie_sw\", args: {rt: 12, rw: 0.05, phi: 0.14}}."
    );
  }
  const known = catalogNames();
  if (!known.has(name)) {
    const near = [...known].filter((n) => n.includes(name) || name.includes(n)).slice(0, 6);
    throw new Error(
      `no tool named "${name}" in the catalog` +
        (near.length ? `; the closest are ${near.join(", ")}` : "") +
        ". Use a name exactly as the catalog spells it."
    );
  }

  if (raw.args && Object.keys(raw.args).length > 0) return { tool: name, args: raw.args };
  const flattened = { ...raw };
  delete flattened.tool;
  delete flattened.name;
  delete flattened.args;
  return { tool: name, args: flattened };
}

/**
 * The Python layer, reachable directly rather than through the registry.
 *
 * `contract-tools.ts` composes several tool calls into one contract shape, so it
 * needs to call them without each hop becoming its own ledger entry — the ledger
 * records the branch, and twenty calls behind one branch is noise. This is that
 * door, and it is the same HTTP path the registered tools use.
 */
export function pythonBridge(readLas: ReadLas = loadText) {
  const withLas = async (ctx: ToolContext) => {
    if (!ctx.lasPath) return null;
    return lasText(readLas, ctx).catch(() => null);
  };
  return {
    async run(tool: string, args: Record<string, unknown>, ctx: ToolContext) {
      const las = await withLas(ctx);
      const out = await post<{ result: unknown }>(
        { op: "call", tool, args, ...(las ? { text: las.text, name: las.name } : {}) },
        ctx.signal
      );
      return (out.result ?? {}) as Record<string, unknown>;
    },
    async columns(ctx: ToolContext, opts: { curves?: string[]; topFt?: number; baseFt?: number; maxSamples?: number }) {
      const las = await withLas(ctx);
      if (!las) return null;
      return post<{ depthFt: (number | null)[]; columns: Record<string, (number | null)[]>; sampled: number; ofRows: number }>(
        { op: "las_columns", text: las.text, name: las.name, ...opts },
        ctx.signal
      ).catch((err: unknown) => {
        // Null means "this log has no readable columns", which three branches
        // treat as an empty result. A swallowed transport error looks identical
        // and is not — say which, or an outdated tool server reads as a log
        // with no curves in it.
        console.warn("geology:las-columns-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    },
    async header(ctx: ToolContext) {
      const las = await withLas(ctx);
      if (!las) return null;
      return post<Record<string, unknown>>(
        { op: "las_header", text: las.text, name: las.name },
        ctx.signal
      ).catch((err: unknown) => {
        console.warn("geology:las-header-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    },
  };
}

export function registerPythonTools(registry: ToolRegistry, readLas: ReadLas = loadText): number {
  const tools: GeologyTool<unknown, unknown>[] = [
    {
      name: TOOL.lasHeader,
      description:
        "The LAS file's ~WELL and ~PARAMETER sections: well name, API, operator, county, kelly bushing and ground elevations, surface location, and the logged depth range.",
      inputSchema: noArgs,
      outputSchema: headerSchema,
      readOnly: true,
      callableBy: ["harness", "gatherer", "fable"],
      async execute(_args: unknown, ctx: ToolContext) {
        const { text, name } = await lasText(readLas, ctx);
        const value = await post<unknown>({ op: "las_header", text, name }, ctx.signal);
        return {
          value,
          provenance: { tool: TOOL.lasHeader, inputs: { file: name }, method: "LAS 2.0 section parse" },
        };
      },
    },
    {
      name: TOOL.lasCurves,
      description:
        "Every curve in the LAS with its mnemonic, unit and description, and the number of data rows.",
      inputSchema: noArgs,
      outputSchema: curvesSchema,
      readOnly: true,
      callableBy: ["harness", "fable"],
      async execute(_args: unknown, ctx: ToolContext) {
        const { text, name } = await lasText(readLas, ctx);
        const value = await post<unknown>({ op: "las_curves", text, name }, ctx.signal);
        return {
          value,
          provenance: { tool: TOOL.lasCurves, inputs: { file: name }, method: "LAS 2.0 ~CURVE parse" },
        };
      },
    },
    {
      name: TOOL.mnemonicNormalize,
      description:
        "Map a raw curve mnemonic to its canonical name using the owned dictionary. Returns null when the mnemonic is not in the dictionary — an unknown mnemonic is flagged, never guessed.",
      inputSchema: z.object({ raw: z.string(), unit: z.string().nullable() }),
      outputSchema: mnemonicSchema,
      readOnly: true,
      callableBy: ["harness", "fable"],
      async execute(args: unknown, ctx: ToolContext) {
        const { raw, unit } = args as { raw: string; unit: string | null };
        const value = await post<unknown>(
          { op: "mnemonic_normalize", raw, unit },
          ctx.signal
        );
        return {
          value,
          provenance: {
            tool: TOOL.mnemonicNormalize,
            inputs: args,
            method: "owned mnemonic dictionary",
          },
        };
      },
    },
    {
      name: TOOL.petrophysics,
      description:
        "Run one petrophysics or reservoir-engineering calculation by name. The catalog in your instructions lists every tool, its required arguments and what it answers. " +
        "Each returns its inputs, its method and the reference its equation came from, or declines with a reason when the inputs do not support an answer. " +
        "If the arguments do not fit, the reply names the signature it expected — read it and call again.",
      inputSchema: dispatchSchema,
      outputSchema: z.unknown(),
      readOnly: true,
      // Fable's, not the gatherer's. The gatherer is handed tool NAMES and asked
      // to write `name key=value` lines, which is enough for a self-describing
      // lookup like `rrc_wells_near` and useless for a dispatcher whose first
      // argument is another tool's name out of a catalog it was never given.
      // Every gatherer call to this failed for exactly that reason.
      //
      // HARNESS ONLY now. Fable reaches these 153 calculations as registered
      // tools with generated schemas instead (`registerPetrophysicsTools`), so a
      // wrong argument name is refused by the provider before the call is made
      // rather than by Python afterwards. Leaving the free-form dispatcher in
      // Fable's reach would have kept an unenforced way to make exactly the call
      // the schemas exist to prevent. The harness keeps it because its branches
      // call by name from code, where there is nothing to constrain.
      callableBy: ["harness"],
      async execute(raw: unknown, ctx: ToolContext) {
        const { tool, args: toolArgs } = resolveDispatch(raw as DispatchArgs);
        // The log goes with the call when there is one, so a tool that works on
        // the parsed LAS gets it without the model having to pass a file it has
        // no handle on. Absent, the arithmetic tools still run on their numbers.
        let las: { text: string; name: string } | null = null;
        if (ctx.lasPath) {
          las = await lasText(readLas, ctx).catch(() => null);
        }
        const value = await post<{ tool: string; result: unknown }>(
          {
            op: "call",
            tool,
            args: toolArgs,
            ...(las ? { text: las.text, name: las.name } : {}),
          },
          ctx.signal
        );
        return {
          value: value.result,
          provenance: {
            tool,
            inputs: toolArgs,
            method: `deterministic tool layer: ${tool}`,
          },
        };
      },
    },
  ] as unknown as GeologyTool<unknown, unknown>[];

  let added = 0;
  for (const tool of tools) {
    if (registry.has(tool.name)) continue;
    registry.register(tool);
    added++;
  }
  return added;
}

/**
 * The catalog, registered one tool at a time, each with a real schema.
 *
 * This is the fix for a class of failure, not for two calls. Behind the
 * dispatcher `args` was a free-form record, so nothing stopped the model
 * emitting `matrices` for `matrix_candidates` or omitting a required
 * `lithology`; the first check was a 422 from Python, and the design assumed the
 * model would read the returned signature and call again. It does not reliably
 * do that — it gave up and wrote a caveat about the very number the tool
 * computes.
 *
 * Registered with schemas, the provider constrains decoding and neither mistake
 * can be expressed. See `catalog-schema.ts` for the measured cost.
 *
 * Execution is unchanged: the same `op: "call"` dispatch, the same LAS
 * attachment, the same provenance, so the ledger reads identically.
 */
export function registerPetrophysicsTools(
  registry: ToolRegistry,
  readLas: ReadLas = loadText
): number {
  let added = 0;
  for (const { name, description, inputSchema } of petrophysicsSchemas()) {
    // A calculation whose name collides with a first-class tool (`las_header`)
    // keeps the first-class one: that tool has hand-written provenance and a
    // narrower contract than the generated wrapper would.
    if (registry.has(name)) continue;
    registry.register({
      name,
      description,
      inputSchema,
      outputSchema: z.unknown(),
      readOnly: true,
      callableBy: ["fable"],
      async execute(args: unknown, ctx: ToolContext) {
        // The log rides along when there is one, exactly as the dispatcher does
        // it, so a tool that works on the parsed LAS gets it without the model
        // having to pass a file it has no handle on.
        let las: { text: string; name: string } | null = null;
        if (ctx.lasPath) las = await lasText(readLas, ctx).catch(() => null);
        const value = await post<{ tool: string; result: unknown }>(
          {
            op: "call",
            tool: name,
            args: args ?? {},
            ...(las ? { text: las.text, name: las.name } : {}),
          },
          ctx.signal
        );
        return {
          value: value.result,
          provenance: {
            tool: name,
            inputs: args,
            method: `deterministic tool layer: ${name}`,
          },
        };
      },
    } as unknown as GeologyTool<unknown, unknown>);
    added++;
  }
  return added;
}

export { PETROPHYSICS_CATALOG, catalogNames };
