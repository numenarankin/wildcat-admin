/**
 * The company's production rate — pure.
 *
 * ONE definition, shared by the headline and the cards: a well's rate is the
 * 14-day EMA of its own measured series (`latestDailyEma`), and the company's
 * rate is the sum of its wells'. Both surfaces read the same per-well numbers,
 * so the headline is the sum of what the map shows by construction rather than
 * by two derivations happening to land on the same figure.
 *
 * What this replaced: the headline summed each oil tank's LAST GAUGE INTERVAL,
 * the gas meters' latest readings, and a 30-day trailing water rate, while the
 * well cards showed 14-day EMAs of the allocated shares. Three estimators over
 * three populations, and no arithmetic that reconciled them — `well-rates.test.ts`
 * now pins the sum against the cards' own readout function.
 *
 * No DB, no React: the loader lives in `./company-rates`.
 */

/** One well's current rates, per stream, in bbl/d (oil, water) and mcf/d (gas). */
export interface WellRates {
  oil: number;
  gas: number;
  water: number;
}

/**
 * The company's rate: its wells', added up. A well contributing nothing to a
 * stream contributes zero to it, so all three streams are summed over the same
 * population — which is what lets the headline and the cards be compared at all.
 */
export function sumWellRates(rates: Iterable<WellRates>): WellRates {
  const total: WellRates = { oil: 0, gas: 0, water: 0 };
  for (const r of rates) {
    total.oil += r.oil;
    total.gas += r.gas;
    total.water += r.water;
  }
  return total;
}
