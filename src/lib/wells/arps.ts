/**
 * Modified Arps decline (hyperbolic with a terminal-exponential switch) — the
 * decline model the production overhaul specifies, superseding the placeholder
 * `exponentialDecline` for the chart trendline (Phase 5) and the "Proj. 12-mo
 * decline" headline (Phase 6).
 *
 *   q(t) = qi / (1 + b·Di·t)^(1/b)          (hyperbolic, 0 < b ≤ 1)
 *   q(t) = qi · exp(−Di·t)                   (exponential, b → 0)
 *
 * with a guardrail: clamp b ∈ [0, 1] and switch hyperbolic → exponential once the
 * instantaneous decline D(t) = Di / (1 + b·Di·t) falls to a terminal minimum
 * `dMin` (default 7%/yr), so a high-b fit can't grow a tail that never dies.
 *
 * `t` is YEARS since the START of the fitting window, so `qi` is the rate at the
 * window start (not original potential) and the integral forward is REMAINING
 * reserves, never original EUR. The fit is on MONTHLY rates (daily is operational
 * noise), post-peak only, in log-rate space.
 *
 * Pure and dependency-free so it unit-tests without a database and runs on the
 * client to draw the trendline live.
 */

import type { ProductionPoint } from "@/lib/wells/wells";
import { emaAsOf } from "@/lib/analytics/ema";

/** Which production stream a fit or a rollup reads. */
export type DeclineStream = "oil" | "gas";

export interface DeclineFit {
  /** Rate at the window start (barrels/day for oil), q at t = 0. */
  qi: number;
  /** Initial nominal decline, per year. */
  Di: number;
  /** Decline exponent, clamped to [0, 1]. */
  b: number;
  /** Years at which hyperbolic switches to terminal exponential (0 = immediate). */
  tSwitch: number;
  /** Terminal minimum decline, per year. */
  dMin: number;
  /** Months of post-peak data the fit used. */
  months: number;
  /** Years spanned by the fitting window (t at the last data point). */
  spanYears: number;
  /** ISO `YYYY-MM` of the window start (peak month) — t = 0 anchors here. */
  startMonth: string;
}

/**
 * Every knob the fit has.
 *
 * Each defaults to the constant below it, and production passes none of them —
 * the app is meant to run on one tuning, not a per-caller one. They are settable
 * so the tuning can be SEEN: `/dev/decline` sweeps them against real wells, which
 * is the only honest way to judge whether a threshold is too aggressive.
 */
export interface FitOpts {
  /** Terminal minimum decline (per year). Default 0.07 (7%/yr). */
  dMinAnnual?: number;
  /** Minimum post-peak months required to fit. Default 6. */
  minMonths?: number;
  /** Despike window in months (centered). Default 5. */
  hampelWindow?: number;
  /** Despike threshold in robust sigma; LOWER flags more. Default 3. */
  hampelK?: number;
  /** How much history the peak is judged on, in days. Default 90. */
  peakSmoothDays?: number;
  /** Post-fit residual rejection in robust sigma; LOWER drops more. Default 3. */
  residK?: number;
  /** Skip the despike pass entirely, to see what it was doing. Default false. */
  noDespike?: boolean;
}

/**
 * The months a curve may be fitted on: those strictly before `inProgress`
 * (`YYYY-MM`, normally the current calendar month). A few days averaged as if
 * they were a month are not a month's rate, and a partial month at the end of
 * the series swung every fit that included it: the company figure moved 1.3
 * points at a month boundary. Every fit in the app cuts here so the dashboard
 * card, the lease and well charts and Orion's answer read the same months.
 */
export function completeMonths<T extends { month: string }>(
  rates: readonly T[],
  inProgress: string = currentMonth()
): T[] {
  return rates.filter((r) => r.month < inProgress);
}

/**
 * THE decline of a monthly series: the forward 12-month fall of its Arps fit
 * over its complete months, or null when nothing fits. Every card, row and
 * tool that quotes one number for a series goes through here, so they cannot
 * disagree about which months were fitted or how the figure is read.
 */
export function decline12(
  rates: readonly MonthlyRate[],
  opts: FitOpts = {},
  inProgress: string = currentMonth()
): number | null {
  const fit = fitDecline(completeMonths(rates, inProgress), opts);
  return fit ? forward12moDecline(fit) : null;
}

/** The current calendar month, `YYYY-MM`. */
export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** A monthly production RATE sample (e.g. barrels/day averaged over the month). */
export interface MonthlyRate {
  /** ISO `YYYY-MM`. */
  month: string;
  rate: number;
}

export const DEFAULT_DMIN = 0.07;
export const DEFAULT_MIN_MONTHS = 6;

/** Whole months between two `YYYY-MM` strings. */
function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/** q(t) for a fixed (qi, Di, b) with no terminal switch. */
function arpsRaw(qi: number, Di: number, b: number, t: number): number {
  if (b <= 1e-9) return qi * Math.exp(-Di * t);
  return qi / Math.pow(1 + b * Di * t, 1 / b);
}

// --- Outlier handling (robust stats) ---------------------------------------
// A single spike month (a cleanout, a catch-up gauge read, a data-entry error)
// must not (a) hijack peak detection and truncate the fit window, (b) skew the
// regression, or (c) bloat the confidence band. Three defenses, all here:
//   1. Hampel despike — replace isolated spikes with the local median.
//   2. Robust peak — pick the peak off a 90-DAY AVERAGE of the despiked series,
//      so a lone surge can never become t = 0.
//   3. Robust refit — after fitting, drop points beyond k·MAD of the log
//      residual and fit once more.
// MAD-based throughout (median absolute deviation), which a lone outlier can't
// move — unlike the mean/σ it would replace.

/** Scale factor making MAD a consistent σ estimate under normality. */
const MAD_TO_SIGMA = 1.4826;
/** Hampel despike window (months, centered). */
export const HAMPEL_WINDOW = 5;
/**
 * Despike threshold, in robust sigma. LOWER flags more months.
 *
 * 1 is aggressive: a month a full robust sigma off its neighbours is pulled
 * back to the local median before anything else runs. It was 0.5, which also
 * pulled the last months of a genuine decline back toward the months before
 * them (the window at the series end has no far side) and flattened a real
 * 16%/yr well to 11%; at 1 that well reads 11.5%. Above about 1.5 the peak
 * detector loses the recent peak on a well with a dip-and-recovery history and
 * fits decades at a fraction of a percent, so this cannot be raised alone.
 * Measured on real wells (`lease-vs-dashboard-decline.diag.test.ts`).
 *
 * It buys the tight `PEAK_SMOOTH_DAYS` below: with the series already flattened,
 * the peak can be read off single months without a lone reading hijacking it.
 * The two are tuned together — raising this without widening that puts the
 * hijacking straight back.
 */
export const HAMPEL_K = 1;
/**
 * How much history the peak is judged on, in DAYS.
 *
 * Thirty days is ONE point on a monthly series, so this averages nothing: the
 * peak is the highest month of the DESPIKED series. That is only safe because
 * `HAMPEL_K` above is aggressive enough to have already removed the months that
 * would otherwise win — the smoothing happens there instead of here, and it
 * keeps a genuinely sharp peak on the month it actually occurred rather than
 * pushing the start date past it.
 *
 * Widen this if declines come out too steep, but widen `HAMPEL_WINDOW` first: a
 * bump several months long is invisible to the despike at any sensitivity (see
 * the test of that name), and only a wider window or a wider peak average reaches
 * it.
 */
export const PEAK_SMOOTH_DAYS = 30;
const DAYS_PER_MONTH = 30;

/** A span in days as a count of monthly points, at least one. */
function monthsForDays(days: number): number {
  return Math.max(1, Math.round(days / DAYS_PER_MONTH));
}
/** Log-residual rejection threshold (σ) for the robust refit pass. */
export const RESID_K = 3;

/**
 * Daily outlier threshold for the production CHARTS, as a multiple of the
 * rolling median. A day above `k ×` the median of the days around it is not
 * drawn: on a 55 bbl/d lease that is the 177 bbl/d rebound after a bad gauge,
 * never a real day. A catch-up day after a missed gauge is 2 to 3× and stays.
 * Tuned beside `HAMPEL_K`, which does the same job on the MONTHLY series the
 * curve is fitted on; the harness in `lease-vs-dashboard-decline.diag.test.ts`
 * shows what each is doing on real wells.
 */
export const DAILY_OUTLIER_K = 5;
/** Days on each side a daily point is judged against (a month either way). */
export const DAILY_OUTLIER_HALF_WINDOW = 15;

/**
 * A daily series with its artifacts removed, for drawing: negative days are
 * dropped outright (a gauge that fell with no ticket is a missing haul, not
 * production), and a day more than {@link DAILY_OUTLIER_K} times the median
 * of the positive days within {@link DAILY_OUTLIER_HALF_WINDOW} of it is
 * dropped too. The median is of the OTHER days, so a spike cannot vouch for
 * itself, and a window with no positive days keeps the point: nothing to judge
 * it against is not evidence against it. Pure; order preserved.
 */
export function withoutDailyOutliers<T extends { value: number }>(
  points: readonly T[],
  k: number = DAILY_OUTLIER_K,
  half: number = DAILY_OUTLIER_HALF_WINDOW
): T[] {
  const kept = points.filter((p) => p.value >= 0);
  return kept.filter((p, i) => {
    if (p.value === 0) return true;
    const around: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(kept.length - 1, i + half); j++) {
      if (j !== i && kept[j].value > 0) around.push(kept[j].value);
    }
    if (around.length === 0) return true;
    return p.value <= k * median(around);
  });
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation about `center`. */
function mad(xs: number[], center: number): number {
  return median(xs.map((x) => Math.abs(x - center)));
}

/** Centered window `[i-half, i+half]`, clamped to the array bounds. */
function windowAround(xs: number[], i: number, half: number): number[] {
  return xs.slice(Math.max(0, i - half), Math.min(xs.length, i + half + 1));
}

/**
 * Per-index mean of the `win` points starting AT that index — forward-looking,
 * not centered.
 *
 * Forward, because the peak is being used to answer "which month did the well
 * start declining from", and that is a statement about what came next. A
 * centered window at the peak month still has the ramp-up behind it in the
 * average, which drags it below the month after and pushes the start date past a
 * genuinely sharp peak.
 *
 * The mean, not the median, because this is a rate over a period — what a
 * 90-day average means to an operator. It is the more spike-sensitive of the
 * two, which is why the despike pass runs before it rather than instead of it.
 *
 * The window clamps at the end, so the final months average over fewer points
 * rather than being dropped. That cannot pull the peak to the end of a declining
 * series, where the rates are lowest.
 */
function forwardMean(xs: number[], win: number): number[] {
  return xs.map((_, i) => {
    const w = xs.slice(i, Math.min(xs.length, i + win));
    return w.reduce((s, v) => s + v, 0) / w.length;
  });
}

/**
 * Hampel filter: replace each point that lies more than `k` robust-σ from its
 * window median with that median. The window median/MAD both ignore the point's
 * own excess (MAD is unmoved by a lone spike), so an isolated surge is flagged
 * and flattened while a genuine sustained level or smooth decline is left as-is.
 */
function despikeHampel(xs: number[], win: number, k: number): number[] {
  const half = Math.floor(win / 2);
  return xs.map((x, i) => {
    const w = windowAround(xs, i, half);
    const med = median(w);
    const sigma = MAD_TO_SIGMA * mad(w, med);
    return sigma > 0 && Math.abs(x - med) > k * sigma ? med : x;
  });
}

/**
 * Fit (qi, Di, b) to a monthly rate series already resampled to years `ts` (t=0
 * at the window start) and rates `qs`. For a fixed b the model linearizes —
 * q^(−b) = qi^(−b)·(1 + b·Di·t) is linear in t — so we sweep b over [0, 1], solve
 * qi/Di in closed form per b, and keep the b with the smallest residual in
 * LOG-rate space (so high early rates don't dominate). Null when nothing fits.
 */
function fitArpsSweep(
  ts: number[],
  qs: number[]
): { qi: number; Di: number; b: number } | null {
  const lnq = qs.map((q) => Math.log(q));

  // Linear least-squares of y on t → { a (intercept), m (slope) }.
  const linFit = (t: number[], y: number[]) => {
    const n = t.length;
    const tBar = t.reduce((s, v) => s + v, 0) / n;
    const yBar = y.reduce((s, v) => s + v, 0) / n;
    let sty = 0;
    let stt = 0;
    for (let i = 0; i < n; i++) {
      sty += (t[i] - tBar) * (y[i] - yBar);
      stt += (t[i] - tBar) ** 2;
    }
    if (stt === 0) return null;
    const m = sty / stt;
    return { a: yBar - m * tBar, m };
  };

  // Collect every valid (qi, Di, b) candidate with its log-space residual; the
  // best is the smallest residual. An array (not a mutated nullable) sidesteps
  // closure-narrowing and keeps the min selection explicit.
  const candidates: { qi: number; Di: number; b: number; err: number }[] = [];
  const consider = (qi: number, Di: number, b: number) => {
    if (!(qi > 0) || !Number.isFinite(Di) || Di <= 0) return;
    let err = 0;
    for (let i = 0; i < ts.length; i++) {
      const pred = arpsRaw(qi, Di, b, ts[i]);
      if (!(pred > 0)) return;
      err += (Math.log(pred) - lnq[i]) ** 2;
    }
    candidates.push({ qi, Di, b, err });
  };

  // b = 0: straight log-linear regression (exponential).
  const exp = linFit(ts, lnq);
  if (exp && exp.m < 0) consider(Math.exp(exp.a), -exp.m, 0);

  // b in (0, 1]: regress q^(−b) on t.
  for (let bi = 1; bi <= 20; bi++) {
    const b = bi / 20;
    const u = qs.map((q) => Math.pow(q, -b));
    const f = linFit(ts, u);
    if (!f || f.a <= 0 || f.m <= 0) continue; // must be increasing & positive
    const qi = Math.pow(f.a, -1 / b);
    const Di = f.m / (f.a * b);
    consider(qi, Di, b);
  }

  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, c) => (c.err < a.err ? c : a));
  return { qi: best.qi, Di: best.Di, b: best.b };
}

/**
 * Boolean keep-mask for a robust refit: keep points whose LOG residual against
 * the current fit is within `k` robust-σ of the median residual. All-true when
 * the residuals have no spread (nothing to reject).
 */
function robustKeepMask(
  ts: number[],
  qs: number[],
  fit: { qi: number; Di: number; b: number },
  k: number
): boolean[] {
  const resid = ts.map(
    (t, i) => Math.log(qs[i]) - Math.log(arpsRaw(fit.qi, fit.Di, fit.b, t))
  );
  const med = median(resid);
  const sigma = MAD_TO_SIGMA * mad(resid, med);
  if (!(sigma > 0)) return ts.map(() => true);
  return resid.map((r) => Math.abs(r - med) <= k * sigma);
}

/**
 * Fit a Modified Arps decline to a monthly rate series, with outlier handling so
 * a spike month can't distort the result (see the robust-stats block above):
 *
 *   1. Hampel DESPIKE the series (isolated surges → local median).
 *   2. Robust PEAK on a rolling-median smooth of the despiked series, so the fit
 *      window starts at the sustained peak (keeps ramp-up out) and a lone spike
 *      never becomes t = 0 nor truncates the window.
 *   3. Fit the b-sweep (`fitArpsSweep`), then a robust REFIT — drop any month
 *      beyond k·MAD of the log residual and fit once more.
 *
 * The raw series is only read for outlier detection; the CHART still plots the
 * true monthly points. Returns null when there isn't enough post-peak decline.
 */
export function fitDecline(
  series: MonthlyRate[],
  opts: FitOpts = {}
): DeclineFit | null {
  const dMin = opts.dMinAnnual ?? DEFAULT_DMIN;
  const minMonths = opts.minMonths ?? DEFAULT_MIN_MONTHS;
  const residK = opts.residK ?? RESID_K;
  const peakWindow = monthsForDays(opts.peakSmoothDays ?? PEAK_SMOOTH_DAYS);

  const clean = series
    .filter((s) => Number.isFinite(s.rate) && s.rate > 0)
    .sort((a, b) => (a.month < b.month ? -1 : 1));
  if (clean.length < minMonths) return null;

  // (1) Despike so a lone surge can't skew the fit OR hijack peak detection.
  const rates = clean.map((s) => s.rate);
  const despiked = opts.noDespike
    ? rates
    : despikeHampel(
        rates,
        opts.hampelWindow ?? HAMPEL_WINDOW,
        opts.hampelK ?? HAMPEL_K
      );

  // (2) The peak is the highest 90-DAY AVERAGE, not the highest month
  // (`PEAK_SMOOTH_DAYS`) — the window starts on a rate the well actually held
  // for a quarter, never on one month that happened to read high.
  const smooth = forwardMean(despiked, peakWindow);
  /*
   * Only months that leave enough data BEHIND them can be the peak.
   *
   * A global argmax lets a surge in the last quarter become the start of the
   * curve, and then there is no post-peak window left to fit — the company chart
   * drew a rate line and no curve at all for exactly this reason. A peak with
   * nothing after it is not the start of a decline; it is the end of the series.
   */
  const searchEnd = Math.max(1, smooth.length - minMonths);
  let peakIdx = 0;
  for (let i = 1; i < searchEnd; i++) {
    if (smooth[i] > smooth[peakIdx]) peakIdx = i;
  }
  const months = clean.slice(peakIdx).map((s) => s.month);
  if (months.length < minMonths) return null; // pre-peak / rising → no curve

  const t0 = months[0];
  const ts = months.map((m) => monthsBetween(t0, m) / 12);
  const qs = despiked.slice(peakIdx);

  // (3) Fit, then one robust refit pass dropping high-residual months. `spanYears`
  // stays the FULL post-peak window (the forward projection anchors at the last
  // observed month), even when an interior spike month is dropped from the fit.
  let params = fitArpsSweep(ts, qs);
  if (!params) return null;
  const keep = robustKeepMask(ts, qs, params, residK);
  const kept = keep.filter(Boolean).length;
  if (kept < ts.length && kept >= minMonths) {
    const refit = fitArpsSweep(
      ts.filter((_, i) => keep[i]),
      qs.filter((_, i) => keep[i])
    );
    if (refit) params = refit;
  }
  const { qi, Di, b } = params;

  // Terminal-exponential switch: t where D(t) = Di/(1 + b·Di·t) falls to dMin.
  let tSwitch = 0;
  if (b > 1e-9 && Di > dMin) {
    tSwitch = (Di / dMin - 1) / (b * Di);
  }

  return {
    qi,
    Di,
    b,
    tSwitch,
    dMin,
    months: months.length,
    spanYears: ts[ts.length - 1],
    startMonth: t0,
  };
}

/**
 * Sample the fitted curve at `t` years from the window start, honoring the
 * terminal-exponential switch: hyperbolic before `tSwitch`, then exponential at
 * the terminal decline `dMin` anchored to the rate at the switch.
 */
export function project(fit: DeclineFit, t: number): number {
  if (t < 0) t = 0;
  if (fit.b <= 1e-9 || fit.tSwitch <= 0 || t <= fit.tSwitch) {
    return arpsRaw(fit.qi, fit.Di, fit.b, t);
  }
  const qSwitch = arpsRaw(fit.qi, fit.Di, fit.b, fit.tSwitch);
  return qSwitch * Math.exp(-fit.dMin * (t - fit.tSwitch));
}

/**
 * The decline rate AT a point on the curve: the fraction the rate falls over the
 * following 12 months, `1 − project(t + 1) / project(t)`.
 *
 * Not a constant under a hyperbolic fit — that is the whole point of one. Early
 * life declines steeply and the curve flattens toward `dMin`, so "the decline
 * rate" is only meaningful with a month attached, which is why the chart's
 * tooltip reports it per month rather than once for the whole curve.
 */
export function declineAt(fit: DeclineFit, t: number): number {
  const now = project(fit, t);
  if (!(now > 0)) return 0;
  return 1 - project(fit, t + 1) / now;
}

/**
 * Projected decline over the NEXT 12 months from the current (window-end) rate.
 * Genuinely distinct from a trailing average under a hyperbolic fit; equal to
 * the constant rate under exponential.
 */
export function forward12moDecline(fit: DeclineFit): number {
  return declineAt(fit, fit.spanYears);
}

/**
 * Resample a well's production points to a post-peak-ready monthly RATE series
 * (month volume ÷ producing days), the same rollup the company summary uses.
 * Shut-in / zero days are naturally excluded by summing only positive production.
 */
export function monthlyRatesFromPoints(
  points: (Partial<ProductionPoint> & { date: string })[],
  stream: DeclineStream
): MonthlyRate[] {
  const byMonth = new Map<string, { vol: number; days: Set<string> }>();
  for (const p of points) {
    const rate = (stream === "oil" ? p.oilProduction : p.gasProduction) ?? 0;
    if (!(rate > 0)) continue;
    const m = p.date.slice(0, 7);
    const s = byMonth.get(m) ?? { vol: 0, days: new Set<string>() };
    s.vol += rate;
    s.days.add(p.date);
    byMonth.set(m, s);
  }
  return [...byMonth.entries()]
    .map(([month, s]) => ({ month, rate: s.days.size > 0 ? s.vol / s.days.size : 0 }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/**
 * The latest value of an EMA of a stream's daily rate, over the chart's points in
 * date order — the "current rate" headline that tracks the chart instead of the
 * stored well scalar. `span` is the EMA period in days (default 14), so
 * `alpha = 2 / (span + 1)` weights the most recent day most. Shut-in (zero) days
 * are kept so downtime pulls the rate down, matching what the chart plots.
 * Returns 0 when there are no points. Pure.
 */
export function latestDailyEma(
  points: Pick<ProductionPoint, "date" | "oilProduction" | "gasProduction">[],
  stream: DeclineStream,
  span = 14
): number {
  const rates = points
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((p) => (stream === "oil" ? p.oilProduction : p.gasProduction))
    .filter((r) => Number.isFinite(r));
  if (rates.length === 0) return 0;
  const alpha = 2 / (span + 1);
  let ema = rates[0];
  for (let i = 1; i < rates.length; i++) {
    ema = alpha * rates[i] + (1 - alpha) * ema;
  }
  return ema;
}

/**
 * {@link latestDailyEma}, evaluated at `asOf` instead of at whatever day the
 * stream happens to stop.
 *
 * THIS is what a "current rate" column wants. `latestDailyEma` answers "what was
 * it making when it was last reported", which for a well whose oil stopped in
 * 2002 while its gas kept filing is a two-decade-old number printed as today's.
 * Every day between the stream's last point and `asOf` is folded in as a day of
 * no production — see {@link emaAsOf} for why that is the honest reading of a
 * missing day, and for what `asOf` has to be.
 *
 * Each stream carries its OWN last date: on one well the oil series can end
 * decades before the gas series, and pinning both to the later one is the whole
 * point.
 */
export function currentDailyEma(
  points: Pick<ProductionPoint, "date" | "oilProduction" | "gasProduction">[],
  stream: DeclineStream,
  asOf: string | null,
  span = 14
): number {
  const ema = latestDailyEma(points, stream, span);
  if (ema === 0) return 0;
  let last: string | null = null;
  for (const p of points) {
    const rate = stream === "oil" ? p.oilProduction : p.gasProduction;
    if (!Number.isFinite(rate)) continue;
    if (last === null || p.date > last) last = p.date;
  }
  return emaAsOf(ema, last, asOf, span) ?? ema;
}
