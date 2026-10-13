/**
 * Collapses the pricing page's flat daily price series into a compact monthly
 * summary — the shape Orion's `get_posted_prices` tool returns. The posted and
 * projected series are flat within each month, so one price per month captures
 * them losslessly while keeping the payload small.
 */
import { COMMODITIES, type Commodity, type PricePoint } from "@/lib/pricing/types";

/** A realized-or-modeled price for one production month. */
export interface MonthlyPostedPrice {
  /** Production month, "YYYY-MM". */
  month: string;
  /** USD per unit (oil $/bbl, gas $/MMBtu). */
  price: number;
  /** Whether this came from the ledger (actual) or the forward model. */
  kind: "actual" | "projected";
}

/** Per-commodity posted-price summary. */
export interface PostedPriceSummary {
  commodity: Commodity;
  /** Benchmark the posted price tracks, e.g. "WTI". */
  benchmark: string;
  /** Price unit suffix, e.g. "/bbl". */
  unit: string;
  /** Chronological monthly prices, actual months then the projected tail. */
  months: MonthlyPostedPrice[];
}

const monthOf = (isoDate: string) => isoDate.slice(0, 7);

/** Average price per month (series are flat within a month, so this is exact). */
function pricesByMonth(series: PricePoint[]): Map<string, number> {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const p of series) {
    const key = monthOf(p.date);
    const e = acc.get(key) ?? { sum: 0, n: 0 };
    e.sum += p.price;
    e.n += 1;
    acc.set(key, e);
  }
  return new Map(
    [...acc].map(([month, { sum, n }]) => [month, sum / n])
  );
}

function summarizeCommodity(
  commodity: Commodity,
  posted: PricePoint[],
  projected: PricePoint[]
): PostedPriceSummary {
  const meta = COMMODITIES[commodity];
  const actual = pricesByMonth(posted);
  const months: MonthlyPostedPrice[] = [...actual].map(([month, price]) => ({
    month,
    price: Math.round(price * 100) / 100,
    kind: "actual" as const,
  }));

  // Projected series carries a bridge point in the last actual month; skip any
  // month we already have an actual for so it isn't double-counted.
  for (const [month, price] of pricesByMonth(projected)) {
    if (actual.has(month)) continue;
    months.push({
      month,
      price: Math.round(price * 100) / 100,
      kind: "projected",
    });
  }

  months.sort((a, b) => (a.month < b.month ? -1 : 1));
  return {
    commodity,
    benchmark: meta.benchmark,
    unit: meta.unit,
    months,
  };
}

export function summarizePostedPrices(
  posted: Record<Commodity, PricePoint[]>,
  projected: Record<Commodity, PricePoint[]>
): PostedPriceSummary[] {
  return (Object.keys(COMMODITIES) as Commodity[]).map((commodity) =>
    summarizeCommodity(commodity, posted[commodity], projected[commodity])
  );
}
