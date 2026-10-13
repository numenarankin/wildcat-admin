/**
 * The UI's data contract for the full RRC mirror.
 *
 * These shapes ARE the spec for whoever wires the backend: field names and
 * nullability mirror the RRC's own columns (see
 * `docs/plans/scout-rrc-mirror-ui.md` Appendix A for the measured shape of each
 * dataset), so a query can be written straight against them.
 *
 * Two things the column names encode and the UI must respect:
 *   - Wellbore rows are one per well x lease x field. Any count is over
 *     DISTINCT api_number.
 *   - Everything status-shaped (`well_type_name`, the 14(b)(2) flags,
 *     `curr_inact_*`, `p5_org_status`) is populated ONLY on rows where
 *     `on_schedule = 'Y'` — 440,452 of 1,368,247. Historic rows carry blanks,
 *     which is why `WellDossier.current` gates whole tabs.
 */

/** `well_type_name`, as published. Measured domain, most common first. */
export type WellTypeName =
  | "PRODUCING"
  | "SHUT IN"
  | "TEMP ABANDONED"
  | "INJECTION"
  | "NO PRODUCTION"
  | "SWR-10-WELL"
  | "PARTIAL PLUG"
  | "WATER SUPPLY"
  | "NOT ELIGIBLE FOR ALLOWABLE"
  | "OBSERVATION"
  | "SHUT IN-MULTI-COMPL"
  | "LPG STORAGE"
  | "GAS STRG-INJECTION"
  | (string & {});

/** The thirteen 14(b)(2) reason flags, set to 'X' (or a letter) when in force. */
export interface Wl14b2Flags {
  ext_status: string | null; // A / D
  mech_integ: string | null;
  plg_ord_sf: string | null;
  pollution: string | null;
  fldops_hold: string | null;
  h15_prob: string | null;
  h15_delq: string | null;
  oper_delq: string | null;
  dist_sfp: string | null;
  dist_sf_clnup: string | null;
  dist_st_plg: string | null;
  good_faith: string | null;
  well_other: string | null;
}

/** One EWA wellbore row: well x lease x field. */
export interface WellboreRow {
  api_number: string;
  district: string | null;
  county_code: string | null;
  county_name: string | null;
  oil_gas_code: "O" | "G" | null;
  lease_name: string | null;
  lease_number: string | null;
  field_number: string | null;
  field_name: string | null;
  well_no: string | null;
  well_no_display: string | null;
  oil_unit_number: string | null;
  operator_name: string | null;
  operator_number: string | null;
  /** 'Y' only for the operator's CURRENT assignment. */
  on_schedule: "Y" | "N" | null;
}

/** Facts that exist only for on-schedule wells. */
export interface WellStatus {
  well_type_name: WellTypeName | null;
  wb_water_land_code: string | null; // Land Well / Bay Well / Offshore Well / Inland Well
  multi_comp_flag: string | null;
  api_depth: number | null;
  wb_shut_in_date: string | null;
  wl_shut_in_date: string | null;
  plug_date: string | null;
  plug_lease_name: string | null;
  plug_operator_name: string | null;
  completion_date: string | null;
  orig_completion_dt: string | null;
  curr_inact_yrs: number | null;
  curr_inact_mos: number | null;
  p5_org_status: string | null; // A X D H S R I
  h15_status_code: string | null; // C A D N U P E W
}

export interface WellCompliance {
  wb_14b2_flag: string | null; // Y / N / 0
  flags: Wl14b2Flags;
  surf_eqp_viol: string | null; // 'S'
  w3x_viol: string | null; // 'W'
}

export interface WellFilings {
  w2_g1_filed_date: string | null;
  w2_g1_date: string | null;
  w3_file_date: string | null;
  p5_renewal_month: string | null;
  p5_renewal_year: string | null;
  recent_permit: string | null;
  recent_permit_lease_name: string | null;
  recent_permit_operator_no: string | null;
  /** RRC's own audit stamp, shown as "record last modified". */
  modified_dt: string | null;
}

export interface WellLocation {
  lat: number | null;
  lon: number | null;
  bottom_lat: number | null;
  bottom_lon: number | null;
  /** RRC well symbol number — legend comes from the RRC symbol table. */
  symbol_num: string | null;
  /** 10 (best) .. 60. Drives plot confidence. */
  reliability: string | null;
  api10: string | null;
  stcode: string | null;
  abstract_label: string | null;
  survey_name: string | null;
  block_number: string | null;
}

/** Everything the well modal renders. */
export interface WellDossier {
  api_number: string;
  /** False for a historic (not on-schedule) wellbore: status tabs are hidden. */
  current: boolean;
  header: WellboreRow;
  status: WellStatus | null;
  compliance: WellCompliance | null;
  filings: WellFilings | null;
  location: WellLocation;
  /** One row per lease x field this hole is completed on. */
  completions: WellboreRow[];
  /** The LEASE's monthly series — per-well oil is allocated, never metered. */
  production: LeaseMonth[];
  /** This well's share of the lease's allocation, 0..1, or null when unknown. */
  allocationShare: number | null;
  /**
   * The same hole's production WEIGHTED BY WELL TEST, summed across every record
   * it sits on, already allocated — not a share to multiply by.
   *
   * Two differences from `production`, which is one lease read whole:
   *
   *   - It carries BOTH streams. Texas files oil per lease and gas per well, so
   *     a hole is routinely on an oil lease and its own gas id at once; one
   *     record shows one stream.
   *   - Each month is weighted by the W-10 in effect THAT month, with liquids
   *     and gas weighted separately, wells excluded before they were completed,
   *     and untested wells taking a head-count residual rather than zero.
   *
   * Empty when the hole is on no current schedule (a plugged or historic
   * wellbore), which is the case for falling back to the lease series.
   */
  productionByTest: LeaseMonth[];
  /** UIC permits and H-10 history; null when the hole has no UIC record. */
  injection: WellInjection | null;
  /** How the hole was built; null when the Well Bore Database has no row. */
  construction: WellConstruction | null;
  /** H-15 test filings, newest first. Empty for a well that has never filed. */
  h15: H15Test[];
  /** This hole's W-10 tests, newest first. Empty for a gas well or an untested one. */
  w10: W10Test[];
  /** This hole's G-10 tests, newest first. The gas mirror of `w10` — empty for
   *  an oil well, since the two forms cover disjoint halves of the state. */
  g10: G10Test[];
  /** W-3 plugging jobs, newest first. Usually one; a hole plugged back and
   *  re-entered has several. Empty for a well that has never been plugged. */
  plugging: PluggingJob[];
  /**
   * Filed W-2 / G-1 completion reports, newest first. Capped.
   *
   * The PAPERWORK, as distinct from `construction`, which is the Well Bore
   * Database's account of the same hole. What only this carries is the
   * formation record -- what the bit went through, at what depth, and which
   * zones the operator says were isolated.
   *
   * Casing appears in both sources and is deliberately read from `construction`
   * alone: 78,164 of the 79,173 wells with a report also have Well Bore
   * Database casing, so rendering both would put two casing lists on nearly
   * every well that has either.
   *
   * Thin coverage by design of the source, not of the query: 79,173 wells out
   * of 1.37M. An empty array is the normal answer for an older hole.
   */
  completionReports: CompletionReport[];
  /**
   * This well's share of the lease's TESTED oil, 0..1, or null when the well
   * has no usable test or the lease has none at all.
   *
   * The measured alternative to `allocationShare`, which is an even split. Both
   * are offered because neither is right on its own: the even split assumes
   * every well is identical, and the weighted one can only speak for wells that
   * have been tested.
   */
  w10Share: number | null;
}

// ---------------------------------------------------------------- production

/** One lease-month, all 25 published measures worth showing. */
export interface LeaseMonth {
  /** "YYYY-MM". */
  cycle: string;
  oil_prod_vol: number;
  oil_allow: number | null;
  oil_ending_bal: number | null;
  gas_prod_vol: number;
  gas_allow: number | null;
  gas_lift_inj_vol: number | null;
  cond_prod_vol: number;
  cond_limit: number | null;
  cond_ending_bal: number | null;
  csgd_prod_vol: number;
  csgd_limit: number | null;
  csgd_gas_lift: number | null;
  oil_tot_disp: number | null;
  gas_tot_disp: number | null;
  cond_tot_disp: number | null;
  csgd_tot_disp: number | null;
  /** 'N' on 18% of lease-months: a zero here means UNFILED, not unproductive. */
  prod_report_filed: "Y" | "N" | null;
  /** False for the ~3 cycles RRC has not published yet. */
  reported: boolean;
}

export type DispositionStream = "oil" | "gas" | "cond" | "csgd";

/** One month of disposition, keyed by RRC code ("00", "01", ... "99"). */
export interface DispositionMonth {
  cycle: string;
  codes: Record<string, number>;
}

export interface LeaseCountySplit {
  county_no: string;
  county_name: string;
  oil_prod_vol: number;
  gas_prod_vol: number;
  cond_prod_vol: number;
  csgd_prod_vol: number;
}

export interface LeaseWell {
  api_number: string;
  well_no: string | null;
  well_root_no: string | null;
  well_type_name: WellTypeName | null;
  county_name: string | null;
  /**
   * Surface hole, NAD83, from `rrc.well_location` — null for a hole the RRC
   * never geocoded, which is common on old leases. The Map tab plots what it
   * has and says how many it could not.
   */
  lat: number | null;
  lon: number | null;
  /**
   * This well's share of the lease's most recently reported month, as a daily
   * rate, weighted by filed well test (`@/lib/rrc/well-share`).
   *
   * Null when the lease has no record in the mirror or has reported nothing.
   * Zero for a service hole, which takes no share of what the lease produced.
   */
  oil_bbl_per_day: number | null;
  gas_mcf_per_day: number | null;
}

/** Everything the lease modal renders. */
export interface LeaseDossier {
  oil_gas_code: "O" | "G";
  district_no: string;
  district_name: string | null;
  lease_no: string;
  lease_name: string | null;
  field_no: string | null;
  field_name: string | null;
  field_type: string | null;
  gas_well_no: string | null;
  operator_no: string | null;
  operator_name: string | null;
  /** Y on 310,473 of 548,047 leases — the majority, so style it quiet. */
  off_schedule: boolean;
  /** Y on 40,805 — rare, so style it loud. */
  severance: boolean;
  monthly: LeaseMonth[];
  disposition: Record<DispositionStream, DispositionMonth[]>;
  counties: LeaseCountySplit[];
  wells: LeaseWell[];
  /** Who takes this lease's product, and the filings that changed it. */
  p4: LeaseP4;
}

// -------------------------------------------------------------------- market

export interface CycleTotals {
  cycle: string;
  oil: number;
  gas: number;
  cond: number;
  csgd: number;
}

export interface RankedRow {
  key: string;
  label: string;
  oil: number;
  gas: number;
  /**
   * Cycles the volumes cover, for the per-month rate the board shows. Absent
   * on the materialised lease board, which carries no count of its own; the
   * full window is the fallback. See `perMonth` in `lib/scout/format.ts`.
   */
  months?: number;
  /** Wells, leases, or operators depending on the ranking. */
  count?: number;
  /**
   * A second line under the label — the operator on a lease, the district on a
   * county. Optional because most rankings identify themselves in one line.
   */
  sub?: string | null;
}

/**
 * A geography with its own monthly series — one RRC district or one county.
 *
 * WIRING: districts come from `district_cycle` (5,252 rows, one per district x
 * month), counties from `county_cycle` (243,957). Both are pre-aggregated BY THE
 * RRC, so neither needs a roll-up from lease grain and neither touches the
 * 78.6M-row lease table.
 */
export interface AreaSeries {
  /** `district_no` or `county_no` — whatever the source table keys on. */
  key: string;
  label: string;
  /** Counties only: which district they sit in, for grouping the picker. */
  district_no?: string;
  monthly: CycleTotals[];
}

export interface MarketData {
  statewide: CycleTotals[];
  districts: AreaSeries[];
  /** All counties with production. The picker searches and multi-selects these. */
  counties: AreaSeries[];
  topCounties: RankedRow[];
  topFields: RankedRow[];
  topOperators: RankedRow[];
  /**
   * Top leases by oil over the trailing window.
   *
   * `key` is `oil_gas_code/district_no/lease_no`, the same triple the lease
   * routes take, so a row opens its dossier without a second lookup.
   */
  topLeases: RankedRow[];
  /** Last cycle RRC has actually published, e.g. "2026-05". */
  lastReportedCycle: string;
  /** Last cycle present in the mirror, published or not, e.g. "2026-08". */
  lastLoadedCycle: string;
}

// ------------------------------------------------------------------ operator

export interface OperatorOfficerRow {
  officer_name: string;
  officer_title: string | null;
  addr1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/** The P-5 master record, every column the RRC publishes. */
export interface OperatorRecord {
  operator_number: string;
  operator_name: string;
  /** flags[1]; the raw string is kept so the rest can be decoded later. */
  p5_status: string | null;
  flags: string | null;
  addr1: string | null;
  city1: string | null;
  state1: string | null;
  zip1: string | null;
  /** Second address — on file for many operators and shown nowhere today. */
  addr2: string | null;
  city2: string | null;
  state2: string | null;
  zip2: string | null;
  phone1: string | null;
  phone2: string | null;
  /** Registration date. NOT the P-5 filing — the operator's age. */
  org_date: string | null;
  last_p5_date: string | null;
}

/**
 * One of the operator's wellbores, as listed under Active / Inactive / Plugged.
 *
 * The bucket is the RRC's own: PRODUCING is active, a plug date is plugged, and
 * everything else on schedule (SHUT IN, TEMP ABANDONED, NO PRODUCTION, ...) is
 * inactive. No production proxy involved.
 */
export interface OperatorWellListRow {
  api_number: string;
  well_no: string | null;
  lease_name: string | null;
  lease_no: string | null;
  county_name: string | null;
  well_type_name: WellTypeName | null;
  api_depth: number | null;
  /** RRC inactivity clock, for the inactive list. */
  curr_inact_yrs: number | null;
  plug_date: string | null;
  flagged14b2: boolean;
}

/** Their wells, bucketed by the RRC's own well-type domain. */
export interface OperatorWellCounts {
  total: number;
  byType: { type: WellTypeName; count: number }[];
  plugged: number;
  /** 14(b)(2)-flagged wellbores, and the reasons across the fleet. */
  flagged14b2: number;
  reasons: { label: string; count: number }[];
  surfaceViolations: number;
  w3xViolations: number;
}

export interface OperatorLeaseRow {
  oil_gas_code: "O" | "G";
  district_no: string;
  lease_no: string;
  lease_name: string | null;
  field_name: string | null;
  county_name: string | null;
  well_count: number;
  oil_last12: number;
  gas_last12: number;
  /** Cycles the sums cover, for the per-month rate. See `perMonth`. */
  months: number;
  off_schedule: boolean;
  severance: boolean;
}

export interface OperatorFieldRow {
  field_no: string;
  field_name: string;
  lease_count: number;
  oil_last12: number;
  gas_last12: number;
  /** Cycles the sums cover, for the per-month rate. See `perMonth`. */
  months: number;
}

/** Everything the RRC operator modal renders. */
export interface OperatorDossier {
  record: OperatorRecord;
  officers: OperatorOfficerRow[];
  wells: OperatorWellCounts;
  /** The fleet itself, for the Active / Inactive / Plugged lists. */
  wellRows: OperatorWellListRow[];
  /**
   * True when `wellRows` is a page of the fleet rather than all of it. Read
   * `wells.total` for the count; this list is capped at `OPERATOR_WELL_CAP`
   * because an uncapped one could not be served for the largest operators.
   */
  wellRowsTruncated: boolean;
  leases: OperatorLeaseRow[];
  fields: OperatorFieldRow[];
  /** Operator-grain monthly production, straight from the RRC rollup. */
  monthly: LeaseMonth[];
  disposition: Record<DispositionStream, DispositionMonth[]>;
  /** Live disposal permits and how full they are. Zeroed, never null. */
  disposal: OperatorDisposal;
  /** H-15 position across the fleet. Zeroed, never null. */
  h15: OperatorH15;
  /**
   * APPROVED drilling permits, most recently issued first, capped.
   *
   * Capped because the tail is long: the busiest operator in the mirror holds
   * 19,549 permits and three hold over 16,000. `permitTotal` is the real count,
   * so the tab can label itself honestly rather than reporting the size of the
   * slice it happens to be showing.
   *
   * These are permits the RRC has GRANTED. Applications still awaiting a
   * decision are a different feed entirely (rrc.pending_queue) and are not
   * mixed in here -- an operator's approved permits and the ones they are still
   * waiting on answer different questions.
   */
  permits: PermitRow[];
  permitTotal: number;
}

export interface CompletionFormation {
  formation: string | null;
  depth: string | null;
  depth_tmd: string | null;
  encountered: string | null;
  isolated: string | null;
  remark: string | null;
}

export interface CompletionCasing {
  casing_size: string | null;
  weight_lb_per_foot: string | null;
  depth_set: string | null;
  hole_size: string | null;
  cement_type: string | null;
  sacks_of_cement: string | null;
  top_of_cement: string | null;
  row_type: string | null;
}

export interface CompletionReport {
  tracking_no: string | null;
  api_no: string | null;
  operator_no: string | null;
  operator_name: string | null;
  lease_name: string | null;
  well_no: string | null;
  field_no: string | null;
  field_name: string | null;
  county_no: string | null;
  county_name: string | null;
  /** The REAL district label — `completion` follows EWA, not PDQ. */
  district: string | null;
  well_type: string | null;
  completion_type: string | null;
  purpose_of_filing: string | null;
  completion_date: string | null;
  spud_date: string | null;
  approved_date: string | null;
  wellbore_profile: string | null;
  total_acres: string | null;
  producing_wells: string | null;
  survey: string | null;
  survey_block: string | null;
  survey_section: string | null;
  survey_abstract: string | null;
  latitude: string | null;
  longitude: string | null;
  formations: CompletionFormation[];
  casing: CompletionCasing[];
  /** Which further W-2/G-1 sections exist for this packet, and how many rows. */
  otherSections: { tag: string; rows: number }[];
}

/** One row of `rrc.permit` -- an approved drilling permit (form W-1). */
export interface PermitRow {
  permit_number: string | null;
  /**
   * Amendment sequence, counting DOWN from 99: an original permit is 99 and
   * each amendment takes the next lower number, keeping the permit number.
   */
  permit_seq: string | null;
  lease_name: string | null;
  well_number: string | null;
  county_no: string | null;
  county_name: string | null;
  /** PDQ's internal code, as stored. */
  district_no: string | null;
  /** The district a Texas operator would say out loud. */
  district_name: string | null;
  total_depth: number | null;
  operator_number: string | null;
  operator_name: string | null;
  filed_date: string | null;
  issued_date: string | null;
  expires_date: string | null;
}

// ------------------------------------------------------------------- people

export interface PersonMatch {
  officer_name: string;
  /** Distinct P-5 operators this person is listed on. */
  operator_count: number;
  /** Wellbores on schedule across those operators, DISTINCT by wellbore. */
  total_wells: number;
  city: string | null;
  state: string | null;
}

export interface PersonAffiliation {
  operator_number: number;
  operator_name: string | null;
  p5_status: string | null;
  /** Every title they hold at this operator, joined — "PRESIDENT / DIRECTOR". */
  officer_title: string | null;
  officer_city: string | null;
  officer_state: string | null;
}

export interface PersonDossier {
  name: string;
  affiliations: PersonAffiliation[];
}

// ---------------------------------------------------- injection / disposal

/**
 * One UIC permit. The grain is the PERMIT, not the well: a wellbore permitted
 * for two intervals has two rows, and a plugged-and-reissued hole keeps both.
 */
export interface UicPermit {
  uic_no: string;
  api_number: string | null;
  operator_no: string | null;
  operator_name: string | null;
  lease_name: string | null;
  /** '2' injection/disposal, '5' storage/geothermal. */
  uic_class: string | null;
  /** RRC code; resolve with `injTypeLabel` — the scheme changed in 1995. */
  inj_type: string | null;
  approved_date: string | null;
  cancel_date: string | null;
  /** W-3 plugging report on file: the well is dead whatever the permit says. */
  w3_date: string | null;
  /** Authorised liquid volume, barrels per day. */
  max_bbl_per_day: number | null;
  max_mcf_per_day: number | null;
  /** PSIG, or null when the RRC put text in the field — then see the note. */
  max_inj_pressure: number | null;
  max_inj_pressure_note: string | null;
  /** Permitted injection interval, feet. */
  top_inj_zone: number | null;
  bot_inj_zone: number | null;
  /** 'C' casing, 'T' tubing. */
  inj_mode: string | null;
  /** Permitted to accept third-party water. */
  is_commercial: boolean;
  fluid_comment: string | null;
  location: string | null;
  /** Permitted fluids as labels, already resolved from the 14 flags. */
  fluids: string[];
  /** Approved, not cancelled, no plugging report — it can take water today. */
  live: boolean;
}

/** One month of H-10 reported injection. An unfiled month is an ABSENT row. */
export interface InjectionMonth {
  /** "YYYY-MM". */
  cycle: string;
  bbl: number;
  mcf: number;
  avg_pressure: number | null;
  max_pressure: number | null;
  /**
   * False past the H-10 reporting edge. Filing runs about 14 months behind:
   * statewide filings per month plateau near 42,000 and fall away to 26 for the
   * newest month in the file. A low tail is UNFILED, not a well going quiet,
   * and must be drawn as such — the same rule the production series follows.
   */
  reported: boolean;
}

/** The Injection tab of the well modal. */
export interface WellInjection {
  permits: UicPermit[];
  monthly: InjectionMonth[];
  /** Last month whose filings are substantially complete, "YYYY-MM". */
  reportedThrough: string;
  /** Summed authorised bbl/day across live permits; null when none is stated. */
  permittedBblPerDay: number | null;
  /**
   * The highest pressure any live permit authorises, in PSIG; null when none
   * states one.
   *
   * A MAXIMUM, where the volume above is a sum. Two permitted intervals each
   * take their own water, so the barrels add; they share one wellhead and one
   * gauge, and the H-10's reported max is already the max across them, so a sum
   * would draw a ceiling no operator was ever granted. Same rule
   * `getFleetPermittedRates` uses in SQL (`sum(max_bbl_per_day)`,
   * `max(max_inj_pressure)`).
   */
  permittedPressurePsig: number | null;
  /**
   * Average barrels per day over the twelve months ending at the reporting
   * edge. The divisor is the days in the months this well actually filed, so a
   * well that filed three of them is not scored as if it sat idle for nine.
   */
  recentBblPerDay: number | null;
}

/** The disposal fleet of one operator. */
export interface OperatorDisposal {
  /** Live disposal permits (class 2, types 1 and 2). */
  wells: number;
  commercialWells: number;
  /** Summed authorised bbl/day across those permits. */
  permittedBblPerDay: number | null;
  /** Barrels injected in the twelve months ending at the reporting edge. */
  injectedBbl12m: number | null;
  /** Most recent month any of those wells filed an H-10, "YYYY-MM". */
  lastReported: string | null;
  /** The edge those figures are measured to, "YYYY-MM". */
  reportedThrough: string;
}

/** A disposal option near a point, with how full it already is. */
export interface NearbyDisposal {
  uic_no: string;
  api_number: string | null;
  operator_no: string | null;
  operator_name: string | null;
  lease_name: string | null;
  well_no: string | null;
  county_name: string | null;
  inj_type: string | null;
  is_commercial: boolean;
  max_bbl_per_day: number | null;
  top_inj_zone: number | null;
  bot_inj_zone: number | null;
  lat: number | null;
  lon: number | null;
  distance_mi: number;
  /** Average bbl/day over the well's last 12 reported months. */
  recentBblPerDay: number | null;
  /** recentBblPerDay / max_bbl_per_day, 0..1+, or null if either is unknown. */
  utilisation: number | null;
}

// -------------------------------------------------- wellbore construction

/** One casing string as filed. */
export interface CasingString {
  seq: number | null;
  /** Outside diameter in inches, e.g. 5.5 for 5 1/2". Null when unrecorded. */
  size_in: number | null;
  /** Pounds per foot. */
  weight_lb_ft: number | null;
  /** Depth the string was set to, feet. Null when the filing did not state one. */
  depth_set: number | null;
  hole_size_in: number | null;
  cement_amount: number | null;
  /** S sacks, Y cubic yards, F cubic feet. */
  cement_measure: string | null;
  /** Free text in the source, not always a depth. */
  top_of_cement: string | null;
}

/** One perforated interval. */
export interface PerfInterval {
  seq: number | null;
  /** Feet. Null is "not recorded" — never render it as zero. */
  top_ft: number | null;
  bottom_ft: number | null;
  /** 'OH' when producing from uncased hole, which has no interval to state. */
  open_hole: boolean;
}

/**
 * One filing against the hole, with the strings and perforations that belong
 * to it. The grain matters: a recompleted well has several, and merging them
 * would blend a 1978 completion with a 2019 one.
 */
export interface WellboreFiling {
  file_date: string | null;
  completion_date: string | null;
  /** Deepest plug-back stated on the filing, feet. */
  plug_back_ft: number | null;
  elevation: number | null;
  elevation_code: string | null;
  casing: CasingString[];
  perforations: PerfInterval[];
}

/** How the hole was built, from the RRC Well Bore Database. */
export interface WellConstruction {
  /** Newest filing first. */
  filings: WellboreFiling[];
  /** Total depth from the wellbore root, feet. */
  total_depth: number | null;
  /** Shallowest perforation top on record, feet — the top of the completion. */
  shallowest_perf: number | null;
  /** Deepest perforation bottom on record, feet. */
  deepest_perf: number | null;
  /** Any filing reports producing from uncased hole. */
  has_open_hole: boolean;
}

/** One H-15 inactive-well test filing. */
export interface H15Test {
  test_date: string | null;
  /** A approved, C compliant, D delinquent, N not approved, P pending,
   *  W W-3A extension, U UIC, E project extension, X W-1X denied. */
  status: string | null;
  status_date: string | null;
  operator_no: string | null;
  /** F fluid level, M mechanical integrity. */
  test_type: string | null;
  /** W wireline, S sonic, V visual, O other (fluid tests only). */
  fluid_method: string | null;
  /** H hydraulic, O other (mechanical integrity tests only). */
  mech_method: string | null;
  /** Depth to the top of the fluid column, feet. */
  top_of_fluid: number | null;
  /** "YYYY-MM" the next test is due, or null. */
  next_test_due: string | null;
}

/** An operator's H-15 position — the plugging-liability and distress signal. */
export interface OperatorH15 {
  /** Wellbores with at least one H-15 filing. */
  wellsTested: number;
  /** Wellbores whose most recent filing is delinquent. */
  delinquent: number;
  /** Wellbores due a test within the next 90 days, by the RRC's own clock. */
  dueSoon: number;
  /** Most recent test date across the fleet, or null. */
  lastTest: string | null;
}

// ------------------------------------------------------- W-10 well tests

/** One Form W-10 test: a single day's measured rate for one wellbore. */
export interface W10Test {
  test_date: string | null;
  /** Barrels per day, already scaled out of the tape's implied decimal. */
  daily_oil: number | null;
  daily_water: number | null;
  /** MCF per day. */
  daily_gas: number | null;
  /** Cubic feet per barrel, as the RRC calculated it. */
  gas_oil_ratio: number | null;
  /** P pumping, G gas lift, F flowing, B swab, V vacuum, S steam, H heat,
   *  C CO2, O other. */
  producing_method: string | null;
  /** I initial, R retest, S survey, W W-2 filed, D dummy. */
  type_flag: string | null;
  /** Reporting cycle the form processed in, "YYYY-MM-DD" (first of month). */
  cycle: string | null;
}

// --------------------------------------------------------- plugging

/** One Form W-3 plugging job, with its cement plugs summarised. */
export interface PluggingJob {
  plug_date: string | null;
  w3_filed_date: string | null;
  total_depth: number | null;
  /** Depth of usable-quality water the job had to protect. */
  fresh_water_depth: number | null;
  /** The cementing contractor named on the form. */
  cement_comp: string | null;
  /** O oil, G gas, D dry, S service. */
  well_type: string | null;
  /**
   * True when the STATE plugged this well, meaning the operator did not. The
   * orphaned-well marker; nothing else in the mirror names these directly.
   */
  state_funded: boolean;
  /** Cement plugs set in this job. */
  plugs: number | null;
  cement_sacks: number | null;
  shallowest_plug_top: number | null;
  deepest_plug_bottom: number | null;
}

// ------------------------------------------------- G-10 gas well tests

/**
 * One Form G-10: the annual deliverability test a gas well must file.
 *
 * The gas mirror of {@link W10Test}. Keyed by district + the six-digit RRC gas
 * id, which for a gas wellbore is carried in `lease_number` — the source file
 * has no API number at all.
 */
export interface G10Test {
  test_date: string | null;
  /** Deliverability: MCF/day actually produced during the test. */
  daily_gas: number | null;
  /** Condensate, BBL/day. */
  daily_cond: number | null;
  daily_water: number | null;
  /**
   * Open-flow potential in MCF/day — the most the well can make under normal
   * operating conditions. Only required where the field rules call for it, so
   * it is 0 or null far more often than `daily_gas` is.
   */
  potential: number | null;
  /** Shut-in wellhead pressure, psi. */
  siwh_press: number | null;
  /** Flowing pressure, psi. */
  flow_press: number | null;
  /** Bottom-hole pressure, psi. */
  bhp: number | null;
  /** Relative to air = 1.0; Texas gas sits near 0.6-0.7. */
  gas_gravity: number | null;
  /** Cubic feet per barrel, the ratio that classifies gas well vs oil well. */
  gas_liquid_ratio: number | null;
  /** "Y" when the well is shut in. */
  shut_in_flag: string | null;
  /** Date last produced or utilised. Null unless the well is shut in. */
  shut_in_date: string | null;
  /** "Y" when the filing was delinquent. */
  late_test: string | null;
  /** "Y" when this filing corrects an earlier one. */
  corrected: string | null;
  /** Operator that filed the form, which can differ from today's operator. */
  operator_no: string | null;
}

/**
 * A lease's most recent W-10 test per well — the only measured basis for
 * splitting a lease's oil between its wells.
 */
export interface LeaseW10 {
  wells: {
    well_no: string;
    api_number: string | null;
    test_date: string | null;
    daily_oil: number | null;
    producing_method: string | null;
    /** This well's share of the lease's tested oil, 0..1. */
    share: number | null;
  }[];
  /** Summed test rate across the lease's tested wells, bbl/d. */
  testedBopd: number;
  /** Wells on the lease with no usable test — they get no weighted share. */
  untested: number;
}

// ---------------------------------------------------------------- P-4

/** One counterparty on a lease: who gathers, buys or nominates a product. */
export interface P4Connection {
  /** F full well stream, G gas well gas, H condensate, O oil, P casinghead. */
  product_code: string | null;
  /** G gatherer, H purchaser, I nominator. */
  type_code: string | null;
  /** The counterparty's P-5 operator number. */
  gpn_no: string | null;
  operator_name: string | null;
  /** Share of the product, 0..1. */
  actual_percent: number | null;
  /** Effective date of the filing this came in on, "YYYY-MM-DD". */
  effective_date: string | null;
  interstate: boolean;
  intrastate: boolean;
}

/** One P-4 filing against a lease, with what it changed. */
export interface P4Filing {
  effective_date: string | null;
  approval_date: string | null;
  /** O original, R regular, A auto-change, T on tape, B bridged. Never 'D'. */
  record_type: string | null;
  operator_no: string | null;
  operator_name: string | null;
  field_no: string | null;
  /** What this filing changed, as labels — empty when it changed nothing named. */
  changes: string[];
}

/** The P-4 story for one lease: who takes the product now, and the history. */
export interface LeaseP4 {
  /** Current connections, newest filing per product and role. */
  connections: P4Connection[];
  /** Filings that changed something, newest first. Dummies excluded. */
  filings: P4Filing[];
}

// ------------------------------------------------- county mineral rolls (cad)
//
// Who OWNS the minerals under a lease, from the county appraisal district's
// mineral roll. Loaded per county and tax year into the mirror's `cad` schema
// by rrc-data (sql/019, load_cad.py); see docs/plans/scout-minerals.md. A
// valuation as of January 1 of the tax year, not a title opinion: interests on
// a lease do not sum to one, and every figure carries its tax year.

/** One taxed interest on one lease, with the owner it belongs to. */
export interface MineralInterest {
  cad_account: string;
  owner_id: string;
  owner_name: string;
  /** I C T E G N -- see `OWNER_TYPE_LABEL` in cad.ts. */
  owner_type: string | null;
  owner_city: string | null;
  owner_state: string | null;
  /** Decimal fraction the county taxes, > 0. */
  interest: number;
  /** R royalty, W working, O overriding. */
  interest_type: string;
  value_appraised: number | null;
  acreage: number | null;
}

/** The Minerals tab: every interest on one lease, plus the roll's own view of it. */
export interface LeaseMinerals {
  county_no: string;
  county_name: string;
  tax_year: number;
  interests: MineralInterest[];
  /** Sum of `value_appraised` over the interests. */
  value_appraised: number;
  /**
   * The county's copy of the RRC record, for reconciliation ONLY. The mirror
   * is the source of truth for operator and production; these are shown when
   * they disagree with it, never used as keys.
   */
  cad_operator_name: string | null;
  cad_first_cycle: string | null;
  cad_last_cycle: string | null;
  /** The one API the roll's legal description names: the reference well. */
  ref_api_number: string | null;
}

/** A search hit in the owner picker and Orion's search. */
export interface OwnerMatch {
  county_no: string;
  tax_year: number;
  owner_id: string;
  name: string;
  owner_type: string | null;
  city: string | null;
  state: string | null;
  /** Distinct leases the owner holds an interest in, this county and year. */
  lease_count: number;
  value_appraised: number;
}

/** One of an owner's leases, with the mirror's own name, operator and volume. */
export interface OwnerInterest {
  cad_account: string;
  oil_gas_code: string;
  /** PDQ code -- the lease route's key. */
  district_no: string;
  /** The real RRC label, for display. */
  district_name: string | null;
  lease_no: string;
  /** From rrc.lease, not the roll. */
  lease_name: string | null;
  operator_no: string | null;
  operator_name: string | null;
  interest: number;
  interest_type: string;
  value_appraised: number | null;
  acreage: number | null;
  /** The lease's volumes over the twelve months ending at the reported edge. */
  oil_12mo: number;
  gas_12mo: number;
  /** How many of those twelve months the lease has a row for. */
  months: number;
}

/** Another owner on the same leases, by how many they share. */
export interface CoOwner {
  owner_id: string;
  name: string;
  owner_type: string | null;
  shared_leases: number;
}

export interface OwnerDossier {
  county_no: string;
  county_name: string;
  tax_year: number;
  owner_id: string;
  name: string;
  owner_type: string | null;
  owner2_name: string | null;
  address: string | null;
  addr1: string | null;
  addr2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  interests: OwnerInterest[];
  coOwners: CoOwner[];
  /** The reported edge the 12-month volumes end at, 'YYYY-MM'. */
  reportedThrough: string;
}
