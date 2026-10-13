/**
 * The client-safe half of `@/lib/wells/wells`.
 *
 * `wells.ts` is a server module: it imports `getSupabaseServer`, and through
 * `@/lib/meters/engine` and `@/lib/tanks/series-loaders` it reaches
 * `@/lib/cache/request-cache`, which is `import "server-only"` and pulls in
 * `node:async_hooks`. Any client component that value-imported a helper from
 * `wells.ts` therefore dragged that whole graph into the browser bundle and the
 * production build failed with `'server-only' cannot be imported from a Client
 * Component module` (plus `the chunking context does not support external
 * modules (request: node:async_hooks)`).
 *
 * Type-only imports from `wells.ts` are fine — they are erased. It is the value
 * imports that break, so the pure functions the UI needs live here, with no
 * imports beyond a string normalizer. `wells.ts` re-exports every one of them,
 * so server callers and existing imports are unaffected.
 *
 * Rule of thumb: if a client component needs it and it does not touch Supabase,
 * it belongs in this file.
 */
import { canonical } from "@/lib/ai/ingest/normalize";
import type { Well } from "@/lib/wells/wells";

/** The three states /production shows a producer in. */
export type WellState = "active" | "inactive" | "plugged";

/**
 * Which of the three a well is in.
 *
 * Plugged WINS over active. The check constraint should make a plugged-and-active
 * row impossible, and this must not depend on that holding: if one ever exists,
 * the honest answer is still "plugged", not "active".
 */
export function wellState(well: Pick<Well, "active" | "pluggedAt">): WellState {
  if (well.pluggedAt) return "plugged";
  return well.active ? "active" : "inactive";
}

/**
 * What the Status control writes when someone picks one of the three states.
 *
 * BOTH columns, because they are one fact. Plugged is `active: false` plus a
 * date, and the date is what makes it plugged (the DB refuses a plugged well
 * that is active). Active and Inactive both CLEAR the date: leaving a plug date
 * on a well someone just marked Inactive would list it on the Plugged tab, which
 * is the disagreement `wells_plugged_is_inactive` exists to make unstorable.
 *
 * `existing` is the date the well already had, kept so re-picking Plugged on a
 * plugged well does not silently re-stamp it as plugged today. `today` is passed
 * in rather than read here so this stays pure.
 */
export function statusPatch(
  next: WellState,
  { existing, today }: { existing: string | null; today: string }
): { active: boolean; pluggedAt: string | null } {
  if (next === "plugged") return { active: false, pluggedAt: existing ?? today };
  return { active: next === "active", pluggedAt: null };
}

/**
 * The producer wells split into the three /production tabs.
 *
 * DISJOINT and EXHAUSTIVE over producers: the Inactive tab is inactive AND not
 * plugged, or a plugged well would be listed twice and the tab badges would sum
 * to more than the fleet. Injection wells belong to /disposal and are dropped
 * here rather than filtered by every caller.
 *
 * Plugged is sorted newest-first because the tab answers "what did we just
 * lose"; the other two keep `getWells`'s name order.
 */
export function partitionProducers(wells: Well[]): {
  active: Well[];
  inactive: Well[];
  plugged: Well[];
} {
  const producers = wells.filter((w) => w.type === "producer");
  return {
    active: producers.filter((w) => wellState(w) === "active"),
    inactive: producers.filter((w) => wellState(w) === "inactive"),
    plugged: producers
      .filter((w) => wellState(w) === "plugged")
      .sort((a, b) => (b.pluggedAt ?? "").localeCompare(a.pluggedAt ?? "")),
  };
}

function roundFt(ft: number): number {
  return Math.round(ft * 100) / 100;
}

/**
 * Running sum of a tubing string's joint lengths: index `i` is the depth to the
 * bottom of joint `i + 1`, which is the tally's third column. The last element is
 * the tubing depth.
 *
 * The single source of the tally's cumulative column, its total, and the Info
 * tab's tubing depth — so the modal, the summary and the export cannot disagree.
 */
export function tubingCumulative(lengths: number[]): number[] {
  let run = 0;
  return lengths.map((ft) => {
    run += ft;
    return roundFt(run);
  });
}

/**
 * Total tubing depth for a tally, feet — or `null` when there is no tally. Null,
 * not 0: an untallied well has an unknown tubing depth, and `0 ft` would read as
 * a fact about the string.
 */
export function tubingDepth(lengths: number[]): number | null {
  if (lengths.length === 0) return null;
  const cumulative = tubingCumulative(lengths);
  return cumulative[cumulative.length - 1];
}

/**
 * A stored `tubing_joints` array, cleaned for use. Drops anything that is not a
 * positive finite number, so one bad value can't make every cumulative figure
 * below it `NaN` — a tally that silently reads `NaN ft` is worse than one missing
 * a joint.
 */
export function mapTubingJoints(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (typeof v === "string" ? Number(v) : v))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
}

/**
 * Equipment labels that the tubing tally now answers: the joint count and the
 * tubing depth. Canonicalized, so the abbreviations already in the field and in
 * Orion's standard field list (`#jts`, `Tbg Depth`) match too.
 *
 * `canonical` drops "no"/"number"/"#" tokens, so "# joints" and "#jts" collapse to
 * "joints" / "jts" — both listed, since it does not stem.
 */
const TALLY_EQUIPMENT_LABELS = new Set(
  [
    "# joints",
    "#jts",
    "joints",
    "jts",
    "tubing depth",
    "tbg depth",
    "joint depth",
  ].map(canonical)
);

/**
 * Whether an equipment row's label is superseded by the tubing tally — i.e. it is
 * a free-text joint count or tubing depth, which the tally now derives.
 *
 * Used to hide such a row while a tally exists, so the same fact is not shown
 * twice with two different values. Non-destructive: the row is still stored, and
 * reappears if the tally is cleared. (Folding these into read-only template slots,
 * and dropping them on first save, is B3's job — see
 * docs/plans/well-page-shots-info-service-detail.md item D.)
 */
export function isTallyEquipmentLabel(label: string): boolean {
  return TALLY_EQUIPMENT_LABELS.has(canonical(label));
}

/**
 * A fluid-level shot: an acoustic shot down the annulus that reports the depth
 * from surface to the top of the fluid column.
 */
export interface WellShot {
  id: string;
  /** Date the shot was fired, ISO `YYYY-MM-DD`. */
  date: string;
  /** Time of day the shot was fired, `HH:MM`, or "" when not recorded. */
  time: string;
  /** Depth from surface to the top of the fluid column, feet, or null. */
  fluidLevelFt: number | null;
  /** Free-text observations. */
  notes: string;
}

/** A shot as supplied by the UI / tools, before it has a row id. */
export interface ShotField {
  date: string;
  time: string;
  fluidLevelFt: number | null;
  notes: string;
}

/** A raw `well_shots` row, as selected by {@link SHOT_COLS}. */
export interface ShotRow {
  id: string;
  shot_date: string | null;
  shot_time: string | null;
  fluid_level_ft: number | null;
  notes: string | null;
}

/**
 * A well's PUMPING SETUP as of a date: how the well was being pumped from that
 * day until a later record supersedes it.
 *
 * Effective-dated rather than current-only, which is the whole reason it is not
 * part of `well_equipment`: a fluid level fired in June has to be read against
 * the pump that was in the hole in June, not the one a September workover put
 * there. See `2026083000100_well_pumping.sql`.
 */
export interface WellPumping {
  id: string;
  /** The day this setup took effect, ISO `YYYY-MM-DD`. */
  effectiveDate: string;
  /** Pump setting depth, feet, or null. */
  pumpDepthFt: number | null;
  /** Plunger bore, inches, or null. */
  pumpSizeIn: number | null;
  /** Surface stroke length, inches, or null. */
  strokeLengthIn: number | null;
  /** Pumping speed, strokes per minute, or null. */
  strokesPerMin: number | null;
  /**
   * Pump-off timer setting as written on the controller ("8 on / 4 off",
   * "45 min per hour", "continuous"); "" when not recorded. Free text, because
   * there is no single number in it and parsing would discard what was written.
   */
  timer: string;
}

/** A pumping setup as supplied by the UI, before it has a row id. */
export interface PumpingField {
  effectiveDate: string;
  pumpDepthFt: number | null;
  pumpSizeIn: number | null;
  strokeLengthIn: number | null;
  strokesPerMin: number | null;
  timer: string;
}

/** A raw `well_pumping` row, as selected by {@link PUMPING_COLS}. */
export interface PumpingRow {
  id: string;
  effective_date: string | null;
  pump_depth_ft: number | null;
  pump_size_in: number | null;
  stroke_length_in: number | null;
  strokes_per_min: number | null;
  timer: string | null;
}

/** Maps a raw `well_pumping` row to a {@link WellPumping}. */
export function mapPumpingRow(r: PumpingRow): WellPumping {
  return {
    id: r.id,
    effectiveDate: r.effective_date ?? "",
    pumpDepthFt: r.pump_depth_ft,
    pumpSizeIn: r.pump_size_in,
    strokeLengthIn: r.stroke_length_in,
    strokesPerMin: r.strokes_per_min,
    timer: r.timer ?? "",
  };
}

/**
 * The setup in force on a DATE: the latest record effective on or before it.
 *
 * On-or-before, not nearest: a setup recorded for the 20th governs the 24th, and
 * one recorded for the 28th does not reach back to it. A shot fired before any
 * setup was ever recorded has none — null, not the earliest, because the earliest
 * is a claim about a day nobody wrote anything down for.
 */
export function pumpingOn(
  records: WellPumping[],
  date: string
): WellPumping | null {
  if (!date) return null;
  let best: WellPumping | null = null;
  for (const r of records) {
    if (!r.effectiveDate || r.effectiveDate > date) continue;
    if (best == null || r.effectiveDate > best.effectiveDate) best = r;
  }
  return best;
}

/**
 * Feet of fluid standing over the pump: `pumpDepthFt − fluidLevelFt`.
 *
 * Null unless BOTH are present — a missing basis is "unknown", and a zero here
 * would read as "pumped off", the opposite of unknown. The single source of this
 * formula for the panel, the export, and any future chart.
 *
 * The depth is now RESOLVED by the caller from the pumping record in force on
 * the shot's date (`pumpingOn`), rather than read off the shot: the shot stopped
 * carrying its own snapshot when `well_pumping` gave the setup a history
 * (`2026083000100_well_pumping.sql`).
 */
export function fluidOverPump(
  fluidLevelFt: number | null,
  pumpDepthFt: number | null
): number | null {
  if (fluidLevelFt == null || pumpDepthFt == null) return null;
  return pumpDepthFt - fluidLevelFt;
}

/**
 * Maps a raw `well_shots` row to a {@link WellShot}. Shared by `getWellShots`
 * (the page load) and `mapShot` in `@/lib/wells/actions.ts` (the realtime resync)
 * so a field can never be present in one path and absent in the other — the drift
 * that makes a value appear on load and vanish on the next table refresh.
 */
export function mapShotRow(r: ShotRow): WellShot {
  return {
    id: r.id,
    date: r.shot_date ?? "",
    // Postgres `time` serializes as `HH:MM:SS`; the UI works in `HH:MM`.
    time: (r.shot_time ?? "").slice(0, 5),
    fluidLevelFt: r.fluid_level_ft,
    notes: r.notes ?? "",
  };
}
