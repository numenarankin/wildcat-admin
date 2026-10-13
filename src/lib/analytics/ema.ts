/**
 * Trailing exponential moving average of a daily-rate series.
 *
 * Uses the SAME recurrence as the production chart's `emaStep`
 * (`src/components/wells/production-chart.tsx`): the EMA has no value until
 * `period` points have been seen, at which point it is seeded with the simple
 * average of those first `period` values, then updated as
 * `v·k + prev·(1−k)` with `k = 2/(period+1)`. So `latestEma(values, 14)` equals
 * the final point of the chart's 14-day EMA line over the same series.
 *
 * `values` must be in chronological (oldest-first) order, one per producing day.
 * Returns null when there are fewer than `period` points (not enough history to
 * seed the average).
 */
export function latestEma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  let seen = 0;
  let seed = 0;
  let value: number | null = null;
  for (const v of values) {
    seen += 1;
    if (seen < period) seed += v;
    else if (seen === period) {
      seed += v;
      value = seed / period;
    } else {
      value = v * k + (value as number) * (1 - k);
    }
  }
  return value;
}

/** One day of one stream: an ISO `YYYY-MM-DD` date and that day's rate. */
export interface DatedRate {
  date: string;
  rate: number;
}

/**
 * The latest ISO date across several streams' dates, or null when they are all
 * empty. The companion to {@link emaAsOf}: this is where a series LEFT OFF, that
 * is where it has to be read AS OF.
 */
export function latestDate(
  ...streams: (readonly string[] | null | undefined)[]
): string | null {
  let latest: string | null = null;
  for (const dates of streams) {
    for (const d of dates ?? []) {
      if (latest === null || d > latest) latest = d;
    }
  }
  return latest;
}

/** Whole days from `from` to `to`, both ISO `YYYY-MM-DD`. Negative if `to` is earlier. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * An EMA carried forward from the last day it has data for to `asOf`, counting
 * every day in between as a day of NO PRODUCTION.
 *
 * A CURRENT rate is a claim about today, and a series that stops answers a
 * different question: what the well was making the last time anything was
 * reported. Folded as-is, a gas well that filed two months of condensate in 2002
 * and nothing since reports 0.6 bbl/d of oil forever — its own last value, two
 * decades stale, sitting in the Oil column beside wells that produced this
 * month. The state's record does not go quiet when a well stops; a well that
 * produces nothing files a zero or is simply absent from the month, and either
 * way the answer to "what is it making" is nothing.
 *
 * So the missing days are folded in at zero. That is the same recurrence
 * {@link latestEma} runs, done in closed form because the gap can be 8,000 days:
 * n zero days multiply the average by `(1−k)^n`. At period 14 that halves it
 * about every five days, so a month of silence is already a rounding error and a
 * decade is exactly zero.
 *
 * `asOf` is the HORIZON OF KNOWLEDGE, not today. For the public record that is
 * the newest month the state has collected (`rrcProductionHorizon`) — Texas runs
 * two to three months behind, and reading those uncollected months as zero would
 * zero out every producing well in the fleet. For the operator's own gauges it is
 * their last reading: a day nobody gauged the tank is a day nobody measured, not
 * a day the well made nothing.
 */
export function emaAsOf(
  ema: number | null,
  lastDate: string | null,
  asOf: string | null,
  period: number
): number | null {
  if (ema == null || lastDate == null || asOf == null) return ema;
  const gap = daysBetween(lastDate, asOf);
  if (gap <= 0) return ema;
  const decayed = ema * Math.pow(1 - 2 / (period + 1), gap);
  // Denormals draw a chart axis in 2e-323 and print as "0.0" anyway.
  return Math.abs(decayed) < 1e-6 ? 0 : decayed;
}

/**
 * Each stream on ITS OWN dates, ready for {@link latestEma}.
 *
 * The previous rule here put every stream on one shared calendar and read a
 * stream's missing day as a zero, on the theory that a stream which falls to
 * nothing stops having rows. That theory is false for how this app measures: a
 * gas meter's series is resampled across its whole reading span
 * (`meterDailySeries`), so a meter that is read and shows nothing produces
 * explicit zeros, and an ABSENT day means nobody read the meter. With tanks
 * gauged daily and meters read monthly, the shared calendar fed up to a month of
 * fabricated zeros into a 14-day EMA and the lease's gas rate decayed toward
 * nothing while its meter was working fine. The per-well rates
 * (`@/lib/wells/rate-cache`) already refused that trade; this is the same rule.
 *
 * What the shared calendar was protecting against is real and is handled
 * elsewhere: a stream that genuinely stopped is carried to the record's horizon
 * by {@link emaAsOf}, which decays it. The state's silence is evidence; the
 * pumper's is not.
 *
 * Within one stream, LATER entries win a duplicate date. Pass the estimated
 * history first and the measured series second, so a measurement always beats an
 * estimate for the same day.
 */
export function ownDateSeries(
  streams: Record<string, DatedRate[]>
): Record<string, { values: number[]; lastDate: string | null }> {
  const out: Record<string, { values: number[]; lastDate: string | null }> = {};
  for (const [name, points] of Object.entries(streams)) {
    const byDate = new Map<string, number>();
    for (const p of points) byDate.set(p.date, p.rate);
    const dates = [...byDate.keys()].sort();
    out[name] = {
      values: dates.map((d) => byDate.get(d)!),
      lastDate: dates[dates.length - 1] ?? null,
    };
  }
  return out;
}

/**
 * The date a stream's rate is read AS OF: the later of its own last day and the
 * public record's horizon.
 *
 * A lease that stopped filing in 2010 has a series ending in 2010, and reading
 * its rate as of its own last day is what let a dead lease keep reporting the
 * rate it died at; carrying it to the horizon folds in the years of nothing
 * since ({@link emaAsOf}).
 *
 * A MEASURED stream is never carried past its own last reading: the horizon is
 * months behind the gauge, so the stream's own end wins and nothing decays. A
 * day nobody gauged the tank is a day nobody measured, not a day the lease made
 * nothing — the state's silence is evidence, the pumper's is not. Per stream
 * rather than per lease, because a lease can be gauged daily for oil while its
 * gas comes only from filings.
 */
export function streamAsOf(
  lastDate: string | null,
  recordHorizon: string | null
): string | null {
  return lastDate !== null && recordHorizon !== null && lastDate > recordHorizon
    ? lastDate
    : (recordHorizon ?? lastDate);
}

/**
 * A stream's CURRENT rate: its trailing EMA, carried to {@link streamAsOf}.
 *
 * `fallback` is the stream's last single value, for a series too short to seed
 * the EMA — carried the same way, so a lease with one filing in 2010 still reads
 * as nothing today. Zero when there is nothing at all.
 */
export function currentStreamRate(
  stream: { values: number[]; lastDate: string | null },
  fallback: number | null,
  recordHorizon: string | null,
  period: number
): number {
  const asOf = streamAsOf(stream.lastDate, recordHorizon);
  return (
    emaAsOf(latestEma(stream.values, period), stream.lastDate, asOf, period) ??
    emaAsOf(fallback, stream.lastDate, asOf, period) ??
    0
  );
}
