/**
 * Deciding which RRC operator a signing-up company IS.
 *
 * Pure functions, no I/O. The caller coarse-filters candidates out of the mirror
 * (surname ILIKE, or zip, or phone digits) and hands them here to be scored, so
 * this module is fully testable without a database and without an API key. That
 * matters more here than almost anywhere else in the app: this code decides
 * whether a new customer's account gets filled with ANOTHER COMPANY'S wells.
 *
 * ## The signals, and why they are weighted the way they are
 *
 * Signup collects a person's name and phone, and a company name and address. The
 * mirror holds, per operator, a name, two phone numbers, two address blocks, and
 * a separate table of officers.
 *
 *   phone           very high   near unique, rarely shared between operators
 *   officer name    very high   this is the PERSON, not the company
 *   company name    high        strong, but entity names repeat across Texas
 *   zip             medium      confirms, never decides
 *   city + state    low         tie-breaker only
 *
 * Two known traps, both of which cap how far any single signal can carry. P-5
 * addresses and phone numbers are frequently the registered agent's or the
 * attorney's rather than the operator's, so an address MISS is weak evidence of
 * anything. And plenty of small operators file under an entity name that is not
 * the name they trade under, which is what the alias list exists for.
 *
 * ## Why no fuzzy string distance
 *
 * Normalization does the work instead. Trigram similarity on `SKY RESOURCES
 * OPERATING, LLC` against `Sky` scores terribly while being a perfect match, and
 * scores well against `SKYLINE RESOURCES LLC` while being a different company.
 * Stripping the entity suffixes and the filler words is both more accurate and
 * explicable to a user, which matters when the UI has to say why it thinks this
 * is you. `pg_trgm` is also not guaranteed on the mirror; it is a read-only
 * instance we do not control.
 */
import { NICKNAME_EDGES, NICKNAME_PARENTS } from "./nicknames.generated";

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/**
 * Legal-entity suffixes. Stripped from both sides before comparing, because
 * whether the user typed "LLC" says nothing about whether it is their company.
 */
const ENTITY_SUFFIXES = new Set([
  "llc", "l l c", "inc", "incorporated", "co", "corp", "corporation",
  "lp", "llp", "lllp", "ltd", "limited", "company", "partnership", "pllc",
  "plc", "pc", "trust", "holdings", "holding", "group",
]);

/**
 * Industry filler. A third of Texas operator names contain one of these, so they
 * carry almost no discriminating power: `SKY RESOURCES OPERATING` and `SKY OIL &
 * GAS` are far more likely to be one company than two.
 *
 * Deliberately NOT stripped when it would empty the name — `ENERGY TRANSFER` is
 * a real operator whose whole name is filler, and reducing it to nothing would
 * make it match everything. See `normalizeCompany`.
 */
/**
 * Grammatical noise, dropped before either pass rather than counted as filler.
 * `&` expands to " and " during normalization, so `Sky Oil & Gas Inc.` would
 * otherwise key as "sky and", and the all-filler fallback would keep the "and"
 * it was trying to discard.
 */
const STOPWORDS = new Set(["and", "the", "of"]);

const FILLER_WORDS = new Set([
  "oil", "gas", "operating", "operations", "production", "producing",
  "energy", "resources", "resource", "petroleum", "exploration", "drilling",
  "development", "properties", "property", "royalty", "royalties",
  "minerals", "mineral", "ventures", "venture", "partners", "enterprises",
  "industries", "services", "management",
]);

/** Casefold, strip punctuation and accents, collapse whitespace. */
export function basicNormalize(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The comparable form of a company name.
 *
 * `SKY RESOURCES OPERATING, LLC` and `Sky Resources` both reduce to `sky`, which
 * is the match we want without the user configuring anything.
 *
 * If stripping would leave nothing, the filler-stripped step is abandoned and the
 * suffix-stripped form is kept. `ENERGY TRANSFER PARTNERS LP` is entirely filler
 * by this vocabulary, and an empty key matches every other empty key.
 */
export function normalizeCompany(value: string | null | undefined): string {
  const words = basicNormalize(value)
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w));
  const withoutEntity = words.filter((w) => !ENTITY_SUFFIXES.has(w));
  const core = withoutEntity.filter((w) => !FILLER_WORDS.has(w));
  const kept = core.length > 0 ? core : withoutEntity;
  return kept.join(" ");
}

/**
 * All-zero strings are the mirror's "no value", not a value.
 *
 * `rrc.operators` stores a missing phone as `0000000000` and a missing ZIP as
 * `000000000`, and 7,926 operators carry one or the other. Treating them as data
 * would make every one of those operators share a phone number with every other,
 * which is the difference between a weak signal and a catastrophic one.
 */
function isSentinel(digits: string): boolean {
  return digits.length > 0 && /^0+$/.test(digits);
}

/** Digits only, and the last 10 of them (drops a leading country code). */
export function normalizePhone(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (isSentinel(digits)) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** First five digits of a US zip, so 76450 and 76450-1234 compare equal. */
export function normalizeZip(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (isSentinel(digits)) return "";
  return digits.slice(0, 5);
}

/* ------------------------------------------------------------------ *
 * People
 * ------------------------------------------------------------------ */

export interface PersonName {
  first: string;
  last: string;
}

/**
 * Parse a name as the RRC stores it.
 *
 * Officer names arrive shouty and surname-first (`RANKIN, JAMES E`), but the
 * table is not consistent about it, so a name with no comma is read
 * first-last (`JAMES RANKIN`). Middle names and initials are dropped: they are
 * absent from what signup collects, so they can only ever cause a false miss.
 */
export function parsePersonName(raw: string | null | undefined): PersonName | null {
  if (!raw) return null;

  // Split on the comma BEFORE normalizing, since normalization strips it.
  if (raw.includes(",")) {
    const [lastRaw, firstRaw = ""] = raw.split(",");
    const last = basicNormalize(lastRaw).split(" ").filter(Boolean)[0] ?? "";
    const first = basicNormalize(firstRaw).split(" ").filter(Boolean)[0] ?? "";
    if (!last) return null;
    return { first, last };
  }

  const parts = basicNormalize(raw).split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { first: "", last: parts[0] };
  return { first: parts[0], last: parts[parts.length - 1] };
}

/**
 * Are these two given names the same person's name?
 *
 * Three bounded tests, never a transitive closure (see the generator's header
 * for what the closure does to this data):
 *
 *   1. equal after normalization
 *   2. adjacent in the source, either direction: james/jim, robert/bob
 *   3. a shared formal parent AND a shared prefix: jim/jimmy, bob/bobby
 *
 * Rule 3 needs the prefix guard. Robert's diminutives include both Bob and Bill,
 * so a bare shared-parent test makes Bob and Bill the same name — and in the
 * real world a Robert goes by one of them, not both. Requiring that one be a
 * prefix of the other keeps jim/jimmy and drops bob/bill.
 *
 * What this deliberately does NOT do is match John and Jackson because both can
 * be called Jack. They are different names that happen to share a diminutive.
 */
export function sameGivenName(a: string, b: string): boolean {
  const x = basicNormalize(a);
  const y = basicNormalize(b);
  if (!x || !y) return false;
  if (x === y) return true;

  if ((NICKNAME_EDGES[x] ?? []).includes(y)) return true;

  const px = NICKNAME_PARENTS[x] ?? [];
  const py = NICKNAME_PARENTS[y] ?? [];
  const sharesParent = px.some((p) => py.includes(p));
  return sharesParent && (x.startsWith(y) || y.startsWith(x));
}

/** Surname must match exactly; the given name may be a nickname of the other. */
export function samePerson(a: PersonName, b: PersonName): boolean {
  if (!a.last || !b.last) return false;
  if (basicNormalize(a.last) !== basicNormalize(b.last)) return false;
  if (!a.first || !b.first) return true;
  if (sameGivenName(a.first, b.first)) return true;
  // Initial fallback: `J RANKIN` against `Jim Rankin`. Last resort, and only
  // when one side is a bare initial, so it cannot make James match John.
  const x = basicNormalize(a.first);
  const y = basicNormalize(b.first);
  if (x.length === 1 || y.length === 1) return x[0] === y[0];
  return false;
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/** What signup knows about the company signing up. */
export interface SignupIdentity {
  companyName: string;
  /** Extra names the company trades under. Empty at signup; used on re-match. */
  aliases?: string[];
  personName?: string;
  phone?: string;
  zip?: string;
  city?: string;
  state?: string;
}

/** One operator out of the mirror, reduced to what scoring reads. */
export interface OperatorCandidate {
  operatorNumber: string;
  operatorName: string;
  phones: (string | null)[];
  zips: (string | null)[];
  city: string | null;
  state: string | null;
  officerNames: string[];
  wellCount?: number;
}

/** Which signals fired, so the UI can say WHY this is the match. */
export type MatchSignal =
  | "phone"
  | "officer"
  | "company_exact"
  | "company_partial"
  | "zip"
  | "city_state";

export type Confidence = "confident" | "possible" | "weak";

export interface ScoredOperator {
  candidate: OperatorCandidate;
  score: number;
  signals: MatchSignal[];
  confidence: Confidence;
  /** One line for the card: "Same phone number, and Jim Rankin is an officer." */
  reason: string;
}

const WEIGHTS: Record<MatchSignal, number> = {
  phone: 50,
  officer: 45,
  company_exact: 30,
  company_partial: 12,
  zip: 10,
  city_state: 4,
};

/**
 * `confident` is what promotes a candidate to "Is this you?" rather than to the
 * alternates list, so it takes one of the two signals that identify a specific
 * company: the phone, or the person. An exact company-name match alone is not
 * enough, because normalization is aggressive by design and `SKY` is a plausible
 * key for more than one Texas operator.
 */
function confidenceFor(signals: MatchSignal[], score: number): Confidence {
  const strong = signals.includes("phone") || signals.includes("officer");
  if (strong) return "confident";
  if (signals.includes("company_exact") && score >= WEIGHTS.company_exact + WEIGHTS.zip) {
    return "confident";
  }
  if (signals.includes("company_exact") || signals.includes("company_partial")) {
    return "possible";
  }
  return "weak";
}

function reasonFor(signals: MatchSignal[], person: string | null): string {
  const parts: string[] = [];
  if (signals.includes("phone")) parts.push("same phone number");
  if (signals.includes("officer")) {
    parts.push(person ? `${person} is listed as an officer` : "your name is on the filing");
  }
  if (signals.includes("company_exact")) parts.push("company name matches");
  else if (signals.includes("company_partial")) parts.push("similar company name");
  if (signals.includes("zip")) parts.push("same ZIP code");
  else if (signals.includes("city_state")) parts.push("same city");
  if (parts.length === 0) return "Weak match.";
  const line = parts.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1) + ".";
}

/** Does either name contain the other, once both are normalized to their core? */
function companyOverlap(a: string, b: string): "exact" | "partial" | null {
  if (!a || !b) return null;
  if (a === b) return "exact";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Word-boundary containment, so `sky` matches `sky resources` but not
  // `skyline`. The bare `includes` here was the first bug this function had.
  const words = long.split(" ");
  const shortWords = short.split(" ");
  const contained = shortWords.every((w) => words.includes(w));
  return contained ? "partial" : null;
}

export function scoreOperator(
  identity: SignupIdentity,
  candidate: OperatorCandidate
): ScoredOperator {
  const signals: MatchSignal[] = [];

  const phone = normalizePhone(identity.phone);
  if (phone && candidate.phones.some((p) => normalizePhone(p) === phone)) {
    signals.push("phone");
  }

  const person = identity.personName ? parsePersonName(identity.personName) : null;
  if (person) {
    const officers = candidate.officerNames
      .map(parsePersonName)
      .filter((n): n is PersonName => n !== null);
    if (officers.some((o) => samePerson(person, o))) signals.push("officer");
  }

  const theirs = normalizeCompany(candidate.operatorName);
  const ours = [identity.companyName, ...(identity.aliases ?? [])]
    .map(normalizeCompany)
    .filter(Boolean);
  const overlaps = ours.map((o) => companyOverlap(o, theirs));
  if (overlaps.includes("exact")) signals.push("company_exact");
  else if (overlaps.includes("partial")) signals.push("company_partial");

  const zip = normalizeZip(identity.zip);
  if (zip && candidate.zips.some((z) => normalizeZip(z) === zip)) {
    signals.push("zip");
  } else if (
    identity.city &&
    identity.state &&
    basicNormalize(identity.city) === basicNormalize(candidate.city) &&
    basicNormalize(identity.state) === basicNormalize(candidate.state)
  ) {
    signals.push("city_state");
  }

  const score = signals.reduce((sum, s) => sum + WEIGHTS[s], 0);
  return {
    candidate,
    score,
    signals,
    confidence: confidenceFor(signals, score),
    reason: reasonFor(signals, identity.personName ?? null),
  };
}

export interface MatchResult {
  /** The card. Null when nothing scored above `weak`. */
  best: ScoredOperator | null;
  /** Ranked runners-up, always shown, capped. */
  alternates: ScoredOperator[];
}

/**
 * Rank the candidates.
 *
 * `weak` matches are dropped rather than shown: a list of operators that merely
 * share a city is worse than an empty result, because it invites the user to
 * pick one to get past the step.
 */
export function matchOperators(
  identity: SignupIdentity,
  candidates: OperatorCandidate[],
  maxAlternates = 4
): MatchResult {
  const ranked = candidates
    .map((c) => scoreOperator(identity, c))
    .filter((s) => s.confidence !== "weak")
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.candidate.wellCount ?? 0) - (a.candidate.wellCount ?? 0) ||
        a.candidate.operatorName.localeCompare(b.candidate.operatorName)
    );

  return {
    best: ranked[0] ?? null,
    alternates: ranked.slice(1, 1 + maxAlternates),
  };
}
