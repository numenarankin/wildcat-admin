/**
 * The tool boundary for the geology path.
 *
 * See geology-agent/harness-implementation.md §2. The 114-tool catalog is built
 * separately; this module is the entire contract the harness knows about, so the
 * stages can be built and tested before any tool exists and the real registry
 * can be swapped in without touching a stage.
 *
 * Three rules live here rather than in any tool:
 *
 *   1. Every tool is READ-ONLY. The geology path analyzes; it never writes. The
 *      registry refuses to admit a tool that does not declare itself read-only,
 *      so "Fable cannot write" is a property of what exists rather than of what
 *      the model was told, and there is nothing for Orion's approval gate to
 *      guard.
 *   2. A REFUSAL IS A VALUE. The four gates now live inside the tools that
 *      produce each gated quantity, so a gate firing has to come back as data
 *      the model can respond to mid-turn — ask for the W-2, offer a range, say
 *      what is unresolved. Throwing would end the turn instead of informing it.
 *   3. `callableBy` decides who may call it. The gatherer gets a narrower set
 *      than Fable; the harness calls Stage 0's tools itself.
 */
import { z } from "zod";

/** The four gates from well-log-agent.md, now enforced inside tools. */
export const GATE_NAMES = [
  "structural-datum",
  "sw-rw-provenance",
  "porosity-washout",
  "completion-numbers",
] as const;
export type GateName = (typeof GATE_NAMES)[number];

/** Who is making the call. */
export type AgentRole = "harness" | "gatherer" | "fable";

export interface ToolContext {
  /** Subject well. Every tool call is scoped to one. */
  api: string;
  /** Path to the LAS on disk, when the call needs it. */
  lasPath?: string;
  signal?: AbortSignal;
}

/** Why a number is trustworthy. Carried into `computed[]` verbatim. */
export interface ToolProvenance {
  tool: string;
  inputs: unknown;
  method: string;
}

export interface ToolRefusal {
  gate: GateName;
  reason: string;
  /** What would unblock it. Always actionable: "pull the W-2 for 42-497-…". */
  remedy: string;
}

export interface ToolResult<R = unknown> {
  value: R;
  provenance: ToolProvenance;
  /** Set when a gate refused. `value` then carries a range or a null result. */
  refused?: ToolRefusal;
}

export interface GeologyTool<A = unknown, R = unknown> {
  name: string;
  /** Goes verbatim into the model's tool schema. Write it for the model. */
  description: string;
  inputSchema: z.ZodType<A>;
  outputSchema: z.ZodType<R>;
  /** Literal `true`. A tool that mutates cannot satisfy this type. */
  readOnly: true;
  callableBy: readonly AgentRole[];
  /** Set when this tool enforces one of the four gates. */
  gate?: GateName;
  execute(args: A, ctx: ToolContext): Promise<ToolResult<R>>;
}

/** Type-erased shape the registry stores. */
type RegisteredTool = Omit<GeologyTool<unknown, unknown>, "inputSchema" | "outputSchema"> & {
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;
};

export class ToolNotFoundError extends Error {
  constructor(name: string, role: AgentRole) {
    super(`no tool "${name}" available to ${role}`);
    this.name = "ToolNotFoundError";
  }
}

/** The tool's own contract was violated — its schema, not its subject matter. */
export class ToolContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolContractError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register<A, R>(tool: GeologyTool<A, R>): this {
    if (tool.readOnly !== true) {
      throw new ToolContractError(
        `tool "${tool.name}" is not declared read-only; the geology path admits no tool that mutates`
      );
    }
    if (tool.callableBy.length === 0) {
      throw new ToolContractError(`tool "${tool.name}" is callable by nobody`);
    }
    if (this.tools.has(tool.name)) {
      throw new ToolContractError(`tool "${tool.name}" is already registered`);
    }
    // The one cast in the module. Erasing the generics is safe because `call`
    // re-validates both directions against the tool's own schemas.
    this.tools.set(tool.name, tool as unknown as RegisteredTool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Zero means the tool layer has not landed yet — a correct state, not a bug. */
  get size(): number {
    return this.tools.size;
  }

  /** The subset one agent may call. This is what becomes its tool schema list. */
  listFor(role: AgentRole): RegisteredTool[] {
    return [...this.tools.values()].filter((t) => t.callableBy.includes(role));
  }

  /**
   * Call a tool. Validates the arguments going in and the result coming back.
   *
   * Output validation is not paranoia about our own code: it is what stops a
   * malformed tool result becoming a number in the answer. A tool that returns
   * the wrong shape is a bug we want loud, at the boundary, naming the tool.
   */
  async call<R = unknown>(
    name: string,
    args: unknown,
    ctx: ToolContext,
    role: AgentRole = "harness"
  ): Promise<ToolResult<R>> {
    const tool = this.tools.get(name);
    if (!tool || !tool.callableBy.includes(role)) throw new ToolNotFoundError(name, role);

    const parsedArgs = tool.inputSchema.safeParse(args);
    if (!parsedArgs.success) {
      throw new ToolContractError(`"${name}" arguments rejected — ${issues(parsedArgs.error)}`);
    }

    const result = await tool.execute(parsedArgs.data, ctx);
    const parsedOut = tool.outputSchema.safeParse(result.value);
    if (!parsedOut.success) {
      throw new ToolContractError(`"${name}" returned an invalid result — ${issues(parsedOut.error)}`);
    }
    if (result.refused && !result.refused.remedy) {
      throw new ToolContractError(`"${name}" refused without a remedy; a gate must say what would unblock it`);
    }
    if (!result.provenance?.method) {
      throw new ToolContractError(`"${name}" returned no provenance method`);
    }

    return { ...result, value: parsedOut.data as R };
  }
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
