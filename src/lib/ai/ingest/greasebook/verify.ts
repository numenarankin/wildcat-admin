/**
 * Prove the mapping using GreaseBook's own arithmetic.
 *
 * Every GB report prints DERIVED columns next to the raw ones, and this import
 * throws those columns away: barrels come from the tank's own strapping, disposal
 * volume from consecutive meter indexes. That makes them a free independent
 * oracle. They were computed by another system from the same rows, so if what we
 * extracted reproduces them, we read the right rows and the right columns. If it
 * does not, we are off by a column or a row, which is the one failure a reader
 * cannot otherwise notice: every value still looks like a plausible number.
 *
 * Identities checked (all verified against the real exports):
 *
 *   tank readings   gauge(n) − gauge(n−1) == printed "+/- in"
 *   tank readings   printed bbls ÷ printed inches is constant per tank (strapping)
 *   water meter     index(n) − index(n−1) == printed "Water (bbls)", gaps included
 *   run tickets     gross ÷ (opening − closing) is constant per tank
 *   production      stock(n) == stock(n−1) + produced(n) − sales(n)
 *
 * The checks run over the EXTRACTED rows, never over the source text, so they
 * test what we actually produced.
 *
 * Two grades of failure, because they mean different things. A whole stream that
 * disagrees is a misread and is refused (the model path can have those rows). A
 * handful of rows that disagree inside an otherwise-clean stream is GreaseBook's
 * own edited or backdated data, so those rows are kept and flagged for the
 * operator to see before approving.
 *
 * Pure.
 */

import type { GbRow } from "./types";

export type Verdict = "ok" | "scattered" | "systematic";

export interface StreamCheck {
  stream: string;
  identity: string;
  checked: number;
  /** `at` (grid row index) of each row that did not reconcile. */
  mismatched: number[];
  verdict: Verdict;
}

export interface VerifyResult {
  checks: StreamCheck[];
  /** Streams whose mapping is not trustworthy; their rows must not be proposed. */
  systematic: Set<string>;
  /** Individual rows to keep but flag, by `at`. */
  flagged: Set<number>;
}

/** A stream needs this many checkable rows before a majority verdict means
 * anything. Below it, disagreement is flagged, never used to refuse a stream. */
const MIN_FOR_SYSTEMATIC = 3;

/**
 * Fraction of a stream that must disagree for the MAPPING to be wrong rather than
 * the data.
 *
 * Set high on purpose. One bad reading breaks TWO consecutive delta checks (the
 * step onto it and the step off it), so a single edited row in a short run can
 * reach half the stream while being nothing but one edited row. A column actually
 * read in the wrong place breaks essentially every check, at a ratio near 1. The
 * gap between those two is what this threshold sits in.
 */
const SYSTEMATIC_RATIO = 0.6;

/** Inches and barrels are printed to 2dp; this is comfortably inside a quarter. */
const ABS_TOLERANCE = 0.02;

/** Strapping and ticket ratios are constant, but printed values are rounded. */
const REL_TOLERANCE = 0.02;

export function verifyGb(rows: GbRow[]): VerifyResult {
  const checks: StreamCheck[] = [];
  for (const [stream, group] of byStream(rows)) {
    const readings = ordered(group.filter((r) => r.type === "tankReadings"));
    const meters = ordered(group.filter((r) => r.type === "meterReadings"));
    const runs = ordered(group.filter((r) => r.type === "runTickets"));
    const production = ordered(group.filter((r) => r.type === "production"));

    if (readings.length > 1) {
      // Readings AND runs, in time order: a haul changes the level, so the
      // reading after one is measured from the level the haul left behind.
      checks.push(gaugeDeltaCheck(stream, ordered([...readings, ...runs])));
      checks.push(ratioCheck(stream, "bbls per inch is constant", readings));
    }
    if (meters.length > 1) {
      checks.push(deltaCheck(stream, "index delta vs printed bbls", meters, "mcf"));
    }
    if (runs.length > 1) {
      checks.push(runRatioCheck(stream, runs));
    }
    if (production.length > 1) {
      checks.push(stockCheck(stream, production));
    }
  }

  const systematic = new Set<string>();
  const flagged = new Set<number>();
  for (const c of checks) {
    if (c.verdict === "systematic") systematic.add(c.stream);
    else if (c.verdict === "scattered") for (const at of c.mismatched) flagged.add(at);
  }
  // A row in a refused stream is not also individually flagged: the stream is
  // going to the model whole.
  for (const row of rows) if (systematic.has(row.stream)) flagged.delete(row.at);
  return { checks: checks.filter((c) => c.checked > 0), systematic, flagged };
}

/**
 * A TANK's printed inch change, checked against the level it was measured from.
 *
 * Not simply the previous reading. A run ticket takes oil out of the tank
 * between two readings, and GreaseBook measures the next reading's change from
 * the level the HAUL left behind, not from the reading before it. Comparing to
 * the previous reading instead flags every post-haul row as not reconciling,
 * which on the real export is ten perfectly good readings wearing a warning.
 *
 * So the previous level is whichever event came last on this tank: a reading's
 * gauge, or a run's closing gauge.
 */
function gaugeDeltaCheck(stream: string, events: GbRow[]): StreamCheck {
  const mismatched: number[] = [];
  let checked = 0;
  let previous: number | null = null;
  for (const event of events) {
    if (event.type === "runTickets") {
      // The tank is left at the closing level; the run's own volume is checked
      // by the ratio identity instead.
      previous = numberField(event, "closingGauge") ?? previous;
      continue;
    }
    const gauge = numberField(event, "gauge");
    const printed = event.derived.deltaIn ?? null;
    if (gauge != null && previous != null && printed != null) {
      checked++;
      if (Math.abs(gauge - previous - printed) > ABS_TOLERANCE) mismatched.push(event.at);
    }
    if (gauge != null) previous = gauge;
  }
  return grade(stream, "gauge delta vs printed +/- in", checked, mismatched);
}

/**
 * `value(n) − value(n−1)` against the change GreaseBook printed on row n.
 *
 * Ordered by DATE, not by position in the grid, because the water page prints
 * newest first and the tank export oldest first, and the identity is about
 * consecutive readings either way.
 */
function deltaCheck(
  stream: string,
  identity: string,
  rows: GbRow[],
  field: "gauge" | "mcf"
): StreamCheck {
  const mismatched: number[] = [];
  let checked = 0;
  for (let i = 1; i < rows.length; i++) {
    const printed = printedDelta(rows[i]);
    if (printed == null) continue;
    const now = numberField(rows[i], field);
    const prev = numberField(rows[i - 1], field);
    if (now == null || prev == null) continue;
    checked++;
    if (Math.abs(now - prev - printed) > ABS_TOLERANCE) mismatched.push(rows[i].at);
  }
  return grade(stream, identity, checked, mismatched);
}

/** Printed barrels ÷ printed inches: a tank's strapping, which cannot change
 * between two rows of one report. */
function ratioCheck(stream: string, identity: string, rows: GbRow[]): StreamCheck {
  const points = rows
    .map((r) => ({
      at: r.at,
      ratio:
        r.derived.deltaIn != null &&
        Math.abs(r.derived.deltaIn) > 0.1 &&
        r.derived.volume != null
          ? r.derived.volume / r.derived.deltaIn
          : null,
    }))
    .filter((p): p is { at: number; ratio: number } => p.ratio != null && Number.isFinite(p.ratio));
  return constantRatio(stream, identity, points);
}

/** Gross barrels ÷ the level drop: the same strapping, seen from the ticket. */
function runRatioCheck(stream: string, rows: GbRow[]): StreamCheck {
  const points = rows
    .map((r) => {
      const gross = numberField(r, "grossBbls");
      const open = numberField(r, "openingGauge");
      const close = numberField(r, "closingGauge");
      if (gross == null || open == null || close == null) return null;
      const drop = open - close;
      if (!(drop > 0.1) || !(gross > 0)) return null;
      return { at: r.at, ratio: gross / drop };
    })
    .filter((p): p is { at: number; ratio: number } => p != null);
  return constantRatio(stream, "gross per inch is constant", points);
}

/** `stock(n) == stock(n−1) + produced(n) − sales(n)`: the report's own ledger. */
function stockCheck(stream: string, rows: GbRow[]): StreamCheck {
  const mismatched: number[] = [];
  let checked = 0;
  for (let i = 1; i < rows.length; i++) {
    const stock = rows[i].derived.stock;
    const prior = rows[i - 1].derived.stock;
    const made = rows[i].derived.produced;
    const sold = rows[i].derived.sales ?? 0;
    if (stock == null || prior == null || made == null) continue;
    checked++;
    /*
     * A day with a SALE gets a proportional allowance.
     *
     * On the real export every sales day misses by 0.2 to 0.7 barrels against a
     * 170-180 barrel run: GreaseBook's stock ledger and its printed sales figure
     * are the gross and net sides of the same ticket, which differ by the BS&W
     * and temperature correction. That is a fraction of a percent, and it is
     * GreaseBook's arithmetic rather than our reading. A misread column, by
     * contrast, is out by whole barrels.
     *
     * Left as an exact check, this fired on nine rows of one battery and would
     * fire on every sales day of every import — and a flag that cries wolf is
     * one nobody reads.
     */
    const tolerance = Math.max(ABS_TOLERANCE, Math.abs(sold) * 0.01);
    if (Math.abs(stock - (prior + made - sold)) > tolerance) mismatched.push(rows[i].at);
  }
  return grade(stream, "oil stock ledger", checked, mismatched);
}

/** Shared tail of the two ratio checks: compare every point to the median. */
function constantRatio(
  stream: string,
  identity: string,
  points: { at: number; ratio: number }[]
): StreamCheck {
  if (points.length < 2) return grade(stream, identity, 0, []);
  const sorted = [...points].sort((a, b) => a.ratio - b.ratio);
  const median = sorted[Math.floor(sorted.length / 2)].ratio;
  const mismatched = points
    .filter((p) => Math.abs(p.ratio - median) > Math.abs(median) * REL_TOLERANCE)
    .map((p) => p.at);
  return grade(stream, identity, points.length, mismatched);
}

function grade(
  stream: string,
  identity: string,
  checked: number,
  mismatched: number[]
): StreamCheck {
  let verdict: Verdict = "ok";
  if (mismatched.length > 0) {
    const systematic =
      checked >= MIN_FOR_SYSTEMATIC && mismatched.length / checked >= SYSTEMATIC_RATIO;
    verdict = systematic ? "systematic" : "scattered";
  }
  return { stream, identity, checked, mismatched, verdict };
}

/** The printed change for a row, whichever column carried it. */
function printedDelta(row: GbRow): number | null {
  if (row.type === "meterReadings") return row.derived.volume ?? null;
  return row.derived.deltaIn ?? null;
}

function numberField(row: GbRow, key: string): number | null {
  const v = row.row[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function byStream(rows: GbRow[]): Map<string, GbRow[]> {
  const out = new Map<string, GbRow[]>();
  for (const r of rows) {
    const list = out.get(r.stream);
    if (list) list.push(r);
    else out.set(r.stream, [r]);
  }
  return out;
}

/** Chronological, so a report printed newest-first checks the same as one printed
 * oldest-first. Ties (two readings the same minute) keep their grid order. */
function ordered(rows: GbRow[]): GbRow[] {
  return [...rows].sort((a, b) => {
    const ka = `${a.row.date ?? ""}T${a.row.time ?? a.row.departureTime ?? ""}`;
    const kb = `${b.row.date ?? ""}T${b.row.time ?? b.row.departureTime ?? ""}`;
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.at - b.at;
  });
}
