/**
 * The geology trace, in the browser console.
 *
 * The answer is deliberately silent about its own machinery — no tool names, no
 * mention of the reference library — which means reading it tells you nothing
 * about whether either was used. This prints what the answer will not say, so
 * "did it actually call the tools and read the corpus" is a question with a
 * visible answer.
 *
 * ## Failure is the thing it exists for
 *
 * Every degradation in this subsystem is designed to be invisible to the
 * operator: a failed tool is noted internally and the model works with what it
 * has, a declined turn falls back to Orion, an empty gather still produces a
 * fluent answer. That is correct behaviour and it is exactly what makes a break
 * hard to notice. So anything that did not go to plan is a `console.warn` or
 * `console.error` here, loudly, whatever the answer looks like.
 *
 * Console only. Never rendered, never persisted, and nothing in the product
 * reads it.
 *
 * All of it is `warn`, never `error`: Next's dev overlay promotes a
 * `console.error` into a full-screen panel, so a diagnostic about a degraded
 * answer would look exactly like a crash — and would interrupt the very session
 * it exists to inform.
 */
import type { GeologyTrace } from "./trace";

/** A turn the harness took. */
interface TraceWire extends GeologyTrace {
  phase: "context" | "answered";
  turnId: string;
  summary: string;
}

/** A turn it did not take. There is no trace, only the reason. */
interface DeclinedWire {
  phase: "declined";
  turnId: string;
  summary: string;
}

type Wire = TraceWire | DeclinedWire;

function isWire(data: unknown): data is Wire {
  return (
    typeof data === "object" &&
    data !== null &&
    "phase" in data &&
    typeof (data as Wire).summary === "string"
  );
}

const STYLE = "color:#b45309;font-weight:600";
const ALARM = "color:#b91c1c;font-weight:600";

/**
 * Log one `data-geology` part.
 *
 * Grouped and collapsed: the summary line is what you read at a glance, and the
 * detail is there when the summary says something surprising. Up to two phases
 * arrive per turn — `context` before the model speaks and `answered` once it
 * has, which is the only point at which Fable's own calls exist — or a single
 * `declined` when the harness did not run at all.
 */
export function logGeologyTrace(part: { type: string; data?: unknown }): void {
  if (part.type !== "data-geology" || !isWire(part.data)) return;
  const wire = part.data;

  if (wire.phase === "declined") {
    // The one failure with no trace behind it, and the easiest to miss: the
    // answer arrives, reads well, and was written without the corpus.
    console.warn(`%c[geology] DECLINED — ${wire.summary}`, ALARM);
    return;
  }

  const trace = wire;
  const label = trace.phase === "context" ? "context assembled" : "answer complete";
  const broken = trace.errors.length > 0 || trace.corpus.length === 0 || trace.by.failed > 0;

  console.groupCollapsed(
    `%c[geology] ${label} — ${trace.summary}${broken ? "  ⚠" : ""}`,
    broken ? ALARM : STYLE
  );
  console.log("turn", trace.turnId, `(${trace.kind}${trace.well ? `, ${trace.well}` : ""})`);

  if (trace.tools.length) {
    // A table, because the question is comparative: which tools ran, who asked,
    // and did any fail. Reading that off a list of objects is work.
    console.table(
      trace.tools.map((t) => ({
        tool: t.tool,
        by: t.by,
        status: t.status,
        method: t.method,
        note: t.note ?? "",
      }))
    );
  } else if (trace.kind === "well") {
    // The well path always runs Stage 0. Nothing at all means the ledger is
    // broken, not that the turn needed nothing.
    console.warn("no tools were called on a well turn — Stage 0 should always run");
  } else {
    console.log("no tools were called (normal for a question that needs no lookup)");
  }

  if (trace.by.unavailable) {
    // Said once, plainly, so a row of `unavailable` in the table is not read as
    // breakage. These are contract shapes with no adapter yet; see the note in
    // tool-registry.ts for which and why.
    console.log(
      `${trace.by.unavailable} optional branches have no tool behind them yet (a known gap, not a failure)`
    );
  }
  if (trace.by.failed) {
    console.warn(
      `${trace.by.failed} tool calls FAILED`,
      trace.tools.filter((t) => t.status === "failed")
    );
  }

  if (trace.corpus.length) {
    console.log(`corpus read (${trace.corpus.length} segments)`, trace.corpus);
  } else {
    // The single most important line here. An answer written with no corpus is
    // the model's own petrophysics, and it reads exactly like a grounded one.
    console.warn(
      "%cNO CORPUS TEXT WAS READ — this answer is not grounded in the reference library",
      ALARM
    );
  }

  if (trace.errors.length) {
    console.warn("steps that broke", trace.errors);
  }
  if (trace.subQuestions.length) console.log("sub-questions", trace.subQuestions);
  if (trace.gaps.length) console.warn("gaps the answer has to work around", trace.gaps);
  console.log("ms", trace.ms);
  console.groupEnd();
}
