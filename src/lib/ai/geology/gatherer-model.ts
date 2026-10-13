/**
 * The live context gatherer: Sonnet navigating the two-level TOC.
 *
 * `gatherer.ts` owns the mechanism — opening files, verifying IDs, slicing
 * verbatim text, deduping, budgeting. This file is only the judgment: which
 * sub-questions, which documents, which segments, which extra tools.
 *
 * ## Lines, not JSON
 *
 * Same call as the conflict detector, for the same measured reason (see
 * conflict-model.ts): `generateObject` on Anthropic compiles a forced tool call
 * and Sonnet 5 intermittently mis-serializes its arguments. Here the outputs are
 * lists of identifiers, so a line per item is both more robust and cheaper —
 * there is no punctuation for the model to get wrong, and a mangled line costs
 * that line rather than the whole selection.
 *
 * ## What the model never sees
 *
 * It never sees the corpus text. It selects by CARD and by SEGMENT ENTRY — the
 * question-forms index — and the harness fetches the source. That is the whole
 * point of the TOC: the summaries are for navigation, and what reaches Fable is
 * the primary text.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { DocumentCard, SegmentEntry } from "./corpus";
import { CONFLICT_NOTES_SYSTEM } from "./conflict-notes";
import type { GathererModel, ToolRequest } from "./gatherer";

/*
 * No per-hop deadline, deliberately.
 *
 * These hops used to abort at 25 seconds, and every abort was a hop that had
 * nearly finished being thrown away — the corpus selection lost, the notes lost,
 * and the answer written with less than the library holds. A deadline only helps
 * if there is something better to do with the time, and here there is not: the
 * alternative to waiting is answering worse.
 *
 * The turn is still bounded, by `maxDuration` on the chat route. That is the
 * right place for it — one ceiling on the whole request rather than seven
 * guesses at how long each piece of it should be allowed to think.
 */
export const GATHERER_MODEL = "claude-sonnet-5";

/**
 * The noting hand-off thinks shallower than the selections.
 *
 * It reads the whole assembled evaluation rather than picking from a list, but
 * it does not need deep reasoning: the arithmetic contradictions are already
 * caught in code, and what is left is spotting semantic pairs that cannot both
 * hold. It is also the last thing before Fable starts, so it is the hop most
 * worth keeping cheap.
 */
export const NOTES_EFFORT = "low";

const SPLIT_SYSTEM = `You split an operator's question about a well into the distinct things that
have to be looked up to answer it.

Most questions are one thing and should come back as one line. Split only when
the question genuinely contains separate lookups — "is there pay here and will
it cone" is two: a saturation question and a coning question.

Write one sub-question per line, in the operator's own terms. No numbering, no
bullets, no commentary. Never more lines than you are asked for.`;

const DOCUMENTS_SYSTEM = `You are choosing which reference documents to open for one question.

You are given a catalogue of documents. Each card says what the document covers,
what it is authoritative for, what it is NOT good for, and its scope. Read
"Not good for" as seriously as the rest: it is what stops a gamma-ray primer
being opened for a saturation question.

Choose the documents whose authoritative topics actually bear on the question.
Two or three good ones beat eight loose ones.

Returning nothing is correct for a question this library does not cover — who
operates a lease, what a well produced last month, anything that is a record
rather than a method. It is the WRONG answer for anything about reading a log,
interpreting a curve, or a petrophysical quantity: this catalogue is a
petrophysics library, so it has something on those, and the answer is written
from what you choose here. When two documents are marginal, choose the better
one rather than neither.

Write one document slug per line, exactly as it appears after "###". Nothing
else: no numbering, no explanation, no slugs you did not see in the catalogue.`;

const SEGMENTS_SYSTEM = `You are choosing which sections to read for one question.

Each entry lists the QUESTIONS that section answers, plus the named things that
appear in it. Match against the questions — that is what the index is for.

Choose sections that answer this specific question. Prefer the section that
states a method, an equation, or a rule over one that merely mentions the topic.
Six sections is plenty; if fewer fit, choose fewer.

Write one section ID per line, exactly as given in backticks (like
"04-coning/coning-basics#1"). Nothing else.`;

const TOOLS_SYSTEM = `You are deciding what to look up for one question, so the analyst who answers
it does not have to stop and look things up themselves.

When the well is identified below, the Texas public record around it is almost
always worth having: the well's own record, how the offsets nearby were
completed, and what they produced. That context is what turns a log reading into
a conclusion, and pulling it now is far cheaper than the analyst pulling it
later, one call at a time, mid-answer.

Ask for nothing only when the question genuinely needs nothing — a question
about method rather than about this well.

Each entry is written as name(required arguments). Supply every argument in the
parentheses — a lookup missing one is refused and its context is lost.

Write one line per lookup, as: name key=value key=value
Use only names from the list. Nothing else.`;

/**
 * What the gatherer spent, so the caller can bill it.
 *
 * The gatherer makes five to eight Sonnet calls a turn and none of them were
 * metered: it is buried three layers below the chat route, which is where the
 * Supabase client lives, so there was nowhere to charge from. Rather than push
 * a billing dependency down here, the hops add to a tally the caller owns and
 * the route meters once at the end — one ledger row per turn instead of eight,
 * which also keeps the ≥1 credit floor from rounding up seven times.
 *
 * Mutable and shared by reference on purpose. A turn's hops run concurrently
 * (`Promise.all` over sub-questions), and `+=` on a number is atomic under the
 * single-threaded event loop, so no coordination is needed.
 */
export interface GathererUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Model calls made. Diagnostic only: a turn reporting 0 never asked Sonnet. */
  calls: number;
}

export function newGathererUsage(): GathererUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 };
}

/**
 * @param usage Filled in as the hops run. Omit it and the calls go unmetered —
 * which is what the tests want and what production must never do.
 */
export function sonnetGathererModel(usage?: GathererUsage): GathererModel {
  const ask = (system: string, user: string, maxOutputTokens: number, opts?: { effort?: string }) =>
    askSonnet(system, user, maxOutputTokens, opts, usage);
  return {
    async splitQuestion(prompt, max) {
      const text = await ask(
        SPLIT_SYSTEM,
        `Question: ${prompt}\n\nSplit into at most ${max} sub-questions, one per line.`,
        1_000
      );
      return lines(text).slice(0, max);
    },

    async selectDocuments(subQuestion, cards) {
      if (cards.length === 0) return [];
      const text = await ask(
        DOCUMENTS_SYSTEM,
        `Question: ${subQuestion}\n\n<catalogue>\n${renderCards(cards)}\n</catalogue>`,
        1_500
      );
      // Verified again in gatherer.ts against the real slugs; this only trims
      // obvious noise so a stray sentence does not become a "dropped citation".
      return lines(text)
        .map(stripBullet)
        // "none" and "empty" ARE the answer when nothing in the catalogue fits,
        // and both pass a slug-shaped test. Left in, each became a phantom
        // dropped citation in the trace and an open item in the brief.
        .filter((l) => /^[a-z0-9-]+$/i.test(l) && !/^(none|empty|nothing|null|n\/?a)$/i.test(l));
    },

    async selectSegments(subQuestion, entries) {
      if (entries.length === 0) return [];
      const text = await ask(
        SEGMENTS_SYSTEM,
        `Question: ${subQuestion}\n\n<sections>\n${renderEntries(entries)}\n</sections>`,
        1_500
      );
      return lines(text).map(stripBullet).filter((l) => /#\d+$/.test(l));
    },

    async requestTools(subQuestion, available, subject) {
      if (available.length === 0) return [];
      // The well, spelled out. A lookup keyed on an API number cannot be written
      // by something that was only shown the question text.
      const who = subject
        ? "\n\nThe well this turn is about:\n" +
          Object.entries(subject)
            .filter(([, v]) => v !== null && v !== undefined && v !== "")
            .map(([k, v]) => `${k}=${String(v)}`)
            .join("\n")
        : "";
      const text = await ask(
        TOOLS_SYSTEM,
        `Question: ${subQuestion}${who}\n\nAvailable lookups:\n${available.join("\n")}`,
        800
      );
      const names = new Set(available.map((a) => a.replace(/\(.*$/, "")));
      const out: ToolRequest[] = [];
      for (const line of lines(text).map(stripBullet)) {
        const parsed = parseRequest(line, names);
        if (parsed) out.push(parsed);
      }
      return out;
    },

    async noteConflicts(renderedState) {
      return ask(
        CONFLICT_NOTES_SYSTEM,
        `<well-evaluation>\n${renderedState}\n</well-evaluation>`,
        4_000,
        { effort: NOTES_EFFORT }
      );
    },
  };
}

async function askSonnet(
  system: string,
  user: string,
  maxOutputTokens: number,
  opts: { effort?: string } = {},
  tally?: GathererUsage
): Promise<string> {
  const { text, usage } = await generateText({
    model: anthropic(GATHERER_MODEL),
    maxOutputTokens,
    maxRetries: 1,
    providerOptions: { anthropic: { effort: opts.effort ?? "medium" } },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (tally) {
    // `inputTokens` already includes cache reads, matching what `meterAnthropic`
    // expects; `cachedInputTokens` is carried separately for the cost record.
    tally.inputTokens += usage.inputTokens ?? 0;
    tally.outputTokens += usage.outputTokens ?? 0;
    tally.cacheReadTokens += usage.cachedInputTokens ?? 0;
    tally.calls += 1;
  }
  return text;
}

/**
 * Level 1, as the model sees it.
 *
 * `notGoodFor` is included deliberately: it is the field that prevents the wrong
 * document being opened, and leaving it out to save tokens would remove the one
 * thing that makes a card a routing decision rather than a description.
 */
function renderCards(cards: DocumentCard[]): string {
  return cards
    .map((c) =>
      [
        `### ${c.slug}`,
        `covers: ${c.covers}`,
        `authoritative for: ${c.authoritativeFor.join("; ")}`,
        `not good for: ${c.notGoodFor.join("; ")}`,
        `scope: ${c.scope}`,
      ].join("\n")
    )
    .join("\n\n");
}

/** Level 2. Question-forms first, because that is what routing matches on. */
function renderEntries(entries: SegmentEntry[]): string {
  return entries
    .map((e) => {
      const out = [`\`${e.id}\` ${e.heading}`];
      if (e.answers.length) out.push(`  answers: ${e.answers.join(" · ")}`);
      if (e.entities.length) out.push(`  mentions: ${e.entities.slice(0, 12).join(", ")}`);
      if (e.equations.length) out.push(`  equations: ${e.equations.join(", ")}`);
      return out.join("\n");
    })
    .join("\n");
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(none|nothing|n\/a)$/i.test(l));
}

/**
 * Strips list markers and backticks the model adds despite instructions.
 *
 * The marker must be followed by whitespace. A greedy `^[-*\d.)\s]+` eats the
 * leading digits of the content itself — every corpus section is numbered
 * (`01-curve-reading`, `04-coning`), so it turned every segment ID into one the
 * verifier would reject as nonexistent. Silent, and it would have emptied every
 * citation against the real corpus.
 */
function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*\u2022]\s+|\d+[.)]\s+)/, "").replace(/`/g, "").trim();
}

/** `key=value key="two words"` — the only argument shape the gatherer needs. */
/**
 * One requested lookup, in either form the model writes it.
 *
 * The instruction says `name key=value key=value`, and the model writes
 * `rrc_well(api=42-429-33846)` — because the catalog above it lists signatures
 * with parentheses, so mirroring them is the natural thing to do. The parser
 * accepted only the first form, so every request was dropped on the floor and
 * the gatherer looked like it had decided to fetch nothing. Accept both; the
 * shape of the line was never the point.
 */
export function parseRequest(
  line: string,
  known: Set<string>
): { name: string; args: Record<string, string | number> } | null {
  const paren = /^([a-z_][\w]*)\s*\(([^)]*)\)\s*$/i.exec(line.trim());
  if (paren && known.has(paren[1])) {
    return { name: paren[1], args: parseArgs(paren[2].split(/[,\s]+/)) };
  }
  const [name, ...rest] = line.trim().split(/\s+/);
  return known.has(name) ? { name, args: parseArgs(rest) } : null;
}

function parseArgs(parts: string[]): Record<string, string | number> {
  const args: Record<string, string | number> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const raw = part.slice(eq + 1).replace(/^["']|["']$/g, "");
    // An empty value would only fail the tool's own schema a moment later, with
    // a worse message than simply not being sent.
    if (!raw) continue;
    args[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return args;
}

/** Exported for tests: the parsing half, which is where the bugs live. */
export const __test = { stripBullet, lines, parseArgs, parseRequest };
