import type { PricePoint } from "@/lib/pricing/types";
import {
  predictRealized,
  type RealizationModel,
} from "@/lib/pricing/realization-model";

/**
 * Realized (basis-adjusted) commodity prices for a set of dates or months, from
 * the org's realization model.
 *
 * Both benchmark series are needed, not just the commodity's own: the model
 * carries a cross-commodity term, so pricing a barrel reads WTI and Henry Hub
 * on the same date. This is the SAME adjustment the dashboard cards and the
 * lease revenue estimate apply, from the same fitted model.
 */

/** Most recent price on or before each date (forward-fill), by date. */
function forwardFill(
  history: PricePoint[],
  dates: string[]
): Map<string, number> {
  const out = new Map<string, number>();
  if (history.length === 0) return out;
  const sorted = [...history].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  let i = 0;
  // Dates before the series starts take its first price.
  let last = sorted[0].price;
  for (const date of dates) {
    while (i < sorted.length && sorted[i].date <= date) {
      last = sorted[i].price;
      i += 1;
    }
    out.set(date, last);
  }
  return out;
}

/** Average price per "YYYY-MM" from a daily series. */
function averageByMonth(history: PricePoint[]): Map<string, number> {
  const totals = new Map<string, { sum: number; days: number }>();
  for (const point of history) {
    const month = point.date.slice(0, 7);
    const at = totals.get(month) ?? { sum: 0, days: 0 };
    at.sum += point.price;
    at.days += 1;
    totals.set(month, at);
  }
  const out = new Map<string, number>();
  for (const [month, { sum, days }] of totals) {
    if (days > 0) out.set(month, sum / days);
  }
  return out;
}

/**
 * The realized price for each requested date.
 *
 * The benchmarks trade on business days only, so each date takes the most
 * recent close on or before it; dates before a series starts take its first
 * price. Returns a `date -> price` map for every requested date. An empty
 * self-history yields an empty map (the caller treats a missing date as no
 * price).
 */
export function realizedPriceByDate(
  selfHistory: PricePoint[],
  crossHistory: PricePoint[],
  model: RealizationModel,
  dates: string[]
): Record<string, number> {
  if (selfHistory.length === 0) return {};
  const wanted = [...new Set(dates)].sort();
  const self = forwardFill(selfHistory, wanted);
  const cross = forwardFill(crossHistory, wanted);
  const out: Record<string, number> = {};
  for (const date of wanted) {
    const s = self.get(date);
    if (s == null) continue;
    out[date] = predictRealized(model, s, cross.get(date) ?? 0);
  }
  return out;
}

/**
 * The same realized price, averaged over each calendar MONTH the benchmark
 * actually traded in.
 *
 * For the lease Production table's state-reported rows, which are monthly
 * averages rather than days. A month is priced only if BOTH benchmark series
 * cover it; unlike {@link realizedPriceByDate} there is deliberately no
 * back-fill, because these rows run back decades before the feed begins and
 * pricing 1994 production at the year-2000 open would be an invented number
 * rather than an estimate. Absent months are simply left out, and the caller
 * shows a dash.
 */
export function realizedPriceByMonth(
  selfHistory: PricePoint[],
  crossHistory: PricePoint[],
  model: RealizationModel
): Record<string, number> {
  const self = averageByMonth(selfHistory);
  const cross = averageByMonth(crossHistory);
  const out: Record<string, number> = {};
  for (const [month, s] of self) {
    const c = cross.get(month);
    if (c == null) continue;
    out[month] = predictRealized(model, s, c);
  }
  return out;
}

/**
 * The raw benchmark on each date, unadjusted. The digests chart it against the
 * realized price to show the gap the realization model represents.
 */
export function benchmarkByDate(
  history: PricePoint[],
  dates: string[]
): Record<string, number> {
  if (history.length === 0) return {};
  const wanted = [...new Set(dates)].sort();
  const filled = forwardFill(history, wanted);
  const out: Record<string, number> = {};
  for (const [date, price] of filled) out[date] = price;
  return out;
}
