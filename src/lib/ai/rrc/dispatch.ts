import { tool } from "ai";
import { z } from "zod";

import { assertSignedIn } from "@/lib/auth/session";
import { hasRrcDb } from "@/lib/scout/rrc-db";
import { findRrcTool, RRC_CATALOG, rrcToolNames } from "./registry";
import { coerceEnumArgs, declaredArgs, normalizeToolArgs } from "@/lib/ai/tool-args";
import { signature } from "./tool";

/**
 * `rrc_analyze`, the one registered tool behind the whole analysis catalog.
 *
 * The `rrc_*` tools already in `src/lib/ai/rrc-tools.ts` are getters: they fetch
 * a dossier and slim it for reading aloud. This is the other half, the
 * arithmetic. Decline fits, percentiles, reconciliations, spacing statistics and
 * survival curves are all things the model was previously doing by eye over
 * twenty slimmed rows, differently every time.
 *
 * ## Why one tool and not a hundred
 *
 * Registering every analysis with its own schema would put tens of thousands of
 * tokens of arguments in front of the model on every turn, nearly all of it
 * irrelevant to any one question. The catalog costs a fraction of that, and a
 * call with the wrong arguments comes back naming the signature it expected. One
 * wrong call is cheaper than the schemas, every turn, forever.
 *
 * ## The name matters
 *
 * `rrc_analyze` starts with `rrc_`, which is what lets the geology harness admit
 * it through `rrc-bridge.ts`. A different name would leave Fable unable to reach
 * any of this, silently.
 */
export function rrcAnalysisTool() {
  return {
    rrc_analyze: tool({
      description:
        "Run a DETERMINISTIC analysis over the Texas RRC public record: decline fits, EUR, type curves, percentile ranks, allocation, spacing, reconciliation, survival curves, screening. Use this instead of reasoning over numbers yourself whenever a question needs arithmetic across more than a handful of rows. The `fn` argument names one analysis from the catalog in your system prompt and `args` carries its arguments; a wrong call comes back with the signature it expected, so guessing once is cheap. These read the public record only, never this company's own data.",
      inputSchema: z.object({
        fn: z.string().describe("analysis name, from the RRC analysis catalog"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("arguments for that analysis"),
      }),
      execute: async ({ fn, args }) => runRrcAnalysis(fn, args ?? {}),
    }),
  };
}

/**
 * Look up, validate, run.
 *
 * Every failure here is a VALUE, not a throw: an unknown name, bad arguments and
 * an unconfigured mirror are all things the model can act on, and an exception
 * would just become "a tool failed" in an operator's answer.
 */
export async function runRrcAnalysis(
  fn: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // These read Texas public record over a service-role connection that bypasses
  // RLS, so the check protects the CREDENTIAL. There is nothing here to hide
  // from one signed-in member versus another.
  await assertSignedIn();

  const found = findRrcTool(fn);
  if (!found) {
    return {
      ok: false,
      error: `No analysis called "${fn}".`,
      available: rrcToolNames(),
    };
  }

  if (!hasRrcDb()) {
    return {
      ok: false,
      error:
        "The Texas RRC mirror is not configured in this environment (RRC_DATABASE_URL is unset). Tell the user the public-records analysis is unavailable here; the company's own data tools still work.",
    };
  }

  // Same vocabulary as every other tool call; see `@/lib/ai/tool-args`.
  const parsed = found.args.safeParse(
    coerceEnumArgs(found.args, normalizeToolArgs(args, declaredArgs(found.args)))
  );
  if (!parsed.success) {
    return {
      ok: false,
      error: `Wrong arguments for ${fn}.`,
      expected: signature(found),
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  return found.run(parsed.data as never);
}

/** The catalog block for the system prompt. Re-exported so callers need one import. */
export { RRC_CATALOG };
