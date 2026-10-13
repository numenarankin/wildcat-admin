/**
 * How the price an operator actually receives relates to the futures benchmark.
 *
 * The old model was one number: `mean(realized ÷ benchmark)` over recent months.
 * That conflates three different things and can only see one commodity at a
 * time. This fits them separately, per commodity:
 *
 *     realized = betaSelf x benchmarkSelf + betaCross x benchmarkCross + alpha
 *
 *   - `betaSelf`  the proportional share of its own index the operator keeps
 *                 (basis, marketing fee, and for gas the MMBtu -> MCF heat
 *                 content, all rolled together).
 *   - `betaCross` how much the OTHER commodity's index moves this one. Rich
 *                 casinghead gas carries condensate and NGLs that settle off
 *                 crude, so a gas stream can track WTI as well as Henry Hub.
 *                 Fitted freely and NOT sign-constrained: if the data says the
 *                 relationship is negative, that is what it reports.
 *   - `alpha`     the fixed per-unit deduct (gathering, compression, treating)
 *                 that does not scale with the index at all.
 *
 * ## Why this still works on one month of history
 *
 * Ordinary least squares needs more months than coefficients and would be
 * singular for a new operator. This is a ridge fit against a conjugate Normal
 * prior centred on the OLD model - `betaSelf = fallback, betaCross = 0` - so
 * with no revenue history at all it returns exactly the legacy answer, and with
 * one month it moves only as far as that one month can support. There is no
 * minimum sample size and no "enough data yet" branch; the prior simply stops
 * mattering as months accumulate.
 *
 * The regressors are centred on their weighted means before fitting, and each
 * coefficient is then identified by how much its index actually MOVED across
 * the window. A single month is its own mean, so both slopes stay exactly at
 * their priors and the whole answer lands in the level: one month of statements
 * says what the operator was paid, not how that payment responds to the index.
 * Both slopes come alive only once the benchmarks have moved underneath them.
 * When two indexes move together the fit cannot tell them apart, and reports a
 * blend of the two rather than pretending to separate them.
 *
 * Every prior width and the noise scale are expressed as FRACTIONS of the mean
 * benchmark over the fitted months, so the fit behaves identically on $70 oil
 * and $3 gas and needs no per-commodity tuning.
 */

/** One production month, with both benchmarks and the volume that backs it. */
export interface RealizationObservation {
  /** Production month, "YYYY-MM". */
  month: string;
  /** Realized price the operator received that month, USD per unit. */
  realized: number;
  /** Average benchmark for THIS commodity that month, USD per unit. */
  self: number;
  /** Average benchmark for the OTHER commodity that month, USD per unit. */
  cross: number;
  /** Units sold that month. Weights the fit; <= 0 falls back to equal weight. */
  volume: number;
}

/** A fitted (or purely prior) realization relationship for one commodity. */
export interface RealizationModel {
  /** Coefficient on this commodity's own benchmark. */
  betaSelf: number;
  /** Coefficient on the other commodity's benchmark. Signed; may be negative. */
  betaCross: number;
  /** Fixed per-unit offset, USD. Signed; a deduct is negative. */
  alpha: number;
  /** How many months went into the fit. */
  months: number;
  /** False when nothing was fitted and this is the untouched prior. */
  measured: boolean;
  /** Mean self-benchmark across the fitted months; the scale the priors used. */
  scale: number;
}

/** Months of history the fit will look at. Recency decay does the rest. */
export const FIT_LOOKBACK_MONTHS = 12;

/**
 * Half-life of the recency weighting, in months. Six months puts the centre of
 * mass of a full window near where the old fixed six-month cutoff sat, while
 * still letting older months contribute the benchmark VARIATION the cross term
 * needs to be identifiable at all.
 */
export const RECENCY_HALF_LIFE_MONTHS = 6;

/**
 * Prior standard deviation on `betaSelf`, dimensionless. It only bites once the
 * benchmark has actually MOVED across the fitted months: the regressor is
 * centred, so a flat quarter leaves the slope at its prior and lets the level
 * carry the whole answer.
 */
export const PRIOR_SELF_SD = 0.5;

/**
 * Prior width on the cross term, as the fraction of this commodity's price that
 * ONE STANDARD DEVIATION of movement in the other index is allowed to be worth.
 *
 * Scaling by the other index's spread rather than its level is the difference
 * between a usable cross term and a dead one. WTI sits near $72 but only ranges
 * about $10 around that, so a prior pegged to the $72 level pins the coefficient
 * so hard that a real condensate relationship never registers, and the fixed
 * deduct gets misattributed to it besides.
 */
export const PRIOR_CROSS_FRAC = 0.15;

/**
 * Prior width on the average realized price, as a fraction of the mean
 * benchmark. Centred on "the operator receives the benchmark". Loose enough
 * that a single month of statements moves it most of the way, which is what
 * makes the one-month case behave like the factor it replaces.
 */
export const PRIOR_LEVEL_FRAC = 0.35;

/**
 * Assumed month-to-month unexplained variation in the realized price, as a
 * fraction of the mean benchmark. This is what sets how fast the data overrules
 * the prior: smaller means the fit trusts each month more.
 */
export const NOISE_FRAC = 0.12;

/** Months since the epoch, for differencing two "YYYY-MM" strings. */
function monthIndex(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return y * 12 + (m - 1);
}

/**
 * Solve a 3x3 system by Gaussian elimination with partial pivoting. Returns
 * null when the matrix is singular, which the ridge term makes impossible in
 * practice (the prior precision is strictly positive on every diagonal).
 */
export function solve3(
  a: number[][],
  b: number[]
): [number, number, number] | null {
  const m = [
    [a[0][0], a[0][1], a[0][2], b[0]],
    [a[1][0], a[1][1], a[1][2], b[1]],
    [a[2][0], a[2][1], a[2][2], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const swap = m[col];
      m[col] = m[pivot];
      m[pivot] = swap;
    }
    for (let row = col + 1; row < 3; row++) {
      const f = m[row][col] / m[col][col];
      if (f === 0) continue;
      for (let k = col; k < 4; k++) m[row][k] -= f * m[col][k];
    }
  }
  const x: number[] = [0, 0, 0];
  for (let row = 2; row >= 0; row--) {
    let sum = m[row][3];
    for (let k = row + 1; k < 3; k++) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }
  return [x[0], x[1], x[2]];
}

/** The model an operator with no revenue history gets: the benchmark, as-is. */
export function priorModel(fallbackSelf: number): RealizationModel {
  return {
    betaSelf: fallbackSelf,
    betaCross: 0,
    alpha: 0,
    months: 0,
    measured: false,
    scale: 0,
  };
}

/** How the fit is anchored when the data cannot speak for itself. */
export interface FitOptions {
  /**
   * Leave the LEVEL unanchored: the fitted average realized price becomes the
   * volume-weighted average of the observations, with nothing pulling it toward
   * the prior.
   *
   * This is what a per-lease fit wants. A lease that settled at $7.30/mcf IS
   * worth $7.30 - that figure is not an estimate in need of regularization, it
   * is what the operator was paid, reconciled to the statement header. Shrinking
   * it toward a company average would hand back exactly the error per-lease
   * pricing exists to remove.
   *
   * The slopes stay anchored either way, because a single observation carries no
   * slope information for any amount of belief to extract.
   */
  freeLevel?: boolean;
}

/**
 * Fit the realization relationship for one commodity.
 *
 * `prior` supplies the coefficients the data cannot determine on its own, and is
 * the whole answer when there is nothing to fit at all. `priorModel(1)` assumes
 * the operator receives the benchmark until its own statements say otherwise.
 *
 * Observations missing either benchmark, or with a non-positive self benchmark,
 * are dropped: they carry no information about a ratio to that index.
 */
export function fitRealization(
  observations: RealizationObservation[],
  prior: RealizationModel,
  opts: FitOptions = {}
): RealizationModel {
  const fallbackSelf = prior.betaSelf;
  const usable = observations.filter(
    (o) =>
      Number.isFinite(o.realized) &&
      Number.isFinite(o.self) &&
      Number.isFinite(o.cross) &&
      o.self > 0 &&
      o.realized > 0
  );
  if (usable.length === 0) return prior;

  // Newest months first, then bound the window. Decay handles the weighting;
  // this only bounds the work.
  const sorted = [...usable].sort((a, b) => (a.month < b.month ? 1 : -1));
  const fitted = sorted.slice(0, FIT_LOOKBACK_MONTHS);
  const newest = monthIndex(fitted[0].month);

  // Volume x recency. A month with no recorded volume still carries its ratio,
  // so it weights as one unit rather than dropping out; when NO month has a
  // volume the whole set falls back to equal weight, which is the old model's
  // volume-agnostic mean.
  const anyVolume = fitted.some((o) => o.volume > 0);
  const raw = fitted.map((o) => {
    const vol = anyVolume ? (o.volume > 0 ? o.volume : 0) : 1;
    const age = newest - monthIndex(o.month);
    return vol * Math.pow(0.5, age / RECENCY_HALF_LIFE_MONTHS);
  });
  const rawTotal = raw.reduce((s, w) => s + w, 0);
  if (rawTotal <= 0) return prior;
  // Normalize so the weights sum to the month COUNT: the data term then grows
  // with how many months there are, not with how many barrels, which is what
  // decides how far the fit is allowed to move off the prior.
  const weights = raw.map((w) => (w * fitted.length) / rawTotal);

  // Weighted means. The regressors are CENTRED on these before fitting, which
  // is what keeps the three coefficients from stealing each other's work: an
  // uncentred WTI column is a $72 constant with a $10 wiggle on top, nearly
  // collinear with the intercept, so a fixed gathering deduct and a condensate
  // effect become indistinguishable and both come out wrong.
  const wTotal = weights.reduce((s, w) => s + w, 0);
  const selfMean =
    fitted.reduce((s, o, i) => s + weights[i] * o.self, 0) / wTotal;
  const crossMean =
    fitted.reduce((s, o, i) => s + weights[i] * o.cross, 0) / wTotal;
  const crossSpread = Math.sqrt(
    fitted.reduce(
      (s, o, i) => s + weights[i] * (o.cross - crossMean) ** 2,
      0
    ) / wTotal
  );

  const scale = selfMean;
  const sigma = NOISE_FRAC * scale;
  const sdSelf = PRIOR_SELF_SD;
  /*
   * A cross index that never moved carries no information about a cross effect,
   * and centring zeroes that column, so the coefficient should simply return its
   * prior mean.
   *
   * The width must be CAPPED for that to happen. A benchmark that is flat in
   * exact arithmetic is flat to about 1e-14 in floating point, which divides
   * into a prior standard deviation of ~1e13, a prior precision of ~0, and a
   * singular normal-equation matrix. The fit then fails and silently returns the
   * prior for EVERY coefficient, discarding a perfectly good self relationship
   * along with the absent cross one. Capping at the self width keeps the exact
   * and near-zero cases continuous.
   */
  const sdCross =
    crossSpread > 0
      ? Math.min((PRIOR_CROSS_FRAC * scale) / crossSpread, PRIOR_SELF_SD)
      : PRIOR_SELF_SD;
  const sdLevel = PRIOR_LEVEL_FRAC * scale;

  const priorPrecision = [
    1 / (sdSelf * sdSelf),
    1 / (sdCross * sdCross),
    // Zero precision, not a very wide prior: an unanchored level has no residual
    // pull at all, so the fitted price is the observations' own average exactly.
    opts.freeLevel ? 0 : 1 / (sdLevel * sdLevel),
  ];
  // The level's prior mean is what the prior implies about the AVERAGE realized
  // price, restated at this window's benchmark level. Unused when freeLevel is
  // set, since its precision is zero.
  const priorMean = [
    fallbackSelf,
    prior.betaCross,
    fallbackSelf * selfMean + prior.betaCross * crossMean + prior.alpha,
  ];

  // A = X'WX / sigma^2 + P0 ;  b = X'Wy / sigma^2 + P0 * b0, on centred columns.
  const inv = 1 / (sigma * sigma);
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhs = [0, 0, 0];
  fitted.forEach((o, i) => {
    const x = [o.self - selfMean, o.cross - crossMean, 1];
    const w = weights[i] * inv;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) A[r][c] += w * x[r] * x[c];
      rhs[r] += w * x[r] * o.realized;
    }
  });
  for (let r = 0; r < 3; r++) {
    A[r][r] += priorPrecision[r];
    rhs[r] += priorPrecision[r] * priorMean[r];
  }

  const beta = solve3(A, rhs);
  if (!beta) return prior;

  // beta[2] is the fitted average realized price at the window's mean
  // benchmarks. Restate it as a raw intercept so callers keep a plain
  // `betaSelf x self + betaCross x cross + alpha` form.
  return {
    betaSelf: beta[0],
    betaCross: beta[1],
    alpha: beta[2] - beta[0] * selfMean - beta[1] * crossMean,
    months: fitted.length,
    measured: true,
    scale,
  };
}

/**
 * The realized price this model implies at a given pair of benchmark levels.
 *
 * Floored at zero. The coefficients themselves are never constrained - a
 * negative cross term is a legitimate finding - but a negative PRICE is not a
 * number any surface should show, and an unbounded extrapolation reaching one
 * would silently turn revenue estimates negative.
 */
export function predictRealized(
  model: RealizationModel,
  self: number,
  cross: number
): number {
  const value =
    model.betaSelf * self + model.betaCross * cross + model.alpha;
  return value > 0 ? value : 0;
}

/**
 * The model expressed the old way: realized divided by its own benchmark, at
 * one pair of benchmark levels. Retained for display and for the surfaces that
 * still show a single "x0.87 of WTI" figure. It is a READ-OUT of the model at a
 * point, not the model itself, so it moves with the benchmark - which is the
 * whole reason the fixed factor was wrong.
 */
export function effectiveFactor(
  model: RealizationModel,
  self: number,
  cross: number
): number {
  if (!(self > 0)) return model.betaSelf;
  return predictRealized(model, self, cross) / self;
}

/** A settled month as the fit needs it, structurally (see `posted-prices`). */
export interface SettledMonth {
  month: string;
  price: number;
  volume: number;
}

/**
 * Pair each settled month with both benchmarks for that same month.
 *
 * A month the benchmark feed does not reach is dropped rather than back-filled.
 * The RRC history on the lease pages runs back decades before these futures
 * contracts began, and anchoring a realization on an invented benchmark would
 * corrupt the fit for every month after it.
 */
export function observationsFrom(
  months: SettledMonth[],
  selfBenchmark: Map<string, number>,
  crossBenchmark: Map<string, number>
): RealizationObservation[] {
  const out: RealizationObservation[] = [];
  for (const m of months) {
    const self = selfBenchmark.get(m.month);
    const cross = crossBenchmark.get(m.month);
    if (self == null || cross == null) continue;
    out.push({
      month: m.month,
      realized: m.price,
      self,
      cross,
      volume: m.volume,
    });
  }
  return out;
}
