/**
 * The single path from the harness to a tool.
 *
 * Every call — the fan-out's fixed branches, the gatherer's own requests, and
 * later Fable's — goes through here, so `toolCalls[]` is complete by
 * construction rather than by everyone remembering to append to it. That
 * completeness is load-bearing twice over:
 *
 *   - Fable is handed exactly what ran and what came back, and is expected to
 *     show its work. A number it cannot trace to one of these entries is a
 *     number it should not have written.
 *   - A failed call is recorded as a failed call. A tool that threw and left no
 *     trace looks identical to a tool that was never needed.
 */
import type { AgentRole, ToolContext, ToolRegistry, ToolResult } from "./registry";
import type { Origin, ZoneEvaluationStore } from "./state";

export interface CallDeps {
  store: ZoneEvaluationStore;
  registry: ToolRegistry;
  ctx: ToolContext;
}

/** Who asked. Mirrors `AgentRole`, minus roles that cannot originate a call. */
type Requester = "harness" | "gatherer" | "fable";

export async function callTool<R>(
  deps: CallDeps,
  origin: Origin,
  name: string,
  args: unknown,
  role: Requester = "harness"
): Promise<ToolResult<R>> {
  const { store, registry, ctx } = deps;
  try {
    const result = await registry.call<R>(name, args, ctx, role as AgentRole);
    store.addToolCall(origin, {
      tool: name,
      args,
      method: result.provenance.method,
      ok: true,
      output: result.value,
      refused: result.refused
        ? { gate: result.refused.gate, reason: result.refused.reason, remedy: result.refused.remedy }
        : null,
      requestedBy: role,
      error: null,
    });
    // A gate refusing is data the answer must respond to, so it is recorded
    // separately from the call that carried it.
    if (result.refused) {
      store.addRefusal(origin, {
        gate: result.refused.gate,
        tool: name,
        reason: result.refused.reason,
        remedy: result.refused.remedy,
      });
    }
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    store.addToolCall(origin, {
      tool: name,
      args,
      method: "(call failed)",
      ok: false,
      output: null,
      refused: null,
      requestedBy: role,
      error: message,
    });
    throw err;
  }
}
