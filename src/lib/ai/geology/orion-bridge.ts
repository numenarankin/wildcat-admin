/**
 * Orion's own read-only tools, made callable from the geology harness.
 *
 * An interpretation frequently turns on the operator's own data rather than the
 * public record: what this lease actually produced, what is in the well file,
 * what the last run ticket said. Orion has 124 tools over exactly that, and the
 * geology path had none of them.
 *
 * ## Read-only is decided here, not trusted
 *
 * The geology path never writes. Orion's write tools are marked
 * `needsApproval: true` — that is the property this filters on, and anything
 * carrying it is refused admission rather than registered and hoped about. The
 * registry then refuses anything not declared read-only, so a write tool would
 * have to defeat two independent checks to get through.
 *
 * A tool with no `execute` is also skipped: provider-executed tools (web search)
 * cannot be called through this path.
 */
import { z } from "zod";
import { orionTools } from "@/lib/ai/tools";
import type { AgentRole, GeologyTool, ToolRegistry } from "./registry";

/**
 * Fable only.
 *
 * The gatherer's job is assembling context from the corpus and the public
 * record; handing it 100 more tools would widen its search space without making
 * the hand-off better, and every extra tool is more of the model's attention
 * spent choosing. Fable reaches for these when the interpretation needs them.
 */
const CALLABLE_BY: readonly AgentRole[] = ["fable"];

interface AiSdkTool {
  description?: string;
  inputSchema?: z.ZodType<unknown>;
  needsApproval?: unknown;
  execute?: (args: never, options: never) => Promise<unknown>;
}

export interface OrionBridgeReport {
  registered: number;
  /** Names refused because they mutate. Logged, so the filter is auditable. */
  skippedWrites: string[];
}

export function registerOrionTools(registry: ToolRegistry): OrionBridgeReport {
  const tools = orionTools() as unknown as Record<string, AiSdkTool>;
  const skippedWrites: string[] = [];
  let registered = 0;

  for (const [name, tool] of Object.entries(tools)) {
    if (typeof tool.execute !== "function" || !tool.inputSchema) continue;
    // Already bridged directly, with its own provenance wording.
    if (name.startsWith("rrc_")) continue;
    /*
     * Orion's corpus reader, deliberately NOT bridged.
     *
     * On this path the gatherer owns corpus access: it selects passages, records
     * each as evidence in the ledger, and the brief renders them under one set
     * of citation rules. A second reader Fable could call directly would return
     * text that never entered the ledger, so the trace would say the answer used
     * fewer sources than it did. The tools exist for the path that has no
     * gatherer, which is exactly the path Fable is not on.
     */
    if (name.startsWith("geology_kb_")) continue;
    if (tool.needsApproval) {
      skippedWrites.push(name);
      continue;
    }
    if (registry.has(name)) continue;

    const execute = tool.execute;
    const geology: GeologyTool<unknown, unknown> = {
      name,
      description: tool.description ?? name,
      inputSchema: tool.inputSchema,
      // These return the operator's own records in a hundred shapes that
      // already have types on the Orion side. Re-declaring them here would be a
      // second source of truth that drifts.
      outputSchema: z.unknown(),
      readOnly: true,
      callableBy: CALLABLE_BY,
      async execute(args) {
        const value = await execute(args as never, {} as never);
        return {
          value,
          provenance: { tool: name, inputs: args, method: "the operator's own records" },
        };
      },
    };
    registry.register(geology);
    registered++;
  }

  return { registered, skippedWrites };
}
