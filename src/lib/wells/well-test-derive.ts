import { productionInWindow, type Segment } from "@/lib/tanks/tank-series";
import {
  dayBefore,
  sharesFromFractions,
  type WellShare,
} from "@/lib/tanks/allocation";

/**
 * Well-test derivation — the pure core of well-level oil/water testing.
 *
 * A test isolates ONE well to a tank over a clock window while the rest of the
 * battery keeps producing into its other tank(s). Nothing about the tanks is
 * entered on the test: it names the isolation tank and the control tank(s), and
 * both rates are read from the STANDARD tank reading series over the window
 * (`productionInWindow`, hauls excluded). The tested well's share of its battery
 * is then
 *
 *   frac = isolation ÷ (isolation + control)
 *
 * and its water rate is the water measured over the same window — node throughput
 * when the test names a water meter/tank, else the volume the operator typed
 * (many wells have nothing metering test water). Stored water is ALWAYS barrels;
 * a bucket test is read in gallons at the wellhead and converted at the form, so
 * `gallonsToBbl` here is the only place that ratio lives.
 *
 * A battery's split is then POOLED across its member wells' latest fracs and
 * effective-dated by test end date, so trickle entry works: testing one well
 * re-cuts the timeline from that date while the others keep their older fracs.
 * Untested members resolve through the one shared rule
 * (`sharesFromFractions`): normalize, single leftover, or not derivable.
 *
 * Pure and dependency-free (types + `tank-series` / `allocation` math) so it
 * unit-tests without a database and can preview live in the browser.
 */

/**
 * US oil barrel, in gallons.
 *
 * The one unit boundary in well testing. A bucket test is measured in GALLONS —
 * that is the graduation on the side of a bucket, and asking a pumper for a fifth
 * of a barrel is asking them to do the division at the wellhead. Everything
 * downstream of the form (`test_water_bbls`, every water split, every rate) is
 * barrels, so the ratio lives here and is applied exactly once, on the way in.
 */
export const GALLONS_PER_BBL = 42;

/** A bucket's gallons as the barrels that get stored. Null until it is a number. */
export function gallonsToBbl(gallons: number | null): number | null {
  if (gallons == null || !Number.isFinite(gallons)) return null;
  return gallons / GALLONS_PER_BBL;
}

/**
 * Stored barrels back as the gallons they were typed as, for a reopened form.
 *
 * Rounded, because the round trip is not exact in binary: 5 gal stores as
 * 0.119047619… bbl and comes back as 5.000000000000001, which is what the
 * pumper would then be looking at in the box. Four places is far finer than a
 * bucket can be read and coarse enough to eat the float noise.
 */
export function bblToGallons(bbls: number | null): number | null {
  if (bbls == null || !Number.isFinite(bbls)) return null;
  return Number((bbls * GALLONS_PER_BBL).toFixed(4));
}

/** A test's measured volumes over its window, as the data layer extracts them. */
export interface WellTestVolumes {
  /** Isolation-tank production over the window, bbl; null when not measured. */
  isolationBbls: number | null;
  /** Σ control-tank production over the window, bbl; null when none was named. */
  controlBbls: number | null;
  /** Water over the window, bbl (node throughput or typed); null when unmeasured. */
  waterBbls: number | null;
}

/** A test's derived rates + its share of the battery. */
export interface WellTestRates {
  /** Isolation-tank rate over the window, bbl/day; null when unmeasured. */
  oilRate: number | null;
  /** Σ control-tank rate over the window, bbl/day; null when no control tank. */
  controlRate: number | null;
  /** `iso ÷ (iso + control)`, 0–1; null when the pair can't be compared. */
  frac: number | null;
  /** Water rate over the window, bbl/day (÷ 24 for the bbl/hr display). */
  waterRate: number | null;
}

/**
 * Fractional days between two ISO timestamps, or null when unusable (span ≤ 0).
 * Deliberately local rather than imported from `@/lib/wells/well-tests`: that
 * module consumes this one (it fills every test's derived volumes), so importing
 * back would make the pair circular.
 */
function windowDays(startAt: string, endAt: string): number | null {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const days = (end - start) / 86_400_000;
  return days > 0 ? days : null;
}

/** Volume clamped to ≥ 0 — a level drop with no haul is a data error, not negative
 *  production, and must not produce a negative share. */
function nonNegative(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v > 0 ? v : 0;
}

/**
 * A test's rates + battery share from its window and measured volumes.
 *
 * `frac` is null (the test can't weight anything) when the isolation volume is
 * missing, when no control tank was named — there is nothing to compare against —
 * or when isolation + control is zero. A zero control volume with positive
 * isolation is legitimate and yields `frac = 1`: the rest of the battery genuinely
 * made nothing over the window. That case is only reachable once the control tanks
 * were observed over the window — an unobserved tank arrives here as null, not
 * zero (see `tankWindowVolume`).
 */
export function wellTestRates(
  window: { startAt: string; endAt: string | null },
  volumes: WellTestVolumes
): WellTestRates {
  const days = window.endAt ? windowDays(window.startAt, window.endAt) : null;
  if (days == null || days <= 0) {
    // An OPEN test (close observation pending) or a bad window is not operative.
    return { oilRate: null, controlRate: null, frac: null, waterRate: null };
  }

  const iso = nonNegative(volumes.isolationBbls);
  const control = nonNegative(volumes.controlBbls);
  const water = nonNegative(volumes.waterBbls);

  const total = iso == null || control == null ? null : iso + control;
  const frac = total == null || total <= 0 ? null : (iso as number) / total;

  return {
    oilRate: iso == null ? null : iso / days,
    controlRate: control == null ? null : control / days,
    frac,
    waterRate: water == null ? null : water / days,
  };
}

/**
 * True when a tank's series BRACKETS a window — it has an anchor at or before the
 * start and one at or after the end, so the tank was actually observed either
 * side of the test.
 *
 * Segments run anchor to anchor and are contiguous, so the span of the segment
 * list is the span of the observations; there is no interior hole to check for.
 */
export function seriesCoversWindow(
  segments: Segment[],
  fromMs: number,
  toMs: number
): boolean {
  const { firstMs, lastMs } = seriesSpan(segments);
  if (firstMs == null || lastMs == null) return false;
  return firstMs <= fromMs && lastMs >= toMs;
}

/**
 * A series' observed span, or nulls when it holds no observations at all.
 *
 * Segments run anchor to anchor and are contiguous, so the span of the list is
 * the span of the gauges behind it.
 */
export function seriesSpan(segments: Segment[]): {
  firstMs: number | null;
  lastMs: number | null;
} {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of segments) {
    if (s.fromMs < lo) lo = s.fromMs;
    if (s.toMs > hi) hi = s.toMs;
  }
  return Number.isFinite(lo) ? { firstMs: lo, lastMs: hi } : { firstMs: null, lastMs: null };
}

/** What a tank was doing in the test whose coverage is being reported. */
export type TestTankRole = "isolation" | "control" | "water";

/**
 * One named tank's observed span against a test window, and whether it brackets
 * it.
 *
 * The test no longer collects gauges of its own: it names tanks and a window,
 * and the tanks' standing series supply the volumes. So "nobody gauged this tank
 * either side of the window" stops being a thing the entry form can prevent and
 * becomes the ordinary way a test fails to derive. `tankWindowVolume` already
 * refuses that case; this is the same judgement, reported rather than collapsed
 * to a null, so the surface can say WHICH tank is missing gauges.
 */
export interface TankCoverage {
  tankId: string;
  role: TestTankRole;
  /** First / last observation on the tank, ms; null when it has no series. */
  firstMs: number | null;
  lastMs: number | null;
  /** True when the series brackets the window at both ends. */
  covers: boolean;
}

/** Coverage for every tank a test names. An open test (no end) covers nothing. */
export function windowCoverage(
  tanks: { tankId: string; role: TestTankRole; segments: Segment[] }[],
  startAt: string,
  endAt: string | null
): TankCoverage[] {
  const fromMs = Date.parse(startAt);
  const toMs = endAt ? Date.parse(endAt) : NaN;
  const usable =
    Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs;
  return tanks.map((t) => {
    const { firstMs, lastMs } = seriesSpan(t.segments);
    return {
      tankId: t.tankId,
      role: t.role,
      firstMs,
      lastMs,
      covers: usable && seriesCoversWindow(t.segments, fromMs, toMs),
    };
  });
}

/**
 * The named tanks whose gauges do NOT bracket a window, by tank id.
 *
 * The same judgement as `windowCoverage`, made from bare stamps rather than
 * segments, so an entry form can warn from the reading times it already has in
 * hand. A tank first gauged after the window opened, or last gauged before it
 * closed, measures nothing over it, and a test built on one weights nothing at
 * all.
 *
 * An OPEN test (no end) is not checked: it derives nothing until it is closed,
 * and the gauge that will close it usually has not been taken yet.
 */
export function uncoveredTanks(
  stampsByTank: Record<string, string[]>,
  startAt: string,
  endAt: string
): string[] {
  if (!startAt || !endAt || endAt <= startAt) return [];
  const out: string[] = [];
  for (const [tankId, stamps] of Object.entries(stampsByTank)) {
    if (stamps.length === 0) {
      out.push(tankId);
      continue;
    }
    if (stamps[0] > startAt || stamps[stamps.length - 1] < endAt) out.push(tankId);
  }
  return out;
}

/**
 * The widest window every named tank can measure: the LATEST first observation
 * to the EARLIEST last one.
 *
 * This is what an entry form may offer. A window reaching outside it is not
 * derivable by construction (`seriesCoversWindow` refuses it), so offering it
 * would only let the pumper record a test that silently weights nothing. Null
 * when a named tank has no series, or when the tanks' spans do not overlap.
 */
export function derivableWindow(
  coverage: Pick<TankCoverage, "firstMs" | "lastMs">[]
): { fromMs: number; toMs: number } | null {
  if (coverage.length === 0) return null;
  let from = -Infinity;
  let to = Infinity;
  for (const c of coverage) {
    if (c.firstMs == null || c.lastMs == null) return null;
    if (c.firstMs > from) from = c.firstMs;
    if (c.lastMs < to) to = c.lastMs;
  }
  return to > from ? { fromMs: from, toMs: to } : null;
}

/**
 * A tank's production over a test window from its level series, or null when the
 * window is unusable (open test / non-positive span) or the series does not cover
 * it. Both bounds are ISO timestamps, as stored on the test.
 *
 * The coverage guard is what keeps "nobody gauged this tank" from reading as
 * "this tank made nothing": `productionInWindow` sums the segments overlapping
 * the window and so returns 0 for a tank with no observations at all, which on a
 * control tank would hand the tested well `frac = iso / (iso + 0) = 1` — the whole
 * battery. Null instead, so the test simply doesn't weight until the gauges are
 * there. Partial coverage is refused for the same reason: prorating half a window
 * understates the control side and overstates the well.
 */
export function tankWindowVolume(
  segments: Segment[],
  startAt: string,
  endAt: string | null
): number | null {
  if (!endAt) return null;
  const fromMs = Date.parse(startAt);
  const toMs = Date.parse(endAt);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return null;
  }
  if (!seriesCoversWindow(segments, fromMs, toMs)) return null;
  return productionInWindow(segments, fromMs, toMs);
}

// --- Open tests: what they have measured so far -----------------------------

/**
 * What an OPEN test has measured so far.
 *
 * An open test derives nothing (`tankWindowVolume`) and weights nothing on the
 * battery timeline; that stays true. This is a separate, explicitly provisional
 * read for the pumper looking at a test in progress: the same window cut, closed
 * at the latest gauge EVERY named tank has, so the figures are what the test
 * would say if it were closed right there.
 */
export interface ThusFar {
  /** Where the provisional window closes, ISO. */
  asOf: string;
  /** `startAt` → `asOf`, fractional days. */
  days: number;
  oilBbls: number | null;
  controlBbls: number | null;
  frac: number | null;
}

/**
 * Where an open test's provisional window closes: the EARLIEST last gauge among
 * the named tanks, so every one of them still brackets it. Null when a named
 * tank has no series or none has been gauged since the test started — "not
 * yet", never a window past the last stick, which `seriesCoversWindow` would
 * refuse anyway.
 */
export function provisionalEnd(
  named: { segments: Segment[] }[],
  startAt: string
): string | null {
  const fromMs = Date.parse(startAt);
  if (!Number.isFinite(fromMs) || named.length === 0) return null;
  let toMs = Infinity;
  for (const n of named) {
    const { lastMs } = seriesSpan(n.segments);
    if (lastMs == null) return null;
    if (lastMs < toMs) toMs = lastMs;
  }
  return toMs > fromMs ? new Date(toMs).toISOString() : null;
}

/** An open test's volumes and share over its provisional window, or null. */
export function thusFarVolumes(
  isolation: Segment[],
  controls: Segment[][],
  startAt: string
): ThusFar | null {
  const asOf = provisionalEnd(
    [{ segments: isolation }, ...controls.map((segments) => ({ segments }))],
    startAt
  );
  if (asOf == null) return null;
  const isolationBbls = tankWindowVolume(isolation, startAt, asOf);
  let controlBbls: number | null = null;
  if (controls.length > 0) {
    controlBbls = 0;
    for (const c of controls) {
      const v = tankWindowVolume(c, startAt, asOf);
      if (v == null) {
        controlBbls = null;
        break;
      }
      controlBbls += v;
    }
  }
  const { frac } = wellTestRates(
    { startAt, endAt: asOf },
    { isolationBbls, controlBbls, waterBbls: null }
  );
  return {
    asOf,
    days: windowDays(startAt, asOf) as number,
    oilBbls: isolationBbls,
    controlBbls,
    frac,
  };
}

// --- Pooled battery timeline ------------------------------------------------

/** One test reduced to what the timeline needs: whose it is, when it ended, its frac. */
export interface FracSample {
  wellId: string;
  /** The test's end date, ISO `YYYY-MM-DD` — when its frac becomes operative. */
  endDate: string;
  /** The test's derived share of its battery (0–1), or null when not derivable. */
  frac: number | null;
  /** The source test's id, carried through for drill-through / delete. */
  testId?: string;
}

/** One derived allocation period on a battery's timeline. */
export interface DerivedWellTestPeriod {
  effectiveFrom: string;
  /** Chained: the day before the next derived period's start; null when latest. */
  effectiveTo: string | null;
  /** The tests whose fracs produced this period's shares. */
  wellTestIds: string[];
  shares: WellShare[];
}

/**
 * Each member well's LATEST usable frac as of `onDate` (a test on the date counts).
 * Later end dates win; among samples sharing an end date, the last one seen wins,
 * so a same-day re-test supersedes.
 */
function latestFracsAsOf(
  samples: FracSample[],
  memberWellIds: string[],
  onDate: string
): { fracByWell: Map<string, number>; testIds: string[] } {
  const members = new Set(memberWellIds);
  const best = new Map<string, FracSample>();
  for (const s of samples) {
    if (s.frac == null || !members.has(s.wellId)) continue;
    if (s.endDate > onDate) continue;
    const cur = best.get(s.wellId);
    if (!cur || s.endDate >= cur.endDate) best.set(s.wellId, s);
  }
  const fracByWell = new Map<string, number>();
  const testIds: string[] = [];
  for (const [wellId, s] of best) {
    fracByWell.set(wellId, s.frac as number);
    if (s.testId) testIds.push(s.testId);
  }
  return { fracByWell, testIds };
}

/**
 * Build a battery's well-test allocation periods from its member wells' tests.
 *
 * One candidate period per distinct test end date, each running until the day
 * before the next candidate (the latest stays open). A period whose split cannot
 * be derived — more than one member well untested as of that date, or all fracs
 * zero — is DROPPED rather than erroring, so the battery's manual split covers
 * those dates instead. Order-independent: samples are sorted internally.
 */
export function wellTestBatteryPeriods(
  samples: FracSample[],
  memberWellIds: string[]
): DerivedWellTestPeriod[] {
  const members = [...new Set(memberWellIds.filter(Boolean))];
  if (members.length === 0) return [];

  const usable = samples.filter(
    (s) => s.frac != null && s.endDate && members.includes(s.wellId)
  );
  if (usable.length === 0) return [];

  const dates = [...new Set(usable.map((s) => s.endDate))].sort();
  const ordered = [...usable].sort((a, b) =>
    a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0
  );

  const periods: DerivedWellTestPeriod[] = [];
  for (const from of dates) {
    const { fracByWell, testIds } = latestFracsAsOf(ordered, members, from);
    const { shares } = sharesFromFractions(fracByWell, members);
    if (shares.length === 0) continue; // not derivable → manual covers these dates
    periods.push({
      effectiveFrom: from,
      effectiveTo: null,
      wellTestIds: testIds,
      shares,
    });
  }

  // Chain the KEPT periods: each runs until the day before the next one that was
  // actually derivable (so a dropped date doesn't leave a hole), latest stays open.
  for (let i = 0; i < periods.length - 1; i++) {
    periods[i].effectiveTo = dayBefore(periods[i + 1].effectiveFrom);
  }

  return periods;
}
