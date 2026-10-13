import "server-only";

import { getSupabaseServer } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { assertSignedIn } from "@/lib/auth/session";
import { hasRrcDb, rrcQuery } from "@/lib/scout/rrc-db";
import {
  getLeaseDossier,
  getWellDossier,
  getWellInjection,
} from "@/lib/scout/rrc-queries";
import { toPdqDistrict } from "@/lib/scout/rrc-districts";
import type {
  LeaseDossier,
  WellboreRow,
  WellDossier,
  WellInjection,
} from "@/lib/scout/rrc-types";

/**
 * Connecting a Wildcat well or lease to the Texas RRC public record.
 *
 * **No mapping table.** The identifier IS the connection, and it is stored on
 * the thing it identifies — never in a join table that would become a second
 * source of truth. For a well that slot already existed: `wells.api_well_no`
 * (`2026070600200_well_regulatory_ids.sql`). A link table would be a second
 * source of truth for a join the identifier already expresses.
 *
 * So the shape is: search the mirror for candidates, let a human confirm which
 * one is theirs, write the identifier into the slot that exists, and from then
 * on every read is a direct lookup by that number. Nothing else is copied — the
 * mirror is the record, and duplicating its facts into Supabase would only
 * create rows that go stale when the RRC reloads.
 *
 * A LEASE resolves through its wells by default: they carry API numbers, and
 * every mirror wellbore row states the lease it is completed on. That covers a
 * lease that has wells. It cannot cover an EMPTY lease — one recorded before its
 * wells are entered, or whose wells carry no API number yet — so a lease may
 * also hold the RRC key directly (`leases.rrc_lease_no` + district + commodity).
 * The stored key wins when set; otherwise the wells answer.
 *
 * GATING. `rrc-db.ts` carries no authorization of its own and requires every
 * caller to gate first, so every function here that touches the mirror calls
 * `assertSignedIn()`. Reading our OWN well's stored number does not.
 *
 * Signed-in, NOT early access. This is the Texas public record — data we have
 * assembled and put a UI in front of, not anything proprietary — and gating it
 * locked out the customers it is for. What early access still hides is the
 * `/scout` page itself, which is a different question from whether a well may
 * show what the state has on file for it.
 */

/** A lease's identity in the public record. */
export interface RrcLeaseKey {
  oilGasCode: "O" | "G";
  districtNo: string;
  leaseNo: string;
}

/** A mirror wellbore the user might be looking at, for the confirm modal. */
export interface RrcCandidate {
  apiNumber: string;
  /** 'Y' only for the operator's current assignment; historic rows are blank. */
  onSchedule: boolean;
  leaseName: string | null;
  leaseNumber: string | null;
  wellNo: string | null;
  district: string | null;
  countyName: string | null;
  operatorName: string | null;
  operatorNumber: string | null;
  fieldName: string | null;
  oilGasCode: "O" | "G" | null;
  /** Why this row was offered, shown next to it so the choice is informed. */
  matchedOn: "api" | "lease_name" | "operator";
}

function toCandidate(
  r: WellboreRow,
  matchedOn: RrcCandidate["matchedOn"]
): RrcCandidate {
  return {
    apiNumber: r.api_number,
    onSchedule: r.on_schedule === "Y",
    leaseName: r.lease_name,
    leaseNumber: r.lease_number,
    wellNo: r.well_no_display ?? r.well_no,
    district: r.district,
    countyName: r.county_name,
    operatorName: r.operator_name,
    operatorNumber: r.operator_number,
    fieldName: r.field_name,
    oilGasCode: r.oil_gas_code,
    matchedOn,
  };
}

const CANDIDATE_COLS = `
  api_number, district, county_name, oil_gas_code, lease_name, lease_number,
  field_name, well_no, well_no_display, operator_name, operator_number,
  on_schedule`;

/**
 * The searchable stem of a well or lease name.
 *
 * Operators write "Repass #2", "REPASS 2" and "Repass  A  #2" for the same
 * property, and the mirror stores its own spacing (lease names carry double
 * spaces). Strip the well number and punctuation from both sides so the
 * comparison is on the name itself.
 */
export function nameStem(name: string | null | undefined): string | null {
  if (!name) return null;
  const stem = name
    .toLowerCase()
    .replace(/#\s*\d+\s*$/, "")
    .replace(/\s+\d+\s*$/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stem === "" ? null : stem;
}

/**
 * Mirror wellbores that might be this property, best first.
 *
 * Ordered on-schedule first: 927,795 of the 1,368,247 rows are historic and
 * blank on status and compliance, so a current assignment is nearly always the
 * one the user means.
 */
export async function searchRrcCandidates(opts: {
  name: string;
  county?: string | null;
  operatorNo?: string | null;
  limit?: number;
}): Promise<RrcCandidate[]> {
  await assertSignedIn();
  if (!hasRrcDb()) return [];

  const stem = nameStem(opts.name);
  if (!stem) return [];
  const limit = Math.min(opts.limit ?? 25, 100);

  // Reduced on BOTH sides to what `nameStem` produces. The mirror stores
  // "ANDREWS  A" with a double space and "BALDWIN  C. R." with periods, and a
  // LIKE on a stem that has lost its punctuation matches neither unless the
  // column loses its punctuation too.
  const rows = await rrcQuery<WellboreRow>(
    `select ${CANDIDATE_COLS}
       from rrc.wellbore
      where regexp_replace(lower(lease_name), '[^a-z0-9]+', ' ', 'g') like $1
        and ($2::text is null or upper(county_name) = upper($2))
        and ($3::text is null or operator_number = $3)
      order by on_schedule desc nulls last, lease_name, well_no
      limit ${limit}`,
    [`%${stem}%`, opts.county ?? null, opts.operatorNo ?? null]
  );

  return rows.map((r) =>
    toCandidate(r, opts.operatorNo ? "operator" : "lease_name")
  );
}

/** An RRC lease the user might mean, for the lease-side confirm modal. */
export interface RrcLeaseCandidate {
  oilGasCode: "O" | "G";
  /** PDQ internal district code — the value that keys `rrc.lease`. */
  districtNo: string;
  leaseNo: string;
  leaseName: string | null;
  fieldNo: string | null;
  operatorNo: string | null;
}

/**
 * RRC leases whose name looks like this one's.
 *
 * Searched against `rrc.lease` directly rather than through wells, because the
 * whole point of this path is a lease that has none. The name is reduced on both
 * sides for the same reason as the wellbore search: the mirror stores
 * "ANDREWS  A" with a double space and "BALDWIN  C. R." with its periods.
 *
 * Commodity matters and is not guessable: Texas files oil at the lease level and
 * gas at the well level, so the same name legitimately exists as both an oil
 * lease and a gas lease with different numbers. Both are offered; the user picks.
 */
export async function searchRrcLeaseCandidates(opts: {
  name: string;
  operatorNo?: string | null;
  limit?: number;
}): Promise<RrcLeaseCandidate[]> {
  await assertSignedIn();
  if (!hasRrcDb()) return [];

  const stem = nameStem(opts.name);
  if (!stem) return [];
  const limit = Math.min(opts.limit ?? 25, 100);

  const rows = await rrcQuery<{
    oil_gas_code: "O" | "G";
    district_no: string;
    lease_no: string;
    lease_name: string | null;
    field_no: string | null;
    operator_no: string | null;
  }>(
    `select oil_gas_code, district_no, lease_no, lease_name, field_no, operator_no
       from rrc.lease
      where regexp_replace(lower(lease_name), '[^a-z0-9]+', ' ', 'g') like $1
        and ($2::text is null or operator_no = $2)
      order by lease_name, oil_gas_code, lease_no
      limit ${limit}`,
    [`%${stem}%`, opts.operatorNo ?? null]
  );

  return rows.map((r) => ({
    oilGasCode: r.oil_gas_code,
    districtNo: r.district_no,
    leaseNo: r.lease_no,
    leaseName: r.lease_name,
    fieldNo: r.field_no,
    operatorNo: r.operator_no,
  }));
}

/** The mirror row for one API number, for confirming a number typed by hand. */
export async function lookupRrcApi(api: string): Promise<RrcCandidate | null> {
  await assertSignedIn();
  if (!hasRrcDb()) return null;
  const digits = api.replace(/\D/g, "");
  if (digits.length < 8) return null;
  // The mirror stores api_number as char(8) on all 1,368,247 rows, so a 10- or
  // 14-digit number the user pastes is reduced, never padded.
  const rows = await rrcQuery<WellboreRow>(
    `select ${CANDIDATE_COLS}
       from rrc.wellbore
      where api_number = $1
      order by on_schedule desc nulls last
      limit 1`,
    [digits.slice(-8)]
  );
  return rows[0] ? toCandidate(rows[0], "api") : null;
}

/** The API number stored on one of our wells, if any. */
async function storedApi(wellId: string): Promise<string | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data } = await sb
    .from("wells")
    .select("api_well_no")
    .eq("id", wellId)
    .maybeSingle<{ api_well_no: string | null }>();
  const digits = (data?.api_well_no ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-8) : null;
}

/**
 * The state's record for one of our wells, or null when it carries no API
 * number yet.
 *
 * Null is the honest answer for an unlinked well: guessing a match and
 * presenting it as the state's record is the failure this whole flow exists to
 * avoid.
 */
export async function getRrcWell(wellId: string): Promise<WellDossier | null> {
  await assertSignedIn();
  if (!hasRrcDb()) return null;
  const api = await storedApi(wellId);
  return api ? getWellDossier(api) : null;
}

/**
 * The state's record for one of our leases, resolved THROUGH its wells.
 *
 * `leases` has no RRC slot and does not need one: each of its wells carries an
 * API number, and the mirror row for that hole carries the lease it is
 * completed on. Taking the lease from the wells means one identifier to
 * maintain instead of two that can disagree.
 *
 * The district must be translated before the lease lookup. `rrc.wellbore` holds
 * the real-world label ("7B", "09"); `rrc.lease` keys on PDQ's internal code,
 * where 13 means district 09. Joining on the label lands on a real lease
 * belonging to a different operator.
 */
export async function getRrcLease(leaseId: string): Promise<LeaseDossier | null> {
  const key = await resolveLeaseKey(leaseId);
  if (!key) return null;
  return getLeaseDossier(key.oilGasCode, key.districtNo, key.leaseNo);
}

/**
 * The RRC lease key for one of our leases, however it can be found.
 *
 * The resolution order is the one this module documents at the top, and it is
 * the ONLY place it is written down: a key confirmed on the lease wins, because
 * it is the only thing that can answer for a lease with no wells and because a
 * human's choice beats a derivation. Otherwise the lease's wells answer — each
 * mirror wellbore row states the lease it is completed on, so an API number on
 * any well is enough.
 *
 * Deriving from the wells is the DEFAULT case, not the exception: the stored
 * columns arrived late, so most leases will never carry them. Anything that
 * reads only the stored key silently finds nothing for the majority of leases.
 *
 * The district is translated on the way out. `rrc.wellbore` reports the
 * real-world label and `rrc.lease` keys on PDQ's internal code; returning the
 * label would point at a different operator's lease.
 */
export async function resolveLeaseKey(
  leaseId: string
): Promise<{ oilGasCode: "O" | "G"; districtNo: string; leaseNo: string } | null> {
  return (await resolveLeaseKeys(leaseId))[0] ?? null;
}

/**
 * EVERY RRC lease record this lease's wells sit on.
 *
 * A property is routinely filed twice — once as an oil lease and once as a gas
 * lease, with different lease numbers — because Texas files oil at the lease
 * level and gas at the well level. A lease that produces both therefore has two
 * records, and picking one silently loses the other stream. Wells on one of our
 * leases can also legitimately sit on different records after a split.
 *
 * Ordered with the stored key first when set, then by how many of the lease's
 * wells point at each record, so `resolveLeaseKey`'s single answer is the
 * dominant one.
 */
export async function resolveLeaseKeys(
  leaseId: string
): Promise<{ oilGasCode: "O" | "G"; districtNo: string; leaseNo: string }[]> {
  await assertSignedIn();
  if (!hasRrcDb() || !hasSupabase()) return [];

  const keys: { oilGasCode: "O" | "G"; districtNo: string; leaseNo: string }[] = [];
  const seen = new Set<string>();
  const add = (k: { oilGasCode: "O" | "G"; districtNo: string; leaseNo: string }) => {
    const id = `${k.oilGasCode}/${k.districtNo}/${k.leaseNo}`;
    if (seen.has(id)) return;
    seen.add(id);
    keys.push(k);
  };

  const stored = await getStoredLeaseKey(leaseId);
  if (stored) add(stored);

  const sb = await getSupabaseServer();
  const { data: wells } = await sb
    .from("wells")
    .select("api_well_no")
    .eq("lease_id", leaseId)
    .not("api_well_no", "is", null);

  const apis = (wells ?? [])
    .map((w) => (w.api_well_no as string | null)?.replace(/\D/g, "") ?? "")
    .filter((d) => d.length >= 8)
    .map((d) => d.slice(-8));
  if (apis.length === 0) return keys;

  // Grouped, not `limit 1`: one row per record the wells sit on, commonest first.
  const rows = await rrcQuery<{
    oil_gas_code: "O" | "G" | null;
    district: string | null;
    lease_number: string | null;
  }>(
    `select oil_gas_code, district, lease_number, count(*) as wells
       from rrc.wellbore
      where api_number = any($1)
        and on_schedule = 'Y'
        and lease_number is not null
      group by 1, 2, 3
      order by wells desc`,
    [apis]
  );
  for (const hit of rows) {
    if (!hit.oil_gas_code || !hit.district || !hit.lease_number) continue;
    const districtNo = toPdqDistrict(hit.district);
    if (!districtNo) continue;
    add({
      oilGasCode: hit.oil_gas_code,
      districtNo,
      leaseNo: hit.lease_number,
    });
  }
  return keys;
}

/**
 * Write a confirmed API number onto one of our wells.
 *
 * The only write in this module, and it goes into slots that already exist. The
 * lease number and operator number come along because the mirror row states
 * them and `wells` already has somewhere to put them — they are a convenience
 * for display, not a second join key.
 */
export async function confirmRrcWell(
  wellId: string,
  candidate: Pick<RrcCandidate, "apiNumber" | "leaseNumber" | "operatorNumber">
): Promise<void> {
  if (!hasSupabase()) throw new Error("confirmRrcWell: no database");
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("wells")
    .update({
      api_well_no: candidate.apiNumber,
      rrc_lease_id: candidate.leaseNumber,
      rrc_operator_no: candidate.operatorNumber,
    })
    .eq("id", wellId);
  if (error) throw new Error(`confirmRrcWell: ${error.message}`);
}

/** Clear the connection, for a match confirmed in error. */
export async function clearRrcWell(wellId: string): Promise<void> {
  if (!hasSupabase()) throw new Error("clearRrcWell: no database");
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("wells")
    .update({ api_well_no: null, rrc_lease_id: null, rrc_operator_no: null })
    .eq("id", wellId);
  if (error) throw new Error(`clearRrcWell: ${error.message}`);
}

/**
 * The UIC permit and injection history for one of our wells.
 *
 * Deliberately NOT `getRrcWell(...).injection`. That fetches the whole dossier —
 * completions, compliance flags, a 33-year lease production series — to reach
 * one small object, and the SWD pages that want the permitted rate render on
 * every page load. This is the two indexed lookups and nothing else.
 *
 * Null covers three different situations that all mean "do not show a limit":
 * no API number on the well yet, no mirror configured, and a hole the state has
 * no UIC record for. Showing a ceiling we are not sure of would be worse than
 * showing none, because a pumper would run to it.
 */
export async function getRrcWellInjection(
  wellId: string
): Promise<WellInjection | null> {
  await assertSignedIn();
  if (!hasRrcDb()) return null;
  const api = await storedApi(wellId);
  return api ? getWellInjection(api) : null;
}

/**
 * The same, for a whole fleet, in one round trip per table.
 *
 * The disposal wells list renders a row per SWD, and a per-row lookup would be
 * N sequential queries against a database on the other side of the internet.
 * Keyed by OUR well id, so a caller never has to hold the API mapping itself.
 *
 * Only the permit is fetched, never the 21M-row H-10 history: a list needs the
 * ceiling, not the series.
 */
export async function getFleetPermittedRates(): Promise<
  Map<string, { permittedBblPerDay: number | null; maxPressurePsig: number | null }>
> {
  const out = new Map<
    string,
    { permittedBblPerDay: number | null; maxPressurePsig: number | null }
  >();
  await assertSignedIn();
  if (!hasRrcDb() || !hasSupabase()) return out;

  const sb = await getSupabaseServer();
  const { data } = await sb
    .from("wells")
    .select("id, api_well_no")
    .eq("type", "injection")
    .not("api_well_no", "is", null);

  // Our id -> the 8-digit API the mirror keys on. Two of our wells CAN carry the
  // same API (a recompletion entered twice), so this is one-to-many by API.
  const byApi = new Map<string, string[]>();
  for (const w of data ?? []) {
    const digits = String(w.api_well_no ?? "").replace(/\D/g, "");
    if (digits.length < 8) continue;
    const api = digits.slice(-8);
    byApi.set(api, [...(byApi.get(api) ?? []), w.id as string]);
  }
  if (byApi.size === 0) return out;

  // Summed over LIVE permits only, matching `rrc.uic_live_permit`: a cancelled
  // 1988 permit must not inflate the ceiling a pumper is shown today.
  const rows = await rrcQuery<{
    api_number: string;
    permitted: number | null;
    max_pressure: number | null;
  }>(
    `select api_number,
            sum(max_bbl_per_day)::bigint as permitted,
            max(max_inj_pressure)::int   as max_pressure
       from rrc.uic_live_permit
      where api_number = any($1)
      group by api_number`,
    [[...byApi.keys()]]
  );

  for (const r of rows) {
    for (const id of byApi.get(r.api_number.trim()) ?? []) {
      out.set(id, {
        permittedBblPerDay: r.permitted,
        maxPressurePsig: r.max_pressure,
      });
    }
  }
  return out;
}

/**
 * Which of our wells carry an API number, for Orion's manifest.
 *
 * One query rather than one per well: the manifest covers every well in the org
 * and is built on every chat turn. No early-access gate — this reads our own
 * rows, not the mirror.
 */
export async function getRrcLinkedWellIds(): Promise<Set<string>> {
  if (!hasSupabase()) return new Set();
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("wells")
    .select("id")
    .not("api_well_no", "is", null);
  if (error) {
    console.error("getRrcLinkedWellIds failed", error);
    return new Set();
  }
  return new Set((data ?? []).map((w) => w.id as string));
}

/**
 * Store a confirmed RRC lease key on one of our leases.
 *
 * The district is written as PDQ's internal code, exactly as `rrc.lease`
 * reported it, so no translation happens on read. Writing the real-world label
 * here would key a different operator's lease.
 */
export async function confirmRrcLease(
  leaseId: string,
  candidate: Pick<RrcLeaseCandidate, "oilGasCode" | "districtNo" | "leaseNo">
): Promise<void> {
  if (!hasSupabase()) throw new Error("confirmRrcLease: no database");
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("leases")
    .update({
      rrc_oil_gas_code: candidate.oilGasCode,
      rrc_district: candidate.districtNo,
      rrc_lease_no: candidate.leaseNo,
    })
    .eq("id", leaseId);
  if (error) throw new Error(`confirmRrcLease: ${error.message}`);
}

/**
 * Clear a lease's stored RRC key.
 *
 * All three go together: a check constraint requires the key be whole or empty,
 * because a half-set identity resolves to the WRONG lease rather than to none.
 */
export async function clearRrcLease(leaseId: string): Promise<void> {
  if (!hasSupabase()) throw new Error("clearRrcLease: no database");
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("leases")
    .update({
      rrc_oil_gas_code: null,
      rrc_district: null,
      rrc_lease_no: null,
    })
    .eq("id", leaseId);
  if (error) throw new Error(`clearRrcLease: ${error.message}`);
}

/** The RRC key stored on a lease, if a human confirmed one. */
export async function getStoredLeaseKey(
  leaseId: string
): Promise<{ oilGasCode: "O" | "G"; districtNo: string; leaseNo: string } | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("leases")
    .select("rrc_lease_no, rrc_district, rrc_oil_gas_code")
    .eq("id", leaseId)
    .maybeSingle<{
      rrc_lease_no: string | null;
      rrc_district: string | null;
      rrc_oil_gas_code: string | null;
    }>();
  if (error) {
    // Distinguish "this lease has no key" from "these columns do not exist".
    // Callers treat both as null, so without this the second is invisible.
    console.warn(
      `getStoredLeaseKey(${leaseId}) failed (${error.code}: ${error.message})` +
        (error.code === "42703"
          ? " — 2026080800900_lease_rrc_identity.sql has not been applied; run: supabase db push"
          : "")
    );
    return null;
  }
  if (!data?.rrc_lease_no || !data.rrc_district || !data.rrc_oil_gas_code) {
    return null;
  }
  return {
    oilGasCode: data.rrc_oil_gas_code as "O" | "G",
    districtNo: data.rrc_district,
    leaseNo: data.rrc_lease_no,
  };
}

/** An RRC lease key implied by a well's mirror row, ready to apply to a lease. */
export interface LeaseKeySuggestion {
  leaseId: string;
  leaseName: string;
  /** The key the well's RRC record implies. */
  suggested: { oilGasCode: "O" | "G"; districtNo: string; leaseNo: string };
  suggestedLeaseName: string | null;
  /** What the lease already holds, when it holds something different. */
  current: { oilGasCode: "O" | "G"; districtNo: string; leaseNo: string } | null;
}

/**
 * The RRC lease a confirmed well match implies for OUR lease, if it tells us
 * something the lease does not already know.
 *
 * This is the whole reason the well path is worth having on the lease side: the
 * mirror already connects a wellbore to its lease, so adding an API number to a
 * well tells us which RRC lease that well's Wildcat lease is — no second search
 * needed. Returned as a SUGGESTION rather than applied, because the well and the
 * lease are two assertions and only a person should merge them.
 *
 * Null when there is nothing to offer: the well is on no lease, the mirror row
 * names no lease, or the lease already holds exactly this key.
 *
 * The district is translated here. `rrc.wellbore` reports the real-world label
 * and `rrc.lease` keys on PDQ's internal code, so storing the label would point
 * the lease at a different operator's record.
 */
export async function suggestLeaseKeyFromWell(
  wellId: string,
  candidate: Pick<RrcCandidate, "leaseNumber" | "district" | "oilGasCode" | "leaseName">
): Promise<LeaseKeySuggestion | null> {
  if (!hasSupabase()) return null;
  if (!candidate.leaseNumber || !candidate.district || !candidate.oilGasCode) {
    return null;
  }
  const districtNo = toPdqDistrict(candidate.district);
  if (!districtNo) return null;

  const sb = await getSupabaseServer();
  const { data: well } = await sb
    .from("wells")
    .select("lease_id")
    .eq("id", wellId)
    .maybeSingle<{ lease_id: string | null }>();
  if (!well?.lease_id) return null;

  const { data: lease } = await sb
    .from("leases")
    .select("id, name, rrc_lease_no, rrc_district, rrc_oil_gas_code")
    .eq("id", well.lease_id)
    .maybeSingle<{
      id: string;
      name: string;
      rrc_lease_no: string | null;
      rrc_district: string | null;
      rrc_oil_gas_code: string | null;
    }>();
  if (!lease) return null;

  const suggested = {
    oilGasCode: candidate.oilGasCode,
    districtNo,
    leaseNo: candidate.leaseNumber,
  };
  const current =
    lease.rrc_lease_no && lease.rrc_district && lease.rrc_oil_gas_code
      ? {
          oilGasCode: lease.rrc_oil_gas_code as "O" | "G",
          districtNo: lease.rrc_district,
          leaseNo: lease.rrc_lease_no,
        }
      : null;

  // Nothing to say when the lease already agrees.
  if (
    current &&
    current.oilGasCode === suggested.oilGasCode &&
    current.districtNo === suggested.districtNo &&
    current.leaseNo === suggested.leaseNo
  ) {
    return null;
  }

  return {
    leaseId: lease.id,
    leaseName: lease.name,
    suggested,
    suggestedLeaseName: candidate.leaseName,
    current,
  };
}
