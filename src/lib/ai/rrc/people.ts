import "server-only";

import { rrcQuery } from "@/lib/scout/rrc-db";
import { basicNormalize, parsePersonName, sameGivenName } from "@/lib/rrc/operator-match";

/**
 * Resolving a person's name, as a human types it, to the officer names the RRC
 * actually stores.
 *
 * ## The failure this exists for
 *
 * A user asked what a named person was doing in a county. The agent searched
 * OPERATORS, because searching for a person was not something it could do, and
 * came back with nothing. The name it was given carried a middle name and a
 * misspelled surname, so even the one tool that took an `officer_name` would
 * have found nothing: it matched `officer_name ilike '%<the whole string>%'`
 * against a table that stores `SMITH, JOHN B.`.
 *
 * Three separate things had to be wrong at once for that to happen, and all
 * three are ordinary:
 *
 *   1. ORDER. The mirror is surname-first. `%John Smith%` matches zero rows
 *      against `SMITH, JOHN`, and it is not a near miss, it is a total one.
 *   2. MIDDLE NAMES. `parsePersonName` drops them on both sides, because the
 *      middle name is the part a caller is most likely to supply and the record
 *      is least likely to carry in the same form.
 *   3. SPELLING. A substring match has no tolerance at all. One wrong letter and
 *      the answer is "no such person", which reads exactly like "that person
 *      operates nothing", and those are opposite answers.
 *
 * ## Why trigrams
 *
 * `pg_trgm` is installed on the mirror and `rrc.operator_officers` carries a
 * `officers_name_trgm` GIN index over `officer_name`, so both the `%` similarity
 * operator and a leading-wildcard `ilike` are index-supported. Verified against
 * the live mirror: "Smithe, John" reaches `SMITH, JOHN` at 0.77 in 67ms, and the
 * fully mangled "John Michael Smithe" still pulls the Smiths in 166ms.
 *
 * That is a stronger guarantee than the comment in `operator-candidates.ts`
 * assumes ("pg_trgm is not guaranteed on the mirror"). It was true when that was
 * written. The extension is there now, and the index with it.
 *
 * ## Why the ranking is not just the similarity score
 *
 * Trigram similarity is over the WHOLE string, so a middle name gets a vote. On
 * "John Michael Smithe" the raw score puts `SMITH, MICHAEL` above `SMITH, JOHN`,
 * because "Michael" is spelled right and appears in both. So SQL scores the
 * surname separately and the given name is decided in TypeScript by
 * `sameGivenName`, which knows that Jim is James and that Bob is not Bill.
 * Surname-and-given-name beats surname alone beats a bare fuzzy hit.
 */

/** Rows pulled back before the ranking runs. */
const CANDIDATE_CAP = 200;

/**
 * How close a surname has to be to count as the same surname.
 *
 * `pg_trgm` similarity, not a letter count. Measured on the mirror: SMITH
 * against "smithe" is 0.83 and against "smyth" is 0.44, so this admits the
 * common trailing-letter typo and the common vowel swap while still refusing a
 * different name. It only decides RANK, never admission, so a value under it is
 * still returned when nothing better matched.
 */
const SURNAME_CLOSE = 0.4;

export interface OfficerMatch {
  /** The name exactly as the mirror stores it. Pass this back verbatim. */
  officer_name: string;
  /** Distinct P-5 operators this exact name is filed on. */
  operator_count: number;
  /** Whole-string trigram similarity to what the caller typed, 0 to 1. */
  score: number;
  /** How the name matched, for a caller that has to explain itself. */
  matched: "exact" | "surname and given name" | "surname" | "fuzzy";
}

interface Row {
  officer_name: string;
  operator_count: number;
  sim: number;
  surname_sim: number;
}

/**
 * Officer names resembling `raw`, best first.
 *
 * Empty when nothing resembles it, which is a real answer: this is the whole
 * P-5 officer file, so a name absent from it is a name that operates nothing in
 * Texas under its own P-5.
 */
export async function resolveOfficerNames(
  raw: string,
  limit = 10
): Promise<OfficerMatch[]> {
  const typed = raw.trim();
  if (typed.length < 2) return [];

  const want = parsePersonName(typed);
  // Surname-first, the way the mirror writes it. `parsePersonName` has already
  // dropped the middle name, which is the point.
  const canonical = want?.last
    ? want.first
      ? `${want.last}, ${want.first}`
      : want.last
    : "";

  // Three arms, all served by `officers_name_trgm`. Fragments are literals in
  // this file; every value is bound.
  const params: unknown[] = [];
  const arms: string[] = [];
  /** The whole-string probes, whose similarity is also what ranks a row. */
  const simExprs: string[] = [];

  const bind = (value: unknown): number => params.push(value);

  const fuzzy = (probe: string) => {
    const at = bind(probe);
    arms.push(`officer_name % $${at}`);
    simExprs.push(`similarity(o.officer_name, $${at})`);
  };

  fuzzy(typed);
  if (canonical && canonical.toLowerCase() !== typed.toLowerCase()) fuzzy(canonical);
  if (want?.last && want.last.length >= 3) {
    // The surname arm. A one-word probe scores badly against a full name under
    // whole-string similarity, so "Rankin" alone needs a prefix match to reach
    // "RANKIN, POAGE H." at all. It admits rows; it does not score them.
    arms.push(`officer_name ilike $${bind(`${want.last}%`)}`);
  }

  const surnameParam = want?.last ? bind(want.last) : null;

  const rows = await rrcQuery<Row>(
    `with hit as (
       select distinct officer_name
         from rrc.operator_officers
        where (${arms.join(" or ")})
          and nullif(btrim(officer_name), '') is not null
        limit ${CANDIDATE_CAP}
     )
     select o.officer_name,
            count(distinct o.operator_number)::int as operator_count,
            greatest(${simExprs.join(", ")})::float8 as sim,
            ${
              surnameParam
                ? `similarity(btrim(split_part(o.officer_name, ',', 1)), $${surnameParam})::float8`
                : `0::float8`
            } as surname_sim
       from rrc.operator_officers o
       join hit h on h.officer_name = o.officer_name
      where o.operator_number is not null
      group by o.officer_name`,
    params
  );

  const typedNorm = basicNormalize(typed);
  const ranked = rows.map((r) => {
    const got = parsePersonName(r.officer_name);
    const surnameClose = r.surname_sim >= SURNAME_CLOSE;
    const givenClose = Boolean(
      want?.first && got?.first && sameGivenName(want.first, got.first)
    );
    const exact = basicNormalize(r.officer_name) === typedNorm;
    const tier = exact ? 4 : surnameClose && givenClose ? 3 : surnameClose ? 2 : 1;
    return {
      officer_name: r.officer_name,
      operator_count: r.operator_count,
      score: Number(r.sim.toFixed(3)),
      matched: (exact
        ? "exact"
        : tier === 3
          ? "surname and given name"
          : tier === 2
            ? "surname"
            : "fuzzy") as OfficerMatch["matched"],
      tier,
    };
  });

  ranked.sort(
    (a, b) =>
      b.tier - a.tier ||
      b.score - a.score ||
      b.operator_count - a.operator_count ||
      a.officer_name.localeCompare(b.officer_name)
  );

  // `tier` is a ranking device, not an answer. It leaves here so a caller cannot
  // start branching on a number whose scale is private to this file.
  return ranked.slice(0, limit).map((m) => ({
    officer_name: m.officer_name,
    operator_count: m.operator_count,
    score: m.score,
    matched: m.matched,
  }));
}

/**
 * The caveats that ride on any answer keyed to a person's name.
 *
 * Attached to the RESULT rather than left in a comment, for the same reason the
 * screening tools do it: a reader who does not have them cannot catch the error.
 */
export const PERSON_NOTES = [
  "A person here is an OFFICER NAME on a P-5, matched as text. Two different people with the same name are one row, and one person filed under two spellings is two rows. Confirm identity before acting on it.",
  "Being named on a P-5 is not ownership. It says the Commission was told this person is an officer of that company. It says nothing about who owns it, who funds it, or who takes the revenue.",
  "The P-5 officer file is a SNAPSHOT with no history. An operator someone left is still filed against them until the P-5 is refiled, so an old affiliation can look current, and a recent one can be missing.",
  "People do not hold wellbores, operating companies do. Everything counted here belongs to the operators the person is filed on, not to the person.",
];
