/**
 * What the harness did, in a shape the browser console can show.
 *
 * The answer deliberately hides its machinery: Fable is told never to mention a
 * tool call, and never to cite the reference library, because the operator asked
 * about their rock and not about how the question was processed. That is the
 * right output and it makes one thing impossible — telling, from the answer
 * alone, whether the tools and the corpus were used at all. A fluent paragraph
 * of general petrophysics looks exactly like a grounded one.
 *
 * This is the side channel that settles it. It rides the same stream as a
 * transient data part, so it reaches the console and never becomes part of the
 * message, is never persisted, and is never shown in the UI.
 *
 * It is a verification aid, not a feature. Nothing in the answer path reads it.
 */
import type { GeologyEntryResult } from "./entry";
import type { ToolCall, ZoneEvaluation } from "./state";

export interface GeologyTraceTool {
  tool: string;
  /** `harness` for Stage 0's fixed branches, then the two agents. */
  by: ToolCall["requestedBy"];
  /**
   * What happened.
   *
   * `unavailable` is separated from `failed` because they mean opposite things
   * and look identical in a ledger. Six of the harness's optional branches ask
   * for contract shapes that have no adapter yet — `curve_suite`, `calculators`,
   * `continuity_check` and the rest — so every well turn records six calls that
   * were never going to run. Counted as failures they read as a broken system;
   * they are a known gap, and the console should say which it is looking at.
   */
  status: "ok" | "failed" | "unavailable" | "refused";
  /** The tool's own account of how it got the answer. */
  method: string;
  /** Present unless the call succeeded outright. */
  note?: string;
}

export interface GeologyTrace {
  kind: "well" | "question";
  /** The log this turn evaluated, when there was one. */
  well: string | null;
  ms: Record<string, number>;
  /** Every server-side call, in the order they were made. */
  tools: GeologyTraceTool[];
  /** Counts by caller, so "did the gatherer actually do anything" is one glance. */
  by: Record<string, number>;
  /** Corpus documents whose primary text was read. Never shown to the user. */
  corpus: string[];
  /** What the gatherer decided the question breaks into. */
  subQuestions: string[];
  /** Numbers the harness required and did not get, plus failed lookups. */
  gaps: string[];
  /**
   * Hops that broke rather than came back empty.
   *
   * Separate from `gaps` because they mean different things: a gap is the
   * harness saying "this number was needed and is not here", and an error is a
   * step that did not run. Both belong in the console; only the first belongs in
   * Fable's brief.
   */
  errors: string[];
}

/** `callTool` phrases it this way, and it is the only signal there is. */
const NOT_REGISTERED = /no tool "[^"]+" available to/;

/**
 * Stage 1 branches with no tool behind them yet.
 *
 * These fail on every turn by construction — see the note in tool-registry.ts —
 * so counting them as breaks trains the reader to ignore the one list that is
 * supposed to mean something.
 */
const UNBUILT_BRANCHES = new Set(["kb-lookup", "calculators", "continuity"]);

function toolLine(call: ToolCall): GeologyTraceTool {
  const note = call.error ?? call.refused?.reason;
  const status: GeologyTraceTool["status"] = call.ok
    ? call.refused
      ? "refused"
      : "ok"
    : call.error && NOT_REGISTERED.test(call.error)
      ? "unavailable"
      : "failed";
  return {
    tool: call.tool,
    by: call.requestedBy,
    status,
    method: call.method,
    ...(note ? { note } : {}),
  };
}

function tally(tools: GeologyTraceTool[]): Record<string, number> {
  const counts: Record<string, number> = {
    harness: 0, gatherer: 0, fable: 0, ok: 0, failed: 0, unavailable: 0, refused: 0,
  };
  for (const t of tools) {
    counts[t.by] = (counts[t.by] ?? 0) + 1;
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Documents actually read, not documents the index offered.
 *
 * The distinction is the whole point of the retrieval design: the table of
 * contents is navigation, and a card that was consulted is not a passage that
 * was read. Only `sources` — the documents the gatherer pulled primary text
 * from — counts as the corpus having informed the answer.
 */
function corpusSources(sources: readonly string[]): string[] {
  return [...new Set(sources)].sort();
}

export function geologyTrace(result: GeologyEntryResult): GeologyTrace {
  if (result.kind === "question") {
    const { question } = result;
    const gathered = question.gathered;
    // Read from the live store, not the snapshot taken when the question path
    // returned: Fable's own calls land after that moment, and reading the
    // snapshot is how a trace ends up claiming the model used no tools.
    const tools = question.store.snapshot().toolCalls.map(toolLine);
    return {
      kind: "question",
      well: null,
      ms: question.timing,
      tools,
      by: tally(tools),
      corpus: corpusSources(gathered.sources),
      subQuestions: gathered.subQuestions,
      gaps: [
        ...gathered.dropped.failedTools.map((t) => `lookup failed: ${t}`),
        ...gathered.dropped.unknownDocuments.map((d) => `cited a document not in the corpus: ${d}`),
      ],
      errors: gathered.errors,
    };
  }

  const { turn } = result;
  const state: ZoneEvaluation = turn.store.snapshot();
  const tools = state.toolCalls.map(toolLine);
  return {
    kind: "well",
    well: state.well.name ?? state.well.api,
    ms: turn.timing,
    tools,
    by: tally(tools),
    corpus: corpusSources(turn.trace.sources ?? []),
    subQuestions: turn.trace.subQuestions,
    gaps: [
      ...turn.trace.missingRequirements.map((r) => `required and not computed: ${r}`),
      ...state.open.filter((o) => o.blocking).map((o) => o.question),
    ],
    errors: [
      // A branch whose tool was never registered is the `unavailable` case
      // again, one level up. Listed as a break it put three permanent entries in
      // "steps that broke" on every single well turn, which is how a real
      // failure gets lost among the noise.
      ...turn.trace.failedBranches
        .filter((b) => !UNBUILT_BRANCHES.has(b))
        .map((b) => `context branch failed: ${b}`),
      ...turn.trace.gatherErrors,
      ...(turn.trace.conflictNoteError ? [`conflict notes failed: ${turn.trace.conflictNoteError}`] : []),
    ],
  };
}

/**
 * The one-line summary, for a console that should be readable at a glance.
 *
 * Leads with the counts that answer the question being asked: were tools run,
 * and was primary source text read.
 */
export function traceSummary(trace: GeologyTrace): string {
  const failed = trace.by.failed ? `, ${trace.by.failed} failed` : "";
  const absent = trace.by.unavailable ? `, ${trace.by.unavailable} not built yet` : "";
  return (
    `geology ${trace.kind}${trace.well ? ` — ${trace.well}` : ""}: ` +
    `${trace.by.ok} tools ran (harness ${trace.by.harness}, ` +
    `gatherer ${trace.by.gatherer}, fable ${trace.by.fable}${failed}${absent}), ` +
    `${trace.corpus.length} corpus segments read`
  );
}
