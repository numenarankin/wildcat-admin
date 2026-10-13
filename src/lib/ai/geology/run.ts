/**
 * The geology turn, end to end.
 *
 * Stage 0 resolve -> Stage 1 fan out -> Stage 3 reason.
 * One entry point, called by the chat route when the router labels a turn
 * `geology`.
 *
 * ## The one ordering decision that matters
 *
 * Stage 0 hands back two promises. Stage 1 waits on `header` — location and
 * elevation, which its RRC branches need — and NOT on `done`, so the curve
 * math finishes alongside the offset queries instead of in front of them. That
 * is the whole reason Stage 0 is shaped the way it is.
 *
 * ## Nothing here can end the turn
 *
 * A failed branch, a lost prerequisite, a conflict detector that times out —
 * each degrades the answer and none cancels it. The only hard failure is Stage 0
 * itself: with no parsed log there is no well to talk about.
 */
import { renderBrief } from "./brief";
import type { Corpus } from "./corpus";
import type { EvaluationCache, CacheStamps } from "./cache";
import type { GathererModel } from "./gatherer";
import type { ToolRegistry } from "./registry";
import type { ModelMessage } from "ai";
import { resolveStage0 } from "./stage0-resolve";
import { fanOut } from "./stage1-fanout";
import { reason, type ReasoningModel, type Stage3Result } from "./stage3-reason";
import type { ZoneEvaluation, ZoneEvaluationStore } from "./state";

export interface GeologyTurnInput {
  /** The operator's question, in their words. */
  prompt: string;
  api: string;
  lasPath: string;
  stamps: CacheStamps;
  history?: ModelMessage[];
  radiusFt?: number;
  /** Delivery contract for Stage 3. See `Stage3Input.styleSuffix`. */
  styleSuffix?: string;
}

export interface GeologyTurnDeps {
  registry: ToolRegistry;
  cache: EvaluationCache;
  corpus: Corpus;
  gatherer: GathererModel;
  /** Defaults to the live Fable implementation. */
  reasoning?: ReasoningModel;
  now?: () => number;
}

export interface GeologyTurn {
  result: Stage3Result;
  store: ZoneEvaluationStore;
  state: ZoneEvaluation;
  brief: string;
  /** Wall clock per stage, for the latency budget this design has to fit. */
  timing: { stage0: number; stage1: number; total: number };
  trace: {
    cacheHit: boolean;
    missReason: string | null;
    failedBranches: string[];
    subQuestions: string[];
    chunks: number;
    /** Corpus segments whose primary text was actually read. */
    sources: string[];
    /** Gatherer hops that failed. Empty on a healthy turn. */
    gatherErrors: string[];
    implausible: number;
    missingRequirements: string[];
    conflicts: number;
    conflictNoteError: string | null;
  };
}

/** Everything the well path produces before Fable is handed the brief. */
export type GeologyTurnContext = Omit<GeologyTurn, "result">;

/**
 * Stages 0 and 1, without Stage 3.
 *
 * Split out for the same reason the question path was: a turn can need the log
 * evaluated WITHOUT the geology agent answering it. "What plays are other
 * operators making like my Repass 2" needs this log read, the company's own
 * records, and the Texas public record all at once, and only Opus can hold all
 * three — so the caller takes the brief and never builds the stream.
 *
 * Everything expensive is here, which is the point. Stage 0 is the curve math
 * and Stage 1 is the fan-out; Stage 3 is one model call over what they produced.
 */
export async function gatherGeologyTurn(
  input: GeologyTurnInput,
  deps: GeologyTurnDeps
): Promise<GeologyTurnContext> {
  const now = deps.now ?? Date.now;
  const started = now();

  // Stage 0. The only stage that can end the turn: no parsed log, no well.
  const stage0 = resolveStage0(
    { api: input.api, lasPath: input.lasPath, stamps: input.stamps },
    { registry: deps.registry, cache: deps.cache, now: deps.now }
  );
  // If the header read fails we bail before ever awaiting `done`, so it needs a
  // handler of its own or the same failure surfaces twice — once as the thrown
  // error and once as an unhandled rejection.
  stage0.done.catch(() => {});

  const [header, store] = await Promise.all([stage0.header, stage0.store]);
  const t0 = now();

  // Stage 1 starts on the header, while Stage 0's curve math is still running.
  const [resolved, fan] = await Promise.all([
    stage0.done,
    fanOut(
      store,
      { prompt: input.prompt, header, radiusFt: input.radiusFt },
      {
        registry: deps.registry,
        corpus: deps.corpus,
        model: deps.gatherer,
        ctx: { api: input.api, lasPath: input.lasPath },
        now: deps.now,
      }
    ),
  ]);
  const t1 = now();

  const brief = renderBrief({
    prompt: input.prompt,
    state: resolved.store.snapshot(),
    gathered: fan.gathered,
    failedBranches: fan.failed,
    requirements: fan.requirements,
  });

  return {
    store: resolved.store,
    state: resolved.store.snapshot(),
    brief,
    timing: { stage0: t0 - started, stage1: t1 - t0, total: now() - started },
    trace: {
      cacheHit: resolved.cacheHit,
      missReason: resolved.missReason,
      failedBranches: fan.failed,
      subQuestions: fan.gathered?.subQuestions ?? [],
      chunks: fan.gathered?.chunks.length ?? 0,
      sources: fan.gathered?.sources ?? [],
      gatherErrors: fan.gathered?.errors ?? [],
      implausible: fan.implausible.length,
      missingRequirements: fan.requirements.missing.map((m) => m.label),
      conflicts: fan.notes.conflicts.length,
      conflictNoteError: fan.notes.error,
    },
  };
}

/**
 * The whole well turn: evaluate the log, then Fable answers from the brief.
 *
 * `timing.total` is re-stamped so it covers building the stream too, which is
 * what it measured before the split.
 */
export async function runGeologyTurn(
  input: GeologyTurnInput,
  deps: GeologyTurnDeps
): Promise<GeologyTurn> {
  const now = deps.now ?? Date.now;
  const started = now();
  const context = await gatherGeologyTurn(input, deps);

  const result = reason(
    { brief: context.brief, history: input.history, styleSuffix: input.styleSuffix },
    {
      store: context.store,
      registry: deps.registry,
      ctx: { api: input.api, lasPath: input.lasPath },
      model: deps.reasoning,
    }
  );

  return {
    ...context,
    result,
    timing: { ...context.timing, total: now() - started },
  };
}
