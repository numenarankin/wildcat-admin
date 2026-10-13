/**
 * Tank strapping: convert a gauge reading (inches) into barrels.
 *
 * v1 uses a single linear factor per tank (`bblPerInch`): `gauge × bblPerInch`.
 * There is no bottom/tare offset — production is measured from the CHANGE in
 * level, and a tank's dead bottom is a constant that cancels out of every delta,
 * so it carries no production information and was retired (migration
 * 2026071101200). Both event types (readings and run levels) convert identically
 * through this one factor.
 *
 * Pure and dependency-free so it can be unit-tested in isolation and shared by
 * every read/write path that needs the conversion.
 */
export function bblsFromGauge(gauge: number, bblPerInch: number): number {
  if (!Number.isFinite(gauge) || !Number.isFinite(bblPerInch)) return 0;
  return gauge * bblPerInch;
}

/**
 * A stick gauge as it is actually read off the tape: feet, whole inches, and a
 * quarter.
 *
 * The stored reading is a single number of INCHES, and a pumper standing on a
 * tank should never be the one converting to it. 10' 2 1/4" is what they see;
 * 122.25 is what the strapping factor multiplies.
 */
export interface GaugeParts {
  feet: number;
  inches: number;
  /** The quarter-inch, as a fraction of an inch: 0, 0.25, 0.5 or 0.75. */
  quarter: number;
}

/** The quarters a stick is read to, in the order the picker offers them. */
export const GAUGE_QUARTERS: { value: number; label: string }[] = [
  // "0/4" rather than "0": beside 1/4, 1/2 and 3/4 it reads as the same kind of
  // answer, which is what makes "none" an obvious pick instead of a blank.
  { value: 0, label: "0/4" },
  { value: 0.25, label: "1/4" },
  { value: 0.5, label: "1/2" },
  { value: 0.75, label: "3/4" },
];

/** Feet + inches + quarter, as the inches the reading is stored in. */
export function gaugeInches(parts: GaugeParts): number {
  const feet = Number.isFinite(parts.feet) ? parts.feet : 0;
  const inches = Number.isFinite(parts.inches) ? parts.inches : 0;
  const quarter = Number.isFinite(parts.quarter) ? parts.quarter : 0;
  return feet * 12 + inches + quarter;
}

/**
 * A stored reading back into the three fields, for editing.
 *
 * Rounded to the nearest quarter, because that is the whole resolution the form
 * can express. A reading that arrived from document ingest at some other
 * precision therefore shows as the nearest quarter, and the derived-volume line
 * moves with it, so the change is on screen before it is saved rather than
 * after.
 */
export function gaugeParts(gauge: number): GaugeParts {
  const total = Number.isFinite(gauge) ? Math.max(0, gauge) : 0;
  const quarters = Math.round(total * 4);
  const wholeInches = Math.floor(quarters / 4);
  return {
    feet: Math.floor(wholeInches / 12),
    inches: wholeInches % 12,
    quarter: (quarters % 4) / 4,
  };
}
