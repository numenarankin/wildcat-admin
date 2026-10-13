/**
 * Everything one or more RRC operator numbers would bring into a new workspace.
 *
 * Reads `rrc.wellbore` directly rather than going through `getOperatorDossier`,
 * which also pulls 34 years of monthly production, a 25-code disposition matrix
 * and the field list — none of which a review table shows, all of which the user
 * would wait for.
 *
 * ## This does NOT build a lease key
 *
 * `wellbore.district` is the EWA label ('01'-'06', '6E', '7B', '7C', '08', '8A',
 * '09', '10'), NOT the PDQ code that `rrc.lease` is keyed on, where 09 means 7C
 * and 13 means 09. Translating it is `lease-key.ts`'s job and resolving the link
 * is `link.ts`'s, at import time. What comes out of here is a DRAFT: raw fields
 * for display, grouped by a key that is local to this screen. Anything that
 * treats `leaseKey` as an RRC identifier is a bug. See
 * docs/plans/rrc-well-linking.md.
 *
 * No authorization here; the caller guards. Same contract as `rrc-*` throughout.
 */
import { rrcQuery } from "@/lib/scout/rrc-db";
import { toPdqDistrict } from "@/lib/scout/rrc-districts";
import { isInjectionWell, wellActivity } from "@/lib/scout/well-activity";
import { fmtDate8 } from "@/lib/scout/format";
import type {
  FleetDraft,
  ImportableLease,
  ImportableWell,
  OperatorSummary,
  WellStatus,
} from "./onboarding-types";

/**
 * A fleet larger than this is not a review table, it is a spreadsheet. The
 * biggest operators in Texas run into the thousands, and an onboarding step is
 * the wrong place to render them; the cap is reported so the UI can say so.
 */
const MAX_WELLS = 1000;

interface WellboreRow {
  api_number: string;
  well_no: string | null;
  lease_name: string | null;
  lease_number: string | null;
  oil_gas_code: string | null;
  district: string | null;
  county_name: string | null;
  well_type_name: string | null;
  field_name: string | null;
  api_depth: string | null;
  curr_inact_yrs: string | null;
  plug_date: string | null;
  /** 'Y' when the RRC flags the wellbore as multiply completed. */
  multi_comp_flag: string | null;
  /** How many rows this API has on the P-5. >1 means several completions. */
  completion_rows: number | null;
  /** The other lease names on this API's remaining rows. */
  other_lease_names: string[] | null;
}

/** Title Case, because the mirror shouts and an operator's own UI should not. */
function titleCase(value: string | null): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Injection and disposal wells are the ones Wildcat models separately; every
 * other type is a producer as far as `WellInput.type` is concerned. The test
 * itself is shared with Scout's operator dossier (`isInjectionWell`) so the
 * fleet an operator sees before importing matches the one they see after.
 */
function wellType(typeName: string | null): ImportableWell["type"] {
  return isInjectionWell(typeName) ? "injection" : "producer";
}

/**
 * Status drives what is checked by default, so it uses Scout's one definition
 * (`@/lib/scout/well-activity`) rather than a rule of its own. Every row here is
 * `on_schedule = 'Y'` — the hole's CURRENT record — so its own plug date is the
 * one that counts. A plug date on some historic row is a wellbore this well was
 * re-entered from, and treating that as the hole's state called four of Sky
 * Resources' producing wells plugged.
 */
function wellStatus(row: WellboreRow): WellStatus {
  const years = Number(row.curr_inact_yrs ?? "0");
  return wellActivity({
    plugged: Boolean((row.plug_date ?? "").trim()),
    onSchedule: true,
    wellTypeName: row.well_type_name,
    inactiveYears: Number.isFinite(years) ? years : 0,
  });
}

/**
 * The plug date the import carries onto `wells.plugged_at`, or null.
 *
 * Only for a well the rule above CALLS plugged. A plug date on a hole that is
 * producing again is the historic row it was re-entered from (see `wellStatus`),
 * and stamping that onto the well would file a live well under Plugged Wells.
 * Eight digits as the state stores them, `19980412`, hence `fmtDate8`.
 */
function pluggedOn(row: WellboreRow, status: WellStatus): string | null {
  if (status !== "plugged") return null;
  return fmtDate8(Number((row.plug_date ?? "").trim()));
}

function num(value: string | null): number | null {
  const n = Number((value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The name an operator would recognise.
 *
 * The mirror splits it: `lease_name` is the lease, `well_no` is the well within
 * it, and nobody says "TURTLE HOLE" when they mean well 1 on it. Joined here the
 * way every operator writes it on a ticket, and editable in the review table
 * because the state's version is frequently not what the crew calls it.
 */
export interface WellNameParts {
  api_number: string;
  lease_name: string | null;
  well_no: string | null;
}

export function wellName(row: WellNameParts): string {
  const lease = titleCase(row.lease_name) || `API ${row.api_number}`;
  const no = (row.well_no ?? "").trim();
  return no ? `${lease} ${no}` : lease;
}

/** The columns the completion tiebreak reads. A subset of `WellboreRow`. */
export interface WellboreOrderKey {
  completion_date: string | null;
  oil_gas_code: string | null;
  lease_number: string | null;
}

/**
 * The tiebreak between several completions on one API, as a comparator.
 *
 * This is the SQL `order by` above expressed in TypeScript, and it exists so the
 * rule can be TESTED. An ordering bug does not reproduce on a single run: the
 * plan is free to emit a group's rows in any order it likes, and the wrong row
 * wins only sometimes. A comparator can be run over a shuffled fixture fifty
 * times, and it can be reconciled against what the database actually returned
 * for a real multiply-completed well.
 *
 * Sorts BEST FIRST, so `rows.sort(compareWellbores)[0]` is the row `distinct on`
 * keeps. Newest completion wins; `completion_date` is CCYYMMDD text so a string
 * compare is chronological, and '' means "never completed" and sorts last.
 */
export function compareWellbores(
  a: WellboreOrderKey,
  b: WellboreOrderKey
): number {
  const dateA = (a.completion_date ?? "").trim();
  const dateB = (b.completion_date ?? "").trim();
  if (dateA !== dateB) {
    if (!dateA) return 1;
    if (!dateB) return -1;
    return dateB.localeCompare(dateA);
  }
  const codeA = (a.oil_gas_code ?? "").trim();
  const codeB = (b.oil_gas_code ?? "").trim();
  if (codeA !== codeB) return codeA.localeCompare(codeB);
  return (a.lease_number ?? "").localeCompare(b.lease_number ?? "");
}

/**
 * The physical lease a wellbore belongs to.
 *
 * NAME + COUNTY, and deliberately NOT the RRC's lease number.
 *
 * ## Why the state's own grouping is the wrong one
 *
 * Texas files OIL at the lease level and GAS at the WELL level: an oil lease
 * number covers a whole property, while every gas well is issued its own gas ID.
 * Measured on Sky Resources' 51 wells, all 24 of their gas "leases" carry
 * exactly one well each, against 1, 2 and 18 on their three oil leases. Keying
 * leases on the RRC number therefore does not split a property into oil and gas
 * halves — it shatters the gas half into one fragment per well, and the account
 * opens with 24 single-well leases that the operator has never heard of.
 *
 * The Roach lease is one property: oil lease 33913 with 18 wells and gas ID
 * 294664 with one. Repass is one property held as two gas IDs and no oil lease
 * at all.
 *
 * ## Nothing is lost by merging
 *
 * `resolveLeaseKeys` in `link.ts` already finds EVERY RRC record a lease's wells
 * sit on, from the wells themselves, and its own header says why: "A lease that
 * produces both therefore has two records, and picking one silently loses the
 * other stream." The stored `rrc_*` identity is the dominant record, not the
 * only one, and each well keeps its own record number in `wells.rrc_lease_id`.
 *
 * County is in the key because a lease name is only unique within one; two
 * counties with a "Brown" lease are two properties.
 */
function physicalLeaseKey(row: WellboreRow): string {
  const name = titleCase(row.lease_name) || `Unnamed ${row.lease_number ?? ""}`;
  return `${name.toUpperCase()}|${titleCase(row.county_name).toUpperCase()}`;
}

/** One RRC record backing a physical lease, and how many wells sit on it. */
interface RecordTally {
  oilGasCode: "O" | "G";
  district: string | null;
  leaseNo: string;
  wells: number;
}

/**
 * Which RRC record a merged lease stores as its identity.
 *
 * The one carrying the most wells, and OIL breaks a tie: oil is filed at the
 * lease level, so an oil number identifies the property, while a gas ID
 * identifies a single well on it. For Roach that picks oil 33913 (18 wells) over
 * gas 294664 (1), which is the record whose production history is the lease's.
 *
 * A lease with only gas IDs stores its largest, and the rest are still reachable
 * through the wells.
 */
function dominantRecord(records: RecordTally[]): RecordTally | null {
  return (
    [...records].sort(
      (a, b) =>
        b.wells - a.wells ||
        (a.oilGasCode === b.oilGasCode ? 0 : a.oilGasCode === "O" ? -1 : 1) ||
        a.leaseNo.localeCompare(b.leaseNo)
    )[0] ?? null
  );
}

export interface FleetLoad extends FleetDraft {
  /** True when the operator has more wells than the review table will show. */
  truncated: boolean;
  /** Wells on the P-5, before the cap. What the operator card advertised. */
  totalWells: number;
}

/**
 * Load the draft for one or more operator numbers.
 *
 * `on_schedule = 'Y'` is the current assignment: only 440,452 of the mirror's
 * 1,368,247 wellbore rows carry it, and the rest are historic rows whose status,
 * compliance and 14(b)(2) flags are all blank. Importing those would hand a new
 * customer wells they sold years ago.
 */
export async function loadFleetDraft(
  operators: OperatorSummary[]
): Promise<FleetLoad> {
  const numbers = operators.map((o) => o.operatorNumber);
  if (numbers.length === 0) {
    return { operators, leases: [], wells: [], truncated: false, totalWells: 0 };
  }

  const [rows, counted] = await Promise.all([
    /*
     * ONE ROW PER API, CHOSEN DETERMINISTICALLY.
     *
     * `rrc.wellbore` is one row per well x lease x field: 17,852 of the 419,618
     * on-schedule API numbers carry more than one. `distinct on` keeps the first
     * row of each group AS ORDERED, and this used to order by `api_number`
     * alone — which dedupes the well correctly and leaves its lease, field and
     * commodity to whatever the query plan happened to emit. The same import run
     * twice could file a well under a different lease, and neither run was
     * detectably wrong.
     *
     * So the ordering is now total. Newest completion first, because that is the
     * completion the well is actually producing from; then the oil/gas code and
     * the lease number purely to break a tie the same way every time.
     * `completion_date` is CCYYMMDD text, so a lexical sort is chronological,
     * and `nullif` is required because the column holds '' rather than null.
     */
    rrcQuery<WellboreRow>(
      `select distinct on (api_number)
              api_number, well_no, lease_name, lease_number, oil_gas_code,
              district, county_name, well_type_name,
              nullif(field_name, '')      as field_name,
              nullif(api_depth, '')       as api_depth,
              nullif(curr_inact_yrs, '')  as curr_inact_yrs,
              nullif(plug_date, '')       as plug_date,
              nullif(multi_comp_flag, '') as multi_comp_flag,
              count(*)      over (partition by api_number) as completion_rows,
              array_remove(
                array_agg(nullif(lease_name, '')) over (partition by api_number),
                null)                                      as other_lease_names
         from rrc.wellbore
        where operator_number = any($1::text[]) and on_schedule = 'Y'
        order by api_number,
                 nullif(completion_date, '') desc nulls last,
                 oil_gas_code, lease_number
        limit ${MAX_WELLS}`,
      [numbers]
    ),
    rrcQuery<{ n: number }>(
      `select count(distinct api_number)::int as n
         from rrc.wellbore
        where operator_number = any($1::text[]) and on_schedule = 'Y'`,
      [numbers]
    ),
  ]);

  /*
   * Wells are grouped by PROPERTY, not by RRC record. See `physicalLeaseKey`:
   * a gas ID is one well, so grouping on the state's numbering would open the
   * account with a lease per gas well.
   */
  const recordsByLease = new Map<string, Map<string, RecordTally>>();
  const seedByLease = new Map<string, WellboreRow>();
  const wells: ImportableWell[] = [];

  for (const row of rows) {
    const leaseKey = physicalLeaseKey(row);
    if (!seedByLease.has(leaseKey)) seedByLease.set(leaseKey, row);

    // Every RRC record this property's wells sit on, with its well count, so the
    // dominant one can be picked once the whole fleet has been read.
    const leaseNo = (row.lease_number ?? "").trim();
    const recordKey = `${row.oil_gas_code ?? "O"}/${row.district ?? ""}/${leaseNo}`;
    const records = recordsByLease.get(leaseKey) ?? new Map<string, RecordTally>();
    const tally = records.get(recordKey);
    if (tally) tally.wells++;
    else
      records.set(recordKey, {
        oilGasCode: row.oil_gas_code === "G" ? "G" : "O",
        district: row.district,
        leaseNo,
        wells: 1,
      });
    recordsByLease.set(leaseKey, records);

    // Multiply completed by either measure: the RRC's own flag, or simply
    // having more than one row on this P-5. The flag alone misses a well whose
    // two completions were filed without it; the row count alone misses one
    // whose second completion sits under an operator number we did not ask for.
    const multiCompletion =
      (row.multi_comp_flag ?? "").trim().toUpperCase() === "Y" ||
      (row.completion_rows ?? 1) > 1;

    const status = wellStatus(row);

    wells.push({
      key: row.api_number,
      apiNumber: row.api_number,
      name: wellName(row),
      county: titleCase(row.county_name),
      depthFt: num(row.api_depth),
      type: wellType(row.well_type_name),
      leaseKey,
      // The well's OWN record number as the state prints it — its gas ID when
      // it is a gas well. Not the merged lease's identity: a gas well on the
      // Roach property files under 294664, not under oil lease 33913, and
      // `wells.rrc_lease_id` is what links it back to its own record.
      rrcLeaseNo: (row.lease_number ?? "").trim(),
      status,
      pluggedOn: pluggedOn(row, status),
      inactiveYears: num(row.curr_inact_yrs),
      fieldName: titleCase(row.field_name),
      multiCompletion,
      otherLeaseNames: multiCompletion
        ? [
            ...new Set(
              (row.other_lease_names ?? [])
                .map((n) => titleCase(n))
                .filter((n) => n && n !== titleCase(row.lease_name))
            ),
          ]
        : [],
    });
  }

  // One lease row per property, carrying its dominant RRC record.
  const leases: ImportableLease[] = [];
  for (const [key, seed] of seedByLease) {
    const records = [...(recordsByLease.get(key)?.values() ?? [])];
    const best = dominantRecord(records);
    leases.push({
      key,
      leaseNo: best?.leaseNo ?? "",
      name: titleCase(seed.lease_name) || "Unnamed lease",
      county: titleCase(seed.county_name),
      // What the property chiefly produces, by the record that holds the most
      // wells — not by whichever wellbore happened to be read first.
      commodity: best?.oilGasCode === "G" ? "gas" : "oil",
      // Translated here, once: `rrc.lease_production` keys on PDQ's internal
      // code, so storing the label would resolve to another operator's lease.
      rrcDistrict: toPdqDistrict(best?.district ?? null),
      rrcOilGasCode: best?.oilGasCode === "G" ? "G" : "O",
    });
  }

  const totalWells = counted[0]?.n ?? wells.length;
  return {
    operators,
    leases: leases.sort((a, b) => a.name.localeCompare(b.name)),
    wells,
    truncated: totalWells > wells.length,
    totalWells,
  };
}
