import type { Conversation } from "@/lib/ai/conversations";
import { stem } from "@/lib/search/stemmer";
import { SYNONYM_GROUPS } from "@/lib/search/synonyms";

/**
 * Keyword search over the chat history.
 *
 * Searching titles alone is close to useless here: a title is derived from the
 * first few words the user typed, so "hello" and "hey quick question" name
 * conversations that went on to be about saltwater disposal and vitrinite
 * reflectance. What the reader remembers is the TOPIC, which lives in the
 * message bodies. So the whole conversation is indexed, and the title is merely
 * weighted more heavily than the body.
 *
 * Three layers, in the order they were added and in the order they matter:
 *
 *   1. BM25's ranking shape, minus the parts that need a corpus-wide index.
 *      Inverse document frequency, so a term in every chat ("well", "orion")
 *      counts for less than one in two. Saturating term frequency, so forty
 *      mentions do not bury the chat that says it three times in the answer
 *      the reader wants. Length normalisation, so a long conversation does not
 *      outrank a short, precisely-about-this one by containing more words.
 *   2. Stemming (`@/lib/search/stemmer`), so the search matches the word rather
 *      than the spelling: "perforation" finds a chat that only said
 *      "perforating".
 *   3. Domain synonyms (`@/lib/search/synonyms`), so it matches the MEANING:
 *      "SWD", "saltwater disposal" and "injection well" are one concept. In a
 *      domain this abbreviation-heavy, that gap is the normal case.
 *
 * All of it runs over an in-memory list of a few dozen conversations, so it is
 * microseconds of work with no index to build, no server call, and no model.
 */

/**
 * Words carrying no topical signal, dropped from the QUERY only.
 *
 * They stay in the documents: removing them there would change the length
 * normalisation for no benefit, and an unfiltered document is what a phrase
 * match needs to test against. A query of nothing but stopwords ("what is the")
 * falls back to using them, so typing a common word still does something rather
 * than silently returning everything.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "did",
  "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in",
  "is", "it", "its", "me", "my", "of", "on", "or", "our", "so", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
]);

/** BM25 term-frequency saturation point. The standard default. */
const K1 = 1.2;
/** BM25 length-normalisation strength. The standard default. */
const B = 0.75;
/** How much more a hit in the title is worth than one in the body. */
const TITLE_WEIGHT = 3;
/** Added when the query appears verbatim, rewarding an exact remembered phrase. */
const PHRASE_BONUS = 4;

/**
 * Split text into lowercase, stemmed word tokens.
 *
 * Punctuation and symbols separate rather than join, and accents are folded, so
 * "Repass-2", "Repass 2" and "repass2" do not read as three different things to
 * someone who typed one of them.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem);
}

/** The query's meaningful terms, de-duplicated, stopwords dropped. */
export function queryTerms(query: string): string[] {
  // Stopwords are checked BEFORE stemming: the list is written in ordinary
  // English, and stemming turns "was" into "wa" and "this" into "thi".
  const raw = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const meaningful = raw.filter((t) => !STOPWORDS.has(t));
  // A query that is ALL stopwords still deserves an answer.
  const kept = meaningful.length > 0 ? meaningful : raw;
  return [...new Set(kept.map(stem))];
}

/**
 * One thing the reader is looking for: a single term, or a set of phrasings
 * that mean the same thing.
 *
 * Modelled as a concept rather than as expanded terms so a synonym group scores
 * ONCE. Expanding "swd" into five terms and scoring each would let a chat that
 * happened to say "disposal well" three different ways outrank one that is
 * actually about it, and would make a query with one abbreviation in it count
 * for five times a query without.
 */
interface Concept {
  /** Each phrasing, as a stemmed token sequence. Single-token for a plain term. */
  variants: string[][];
  /**
   * Whether a variant's final token may match on prefix.
   *
   * True only for a term the reader actually typed, where the prefix is what
   * makes the list filter as they go. False for synonym variants: those are our
   * own vocabulary, full of two-letter abbreviations, and prefix-matching them
   * would have `wi` (working interest) hit "wireline" and "winter". Stemming
   * already covers the plurals that prefix matching would otherwise be needed
   * for, so exact is not restrictive here.
   */
  prefix: boolean;
}

/** Synonym groups as stemmed token sequences, longest phrase first. */
const STEMMED_GROUPS: string[][][] = SYNONYM_GROUPS.map((group) =>
  group
    .map((phrase) => tokenize(phrase))
    .filter((tokens) => tokens.length > 0)
    .sort((a, b) => b.length - a.length)
);

/**
 * Match a synonym phrase starting at `i`, longest first, and return its group.
 *
 * Longest-first matters: "salt water disposal" and "water" are both matchable
 * at the same position, and taking the short one would read the query as being
 * about water in general.
 */
function groupAt(
  tokens: string[],
  i: number
): { variants: string[][]; length: number } | null {
  let best: { variants: string[][]; length: number } | null = null;
  for (const group of STEMMED_GROUPS) {
    for (const variant of group) {
      if (variant.length > tokens.length - i) continue;
      const matches = variant.every((t, k) => tokens[i + k] === t);
      if (!matches) continue;
      if (!best || variant.length > best.length) {
        best = { variants: group, length: variant.length };
      }
      break; // group's variants are longest-first, so this is its best match
    }
  }
  return best;
}

/** Parse a query into the concepts it is asking about. */
function queryConcepts(query: string): Concept[] {
  const terms = queryTerms(query);
  const concepts: Concept[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < terms.length; ) {
    const group = groupAt(terms, i);
    if (group) {
      const key = group.variants[0].join(" ");
      if (!seen.has(key)) {
        seen.add(key);
        concepts.push({ variants: group.variants, prefix: false });
      }
      i += group.length;
      continue;
    }
    const key = terms[i];
    if (!seen.has(key)) {
      seen.add(key);
      concepts.push({ variants: [[terms[i]]], prefix: true });
    }
    i++;
  }
  return concepts;
}

/**
 * How many times a concept appears in a token list.
 *
 * A typed term matches on PREFIX of its stem, so "poros" finds "porosity"
 * while the reader is still typing. It is never a substring match: "ore" must
 * not hit "before", which is the sort of result that makes a search feel
 * random. A multi-token variant must match as a consecutive sequence.
 */
function countConcept(tokens: string[], concept: Concept): number {
  const matches = (token: string, t: string, last: boolean): boolean =>
    concept.prefix && last ? token.startsWith(t) : token === t;

  let n = 0;
  for (const variant of concept.variants) {
    for (let i = 0; i + variant.length <= tokens.length; i++) {
      const hit = variant.every((t, k) =>
        matches(tokens[i + k], t, k === variant.length - 1)
      );
      if (hit) n++;
    }
  }
  return n;
}

/** Everything in a conversation a search should be able to reach. */
function documentTokens(conversation: Conversation): {
  title: string[];
  body: string[];
  text: string;
} {
  const bodyText = conversation.messages
    .flatMap((m) =>
      m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
    )
    .join("\n");
  return {
    title: tokenize(conversation.title),
    body: tokenize(bodyText),
    text: `${conversation.title}\n${bodyText}`.toLowerCase(),
  };
}

export interface ScoredConversation {
  conversation: Conversation;
  score: number;
}

/**
 * Rank conversations against a query, best first.
 *
 * A conversation must contain EVERY concept to place at all: with a handful of
 * chats to search, an OR would return most of them on any two-word query, and a
 * list that always answers is a list that never helps. Ties break on recency.
 *
 * An empty query returns everything in recency order, which is the unsearched
 * list.
 */
export function searchConversations(
  conversations: Conversation[],
  query: string
): Conversation[] {
  return rank(conversations, query).map((s) => s.conversation);
}

/**
 * The same ranking, keeping the scores, and RELAXING rather than returning
 * nothing.
 *
 * Requiring every concept is right when it finds something and useless when it
 * does not, which is the common case for a query a model wrote. A person types
 * "repass 2"; a model types "Repass 2 recompletion plan target zone" and gets
 * zero, because no single conversation happens to contain all five stems — even
 * though five conversations are about exactly that. The model then reports that
 * nothing was ever discussed, which is worse than a thin answer: it is a
 * confident denial.
 *
 * So a miss drops the LEAST distinctive concept and asks again. Least
 * distinctive by document frequency, so "plan" and "zone" go before "repass"
 * and the specific term is the last thing surrendered. Anything found this way
 * is reported with the terms that actually matched, so the caller can see the
 * query was widened rather than believing it was answered as asked.
 */
export interface RankedConversation extends ScoredConversation {
  /** Concepts the search ended up requiring. Shorter than the query on a relax. */
  matchedOn: string[];
  /** Concepts dropped to find anything at all. Empty on a clean hit. */
  relaxed: string[];
}

export function searchConversationsRelaxed(
  conversations: Conversation[],
  query: string
): RankedConversation[] {
  const all = queryConcepts(query);
  if (all.length === 0) {
    return rank(conversations, query).map((s) => ({ ...s, matchedOn: [], relaxed: [] }));
  }

  const freq = new Map(all.map((c) => [label(c), docFrequency(conversations, c)]));

  /*
   * A concept nobody ever wrote is dropped OUTRIGHT, before any relaxation.
   *
   * Requiring it is guaranteed failure, and it is also the most-relaxed-last
   * term under a rarity sort — so "Repass 2 recompletion plan" relaxed all the
   * way down to `recompletion` alone, a word appearing in zero conversations,
   * and still returned nothing. The rarest surviving term is the most
   * distinctive one only among terms that exist.
   */
  const present = all.filter((c) => (freq.get(label(c)) ?? 0) > 0);
  const absent = all.filter((c) => (freq.get(label(c)) ?? 0) === 0).map(label);
  if (present.length === 0) return [];

  // Least distinctive first, so the FRONT of this list is what gets dropped.
  const byRarity = [...present].sort(
    (a, b) => (freq.get(label(b)) ?? 0) - (freq.get(label(a)) ?? 0)
  );

  for (let drop = 0; drop < byRarity.length; drop++) {
    const kept = byRarity.slice(drop);
    const hits = rankConcepts(conversations, kept, query);
    if (hits.length > 0) {
      return hits.map((s) => ({
        ...s,
        matchedOn: kept.map(label),
        relaxed: [...absent, ...byRarity.slice(0, drop).map(label)],
      }));
    }
  }
  return [];
}

const label = (c: Concept): string => c.variants[0].join(" ");

function docFrequency(conversations: Conversation[], concept: Concept): number {
  return conversations.filter((conversation) => {
    const d = documentTokens(conversation);
    return countConcept(d.title, concept) + countConcept(d.body, concept) > 0;
  }).length;
}

function rank(conversations: Conversation[], query: string): ScoredConversation[] {
  const concepts = queryConcepts(query);
  if (concepts.length === 0) {
    return [...conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((conversation) => ({ conversation, score: 0 }));
  }
  return rankConcepts(conversations, concepts, query);
}

function rankConcepts(
  conversations: Conversation[],
  concepts: Concept[],
  query: string
): ScoredConversation[] {
  if (concepts.length === 0) return [];

  const docs = conversations.map((conversation) => ({
    conversation,
    ...documentTokens(conversation),
  }));
  const lengths = docs.map((d) => d.title.length * TITLE_WEIGHT + d.body.length);
  const avgLength =
    lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, lengths.length);

  // Document frequency per concept, over the conversations being searched.
  const docFreq = concepts.map(
    (concept) =>
      docs.filter(
        (d) => countConcept(d.title, concept) + countConcept(d.body, concept) > 0
      ).length
  );

  const needle = query.trim().toLowerCase();
  const total = docs.length;

  const scored: ScoredConversation[] = [];
  for (const [i, d] of docs.entries()) {
    let score = 0;
    let matchedAll = true;

    for (const [c, concept] of concepts.entries()) {
      const tf =
        countConcept(d.title, concept) * TITLE_WEIGHT +
        countConcept(d.body, concept);
      if (tf === 0) {
        matchedAll = false;
        break;
      }
      const df = docFreq[c];
      // BM25's IDF, floored at zero so a concept present in every conversation
      // contributes nothing rather than pushing the score negative.
      const idf = Math.max(0, Math.log((total - df + 0.5) / (df + 0.5) + 1));
      const norm = 1 - B + (B * lengths[i]) / Math.max(1, avgLength);
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }

    if (!matchedAll) continue;
    if (needle.length > 0 && d.text.includes(needle)) score += PHRASE_BONUS;
    scored.push({ conversation: d.conversation, score });
  }

  return scored.sort(
    (a, b) =>
      b.score - a.score || b.conversation.updatedAt - a.conversation.updatedAt
  );
}
