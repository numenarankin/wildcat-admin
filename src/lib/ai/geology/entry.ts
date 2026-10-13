/**
 * The chat route's door into the geology harness.
 *
 * The router already labels a turn `geology` and today the route acts on that by
 * swapping the model to Fable on the same call, with Orion's prompt and Orion's
 * tools. This is the fork that sends such a turn to the harness instead.
 *
 * ## Three ways this declines, all of them normal
 *
 * OFF. The harness is behind `GEOLOGY_HARNESS=1`, which is the switch for
 * putting it in front of users rather than a statement about whether it works.
 * The corpus, the tool layer and the public record all ship with the app.
 *
 * NO LOG. "What does high GR mean" is a geology question with no file attached.
 * There is no well to evaluate, so it belongs on the general path.
 *
 * NOT READY. No corpus configured, no tools registered — anything that means the
 * harness would produce a worse answer than Orion would.
 *
 * In all three the caller carries on with today's path. That is also the failure
 * mode: `runGeology` returns null rather than throwing, because a new subsystem
 * must never be able to turn a slow answer into no answer.
 */
import type { UIMessage } from "ai";
import { convertToModelMessages } from "ai";
import { Corpus, corpusRoot, openCorpus } from "./corpus";
import { MemoryEvaluationCache, type EvaluationCache } from "./cache";
import { newGathererUsage, sonnetGathererModel, type GathererUsage } from "./gatherer-model";
import type { GathererModel } from "./gatherer";
import { geologyRegistry } from "./tool-registry";
import { gatherGeologyTurn, runGeologyTurn, type GeologyTurn } from "./run";
import {
  gatherGeologyQuestion,
  runGeologyQuestion,
  type GeologyQuestion,
} from "./question";
import { pointsAtALog, resolveSubject, subjectIdentity, type LasSubject } from "./subject";
import type { ReasoningModel, Stage3Result } from "./stage3-reason";

export interface GeologyEntryInput {
  messages: UIMessage[];
  pageContext?: string;
  folderFiles?: { id: string; name: string }[];
  /**
   * The library lookup, overridable for tests.
   *
   * Production leaves it unset and gets `getLasFiles`, which is RLS-scoped to
   * the caller's org.
   */
  lasFiles?: () => Promise<{ id: string; name: string }[]>;
  /**
   * Model overrides. Production passes none; tests substitute the judgment side
   * so the routing and the decline paths can be exercised without an API key.
   */
  models?: { gatherer?: GathererModel; reasoning?: ReasoningModel };
  /**
   * Appended to Fable's system prompt on whichever path runs.
   *
   * The harness answers on its own `streamText`, so the caller's delivery rules
   * — spoken prose for voice, formatting for the drawer — cannot reach it any
   * other way. Typed chat passes nothing and gets Fable's own contract.
   */
  styleSuffix?: string;
}

/**
 * Which of the two geology paths ran.
 *
 * `well` evaluated a specific log. `question` had no log in scope and answered
 * from the reference library plus whatever the gatherer chose to look up —
 * without it, every geology question that is not about an attached LAS would
 * fall through to Orion, which has no corpus at all.
 */
export type GeologyEntryResult = {
  /**
   * What the Sonnet gatherer spent on this turn, for the caller to meter.
   *
   * Both paths run the gatherer, so it is on the shared side of the union. It
   * is final by the time this returns — the gatherer completes before Fable is
   * handed the brief — unlike the Fable stream, which the caller still has to
   * await. Zeros mean the gatherer never ran, which is a decline or an
   * injected test model, not a free turn.
   */
  gathererUsage: GathererUsage;
} & (
  | { kind: "well"; turn: GeologyTurn; subject: LasSubject; stream: Stage3Result["stream"] }
  | { kind: "question"; question: GeologyQuestion; stream: Stage3Result["stream"] }
);

/**
 * One process-wide cache.
 *
 * Correct for a single-instance deployment and wrong for several — the second
 * instance simply misses and re-materializes, which is slow rather than
 * incorrect. Swap for a Postgres-backed `EvaluationCache` when there is more
 * than one.
 */
let cache: EvaluationCache | null = null;
function sharedCache(): EvaluationCache {
  cache ??= new MemoryEvaluationCache();
  return cache;
}

/**
 * The library lookup, imported at CALL time.
 *
 * A top-level import would pull `server-only` (through the Supabase server
 * client) into this module's graph, and this module is loaded by the node-test
 * suite, which is not a server component and refuses it outright. Deferring the
 * import keeps the default in place for both routes without either of them
 * having to wire it, and keeps this file loadable by a plain test.
 */
async function defaultLasFiles(): Promise<{ id: string; name: string }[]> {
  const { getLasFiles } = await import("@/lib/kb/files");
  return getLasFiles();
}

export function geologyHarnessEnabled(): boolean {
  return process.env.GEOLOGY_HARNESS === "1";
}

/** The corpus that ships with the app. Root resolution lives in `corpus.ts`. */
function corpus(): Corpus | null {
  const kb = openCorpus();
  if (!kb) {
    // An error, not a warning: the corpus is the reason this path exists. Absent
    // in a deployment, every geology turn quietly becomes an ordinary one.
    console.error("geology:skipped", { stage: "corpus", reason: "no corpus at " + corpusRoot() });
    return null;
  }
  return kb;
}

/**
 * Run the turn, or return null to say "not mine".
 *
 * Never throws. Every reason to decline — flag off, no log, no corpus, no tools,
 * a Stage 0 that could not parse — resolves to null and the caller falls back.
 */
export async function runGeology(
  input: GeologyEntryInput
): Promise<GeologyEntryResult | null> {
  /*
   * Every exit from here is announced.
   *
   * Returning null hands the turn back to Orion, which answers it competently
   * and with no corpus — so a decline is invisible from the outside. That is
   * fine when the reason is "no log in scope"; it is a bug the user cannot see
   * when the reason is a missing corpus or an unreachable tool layer. Naming the
   * stage in the log is what makes the difference diagnosable, and the caller
   * puts the same reason on the stream so it reaches the browser console too.
   */
  if (!geologyHarnessEnabled()) {
    console.info("geology:skipped", { stage: "flag", reason: "GEOLOGY_HARNESS is not 1" });
    return null;
  }

  const kb = corpus();
  if (!kb) return null;

  const registry = geologyRegistry();
  if (registry.size === 0) {
    console.error("geology:skipped", { stage: "tools", reason: "no tools registered" });
    return null;
  }

  const prompt = latestUserText(input.messages);
  if (!prompt) {
    console.warn("geology:skipped", { stage: "prompt", reason: "no user text in the turn" });
    return null;
  }

  // Everything except the current turn: the brief IS the current turn.
  const history = await convertToModelMessages(input.messages.slice(0, -1));

  const { subject, candidates } = await resolveSubject({
    ...input,
    prompt,
    lasFiles: input.lasFiles ?? defaultLasFiles,
  });

  /*
   * One tally for the turn, shared by whichever path runs.
   *
   * The well path can fail and fall through to the question path, and when it
   * does the gatherer has usually already spent a full set of hops. Keeping a
   * single tally across both means that work is billed rather than discarded
   * because the branch that spent it lost.
   */
  const gathererUsage = newGathererUsage();

  /**
   * The corpus path, which is the floor.
   *
   * It needs the reference library and nothing else — no log, no tool server, no
   * public record — so it is what a failure anywhere else falls back TO rather
   * than past. Falling back to Orion instead means answering a geology question
   * with no petrophysics library at all, which is strictly worse than answering
   * it from the library without the log.
   */
  const questionPath = async (why?: string): Promise<GeologyEntryResult | null> => {
    if (why) console.warn("geology:degraded-to-question", { reason: why, prompt: prompt.slice(0, 120) });
    try {
      const question = await runGeologyQuestion(
        {
          prompt,
          history,
          styleSuffix: input.styleSuffix,
          // Shown only when the question actually points at a log. A general
          // petrophysics question that is handed the list reaches for whatever
          // log is nearest and answers about that operator's well; see
          // `pointsAtALog`.
          candidates: pointsAtALog(prompt, candidates) ? candidates : [],
          // A degrade from the well path still KNOWS the log. Dropping it here
          // made `las_header` refuse with "no LAS file in scope for this turn"
          // on a turn where the file was resolved and readable, so every
          // sub-question about the log came back empty.
          ...(subject ? { lasPath: subject.fileId } : {}),
        },
        {
          corpus: kb,
          gatherer: input.models?.gatherer ?? sonnetGathererModel(gathererUsage),
          registry,
          ...(input.models?.reasoning ? { reasoning: input.models.reasoning } : {}),
        }
      );
      return { kind: "question", question, stream: question.result.stream, gathererUsage };
    } catch (err: unknown) {
      console.error("geology:question-failed", {
        stage: "question",
        prompt: prompt.slice(0, 120),
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
      });
      return null;
    }
  };

  // No log PINNED. Still a geology question, and still one the corpus can answer
  // better than a general assistant with no corpus at all — and when the library
  // holds logs, the question path is now told about them rather than told there
  // are none.
  //
  // Announced, because a null subject used to be the one silent decline here.
  // That silence is exactly how this shipped saying it could not read a log that
  // was in the library: nothing in the answer or the log showed which of the
  // four lookups had been possible.
  if (!subject) {
    console.info("geology:no-subject", {
      prompt: prompt.slice(0, 120),
      candidates: candidates.length,
      lookups: {
        page: Boolean(input.pageContext),
        history: input.messages.length > 1,
        folder: (input.folderFiles ?? []).length,
        library: candidates.length,
      },
    });
    return questionPath();
  }

  try {
    const turn = await runGeologyTurn(
      {
        prompt,
        api: subjectIdentity(subject),
        lasPath: subject.fileId,
        // Content hashes are not available before the file is read, so the
        // file's identity stands in. A re-uploaded log that keeps its id would
        // read a stale evaluation — worth revisiting when files carry a
        // content hash or an updated_at we can reach cheaply.
        stamps: { las: subject.fileId, rrc: "v1", facts: "v1" },
        history,
        styleSuffix: input.styleSuffix,
      },
      {
        registry,
        cache: sharedCache(),
        corpus: kb,
        gatherer: input.models?.gatherer ?? sonnetGathererModel(),
        ...(input.models?.reasoning ? { reasoning: input.models.reasoning } : {}),
      }
    );
    console.info("geology:well", {
      fileId: subject.fileId,
      via: subject.via,
      well: turn.state.well.name,
      ...turn.timing,
      corpusSegments: turn.trace.sources.length,
      gatherErrors: turn.trace.gatherErrors,
    });
    return { kind: "well", turn, subject, stream: turn.result.stream, gathererUsage };
  } catch (err: unknown) {
    /*
     * The log could not be evaluated. That is not a reason to give up the corpus.
     *
     * Stage 0 dies if the tool layer is unreachable — a dead dev tool server, a
     * cold Python function, a timeout — and every one of those used to return
     * null and hand a subsurface question to Orion, which has no petrophysics
     * library at all. The question path needs none of what just failed. It reads
     * the corpus and the public record, and it answers the question asked with
     * the operator's own numbers in it, which is far closer to right than a
     * general assistant guessing.
     *
     * Only if THAT also fails does this return null.
     */
    const message = err instanceof Error ? err.message : String(err);
    console.error("geology:failed", {
      stage: "well",
      fileId: subject.fileId,
      via: subject.via,
      prompt: prompt.slice(0, 120),
      error: message,
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
    });
    return questionPath(`the log could not be evaluated (${message})`);
  }
}

/**
 * The corpus as a RESEARCHER rather than as the answer.
 *
 * `runGeology` above takes the whole turn over: it streams Fable's answer from
 * its own brief, so nothing else the turn gathered can reach the reader. That is
 * right when the question is only about the rock and wrong the moment it is
 * about the rock AND something else. "Analyze the geology of another operator's
 * play" needs the petrophysics corpus and the Texas public record together, and
 * while geology could only answer or not answer, that question read the public
 * record alone and said nothing about the rock — with nothing in the answer to
 * show which half was missing.
 *
 * So this runs the same stages and stops at the brief. Opus holds it alongside
 * the other briefs.
 *
 * ## It takes the WELL path when there is a log, and that was the bug
 *
 * This used to run the question path unconditionally, on the reasoning that the
 * well path is shaped to end in Fable's interpretation. That was wrong twice
 * over. It meant a mixed turn never evaluated the log at all — and worse, the
 * comment claimed the gatherer could still read one through the registry's
 * tools, which it cannot: `read_las_full` and the curve readers are bridged
 * `callableBy: ["fable"]` and `["harness", "fable"]` (see `orion-bridge.ts` and
 * `python-tools.ts`). The gatherer's reach is the corpus and the public record.
 *
 * So "what plays are other operators making like my Repass 2" got the reference
 * library and the state's filings, and answered about a well whose own log
 * nobody opened — while the log sat in the project folder the question was
 * asked from. Nothing in the answer showed it.
 *
 * With a log in scope this now runs Stages 0 and 1: the curve math and the
 * fan-out, everything except Fable. Without one it runs the question path as
 * before, and it falls back to the question path if the log cannot be
 * evaluated — the same ladder `runGeology` uses, for the same reason.
 *
 * Null on every decline, like everything else here, and never throws.
 */
export async function gatherGeology(input: {
  messages: UIMessage[];
  /** All three are how a log is FOUND. Omitting them was the bug above. */
  pageContext?: string;
  folderFiles?: { id: string; name: string }[];
  lasFiles?: () => Promise<{ id: string; name: string }[]>;
  models?: { gatherer?: GathererModel };
}): Promise<{ brief: string; trace: object & { ms: number } } | null> {
  if (!geologyHarnessEnabled()) {
    console.info("geology:skipped", { stage: "flag", reason: "GEOLOGY_HARNESS is not 1" });
    return null;
  }
  const kb = corpus();
  if (!kb) return null;

  const registry = geologyRegistry();
  if (registry.size === 0) {
    console.error("geology:skipped", { stage: "tools", reason: "no tools registered" });
    return null;
  }

  const prompt = latestUserText(input.messages);
  if (!prompt) {
    console.warn("geology:skipped", { stage: "prompt", reason: "no user text in the turn" });
    return null;
  }

  const started = Date.now();
  const gatherer = input.models?.gatherer ?? sonnetGathererModel(newGathererUsage());
  const history = await convertToModelMessages(input.messages.slice(0, -1));

  /** The corpus-only path. The floor, and what everything else falls back to. */
  const questionPath = async (why?: string, lasPath?: string) => {
    if (why) console.warn("geology:gather-degraded", { reason: why });
    const context = await gatherGeologyQuestion(
      { prompt, history, ...(lasPath ? { lasPath } : {}) },
      { corpus: kb, gatherer, registry }
    );
    return { brief: context.brief, trace: { ...context.trace, ms: Date.now() - started } };
  };

  const { subject, candidates } = await resolveSubject({
    ...input,
    prompt,
    lasFiles: input.lasFiles ?? defaultLasFiles,
  });

  try {
    if (!subject) {
      console.info("geology:no-subject", {
        stage: "gather",
        prompt: prompt.slice(0, 120),
        candidates: candidates.length,
      });
      return await questionPath();
    }

    // A log is in scope, so evaluate it. This is the expensive half of the
    // geology harness and the whole reason a mixed turn can say anything about
    // the rock rather than about the neighbourhood.
    const context = await gatherGeologyTurn(
      {
        prompt,
        api: subjectIdentity(subject),
        lasPath: subject.fileId,
        // Same standing caveat as `runGeology`: a re-uploaded log keeping its id
        // would read a stale evaluation.
        stamps: { las: subject.fileId, rrc: "v1", facts: "v1" },
        history,
      },
      { registry, cache: sharedCache(), corpus: kb, gatherer }
    );
    console.info("geology:gather-well", {
      fileId: subject.fileId,
      via: subject.via,
      well: context.state.well.name,
      ...context.timing,
    });
    return { brief: context.brief, trace: { ...context.trace, ms: Date.now() - started } };
  } catch (err: unknown) {
    // Same contract as every other decline here: a missing brief costs quality,
    // a thrown one costs the answer. A log that cannot be evaluated still leaves
    // the corpus worth reading, so that is tried before giving up.
    const message = err instanceof Error ? err.message : String(err);
    console.error("geology:gather-failed", {
      prompt: prompt.slice(0, 120),
      ms: Date.now() - started,
      error: message,
    });
    if (!subject) return null;
    try {
      return await questionPath(`the log could not be evaluated (${message})`, subject.fileId);
    } catch {
      return null;
    }
  }
}

function latestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = (messages[i].parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim();
    if (text) return text;
  }
  return "";
}
