import "server-only";

import { z } from "zod";

import { rrcQuery } from "@/lib/scout/rrc-db";
import { resolveCounty } from "@/lib/scout/rrc-queries";
import { PERSON_NOTES, resolveOfficerNames } from "../people";
import { defineTool, type RrcTool } from "../tool";

/**
 * The third way into the record: by a PERSON.
 *
 * Scout's map has had this since it shipped (`searchPeople` / `getPerson` in
 * `rrc-queries.ts`), next to operator and county. The agent did not, which is
 * why a question naming a person came back empty: with no person tool in the
 * catalog the only thing it could do was search operator names, and a person is
 * not an operator. People do not hold wellbores. Operating companies do, and a
 * person reaches them through the P-5 officer file.
 *
 * Name matching is `../people.ts`, which is where the ordering, middle-name and
 * spelling tolerance lives and why it has to.
 */

// ------------------------------------------------------------------- notes

function fail(error: string) {
  return { ok: false as const, error };
}

/** How far back `permits_recent` looks. Fixed, so the number needs no caption. */
const PERMIT_MONTHS = 24;

const SCHEDULE_NOTE =
  "Well counts are wellbores currently ON SCHEDULE to the operator (on_schedule = 'Y'). That is what the RRC carries against the P-5 today, not everything the operator has ever held.";

// ------------------------------------------------------------------- shape

interface FleetRow {
  /** Null on the rollup row, which carries the totals across every operator. */
  operator_number: string | null;
  wells: number;
  wells_in_county: number;
}

interface PermitRow {
  operator_number: string;
  permits: number;
  last_issued: string | null;
}

// -------------------------------------------------------------------- 1

const personSearch = defineTool(
  "rrc_person_search",
  "Find a PERSON in the P-5 officer file by name, however it is spelled or ordered, and return every operator they are filed on with its fleet size, optionally narrowed to what those operators hold and have permitted in one county. This is the only way into the record by a person's name; operator search will not find one.",
  {
    name: z.string(),
    county: z.string().optional(),
    limit: z.number().int().positive().optional(),
  },
  async ({ name, county, limit }) => {
    const typed = name.trim();
    if (typed.length < 2) return fail("name is required.");
    const cap = Math.min(Math.max(Math.floor(limit ?? 50), 1), 200);

    const place = county?.trim() ? resolveCounty(county.trim()) : null;
    if (county?.trim() && !place) return fail(`Not a Texas county: "${county}".`);

    // Five, not more. Every alternate is JSON in the analyst's brief, and past
    // the first few they are people who merely share a surname. Observed live:
    // "David W. Arringtin" reaches two real David Arringtons, and the rest of
    // the list was Ben, Diane, Clay and Ryan.
    const matches = await resolveOfficerNames(typed, 5);
    if (!matches.length) {
      return fail(
        `No P-5 officer name resembles "${typed}". That is an answer, not an error: the P-5 officer file covers every operator registered in Texas, so a name absent from it operates nothing here under its own P-5. The person may still hold a working interest, a royalty or a share of an operating company under another name, none of which the RRC publishes.`
      );
    }

    const resolved = matches[0];
    const affiliations = await rrcQuery<{
      operator_number: string;
      operator_name: string | null;
      p5_status: string | null;
      officer_title: string | null;
    }>(
      `select btrim(oo.operator_number) as operator_number,
              o.operator_name, o.p5_status,
              string_agg(distinct nullif(btrim(oo.officer_title), ''), ' / ') as officer_title
         from rrc.operator_officers oo
         left join rrc.operators o on o.operator_number = oo.operator_number
        where oo.officer_name = $1
          and oo.operator_number is not null
        group by btrim(oo.operator_number), o.operator_name, o.p5_status
        limit 500`,
      [resolved.officer_name]
    );

    const operatorNos = affiliations.map((a) => a.operator_number);
    const [fleets, permits] = await Promise.all([
      operatorNos.length
        ? /*
           * ROLLUP, so the county total is COUNTED rather than summed from the
           * per-operator rows.
           *
           * `rrc.wellbore` is one row per well x lease x field, and a person's
           * operators can hold the same api_number between them, so adding up
           * per-operator distinct counts reads more wells than exist. Two
           * derivations of one number that can disagree is the bug, whether or
           * not it has fired yet.
           */
          rrcQuery<FleetRow>(
            `select btrim(operator_number) as operator_number,
                    count(distinct api_number)::int as wells,
                    count(distinct api_number) filter (
                      where $2::text is null or county_code = $2)::int as wells_in_county
               from rrc.wellbore
              where operator_number = any($1) and on_schedule = 'Y'
              group by rollup(btrim(operator_number))`,
            [operatorNos, place?.county_no ?? null]
          )
        : Promise.resolve([] as FleetRow[]),
      operatorNos.length
        ? rrcQuery<PermitRow>(
            `select btrim(operator_number) as operator_number,
                    count(*)::int as permits,
                    to_char(max(issued_date), 'YYYY-MM-DD') as last_issued
               from rrc.permit
              where operator_number = any($1)
                and issued_date > (current_date - interval '${PERMIT_MONTHS} months')
                and ($2::text is null or county_code = $2)
              group by 1`,
            [operatorNos, place?.county_no ?? null]
          )
        : Promise.resolve([] as PermitRow[]),
    ]);

    const fleetBy = new Map(
      fleets.filter((f) => f.operator_number !== null).map((f) => [f.operator_number!, f])
    );
    const fleetTotal = fleets.find((f) => f.operator_number === null) ?? null;
    const permitBy = new Map(permits.map((p) => [p.operator_number, p]));

    const operators = affiliations
      .map((a) => {
        const f = fleetBy.get(a.operator_number);
        const p = permitBy.get(a.operator_number);
        return {
          operator_no: a.operator_number,
          operator_name: a.operator_name,
          p5_status: a.p5_status,
          officer_title: a.officer_title,
          wells_on_schedule: f?.wells ?? 0,
          // Only meaningful when a county was asked for; without one it repeats
          // the statewide count, so it is dropped instead.
          wells_in_county: place ? (f?.wells_in_county ?? 0) : null,
          permits_recent: p?.permits ?? 0,
          last_permit_issued: p?.last_issued ?? null,
        };
      })
      .sort(
        (a, b) =>
          (b.wells_in_county ?? 0) - (a.wells_in_county ?? 0) ||
          b.wells_on_schedule - a.wells_on_schedule
      );

    const here = place ? operators.filter((o) => (o.wells_in_county ?? 0) > 0 || o.permits_recent > 0) : operators;

    return {
      ok: true as const,
      query: { name: typed, county: place?.county_name ?? null },
      resolved: {
        officer_name: resolved.officer_name,
        matched: resolved.matched,
        score: resolved.score,
        operator_count: resolved.operator_count,
      },
      // Same-name people do not merge here, so a second candidate is a second
      // person to ask about, not a duplicate. Re-call with the exact string.
      other_matches: matches.slice(1).map((m) => ({
        officer_name: m.officer_name,
        matched: m.matched,
        score: m.score,
        operator_count: m.operator_count,
      })),
      operators_total: operators.length,
      operators: (place ? here : operators).slice(0, cap),
      truncated: (place ? here : operators).length > cap || affiliations.length >= 500,
      county_summary: place
        ? {
            county_no: place.county_no,
            county_name: place.county_name,
            operators_active: here.length,
            // From the rollup row, not from adding up the list. A permit belongs
            // to exactly one operator so that one is safe to sum; a wellbore is
            // not.
            wells_on_schedule: fleetTotal?.wells_in_county ?? 0,
            permits_last_24mo: here.reduce((a, o) => a + o.permits_recent, 0),
          }
        : null,
      notes: [
        ...PERSON_NOTES,
        resolved.matched === "exact"
          ? "The name matched the file exactly."
          : `The name was matched by ${resolved.matched}, not exactly. Say which name was actually read before reporting what it holds.`,
        place && here.length === 0
          ? `None of the ${operators.length} operators filed under this name holds a well on schedule or has taken a permit in ${place.county_name} County in the last ${PERMIT_MONTHS} months. That is a real finding: they are registered in Texas and active elsewhere, or not active at all.`
          : `Permits counted are those ISSUED in the last ${PERMIT_MONTHS} months. A permit is an option to drill, not a commitment, and it runs two years.`,
        SCHEDULE_NOTE,
        "The operator numbers here are the key every other RRC tool takes as operator_no. Pass them straight through to ask what these companies are actually doing.",
      ].filter(Boolean),
    };
  }
);

export const TOOLS: RrcTool[] = [personSearch];
