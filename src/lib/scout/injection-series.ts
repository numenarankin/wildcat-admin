import type { InjectionMonth, UicPermit } from "./rrc-types";

/**
 * ===========================================================================
 * INJECTION SERIES — the arithmetic behind the Injection tab's chart.
 * ===========================================================================
 *
 * Pulled out of `injection-chart.tsx` because every claim the chart makes is a
 * claim about numbers, and none of them can be checked through a rendered
 * recharts tree. The component keeps the toggles and the furniture; this file
 * decides what each month's point actually is.
 *
 * THE FOUR RULES THAT ARE EASY TO GET WRONG
 *   1. The volume permit is a RATE — barrels per day — and the series is a
 *      monthly total, so the ceiling is redrawn per month as rate x days in
 *      that month. It steps between 28 and 31 day months; it does not run flat.
 *   2. The pressure permit is NOT a rate. PSIG is PSIG whatever the month is
 *      long, so its ceiling is one flat value repeated across the window. Two
 *      ceilings, two different arithmetics, one chart.
 *   3. A ceiling that is missing must be NULL, never 0. A zero line sits on the
 *      axis and reads as a permit of zero — "you may not inject" — which is the
 *      opposite of "the RRC never stated one". Same for a month whose pressure
 *      was left blank: a gap, not a floor.
 *   4. Pressure ceilings do not ADD. Two permits on one hole are two intervals
 *      that each take their own water, so the volume allowance is their sum;
 *      but there is one wellhead and one gauge, and the H-10 pressure is the
 *      highest reading across the permits. Its ceiling is therefore the highest
 *      permitted pressure, matching how `getFleetPermittedRates` reads the same
 *      two columns in SQL (sum bbl, max PSIG).
 */

/** The three spans the chart's window buttons offer. */
export type InjectionWindow = "5Y" | "10Y" | "All";

export const INJECTION_WINDOWS: { value: InjectionWindow; months: number }[] = [
  { value: "5Y", months: 60 },
  { value: "10Y", months: 120 },
  { value: "All", months: Number.POSITIVE_INFINITY },
];

/** Days in the month a "YYYY-MM" names — the volume permit is a DAILY allowance. */
export function daysIn(cycle: string): number {
  const [y, m] = cycle.split("-").map(Number);
  // Day 0 of month m is the last day of month m-1 in 1-based terms, i.e. the
  // last day of the month `cycle` names. Handles February in a leap year.
  return new Date(y, m, 0).getDate();
}

/**
 * The permitted pressure ceiling for one wellbore, PSIG, or null.
 *
 * LIVE PERMITS ONLY, the same filter `permittedBblPerDay` uses in
 * `getWellInjection`: a permit cancelled in 1988 states nothing about what the
 * hole may do today, and drawing its limit as today's ceiling would invent
 * headroom (or an exceedance) out of a dead record. The well modal's stat tiles
 * fall back to the most recent permit when none is live — that fallback is
 * right for describing a wellbore and wrong for a ceiling, so it is not
 * repeated here.
 *
 * Non-positive values are dropped rather than kept. The RRC writes 0 into
 * `max_inj_pressure` when the field is unusable — usually because the real
 * limit is prose, parked in `max_inj_pressure_note` — and a 0 ceiling would
 * draw a line along the axis that every well on earth "exceeds".
 */
export function permittedPressurePsig(permits: UicPermit[]): number | null {
  const stated = permits
    .filter((p) => p.live)
    .map((p) => p.max_inj_pressure)
    .filter((v): v is number => v != null && v > 0);
  return stated.length > 0 ? Math.max(...stated) : null;
}

export interface InjectionSeriesInput {
  /** Oldest-first, as `getWellInjection` returns it. */
  monthly: InjectionMonth[];
  window: InjectionWindow;
  /** Summed authorised rate across live permits; null when none is stated. */
  permittedBblPerDay: number | null;
  /** From `permittedPressurePsig`; null when no live permit states one. */
  permittedPressurePsig: number | null;
  /** The "Permitted" toggle: governs the VOLUME ceiling only. */
  showVolumeCeiling: boolean;
  /** The "Pressure" toggle: governs everything on the PSIG axis. */
  showPressure: boolean;
}

/** One plotted month. Every nullable field is null because it is absent. */
export interface InjectionPoint {
  cycle: string;
  volume: number;
  /** Permitted bbl for THIS month: rate x its own day count. */
  permitted: number | null;
  /** `avg_pressure`, PSIG. */
  pressure: number | null;
  /** `max_pressure`, PSIG. */
  pressureMax: number | null;
  /**
   * [low, high] across the month's two reported pressures, for the shaded band
   * between the lines. Null unless BOTH were filed: a band needs two edges, and
   * half a band drawn from a zero would claim a reading nobody took.
   *
   * Ordered rather than assumed. A handful of H-10 rows carry avg above max
   * (transposed at entry), and recharts reads the pair as [baseline, top]: fed
   * an inverted pair it still draws, so the ordering is done here where it can
   * be seen instead of left to look like a rendering accident.
   */
  pressureBand: [number, number] | null;
  /** The flat permitted-pressure ceiling, repeated per point. */
  permittedPressure: number | null;
  reported: boolean;
}

export interface InjectionSeries {
  rows: InjectionPoint[];
  /**
   * Is there any pressure at all in THIS window — either series. Drives the
   * toggle's disabled state, so a window with no gauge readings cannot be
   * switched into an empty right-hand axis.
   */
  hasPressure: boolean;
  /** Draw the volume ceiling: asked for, and a positive rate on file. */
  showVolumeCeiling: boolean;
  /** Draw the pressure ceiling: overlay on, and a positive PSIG on file. */
  showPressureCeiling: boolean;
  /** First month past the H-10 reporting edge, for the shaded tail. */
  unreportedFrom: string | null;
  lastCycle: string | null;
}

/**
 * Build every series the chart draws, for one window and one toggle state.
 *
 * WHY THE PRESSURE CEILING RIDES WITH THE PRESSURE TOGGLE AND NOT WITH
 * "PERMITTED". Both ceilings are permits, so putting both under the Permitted
 * button is the tidier-looking rule, and it is the wrong one for two reasons.
 * The PSIG axis only exists while the overlay is on, so a ceiling on it would
 * be governed by a button that cannot show it. And the Permitted button is
 * disabled when no bbl/day is on file — a well permitted for pressure but not
 * volume (or the reverse) would have one ceiling locked behind the other's
 * absence. So: the Permitted button owns the volume axis, the Pressure button
 * owns the PSIG axis and everything drawn against it. The reader never gets a
 * max-pressure line with no ceiling to read it against, which is the whole
 * argument for drawing the ceiling.
 */
export function buildInjectionSeries(input: InjectionSeriesInput): InjectionSeries {
  const {
    monthly,
    window,
    permittedBblPerDay,
    permittedPressurePsig,
    showVolumeCeiling,
    showPressure,
  } = input;

  const months =
    INJECTION_WINDOWS.find((w) => w.value === window)?.months ??
    Number.POSITIVE_INFINITY;
  const windowed = Number.isFinite(months) ? monthly.slice(-months) : monthly;

  const hasPressure = windowed.some(
    (m) => (m.avg_pressure ?? 0) > 0 || (m.max_pressure ?? 0) > 0
  );
  const volumeCeiling =
    showVolumeCeiling && permittedBblPerDay != null && permittedBblPerDay > 0;
  const pressureCeiling =
    showPressure && permittedPressurePsig != null && permittedPressurePsig > 0;

  const rows = windowed.map<InjectionPoint>((m) => {
    const avg = showPressure ? (m.avg_pressure ?? null) : null;
    const max = showPressure ? (m.max_pressure ?? null) : null;
    return {
      cycle: m.cycle,
      volume: m.bbl,
      permitted: volumeCeiling
        ? Math.round(permittedBblPerDay! * daysIn(m.cycle))
        : null,
      pressure: avg,
      pressureMax: max,
      pressureBand:
        avg != null && max != null
          ? [Math.min(avg, max), Math.max(avg, max)]
          : null,
      permittedPressure: pressureCeiling ? permittedPressurePsig! : null,
      reported: m.reported,
    };
  });

  return {
    rows,
    hasPressure,
    showVolumeCeiling: volumeCeiling,
    showPressureCeiling: pressureCeiling,
    unreportedFrom: rows.find((r) => !r.reported)?.cycle ?? null,
    lastCycle: rows[rows.length - 1]?.cycle ?? null,
  };
}
