/**
 * Conflict notes — the gatherer flags what does not add up when it hands off.
 *
 * This replaces a dedicated Sonnet stage that sat on the critical path of every
 * turn at a measured 14 seconds. Contradictions are worth naming, but they do
 * not need their own agent, their own hop, or an escalated three-persona path:
 * the gatherer has already assembled the context, so it is the natural place to
 * say "these two things disagree" on the way out.
 *
 * What survives from the stage it replaces:
 *
 *   - The DETERMINISTIC findings still stand on their own. A datum disagreement
 *     or an impossible value was proved arithmetically by Stage 0/1 and is in
 *     `conflicts[]` before this runs. Nothing here can un-find one.
 *   - NO HISTORY. The note-taker sees the assembled facts and nothing else — no
 *     question, no conversation. A confidently phrased question is not evidence.
 *   - LINES, NOT JSON. Measured: `generateObject` against Sonnet 5 mis-serialized
 *     its forced-tool arguments on 8-11 of 16 calls. A line format has no bracket
 *     to balance and no quote to escape, so a mangled line costs that line.
 *   - FAILURE IS NOT FATAL. If the note-taker errors, the turn carries on with
 *     whatever the deterministic checks already found. It never blocks an answer.
 */
import { z } from "zod";
import type {
  Conflict,
  Origin,
  ZoneEvaluation,
  ZoneEvaluationStore,
} from "./state";

const ORIGIN: Origin = { stage: "stage1", branch: "gatherer" };

export const detectedConflictSchema = z.object({
  description: z.string().min(1),
  /** The incompatible readings. Two or more, or it is not a conflict. */
  branches: z.array(z.string()).min(2),
  /** The one document that would collapse it, when there is one. */
  resolvingDocument: z.string().nullable(),
});
export type DetectedConflict = z.infer<typeof detectedConflictSchema>;

/**
 * Everything the note-taker sees. Note what is absent: the user's prompt, the
 * conversation, and the gathered passages. It is judging whether the FACTS
 * disagree.
 */
export interface ConflictView {
  well: ZoneEvaluation["well"];
  datum: ZoneEvaluation["datum"];
  interval: ZoneEvaluation["interval"];
  curves: ZoneEvaluation["curves"];
  computed: ZoneEvaluation["computed"];
  assumptions: ZoneEvaluation["assumptions"];
  offsets: ZoneEvaluation["offsets"];
  evidence: ZoneEvaluation["evidence"];
  refusals: ZoneEvaluation["refusals"];
  open: ZoneEvaluation["open"];
  /** What the deterministic stages already proved. Cannot be un-found. */
  alreadyFound: ZoneEvaluation["conflicts"];
}

export interface NotesResult {
  conflicts: readonly Conflict[];
  /** Only what the note-taker added. */
  noted: DetectedConflict[];
  /** Set when it failed. The turn carries on regardless. */
  error: string | null;
  /** Claims that were not conflicts at all. Dropped, never repaired. */
  malformed: number;
}

/** Strips the prompt and the conversation by construction, not by trimming. */
export function conflictView(state: ZoneEvaluation): ConflictView {
  return {
    well: state.well,
    datum: state.datum,
    interval: state.interval,
    curves: state.curves,
    computed: state.computed,
    assumptions: state.assumptions,
    offsets: state.offsets,
    evidence: state.evidence,
    refusals: state.refusals,
    open: state.open,
    alreadyFound: state.conflicts,
  };
}

/**
 * Ask the gatherer to note contradictions, and record what it finds.
 *
 * `note` returns raw text; parsing and validation stay here, so a model that
 * returns something odd costs a line rather than the turn.
 */
export async function noteConflicts(
  store: ZoneEvaluationStore,
  note: (view: ConflictView) => Promise<string>
): Promise<NotesResult> {
  const before = store.snapshot();

  let raw: DetectedConflict[];
  try {
    raw = parseConflicts(await note(conflictView(before)));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Not fatal, and not escalation-worthy. The deterministic findings already
    // in `conflicts[]` are what the answer leans on.
    store.addOpen(ORIGIN, {
      question: `Conflict noting did not complete (${message}); only the checks proved in code are recorded`,
      blocking: false,
    });
    return { conflicts: before.conflicts, noted: [], error: message, malformed: 0 };
  }

  const noted: DetectedConflict[] = [];
  let malformed = 0;
  const seen = new Set(before.conflicts.map((c) => normalize(c.description)));

  for (const candidate of raw) {
    const parsed = detectedConflictSchema.safeParse(candidate);
    // One branch is a caveat, not a contradiction.
    if (!parsed.success) {
      malformed++;
      continue;
    }
    const key = normalize(parsed.data.description);
    if (seen.has(key)) continue;
    seen.add(key);
    noted.push(parsed.data);
    store.addConflict(ORIGIN, parsed.data);
  }

  return { conflicts: store.snapshot().conflicts, noted, error: null, malformed };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export const CONFLICT_NOTES_SYSTEM = `You are checking whether the facts gathered about one well CONTRADICT each other.

You are given a structured evaluation of a single well and nothing else — no
question, no conversation, no prior turns. You are not answering anything. You
are looking for pairs of facts that cannot both be true, or that support
incompatible conclusions.

FLAG ON SUSPICION. A note costs nothing. A missed contradiction ends up inside an
analysis an operator spends money on. When you are unsure whether two things
genuinely conflict, note it.

Kinds of thing that are conflicts — examples, NOT an exhaustive list:

- Two datums disagreeing, or a depth compared across wells on different references
- Two viable readings of the same document producing incompatible geometry
- A saturation reported as a number when Rw was never measured
- An offset contact projection contradicting the local log character
- A computed value outside a physical range: porosity above 0.45 or below 0,
  saturation or shale volume outside 0-1, negative resistivity, a bulk density
  outside 1.0-3.2 g/cc, a negative thickness or standoff
- A value whose unit says fraction (v/v) but whose magnitude reads as a percent
- Two independently derived values that must agree and do not: crossplot porosity
  outside the density and neutron pair it came from, a standoff that disagrees
  with the subsea difference, an offset distance inconsistent with its location
- A value that cannot follow from the inputs and method recorded beside it
- An assumption doing load-bearing work that the evidence does not support
- Evidence recorded as measured that traces back to something a person said

Anything already listed as ALREADY-FOUND is known. Do not repeat it.

Each conflict needs at least TWO sides: the incompatible readings, stated
concretely enough that a reader can tell them apart. If you cannot name two
sides, it is a caveat, not a conflict, and you should leave it out.

## Output format

For each conflict, write a block exactly like this:

CONFLICT
what: one sentence naming the contradiction
side: the first reading
side: the competing reading
resolves: the one document that would settle it, or "unknown"

Repeat the block for each conflict. If nothing contradicts, write exactly:

NONE

Write nothing else. No preamble, no summary, no markdown formatting.`;

export function describe(view: ConflictView): string {
  const out: string[] = [];
  const d = view.datum;
  out.push(`WELL ${view.well.api}${view.well.name ? ` (${view.well.name})` : ""}`);
  out.push(
    `DATUM ${d.resolved ? "resolved" : "UNRESOLVED"}` +
      `${d.kbFt !== null ? ` kb=${d.kbFt}ft` : ""}${d.glFt !== null ? ` gl=${d.glFt}ft` : ""}` +
      `${d.reference ? ` ref=${d.reference}` : ""}${d.source ? ` source="${d.source}"` : ""}`
  );
  if (view.interval) {
    out.push(`INTERVAL ${view.interval.topMd.ft}-${view.interval.baseMd.ft}ft ${view.interval.topMd.reference}`);
  }
  for (const c of view.curves) {
    out.push(`CURVE ${c.mnemonicRaw}${c.mnemonicCanonical ? ` -> ${c.mnemonicCanonical}` : " UNRECOGNIZED"}${c.unit ? ` [${c.unit}]` : ""}`);
  }
  for (const c of view.computed) {
    const value = typeof c.value === "object" ? `${c.value.low}-${c.value.high}` : String(c.value);
    const inputs = c.inputs
      .map((i) => `${i.name}=${String(i.value)}${i.source ? `(from ${i.source})` : "(NO SOURCE)"}`)
      .join(" ");
    out.push(`COMPUTED ${c.field}=${value}${c.unit ? c.unit : ""} method="${c.method}" inputs: ${inputs}`);
  }
  for (const a of view.assumptions) {
    out.push(`ASSUMPTION ${a.field}=${a.value} basis="${a.basis}" (${a.source})`);
  }
  for (const o of view.offsets) {
    out.push(`OFFSET ${o.api} at ${o.distanceFt}ft datum=${o.datumResolved ? "resolved" : "UNRESOLVED"}`);
    for (const p of o.picks) out.push(`  PICK ${o.api} ${p.formation} ${p.depth.ft}ft ${p.depth.reference}`);
    for (const t of o.dst) out.push(`  DST ${o.api} ${t.interval}: ${t.result}`);
  }
  for (const e of view.evidence) out.push(`EVIDENCE [${e.kind}] ${e.claim} (source: ${e.sourceId})`);
  for (const r of view.refusals) out.push(`REFUSED ${r.gate} by ${r.tool}: ${r.reason} (remedy: ${r.remedy})`);
  for (const o of view.open) out.push(`OPEN${o.blocking ? " BLOCKING" : ""} ${o.question}`);
  for (const c of view.alreadyFound) out.push(`ALREADY-FOUND ${c.description}`);
  return out.join("\n");
}

/**
 * Parse the line format.
 *
 * Tolerant line by line: unknown lines are ignored, a block missing two sides is
 * dropped, and prose around the blocks costs nothing. Nothing here can be broken
 * by a quote, a comma, or a truncated tail — the worst a mangled reply can do is
 * lose the block it mangled.
 */
export function parseConflicts(text: string): DetectedConflict[] {
  const out: DetectedConflict[] = [];
  let what = "";
  let sides: string[] = [];
  let resolves: string | null = null;
  let open = false;

  const flush = () => {
    if (open && what && sides.length >= 2) {
      out.push({ description: what, branches: sides, resolvingDocument: resolves });
    }
    what = "";
    sides = [];
    resolves = null;
  };

  for (const raw of text.split("\n")) {
    // Strip any markdown the model added despite being told not to.
    const line = raw.replace(/^[\s>*#-]+/, "").trim();
    if (!line) continue;

    if (/^conflict\b/i.test(line)) {
      flush();
      open = true;
      continue;
    }
    if (!open) continue;

    const m = /^(what|side|resolves)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    if (!value) continue;

    switch (m[1].toLowerCase()) {
      case "what":
        // A second `what:` means the model ran two blocks together.
        if (what) {
          flush();
          open = true;
        }
        what = value;
        break;
      case "side":
        sides.push(value);
        break;
      case "resolves":
        resolves = /^(unknown|none|n\/a)$/i.test(value) ? null : value;
        break;
    }
  }
  flush();

  // Strict about contents even though the envelope is forgiving.
  return out.filter((c) => detectedConflictSchema.safeParse(c).success);
}
