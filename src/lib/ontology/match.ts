import type { EntityType } from "./handles";

/**
 * Turning something a person said into an entity.
 *
 * "the Repass", "Repass 2", "repass #2" and "REPASS  #2" are one well, and the
 * name on file is whichever of those someone typed when they created it. A model
 * left to match these itself either guesses an id or asks the user to spell it,
 * and both are worse than a ranked candidate list.
 *
 * Pure, so the ranking can be checked against hand-written expectations rather
 * than against whatever the org's data happens to contain.
 */

/** One thing that could be named, as the loaders hand it over. */
export interface Candidate {
  type: EntityType;
  id: string;
  name: string;
  /** Disambiguating detail for the model, e.g. a lease number or a county. */
  detail?: string;
}

/** How a candidate matched. Ordered strongest first. */
export type MatchKind = "exact" | "prefix" | "contains" | "tokens";

export interface Match extends Candidate {
  handle: string;
  score: number;
  how: MatchKind;
}

const SCORES: Record<MatchKind, number> = {
  exact: 1,
  prefix: 0.8,
  contains: 0.6,
  tokens: 0.4,
};

/**
 * Fold the punctuation people vary and the app does not.
 *
 * `#` is the big one: a well is entered as "REPASS #2" and spoken as "repass 2".
 * Hyphens and periods go the same way, so "Smith-3" and "Smith 3" meet. Case is
 * folded, runs of whitespace collapse, and the leading article is dropped
 * because "the Repass" is how anyone actually refers to a lease.
 */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[#().,'"_/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
}

function tokens(value: string): string[] {
  return normalizeName(value).split(" ").filter(Boolean);
}

/** How one candidate matches, or null when it does not. */
function classify(queryNorm: string, queryTokens: string[], name: string): MatchKind | null {
  const nameNorm = normalizeName(name);
  if (!nameNorm) return null;
  if (nameNorm === queryNorm) return "exact";
  if (nameNorm.startsWith(queryNorm)) return "prefix";
  if (nameNorm.includes(queryNorm)) return "contains";

  // Every word of the query appears somewhere in the name, in any order. This is
  // what catches "repass 2" against "REPASS LEASE #2", where no substring of the
  // name contains the query intact.
  const nameTokens = new Set(tokens(name));
  if (queryTokens.length > 0 && queryTokens.every((t) => nameTokens.has(t))) {
    return "tokens";
  }
  return null;
}

export interface MatchOpts {
  limit?: number;
  /** Restrict to these types. Empty or omitted means all of them. */
  types?: readonly EntityType[];
}

/**
 * Rank candidates against what the user said.
 *
 * Ties break on the SHORTER name first. Between "REPASS" and "REPASS SOUTH
 * UNIT", both of which contain the query, the shorter one is the more exact
 * reading of what was asked, and putting the longer first is how a model ends up
 * answering about the wrong lease. Name then id break the remaining ties so the
 * order is stable across calls, which matters because the model is choosing from
 * a list it may see twice.
 */
export function matchEntities(
  query: string,
  candidates: Candidate[],
  opts: MatchOpts = {}
): Match[] {
  const queryNorm = normalizeName(query ?? "");
  if (!queryNorm) return [];
  const queryTokens = queryNorm.split(" ").filter(Boolean);
  const allowed = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;

  const matches: Match[] = [];
  for (const c of candidates) {
    if (allowed && !allowed.has(c.type)) continue;
    const how = classify(queryNorm, queryTokens, c.name ?? "");
    if (!how) continue;
    matches.push({
      ...c,
      handle: `${c.type}:${c.id}`,
      how,
      score: SCORES[how],
    });
  }

  matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
  );

  return matches.slice(0, opts.limit ?? 8);
}

/**
 * Whether the top answer is actually the answer.
 *
 * Two candidates tied at the top is the case that must never be silently
 * resolved: picking one is a coin flip that reads as certainty. Anything else,
 * including a single weak match, is a usable lead the model can act on and say
 * so.
 */
export function isAmbiguous(matches: Match[]): boolean {
  return matches.length > 1 && matches[0].score === matches[1].score;
}
