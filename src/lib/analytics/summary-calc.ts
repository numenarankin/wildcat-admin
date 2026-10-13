/**
 * Pure math for the analytics summary stats (no I/O, no React, no DB) so it
 * unit-tests in isolation and can be reused by the server loader.
 *
 * Three headline numbers, all derived from the measurement + accounting layers:
 *
 *  1. **Est. daily production** — the most recent tank-gauge interval normalized
 *     to a 24h rate (`(Δ stock + hauled) ÷ elapsed days`), summed across tanks,
 *     plus the meters' current MCF/day. Gauges aren't taken daily, so a single
 *     reading is a multi-day lump; dividing by the interval turns it into a rate.
 *  2. **Realized price** — the live benchmark (WTI / Henry Hub) scaled by the
 *     historical relationship between the benchmark and what the operator was
 *     actually paid (`realized $/unit ÷ benchmark $/unit`, averaged over recent
 *     months). Absorbs basis, gravity/transport deducts, and (for gas) the
 *     MMBtu→MCF heat-content difference in one factor.
 *  3. **Cumulative decline** — each well's Arps annual decline fitted per stream,
 *     blended into one company number weighted by each stream's dollar value
 *     (volume × realized price). Same-well ("same unit"): a new or shut-in well
 *     can't distort it the way an aggregate-volume curve would.
 */

import { decline12, type MonthlyRate } from "@/lib/wells/arps";

export const DAY_MS = 86_400_000;

/**
 * Fallback realization factor when the ledger has no realized/benchmark overlap:
 * assume the operator receives the benchmark price (factor 1), unadjusted, until
 * there's revenue history to measure a real basis differential from. Never guess
 * a discount we can't back up with data.
 */
/**
 * Days in an average month (365.25 / 12), for turning a daily rate into the
 * monthly figure the dashboard headlines and the wells table report. An average
 * rather than the current month's own length, because these are run rates, not
 * the sum of a calendar month: switching from a 28-day to a 31-day month would
 * otherwise step the headline by 11% with nothing happening in the field.
 */
export const DAYS_PER_MONTH = 365.25 / 12;

export const DEFAULT_OIL_FACTOR = 1;
export const DEFAULT_GAS_FACTOR = 1;

/** Trailing complete months fed to the decline fit. */
export const DECLINE_LOOKBACK_MONTHS = 12;
/**
 * Two gauge readings closer than this (in days) don't form a usable interval —
 * a same-shift re-gauge would divide a tiny Δ by a near-zero span and explode.
 */
const MIN_INTERVAL_DAYS = 0.5;

/** Epoch ms for an ISO date + optional `HH:MM` (UTC), matching the decline fit. */
function readingMs(date: string, time: string): number {
  const t = time && time.length >= 4 ? time : "00:00";
  return Date.parse(`${date}T${t}:00Z`);
}

/** Calendar days in a `YYYY-MM` month (deterministic; no clock read). */
function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// --- 1. Est. daily production (latest gauge interval → rate) ----------------

/** A gauge reading reduced to what the rate needs. */
export interface RateReading {
  date: string;
  time: string;
  bbls: number;
}

/** A run ticket reduced to its net barrels drawn off. */
export interface RateTicket {
  date: string;
  netBbls: number;
}

export interface TankRate {
  /** Barrels per day over the latest usable interval. Negative is a real signal. */
  bblPerDay: number;
  /** Date of the latest reading the rate is anchored on. */
  asOf: string;
}

/**
 * The most recent gauge-implied daily oil rate for one tank, or null when there
 * isn't a usable interval (fewer than two readings, or no prior reading at least
 * {@link MIN_INTERVAL_DAYS} before the latest). Produced barrels over the
 * interval are `(latest − prior) stock + net hauled in the interval`, divided by
 * the interval's elapsed days. `readings` must be oldest-first.
 */
export function latestTankRate(
  readings: RateReading[],
  tickets: RateTicket[]
): TankRate | null {
  if (readings.length < 2) return null;
  const latest = readings[readings.length - 1];
  const latestMs = readingMs(latest.date, latest.time);

  // Walk back to the newest reading a real interval before `latest`.
  let prev: RateReading | null = null;
  for (let i = readings.length - 2; i >= 0; i--) {
    const gapDays = (latestMs - readingMs(readings[i].date, readings[i].time)) / DAY_MS;
    if (gapDays >= MIN_INTERVAL_DAYS) {
      prev = readings[i];
      break;
    }
  }
  if (!prev) return null;

  const days = (latestMs - readingMs(prev.date, prev.time)) / DAY_MS;
  if (!(days > 0)) return null;

  // Net barrels hauled off in (prev, latest]. Tickets carry a date only.
  let hauled = 0;
  for (const t of tickets) {
    if (t.date > prev.date && t.date <= latest.date) hauled += t.netBbls;
  }
  const produced = latest.bbls - prev.bbls + hauled;
  return { bblPerDay: produced / days, asOf: latest.date };
}

/** One tank's readings + tickets for the company rate roll-up. */
export interface TankRateInput {
  readings: RateReading[];
  tickets: RateTicket[];
}

export interface DailyProductionRate {
  oilBblPerDay: number;
  gasMcfPerDay: number;
  /** Latest reading date any oil rate is anchored on, or null. */
  asOf: string | null;
}

/**
 * A daily rate out of lumpy measured volumes: everything measured in the last
 * `days` days, divided by `days`.
 *
 * Produced water arrives in hauls, not in a reading a day — a tank trucked twice
 * a month has two enormous days and twenty-eight zeroes, so the last day of the
 * series is either a lump or nothing and neither is a rate. Averaging over a
 * window is how the disposal page already quotes bbl/d (`swdWellIndicators`,
 * 30 days), and this is that arithmetic, sharable.
 *
 * `today` is passed in rather than read from the clock so the window is
 * deterministic. The window is (today - days, today]: `days` whole days ending
 * today. Zero when the window holds nothing.
 */
export function trailingDailyRate(
  points: { date: string; bbls: number }[],
  today: string,
  days: number
): number {
  if (days <= 0) return 0;
  const from = new Date(Date.parse(today + "T00:00:00Z") - days * DAY_MS)
    .toISOString()
    .slice(0, 10);
  let volume = 0;
  for (const p of points) {
    if (p.date > from && p.date <= today) volume += p.bbls;
  }
  return volume / days;
}

/**
 * Company est. daily production: sum each oil tank's latest-interval rate, plus
 * the meters' current MCF/day (already daily-native). `asOf` is the freshest
 * reading date underlying the oil rate.
 */
export function estDailyProduction(
  oilTanks: TankRateInput[],
  meterMcfPerDay: number[]
): DailyProductionRate {
  let oilBblPerDay = 0;
  let asOf: string | null = null;
  for (const t of oilTanks) {
    const rate = latestTankRate(t.readings, t.tickets);
    if (!rate) continue;
    oilBblPerDay += rate.bblPerDay;
    if (asOf == null || rate.asOf > asOf) asOf = rate.asOf;
  }
  const gasMcfPerDay = meterMcfPerDay.reduce((s, m) => s + (m || 0), 0);
  return { oilBblPerDay, gasMcfPerDay, asOf };
}

// --- 3. Cumulative (aggregate) decline --------------------------------------

/** One well's per-stream annual decline + window volumes for weighting. */
export interface WellStreams {
  wellId: string;
  /** Effective annual decline (fraction) for oil, or null when unfittable. */
  oilDecline: number | null;
  gasDecline: number | null;
  /** Total oil / gas produced over the window (weighting basis). */
  oilVol: number;
  gasVol: number;
}

/** A per-well/day production row within the decline window. */
export interface DeclineRow {
  wellId: string;
  date: string;
  oilProduction: number;
  gasProduction: number;
}

/**
 * Per-well decline inputs, but with each stream's decline taken as the Modified
 * Arps FORWARD-12-MONTH decline (the "Proj. 12-mo decline" headline) rather than
 * a trailing exponential fit. Monthly rollup is month volume ÷ producing days;
 * a stream that fails the Arps data gate (pre-peak / too short) drops out as
 * null and is disclosed through the coverage figures instead.
 */
export function wellStreamsForDeclineArps(rows: DeclineRow[]): WellStreams[] {
  const byWell = new Map<string, DeclineRow[]>();
  for (const r of rows) {
    const list = byWell.get(r.wellId);
    if (list) list.push(r);
    else byWell.set(r.wellId, [r]);
  }

  const forward = (monthly: Map<string, number>): number | null => {
    const series: MonthlyRate[] = [...monthly.entries()]
      .map(([month, rate]) => ({ month, rate }))
      .sort((a, b) => (a.month < b.month ? -1 : 1));
    return decline12(series);
  };

  const out: WellStreams[] = [];
  for (const [wellId, wellRows] of byWell) {
    const oilByMonth = new Map<string, number>();
    const gasByMonth = new Map<string, number>();
    let oilVol = 0;
    let gasVol = 0;
    // Monthly RATE = month volume ÷ days in month (dissolves gauge lumpiness).
    const oilMonthVol = new Map<string, number>();
    const gasMonthVol = new Map<string, number>();
    for (const r of wellRows) {
      const m = r.date.slice(0, 7);
      oilVol += r.oilProduction;
      gasVol += r.gasProduction;
      oilMonthVol.set(m, (oilMonthVol.get(m) ?? 0) + r.oilProduction);
      gasMonthVol.set(m, (gasMonthVol.get(m) ?? 0) + r.gasProduction);
    }
    for (const [m, v] of oilMonthVol) oilByMonth.set(m, v / daysInMonth(m));
    for (const [m, v] of gasMonthVol) gasByMonth.set(m, v / daysInMonth(m));

    out.push({
      wellId,
      oilDecline: forward(oilByMonth),
      gasDecline: forward(gasByMonth),
      oilVol,
      gasVol,
    });
  }
  return out;
}

export interface DeclineSummary {
  /** Revenue-weighted blended annual decline (fraction), or null. */
  blended: number | null;
  /** Oil-only and gas-only volume-weighted annual declines, or null. */
  oil: number | null;
  gas: number | null;
  /** Wells contributing at least one fitted stream. */
  wellsCovered: number;
  wellsTotal: number;
  /** Share of window revenue represented by the fitted streams (0–100). */
  revenueCoveredPct: number;
}

/**
 * Blend every well's per-stream annual decline into one company number,
 * weighting each stream by its dollar value (window volume × realized price).
 * A stream that couldn't be fitted drops out of the blend but still counts
 * against coverage, so a thin-data stream is disclosed, not silently ignored.
 */
export function aggregateDecline(
  wells: WellStreams[],
  oilPrice: number,
  gasPrice: number
): DeclineSummary {
  let num = 0;
  let den = 0;
  let oilNum = 0;
  let oilDen = 0;
  let gasNum = 0;
  let gasDen = 0;
  let coveredRev = 0;
  let totalRev = 0;
  let wellsCovered = 0;

  for (const w of wells) {
    const oilRev = Math.max(0, w.oilVol) * oilPrice;
    const gasRev = Math.max(0, w.gasVol) * gasPrice;
    totalRev += oilRev + gasRev;
    let covered = false;

    if (w.oilDecline != null && oilRev > 0) {
      num += w.oilDecline * oilRev;
      den += oilRev;
      oilNum += w.oilDecline * oilRev;
      oilDen += oilRev;
      coveredRev += oilRev;
      covered = true;
    }
    if (w.gasDecline != null && gasRev > 0) {
      num += w.gasDecline * gasRev;
      den += gasRev;
      gasNum += w.gasDecline * gasRev;
      gasDen += gasRev;
      coveredRev += gasRev;
      covered = true;
    }
    if (covered) wellsCovered += 1;
  }

  return {
    blended: den > 0 ? num / den : null,
    oil: oilDen > 0 ? oilNum / oilDen : null,
    gas: gasDen > 0 ? gasNum / gasDen : null,
    wellsCovered,
    wellsTotal: wells.length,
    revenueCoveredPct: totalRev > 0 ? (coveredRev / totalRev) * 100 : 0,
  };
}

export interface BlendedDecline {
  /** Revenue-weighted oil+gas annual decline (fraction), or null if neither fits. */
  blended: number | null;
  /** The per-stream Arps forward-12-month declines feeding the blend, or null. */
  oilDecline: number | null;
  gasDecline: number | null;
}

/**
 * Blend one unit's (lease / battery) oil and gas declines into a single
 * revenue-weighted annual decline — the same "weight each stream by window volume
 * × realized price" rule as the company `aggregateDecline`, applied to a single
 * unit rather than a well set. Each stream's decline is the Arps forward-12-month
 * fit of its monthly rate series (`decline12`); a stream
 * that can't be fitted drops out of the blend (so an oil-only lease still reports
 * its oil decline). Pure — the caller builds the monthly rates + window volumes.
 */
export function blendDecline(
  oilMonthly: MonthlyRate[],
  gasMonthly: MonthlyRate[],
  oilVol: number,
  gasVol: number,
  oilPrice: number,
  gasPrice: number
): BlendedDecline {
  const project = (s: MonthlyRate[]): number | null => decline12(s);
  const oilDecline = project(oilMonthly);
  const gasDecline = project(gasMonthly);
  const { blended } = aggregateDecline(
    [{ wellId: "unit", oilDecline, gasDecline, oilVol, gasVol }],
    oilPrice,
    gasPrice
  );
  return { blended, oilDecline, gasDecline };
}
