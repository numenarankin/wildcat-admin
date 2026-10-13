import { DAY_MS, anchorMs, type DailyPoint } from "@/lib/tanks/tank-series";

/**
 * Gas meter readings to a daily MCF/d series: the RATE the meter ran at on each
 * calendar day, not the volume that happened to be metered inside that day.
 *
 * A gas reading carries three INDEPENDENT numbers, the three an EFM display
 * shows, and this module is the only place that decides which one a given day is
 * built from:
 *
 *  - `yesterdayMcf` is the volume the meter reports for the calendar day BEFORE
 *    the reading, midnight to midnight.
 *  - `mcf` is the CURRENT FLOW RATE, which is the rate for the reading's own day.
 *  - `cumulativeMcf` is the counter on the meter itself.
 *
 * None is ever derived from another.
 *
 * ## The order of preference
 *
 * `yesterdayMcf` WINS its day outright. It is a whole calendar day measured by
 * the meter, where a counter span is a measured volume spread across days by a
 * shape the pumper estimated, and a flow rate is not a volume at all. So a day
 * with a yesterday-volume takes that and nothing else: no counter span and no
 * spot rate contributes to it, and the hours it occupies are removed from both
 * before either is distributed.
 *
 * The counter fills in what is left. The difference between two counter readings
 * is a MEASURED volume, so distributing it across the unclaimed days between them
 * moves real gas around rather than inventing it. A counter span that also covers
 * yesterday-volume days has those days' share taken OUT of its delta first, so
 * the same gas is never counted twice and the span's own measurement is still
 * conserved across everything it is left holding.
 *
 * Flow rate is the fallback, and the only thing that speaks for a day nobody has
 * measured. It holds forward, which is why a rate-only gap holds its last value
 * instead of ramping.
 *
 * ## Two independent spans, not one
 *
 * A COUNTER SPAN runs between consecutive readings that CARRY a counter. Spot
 * readings taken inside one do not break it: a pumper who records the counter on
 * Monday and Friday and only spot in between still has one measured volume
 * covering the whole week, and that is the whole point of recording it.
 *
 * Days a counter span covers are built from it. Everything else falls back to
 * spot, held from the last reading that reported one.
 *
 * ## Hours inside, rates outside
 *
 * Readings are never taken at midnight, so a span covers a partial day at each
 * end and, while the gas is being distributed, every day takes only its own
 * overlapping hours. That is the same 24 hour normalization the oil tank engine
 * does (`dailyProduction` in `@/lib/tanks/tank-series`), and it is what keeps a
 * counter's volume from being counted twice across a reading taken mid-day.
 *
 * What comes OUT is a rate. A day the coverage only half reaches is reported at
 * the rate it ran, not at half a day's gas dressed as a whole one: a meter read
 * at 07:00 today at 400 MCF/d charts today at 400, the number the pumper wrote
 * down, where the raw seven-hour slice would chart 117 and read like the well
 * died overnight. Whole days are unchanged by this, so a month of whole days
 * still sums to the volume the counter measured; only the partial day at each
 * end of the coverage is a rate rather than a slice.
 *
 * ## Shape and scale
 *
 * Across a counter span the counter fixes the TOTAL and the spot values fix the
 * SHAPE:
 *
 *     v_d = s_d x h_d / 24     provisional volume implied by spot
 *     V   = sum of v_d          what spot claims the span made
 *     k   = deltaMcf / V        the correction factor
 *     day d receives k x v_d
 *
 * The pumper's relative day-to-day picture survives and the total is the
 * physical measurement, so the small estimation errors in daily spot reporting
 * are absorbed continuously instead of surfacing at monthly settlement. With
 * uniform spot values, or none at all, every `v_d` is proportional to `h_d` and
 * this reduces to a flat hour-weighted spread, which is the right answer for
 * counter-only data and falls out of the same formula rather than a branch.
 *
 * ## What this deliberately does NOT do
 *
 * It does not sanity-check the operator. A counter typed in wrong produces wrong
 * production, with no plausibility band on `k` and no refusal to reconcile. The
 * only guard is against dividing by zero.
 */

const HOUR_MS = 3_600_000;

/** One reading as the series needs it. All three numbers are independently optional. */
export interface GasReading {
  date: string;
  /** `HH:MM`, or "" when none was recorded (treated as midnight). */
  time?: string;
  /** The current flow rate off the meter, for this reading's own day, or null. */
  mcf: number | null;
  /** The meter's cumulative counter at this reading, or null if not recorded. */
  cumulativeMcf: number | null;
  /**
   * The volume the meter reports for the calendar day BEFORE `date`, midnight to
   * midnight, or null if not recorded. Definitive for that day.
   */
  yesterdayMcf?: number | null;
}

/** The span between two consecutive readings that both carry a counter. */
export interface CounterSpan {
  fromMs: number;
  toMs: number;
  hours: number;
  /** Measured volume over the span, or null when the counter went backwards. */
  deltaMcf: number | null;
  /** The counter dropped: a reset or a meter swap. The span measures nothing. */
  isReset: boolean;
}

/** The span between two consecutive readings of any kind. */
export interface GasSegment {
  fromMs: number;
  toMs: number;
  hours: number;
  /** The spot rate in force at the segment's open, or null if none was entered. */
  openSpot: number | null;
}

interface Stamped extends GasReading {
  ms: number;
}

/** Days since the epoch, floored to midnight UTC. */
function dayStartMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** ISO `YYYY-MM-DD` for an epoch ms. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function stamp(readings: GasReading[]): Stamped[] {
  return readings
    .map((r) => ({ ...r, ms: anchorMs(r.date, r.time ?? "") }))
    .sort((a, b) => a.ms - b.ms);
}

/**
 * Counter spans, oldest first, between each pair of consecutive readings that
 * carry a counter. Readings without one are skipped over rather than breaking
 * the span.
 *
 * A backwards counter is a reset or a meter swap. That span measures nothing and
 * is handed to the spot path instead; the NEXT span measures forward from the
 * reset reading, which happens for free because it is that span's open.
 */
export function buildCounterSpans(readings: GasReading[]): CounterSpan[] {
  const withCounter = stamp(readings).filter((r) => r.cumulativeMcf != null);

  const out: CounterSpan[] = [];
  for (let i = 1; i < withCounter.length; i++) {
    const from = withCounter[i - 1];
    const to = withCounter[i];
    const d = (to.cumulativeMcf as number) - (from.cumulativeMcf as number);
    const isReset = d < 0;
    out.push({
      fromMs: from.ms,
      toMs: to.ms,
      hours: (to.ms - from.ms) / HOUR_MS,
      deltaMcf: isReset ? null : d,
      isReset,
    });
  }
  return out;
}

/** Segments between each pair of consecutive readings, whatever they carry. */
export function buildGasSegments(readings: GasReading[]): GasSegment[] {
  const sorted = stamp(readings);
  const out: GasSegment[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1];
    const to = sorted[i];
    out.push({
      fromMs: from.ms,
      toMs: to.ms,
      hours: (to.ms - from.ms) / HOUR_MS,
      openSpot: from.mcf,
    });
  }
  return out;
}

/**
 * The volume a gas meter measured over an arbitrary window, MCF, or null when
 * its counter does not bracket the window.
 *
 * The counter is what measures a well test. A shut-in campaign compares a
 * baseline rate against a rate with one well off, and both are read off the
 * meter over a window the pumper timed, so the number wanted here is the same
 * one `buildCounterSpans` already derives between two counter readings, prorated
 * to the part of each span the window covers.
 *
 * Null, not zero, when the counter spans do not reach either side of the window:
 * an unmeasured window would otherwise read as a meter that made nothing, which
 * on a baseline is a divide-by-zero and on a shut-in is a well credited with the
 * whole meter. Callers fall back to the rate the pumper typed.
 *
 * A RESET span measures nothing and is skipped, so a window containing a meter
 * swap reports only the part of itself that was actually counted, and is treated
 * as uncovered when the reset lands at either edge.
 */
export function gasWindowVolume(
  readings: GasReading[],
  fromMs: number,
  toMs: number
): number | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return null;
  }
  const spans = buildCounterSpans(readings).filter(
    (s) => !s.isReset && s.deltaMcf != null && s.hours > 0
  );
  if (spans.length === 0) return null;

  const first = Math.min(...spans.map((s) => s.fromMs));
  const last = Math.max(...spans.map((s) => s.toMs));
  if (first > fromMs || last < toMs) return null;

  let mcf = 0;
  for (const s of spans) {
    const overlapMs = Math.min(s.toMs, toMs) - Math.max(s.fromMs, fromMs);
    if (overlapMs <= 0) continue;
    mcf += (overlapMs / (s.hours * HOUR_MS)) * (s.deltaMcf as number);
  }
  return mcf;
}

/**
 * The hours of `[fromMs, toMs)` that land in each calendar day it touches, as
 * `dayStartMs -> hours`. A span opening at 07:00 and closing at 07:00 four days
 * later gives its first day 17 hours, its last 7, and the three between 24.
 */
function hoursByDay(fromMs: number, toMs: number): Map<number, number> {
  const out = new Map<number, number>();
  if (!(toMs > fromMs)) return out;
  for (let dayMs = dayStartMs(fromMs); dayMs < toMs; dayMs += DAY_MS) {
    const overlap = Math.min(toMs, dayMs + DAY_MS) - Math.max(fromMs, dayMs);
    if (overlap > 0) out.set(dayMs, overlap / HOUR_MS);
  }
  return out;
}

/**
 * The spot rate in force on each calendar day the readings span, as
 * `dayStartMs -> MCF/day`.
 *
 * A spot value belongs to the DATE it was entered on, because that is what the
 * pumper is reporting: the rate for that day. A date with no spot reading of its
 * own holds the last one entered, which is the same rule the series itself
 * follows for an unwatched day. Dates before the first spot reading are absent:
 * there is nothing behind them to hold, and reaching backwards would be
 * inventing the shape rather than inheriting it.
 */
function spotByDay(readings: GasReading[]): Map<number, number> {
  // Average same-date spot entries, the way a duplicate reading has always been
  // treated: two numbers for one day are two attempts at one quantity.
  const totals = new Map<number, { sum: number; n: number }>();
  for (const r of readings) {
    if (r.mcf == null) continue;
    const key = dayStartMs(anchorMs(r.date, ""));
    const cur = totals.get(key) ?? { sum: 0, n: 0 };
    cur.sum += r.mcf;
    cur.n += 1;
    totals.set(key, cur);
  }
  if (totals.size === 0) return new Map();

  const sorted = stamp(readings);
  const firstDay = dayStartMs(sorted[0].ms);
  const lastDay = dayStartMs(sorted[sorted.length - 1].ms);

  const out = new Map<number, number>();
  let held: number | null = null;
  for (let dayMs = firstDay; dayMs <= lastDay; dayMs += DAY_MS) {
    const own = totals.get(dayMs);
    if (own) held = own.sum / own.n;
    if (held != null) out.set(dayMs, held);
  }
  return out;
}

/**
 * The days a reading MEASURED outright, as `dayStartMs -> MCF`.
 *
 * A reading dated the 5th carrying a yesterday-volume measured the 4th. Two
 * readings claiming the same day are averaged, the same way two spot entries on
 * one date are: they are two attempts at one quantity, not two days of gas.
 */
export function measuredDays(readings: GasReading[]): Map<number, number> {
  const totals = new Map<number, { sum: number; n: number }>();
  for (const r of readings) {
    if (r.yesterdayMcf == null) continue;
    // The day BEFORE the reading's date. Dates, not timestamps: the meter's
    // figure is a calendar day, midnight to midnight, whatever hour it was read.
    const key = dayStartMs(anchorMs(r.date, "")) - DAY_MS;
    const cur = totals.get(key) ?? { sum: 0, n: 0 };
    cur.sum += r.yesterdayMcf;
    cur.n += 1;
    totals.set(key, cur);
  }
  const out = new Map<number, number>();
  for (const [dayMs, { sum, n }] of totals) out.set(dayMs, sum / n);
  return out;
}

/**
 * A counter span's measured volume, distributed across the days it covers that
 * nothing else has already measured.
 *
 * `shape` supplies the spot rate on each day. Where a day has none, it is
 * weighted by hours alone, which is "shape unknown", not "no gas".
 *
 * `measured` holds the days a yesterday-volume already owns. Those days take no
 * share here, and the gas they account for comes OUT of the span's delta first:
 * a span running from Monday to Friday over a Wednesday the meter measured has
 * Wednesday's volume removed and distributes only the remainder, so the same gas
 * is never counted twice. The span covers a day only partly at each end, so a
 * measured day at an edge is charged only for the hours the span actually holds.
 *
 * What is left of `deltaMcf` is then conserved exactly, including in the
 * zero-shape fallback. A remainder that comes out NEGATIVE is distributed as it
 * is: the counter and the meter's own day totals disagree, and this engine
 * reports what the numbers say rather than deciding which one to believe.
 */
function counterSpanDaily(
  span: CounterSpan,
  shape: Map<number, number>,
  measured: Map<number, number>
): Map<number, number> {
  const hoursAll = hoursByDay(span.fromMs, span.toMs);
  const out = new Map<number, number>();
  if (hoursAll.size === 0) return out;

  // Take the measured days out of both the delta and the days to spread it over.
  let claimed = 0;
  const hours = new Map<number, number>();
  for (const [dayMs, h] of hoursAll) {
    const own = measured.get(dayMs);
    if (own != null) {
      claimed += (own * h) / 24;
      continue;
    }
    hours.set(dayMs, h);
  }
  const delta = (span.deltaMcf ?? 0) - claimed;
  if (hours.size === 0) return out;

  const provisional = new Map<number, number>();
  let total = 0;
  for (const [dayMs, h] of hours) {
    const spot = shape.get(dayMs);
    const v = spot != null ? (spot * h) / 24 : h / 24;
    provisional.set(dayMs, v);
    total += v;
  }

  if (!(total > 0)) {
    // Every spot across the span reads zero while the counter moved, so the
    // shape carries no information. Spread the measured volume flat across the
    // hours. A divide-by-zero guard, not a judgement about the data.
    const totalHours = [...hours.values()].reduce((a, b) => a + b, 0);
    for (const [dayMs, h] of hours) out.set(dayMs, (delta * h) / totalHours);
    return out;
  }

  const k = delta / total;
  for (const [dayMs, v] of provisional) out.set(dayMs, k * v);
  return out;
}

/**
 * A segment with no counter span over it, distributed across the days it covers.
 *
 * There is no measured volume here, so nothing can be conserved and nothing may
 * be invented. The rate in force at the segment's open holds across every day it
 * covers, weighted by each day's hours. A later reading says what the rate
 * BECAME, not when it got there, so the change lands on the day it was observed
 * rather than being smeared backwards across days nobody watched.
 */
function spotSegmentDaily(
  seg: GasSegment,
  shape: Map<number, number>,
  measured: Map<number, number>
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [dayMs, h] of hoursByDay(seg.fromMs, seg.toMs)) {
    // A day the meter measured takes its own figure and nothing else. A rate is
    // an estimate of that day; the meter's total is the day.
    if (measured.has(dayMs)) continue;
    // The rate for a calendar day is the one entered ON that date (`spotByDay`),
    // so the hours of a reading's own day that fall before the reading carry
    // its own number rather than the previous reading's. Without that, the day
    // a pumper reports 400 on would be a blend of 400 and whatever came before.
    const rate = shape.get(dayMs) ?? seg.openSpot;
    if (rate == null) continue; // no number recorded: nothing to say
    out.set(dayMs, (rate * h) / 24);
  }
  return out;
}

/**
 * A gas meter's daily MCF, oldest first.
 *
 * Runs from the first reading to the last and no further: no back-extrapolation
 * before the first, and no carry into the future past the last. Aggregate
 * revenue and production estimates elsewhere in the app may project a last known
 * rate forward; the ground-truth production series must not.
 *
 * Each stretch is derived on its own terms, so a history that records the
 * counter for part of the month and only spot for the rest mixes the two. That
 * is what "the best data available" means in practice.
 */
export function gasDailySeries(readings: GasReading[]): DailyPoint[] {
  const segments = buildGasSegments(readings);
  const measured = measuredDays(readings);
  // A single reading carrying a yesterday-volume is still a measured day, even
  // though one reading spans nothing and makes no segments.
  if (segments.length === 0 && measured.size === 0) return [];

  const shape = spotByDay(readings);
  const counted = buildCounterSpans(readings).filter((s) => s.deltaMcf != null);

  const byDay = new Map<number, number>();
  const add = (dayMs: number, mcf: number): void => {
    byDay.set(dayMs, (byDay.get(dayMs) ?? 0) + mcf);
  };

  // First, the days the meter measured outright. Nothing below may touch them.
  for (const [dayMs, mcf] of measured) byDay.set(dayMs, mcf);

  for (const span of counted) {
    for (const [dayMs, mcf] of counterSpanDaily(span, shape, measured)) add(dayMs, mcf);
  }

  // Everything a counter span does not cover falls back to the flow rate.
  // Segments nest inside spans exactly, because both are bounded by reading
  // timestamps, so containment is the whole test.
  for (const seg of segments) {
    const covered = counted.some(
      (s) => seg.fromMs >= s.fromMs && seg.toMs <= s.toMs
    );
    if (covered) continue;
    for (const [dayMs, mcf] of spotSegmentDaily(seg, shape, measured)) add(dayMs, mcf);
  }

  /*
   * Volumes to rates. Coverage runs from the first reading to the last, so the
   * hours a day holds are its overlap with that one window. A measured day is
   * already a whole day's figure and is left alone.
   */
  const sorted = stamp(readings);
  const covered = hoursByDay(sorted[0].ms, sorted[sorted.length - 1].ms);
  for (const [dayMs, mcf] of byDay) {
    if (measured.has(dayMs)) continue;
    const h = covered.get(dayMs);
    if (h != null && h > 0 && h < 24) byDay.set(dayMs, (mcf * 24) / h);
  }

  // A last reading stamped at midnight covers none of its own day's hours, but
  // the rate it reported is still that date's rate. Say so.
  const lastDay = dayStartMs(sorted[sorted.length - 1].ms);
  const lastRate = shape.get(lastDay);
  if (!byDay.has(lastDay) && !measured.has(lastDay) && lastRate != null) {
    byDay.set(lastDay, lastRate);
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    // `DailyPoint.bbls` carries the day's MCF/d here, as it does everywhere gas
    // rides this type. Anything summing it with oil is wrong.
    .map(([dayMs, mcf]) => ({ date: dayKey(dayMs), bbls: mcf }));
}
