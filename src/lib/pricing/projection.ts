/**
 * Forward-projected posted prices, the pure half of `projected-prices.ts`.
 *
 * Accounting arrives about a month late, but the benchmarks are live, so the
 * model that explains settled months can carry them forward: each unsettled
 * month is priced by reading the org's realization model at that month's
 * average benchmarks, and emitted as a flat daily series (the current month
 * only through today). Split out so the device can project from its cached
 * snapshot with the same arithmetic the /prices chart uses.
 */
import type { Commodity, PricePoint } from "@/lib/pricing/types";
import type { RealizationModels } from "@/lib/pricing/realization";
import { predictRealized } from "@/lib/pricing/realization-model";

const monthOf = (isoDate: string) => isoDate.slice(0, 7); // "YYYY-MM"

/** Flat daily posted series → month → price. */
function postedByMonth(series: PricePoint[]): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const p of series) byMonth.set(monthOf(p.date), p.price);
  return byMonth;
}

function lastDayOfMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1)); // 1st of this month
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Project one commodity forward from its last settled month.
 *
 * `self` is that commodity's own benchmark by month and `cross` the other's;
 * the model weighs both. A month either series does not reach is skipped rather
 * than guessed.
 */
export function projectFrom(
  models: RealizationModels,
  commodity: Commodity,
  postedSeries: PricePoint[],
  self: Map<string, number>,
  cross: Map<string, number>,
  today: string
): PricePoint[] {
  const posted = postedByMonth(postedSeries);
  if (posted.size === 0) return []; // nothing to project forward FROM

  const months = [...posted.keys()].sort();
  const lastPosted = months[months.length - 1];
  const currentMonth = monthOf(today);
  const todayDay = Number(today.slice(8, 10));
  const model = models[commodity];

  const points: PricePoint[] = [];
  // Bridge the solid line into the faded one: start at the last actual point.
  points.push({
    date: `${lastPosted}-${String(lastDayOfMonth(lastPosted)).padStart(2, "0")}`,
    price: posted.get(lastPosted) as number,
  });

  for (
    let month = nextMonth(lastPosted);
    month <= currentMonth;
    month = nextMonth(month)
  ) {
    const s = self.get(month);
    const c = cross.get(month);
    if (s == null || c == null) continue; // no benchmark for this month yet
    const price = predictRealized(model, s, c);
    // Don't project days that haven't happened yet in the current month.
    const maxDay = month === currentMonth ? todayDay : lastDayOfMonth(month);
    for (let day = 1; day <= maxDay; day++) {
      points.push({ date: `${month}-${String(day).padStart(2, "0")}`, price });
    }
  }

  // Only the bridge point means there's nothing actually projected — drop it.
  return points.length > 1 ? points : [];
}
