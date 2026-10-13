/**
 * Finding the handful of RRC operators that could plausibly be this company.
 *
 * A coarse filter, deliberately. It casts a wide net over the mirror on the four
 * things signup gives us, and `operator-match.ts` does the deciding in
 * TypeScript. Two reasons the scoring is not pushed into SQL: the nickname and
 * entity-suffix logic is not expressible there, and `pg_trgm` is not guaranteed
 * on the mirror, which is a read-only instance we do not control.
 *
 * ## No authorization here
 *
 * Same contract as the rest of `rrc-*`: this reads public record over a
 * service-role connection with no user identity attached, so gating is the
 * CALLER's job. The only caller is the onboarding action, which guards itself.
 *
 * ## Cost
 *
 * Four indexed lookups, capped, run concurrently, then deduped. The officer join
 * is the expensive one, which is why it is restricted to a surname rather than
 * to a free-text name.
 */
import { rrcQuery } from "@/lib/scout/rrc-db";
import {
  basicNormalize,
  normalizeCompany,
  normalizePhone,
  normalizeZip,
  parsePersonName,
  type OperatorCandidate,
} from "./operator-match";

/** How many rows each arm of the search may contribute. */
const PER_ARM = 25;
/** Hard ceiling on what gets scored, after dedup. */
const MAX_CANDIDATES = 60;

interface OperatorRow {
  operator_number: string;
  operator_name: string;
  phone1: string | null;
  phone2: string | null;
  zip1: string | null;
  zip2: string | null;
  city1: string | null;
  state1: string | null;
  well_count: number | null;
}

const SELECT = `
  select o.operator_number, o.operator_name,
         o.phone1, o.phone2, o.zip1, o.zip2, o.city1, o.state1,
         (select count(distinct w.api_number)::int
            from rrc.wellbore w
           where w.operator_number = o.operator_number
             and w.on_schedule = 'Y') as well_count
    from rrc.operators o`;

/**
 * The company-name arm.
 *
 * Matches on the FIRST distinctive word of the normalized name rather than on
 * the whole string, because the mirror stores `SKY RESOURCES OPERATING, LLC`
 * where the user typed `Sky`. A full-string ILIKE finds neither direction.
 */
async function byName(companyName: string, aliases: string[]): Promise<OperatorRow[]> {
  const stems = [companyName, ...aliases]
    .map(normalizeCompany)
    .flatMap((n) => n.split(" ").filter((w) => w.length >= 3))
    .slice(0, 4);
  if (stems.length === 0) return [];
  return rrcQuery<OperatorRow>(
    `${SELECT} where ${stems.map((_, i) => `o.operator_name ilike $${i + 1}`).join(" or ")}
      order by o.operator_name limit ${PER_ARM}`,
    stems.map((s) => `%${s}%`)
  );
}

/**
 * The phone arm, and the strongest signal there is.
 *
 * The mirror stores phones unformatted but inconsistently, so both sides are
 * reduced to their last ten digits in SQL before comparing. `regexp_replace` is
 * not indexable, hence the length guard: this arm only runs with a real number.
 */
async function byPhone(phone: string): Promise<OperatorRow[]> {
  // `normalizePhone` returns "" for the mirror's all-zero sentinel, so a caller
  // whose own number is 000-000-0000 cannot pull back the 7,926 operators that
  // carry the placeholder.
  const digits = normalizePhone(phone);
  if (digits.length !== 10) return [];
  return rrcQuery<OperatorRow>(
    `${SELECT}
      where right(regexp_replace(coalesce(o.phone1, ''), '\\D', '', 'g'), 10) = $1
         or right(regexp_replace(coalesce(o.phone2, ''), '\\D', '', 'g'), 10) = $1
      limit ${PER_ARM}`,
    [digits]
  );
}

/** The ZIP arm. Confirms rather than decides, but it is cheap and indexed. */
async function byZip(zip: string): Promise<OperatorRow[]> {
  // Sentinel-aware for the same reason as the phone arm.
  const five = normalizeZip(zip);
  if (five.length !== 5) return [];
  return rrcQuery<OperatorRow>(
    `${SELECT} where left(o.zip1, 5) = $1 or left(o.zip2, 5) = $1
      order by o.operator_name limit ${PER_ARM}`,
    [five]
  );
}

/**
 * The officer arm: operators one of whose filed officers shares this surname.
 *
 * Surname only. Given names are where the nicknames live and SQL cannot resolve
 * `Jim` to `James`, so the filter is deliberately loose here and tight in the
 * scorer.
 */
async function byOfficerSurname(personName: string): Promise<OperatorRow[]> {
  const parsed = parsePersonName(personName);
  if (!parsed?.last || parsed.last.length < 3) return [];
  return rrcQuery<OperatorRow>(
    `${SELECT}
      where exists (
        select 1 from rrc.operator_officers f
         where f.operator_number = o.operator_number
           and f.officer_name ilike $1
      )
      order by o.operator_name limit ${PER_ARM}`,
    [`%${parsed.last}%`]
  );
}

/** Officer names for the operators we are about to score. One round trip. */
async function officersFor(
  operatorNumbers: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (operatorNumbers.length === 0) return out;
  const rows = await rrcQuery<{ operator_number: string; officer_name: string }>(
    `select operator_number, officer_name
       from rrc.operator_officers
      where operator_number = any($1::text[])`,
    [operatorNumbers]
  );
  for (const r of rows) {
    const list = out.get(r.operator_number) ?? [];
    list.push(r.officer_name);
    out.set(r.operator_number, list);
  }
  return out;
}

export interface CandidateSearch {
  companyName: string;
  aliases?: string[];
  personName?: string;
  phone?: string;
  zip?: string;
}

/**
 * Candidates for scoring, from every arm that has an input.
 *
 * Order matters only for the cap: phone and officer arms are unshifted ahead of
 * the broad name arm, so that if 60 rows is not enough the ones dropped are the
 * ones that were never going to score above `weak`.
 */
export async function findOperatorCandidates(
  input: CandidateSearch
): Promise<OperatorCandidate[]> {
  const [phoneRows, officerRows, nameRows, zipRows] = await Promise.all([
    input.phone ? byPhone(input.phone) : Promise.resolve([]),
    input.personName ? byOfficerSurname(input.personName) : Promise.resolve([]),
    byName(input.companyName, input.aliases ?? []),
    input.zip ? byZip(input.zip) : Promise.resolve([]),
  ]);

  const seen = new Map<string, OperatorRow>();
  for (const row of [...phoneRows, ...officerRows, ...nameRows, ...zipRows]) {
    if (!seen.has(row.operator_number)) seen.set(row.operator_number, row);
  }
  const rows = [...seen.values()].slice(0, MAX_CANDIDATES);
  const officers = await officersFor(rows.map((r) => r.operator_number));

  return rows.map((r) => ({
    operatorNumber: r.operator_number,
    operatorName: r.operator_name,
    phones: [r.phone1, r.phone2],
    zips: [r.zip1, r.zip2],
    city: r.city1,
    state: r.state1,
    officerNames: officers.get(r.operator_number) ?? [],
    wellCount: r.well_count ?? 0,
  }));
}

/** Look up exactly one operator by number, for the typed-P-5 shortcut. */
export async function findOperatorByNumber(
  operatorNo: string
): Promise<OperatorCandidate | null> {
  const digits = operatorNo.replace(/\D/g, "");
  if (!digits) return null;
  const rows = await rrcQuery<OperatorRow>(
    `${SELECT} where o.operator_number = $1 limit 1`,
    [digits.padStart(6, "0")]
  );
  const row = rows[0];
  if (!row) return null;
  const officers = await officersFor([row.operator_number]);
  return {
    operatorNumber: row.operator_number,
    operatorName: row.operator_name,
    phones: [row.phone1, row.phone2],
    zips: [row.zip1, row.zip2],
    city: row.city1,
    state: row.state1,
    officerNames: officers.get(row.operator_number) ?? [],
    wellCount: row.well_count ?? 0,
  };
}

/** Free-text operator search for the "that's not us" path. */
export async function searchOperatorsByName(
  query: string
): Promise<OperatorCandidate[]> {
  const term = basicNormalize(query);
  if (term.length < 2) return [];
  const rows = await rrcQuery<OperatorRow>(
    `${SELECT} where o.operator_name ilike $1 order by o.operator_name limit ${PER_ARM}`,
    [`%${term}%`]
  );
  return rows.map((r) => ({
    operatorNumber: r.operator_number,
    operatorName: r.operator_name,
    phones: [r.phone1, r.phone2],
    zips: [r.zip1, r.zip2],
    city: r.city1,
    state: r.state1,
    officerNames: [],
    wellCount: r.well_count ?? 0,
  }));
}
