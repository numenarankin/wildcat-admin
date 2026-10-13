import "server-only";
import type { Commodity, PricePoint } from "@/lib/pricing/types";
import { getPriceHistory } from "@/lib/pricing/feed";
import { getRealizationModels, monthlyBenchmark } from "@/lib/pricing/realization";
import { projectFrom } from "@/lib/pricing/projection";

/**
 * Forward-projected posted prices, filling the gap between the last actual
 * posted month and the current month. Accounting arrives about a month late,
 * but the benchmarks are live, so the model that explains settled months can
 * carry them forward.
 *
 * The projection reads the org's realization model at each unsettled month's
 * average benchmarks and emits the result as a flat daily series (the current
 * month only through today).
 *
 * This used to be its own estimator: a mean of (benchmark − posted) subtracted
 * from the benchmark. That answered the same question as the realization factor
 * every other surface used, in a different and incompatible form — an additive
 * differential holds a discount constant in dollars while a multiplied factor
 * scales it with price, so the faded line on this chart and the price the lease
 * pages applied to the same month were, by construction, two different numbers.
 * They are now one fit: proportional share, cross-commodity term and fixed
 * deduct estimated together rather than one of them assumed.
 */

const COMMODITIES: Commodity[] = ["oil", "gas"];

export { projectFrom };

export async function getProjectedPrices(
  posted: Record<Commodity, PricePoint[]>
): Promise<Record<Commodity, PricePoint[]>> {
  const today = new Date().toISOString().slice(0, 10);
  // A year of daily benchmark, independent of the chart's display range, so
  // every projected month is covered.
  const [models, oilHistory, gasHistory] = await Promise.all([
    getRealizationModels(),
    getPriceHistory("oil", "12M"),
    getPriceHistory("gas", "12M"),
  ]);
  const byCommodity: Record<Commodity, Map<string, number>> = {
    oil: monthlyBenchmark(oilHistory),
    gas: monthlyBenchmark(gasHistory),
  };
  const entries = COMMODITIES.map(
    (c) =>
      [
        c,
        projectFrom(
          models,
          c,
          posted[c],
          byCommodity[c],
          byCommodity[c === "oil" ? "gas" : "oil"],
          today
        ),
      ] as const
  );
  return Object.fromEntries(entries) as Record<Commodity, PricePoint[]>;
}
