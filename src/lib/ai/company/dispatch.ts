import { tool } from "ai";
import { z } from "zod";

import { signature } from "@/lib/ai/catalog-tool";
import { coerceEnumArgs, declaredArgs, normalizeToolArgs } from "@/lib/ai/tool-args";
import { assertSignedIn } from "@/lib/auth/session";
import { COMPANY_CATALOG, companyToolNames, findCompanyTool } from "./registry";

/**
 * `company_analyze`, the one registered tool behind the company analysis catalog.
 *
 * The ontology tools resolve, traverse and measure. This is the arithmetic over
 * what they return: rankings, percentiles, fitted trends, concentration. The
 * alternative is the model eyeballing a list of forty wells and producing a
 * slightly different order every time it is asked, with nobody able to tell
 * which run was wrong.
 *
 * One tool rather than a schema each, for the same reason `rrc_analyze` is one
 * tool: registering the catalog would put tens of thousands of tokens of
 * argument shapes in front of the model on every turn, nearly all of it
 * irrelevant to the question asked. A wrong call comes back naming the signature
 * it expected, which is cheaper than the schemas, every turn.
 *
 * These read the COMPANY's own records through RLS as the signed-in user, which
 * is what separates them from `rrc_analyze` and its public-record mirror. The
 * two must never be averaged together.
 */
export function companyAnalysisTool() {
  return {
    company_analyze: tool({
      description:
        "Run a DETERMINISTIC analysis over THIS COMPANY'S own production records: rank a cohort by a metric, compare one entity against its peers, fit a trend, or measure concentration. Use this instead of reasoning over numbers yourself whenever a question spans more than a couple of entities or needs a ranking, a percentile or a direction. The `fn` argument names one analysis from the company analysis catalog in your system prompt and `args` carries its arguments; a wrong call comes back with the signature it expected, so guessing once is cheap. Everything reads the same production engines as the app's own pages, so results cannot disagree with what the user sees. This is the company's data, never the Texas public record.",
      inputSchema: z.object({
        fn: z.string().describe("analysis name, from the company analysis catalog"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("arguments for that analysis"),
      }),
      execute: async ({ fn, args }) => runCompanyAnalysis(fn, args ?? {}),
    }),
  };
}

/**
 * Look up, validate, run.
 *
 * Every failure is a VALUE, not a throw: an unknown name and bad arguments are
 * both things the model can act on mid-turn, and an exception would reach the
 * operator as "a tool failed" with nothing to do about it.
 */
export async function runCompanyAnalysis(
  fn: string,
  args: Record<string, unknown>
): Promise<unknown> {
  await assertSignedIn();

  const found = findCompanyTool(fn);
  if (!found) {
    return {
      ok: false,
      error: `No analysis called "${fn}".`,
      available: companyToolNames(),
    };
  }

  const parsed = found.args.safeParse(
    coerceEnumArgs(found.args, normalizeToolArgs(args, declaredArgs(found.args)))
  );
  if (!parsed.success) {
    return {
      ok: false,
      error: `Wrong arguments for ${fn}.`,
      expected: signature(found),
      problems: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      ),
    };
  }

  return found.run(parsed.data as never);
}

export { COMPANY_CATALOG };
