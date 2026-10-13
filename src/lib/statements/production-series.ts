/**
 * Settlement statements as a production series (docs/plans/statement-derived-production.md).
 *
 * A statement prints a VOLUME for a settlement period. Spreading that volume evenly
 * across the period's days is the only thing the source supports and is exactly what
 * the RRC tier already does with a filed month: 3100 bbl over a 31-day period is
 * 100 bbl/d for all 31 days, a flat step and no invented detail.
 *
 * ## Why this is a sibling of `expandMonthlyToDaily` and not a call to it
 *
 * The RRC version (`@/lib/rrc/lease-history-series`) is keyed on a CALENDAR MONTH and
 * trims each stream to the span it was actually reported over, because Texas files the
 * months it has not collected yet as zero. A statement has neither property: its period
 * is an arbitrary range the purchaser chose, and a zero on a settled statement is the
 * purchaser stating that nothing was sold, which is a fact and not a gap. Sharing one
 * function would mean one of the two carries a branch it never wants.
 *
 * ## Strictly an approximation of produced volume
 *
 * A statement measures what was SOLD: net of what stayed in the tank, and at the
 * operator's settled share (explicit on gas, where `grossMcf` and `settleQty` differ by
 * `producerPct`). A gauge measures gross production. For a period the operator measured
 * nothing, sold volume is the best evidence there is, so it is used as-is and labelled by
 * `source` rather than grossed up. It must never be read back as a statement TOTAL: that
 * comes from the statement.
 *
 * Pure and side-effect free, so every rate here is checked against a hand-computed oracle
 * rather than against whatever the database returned.
 */

/** One settled volume, as the loader reads it off a line plus its statement. */
export interface StatementVolume {
  /** Settlement period start, ISO `YYYY-MM-DD`, inclusive. */
  periodStart: string;
  /** Settlement period end, ISO `YYYY-MM-DD`, INCLUSIVE. */
  periodEnd: string;
  product: "oil" | "gas";
  /** Barrels on oil, MCF on gas, as settled. */
  volume: number;
}

/** A constant daily rate implied by one period's volume. */
export interface StatementPoint {
  date: string;
  /** bbl/d on oil, MCF/d on gas. */
  value: number;
}

export interface StatementSeries {
  /** Daily oil rate, bbl/d. Empty when no oil was ever settled. */
  oil: StatementPoint[];
  /** Daily gas rate, MCF/d. Empty when no gas was ever settled. */
  gas: StatementPoint[];
}

const EMPTY: StatementSeries = { oil: [], gas: [] };

/**
 * Never enumerate more than this many days from one period.
 *
 * Guards a mis-parsed or mis-extracted range. The same ceiling `revenueShares` puts on a
 * settlement window (`MAX_PERIOD_DAYS`), for the same reason and with the same number, so
 * the two cannot disagree about what an absurd period is.
 */
export const MAX_PERIOD_DAYS = 400;

const DAY_MS = 86_400_000;

/** Inclusive day count, or 0 when the range is unparseable or inverted. */
function daysInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / DAY_MS) + 1;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Period volumes to a flat daily rate per day, per stream, oldest first.
 *
 * OVERLAPPING PERIODS SUM. An operator really can sell oil to two purchasers in one
 * month, and each statement reports only its own half; adding them is what makes the
 * lease's rate whole. The cost of that choice is that a DUPLICATE upload is arithmetically
 * indistinguishable from a second purchaser, which is why de-duplication happens in the
 * loader before anything reaches here (see the plan's D5). This function is deliberately
 * credulous: it adds what it is given.
 *
 * A ZERO VOLUME IS A REAL ZERO. `Roach MM` settles 0 MCF on a reviewed statement in
 * production today. The purchaser is saying nothing was sold, and the series says so.
 * That is the opposite of an RRC month filed as zero, which means "Texas has not collected
 * this yet" and is trimmed away by `reportedRange`.
 *
 * An unparseable or inverted period contributes nothing rather than throwing: one bad
 * extraction should cost its own line, never the lease's whole chart.
 */
export function expandPeriodsToDaily(
  volumes: StatementVolume[]
): StatementSeries {
  if (volumes.length === 0) return EMPTY;

  // Accumulate per stream per date, because periods legitimately overlap.
  const byStream: Record<"oil" | "gas", Map<string, number>> = {
    oil: new Map(),
    gas: new Map(),
  };

  for (const v of volumes) {
    const days = daysInclusive(v.periodStart, v.periodEnd);
    if (days <= 0) continue;
    const rate = v.volume / days;
    if (!Number.isFinite(rate)) continue;

    const start = Date.parse(`${v.periodStart}T00:00:00Z`);
    const at = byStream[v.product];
    if (!at) continue;
    for (let i = 0; i < Math.min(days, MAX_PERIOD_DAYS); i++) {
      const date = iso(start + i * DAY_MS);
      at.set(date, (at.get(date) ?? 0) + rate);
    }
  }

  return {
    oil: sorted(byStream.oil),
    gas: sorted(byStream.gas),
  };
}

function sorted(byDate: Map<string, number>): StatementPoint[] {
  return [...byDate]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
