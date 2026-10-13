/**
 * Which of an operator's wells the person meant.
 *
 * ## Why this is not a SQL `LIKE`
 *
 * It used to be, and it could not answer the ordinary question. The mirror
 * files a lease surname-first and shouting — `YOUNG  FANNIE`, `KENNEDY  M.O.
 * ESTATE`, `FORD  ED`, `BALDWIN  C. R.` — while an operator writes it the way
 * they say it and hangs their own designation off the end: "Fannie Young 6
 * SWD". That single input misses a substring search three separate ways: the
 * words are in the other order, "SWD" is nowhere in the state's name, and the
 * well number sits in the middle where a trailing-number strip cannot see it.
 * No pattern fixes word order, and `pg_trgm` is not guaranteed on the mirror
 * (a read-only instance we do not control).
 *
 * So the shape is: fetch the operator's fleet with one indexed query and rank
 * it here. A P-5 is hundreds of rows, not millions, and ranking in TypeScript
 * buys the thing a `LIKE` can never have — it is PURE, so every real-world
 * miss becomes a fixture instead of something found in production.
 *
 * ## The rules, and why each one is here
 *
 *  - The well number is pulled from ANYWHERE in the input and scored on its
 *    own. It is the most discriminating token there is: sixteen of Sky
 *    Resources' wells are called ROACH and only the number tells them apart.
 *  - The rest is scored as a SET, so word order stops mattering.
 *  - Designation words (SWD, WIW, INJ …) are DOWN-WEIGHTED, not stripped.
 *    `LONESOME DOVE SWD` is a real lease name on Sky's own permits, and a rule
 *    that deleted the word would stop that lease matching itself.
 *  - A tie is reported as a tie. Two of Sky's wells really are both `CORBETT`
 *    #2 on different holes, and picking one silently is how the wrong hole's
 *    record lands in somebody's form.
 */
import { titleCase } from "@/lib/scout/format";

/** One candidate wellbore, reduced to what ranking reads. */
export interface MatchableWell {
  apiNumber: string;
  leaseName: string | null;
  wellNo: string | null;
  /** The operator's CURRENT assignment. Breaks ties toward the live hole. */
  onSchedule: boolean;
}

export interface RankedWell {
  well: MatchableWell;
  score: number;
  /** 0..1 over the name tokens alone, before the number and schedule bonuses. */
  nameScore: number;
  wellNoMatch: boolean;
}

/**
 * Words an operator adds that the state's lease name does not carry.
 *
 * Weighted rather than removed (see the header). 0.15 is low enough that the
 * word decides nothing on its own and high enough that two names that BOTH
 * carry it score better than two that disagree on it.
 */
const DESIGNATION = new Set([
  "swd",
  "sw",
  "wd",
  "ws",
  "wiw",
  "inj",
  "injection",
  "injector",
  "disposal",
  "saltwater",
  "well",
  "lease",
]);

const DESIGNATION_WEIGHT = 0.15;

/** A well number's own worth, on the 0..100 scale the name score sits on. */
const WELL_NO_POINTS = 40;

/**
 * A live P-5 assignment, and worth MORE than the margin below on purpose.
 *
 * Two rows of the same name and number is the ordinary case, not the exotic
 * one: Sky Resources has a `YOUNG  FANNIE` #6 on its current schedule and
 * another, plugged in 2021, in the next county. Those are not a tie to put to
 * the user — the live hole is the one they are editing — so the schedule alone
 * settles it, while still costing less than 0.15 of name score.
 */
const SCHEDULE_POINTS = 15;

/** Below this the name is not this well, whatever the number says. */
export const MIN_NAME_SCORE = 0.5;

/** How far ahead the winner must be to be taken without asking. */
export const DECISIVE_MARGIN = 10;

function weigh(token: string): number {
  return DESIGNATION.has(token) ? DESIGNATION_WEIGHT : 1;
}

/** Lowercase alphanumeric words. Punctuation and case are noise on both sides. */
export function tokenize(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A well number as both sides write it: digits with an optional letter tail,
 * which is how the mirror files sidetracks and water wells (`13W`, `1WS`,
 * `2A`, `1D`). The mirror also spaces some of them (`1 B`, `14 A`), so the
 * row's number is joined back up before comparing.
 */
const WELL_NO = /^\d+[a-z]{0,2}$/;

export interface ParsedName {
  /** The name tokens, with any well number taken out. */
  name: string[];
  /** The well number, or null when the input carries none. */
  wellNo: string | null;
}

/**
 * Split an input into a lease name and a well number.
 *
 * The LAST number-shaped token wins, because a lease can legitimately have one
 * in its name and the well's own number comes after it: `ASHBY 6X 1` is well 1
 * on the Ashby 6X. Both readings are scored anyway (see `rankWells`), so a name
 * that ends in its own number is not punished for it.
 */
export function parseFacilityName(input: string): ParsedName {
  const tokens = tokenize(input);
  let index = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (WELL_NO.test(tokens[i])) {
      index = i;
      break;
    }
  }
  if (index === -1) return { name: tokens, wellNo: null };
  return {
    name: [...tokens.slice(0, index), ...tokens.slice(index + 1)],
    wellNo: tokens[index],
  };
}

/**
 * Weighted Jaccard over two token sets: shared weight over total weight.
 *
 * A set, so `Fannie Young` and `YOUNG FANNIE` are the same name. Weighted, so a
 * designation word present on one side and absent on the other costs almost
 * nothing while a real word costs a lot.
 */
export function nameOverlap(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  let total = 0;
  for (const token of new Set([...left, ...right])) {
    const w = weigh(token);
    total += w;
    if (left.has(token) && right.has(token)) shared += w;
  }
  return total === 0 ? 0 : shared / total;
}

/** The row's well number, closed up: the mirror files `1 B` and `14 A`. */
function rowWellNo(wellNo: string | null): string {
  return tokenize(wellNo).join("");
}

function scoreAgainst(
  parsed: ParsedName,
  well: MatchableWell,
  leaseTokens: string[],
  rowNo: string
): RankedWell {
  const nameScore = nameOverlap(parsed.name, leaseTokens);
  const wellNoMatch = parsed.wellNo != null && rowNo === parsed.wellNo;
  return {
    well,
    nameScore,
    wellNoMatch,
    score:
      nameScore * 100 +
      (wellNoMatch ? WELL_NO_POINTS : 0) +
      (well.onSchedule ? SCHEDULE_POINTS : 0),
  };
}

/**
 * The operator's fleet, best first.
 *
 * Each row is scored under BOTH readings of the input — with its last number
 * taken as the well number, and with the whole thing taken as the name — and
 * keeps its better one. That is what lets `Ashby 6X` match the lease called
 * `ASHBY 6X` and `Roach 12` match well 12 on `ROACH`, without the caller having
 * to say which kind of name it typed.
 *
 * Rows are deduplicated by API first: the mirror carries one row per well x
 * lease x field, so a multiply-completed hole appears several times and would
 * otherwise fill the shortlist with itself. The row kept is the live one.
 */
export function rankWells(
  input: string,
  wells: MatchableWell[]
): RankedWell[] {
  const parsed = parseFacilityName(input);
  const whole: ParsedName = { name: tokenize(input), wellNo: parsed.wellNo };

  const best = new Map<string, RankedWell>();
  for (const well of wells) {
    const leaseTokens = tokenize(well.leaseName);
    const rowNo = rowWellNo(well.wellNo);
    const a = scoreAgainst(parsed, well, leaseTokens, rowNo);
    const b = scoreAgainst(whole, well, leaseTokens, rowNo);
    const scored = b.score > a.score ? b : a;
    const seen = best.get(well.apiNumber);
    if (!seen || scored.score > seen.score) best.set(well.apiNumber, scored);
  }

  return [...best.values()].sort(
    (x, y) =>
      y.score - x.score ||
      x.well.apiNumber.localeCompare(y.well.apiNumber)
  );
}

export interface MatchDecision {
  /** The well to use, or null when nothing is clear enough to use quietly. */
  pick: RankedWell | null;
  /** What to offer instead, best first. Empty when nothing came close. */
  choices: RankedWell[];
}

/**
 * Take the winner, or offer a shortlist.
 *
 * Two bars, and both have to clear. The name has to actually look like this
 * well (`MIN_NAME_SCORE`), so a fleet with no Baldwin in it returns nothing
 * rather than its least-bad row. And the winner has to be clear of the runner
 * up (`DECISIVE_MARGIN`), because two wells that score the same ARE two wells
 * the input does not distinguish, and the person who typed it is the only one
 * who knows which they meant.
 */
export function decideMatch(ranked: RankedWell[], shortlist = 3): MatchDecision {
  const viable = ranked.filter((r) => r.nameScore >= MIN_NAME_SCORE);
  if (viable.length === 0) return { pick: null, choices: [] };

  const [best, next] = viable;
  const decisive = !next || best.score - next.score >= DECISIVE_MARGIN;
  if (decisive) return { pick: best, choices: [] };
  return { pick: null, choices: viable.slice(0, shortlist) };
}

/**
 * A name that is entirely inside the other, which is not the same as being
 * equal to it and is not nothing either.
 *
 * An operator writes `Baldwin` where the state writes `BALDWIN, C. R.`, and a
 * set overlap scores that 0.33 — the initials are two thirds of the state's
 * name. Scored as CONTAINMENT it is a strong signal, and the caller's rule that
 * the winner must be strictly ahead of the runner-up is what keeps it safe: an
 * org that also has a `Baldwin C.R.` lease sees that one score higher, and an
 * org with only `Corbett` gets its `CORBETT RANCH` well filed there because
 * that is in fact where they keep it.
 */
const CONTAINMENT_SCORE = 0.8;

function contains(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const words = new Set(long);
  return short.every((w) => words.has(w));
}

/**
 * How alike two names are, 0..1. For comparing a state lease name against one
 * of the operator's own: `YOUNG, FANNIE` and `Fannie Young` are the same lease,
 * and `Baldwin` is probably `BALDWIN, C. R.`
 */
export function nameSimilarity(a: string | null, b: string | null): number {
  const left = tokenize(a);
  const right = tokenize(b);
  const overlap = nameOverlap(left, right);
  return contains(left, right) ? Math.max(overlap, CONTAINMENT_SCORE) : overlap;
}

/** How a candidate reads in a picker: `Young Fannie 6 (API 50339456)`. */
export function wellChoiceLabel(well: MatchableWell): string {
  // The mirror double-spaces its lease names (`YOUNG  FANNIE`); a picker should
  // not.
  const lease =
    titleCase(well.leaseName).replace(/\s+/g, " ").trim() ||
    `API ${well.apiNumber}`;
  const no = (well.wellNo ?? "").trim();
  return `${no ? `${lease} ${no}` : lease} (API ${well.apiNumber})`;
}
