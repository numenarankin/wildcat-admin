/**
 * The no-log geology path.
 *
 * Most of what the reference library knows is not about one well. "Why does the
 * neutron read high in gas", "which Vsh transform suits a Pennsylvanian
 * carbonate", "how do I pick Rw without a water sample" — those are the
 * questions a 66-document petrophysics corpus exists to answer, and they arrive
 * with no LAS attached. Without this path they would fall through to Orion,
 * which has no corpus at all.
 *
 * ## What it is not
 *
 * It is not the well harness with the well parts skipped. There is no Stage 0,
 * no automatic fan-out, no requirements ledger, no plausibility check — every
 * one of those is about a specific log, and running them over nothing produces
 * an empty section that reads as a gap.
 *
 * What remains is the part that generalizes: the gatherer navigating the TOC to
 * the primary text, and Fable reasoning from it under the same contract.
 *
 * ## The gatherer chooses the lookups
 *
 * The well path fires a fixed set of branches because a well always has
 * offsets, a datum and curve math worth having. A question has no such floor —
 * "what is the Archie exponent for a vuggy carbonate" needs nothing but the
 * corpus, while "who else is drilling the Caddo in Wise County" is entirely a
 * public-record lookup. So nothing fires automatically and the gatherer decides,
 * per sub-question, from the tools it can reach.
 */
import { renderBrief } from "./brief";
import type { Corpus } from "./corpus";
import { gather, type GatherResult, type GathererModel } from "./gatherer";
import { fableQuestionSystem } from "./fable-prompt";
import { geologyTools } from "./ai-tools";
import type { CallDeps } from "./call-tool";
import type { ToolRegistry } from "./registry";
import { createZoneEvaluation, type ZoneEvaluation, type ZoneEvaluationStore } from "./state";
import { fableReasoningModel, type ReasoningModel, type Stage3Result } from "./stage3-reason";
import type { ModelMessage } from "ai";

/**
 * The identity a question is keyed on.
 *
 * The state object exists here only to carry the tool ledger and the retrieved
 * passages — the same machinery the brief renders from — so it needs an API it
 * will never use. `question` is that placeholder, and the brief's question mode
 * suppresses the well block so it is never shown.
 */
const NO_WELL = "question";

export interface GeologyQuestionInput {
  prompt: string;
  history?: ModelMessage[];
  /** Delivery contract for Stage 3. See `Stage3Input.styleSuffix`. */
  styleSuffix?: string;
  /**
   * Logs in the library that nothing pinned to this turn.
   *
   * Empty means there are none, which is the only case in which this path may
   * say there is no log. See `fableQuestionSystem`.
   */
  candidates?: readonly { id: string; name: string }[];
  /**
   * A log that IS in scope, on a turn this path is running anyway.
   *
   * The well path degrading here is the case: the subject resolved, Stage 0 then
   * failed (a dead tool server, a timeout), and the fall-back used to drop the
   * fileId on the floor. `las_header` and every other LAS tool then refused with
   * "no LAS file in scope for this turn" on a turn where the log was known and
   * readable — so the gatherer's first three sub-questions, which are always
   * about the log, all came back empty.
   */
  lasPath?: string;
}

export interface GeologyQuestionDeps {
  corpus: Corpus;
  gatherer: GathererModel;
  registry: ToolRegistry;
  reasoning?: ReasoningModel;
  now?: () => number;
}

export interface GeologyQuestion {
  result: Stage3Result;
  /**
   * The ledger, live.
   *
   * Kept alongside the snapshot because Fable's own tool calls land in it while
   * the answer streams — a snapshot taken here would be missing every one of
   * them.
   */
  store: ZoneEvaluationStore;
  state: ZoneEvaluation;
  brief: string;
  gathered: GatherResult;
  timing: { gather: number; total: number };
  trace: {
    subQuestions: string[];
    chunks: number;
    sources: string[];
    toolCalls: number;
    droppedCitations: number;
    failedLookups: number;
  };
}

/** Everything the question path produces before Fable is handed the brief. */
export type GeologyQuestionContext = Omit<GeologyQuestion, "result">;

/**
 * The gather half, on its own.
 *
 * Split out because a turn can need the corpus WITHOUT the corpus answering it.
 * "Analyze the geology of another operator's play" needs this brief and the
 * public record together, and only Opus can hold both — so the caller takes the
 * brief and never builds the stream. Nothing here knows which case it is in.
 */
export async function gatherGeologyQuestion(
  input: GeologyQuestionInput,
  deps: GeologyQuestionDeps
): Promise<GeologyQuestionContext> {
  const now = deps.now ?? Date.now;
  const started = now();

  const store = createZoneEvaluation({
    api: NO_WELL, name: null, operator: null, county: null, district: null,
  });
  const ctx = { api: NO_WELL, ...(input.lasPath ? { lasPath: input.lasPath } : {}) };

  const gathered = await gather(input.prompt, {
    corpus: deps.corpus,
    model: deps.gatherer,
    registry: deps.registry,
    ctx,
    store,
  });

  // Passages become evidence so they render in the brief the same way they do
  // on the well path — one rendering, one set of citation rules.
  for (const chunk of gathered.chunks) {
    store.addEvidence({ stage: "stage1", branch: "gatherer" }, {
      claim: `${chunk.slug}: ${chunk.heading}`,
      sourceId: chunk.id,
      kind: "documented",
    });
  }
  for (const failure of gathered.dropped.failedTools) {
    store.addOpen({ stage: "stage1", branch: "gatherer" }, {
      question: `A lookup the gatherer asked for could not be run (${failure}); its context is missing`,
      blocking: false,
    });
  }
  for (const slug of gathered.dropped.unknownDocuments) {
    store.addOpen({ stage: "stage1", branch: "gatherer" }, {
      question: `Gatherer cited "${slug}", which is not in the corpus; that thread was dropped`,
      blocking: false,
    });
  }
  const gatherMs = now() - started;

  const brief = renderBrief({
    prompt: input.prompt,
    mode: "question",
    state: store.snapshot(),
    gathered,
  });

  return {
    store,
    state: store.snapshot(),
    brief,
    gathered,
    timing: { gather: gatherMs, total: now() - started },
    trace: {
      subQuestions: gathered.subQuestions,
      chunks: gathered.chunks.length,
      sources: gathered.sources,
      toolCalls: store.snapshot().toolCalls.length,
      droppedCitations:
        gathered.dropped.unknownDocuments.length + gathered.dropped.unknownSegments.length,
      failedLookups: gathered.dropped.failedTools.length,
    },
  };
}

/**
 * The whole question path: gather, then Fable answers from the brief.
 *
 * `timing.total` is re-stamped so it covers building the stream too, which is
 * what it measured before the split.
 */
export async function runGeologyQuestion(
  input: GeologyQuestionInput,
  deps: GeologyQuestionDeps
): Promise<GeologyQuestion> {
  const now = deps.now ?? Date.now;
  const started = now();
  const context = await gatherGeologyQuestion(input, deps);

  const call: CallDeps = {
    store: context.store,
    registry: deps.registry,
    ctx: { api: NO_WELL, ...(input.lasPath ? { lasPath: input.lasPath } : {}) },
  };
  const model = deps.reasoning ?? fableReasoningModel();
  const result: Stage3Result = {
    stream: model.answer(
      fableQuestionSystem(input.candidates ?? []) + (input.styleSuffix ?? ""),
      [...(input.history ?? []), { role: "user", content: context.brief }],
      geologyTools(deps.registry, call, "fable")
    ),
  };

  return {
    ...context,
    result,
    timing: { gather: context.timing.gather, total: now() - started },
  };
}
