/**
 * WHAT MAKES A WELL ACTIVE — the single definition, for every surface in Scout.
 *
 * The map's Status filter, the operator dossier's well buckets and the RRC
 * import's default checkboxes all answered this question separately, and they
 * disagreed. The worst of it was the map: "Active" meant nothing more than "no
 * plug date", so it drew 86,707 shut-in holes, 28,959 temporarily abandoned
 * ones, 164,024 wellbores with no current schedule row at all, and — because
 * the predicate ran per ROW on a well x lease x field table — 25,865 wells that
 * ARE plugged on another row. An operator scouting for live wells got a map of
 * the whole state.
 *
 * THE RULE, IN PRECEDENCE ORDER. A well is:
 *   1. ACTIVE if ANY of its rows is a live completion — on schedule, carrying no
 *      plug date of its own, typed as something that has not stopped, and with
 *      the inactivity clock at zero.
 *   2. PLUGGED if the CURRENT record says so: an on-schedule row with a plug
 *      date.
 *   3. INACTIVE if it still has a live schedule row, just not a running one.
 *   4. PLUGGED if any historic row carries a plug date. Only reached when the
 *      hole has no current record at all, which is the normal state of a
 *      plugged well: it drops off the schedule.
 *   5. INACTIVE otherwise.
 *
 * WHY THE ORDER, AND NOT JUST "ANY PLUG DATE ANYWHERE". Because a wellbore is
 * re-entered. Sky Resources' 42932346 was plugged in 1980 and re-completed in
 * 1985; 50338806 was plugged in 2000 by another operator and re-completed in
 * 2022. The plug sits on a historic row forever, and reading it as the hole's
 * state calls four of Sky's producing wells plugged. A live completion is the
 * later fact and it wins. What the per-row reading got wrong is the opposite
 * case — a plugged hole whose blank on-schedule row made it look active — and
 * step 2 and step 4 are what catch that.
 *
 * INJECTORS COUNT AS ACTIVE. An injection, disposal, storage or water-supply
 * hole is an operating well that happens not to make oil, the map already
 * colours it separately (blue), and an operator hunting disposal capacity is
 * looking for exactly those. Only 653 of 29,313 injectors have the inactivity
 * clock running, so the clock does not quietly reclassify the fleet.
 *
 * The definition is duplicated ONCE, in SQL, inside
 * `scripts/scout-sync-data.mjs` — the sync writes a status flag into the points
 * file so the tiles can be filtered client-side without a round trip. That copy
 * is pinned to this one by `well-activity.test.ts`, which fails if the two type
 * lists drift.
 */

/** Active / inactive / plugged, the three buckets every Scout surface uses. */
export type WellActivity = "active" | "inactive" | "plugged";

/**
 * `well_type_name` values that mean the hole has STOPPED, verbatim as the RRC
 * spells them. A well carrying one of these is idle whatever else is true of
 * it, and the map has always drawn them red (`dead` in the points file) — this
 * is that same list, finally reaching the filter as well as the colour.
 *
 * PARTIAL PLUG is here and not under "plugged": the hole is plugged back to a
 * shallower depth, so the wellbore still exists and can be re-entered, but
 * nothing is producing from it now.
 */
export const STOPPED_WELL_TYPES = [
  "SHUT IN",
  "SHUT IN-MULTI-COMPL",
  "TEMP ABANDONED",
  "ABANDONED",
  "NO PRODUCTION",
  "PARTIAL PLUG",
  "SEALED",
  "NOT ELIGIBLE FOR ALLOWABLE",
] as const;

const STOPPED = new Set<string>(STOPPED_WELL_TYPES);

/** The list as a SQL `in (...)` body, so a query never re-types it by hand. */
export function stoppedTypesSql(): string {
  return STOPPED_WELL_TYPES.map((t) => `'${t}'`).join(", ");
}

export interface WellActivityInput {
  /**
   * THIS ROW's plug date, not the hole's.
   *
   * Every TypeScript caller is looking at on-schedule rows only (the operator
   * fleet lists), where the row IS the current record — so a plug date here is
   * step 2 of the rule. Never pass "plugged somewhere in this well's history":
   * that is step 4, it only applies when no current record exists, and the SQL
   * copies are where it is resolved.
   */
  plugged: boolean;
  /** True when the row is the operator's current assignment (`on_schedule = 'Y'`). */
  onSchedule: boolean;
  /** `well_type_name`, which only on-schedule rows carry. */
  wellTypeName: string | null;
  /**
   * The RRC's inactivity clock in YEARS (`curr_inact_yrs`).
   *
   * Years only. `curr_inact_mos` is the months part of the same clock, and a
   * well down for a few months is a workover, not an idle well — the state's
   * own inactive-well regime starts at twelve months, which is where this line
   * is drawn too.
   */
  inactiveYears: number | null;
}

/**
 * Is this hole an INJECTOR — one Wildcat would model as an injection well?
 *
 * INJECT / DISPOS only. Deliberately NARROWER than the map's blue dot
 * (`wellStatus` in `wells-map.tsx`, and `swd` in the points file), which also
 * covers water supply, storage and other service holes because it answers "does
 * this put fluid in the ground rather than make oil". A fleet list answers a
 * different question — "which of these do we import and run as injection wells"
 * — and a water-supply well is not one of those.
 *
 * Shared so the operator dossier's Injection tab and the seeding flow's well
 * types cannot disagree about the same fleet: Sky Resources' one WATER SUPPLY
 * well was an injector on one screen and a producer on the other.
 */
export function isInjectionWell(wellTypeName: string | null): boolean {
  const t = (wellTypeName ?? "").toUpperCase();
  return t.includes("INJECT") || t.includes("DISPOS");
}

/** Which bucket a well falls in. See the rule at the top of this file. */
export function wellActivity(w: WellActivityInput): WellActivity {
  if (w.plugged) return "plugged";
  // No live schedule row means no current operator, no type, and no status
  // columns — a historic wellbore, not an active one.
  if (!w.onSchedule) return "inactive";
  const type = (w.wellTypeName ?? "").trim().toUpperCase();
  if (type === "") return "inactive";
  if (STOPPED.has(type)) return "inactive";
  if ((w.inactiveYears ?? 0) > 0) return "inactive";
  return "active";
}
