/**
 * What the state record would put in a facility's SETTINGS FORM.
 *
 * The onboarding import already decides what the RRC knows about a hole and
 * which of it belongs on a well row (`fleet-import.ts`, the `WellInput` it
 * builds). The Sync with RRC button on a settings modal asks the same question
 * for one facility that already exists, so the mapping lives here — pure, so
 * the answer can be asserted against the mirror's columns without a database —
 * and `facility-sync.ts` is only the part that finds the row.
 *
 * ## Blank stays blank
 *
 * A field the state has nothing for produces NO KEY, not an empty string. The
 * caller highlights exactly the keys that came back, and a key that arrived
 * empty would highlight a box it did not fill and, on save, would erase what
 * the operator had typed there. Same rule as `well-record.ts`.
 *
 * ## What is deliberately NOT filled
 *
 *  - `name`: the state's lease name is not what the crew calls the well, and
 *    renaming a facility out from under everyone is not a form prefill.
 *  - `type` and `active`: the RRC's status lags by months and `wells.active`
 *    also means shut-in here, so a stale record would retire a producing well.
 *    Onboarding sets them because there is nothing to overwrite yet.
 */
import { titleCase } from "@/lib/scout/format";
import {
  wellRecordFields,
  type WellRecord,
  type WellboreProfile,
} from "./well-record";

/** The `rrc.wellbore` columns a fill reads. */
export interface WellboreFacts {
  api_number: string;
  county_name: string | null;
  field_name: string | null;
  /** TEXT in the mirror, and '' on wells nobody filed a depth for. */
  api_depth: string | null;
  lease_name: string | null;
  lease_number: string | null;
  /** 'O' or 'G'. Texas keys oil per LEASE and gas per WELL, so both appear. */
  oil_gas_code: string | null;
  well_no: string | null;
  operator_name: string | null;
  operator_number: string | null;
  /** 'Y' only for the operator's CURRENT assignment; historic rows are blank. */
  on_schedule: string | null;
}

/**
 * The settings-form keys the RRC can speak to, each present only when the state
 * actually has it. Mirrors the `WellInput` `fleet-import.ts` builds.
 */
export interface RrcWellFill {
  formation?: string;
  county?: string;
  depth?: number;
  perforations?: string;
  dateDrilled?: string;
  coordinates?: string;
  apiWellNo?: string;
  rrcLeaseId?: string;
  rrcOperatorNo?: string;
  wellboreProfile?: WellboreProfile;
  /**
   * The org's own lease this well belongs to (`leases.id`).
   *
   * NOT set by `wellFill`, which is pure and cannot know what leases the
   * workspace has. `facility-sync.ts` resolves it against them and merges it in
   * — the state says which LEASE a wellbore is completed on, and that is the
   * fact `wells.lease_id` records.
   */
  leaseId?: string;
}

/** Lease settings, same contract. */
export interface RrcLeaseFill {
  leaseNo?: string;
  county?: string;
}

/** A depth as the mirror files it. 0 and '' mean "not filed", not "at grade". */
function feet(value: string | null): number | undefined {
  const n = Number((value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function text(value: string | null): string | undefined {
  const cased = titleCase(value).trim();
  return cased || undefined;
}

/**
 * One wellbore row plus its completion packet, as the well settings form.
 *
 * `record` is null when the mirror has the wellbore but no packet behind it —
 * ordinary, and the reason perforations / spud date / coordinates are the four
 * keys most often absent from the result.
 */
export function wellFill(
  row: WellboreFacts,
  record: WellRecord | null
): RrcWellFill {
  const fill: RrcWellFill = {};
  const depth = feet(row.api_depth);

  // The RRC field name, which is not strictly a producing formation but is what
  // an operator says out loud — the same value onboarding seeds into `zone`.
  const field = text(row.field_name);
  if (field) fill.formation = field;
  const county = text(row.county_name);
  if (county) fill.county = county;
  if (depth !== undefined) fill.depth = depth;
  if (row.api_number) fill.apiWellNo = row.api_number;
  const leaseNo = (row.lease_number ?? "").trim();
  // THIS well's record number — a gas well's gas ID, not its property's oil
  // lease. See `ImportableWell.rrcLeaseNo`.
  if (leaseNo) fill.rrcLeaseId = leaseNo;
  const operatorNo = (row.operator_number ?? "").trim();
  if (operatorNo) fill.rrcOperatorNo = operatorNo;

  if (record) {
    const decoded = wellRecordFields(record, { totalDepthFt: depth ?? null });
    if (decoded.perforations) fill.perforations = decoded.perforations;
    if (decoded.dateDrilled) fill.dateDrilled = decoded.dateDrilled;
    if (decoded.coordinates) fill.coordinates = decoded.coordinates;
    // Null means the state filed no profile code; an "Unknown" selection is a
    // value, and writing one would claim we asked and were told.
    if (decoded.profile) fill.wellboreProfile = decoded.profile;
  }

  return fill;
}

/** The wellbore rows a lease's wells sit on, as the lease settings form. */
export function leaseFill(rows: WellboreFacts[]): RrcLeaseFill {
  const fill: RrcLeaseFill = {};
  if (rows.length === 0) return fill;

  const leaseNo = oilLeaseNumbers(rows);
  if (leaseNo) fill.leaseNo = leaseNo;
  // A lease spanning two counties files under both; the one with the most wells
  // is the one an operator would write on the form.
  const county = text(dominantValue(rows.map((r) => r.county_name)));
  if (county) fill.county = county;
  return fill;
}

/**
 * The property's OIL lease number, which is the only lease-level identifier
 * Texas issues.
 *
 * Gas is deliberately excluded. A gas ID is filed per WELL, so it names one
 * hole rather than the lease, and a property with four gas wells has four of
 * them — putting those in a lease's number field describes the wrong kind of
 * thing. The well's own record number is where a gas ID belongs, and
 * `wellFill` already puts it there (`rrcLeaseId`).
 *
 * Comma separated and ascending on the rare property that files under two oil
 * records, so two runs over the same lease produce the same string. Undefined
 * when the wells are all gas: blank is the honest answer, not a well's id.
 */
function oilLeaseNumbers(rows: WellboreFacts[]): string | undefined {
  const oil = new Set<string>();
  for (const row of rows) {
    if (row.oil_gas_code === "G") continue;
    const no = (row.lease_number ?? "").trim();
    if (no) oil.add(no);
  }
  return oil.size > 0 ? [...oil].sort().join(", ") : undefined;
}

function dominantValue(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of [...counts].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}
