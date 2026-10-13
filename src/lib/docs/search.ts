import { readFileSync } from "node:fs";
import path from "node:path";
import { DOC_SECTIONS, type DocSection } from "@/lib/docs/catalog";
import { SYNONYM_GROUPS } from "@/lib/docs/synonyms";

/**
 * Keyword search over the help docs, with the operator's vocabulary mapped onto
 * the writer's (see `synonyms.ts`).
 *
 * ## Why not embeddings
 *
 * The corpus is 147 short how-to pages with plain titles. Nearly every question
 * a user asks names the thing it is about ("tank", "statement", "password"), so
 * the retrieval problem here is vocabulary, not semantics: "stick a tank" and
 * "record a tank gauge" are the same request in different words, and a synonym
 * table says so exactly, in one file a person can read and correct. Embeddings
 * would add a build step, an index to keep in step with the markdown, and a
 * failure mode where nobody can explain why a doc did not come back.
 *
 * ## Scoring
 *
 * A hit in the TITLE beats a hit in a heading beats a hit in the body, because
 * these docs are named after the task they describe: "Record a tank gauge"
 * matching on its title IS the answer, while the same words inside another doc
 * are usually a cross-reference. Body hits are capped so a long doc that
 * mentions a word repeatedly cannot outrank the doc actually about it.
 *
 * A term the user typed counts for more than one the synonym table added, so a
 * broad group ("add" / "create" / "new" / "set up") widens the net without
 * deciding the result.
 */

const DOCS_DIR = path.join(process.cwd(), "site-docs");

/** Words that carry no signal in a question about how to do something. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "how", "do", "does", "did", "i", "you", "my", "me", "we",
  "to", "of", "in", "on", "at", "for", "with", "and", "or", "is", "are", "was",
  "can", "could", "should", "would", "what", "when", "where", "which", "who",
  "why", "it", "its", "this", "that", "there", "here", "from", "by", "as",
  "have", "has", "get", "got", "want", "need", "please", "help", "way",
]);

const FIELD_WEIGHT = { title: 8, heading: 4, section: 2, body: 1 } as const;
/** Body hits past this add nothing: repetition is not relevance. */
const MAX_BODY_HITS = 4;
/** A term the synonym table supplied, relative to one the user typed. */
const SYNONYM_WEIGHT = 0.5;

export interface DocHit {
  section: string;
  sectionTitle: string;
  slug: string;
  title: string;
  /** Rounded, for a stable tool result. Comparable within one search only. */
  score: number;
  /** The terms that actually matched, so a caller can see WHY this came back. */
  matched: string[];
  /** A line of the doc around the best match, for choosing between hits. */
  snippet: string;
}

interface IndexedDoc {
  section: DocSection;
  slug: string;
  title: string;
  /** Lowercased title, for matching. */
  titleText: string;
  headingText: string;
  bodyText: string;
  /** Body lines, original case, for snippets. */
  lines: string[];
}

let INDEX: IndexedDoc[] | null = null;

/** Strip the markup that would otherwise match ("**", "#", link syntax). */
function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#|]/g, " ");
}

function buildIndex(): IndexedDoc[] {
  const docs: IndexedDoc[] = [];
  for (const section of DOC_SECTIONS) {
    for (const page of section.pages) {
      let raw: string;
      try {
        raw = readFileSync(
          path.join(DOCS_DIR, section.slug, `${page.slug}.md`),
          "utf8"
        );
      } catch {
        // A doc named in the catalog but absent from disk. Skip it rather than
        // failing the whole search: the rest of the corpus still answers.
        continue;
      }
      const text = plain(raw);
      const headings = raw
        .split("\n")
        .filter((l) => l.trimStart().startsWith("#"))
        .join("\n");
      docs.push({
        section,
        slug: page.slug,
        title: page.title,
        titleText: fold(page.title.toLowerCase()),
        headingText: fold(plain(headings).toLowerCase()),
        bodyText: fold(text.toLowerCase()),
        lines: text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      });
    }
  }
  return docs;
}

/** Built once per process. The corpus ships with the deploy and cannot change. */
function index(): IndexedDoc[] {
  INDEX ??= buildIndex();
  return INDEX;
}

/** True when the corpus is missing entirely (not deployed, wrong cwd). */
export function docsAvailable(): boolean {
  return index().length > 0;
}

/** Every word folded to its singular, so the index and the query agree. */
function fold(text: string): string {
  return text.replace(/[a-z0-9]+/g, (w) => singular(w));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * "gauges" and "gauge" are the same question. Nothing cleverer is needed.
 *
 * Applied to the QUERY and to the indexed text alike. Folding only the query
 * was a real bug: a search for "report" missed the doc titled "Have reports
 * emailed to you" while matching the one that says "report" in the singular, so
 * the closest doc lost to a neighbour on a plural.
 */
function singular(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("es") && !word.endsWith("ses")) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

export interface SearchTerm {
  term: string;
  weight: number;
}

/**
 * The question, as terms to look for: what the user typed, plus every phrase
 * that means the same thing in this app.
 */
export function termsFor(query: string): SearchTerm[] {
  const q = normalize(query);
  if (!q) return [];
  const typed = q
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(singular);

  const terms = new Map<string, number>();
  for (const t of typed) terms.set(t, 1);

  const padded = ` ${q} `;
  for (const group of SYNONYM_GROUPS) {
    const hit = group.some((member) =>
      member.includes(" ")
        ? padded.includes(` ${member} `)
        : typed.includes(singular(member))
    );
    if (!hit) continue;
    for (const member of group) {
      const term = member.includes(" ") ? member : singular(member);
      if (!terms.has(term)) terms.set(term, SYNONYM_WEIGHT);
    }
  }
  return [...terms].map(([term, weight]) => ({ term, weight }));
}

/** Occurrences of `term` in `text`, on word boundaries so "oil" misses "boiler". */
function count(text: string, term: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at === -1) return n;
    const before = at === 0 ? " " : text[at - 1];
    const after = text[at + term.length] ?? " ";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) n += 1;
    from = at + term.length;
  }
}

function snippetFor(doc: IndexedDoc, terms: SearchTerm[]): string {
  const line = doc.lines.find((l) => {
    const lower = fold(l.toLowerCase());
    return terms.some((t) => count(lower, t.term) > 0);
  });
  const chosen = line ?? doc.lines[0] ?? "";
  return chosen.length > 240 ? `${chosen.slice(0, 237)}...` : chosen;
}

export interface SearchOptions {
  /** Restrict to one section slug. */
  section?: string;
  limit?: number;
}

/**
 * The docs that bear on a question, best first. Empty when nothing matches,
 * which is a real answer: the corpus does not cover everything.
 */
export function searchDocs(query: string, opts: SearchOptions = {}): DocHit[] {
  const terms = termsFor(query);
  if (terms.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);

  const scored: DocHit[] = [];
  for (const doc of index()) {
    if (opts.section && doc.section.slug !== opts.section) continue;
    let score = 0;
    const matched: string[] = [];
    for (const { term, weight } of terms) {
      let termScore = 0;
      if (count(doc.titleText, term) > 0) termScore += FIELD_WEIGHT.title;
      if (count(fold(doc.section.title.toLowerCase()), term) > 0) {
        termScore += FIELD_WEIGHT.section;
      }
      const headingHits = count(doc.headingText, term);
      if (headingHits > 0) termScore += FIELD_WEIGHT.heading;
      const bodyHits = Math.min(count(doc.bodyText, term), MAX_BODY_HITS);
      termScore += bodyHits * FIELD_WEIGHT.body;
      if (termScore > 0) {
        score += termScore * weight;
        matched.push(term);
      }
    }
    if (score <= 0) continue;
    scored.push({
      section: doc.section.slug,
      sectionTitle: doc.section.title,
      slug: doc.slug,
      title: doc.title,
      score: Math.round(score * 10) / 10,
      matched,
      snippet: snippetFor(doc, terms),
    });
  }

  // Ties broken by slug so the same question always answers the same way.
  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return scored.slice(0, limit);
}
