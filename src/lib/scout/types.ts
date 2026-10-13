/**
 * Row shapes for Scout's RRC data, as read from the Tiger mirror.
 *
 * Kept in a plain module — not in `queries.ts` — because that file is a
 * `"use server"` boundary, which may only export async functions. Client
 * components import their types from here and their data from there.
 *
 * The field names still follow archon's `20260621001000_wells_operators.sql`,
 * which is where these shapes came from — `queries.ts` maps the mirror's own
 * column names onto them so the components did not have to change when the
 * data moved.
 */

import type { Shape } from "./geo-shapes";
import type { WellActivity } from "./well-activity";

export interface WellRow {
  api_number: number;
  county_code: number | null;
  admin_district: number | null;
  oil_gas: string | null;
  oil_gas_label: string | null;
  water_land: string | null;
  is_plugged: boolean | null;
  has_fresh_water: boolean | null;
  total_depth: number | null;
  n_formations: number | null;
  deepest_formation_depth: number | null;
  n_completions: number | null;
  latitude: number | null;
  longitude: number | null;
  plugged_d: string | null;
  w3_filed_d: string | null;
}

export interface OperatorDetailRow {
  api_number: number;
  operator_number: number | null;
  operator_source: string | null;
  /**
   * `rrc.wellbore.plug_operator_name`, which does NOT mean the well is plugged:
   * 439,654 of the 440,050 rows carrying it have no `plug_date`, and the value
   * repeats the row's current operator. Only pair it with a `plug_date`.
   */
  plugging_operator_name: string | null;
  operator_name: string | null;
  p5_status: string | null;
  addr_line1: string | null;
  addr_line2: string | null;
  city: string | null;
  state: string | null;
  zip: number | null;
  last_p5_date: number | null;
  operator_display_name: string | null;
  officer_count: number | null;
}

export interface OfficerRow {
  officer_name: string | null;
  officer_title: string | null;
  officer_city: string | null;
  officer_state: string | null;
}

export interface WellDetail {
  well: WellRow | null;
  operator: OperatorDetailRow | null;
  officers: OfficerRow[];
}

/** One operator placed at its mailing-ZIP centroid (from the operator points). */
export interface OperatorPoint {
  n: number; // operator_number
  nm: string; // name
  a: string; // address line 1
  c: string; // city
  s: string; // state
  z: number; // zip
  lng: number;
  lat: number;
  w: number; // well count (all wells)
  wa?: number; // active (non-plugged) well count; absent in older data files
  /**
   * Last-12-month production the operator ITSELF reported — oil in bbl (`o12`)
   * and gas in MCF (`g12`), summed from the RRC mirror's
   * `operator_production_monthly` (oil excludes condensate, gas excludes
   * casinghead). This used to be the whole-lease footprint of every lease the
   * operator's wells touched, which overstated a partner on a shared lease.
   * `getOperatorProfile.last12` reads the same figures, so the dot and the
   * dossier it opens cannot disagree.
   *
   * ABSENT MEANS ZERO: operators that reported nothing are left off here to
   * keep the payload small, and older data files predate the field entirely.
   */
  o12?: number;
  g12?: number;
  /**
   * How many of the window's cycles this operator actually filed — the divisor
   * for the per-month rate the map shows. Absent in files synced before the
   * field existed, and `perMonth` then falls back to the full twelve.
   */
  m12?: number;
}

export interface FocusWell {
  api: number;
  lng: number;
  lat: number;
  og: string | null;
  /**
   * 1 for any hole that injects rather than produces: a live disposal permit,
   * or a wellbore typed INJECTION / WATER SUPPLY / storage / service.
   *
   * Carried so the focus layer colours the same as the tile layer. Without it,
   * an injection well is blue on the statewide map and green the moment a search
   * focuses it -- the same well, two colours, depending on how you got there.
   */
  swd: number;
  /** 1 when the hole is no longer operational: plugged, shut in, abandoned. */
  dead: number;
}

/**
 * The focus-layer query: an AND of everything set below.
 *
 * EVERY LIST FIELD READS THE SAME WAY, and it is the rule `operatorNumbers`
 * has always followed: `null` is "no filter", and an EMPTY list is a resolution
 * that found nobody, so it draws no wells rather than the whole state.
 */
export interface FocusOpts {
  /**
   * Restrict to these operators' wellbores, or null for "any operator".
   *
   * A LIST rather than one number because a person search resolves to every
   * operator they are listed on. An EMPTY list is not the same as null: it means
   * the search resolved to nobody, so the honest answer is no wells at all.
   */
  operatorNumbers: number[] | null;
  /**
   * The global "exclude plugged wells" setting, which is a coarser cut than
   * `statuses` and composes with it: active + exclude-plugged is just active,
   * while all + exclude-plugged is "active or inactive" — a set of buckets alone
   * cannot name. Only applied where `statuses` was not set, because a request
   * for plugged wells is the more specific one.
   */
  excludePlugged: boolean;
  /**
   * RRC county codes. Several counties are several API-number ranges ORed
   * inside the one predicate, so "Andrews or Martin" is one filter.
   */
  countyCodes: number[] | null;
  /** PDQ internal district codes (1..14), translated to the mirror's labels. */
  districts: number[] | null;
  oilGas: "O" | "G" | null;
  /**
   * Which activity buckets to draw, or null for all three. Resolved per WELL
   * (see `statusPredicate` in `focus-where.ts`), never per wellbore row.
   */
  statuses: WellActivity[] | null;
  /**
   * The RRC's `well_type_name`, verbatim ("PRODUCING", "INJECTION", ...), or
   * null for any type.
   *
   * This is a CURRENT status, not a historical one, and the data enforces it:
   * the column is populated only on `on_schedule = 'Y'` rows — all 927,867
   * historic rows are blank — so a type only ever matches a well's live
   * assignment. That is the right reading anyway; "is an injector" is a fact
   * about a well now, not about a lease it was on in 1985.
   *
   * A hole matches if ANY of its live completions has one of these types. It can
   * have more than one: the grain is well x lease x field, so a hole completed
   * into two fields carries a type on each, and they need not agree (81 of
   * Andrews' 25,932 holes do not). There is no single current type to prefer,
   * and both rows are true of the hole.
   */
  wellTypes: string[] | null;
  /**
   * Total depth in feet, inclusive, from the wellbore's `api_depth`. Null on an
   * end means unbounded there.
   */
  minDepth: number | null;
  maxDepth: number | null;
  /**
   * Completion YEARS, inclusive, from the wellbore's `completion_date`.
   *
   * Years rather than dates because that is the grain the question is asked at
   * ("what got completed since the last boom"), and because the column is a
   * `YYYYMMDD` string, so a year range is a plain numeric comparison on it.
   *
   * ANY COMPLETION OF THE HOLE, not its current one. The wellbore grain is well
   * x lease x field, so a recompletion into another field is its own row with
   * its own date — genuinely a completion in that year. Reading only the
   * on-schedule row would also be the wrong half of the record: on 22% of holes
   * (measured over Andrews county) that row's date is blank while a historic row
   * carries a real one, so the "current row" reading throws away a fifth of the
   * county for no gain.
   *
   * Bounding either end EXCLUDES wells with no completion date at all — about
   * 8% of on-schedule wellbores. An unknown date is not evidence the well falls
   * in the range, and letting it through would put wells in the answer that
   * cannot be checked against the question. Same for an absent depth above.
   */
  minCompletionYear: number | null;
  maxCompletionYear: number | null;
  /**
   * PRODUCTION PER MONTH, inclusive: oil in bbl, gas in MCF. Null on an end
   * means unbounded there.
   *
   * The rate is the one `wildcat.well_rate` holds in the mirror, and it is the
   * same number the map's hover label and the well modal's Production tab show:
   * `monthlyRate(allocatedByTestBatch(...))` averaged over the last 12 FILED
   * months (`src/app/api/scout/well-rate/route.ts`). Oil is ALLOCATED off the
   * lease by W-10 test share, because oil is metered per lease; gas is not
   * allocated at all, because a gas id IS the well and the RRC reports against
   * it. So an oil figure here is a share of a lease's tank, not a meter
   * reading, and the filter bar says so where the user meets it.
   *
   * A well with NO ROW in that table has no rate on file, which is not zero
   * (18% of lease-months are never filed). It fails a bounded test rather than
   * passing it, the same way an unknown depth does above — see the join in
   * `buildFocusWhere`.
   */
  minOilRate: number | null;
  maxOilRate: number | null;
  minGasRate: number | null;
  maxGasRate: number | null;
  /**
   * The drawn area: circles and polygons, UNIONED — a well inside any of them
   * qualifies (`shapePredicate` in `@/lib/scout/geo-shapes`).
   *
   * EMPTY MEANS NO SPATIAL CONSTRAINT, which is the opposite of the empty-list
   * rule the lists above follow. There is no resolution step behind it that
   * could find nobody: a shape is drawn or it is not, and no shapes is simply
   * the whole map. `wellsInShapes` reads the empty case the other way (a
   * SELECTION of no shapes is empty) and `geo-shapes.ts` documents the pair.
   */
  shapes: Shape[];
  /**
   * A mineral owner on a county appraisal roll, or null for no owner filter.
   *
   * Draws the on-schedule wells on every lease the owner holds a taxed
   * interest in (`cad.mineral_interest`, see docs/plans/scout-minerals.md).
   * The roll is per county and tax year, so the key carries both; the clause
   * bounds itself to that county's API range because an Archer lease number
   * is only unique inside District 09.
   */
  owner: OwnerRef | null;
}

/** The key of one owner on one county's roll for one tax year. */
export interface OwnerRef {
  countyNo: string;
  taxYear: number;
  ownerId: string;
}

export interface OperatorMatch {
  operator_number: number;
  operator_name: string | null;
}

export interface OperatorFull {
  operator_number: number;
  operator_name: string | null;
  p5_status: string | null;
  addr_line1: string | null;
  addr_line2: string | null;
  city: string | null;
  state: string | null;
  zip: number | null;
  zip_suffix: number | null;
  phone: number | null;
  last_p5_date: number | null;
  oil_gatherer: string | null;
  gas_gatherer: string | null;
}

export interface OperatorWellRow {
  api_number: number;
  admin_district: number | null;
  county_code: number | null;
  oil_gas_label: string | null;
  is_plugged: boolean | null;
  total_depth: number | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * The two halves of the name a person uses — "ROACH" and "7" — kept apart
   * because the lease half is also what the lease tables key on. Either can be
   * blank on an older row; see `wellName`.
   */
  lease_name: string | null;
  well_no: string | null;
}

/**
 * Which bucket a wellbore falls in — for the operator modal's three well tabs,
 * for the map's Status filter, and for the RRC import's default checkboxes.
 *
 * ONE definition, in `@/lib/scout/well-activity`, re-exported here because this
 * file is where the Scout payload types live. It used to be answered three
 * different ways (and, before the Tiger migration, by a lease-level production
 * proxy that marked every well on a producing lease as producing).
 */
export type { WellActivity } from "./well-activity";

export interface OperatorWell extends OperatorWellRow {
  activity: WellActivity;
  /**
   * The RRC's own well type, verbatim.
   *
   * `activity` buckets everything that is not producing or plugged into "idle",
   * which puts an injector and a shut-in producer in the same bucket. The map
   * colours those differently, so it needs the type rather than the bucket.
   */
  well_type: string | null;
}

/**
 * Everything the operator modal shows, resolved in one server round trip so the
 * counts, the county labels, and the well buckets are all derived from a single
 * read (see `getOperatorProfile`).
 */
export interface OperatorProfile {
  operator: OperatorFull | null;
  officers: OfficerRow[];
  /** Exact well count from the DB, even when `wells` is a capped sample. */
  wellCount: number;
  wells: OperatorWell[];
  /** True when `wells` is a first-N sample of a larger fleet. */
  capped: boolean;
  /** Highest-producing first; may be a sample of `leaseCount` (see `fetchLeases`). */
  leases: OperatorLease[];
  /** Exact lease count from the database, sample or not. */
  leaseCount: number;
  last12: OperatorLast12;
  /**
   * Drilling permits the RRC has GRANTED this operator, newest issue first,
   * capped at `OPERATOR_PERMIT_SAMPLE`. Applications still in the queue are a
   * different feed and are not mixed in.
   */
  permits: OperatorPermit[];
  /** Every granted permit, counted in the database — not `permits.length`. */
  permitTotal: number;
  /**
   * Dated wellbore events for the Activity feed: completions and pluggings,
   * newest first, capped at `OPERATOR_EVENT_SAMPLE`. Read in the same round
   * trip as everything else here, so opening Activity costs no query at all.
   */
  wellEvents: OperatorWellEvent[];
  /** True when `wellEvents` is the newest slice of a longer history. */
  wellEventsCapped: boolean;
}

/**
 * One wellbore row's dated events, for the operator Activity feed.
 *
 * EVERY ROW OF THE HOLE, not the on-schedule one. The grain is well x lease x
 * field, so a recompletion into another field is its own row with its own date
 * — genuinely a second completion — and on 22% of holes the current row's
 * completion date is blank while a historic row carries a real one (see
 * `WellFilter.minCompletionYear`). Reading only the current row would throw a
 * fifth of the history away.
 *
 * SCOPED TO THIS OPERATOR by `operator_number` on the row itself, not by the
 * fleet it runs today: the feed answers "what did this operator do", and a
 * completion filed by the previous operator of a well is not that.
 *
 * Dates are `YYYY-MM-DD` or null. The mirror stores them as `YYYYMMDD` text and
 * zero-fills what it does not know, so the query drops anything that is not a
 * real calendar date rather than passing '19750000' along to be misread.
 */
export interface OperatorWellEvent {
  api_number: number;
  lease_name: string | null;
  well_no: string | null;
  county_code: number | null;
  /** The wellbore row's own lease columns, for `leaseKeyFromWellbore`. */
  oil_gas_code: string | null;
  /** EWA's district LABEL ("7B"), not PDQ's internal code. */
  district: string | null;
  lease_number: string | null;
  completion_date: string | null;
  plug_date: string | null;
}

/**
 * One granted drilling permit, with a position where the mirror has one.
 *
 * COORDINATES ARE THE EXCEPTION, NOT THE RULE. `rrc.permit` carries no
 * position at all; the only permits that can be mapped are the ones that passed
 * through the pending-application feed while this mirror was holding it, which
 * is where `lat`/`lon` come from. Null for everything issued before that window
 * opened, so the map plots a subset of the table and has to say so.
 */
export interface OperatorPermit {
  permit_number: string | null;
  /** Amendment sequence: 99 is the original, each amendment counts down. */
  permit_seq: string | null;
  lease_name: string | null;
  well_number: string | null;
  county_name: string | null;
  /** The district a Texas operator would say out loud ("7B"), not PDQ's code. */
  district_name: string | null;
  total_depth: number | null;
  filed_date: string | null;
  issued_date: string | null;
  expires_date: string | null;
  api_number: string | null;
  /**
   * The permit became a hole: the state carries a completion date or a filed
   * W-2/G-1 for its API. False also covers "cannot tell" — a permit whose API
   * was never assigned has certainly not been reported complete.
   */
  drilled: boolean;
  lat: number | null;
  lon: number | null;
}

/**
 * One well's estimated month, test-weighted — what `getOperatorWellRates`
 * returns per API.
 *
 * Per MONTH, not per day, so it sits on the same axis as every other volume the
 * operator dossier prints. It is an ESTIMATE in the strict sense: Texas files
 * oil per lease, and this is that lease's filed month divided among its wells by
 * the W-10/G-10 tests in effect (`sharesByMonth`), which is the same split the
 * well's own page and the map's hover label show.
 */
export interface OperatorWellRate {
  /** `YYYY-MM` the estimate came from — the record's last month with volume. */
  cycle: string;
  /** Barrels that month (oil + condensate). */
  oil: number;
  /** MCF that month (gas + casinghead). */
  gas: number;
}

/** Test-weighted estimates for a fleet, keyed by API number. */
export interface OperatorWellRates {
  byApi: Record<number, OperatorWellRate>;
  /**
   * True when the fleet spans more records than one request will read, so the
   * table is showing estimates for some of its wells and dashes for the rest.
   * See `OPERATOR_RATE_RECORD_CAP`.
   */
  capped: boolean;
}

export interface OperatorLast12 {
  oil_last12: number;
  gas_last12: number;
  /**
   * How many cycles the sum actually covers — the divisor for the per-month
   * rate the UI shows. Twelve for an operator who filed every month of the
   * window, fewer for one who did not; see `MONTHS_IN_WINDOW`.
   */
  months: number;
}

/** P-5 master fields for a set of operators (for the cluster CSV export). */
export interface OperatorP5 {
  operator_number: number;
  p5_status: string | null;
  last_p5_date: number | null;
  phone: number | null;
  addr_line1: string | null;
  addr_line2: string | null;
  city: string | null;
  state: string | null;
  zip: number | null;
  zip_suffix: number | null;
  oil_gatherer: string | null;
  gas_gatherer: string | null;
}

export interface OperatorLease {
  oil_gas_code: string;
  district_no: number;
  lease_no: number;
  lease_name: string | null;
  well_count: number;
  oil_last12: number | null;
  gas_last12: number | null;
  /** Cycles the sums cover, for the per-month rate. See `OperatorLast12`. */
  months: number | null;
  last_cycle: number | null;
  /**
   * Counties this lease's wells sit in. DERIVED, not a column: `leases` carries
   * a district but no county, so these come from the API numbers of the wells
   * bridged to the lease (`api_number / 100000` is the RRC county code — the
   * same value `wells.county_code` holds, verified against the live dataset).
   * Empty when none of the lease's wells were in the fetched sample.
   */
  county_codes: number[];
}

/** Which affiliation role the Network view is drawing. */
export type NetworkRole = "all" | "filing" | "agent";

export interface TopHub {
  officer_name: string;
  operator_count: number;
  total_wells: number;
  is_filing_agent: boolean;
  is_agent: boolean;
}

export interface SubgraphSeed {
  person?: string | null;
  operator?: number | null;
  county?: number | null;
}
