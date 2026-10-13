/**
 * Orion's RRC tools, made callable from the geology harness.
 *
 * `rrcTools()` already exposes the Texas public record over the TigerCloud mirror
 * behind the scout page: every `rrc_*` tool it defines, counted at
 * registration rather than restated here so a new one is admitted by adding it
 * there and nothing else. They are AI SDK tools, and the
 * harness speaks `GeologyTool`, so this adapts one to the other rather than
 * reimplementing anything.
 *
 * This matters more here than anywhere else in Orion: surrounding production is
 * usually what turns a log reading into a conclusion. A porosity number says the
 * rock could hold oil; the producers within a mile completed in the same
 * interval say whether it does. And on the no-log path it is often the entire
 * answer. "Who else is drilling the Caddo in Wise County" is a public-record
 * question with no petrophysics in it at all.
 *
 * ## Why these are safe to admit
 *
 * The registry refuses any tool not declared read-only, and every `rrc_*` tool
 * is a query against a public-records mirror. They also carry their own
 * permission guard internally, so admitting them here does not widen what a user
 * can reach, only which agent can reach it.
 *
 * ## What is deliberately loose
 *
 * `outputSchema` is `unknown`. These tools return a different record shape each that already have their own types on the Orion side, and re-declaring
 * them here would be a second source of truth that drifts. The registry's output
 * validation exists to catch a tool returning the wrong shape; for these, the
 * shape is whatever the public record holds, and the harness passes it through
 * to the ledger verbatim.
 */
import { z } from "zod";
import { rrcTools } from "@/lib/ai/rrc-tools";
import { rrcAnalysisTool } from "@/lib/ai/rrc/dispatch";
import type { AgentRole, GeologyTool, ToolRegistry } from "./registry";

/** Both agents get the public record. The gatherer pulls it, Fable follows up. */
const CALLABLE_BY: readonly AgentRole[] = ["harness", "gatherer", "fable"];

/**
 * Tools admitted despite not being named `rrc_*`.
 *
 * The prefix test was doing double duty, marking both "reads the public record"
 * and "safe to admit", and these two failed it on the name alone. They are the
 * bridge between one of THIS company's wells and the state's record for it,
 * which is exactly what a geology question about a well we operate needs, and
 * Fable could not reach either of them.
 */
const ALSO_ADMITTED = new Set(["get_well_rrc_record", "get_lease_rrc_record"]);

function admitted(name: string): boolean {
  return name.startsWith("rrc_") || ALSO_ADMITTED.has(name);
}

interface AiSdkTool {
  description?: string;
  inputSchema: z.ZodType<unknown>;
  execute?: (args: never, options: never) => Promise<unknown>;
}

/**
 * Register every `rrc_*` tool.
 *
 * Returns the count so a caller can log what the harness can actually reach.
 * A registry that silently ends up with nothing is the failure mode worth
 * catching early.
 */
export function registerRrcTools(registry: ToolRegistry): number {
  // The getters and the analysis dispatcher. `rrc_analyze` is the one that
  // matters most here: correlation, offset statistics and decline over the
  // public record are arithmetic, and without it Fable would be reading numbers
  // off a dossier and doing that arithmetic in prose.
  const tools = {
    ...rrcTools(),
    ...rrcAnalysisTool(),
  } as unknown as Record<string, AiSdkTool>;
  let added = 0;

  for (const [name, tool] of Object.entries(tools)) {
    if (!admitted(name) || typeof tool.execute !== "function") continue;
    if (registry.has(name)) continue;

    const execute = tool.execute;
    const geology: GeologyTool<unknown, unknown> = {
      name,
      // The description is written for a model already; reuse it verbatim so
      // the gatherer and Fable see exactly what Orion sees.
      description: tool.description ?? `Texas RRC public record: ${name}`,
      inputSchema: tool.inputSchema,
      outputSchema: z.unknown(),
      readOnly: true,
      callableBy: CALLABLE_BY,
      async execute(args) {
        // The AI SDK hands tools a second options argument (tool call id,
        // messages). The RRC tools do not read it, and fabricating a plausible
        // one would be inventing state, an empty object is the honest shape.
        const value = await execute(args as never, {} as never);
        return {
          value,
          provenance: {
            tool: name,
            inputs: args,
            method: "Texas Railroad Commission public record",
          },
        };
      },
    };

    registry.register(geology);
    added++;
  }
  return added;
}
