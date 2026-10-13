"use server";

/**
 * Sync with RRC — filling a facility's settings form from the public record.
 *
 * The onboarding import answers "what does this operator have and what is in
 * it" for a whole fleet. This answers the same question for ONE facility that
 * already exists, on demand, and it WRITES NOTHING: the action returns values,
 * the modal shows them, and the user's Save is still the only thing that
 * reaches the database. Nothing here touches Supabase except to read which
 * operator numbers this workspace claims.
 *
 * ## Finding the row
 *
 * The identifier wins when there is one — an API number for a well, a lease
 * number for a lease — because it IS the state's identity for the thing. With
 * no identifier the fallback is the operator's own P-5 numbers plus the
 * facility's name, which is the pair that makes a name search safe: "Dollar"
 * matches 40 leases in Texas and one of them on this operator's schedule.
 *
 * Without an operator number on file there is no safe fallback at all, and
 * guessing from the name alone would offer another company's well as this one's
 * record. That case says so instead (`reason`).
 *
 * GATING: `rrc-db.ts` carries no authorization, so every path here calls
 * `assertSignedIn()` first, exactly as `link.ts` does.
 */

import { assertSignedIn } from "@/lib/auth/session";
import { getSupabaseServer } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { hasRrcDb, rrcQuery } from "@/lib/scout/rrc-db";
import { listOrgRrcOperators } from "@/lib/settings/rrc-operators";
import { getOrgInfo } from "@/lib/settings/org-info";
import { findOperatorCandidates } from "./operator-candidates";
import { matchOperators } from "./operator-match";
import { nameStem } from "./link";
import { wellName } from "./operator-fleet";
import {
  decideMatch,
  nameSimilarity,
  rankWells,
  tokenize,
  wellChoiceLabel,
  type MatchableWell,
} from "./well-match";
import { loadWellRecords } from "./well-record";
import {
  leaseFill,
  wellFill,
  type RrcLeaseFill,
  type RrcWellFill,
  type WellboreFacts,
} from "./facility-fill";

/**
 * What a sync produced. `ok: false` carries a sentence for the modal rather
 * than throwing: "the state has nothing on this well" is an answer, not a
 * failure, and it reads badly as a red error toast.
 */
export type RrcSyncResult<T> =
  | { ok: true; values: T; match: string }
  | { ok: false; reason: string; choices?: RrcChoice[] };

/** A near miss the user can pick, when the name does not settle it alone. */
export interface RrcChoice {
  apiNumber: string;
  label: string;
}

const FACT_COLS = `
  api_number, county_name, lease_name, lease_number, oil_gas_code, well_no,
  operator_name, operator_number, on_schedule,
  nullif(field_name, '') as field_name,
  nullif(api_depth, '')  as api_depth`;

/**
 * A lease name reduced to the same shape `nameStem` reduces ours to.
 *
 * BOTH sides have to lose their punctuation, not just ours. The mirror files
 * "BALDWIN  C. R." (double space, two periods) and `nameStem("Baldwin C. R. 1")`
 * is "baldwin c r", so collapsing only the whitespace left the periods in place
 * and the LIKE matched nothing — the well is on the operator's schedule and the
 * search said it did not exist. Measured against the live mirror: 0 rows before,
 * 4 after.
 *
 * One pass does it: `[^a-z0-9]+` swallows runs of punctuation AND runs of
 * spaces, so "baldwin  c. r." becomes "baldwin c r ".
 */
const NAME_KEY = `regexp_replace(lower(lease_name), '[^a-z0-9]+', ' ', 'g')`;

/** On-schedule first: 927,795 of 1,368,247 wellbore rows are historic. */
const CURRENT_FIRST = `on_schedule desc nulls last,
                       nullif(completion_date, '') desc nulls last,
                       oil_gas_code, lease_number`;

/*
 * Everything below is read by an operator on a form, not by us in a log. It
 * says what happened and what would fix it, in the words they use, and never
 * names a table, a column or an identifier they did not type themselves. The
 * branch that produced it goes to the server log instead (`fail`).
 */
/**
 * How much of a P-5 is read to rank a name against. The biggest operators in
 * Texas run into the thousands, and nobody with a fleet that size is matching
 * one well by hand from a settings modal; a truncation is logged rather than
 * quietly narrowing the search.
 */
const FLEET_LIMIT = 2000;

const NO_MIRROR =
  "Railroad Commission records are unavailable right now. Try again shortly.";
const NO_OPERATOR =
  "Could not tell which Railroad Commission operator this workspace is. Add your RRC operator number in Settings.";

/**
 * A "found nothing" answer, logged on the way out.
 *
 * Every one of these is a reason a user will ask about ("I clicked it and
 * nothing happened"), and the modal shows only the sentence — the server log is
 * where WHICH branch produced it is recoverable.
 */
function fail(
  action: string,
  reason: string,
  choices?: RrcChoice[]
): { ok: false; reason: string; choices?: RrcChoice[] } {
  console.info(`${action}: no match`, {
    reason,
    choices: choices?.map((c) => c.label) ?? [],
  });
  return choices?.length ? { ok: false, reason, choices } : { ok: false, reason };
}

/**
 * The operator numbers to search under, primary first.
 *
 * The linked ones win. A workspace that never went through the RRC step of
 * onboarding has none, and refusing to look anything up because of a number the
 * user has never been asked for is not an answer — so the company's own name is
 * matched against the P-5 register instead, with the same scorer onboarding
 * uses (`matchOperators`).
 */
async function operatorNumbers(): Promise<string[]> {
  const linked = (await listOrgRrcOperators()).map((o) => o.operatorNo);
  if (linked.length > 0) return linked;
  const matched = await operatorFromCompanyName();
  return matched ? [matched] : [];
}

/**
 * The operator this workspace IS, from its company name.
 *
 * Deliberately strict, because getting it wrong fills an operator's form with
 * ANOTHER COMPANY'S well. A name alone can never score `confident`
 * (`confidenceFor`: that needs the phone or an officer, neither of which is on
 * the org row), so the test here is uniqueness instead: the match is taken only
 * when it is the one candidate whose name matches exactly, or the only
 * non-weak candidate there is. Anything else is ambiguous and says so.
 *
 * The ZIP out of the company address is a free extra signal where there is one.
 */
async function operatorFromCompanyName(): Promise<string | null> {
  const org = await getOrgInfo();
  const companyName = (org?.name ?? "").trim();
  if (!companyName) {
    console.info("rrc sync: no company name on the org");
    return null;
  }
  const zip = org?.companyAddress?.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];

  const identity = { companyName, zip };
  const candidates = await findOperatorCandidates(identity);
  const { best, alternates } = matchOperators(identity, candidates);

  const exact = best?.signals.includes("company_exact") ?? false;
  const rivals = alternates.filter((a) => a.signals.includes("company_exact"));
  const unique =
    Boolean(best) && ((exact && rivals.length === 0) || alternates.length === 0);

  console.info("rrc sync: operator by company name", {
    companyName,
    zip: zip ?? "(none)",
    candidates: candidates.length,
    best: best
      ? `${best.candidate.operatorName} (${best.candidate.operatorNumber})`
      : "(none)",
    confidence: best?.confidence ?? "(none)",
    signals: best?.signals ?? [],
    alternates: alternates.length,
    taken: unique,
  });

  return unique && best ? best.candidate.operatorNumber : null;
}

/**
 * What the modal says it matched, so the operator can see it took the right
 * hole before they save. The name first, because that is what they recognise;
 * the API number after it, because that is what settles it.
 */
function wellLabel(row: WellboreFacts): string {
  return `Matched ${wellName(row)} (API ${row.api_number})`;
}

/**
 * Fill a well's settings form from the state record.
 *
 * `apiWellNo` is whatever is currently in the form's box, not a stored value:
 * a user who has just typed the number expects the button to use it.
 */
export async function syncWellFromRrc(input: {
  name: string;
  apiWellNo?: string;
}): Promise<RrcSyncResult<RrcWellFill>> {
  await assertSignedIn();
  console.info("syncWellFromRrc: start", {
    name: input.name,
    apiWellNo: input.apiWellNo || "(unset)",
    mirrorConfigured: hasRrcDb(),
  });
  if (!hasRrcDb()) return fail("syncWellFromRrc", NO_MIRROR);

  const digits = (input.apiWellNo ?? "").replace(/\D/g, "");
  let row: WellboreFacts | null = null;

  if (digits.length >= 8) {
    // char(8) on every row in the mirror, so a 10- or 14-digit number a user
    // pasted is reduced to the state's own key, never padded.
    const rows = await rrcQuery<WellboreFacts>(
      `select ${FACT_COLS}
         from rrc.wellbore
        where api_number = $1
        order by ${CURRENT_FIRST}
        limit 1`,
      [digits.slice(-8)]
    );
    row = rows[0] ?? null;
    console.info("syncWellFromRrc: by api", {
      api: digits.slice(-8),
      found: Boolean(row),
    });
    if (!row) {
      return fail(
        "syncWellFromRrc",
        "The Railroad Commission has no record for that API number."
      );
    }
  } else {
    const operators = await operatorNumbers();
    if (operators.length === 0) return fail("syncWellFromRrc", NO_OPERATOR);
    if (tokenize(input.name).length === 0) {
      return fail("syncWellFromRrc", "Enter a well name or API number first.");
    }

    /*
     * The whole fleet, then ranked here — NOT filtered by name in SQL.
     *
     * No pattern can match "Fannie Young 6 SWD" against `YOUNG  FANNIE` #6: the
     * words are in the other order, the designation is the operator's own, and
     * the number is mid-string. A P-5 is hundreds of rows on one indexed
     * column, so it is cheaper to read it and rank it in `well-match.ts`, where
     * the rule is pure and every real miss becomes a test.
     */
    const rows = await rrcQuery<WellboreFacts>(
      `select ${FACT_COLS}
         from rrc.wellbore
        where operator_number = any($1::text[])
        order by ${CURRENT_FIRST}
        limit ${FLEET_LIMIT}`,
      [operators]
    );
    if (rows.length === FLEET_LIMIT) {
      console.warn("syncWellFromRrc: fleet truncated", {
        operators,
        limit: FLEET_LIMIT,
      });
    }

    const byApi = new Map(rows.map((r) => [r.api_number, r]));
    const { pick, choices } = decideMatch(rankWells(input.name, rows.map(toMatchable)));
    console.info("syncWellFromRrc: by name", {
      name: input.name,
      operators,
      fleet: rows.length,
      picked: pick ? wellChoiceLabel(pick.well) : "(none)",
      score: pick?.score ?? null,
      choices: choices.map((c) => wellChoiceLabel(c.well)),
    });

    row = pick ? byApi.get(pick.well.apiNumber) ?? null : null;
    if (!row) {
      return fail(
        "syncWellFromRrc",
        choices.length
          ? "More than one well goes by that name. Which one?"
          : `No well matching "${input.name}" in your Railroad Commission records.`,
        choices.map((c) => ({
          apiNumber: c.well.apiNumber,
          label: wellChoiceLabel(c.well),
        }))
      );
    }
  }

  /*
   * The completion packet behind the wellbore. Swallowed on failure for the
   * same reason onboarding swallows it: the wellbore facts are worth filling in
   * on their own, and a mirror hiccup on the second query should not turn a
   * partial answer into no answer.
   */
  let record = null;
  try {
    record = (await loadWellRecords([row.api_number])).get(row.api_number) ?? null;
  } catch (error) {
    console.error("syncWellFromRrc: record load failed", error);
  }

  const values = wellFill(row, record);

  /*
   * And which of the operator's leases it belongs to.
   *
   * The state knows this — every wellbore row states the lease it is completed
   * on — so leaving `wells.lease_id` alone made the sync fill in a well's
   * geometry while saying nothing about the one fact that puts it on a page.
   * Resolved against the workspace's OWN leases, never created: making a lease
   * is a write, and this button writes nothing.
   */
  const lease = await resolveLeaseId(row);
  if (lease) values.leaseId = lease.id;

  if (Object.keys(values).length === 0) {
    return fail(
      "syncWellFromRrc",
      "The Railroad Commission has no details on file for this well."
    );
  }
  console.info("syncWellFromRrc: filled", {
    match: wellLabel(row),
    hasCompletionPacket: Boolean(record),
    lease: lease ? `${lease.name} (${lease.matchedOn})` : "(none)",
    fields: Object.keys(values),
  });
  return { ok: true, values, match: wellLabel(row) };
}

/** How alike two lease names must be before one is taken for the other. */
const LEASE_NAME_FLOOR = 0.8;

/**
 * The workspace's own lease for a state wellbore row, or null.
 *
 * Three ways to know, strongest first:
 *
 *  1. The lease already carries this record's number (`rrc_lease_no`), which is
 *     what onboarding writes and is a statement that they are the same lease.
 *  2. It carries it as the operator's own number (`lease_no`) — the same thing,
 *     for a lease imported before that column existed or typed by hand.
 *  3. The names agree. The state files `YOUNG, FANNIE` and the operator calls
 *     it Fannie Young, so this is the token-set comparison, not a string match.
 *
 * Null unless the answer is unambiguous. A name that half-matches two leases is
 * not a link, and quietly moving a well onto the wrong lease moves its
 * production with it.
 */
async function resolveLeaseId(
  row: WellboreFacts
): Promise<{ id: string; name: string; matchedOn: string } | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("leases")
    .select("id, name, lease_no, rrc_lease_no");
  if (error) {
    console.warn("syncWellFromRrc: lease lookup failed", error.message);
    return null;
  }
  const leases = (data ?? []) as {
    id: string;
    name: string | null;
    lease_no: string | null;
    rrc_lease_no: string | null;
  }[];

  const recordNo = (row.lease_number ?? "").trim();
  if (recordNo) {
    const byRecord = leases.filter(
      (l) => (l.rrc_lease_no ?? "").trim() === recordNo
    );
    if (byRecord.length === 1) {
      return {
        id: byRecord[0].id,
        name: byRecord[0].name ?? "",
        matchedOn: "rrc record",
      };
    }
    const byNumber = leases.filter(
      (l) => (l.lease_no ?? "").trim() === recordNo
    );
    if (byNumber.length === 1) {
      return {
        id: byNumber[0].id,
        name: byNumber[0].name ?? "",
        matchedOn: "lease number",
      };
    }
  }

  const scored = leases
    .map((l) => ({ lease: l, score: nameSimilarity(row.lease_name, l.name) }))
    .filter((s) => s.score >= LEASE_NAME_FLOOR)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
    return {
      id: scored[0].lease.id,
      name: scored[0].lease.name ?? "",
      matchedOn: `name ${scored[0].score.toFixed(2)}`,
    };
  }
  if (scored.length > 1) {
    console.info("syncWellFromRrc: lease name is ambiguous", {
      stateName: row.lease_name,
      tied: scored.map((s) => s.lease.name),
    });
  }
  return null;
}

/** A wellbore row as the ranker reads it. */
function toMatchable(row: WellboreFacts): MatchableWell {
  return {
    apiNumber: row.api_number,
    leaseName: row.lease_name,
    wellNo: row.well_no,
    onSchedule: row.on_schedule === "Y",
  };
}

/** The operator's on-schedule wells matching one predicate on `rrc.wellbore`. */
async function leaseWells(
  operators: string[],
  predicate: string,
  param: string
): Promise<WellboreFacts[]> {
  return rrcQuery<WellboreFacts>(
    `select ${FACT_COLS}
       from rrc.wellbore
      where operator_number = any($1::text[])
        and on_schedule = 'Y'
        and ${predicate}
      order by lease_number, well_no
      limit 500`,
    [operators, param]
  );
}

/**
 * Fill a lease's settings form from the state record.
 *
 * Resolved through the operator's WELLS rather than through `rrc.lease`: the
 * wellbore rows carry the county, which the lease table does not, and they are
 * how onboarding decides a property's number and county in the first place. A
 * lease whose wells are not on this P-5 falls back to `rrc.lease`, which can
 * still name the number.
 */
export async function syncLeaseFromRrc(input: {
  name: string;
  leaseNo?: string;
}): Promise<RrcSyncResult<RrcLeaseFill>> {
  await assertSignedIn();
  console.info("syncLeaseFromRrc: start", {
    name: input.name,
    leaseNo: input.leaseNo || "(unset)",
    mirrorConfigured: hasRrcDb(),
  });
  if (!hasRrcDb()) return fail("syncLeaseFromRrc", NO_MIRROR);

  const operators = await operatorNumbers();
  if (operators.length === 0) return fail("syncLeaseFromRrc", NO_OPERATOR);

  const leaseNo = (input.leaseNo ?? "").trim();
  const stem = nameStem(input.name);
  if (!leaseNo && !stem) {
    return fail(
      "syncLeaseFromRrc",
      "Enter a lease name or number first."
    );
  }

  /*
   * The number first, then the name — and NOT both at once. `leases.lease_no`
   * holds whatever the operator numbers their leases with, which is the RRC's
   * number on an imported lease and an internal one on a hand-entered lease.
   * Requiring both to match would make a lease with an internal number look
   * like a lease the state has never heard of.
   */
  const rows = leaseNo
    ? await leaseWells(operators, "lease_number = $2", leaseNo)
    : [];
  if (rows.length === 0 && stem) {
    rows.push(
      ...(await leaseWells(
        operators,
        `${NAME_KEY} like $2`,
        `%${stem}%`
      ))
    );
  }

  console.info("syncLeaseFromRrc: wells", {
    matchedBy: leaseNo && rows.length > 0 ? "lease number" : "name",
    stem,
    operators,
    wells: rows.length,
  });

  const values = leaseFill(rows);

  /*
   * The oil lease number, when the wells did not supply one.
   *
   * Two ways that happens, and `rrc.lease` answers both. A lease with no wells
   * on the P-5 has nothing to read at all — the empty-lease case
   * `searchRrcLeaseCandidates` exists for. And a GAS-ONLY property has wells
   * that give a county and no lease-level number, because every id they carry
   * is a well's: Fannie Young's three live wells file under three gas ids while
   * the property's oil lease, 08440, is only in the lease table. Reading it
   * only when the wells came back empty left that lease unnumbered.
   */
  if (!values.leaseNo && stem) {
    const leases = await rrcQuery<{ lease_no: string }>(
      `select distinct lease_no
         from rrc.lease
        where operator_no = any($1::text[])
          and oil_gas_code = 'O'
          and ${NAME_KEY} like $2
        order by lease_no
        limit 40`,
      [operators, `%${stem}%`]
    );
    const fromTable = leases.map((l) => l.lease_no.trim()).join(", ");
    console.info("syncLeaseFromRrc: oil lease from rrc.lease", {
      stem,
      records: leases.length,
      leaseNo: fromTable || "(none)",
    });
    if (fromTable) values.leaseNo = fromTable;
  }

  if (Object.keys(values).length === 0) {
    return fail(
      "syncLeaseFromRrc",
      stem
        ? `No lease matching "${input.name}" in your Railroad Commission records.`
        : "No lease matching that number in your Railroad Commission records."
    );
  }

  console.info("syncLeaseFromRrc: filled", {
    fields: Object.keys(values),
    leaseNo: values.leaseNo ?? "(none)",
  });
  return { ok: true, values, match: leaseMatchLabel(values, rows.length) };
}

/** What the modal says it matched: the record if there is one, else the wells. */
function leaseMatchLabel(values: RrcLeaseFill, wells: number): string {
  const wellCount = `${wells} well${wells === 1 ? "" : "s"}`;
  if (!values.leaseNo) return `Matched ${wellCount}`;
  const label = values.leaseNo.includes(",") ? "leases" : "lease";
  return wells > 0
    ? `Matched ${wellCount} on ${label} ${values.leaseNo}`
    : `Matched ${label} ${values.leaseNo}`;
}
