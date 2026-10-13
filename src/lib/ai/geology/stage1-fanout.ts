/**
 * Stage 1 — Fan out. One wall-clock hop, five branches, none waiting on another.
 *
 * See well-log-agent.md, Stage 1, as revised: the Sonnet gatherer ALWAYS runs
 * and runs CONCURRENTLY with the deterministic branches. It is not a fallback on
 * a dictionary key miss and it is not sequenced after the calculators.
 *
 * Everything here writes into the one state object. Retrieval returns text;
 * calculators return numbers with inputs attached; neither returns conclusions.
 *
 * ## A failing branch must not sink the turn
 *
 * Each branch is caught independently and recorded — with the failure surfaced
 * as an open item naming the branch, never swallowed. A turn that lost its
 * offset query is still answerable and should say what it lost; a turn that dies
 * because one query timed out is not.
 */
import {
  DEFAULT_RADIUS_FT,
  MAX_OFFSETS,
  TOOL,
  type CalculatorFacts,
  type ContinuityFacts,
  type HeaderFacts,
  type KbLookupFacts,
  type OffsetsFacts,
} from "./contracts";
import { gather, type GatherDeps, type GatherResult, type GathererModel } from "./gatherer";
import type { Corpus } from "./corpus";

import { checkPlausibility, type Implausibility } from "./plausibility";
import { checkRequirements, type RequirementsReport } from "./requirements";
import { describe as describeState, noteConflicts, type NotesResult } from "./conflict-notes";
import { callTool, type CallDeps } from "./call-tool";
import type { ToolContext, ToolRegistry } from "./registry";
import type { Origin, ZoneEvaluationStore } from "./state";

export interface BranchTiming {
  branch: string;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  error?: string;
}

export interface Stage1Input {
  /** The user's turn, in their words. The gatherer routes on this. */
  prompt: string;
  header: HeaderFacts;
  /** Offset search radius. Bounded by the tool's own schema. */
  radiusFt?: number;
}

export interface Stage1Deps {
  registry: ToolRegistry;
  corpus: Corpus;
  model: GathererModel;
  ctx: ToolContext;
  maxSubQuestions?: number;
  now?: () => number;
}

export interface Stage1Result {
  gathered: GatherResult | null;
  timings: BranchTiming[];
  /** Branch names that failed. Empty on a clean fan-out. */
  failed: string[];
  /** Computed values that are not physically possible — i.e. a broken tool. */
  implausible: Implausibility[];
  /** What this question required, and what of it actually got computed. */
  requirements: RequirementsReport;
  /** Contradictions the gatherer flagged on the way out. */
  notes: NotesResult;
}

const origin = (branch: string): Origin => ({ stage: "stage1", branch });

export async function fanOut(
  store: ZoneEvaluationStore,
  input: Stage1Input,
  deps: Stage1Deps
): Promise<Stage1Result> {
  const now = deps.now ?? Date.now;
  const call: CallDeps = { store, registry: deps.registry, ctx: deps.ctx };
  const timings: BranchTiming[] = [];
  let gathered: GatherResult | null = null;

  const run = async (branch: string, fn: () => Promise<void>): Promise<void> => {
    const startedAt = now();
    try {
      await fn();
      timings.push({ branch, startedAt, endedAt: now(), ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      timings.push({ branch, startedAt, endedAt: now(), ok: false, error: message });
      store.addOpen(origin(branch), {
        question: `Context branch "${branch}" failed (${message}); the answer is missing what it would have found`,
        blocking: false,
      });
    }
  };

  await Promise.all([
    // The gatherer. Unconditional, and in the same hop as everything else.
    run("gatherer", async () => {
      const gatherDeps: GatherDeps = {
        corpus: deps.corpus,
        model: deps.model,
        registry: deps.registry,
        ctx: deps.ctx,
        store,
        maxSubQuestions: deps.maxSubQuestions,
        // The well, so the gatherer can write a lookup keyed on it rather than
        // guessing at arguments from the question text.
        subject: {
          api: input.header.api,
          name: input.header.name,
          operator: input.header.operator,
          county: input.header.county,
          district: input.header.district,
          latitude: input.header.latitude,
          longitude: input.header.longitude,
        },
      };
      gathered = await gather(input.prompt, gatherDeps);
      applyGathered(store, gathered);
    }),

    run("kb-lookup", async () => {
      const result = await callTool<KbLookupFacts>(call, origin("kb-lookup"), TOOL.kbLookup, {
        county: input.header.county,
        district: input.header.district,
      });
      for (const a of result.value.assumptions) {
        store.addAssumption(origin("kb-lookup"), {
          field: a.field,
          value: a.value,
          source: "default",
          basis: a.basis,
          overridable: true,
        });
      }
      for (const f of result.value.facts) {
        store.addEvidence(origin("kb-lookup"), { claim: f.claim, sourceId: f.sourceId, kind: "documented" });
      }
    }),

    run("calculators", async () => {
      const result = await callTool<CalculatorFacts>(call, origin("calculators"), TOOL.calculators, {});
      for (const v of result.value.values) store.addComputed(origin("calculators"), v);
    }),

    run("offsets", async () => {
      const { latitude, longitude } = input.header;
      if (latitude === null || longitude === null) {
        // Not a failure. A log with no surface location simply has no offsets to
        // find, and saying so is more useful than an empty result set.
        store.addOpen(origin("offsets"), {
          question: "No surface location in the LAS header, so no offset wells were retrieved",
          blocking: false,
        });
        return;
      }
      const result = await callTool<OffsetsFacts>(call, origin("offsets"), TOOL.offsetsWithinRadius, {
        latitude,
        longitude,
        radiusFt: input.radiusFt ?? DEFAULT_RADIUS_FT,
        limit: MAX_OFFSETS,
      });
      for (const o of result.value.offsets) {
        store.addOffset(origin("offsets"), {
          api: o.api,
          distanceFt: o.distanceFt,
          picks: o.picks.map((p) => ({
            formation: p.formation,
            // Every offset pick is stamped with the OFFSET's API, not the
            // subject well's. Filing one under the wrong well is the exact
            // mistake `inconsistencies()` looks for.
            depth: store.depth(p.depthFt, p.reference, { api: o.api }),
          })),
          dst: o.dst,
          datumResolved: o.datumResolved,
        });
      }
      if (result.value.truncated) {
        store.addOpen(origin("offsets"), {
          question: `Offset search hit its ${MAX_OFFSETS}-well limit; there are more wells inside the radius`,
          blocking: false,
        });
      }
    }),

    run("continuity", async () => {
      const result = await callTool<ContinuityFacts>(call, origin("continuity"), TOOL.continuityCheck, {});
      for (const f of result.value.findings) {
        store.addEvidence(origin("continuity"), {
          claim: f.description,
          sourceId: `continuity:${f.topFt ?? "?"}-${f.baseFt ?? "?"}`,
          kind: "measured",
        });
      }
    }),
  ]);

  // Runs after every branch has written, because the redundancy checks compare
  // values produced by different branches. A tool returning a plausible-looking
  // wrong number is the worst failure available to this system: it satisfies
  // every provenance rule and lands in an answer someone spends money on. This
  // catches it arithmetically instead of hoping the model notices.
  const implausible = checkPlausibility(store);

  // What the question obliges us to have computed. The largest failure in the
  // graded runs was arithmetic that never happened — the model cannot notice a
  // number it never thought to want, so the harness decides and tells it.
  const requirements = checkRequirements(store, input.prompt);

  // Last, because it reads everything the branches wrote — including the
  // arithmetic findings above. The gatherer flags what does not add up as it
  // hands off; there is no separate conflict stage and no escalated path.
  const notes = deps.model.noteConflicts
    ? await noteConflicts(store, (view) => deps.model.noteConflicts!(describeState(view)))
    : { conflicts: store.snapshot().conflicts, noted: [], error: null, malformed: 0 };

  return {
    gathered,
    timings,
    failed: timings.filter((t) => !t.ok).map((t) => t.branch),
    implausible,
    requirements,
    notes,
  };
}

/**
 * Land the gatherer's work in the state object.
 *
 * Chunks become `evidence` as DOCUMENTED, with their segment ID as the source —
 * that ID is what Fable cites and what a reader follows back to the page. Tool
 * results the gatherer pulled become `computed` when they carry a number.
 */
function applyGathered(store: ZoneEvaluationStore, result: GatherResult): void {
  for (const chunk of result.chunks) {
    store.addEvidence(origin("gatherer"), {
      claim: `${chunk.slug}: ${chunk.heading}`,
      sourceId: chunk.id,
      kind: "documented",
    });
  }
  // Dropping a hallucinated citation silently would leave the turn looking
  // better-sourced than it is.
  for (const slug of result.dropped.unknownDocuments) {
    store.addOpen(origin("gatherer"), {
      question: `Gatherer cited "${slug}", which is not in the corpus; that thread was dropped`,
      blocking: false,
    });
  }
  for (const failure of result.dropped.failedTools) {
    store.addOpen(origin("gatherer"), {
      question: `A lookup the gatherer asked for could not be run (${failure}); its context is missing`,
      blocking: false,
    });
  }
  if (result.dropped.overBudget > 0) {
    store.addOpen(origin("gatherer"), {
      question: `${result.dropped.overBudget} retrieved passages exceeded the context budget and were not passed on`,
      blocking: false,
    });
  }
}
