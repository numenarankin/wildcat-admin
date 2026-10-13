/**
 * The shapes the onboarding RRC steps render, shared by the UI and by whatever
 * eventually feeds it.
 *
 * Client-safe on purpose: no server imports, no database types, nothing that
 * drags `pg` into the browser bundle. The reduction from the mirror's rows to
 * these happens server-side, so the UI never sees a `LeaseMonth` or a raw
 * wellbore row and cannot start depending on one.
 *
 * See `docs/plans/rrc-onboarding-sync.md`.
 */

/** One operator, reduced to what a person needs to say "yes, that's us". */
export interface OperatorSummary {
  /** RRC operator number (P-5). The key for everything downstream. */
  operatorNumber: string;
  name: string;
  city: string | null;
  state: string | null;
  /** Wells on the P-5. What actually distinguishes two similar names. */
  wellCount: number;
  /** RRC's own P-5 status string, shown verbatim. */
  p5Status: string | null;
  /**
   * Officers filed on the P-5. These are the checkable fact on the card — an
   * operator recognises their own people faster than they parse a sentence
   * about why we guessed them.
   */
  officers: string[];
}

/** A scored candidate, with the sentence that explains why we think it is them. */
export interface OperatorMatch {
  operator: OperatorSummary;
  confidence: "confident" | "possible";
  /** "Same phone number, and Jim Rankin is listed as an officer." */
  reason: string;
}

/** What the match step renders: one card, and the runners-up beneath it. */
export interface MatchSurface {
  best: OperatorMatch | null;
  alternates: OperatorMatch[];
}

export type WellStatus = "active" | "inactive" | "plugged";

/** A lease as it would be created, before the user has touched it. */
export interface ImportableLease {
  /**
   * Stable row key within the draft: the PROPERTY (name + county), not an RRC
   * identifier. Texas files gas per well, so keying on the state's lease number
   * would split one lease into a fragment per gas well.
   */
  key: string;
  leaseNo: string;
  name: string;
  county: string;
  commodity: "oil" | "gas";
  /**
   * The lease's identity in the public record: PDQ's INTERNAL district code
   * (already translated from the label the wellbore row prints) plus the oil/gas
   * code. Stored on the lease so its production history is resolvable without a
   * second search. Null when the district could not be translated.
   *
   * NOT the same as `key`, which is a draft-local grouping string built from the
   * EWA label — the two districts disagree (real 09 is PDQ 13).
   */
  rrcDistrict: string | null;
  rrcOilGasCode: "O" | "G";
}

/** A well as it would be created, before the user has touched it. */
export interface ImportableWell {
  /** Stable row key within the draft; the API number in practice. */
  key: string;
  apiNumber: string;
  name: string;
  county: string;
  depthFt: number | null;
  type: "producer" | "injection";
  /** `ImportableLease.key` this well files under — the PROPERTY, not the record. */
  leaseKey: string;
  /**
   * This well's own RRC record number, as the state prints it.
   *
   * A gas well carries its GAS ID, which is issued per well; an oil well carries
   * its lease number, which covers the whole property. The two are different
   * identifiers and the well needs its own, because several records back one
   * lease (see `physicalLeaseKey` in `operator-fleet.ts`).
   */
  rrcLeaseNo: string;
  status: WellStatus;
  /**
   * The plug date (`YYYY-MM-DD`) when the status is `plugged`, else null.
   *
   * Carried because `wells.plugged_at` IS the app's plugged flag, and the state
   * is the only place this date exists for a well the operator is importing.
   * Non-null exactly when `status === "plugged"`: the RRC's own definition of
   * plugged is a plug date on the current record (`wellActivity` rule 2), so
   * there is no plugged well here without one.
   */
  pluggedOn: string | null;
  /** RRC's inactivity clock, why a well is in the inactive bucket. */
  inactiveYears: number | null;
  /**
   * The RRC field this completion is in, e.g. `SPRABERRY (TREND AREA)`.
   *
   * Seeds `wells.zone`. A field is not strictly a producing formation, but it is
   * what an operator says out loud, it is present on every wellbore row, and the
   * actual formation column arrives separately for the wells that have a
   * completion packet. Free text the operator can correct.
   */
  fieldName: string;
  /**
   * This API is completed in more than one field / lease.
   *
   * The mirror carries one row per well x lease x field, so a multi-completed
   * well appears several times and only one of those rows can decide which lease
   * we file it under. The choice is deterministic (see `loadFleetDraft`) but it
   * is still a choice, so it is surfaced rather than made quietly: 4.3% of
   * on-schedule API numbers are affected.
   */
  multiCompletion: boolean;
  /** The other lease names this API also files under, for the badge's tooltip. */
  otherLeaseNames: string[];
}

/**
 * Everything one or more operator numbers would bring in.
 *
 * `operators` is a list because a company holding two or three P-5 numbers is
 * ordinary rather than an edge case, and both fleets should import in one pass.
 */
export interface FleetDraft {
  operators: OperatorSummary[];
  leases: ImportableLease[];
  wells: ImportableWell[];
  /**
   * True when the operator has more wells on its P-5 than the review table
   * will render.
   *
   * Carried all the way to the UI on purpose. A silent cut reads as "that is all
   * there is", and here it would understate a customer's fleet by thousands
   * while also setting the price. `totalWells` is what the state actually has.
   */
  truncated?: boolean;
  totalWells?: number;
}

/** Per-well edits the user made before importing. Absent keys are unchanged. */
export interface WellEdit {
  name?: string;
  county?: string;
  depthFt?: number | null;
}

/** What the import step hands back on confirm. */
export interface ImportSelection {
  operatorNumbers: string[];
  /** Well keys to create. The length of this is what prices the plan. */
  wellKeys: string[];
  edits: Record<string, WellEdit>;
}

