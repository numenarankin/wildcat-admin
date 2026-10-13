/**
 * The context gatherer — Sonnet, unconditional, parallel.
 *
 * See well-log-agent.md, Stage 1. It runs on EVERY geology turn, alongside the
 * deterministic branches rather than after them, and it is not gated on a
 * dictionary key miss. Its job is to make Fable's answer maximally informed, so
 * it is judged on whether the right material arrives — not on retrieval metrics.
 *
 * ## Navigation, not similarity
 *
 * Retrieval is two model hops over the TOC, because the TOC is question-indexed:
 * its entries are the questions a section answers, which is what routing needs.
 *
 *   level 1  resident cards      -> which documents are worth opening
 *   level 2  per-document detail -> which segments answer this sub-question
 *   level 3  the corpus file     -> the verbatim text, by character offset
 *
 * ## Two disciplines, both enforced in code
 *
 * VERBATIM. The gatherer returns source text with IDs, never summaries. There is
 * no synthesis call at the end — merging is concatenation and dedupe. A summary
 * would be an unattributable claim by the time Fable read it.
 *
 * SELECTIONS ARE VERIFIED. A model asked to pick from a list can return a slug
 * or segment ID that does not exist. Those are dropped mechanically and counted,
 * the same way `build_toc.py` greps claimed entities against the segment: a
 * plausible-looking citation to a document that is not in the corpus is worse
 * than a gap, because it reads as evidence.
 */
import type { Chunk, Corpus, DocumentCard, SegmentEntry } from "./corpus";
import { callTool, type CallDeps } from "./call-tool";
import type { AgentRole, ToolContext, ToolRegistry, ToolResult } from "./registry";
import type { ZoneEvaluationStore } from "./state";

/** Enough to split a compound question; bounded because it sits in the user's wait. */
export const MAX_SUB_QUESTIONS = 3;
/** Ceilings on what comes back, so one greedy turn cannot flood Fable's context. */
export const MAX_CHUNKS = 24;
export const MAX_CHUNK_CHARS = 120_000;

const ROLE: AgentRole = "gatherer";

export interface ToolRequest {
  name: string;
  args: unknown;
}

/**
 * The model side of the gatherer, behind an interface.
 *
 * Not for mocking convenience — it is the seam between judgment (which document
 * bears on this question) and mechanism (opening files, verifying IDs, slicing
 * text). Everything outside this interface is deterministic and testable without
 * a model in the loop.
 */
export interface GathererModel {
  /** Split the turn into at most `max` sub-questions. One, for a simple turn. */
  splitQuestion(prompt: string, max: number): Promise<string[]>;
  /** Level 1. Returns slugs. */
  selectDocuments(subQuestion: string, cards: DocumentCard[]): Promise<string[]>;
  /** Level 2. Returns segment IDs (`section/slug#n`). */
  selectSegments(subQuestion: string, entries: SegmentEntry[]): Promise<string[]>;
  /**
   * Read-only tools the gatherer judges Fable will need. Optional.
   *
   * `subject` is the well, and it is not decoration. Without it the gatherer was
   * asked to call `rrc_well` while knowing nothing but the question text, so it
   * guessed `name=Repass` — an argument that tool does not take — and every
   * public-record lookup on the well path failed for that reason alone.
   */
  requestTools?(
    subQuestion: string,
    available: string[],
    subject?: GatherSubject
  ): Promise<ToolRequest[]>;
  /**
   * Flag contradictions in the assembled facts on the way out.
   *
   * Runs once, after the fan-out, on the state object rather than the question —
   * so it is the gatherer noting what does not add up as it hands off, not a
   * stage of its own. Returns raw text; the harness parses and validates.
   */
  noteConflicts?(renderedState: string): Promise<string>;
}

/** Who the turn is about, in the terms the lookup tools take. */
export interface GatherSubject {
  api?: string | null;
  name?: string | null;
  operator?: string | null;
  county?: string | null;
  district?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface GatheredTool {
  subQuestion: string;
  name: string;
  args: unknown;
  result: ToolResult<unknown>;
}

export interface GatherResult {
  subQuestions: string[];
  /** Deduped by segment ID, first occurrence wins. Verbatim. */
  chunks: Chunk[];
  /** Segment IDs, in the order they were kept. Fable cites these. */
  sources: string[];
  toolResults: GatheredTool[];
  /** What was dropped or cut, and why. Never silent. */
  dropped: {
    unknownDocuments: string[];
    unknownSegments: string[];
    /** Lookups the gatherer asked for that could not be run. */
    failedTools: string[];
    overBudget: number;
  };
  /**
   * Hops that failed, in the operator's terms rather than a stack trace.
   *
   * Empty on a healthy turn. Non-empty means the answer was written with less
   * than the library holds, which is exactly the condition that is invisible
   * from the answer itself.
   */
  errors: string[];
}

export interface GatherDeps {
  corpus: Corpus;
  model: GathererModel;
  registry: ToolRegistry;
  ctx: ToolContext;
  /**
   * The gatherer's own tool calls are recorded here as they happen, alongside
   * the fan-out's automatic ones. Fable is handed the union: exactly which tools
   * ran, who asked for each, and what each returned.
   */
  store: ZoneEvaluationStore;
  maxSubQuestions?: number;
  /** The well, when there is one. Absent on the no-log path. */
  subject?: GatherSubject;
}

/** One failure, named by where it happened, for the ledger and the console. */
function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which arguments a tool cannot be called without.
 *
 * Derived by parsing `{}` and reading which paths the schema complains about,
 * rather than reaching into zod's internals — the shape of those changes between
 * versions and this does not.
 */
function requiredArgs(schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { path: PropertyKey[] }[] } } }): string[] {
  const parsed = schema.safeParse({});
  if (parsed.success || !parsed.error) return [];
  return [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}

export async function gather(prompt: string, deps: GatherDeps): Promise<GatherResult> {
  const { corpus, model, registry, ctx, store } = deps;
  const call: CallDeps = { store, registry, ctx };
  const max = deps.maxSubQuestions ?? MAX_SUB_QUESTIONS;

  /*
   * Every hop below is isolated, and none of them is optional to the answer.
   *
   * There are five model calls and three file reads in here, each with its own
   * 25-second ceiling. Left unguarded — as this was — one Sonnet timeout on one
   * sub-question rejected the `Promise.all` and threw away every passage
   * gathered for all of them. That is the worst failure shape available: the
   * turn still produces a confident answer, written from the model's own
   * petrophysics, and nothing anywhere says the library was not read.
   *
   * So each hop degrades to its empty value and records why. The gather comes
   * back smaller, `errors[]` says what is missing, and the console says it out
   * loud.
   */
  const errors: string[] = [];

  const cards = await corpus.documentCards().catch((err: unknown) => {
    errors.push(`the reference index could not be opened (${why(err)})`);
    return [];
  });
  const bySlug = new Map(cards.map((c) => [c.slug, c]));

  const split = await model.splitQuestion(prompt, max).catch((err: unknown) => {
    errors.push(`the question could not be split (${why(err)}); answered as one`);
    return [] as string[];
  });
  // A model that returns nothing must not silently produce an empty gather —
  // the original question is always a legitimate sub-question.
  const subQuestions = (split.length > 0 ? split : [prompt]).slice(0, max);

  // Names AND required arguments. Given names alone the gatherer wrote
  // `rrc_well name=Repass`, which the tool's schema rejected because it takes
  // `api` — a whole lookup lost to a guess it had no way to make correctly.
  const callable = registry.listFor(ROLE);
  const available = callable.map((t) => `${t.name}(${requiredArgs(t.inputSchema).join(", ")})`);
  const nameOf = (line: string) => line.replace(/\(.*$/, "");

  const perQuestion = await Promise.all(
    subQuestions.map(async (sq) => {
      const unknownDocuments: string[] = [];
      const unknownSegments: string[] = [];
      const failedTools: string[] = [];
      const slugs = await model.selectDocuments(sq, cards).catch((err: unknown) => {
        errors.push(`no documents chosen for "${sq}" (${why(err)})`);
        return [] as string[];
      });
      const known: DocumentCard[] = [];
      for (const slug of slugs) {
        const card = bySlug.get(slug);
        if (card) known.push(card);
        else unknownDocuments.push(slug);
      }

      const entries = (
        await Promise.all(
          known.map((c) =>
            corpus.detail(c.section, c.slug).catch((err: unknown) => {
              errors.push(`could not open ${c.slug} (${why(err)})`);
              return [];
            })
          )
        )
      ).flat();

      const byId = new Map(entries.map((e) => [e.id, e]));
      const picked =
        entries.length > 0
          ? await model.selectSegments(sq, entries).catch((err: unknown) => {
              errors.push(`no sections chosen for "${sq}" (${why(err)})`);
              return [] as string[];
            })
          : [];
      const refs: string[] = [];
      for (const id of picked) {
        if (byId.has(id)) refs.push(id);
        else unknownSegments.push(id);
      }

      // Per segment: one unreadable file costs that passage, not the branch.
      const chunks = (
        await Promise.all(
          refs.map((id) =>
            corpus.read(id).catch((err: unknown) => {
              errors.push(`could not read ${id} (${why(err)})`);
              return null;
            })
          )
        )
      ).filter((c): c is Chunk => c !== null);

      const requested = model.requestTools
        ? await model.requestTools(sq, available, deps.subject).catch((err: unknown) => {
            errors.push(`no lookups chosen for "${sq}" (${why(err)})`);
            return [];
          })
        : [];
      const toolResults: GatheredTool[] = [];
      for (const req of requested) {
        // A tool the gatherer may not call is a dropped request, not a thrown
        // turn: the gatherer asking for something out of scope should cost
        // nothing rather than sink the whole fan-out branch.
        if (!available.some((a) => nameOf(a) === req.name)) continue;
        try {
          toolResults.push({
            subQuestion: sq,
            name: req.name,
            args: req.args,
            result: await callTool(call, { stage: "stage1", branch: "gatherer" }, req.name, req.args, ROLE),
          });
        } catch (err: unknown) {
          // A lookup the gatherer asked for badly — wrong arguments, a tool that
          // threw — costs that lookup and nothing else. `callTool` has already
          // recorded it as a failed call, so the ledger still shows it was
          // attempted; letting it propagate would lose every passage gathered
          // for this sub-question alongside it.
          const message = err instanceof Error ? err.message : String(err);
          console.warn("geology:gatherer-tool-failed", { tool: req.name, args: req.args, error: message });
          failedTools.push(`${req.name}: ${message}`);
        }
      }

      return { chunks, toolResults, unknownDocuments, unknownSegments, failedTools };
    })
  );

  // Merge is deterministic: concatenate, dedupe by segment ID, first wins.
  // There is no second model call to synthesize — that would be the
  // summarization the verbatim rule forbids.
  const seen = new Set<string>();
  const chunks: Chunk[] = [];
  let chars = 0;
  let overBudget = 0;

  for (const r of perQuestion) {
    for (const chunk of r.chunks) {
      if (seen.has(chunk.id)) continue;
      if (chunks.length >= MAX_CHUNKS || chars + chunk.text.length > MAX_CHUNK_CHARS) {
        overBudget++;
        continue;
      }
      seen.add(chunk.id);
      chunks.push(chunk);
      chars += chunk.text.length;
    }
  }

  /*
   * Nothing chosen is not the same as nothing there.
   *
   * The selection is a model judgment, and on a question that names a well and a
   * depth it reads as a data lookup rather than a method question — so Sonnet
   * returns nothing, and the answer gets written from its own petrophysics with
   * a 66-document petrophysics library sitting unread. Measured on the first
   * real question asked of this system, twice.
   *
   * So when judgment produces nothing and nothing broke, fall back to search:
   * BM25 over the same corpus, in Python, no model in the loop. It cannot decide
   * that a porosity question needs no reference material, because it does not
   * decide anything.
   */
  if (chunks.length === 0 && errors.length === 0) {
    try {
      const hits = await callTool<{ inputs?: { hits?: { anchor?: string }[] } }>(
        call,
        { stage: "stage1", branch: "gatherer-fallback" },
        "petrophysics",
        { tool: "kb_search", args: { query: prompt, top_k: 6 } },
        "harness"
      );
      const anchors = (hits.value.inputs?.hits ?? [])
        .map((h) => h.anchor)
        .filter((a): a is string => typeof a === "string" && a.includes("#"))
        .slice(0, MAX_CHUNKS);
      for (const id of anchors) {
        if (seen.has(id)) continue;
        const chunk = await corpus.read(id).catch(() => null);
        if (!chunk) continue;
        seen.add(id);
        chunks.push(chunk);
      }
      if (chunks.length > 0) {
        console.info("geology:corpus-via-search", { anchors: chunks.length, prompt: prompt.slice(0, 90) });
      }
    } catch (err: unknown) {
      // The fallback failing is not worth an error line of its own — the
      // no-corpus warning below already says the outcome, which is what matters.
      errors.push(`corpus search fallback did not run (${why(err)})`);
    }
  }

  // Loud, because it is invisible everywhere else. A turn that read nothing
  // still produces a fluent answer — from the model's own petrophysics rather
  // than from the library — and reads exactly like a grounded one. Measured
  // across live runs this happened intermittently on well-path questions the
  // corpus plainly covers, which is what the selection prompt now guards.
  if (chunks.length === 0) {
    console.warn("geology:no-corpus-read", { subQuestions, errors, prompt: prompt.slice(0, 120) });
  }
  if (errors.length > 0) {
    console.warn("geology:gather-degraded", { errors, chunks: chunks.length });
  }

  return {
    subQuestions,
    chunks,
    errors,
    sources: chunks.map((c) => c.id),
    toolResults: perQuestion.flatMap((r) => r.toolResults),
    dropped: {
      unknownDocuments: perQuestion.flatMap((r) => r.unknownDocuments),
      unknownSegments: perQuestion.flatMap((r) => r.unknownSegments),
      failedTools: perQuestion.flatMap((r) => r.failedTools),
      overBudget,
    },
  };
}
