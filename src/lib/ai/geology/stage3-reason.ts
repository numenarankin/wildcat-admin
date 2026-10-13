/**
 * Stage 3 — Reason, and Stage 4 — Render.
 *
 * See well-log-agent.md. One Fable conversation at high effort, with tools, and
 * one streaming prose answer with nothing in front of it: the question was asked
 * in prose and is answered in prose. Stage 4 has no work of its own left — the
 * gates moved into the tools — so all it does is not get in the way of the
 * stream.
 *
 * Tool round-trips happen inside the turn, so "one turn" is one conversation
 * rather than one API call.
 *
 * ## What used to be here
 *
 * An escalated path: a Sonnet conflict stage that routed contradictory wells to
 * three personas and an arbiter. It was cut. Measured on a real turn it cost 14s
 * for the routing decision and ~75s to first token for the persona fan-out, on
 * a design whose whole latency problem is that nothing is emitted until the
 * model returns. Contradictions are still found — arithmetically in Stage 0/1,
 * and by the gatherer noting them as it hands off — they simply reach Fable as
 * part of the brief instead of as a second reasoning topology.
 */
import { smoothStream, streamText, stepCountIs, type StreamTextResult, type Tool, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { geologyTools } from "./ai-tools";
import { FABLE_SYSTEM } from "./fable-prompt";
import type { CallDeps } from "./call-tool";
import type { ToolRegistry } from "./registry";
import type { ZoneEvaluationStore } from "./state";

export const FABLE_MODEL = "claude-fable-5";
/**
 * Twelve, not Orion's ten: a geology turn has more tools and a real reason to
 * iterate. This is a runaway guard, not a budget meant to bind.
 */
export const MAX_STEPS = 12;
/** See the note at the call site. Raise only with a latency measurement in hand. */
export const FABLE_EFFORT = "medium";

export interface Stage3Input {
  /** The rendered context brief. */
  brief: string;
  /** Prior turns of this conversation. */
  history?: ModelMessage[];
  /**
   * Appended to Fable's system prompt. The caller's delivery contract, not the
   * reasoning contract: voice needs the answer spoken rather than formatted, and
   * this stage builds its own `streamText`, so nothing the route layers onto its
   * own call reaches here. Empty on the typed path.
   */
  styleSuffix?: string;
}

/**
 * The model side of Stage 3, behind an interface.
 *
 * Same seam as the gatherer: judgment on one side, mechanism on the other. It
 * also makes the stage testable — `streamText` is lazy, so a test that only
 * inspected the returned stream would pass without any model call.
 */
export interface ReasoningModel {
  answer(
    system: string,
    messages: ModelMessage[],
    tools: Record<string, Tool>
  ): StreamTextResult<Record<string, Tool>, never>;
}

export interface Stage3Deps {
  store: ZoneEvaluationStore;
  registry: ToolRegistry;
  ctx: CallDeps["ctx"];
  model?: ReasoningModel;
}

export interface Stage3Result {
  stream: StreamTextResult<Record<string, Tool>, never>;
}

export function reason(input: Stage3Input, deps: Stage3Deps): Stage3Result {
  const call: CallDeps = { store: deps.store, registry: deps.registry, ctx: deps.ctx };
  const tools = geologyTools(deps.registry, call, "fable");
  const model = deps.model ?? fableReasoningModel();

  return {
    stream: model.answer(FABLE_SYSTEM + (input.styleSuffix ?? ""), [
      ...(input.history ?? []),
      { role: "user", content: input.brief },
    ], tools),
  };
}

/** The live implementation. The only part of Stage 3 that talks to the API. */
export function fableReasoningModel(): ReasoningModel {
  return {
    answer(system, messages, tools) {
      return streamText({
        model: anthropic(FABLE_MODEL),
        system,
        messages,
        tools,
        /*
         * `medium`, not `high`.
         *
         * At `high` a well turn measured 130-240 seconds to first token, most of
         * it thinking before a word appeared, against a 300-second ceiling on the
         * route. The reasoning this stage does is mostly reading an assembled
         * brief and calling for the numbers it still needs — the deterministic
         * layer does the arithmetic — so the depth was buying latency more than
         * quality.
         */
        providerOptions: { anthropic: { effort: FABLE_EFFORT, cacheControl: { type: "ephemeral" } } },
        stopWhen: stepCountIs(MAX_STEPS),
        /*
         * The same smoothing Orion's own stream uses, and for the same reason.
         *
         * This path builds its own `streamText` rather than going through the
         * chat route's, which means every option the route sets has to be set
         * again here — and this one was missed. Without it the model's raw
         * chunks go straight to the browser, so a long answer lands in a few
         * large blocks instead of gliding in, and a geology turn visibly reads
         * as a different product from every other turn.
         *
         * Keep in step with the route's copy; if they drift again, the tell is
         * exactly this — geology answers that pop rather than stream.
         */
        experimental_transform: smoothStream({
          delayInMs: 12,
          chunking: (buffer) => {
            if (buffer.length === 0) return null;
            const n = buffer.length > 80 ? 5 : buffer.length > 24 ? 2 : 1;
            return buffer.slice(0, n);
          },
        }),
      });
    },
  };
}
