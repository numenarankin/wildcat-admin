/**
 * The live tool registry for the geology path.
 *
 * Three sources, all inside this repository:
 *
 * - **RRC** — `rrcTools()`, the Texas public record over the TigerCloud mirror
 *   behind the scout page. Fifteen tools, reachable by both agents.
 * - **Petrophysics** — `api/geology.py`, a Python function of this deployment.
 *   Three tools carry the Stage 0 contract; the fourth reaches the other 113 by
 *   name against the catalog in Fable's prompt.
 * - **Orion** — the operator's own records. Read-only tools only; the write
 *   tools are refused admission and the registry would refuse them again.
 */
import { ToolRegistry } from "./registry";
import { registerRrcTools } from "./rrc-bridge";
import { registerOrionTools } from "./orion-bridge";
import { pythonBridge, registerPetrophysicsTools, registerPythonTools } from "./python-tools";
import { registerContractTools } from "./contract-tools";
import { rrcTools } from "@/lib/ai/rrc-tools";

let registry: ToolRegistry | null = null;

export function geologyRegistry(): ToolRegistry {
  if (registry) return registry;
  registry = new ToolRegistry();
  registerRrcTools(registry);
  const python = registerPythonTools(registry);
  const orion = registerOrionTools(registry);
  // The six aggregate branches Stage 0 and Stage 1 call on every well turn.
  // Registered last so they compose the tools above rather than racing them.
  const bridge = pythonBridge();
  const contracts = registerContractTools(registry, {
    ...bridge,
    header: async (ctx) => (await bridge.header(ctx)) as never,
    async rrc(tool, args, ctx) {
      const set = rrcTools() as unknown as Record<string, { execute?: (a: never, o: never) => Promise<unknown> }>;
      const fn = set[tool]?.execute;
      if (!fn) return null;
      void ctx;
      return fn(args as never, {} as never);
    },
  });
  /*
   * LAST, deliberately.
   *
   * The generated wrappers stand aside for any name already taken, so this has
   * to run after every hand-written tool or it steals theirs. It did: registered
   * before the contracts, it claimed `kb_lookup` and `hole_quality` — which
   * exist in the Python catalog AND as harness contract branches — with
   * `callableBy: ["fable"]`, and Stage 0 lost both. The trace showed them as
   * `unavailable` to the harness and `contracts` fell from 7 to 5.
   */
  const petrophysics = registerPetrophysicsTools(registry);

  console.info("geology:registry", {
    total: registry.size,
    python,
    petrophysics,
    orionReadOnly: orion.registered,
    orionWritesRefused: orion.skippedWrites.length,
    contracts,
  });
  return registry;
}

/** Tests and scripts swap the whole registry rather than reaching inside it. */
export function setGeologyRegistry(next: ToolRegistry | null): void {
  registry = next;
}
