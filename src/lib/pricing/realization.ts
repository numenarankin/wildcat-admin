import "server-only";

/**
 * The org's realization models: how the price it actually receives relates to
 * the futures benchmarks, fitted from its own settlement history.
 *
 * ONE definition, loaded once, used by every surface that puts a dollar figure
 * on a volume - the dashboard cards, the lease table's monthly estimate, the
 * lease/well/tank/meter pages, the CSV export, the digests and the reports. The
 * math is in `./realization-model`; this is the loader that feeds it.
 */

import { getPriceHistory } from "@/lib/pricing/feed";
import {
  getRealizedMonths,
  netWeight,
  realizedMonthsByLease,
  type RealizedMonth,
} from "@/lib/pricing/posted-prices";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { memoScope } from "@/lib/cache/request-cache";
import { listAllInterests } from "@/lib/interest/interest";
import { ASSUMED_NRI, operatorNriByLease } from "@/lib/interest/gross-net";
import { getTransactions } from "@/lib/accounting/ledger";
import type { Commodity, PricePoint } from "@/lib/pricing/types";
import {
  fitRealization,
  observationsFrom,
  priorModel,
  FIT_LOOKBACK_MONTHS,
  type RealizationModel,
} from "@/lib/pricing/realization-model";
import { hasSupabase } from "@/lib/env";

/**
 * Both commodities' models. `measured` is false when EITHER fell back to the
 * prior, which is the flag the UI reads to mark a figure as an estimate.
 */
export interface RealizationModels {
  oil: RealizationModel;
  gas: RealizationModel;
  measured: boolean;
}

/** The company models, plus a model per lease that has settled anything. */
export interface OrgRealization {
  /** Fitted from EVERY revenue row, including rows with no lease. */
  company: RealizationModels;
  /** Fitted from that lease's own months alone. Absent = no settlements. */
  byLease: Map<string, RealizationModels>;
}

/** Untouched priors: assume the operator receives the benchmark. */
export const PRIOR_MODELS: RealizationModels = {
  oil: priorModel(1),
  gas: priorModel(1),
  measured: false,
};

export const PRIOR_ORG: OrgRealization = {
  company: PRIOR_MODELS,
  byLease: new Map(),
};

/**
 * The models to price a volume with.
 *
 * **The single place the fallback is decided.** A lease with its own settlement
 * history is priced from that history; a lease with none, or a caller with no
 * lease in hand at all, gets the company models. No consumer may implement this
 * choice itself, or the rule becomes a convention instead of a guarantee.
 */
export function modelsFor(
  org: OrgRealization,
  leaseId?: string | null
): RealizationModels {
  if (!leaseId) return org.company;
  return org.byLease.get(leaseId) ?? org.company;
}

/** Average benchmark price per "YYYY-MM" from a daily series. */
export function monthlyBenchmark(daily: PricePoint[]): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const p of daily) {
    const m = p.date.slice(0, 7);
    const s = sums.get(m) ?? { sum: 0, n: 0 };
    s.sum += p.price;
    s.n += 1;
    sums.set(m, s);
  }
  const out = new Map<string, number>();
  for (const [m, s] of sums) if (s.n > 0) out.set(m, s.sum / s.n);
  return out;
}

/**
 * Pure: fit both commodities from already-loaded inputs. Each commodity's own
 * index is its `self` regressor and the other is its `cross`, so gas is fitted
 * against Henry Hub AND WTI (condensate) and oil against WTI and Henry Hub.
 */
export function fitRealizationModels(
  months: Record<Commodity, RealizedMonth[]>,
  oilHistory: PricePoint[],
  gasHistory: PricePoint[]
): RealizationModels {
  const oilBenchmark = monthlyBenchmark(oilHistory);
  const gasBenchmark = monthlyBenchmark(gasHistory);
  const oil = fitRealization(
    observationsFrom(months.oil, oilBenchmark, gasBenchmark),
    priorModel(1)
  );
  const gas = fitRealization(
    observationsFrom(months.gas, gasBenchmark, oilBenchmark),
    priorModel(1)
  );
  return { oil, gas, measured: oil.measured && gas.measured };
}

/**
 * Pure: the company models plus one per lease, from already-loaded inputs.
 *
 * A lease's fit is anchored on nothing but its own months. `freeLevel` leaves
 * the level unpinned, so a lease that settled at $7.30/mcf prices at $7.30 - not
 * shrunk toward the company average, which is the error this exists to remove.
 * There is no month-count threshold and no second estimator: one month and
 * twelve months run the identical call, and whatever it returns is the price.
 *
 * The company fit reads every row, including rows with no lease (see
 * `realizedMonthsByLease`), so it stays the honest fallback.
 */
export function fitOrgRealization(
  transactions: Parameters<typeof realizedMonthsByLease>[0],
  months: Record<Commodity, RealizedMonth[]>,
  oilHistory: PricePoint[],
  gasHistory: PricePoint[]
): OrgRealization {
  const company = fitRealizationModels(months, oilHistory, gasHistory);
  const oilBenchmark = monthlyBenchmark(oilHistory);
  const gasBenchmark = monthlyBenchmark(gasHistory);

  const byLeaseOil = realizedMonthsByLease(transactions, "oil");
  const byLeaseGas = realizedMonthsByLease(transactions, "gas");

  const byLease = new Map<string, RealizationModels>();
  for (const leaseId of new Set([...byLeaseOil.keys(), ...byLeaseGas.keys()])) {
    // Each commodity falls back independently: a lease with gas statements and
    // no oil statements gets its own gas model and the company's oil model.
    const oil = fitLease(
      byLeaseOil.get(leaseId),
      oilBenchmark,
      gasBenchmark,
      company.oil
    );
    const gas = fitLease(
      byLeaseGas.get(leaseId),
      gasBenchmark,
      oilBenchmark,
      company.gas
    );
    byLease.set(leaseId, {
      oil,
      gas,
      measured: oil.measured && gas.measured,
    });
  }

  return { company, byLease };
}

function fitLease(
  months: RealizedMonth[] | undefined,
  self: Map<string, number>,
  cross: Map<string, number>,
  companyFallback: RealizationModel
): RealizationModel {
  if (!months || months.length === 0) return companyFallback;
  const observations = observationsFrom(months, self, cross);
  if (observations.length === 0) return companyFallback;
  return fitRealization(observations, priorModel(1), { freeLevel: true });
}

/**
 * How far back the ledger is read. The fit looks back
 * {@link FIT_LOOKBACK_MONTHS} complete months; a month of slack covers a
 * partial current month and a late-posting statement.
 */
export function fitSince(): string {
  const ms = Date.now() - (FIT_LOOKBACK_MONTHS + 1) * 31 * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Fit both commodities from the ledger and the benchmark feed. */
export async function getRealizationModels(): Promise<RealizationModels> {
  return (await getOrgRealization()).company;
}

/**
 * The settled months the COMPANY model is fitted on: every revenue row, each
 * weighted by the operator's interest in its lease (`netWeight`), so the
 * company factor is the factor on the operator's net revenue. A lease's own
 * model is unweighted, because one lease has one interest and a constant
 * changes nothing. Memoized per request scope; the device snapshot reads the
 * same months so a phone refits what the server fitted.
 */
export function getCompanyRealizedMonths(
  opts: { since?: string } = {}
): Promise<Record<Commodity, RealizedMonth[]>> {
  return memoScope(`company-realized-months:${opts.since ?? ""}`, async () => {
    const sb = await getRequestSupabase();
    // The ledger read `getRealizedMonths` makes does not depend on the
    // interests, so it is started here beside them (it is a memo hit inside).
    getTransactions(undefined, { ...opts, revenueOnly: true }).catch(() => {});
    const interests = await listAllInterests(sb);
    return getRealizedMonths(opts, netWeight(operatorNriByLease(interests), ASSUMED_NRI));
  });
}

/**
 * The company models and every lease's, from one ledger read.
 *
 * The ledger read is memoized per request scope, so a page that already loaded
 * transactions pays nothing extra here.
 */
export function getOrgRealization(): Promise<OrgRealization> {
  if (!hasSupabase()) return Promise.resolve(PRIOR_ORG);
  // Once per request: /prices reaches it from the page and again from the
  // projection, and each fit walked the ledger on its own.
  return memoScope("org-realization", loadOrgRealization);
}

async function loadOrgRealization(): Promise<OrgRealization> {
  const since = fitSince();
  const [transactions, months, oilHistory, gasHistory] = await Promise.all([
    // Revenue only: the fit skips every other kind (`accumulate`), so the
    // invoice projection the full ledger carries would be loaded and dropped.
    getTransactions(undefined, { since, revenueOnly: true }),
    getCompanyRealizedMonths({ since }),
    getPriceHistory("oil", "12M"),
    getPriceHistory("gas", "12M"),
  ]);
  return fitOrgRealization(transactions, months, oilHistory, gasHistory);
}
