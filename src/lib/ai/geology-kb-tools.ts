/**
 * The petrophysics reference library, made readable by ordinary Orion.
 *
 * The corpus used to be reachable only through the geology harness. Whenever the
 * harness declined — the router labelled a subsurface turn `general`, no log was
 * in scope, the flag was off, the tool layer was down — Orion answered the same
 * question from model memory, with no library and no citation trail, and the
 * reply looked identical either way. These three tools close that hole.
 *
 * ## Navigation, not search
 *
 * The library is 90 documents and 9 MB of index. Keyword search over that
 * returns passages that share a word with the question, which is not the same as
 * passages that ANSWER it — and the corpus already carries a better signal.
 * `build_toc.py` wrote, per segment, the list of questions that segment answers.
 * So the route here is the corpus's own two-level shape:
 *
 *   geology_kb_index     which document, from what each one is authoritative for
 *   geology_kb_segments  which segment, from the questions it answers
 *   geology_kb_read      that segment, verbatim
 *
 * ## Verbatim, and hash-checked
 *
 * `Corpus.read` verifies the document hash before slicing, so a rebuilt corpus
 * with a stale TOC raises rather than returning a plausible passage from the
 * wrong offsets. Nothing here rewrites, trims or summarises the text it returns:
 * a summarised chunk is an unattributable claim by the time the model reads it.
 *
 * ## Read-only by construction
 *
 * Every execute path is a file read. There is nothing to gate on ownership and
 * nothing to approve — which is also why `orion-bridge` skips these by name
 * rather than letting them cross into the harness, where the gatherer owns
 * corpus access and records what it read.
 *
 * ## And one tool that runs the other way
 *
 * The three above are consulted AFTER somebody has decided where to look.
 * `geology_play_extent` is consulted before: it reads the same corpus as a map,
 * and answers where a play is described and at what depth, so the rock sets the
 * search extent instead of a circle drawn around one well. See
 * `docs/plans/geology-rrc-screening.md` item 8.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import {
  CorpusError,
  corpusRoot,
  openCorpus,
  type Corpus,
  type DocumentCard,
  type SegmentEntry,
} from "@/lib/ai/geology/corpus";
import { COUNTY_OPTIONS } from "@/lib/scout/counties";
import { resolveCounty } from "@/lib/scout/rrc-queries";

/** Uniform "the library isn't on disk here" answer, rather than a throw. */
const NOT_CONFIGURED = {
  ok: false as const,
  error:
    "The petrophysics reference library is not present in this environment " +
    "(no geology-corpus/toc/TOC.md). Answer from your own knowledge and say " +
    "plainly that you could not consult the library.",
};

/**
 * A cap, not a page size.
 *
 * The largest document has 248 segments and its index file is 290 KB — returned
 * whole it would be most of a context window spent on a menu. Everything past
 * the cap is reported as a count, never dropped silently: a quiet cut reads as
 * "that is all there is", which is worse than no answer.
 */
const MAX_SEGMENTS = 40;

/**
 * The library is a capability, not a catalogue, and this is the enforcement.
 *
 * `geology_kb_index` used to answer an argument-less call with every document
 * card and the full section list — the entire shape of the collection, in one
 * tool result, for the asking. The curation is the asset (see `LIBRARY_PRIVACY`
 * in `system-prompt.ts`), and a prompt rule cannot hold a line the tool has
 * already crossed: once an inventory is in the model's context, a user
 * persistent enough will get it back out.
 *
 * So the index is a LOOKUP now rather than a listing. It answers "what do you
 * have on shaly sand" and refuses "what do you have". That is also how a model
 * should be using it — nobody picks a document by reading ninety cards — so the
 * narrowing costs nothing an unfiltered call was actually buying.
 *
 * The cap is separate from the filter and does the same job from the other end:
 * a filter broad enough to match everything ("e", "the") would otherwise be an
 * inventory with extra steps.
 */
const MAX_DOCUMENTS = 12;

const NEEDS_A_SUBJECT = {
  ok: false as const,
  error:
    "The library is not browsable. Say what you need it for and it will return " +
    "the documents that bear on that: `matching` takes a subject ('shaly sand', " +
    "'liquid loading', 'decline'), `section` takes one you already know.",
  note:
    "This is deliberate, not a fault, and it is not worth mentioning to the " +
    "user. Search it for the subject you are actually working on.",
};

/** Attached to every result, next to the thing it governs. */
const PRIVATE =
  "INTERNAL. This is the app's own reference material. Use what it says and " +
  "attribute a method to its published source where the text gives one, but do " +
  "not repeat these document ids to the user, and never present any of this as " +
  "a list of what the library holds.";

function open(): Corpus | null {
  return openCorpus();
}

/**
 * Case-insensitive substring match across the fields worth matching on.
 *
 * The separator is a newline so a needle cannot match ACROSS two fields — the
 * end of `covers` running into the start of `authoritativeFor` is not a hit.
 * It was a literal NUL byte, which worked and made the whole file read as
 * binary: `grep` and `sed` skipped it silently, so every search over this
 * source came back empty as though the code did not exist.
 */
function matches(needle: string | undefined, ...fields: (string | string[])[]): boolean {
  if (!needle) return true;
  const hay = fields.flat().join("\n").toLowerCase();
  return hay.includes(needle.trim().toLowerCase());
}

/** The one-line form: enough to choose a document, not enough to drown in. */
function slimCard(c: DocumentCard) {
  return {
    document: `${c.section}/${c.slug}`,
    covers: c.covers,
    segments: c.segments,
  };
}

/** The full card, for when the caller has narrowed to a section. */
function fullCard(c: DocumentCard) {
  return {
    ...slimCard(c),
    authoritativeFor: c.authoritativeFor,
    notGoodFor: c.notGoodFor,
    scope: c.scope,
  };
}

/**
 * `Answers` is the field that makes selection non-blind — it is the list of
 * questions the segment was indexed as answering. `entities` is dropped: it is
 * the longest field and the least selective (author names, figure numbers).
 */
function slimSegment(s: SegmentEntry) {
  return {
    ref: s.id,
    heading: s.heading,
    answers: s.answers,
    equations: s.equations,
  };
}

/** A corpus failure is an answer, not an exception: the turn continues without it. */
function failed(err: unknown) {
  return {
    ok: false as const,
    error:
      err instanceof CorpusError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err),
  };
}

export function geologyKbTools() {
  return {
    geology_kb_index: tool({
      description:
        "Look up which documents in the app's internal petrophysics and geology reference library bear on a SUBJECT: log reading, Archie and shaly-sand saturation, porosity, DST, coning, liquid loading, gas deliverability, perforating, decline curves, cement integrity, Fort Worth Basin / Bend Arch geology. START HERE for any subsurface question. Each result says what the document covers, what it is authoritative FOR and what it is NOT good for — pick from those, then call geology_kb_segments on the one you chose. Do not answer a petrophysics question from memory when the library is authoritative for it. This is a lookup, not a browsable catalogue: pass the subject you are working on. It holds INTERNAL material — use what it says, but never relay its contents to the user as a list of what the library holds.",
      inputSchema: z.object({
        section: z
          .string()
          .optional()
          .describe(
            "narrow to one section you already know, e.g. '01-curve-reading'. Returns the full card (authoritative-for, not-good-for, scope) for each document in it."
          ),
        matching: z
          .string()
          .optional()
          .describe(
            "the subject to look up, matched over the document's name and its covers/authoritative-for text, e.g. 'shaly sand' or 'liquid loading'. Required unless `section` is given."
          ),
      }),
      execute: async ({ section, matching }) => {
        const kb = open();
        if (!kb) return NOT_CONFIGURED;
        // No subject, no answer. An argument-less call is the inventory request,
        // whether it came from a curious model or a user working through one.
        if (!section?.trim() && !matching?.trim()) return NEEDS_A_SUBJECT;
        try {
          const cards = await kb.documentCards();
          const picked = cards.filter(
            (c) =>
              (!section || c.section === section.trim()) &&
              matches(matching, c.slug, c.covers, c.authoritativeFor)
          );
          // The section list is the library's skeleton, so it is not returned.
          // Nor is the unmatched total: "12 of 90" is most of what someone
          // enumerating wants to know.
          return {
            ok: true as const,
            documents: picked.slice(0, MAX_DOCUMENTS).map(section ? fullCard : slimCard),
            ...(picked.length > MAX_DOCUMENTS
              ? {
                  note: `Showing ${MAX_DOCUMENTS} documents that bear on this. Narrow \`matching\` if none of them is right.`,
                }
              : {}),
            private: PRIVATE,
            next: "geology_kb_segments(document) lists that document's segments and the questions each one answers.",
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    geology_kb_segments: tool({
      description:
        "The segment list for ONE document in the reference library, from geology_kb_index. Every segment carries the questions it answers and the equations it contains, so choose by those rather than by heading alone. Returns a `ref` per segment to pass to geology_kb_read. Long documents are capped — narrow with `matching` (it filters on the answered questions and equations) rather than paging blindly.",
      inputSchema: z.object({
        document: z
          .string()
          .describe("'section/slug' exactly as geology_kb_index returned it, e.g. '01-curve-reading/asquith-krygowski-basic-well-log-analysis-2004'"),
        matching: z
          .string()
          .optional()
          .describe("substring filter over headings, answered questions and equations, e.g. 'Larionov' or 'bubble point'"),
      }),
      execute: async ({ document, matching }) => {
        const kb = open();
        if (!kb) return NOT_CONFIGURED;
        const [section, ...rest] = document.trim().split("/");
        const slug = rest.join("/");
        if (!section || !slug) {
          return {
            ok: false as const,
            error: `"${document}" is not a document id. Want 'section/slug', as geology_kb_index returns it.`,
          };
        }
        try {
          const entries = await kb.detail(section, slug);
          const hits = entries.filter((e) =>
            matches(matching, e.heading, e.answers, e.equations, e.entities)
          );
          const card = await kb.card(slug);
          return {
            ok: true as const,
            document,
            ...(card ? { scope: card.scope, notGoodFor: card.notGoodFor } : {}),
            matched: hits.length,
            total: entries.length,
            truncated: hits.length > MAX_SEGMENTS,
            segments: hits.slice(0, MAX_SEGMENTS).map(slimSegment),
            private: PRIVATE,
            ...(hits.length > MAX_SEGMENTS
              ? {
                  note: `Showing the first ${MAX_SEGMENTS} of ${hits.length} matching segments. Narrow with \`matching\` — the rest were NOT searched away, they are simply not shown.`,
                }
              : {}),
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    geology_kb_read: tool({
      description:
        "Read one segment of the reference library verbatim, by the `ref` geology_kb_segments returned (e.g. '01-curve-reading/asquith-krygowski-basic-well-log-analysis-2004#12'). This is source text, not a summary — quote or paraphrase it as the published method it is, and honour the document's `scope` and `notGoodFor`, which come back with it. A 1983 chartbook and a 2004 textbook can both be right about their own era and wrong about each other's, and the scope line is how you tell.",
      inputSchema: z.object({
        ref: z.string().describe("'section/slug#index', exactly as geology_kb_segments returned it"),
      }),
      execute: async ({ ref }) => {
        const kb = open();
        if (!kb) return NOT_CONFIGURED;
        try {
          const chunk = await kb.read(ref);
          const card = await kb.card(chunk.slug);
          return {
            ok: true as const,
            ref: chunk.id,
            document: `${chunk.section}/${chunk.slug}`,
            heading: chunk.heading,
            ...(card ? { scope: card.scope, notGoodFor: card.notGoodFor } : {}),
            text: chunk.text,
            private: PRIVATE,
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),
  };
}

/* ------------------------------------------------------------------ *
 * The play extent: the same corpus, read as a map instead of a library.
 * ------------------------------------------------------------------ */

/**
 * Where does this rock actually EXIST, and how deep is it — asked of the
 * literature, before a radius is chosen.
 *
 * Every geological tool downstream is anchored to a point and takes the nearest
 * N wells from it, so the population is decided by a circle somebody invented
 * and the geology is only consulted afterwards, to explain what the circle
 * caught. That is backwards. A play has an extent, the corpus states it in
 * plain words, and reading it first is what turns "wells near Repass 2" into
 * "wells where this zone is present".
 *
 * This returns EVIDENCE, never a verdict. Counties come back with the number of
 * passages that named them, depths as a distribution with the quotes they were
 * pulled from, and a handful of excerpts so the model can read the source
 * instead of trusting the extraction. A single county with one mention and a
 * county with forty are both true statements about the literature, and only the
 * count tells them apart.
 */

/**
 * Deliberately not a search box.
 *
 * A one- or two-character needle is the enumeration request `NEEDS_A_SUBJECT`
 * refuses on the other tools, wearing a different hat, so it is refused here on
 * the same grounds. The caps below finish the job: no call returns the shape of
 * the collection, and none reports how many documents were read.
 */
const MIN_PLAY_TERM = 3;

/** Texas has 254 counties; a play that spans two dozen is already regional. */
const MAX_COUNTIES = 24;

/** Enough excerpts to read the evidence, not enough to page through the corpus. */
const MAX_EXCERPTS = 5;
const MAX_DEPTH_QUOTES = 6;

/**
 * The band a figure has to fall in to be a drilling depth at all.
 *
 * Below ~300 ft prose is almost always talking about a bed thickness or an
 * outcrop, and Texas's deepest wells stop well short of 25,000 ft. This is a
 * coarse sieve over OCR'd text, not a claim about the play.
 */
const DEPTH_MIN_FT = 300;
const DEPTH_MAX_FT = 25_000;

const NEEDS_A_PLAY = {
  ok: false as const,
  error:
    "Name the play, formation or zone: 'Bend Arch', 'Marble Falls', 'Caddo', " +
    "'Strawn'. This reads the library for where that rock is described, so it " +
    "needs the rock. It is not browsable and it does not take a blank term.",
  note:
    "This is deliberate, not a fault, and it is not worth mentioning to the " +
    "user. Ask it about the formation you are actually screening on.",
};

/**
 * The gazetteer, keyed for lookup. Imported, never re-listed: the RRC's county
 * table is the same one every screening query joins on, so a name that resolves
 * here is a name the mirror can be asked about, and one that does not resolve
 * is not a Texas county no matter how capitalised the OCR left it.
 */
const COUNTY_BY_NAME = new Map(COUNTY_OPTIONS.map((c) => [c.name.toLowerCase(), c.name]));

/** The longest county name is two words ("Palo Pinto", "Val Verde", "Deaf Smith"). */
const COUNTY_WORDS = 2;

/**
 * Anchor on the word "County", then walk backwards through the gazetteer.
 *
 * A capitalised word before "County" is not a test — this corpus is OCR'd
 * mid-century prose full of "Bend County line" style noise, and half the Texas
 * gazetteer is ordinary English besides ("Brown", "Young", "Wise", "Real",
 * "Live Oak"). So the name must BE a county, and the walk continues backwards
 * across commas and "and" so that "Brown, Coleman, and Callahan Counties"
 * yields three, which is the form a paper states a play's extent in.
 *
 * Two words are tried before one, or "Palo Pinto County" returns Pinto, which
 * is not a county, and loses Palo Pinto, which is.
 *
 * The walk continues ONLY past a plural anchor, and grammar is the reason: a
 * list of counties is written "Counties", so a singular "County" is preceded by
 * exactly one name and anything before it belongs to the previous clause.
 * Measured on this corpus, dropping that rule reads "the Texas Company, Parks
 * Camp, Stephens County" as evidence for Camp County, 300 miles away.
 */
const COUNTY_ANCHOR = /\bcount(?:y|ies)\b/gi;
const COUNTY_JOIN = /(?:\s*,\s*|\s+and\s+|\s*&\s*|\s+)$/;
const COUNTY_WORD = /[A-Za-z][A-Za-z.'’-]*/g;

function countiesIn(passage: string): Set<string> {
  const found = new Set<string>();
  COUNTY_ANCHOR.lastIndex = 0;
  let anchor: RegExpExecArray | null;
  while ((anchor = COUNTY_ANCHOR.exec(passage))) {
    let end = anchor.index;
    // A list has to terminate: 12 is far past the longest county enumeration
    // in this corpus and stops a pathological string from walking a whole page.
    const steps = anchor[0].toLowerCase() === "counties" ? 12 : 1;
    for (let step = 0; step < steps; step++) {
      const window = passage.slice(Math.max(0, end - 34), end);
      const join = COUNTY_JOIN.exec(window);
      if (!join) break;
      const upto = window.slice(0, join.index);
      const words = [...upto.matchAll(COUNTY_WORD)];
      let start = -1;
      let name: string | undefined;
      for (let take = COUNTY_WORDS; take >= 1 && !name; take--) {
        const parts = words.slice(-take);
        if (parts.length < take) continue;
        // Only adjacent words form a name: "in Brown" must not become a lookup
        // for "in brown", and a comma between them ends the candidate.
        const spanned = upto.slice(parts[0].index, upto.length);
        if (/[^A-Za-z.'’ -]/.test(spanned)) continue;
        name = COUNTY_BY_NAME.get(spanned.toLowerCase());
        if (name) start = parts[0].index;
      }
      if (!name || start < 0) break;
      found.add(name);
      end = Math.max(0, end - (window.length - join.index) - (upto.length - start));
    }
  }
  return found;
}

/**
 * A depth figure, with an optional range partner ("3,100 to 3,200 ft").
 *
 * The bare foot mark is NOT accepted as a unit. `1950's` and `1920's` are all
 * over a corpus of boom-era field histories, and every one of them parses as a
 * plausible depth; requiring "ft" or "feet" costs a handful of real figures and
 * removes an entire class of confident nonsense.
 *
 * The lookbehind is what stops a longer number being read from its middle: with
 * no left boundary, "123456 ft" matches as 23456, which is inside the plausible
 * band and therefore invisible once it is a number.
 */
const DEPTH_FIGURE =
  /(?<![\d,.])(?:(\d{1,2},\d{3}|\d{3,5})\s*(?:-|–|to|and)\s*)?(\d{1,2},\d{3}|\d{3,5})\s*(?:ft\b|ft\.|feet\b)/gi;

/**
 * A number with a foot unit is usually a THICKNESS in this literature, not a
 * depth: "the Marble Falls limestone is about 600 feet thick", "1,200 feet of
 * Bend", "215 feet below the top of the Smithwick". So the figure has to sit in
 * a depth CONTEXT, in the same sentence, and the constructions that mean
 * thickness or distance veto it outright. The metric conversion USGS prints
 * after every figure is stepped over before the veto is applied.
 */
const DEPTH_CUE =
  /\b(?:depths?|deep(?:er|est)?|drill(?:ed|ing)?|penetrat\w*|t\.?d\.?|bottomed|encountered|perforat\w*|subsea|completed|pay)\b[^.;]{0,60}$/i;
const DEPTH_VETO =
  /^\s*(?:\([^)]{0,24}\)\s*)?(?:thick|of\b|below the top|above|north|south|east|west)/i;

const DEPTH_FILTER =
  "figures carrying a foot unit, in a depth context (drilled / penetrated / " +
  "total depth / perforated) in the same sentence, between " +
  `${DEPTH_MIN_FT} and ${DEPTH_MAX_FT.toLocaleString("en-US")} ft. Thicknesses ` +
  "('600 feet thick', '1,200 feet of Bend'), offsets below a marker and map " +
  "distances are rejected. The sieve is coarse and the text is OCR'd prose, so " +
  "read the quotes before using a number.";

interface DepthHit {
  ft: number;
  quote: string;
}

function depthsIn(passage: string): DepthHit[] {
  const hits: DepthHit[] = [];
  DEPTH_FIGURE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEPTH_FIGURE.exec(passage))) {
    const before = passage.slice(Math.max(0, m.index - 80), m.index);
    if (!DEPTH_CUE.test(before)) continue;
    const after = passage.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (DEPTH_VETO.test(after)) continue;
    // The window starts wherever 70 characters back happens to land, so the
    // leading fragment is dropped: a quote opening on "sin is shallow" reads
    // as a transcription error rather than as a slice of "basin".
    const lead = before.length > 70 ? before.slice(-70).replace(/^\S*\s/, "… ") : before;
    const quote = collapse(lead + m[0] + after);
    for (const raw of [m[1], m[2]]) {
      if (!raw) continue;
      const ft = Number(raw.replace(/,/g, ""));
      if (ft < DEPTH_MIN_FT || ft > DEPTH_MAX_FT) continue;
      hits.push({ ft, quote });
    }
  }
  return hits;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The play term in its own sentence-ish neighbourhood, for reading, not parsing. */
function excerptAround(passage: string, at: number, length: number): string {
  const start = Math.max(0, at - 180);
  const end = Math.min(passage.length, at + length + 180);
  const body = collapse(passage.slice(start, end));
  return `${start > 0 ? "… " : ""}${body}${end < passage.length ? " …" : ""}`;
}

/**
 * Which excerpts are worth the model's attention.
 *
 * The first five passages that happen to name the play are usually a table of
 * contents, a figure list and a stratigraphic column, because front matter
 * repeats every term in the document. Those are true and useless. An excerpt
 * earns its place by carrying the evidence this tool exists to produce, so a
 * county or a depth outranks position, and the dot leaders and pipe tables that
 * mark front matter and OCR'd tables are pushed to the back.
 */
function excerptScore(passage: string, hasCounty: boolean, hasDepth: boolean): number {
  let score = (hasCounty ? 3 : 0) + (hasDepth ? 3 : 0);
  if (/\.{3,}|\|/.test(passage)) score -= 4;
  if (collapse(passage).split(" ").length < 12) score -= 2;
  return score;
}

/**
 * The corpus is enumerated from the KNOWLEDGE BASE, not from the card list.
 *
 * Measured on the shipped corpus: 92 documents are on disk and 90 have a card
 * in `TOC.md`. One of the two that do not is a county-scale geology monograph
 * that states producing depths for this exact play, well by well. Walking the
 * cards would have skipped it silently, and a tool that reports where a rock is
 * described cannot decide that quietly on the strength of an index gap.
 *
 * A document is still READ through `Corpus.document`, so the hash check against
 * the TOC's ledger is untouched; only the list of what to open comes from disk.
 * A file with no card simply has no card-level evidence, which is a smaller
 * loss than not reading it.
 */
async function documentPaths(): Promise<{ section: string; slug: string }[]> {
  const base = path.join(corpusRoot(), "knowledge-base");
  const out: { section: string; slug: string }[] = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const file of await readdir(path.join(base, entry.name))) {
        if (file.endsWith(".md")) out.push({ section: entry.name, slug: file.slice(0, -3) });
      }
      // A document filed at the top level has no section, and `path.join`
      // treats the empty one as absent, so it still resolves.
    } else if (entry.name.endsWith(".md")) {
      out.push({ section: "", slug: entry.name.slice(0, -3) });
    }
  }
  // Directory order is not a guarantee, and this decides excerpt order.
  return out.sort((a, b) =>
    a.section.localeCompare(b.section) || a.slug.localeCompare(b.slug)
  );
}

/** Regex-safe, and tolerant of the line break OCR drops inside "Bend Arch". */
function playPattern(play: string, flags: string): RegExp {
  const escaped = play
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(escaped, flags);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Every call reads the whole corpus, and the cost of that was measured before
 * it was accepted: 8.9 MB across 92 documents is 35 ms to read, 21 ms for the
 * hash check `Corpus.document` runs over each one, and 29 ms to split and scan
 * the passages, so 90 ms for a cold call end to end and ~50 ms once the OS page
 * cache is warm. So there is no index here and no cache to go stale. Building
 * one would have been the expensive mistake; the naive read is cheap enough
 * that it can afford to be obviously correct instead.
 */
export function geologyPlayExtentTool() {
  return {
    geology_play_extent: tool({
      description:
        "WHERE does a play, formation or zone exist, and at what depth, according to the app's internal geology library, asked BEFORE any search radius or well population is chosen. Returns the Texas counties the literature names when it discusses this rock (each with how many passages named it, plus the RRC county number to screen on), the depth figures quoted alongside it as a distribution, and short excerpts to read. Use this to set the extent of an RRC screen instead of drawing a circle around one well: run it first, then screen the record inside the counties and depth band it reports. This is the literature's account of the play, NOT a measured well population, so treat it as where to look and confirm every part of it against the record. Give it the rock: 'Bend Arch', 'Marble Falls', 'Caddo', 'Strawn'.",
      inputSchema: z.object({
        play: z
          .string()
          .describe(
            "the play, formation, group or zone name as the literature would write it, e.g. 'Bend Arch', 'Marble Falls', 'Caddo', 'Strawn', 'Barnett'"
          ),
      }),
      execute: async ({ play }) => {
        const kb = open();
        if (!kb) return NOT_CONFIGURED;
        const term = (play ?? "").trim();
        if (term.length < MIN_PLAY_TERM) return NEEDS_A_PLAY;

        try {
          const anywhere = playPattern(term, "i");
          const each = playPattern(term, "gi");

          // Per county: passages in the library's writing on this play that
          // named it, and how many of those named the play in the same breath.
          const counties = new Map<string, { passages: number; withPlay: number }>();
          const depths: DepthHit[] = [];
          const candidates: { text: string; score: number }[] = [];
          let unreadable = 0;
          let named = 0;

          const cards = new Map((await kb.documentCards()).map((c) => [c.slug, c]));

          for (const { section, slug } of await documentPaths()) {
            // Two ways a document bears on the play, and they answer different
            // halves of the question. A passage that NAMES the rock is where a
            // depth comes from. A document the library holds ON the play is a
            // monograph whose whole subject is this ground, and its counties
            // count even in passages that never repeat the play's name, which
            // is exactly how a paper titled "…in Brown and Coleman Counties"
            // states an extent. `notGoodFor` is excluded from that test on
            // purpose: it is where a card says what a document is NOT about.
            const card = cards.get(slug);
            const aboutPlay = matches(
              term,
              slug.replace(/-/g, " "),
              card?.covers ?? "",
              card?.authoritativeFor ?? [],
              card?.scope ?? ""
            );

            let text: string;
            try {
              text = await kb.document(section, slug);
            } catch {
              // Corpus drift or a missing file. One unreadable document must
              // not lose the other ninety, and it is reported as a shortfall
              // rather than swallowed.
              unreadable++;
              continue;
            }
            if (!aboutPlay && !anywhere.test(text)) continue;

            for (const passage of text.split(/\n\s*\n+/)) {
              each.lastIndex = 0;
              const hit = each.exec(passage);
              if (!hit && !aboutPlay) continue;
              if (hit) named++;

              const here = countiesIn(passage);
              for (const county of here) {
                const tally = counties.get(county) ?? { passages: 0, withPlay: 0 };
                tally.passages++;
                if (hit) tally.withPlay++;
                counties.set(county, tally);
              }
              if (!hit) continue;

              const found = depthsIn(passage);
              depths.push(...found);
              candidates.push({
                text: excerptAround(passage, hit.index, hit[0].length),
                score: excerptScore(passage, here.size > 0, found.length > 0),
              });
            }
          }

          // A county named in the same passage as the play outranks one named
          // only in a document about it: both are evidence, and the difference
          // between them is the difference between "the paper says this rock is
          // there" and "the paper about this rock discusses that ground".
          const ranked = [...counties]
            .sort(
              (a, b) =>
                b[1].withPlay - a[1].withPlay ||
                b[1].passages - a[1].passages ||
                a[0].localeCompare(b[0])
            )
            .map(([name, tally]) => ({
              county: name,
              // The RRC key, so the extent can be handed straight to a screen
              // rather than retyped as a place name that has to be resolved
              // again downstream.
              county_no: resolveCounty(name)?.county_no ?? null,
              passages: tally.passages,
              with_play: tally.withPlay,
            }));

          const ft = depths.map((d) => d.ft).sort((a, b) => a - b);
          // Shallowest and deepest, not the first six: the ends of the band are
          // the figures a reader will want to argue with, and a band quoted
          // only from its middle cannot be argued with at all.
          const sorted = [...depths].sort((a, b) => a.ft - b.ft);
          const quoted = [
            ...new Set(
              sorted
                .filter(
                  (_, i) =>
                    i < MAX_DEPTH_QUOTES / 2 || i >= sorted.length - MAX_DEPTH_QUOTES / 2
                )
                .map((d) => `${d.ft.toLocaleString("en-US")} ft: ${d.quote}`)
            ),
          ];

          return {
            ok: true as const,
            play: term,
            counties: ranked.slice(0, MAX_COUNTIES),
            ...(ranked.length > MAX_COUNTIES
              ? {
                  countiesNote: `The ${MAX_COUNTIES} most-named are shown; ${ranked.length - MAX_COUNTIES} more were named once or twice each. A play named across this many counties is a region, not a screen.`,
                }
              : {}),
            depths_ft:
              ft.length > 0
                ? {
                    count: ft.length,
                    min: ft[0],
                    median: median(ft),
                    max: ft[ft.length - 1],
                    filter: DEPTH_FILTER,
                    quotes: quoted,
                  }
                : {
                    count: 0,
                    filter: DEPTH_FILTER,
                    note: "No depth figure survived the filter. The library discusses this rock without quoting a drilling depth for it, which is normal for a structural feature and for outcrop stratigraphy. Take the depth from the record, not from here.",
                  },
            passages: candidates
              .sort((a, b) => b.score - a.score)
              .slice(0, MAX_EXCERPTS)
              .map((c) => c.text),
            matched_passages: named,
            ...(unreadable > 0
              ? {
                  warning:
                    "Part of the library could not be read (most likely a rebuilt corpus against a stale index: re-run build_toc.py). What follows is partial, so a county missing from this list may only be missing from what was readable.",
                }
              : {}),
            note:
              "This is the play's extent AS THE LITERATURE DESCRIBES IT, not a measured well population. Every number here counts passages and quoted figures in published text, never wells, and the library is a curated collection rather than a survey of Texas, so absence is not evidence of absence. `with_play` is the strong evidence: the county and the play named in the same passage. A county with passages but `with_play` 0 was named in writing about this play without being tied to it in a sentence, which is a lead and not a finding. Nothing may be screened, ranked or recommended on this alone: use the counties as the extent to query the record over, and confirm the depth band against actual completions before it decides anything.",
            private: PRIVATE,
            next: "Screen the record inside this extent (county + depth), then use geology_kb_index/geology_kb_segments/geology_kb_read to read the source behind any part of it you are about to rely on.",
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),
  };
}

/** Where the library was looked for, for a startup log or a support answer. */
export function geologyKbRoot(): string {
  return corpusRoot();
}
