/**
 * Texas RRC monthly reporting — the PURE math (GBC-14).
 *
 * Two GreaseBook reports, both monthly and keyed per lease:
 *
 *   • TexasMonthlyReconciliationReport — our measured production vs. what the
 *     purchaser reports buying, per lease (oil runs vs purchaser oil sales; gas
 *     produced vs purchaser gas sales vs lease-use gas; differences + %).
 *   • TexasMonthlyWellDetailReport — a per-lease oil inventory + production
 *     statement formatted for RRC monthly (PR) filing (opening/closing balance,
 *     production, sales, disposition, gas, water, days online, production days).
 *
 * Everything here is dependency-free (types only — no DB, React, or I/O) so it
 * unit-tests directly against fixtures. The DB wrapper that assembles these
 * inputs from the ledger lives in `report-data.ts`.
 *
 * ── BLOCKED INPUTS (typed seams) ──────────────────────────────────────────
 * GBC-14 depends on two issues still in flight. Rather than fabricate their
 * data, every field they own is a nullable SEAM on the input interfaces below,
 * marked `SEAM (GBC-13)` / `SEAM (GBC-11)`. A null seam propagates to a null
 * output cell (renders "—"); a difference or percentage that needs a blocked
 * side is null until that side lands. When GBC-11/GBC-13 merge, fill these seams
 * in `report-data.ts` — the math here does not change.
 *
 *   • GBC-13 (purchaser statements): purchaser oil sales, purchaser gas sales,
 *     gas sales (distinct from gas produced).
 *   • GBC-11 (downtime → days online): days online, production days.
 */

/** A reporting month, ISO first-of-month `YYYY-MM-01`. */
export type Month = string;

/** Round to one decimal without dragging float noise into cells. */
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

// --- Small comparison primitives -------------------------------------------

/**
 * Signed percentage difference of `value` from a `reference` base:
 * `(value − reference) / reference × 100`, one decimal. Null when the reference
 * is null (a blocked seam) or zero (no meaningful base to divide by).
 */
export function percentDiff(
  value: number,
  reference: number | null
): number | null {
  if (reference == null || reference === 0) return null;
  return r1(((value - reference) / reference) * 100);
}

/**
 * A part as a percentage of a whole: `part / whole × 100`, one decimal. Null
 * when the part is null (a blocked seam couldn't be computed) or the whole is
 * zero. Used for "shrinkage as a % of gas produced".
 */
export function pctOf(part: number | null, whole: number): number | null {
  if (part == null || whole === 0) return null;
  return r1((part / whole) * 100);
}

// --- Gas balance -----------------------------------------------------------

/**
 * Inputs to a lease's monthly gas balance. `producedMcf` is the field meter and
 * `leaseUseMcf` is this issue's manual monthly field — both captured today.
 * `salesMcf` is the gas the purchaser reports buying, which GBC-13 (Statements)
 * supplies; null until then.
 */
export interface GasBalanceInput {
  /** Gas produced at the field meter, MCF. */
  producedMcf: number;
  /** SEAM (GBC-13): gas sold per the purchaser statement, MCF. null = unwired. */
  salesMcf: number | null;
  /** Manual monthly lease-use (on-lease fuel) gas, MCF (this issue's field). */
  leaseUseMcf: number;
}

/** A lease's monthly gas balance: Produced − Sales − Lease Use = shrinkage. */
export interface GasBalance {
  producedMcf: number;
  salesMcf: number | null;
  leaseUseMcf: number;
  /** `produced − sales − leaseUse`; null when sales is a blocked seam. */
  shrinkageMcf: number | null;
  /** Shrinkage as a % of produced; null when shrinkage is null or produced is 0. */
  shrinkagePct: number | null;
}

/**
 * The balancing identity behind both the wells gas-balance panel and the
 * reconciliation report's gas section: shrinkage is what's left after sales and
 * lease-use are removed from produced. With sales unavailable (GBC-13 seam),
 * shrinkage cannot be closed, so it (and its %) are null rather than a guess.
 */
export function gasBalance(input: GasBalanceInput): GasBalance {
  const { producedMcf, salesMcf, leaseUseMcf } = input;
  const shrinkageMcf =
    salesMcf == null ? null : r1(producedMcf - salesMcf - leaseUseMcf);
  return {
    producedMcf: r1(producedMcf),
    salesMcf: salesMcf == null ? null : r1(salesMcf),
    leaseUseMcf: r1(leaseUseMcf),
    shrinkageMcf,
    shrinkagePct: pctOf(shrinkageMcf, producedMcf),
  };
}

/** One month of a well's gas balance, for the wells/{id} gas-balance panel. */
export interface GasBalanceMonth extends GasBalance {
  month: Month;
}

// --- Reconciliation report (operator vs purchaser, per lease) ---------------

/**
 * One lease-month of reconciliation inputs. Oil runs and gas produced come from
 * the field (run tickets / readings); the purchaser sides are GBC-13 seams;
 * lease-use gas is this issue's field.
 */
export interface ReconciliationInput {
  /** Stable grouping/sort key (well id or lease id). */
  leaseKey: string;
  leaseName: string;
  month: Month;
  /** Oil sold, sourced from run tickets (GBC-5). Barrels. */
  oilSalesRunsBbls: number;
  /** SEAM (GBC-13): purchaser oil settlement, barrels. null = unwired. */
  purchaserOilSalesBbls: number | null;
  /** Gas produced at the field meter, MCF. */
  gasProducedMcf: number;
  /** SEAM (GBC-13): purchaser gas settlement, MCF. null = unwired. */
  purchaserGasSalesMcf: number | null;
  /** Manual monthly lease-use gas, MCF (this issue's field). */
  leaseUseGasMcf: number;
}

/** One reconciliation report row — the operator-vs-purchaser comparison. */
export interface ReconciliationRow {
  leaseKey: string;
  leaseName: string;
  month: Month;
  oilSalesRunsBbls: number;
  purchaserOilSalesBbls: number | null;
  /** `oilRuns − purchaserOil`; null when the purchaser side is a seam. */
  oilDifferenceBbls: number | null;
  /** % the operator's runs exceed the purchaser's figure; null when unwired. */
  oilPctDiff: number | null;
  gasProducedMcf: number;
  purchaserGasSalesMcf: number | null;
  leaseUseGasMcf: number;
  /** Gas shrinkage = produced − purchaserSales − leaseUse; null when unwired. */
  gasDifferenceMcf: number | null;
  /** Gas shrinkage as a % of produced; null when unwired. */
  gasPctDiff: number | null;
}

/** Reconcile one lease-month (operator field side vs purchaser settlement). */
export function reconcileLease(input: ReconciliationInput): ReconciliationRow {
  const oilDifferenceBbls =
    input.purchaserOilSalesBbls == null
      ? null
      : r1(input.oilSalesRunsBbls - input.purchaserOilSalesBbls);

  // The gas section IS the gas balance: difference = shrinkage.
  const gb = gasBalance({
    producedMcf: input.gasProducedMcf,
    salesMcf: input.purchaserGasSalesMcf,
    leaseUseMcf: input.leaseUseGasMcf,
  });

  return {
    leaseKey: input.leaseKey,
    leaseName: input.leaseName,
    month: input.month,
    oilSalesRunsBbls: r1(input.oilSalesRunsBbls),
    purchaserOilSalesBbls:
      input.purchaserOilSalesBbls == null
        ? null
        : r1(input.purchaserOilSalesBbls),
    oilDifferenceBbls,
    oilPctDiff: percentDiff(input.oilSalesRunsBbls, input.purchaserOilSalesBbls),
    gasProducedMcf: gb.producedMcf,
    purchaserGasSalesMcf: gb.salesMcf,
    leaseUseGasMcf: gb.leaseUseMcf,
    gasDifferenceMcf: gb.shrinkageMcf,
    gasPctDiff: gb.shrinkagePct,
  };
}

/** Build the reconciliation report, sorted by month (newest first) then lease. */
export function buildReconciliation(
  inputs: ReconciliationInput[]
): ReconciliationRow[] {
  return inputs
    .map(reconcileLease)
    .sort(
      (a, b) =>
        (a.month < b.month ? 1 : a.month > b.month ? -1 : 0) ||
        a.leaseName.localeCompare(b.leaseName) ||
        a.leaseKey.localeCompare(b.leaseKey)
    );
}

// --- Well detail report (RRC PR-style oil inventory statement) --------------

/**
 * Oil inventory closing balance from the monthly flow identity:
 * `closing = opening + production − sales − disposition`. This is the auditable
 * figure an RRC PR filing carries — a month's oil that came in (production) less
 * what left (sales + non-sale disposition), on top of the opening inventory.
 */
export function oilClosingBalance(
  openingBbls: number,
  productionBbls: number,
  salesBbls: number,
  dispositionBbls: number
): number {
  return openingBbls + productionBbls - salesBbls - dispositionBbls;
}

/**
 * One lease-month of well-detail inputs. Oil inventory + flows and gas/water
 * production are captured today (tank stock, run tickets, readings); gas SALES
 * and the day counts are blocked seams.
 */
export interface WellDetailInput {
  /** Stable grouping/sort key (well id). */
  leaseKey: string;
  leaseName: string;
  /** Lease/API filing number (GBC-6): RRC lease id, else API well #, else "". */
  leaseNumber: string;
  month: Month;
  /** Oil on hand at month open (tank stock before the month), barrels. */
  openingBalanceBbls: number;
  /** Oil produced in the month, barrels. */
  oilProductionBbls: number;
  /** Oil sold via run tickets (GBC-5), barrels. */
  oilSalesBbls: number;
  /** Non-sale oil off the lease (disposition run tickets, GBC-5), barrels. */
  oilDispositionBbls: number;
  /** Gas produced at the field meter, MCF. */
  gasProductionMcf: number;
  /** SEAM (GBC-13): gas sold (distinct from produced), MCF. null = unwired. */
  gasSalesMcf: number | null;
  /** Produced water in the month, barrels. */
  waterProductionBbls: number;
  /** SEAM (GBC-11): days the well was online in the month. null = unwired. */
  daysOnline: number | null;
  /** SEAM (GBC-11): producing days (downtime-adjusted). null = unwired. */
  productionDays: number | null;
}

/** One well-detail report row — a per-lease monthly oil inventory statement. */
export interface WellDetailRow extends WellDetailInput {
  /** `opening + production − sales − disposition`, barrels. */
  closingBalanceBbls: number;
}

/** Build a single well-detail row: derive the closing oil balance, round out. */
export function wellDetailRow(input: WellDetailInput): WellDetailRow {
  const closingBalanceBbls = r1(
    oilClosingBalance(
      input.openingBalanceBbls,
      input.oilProductionBbls,
      input.oilSalesBbls,
      input.oilDispositionBbls
    )
  );
  return {
    ...input,
    openingBalanceBbls: r1(input.openingBalanceBbls),
    oilProductionBbls: r1(input.oilProductionBbls),
    oilSalesBbls: r1(input.oilSalesBbls),
    oilDispositionBbls: r1(input.oilDispositionBbls),
    gasProductionMcf: r1(input.gasProductionMcf),
    gasSalesMcf: input.gasSalesMcf == null ? null : r1(input.gasSalesMcf),
    waterProductionBbls: r1(input.waterProductionBbls),
    closingBalanceBbls,
  };
}

/** Build the well-detail report, sorted by month (newest first) then lease. */
export function buildWellDetail(inputs: WellDetailInput[]): WellDetailRow[] {
  return inputs
    .map(wellDetailRow)
    .sort(
      (a, b) =>
        (a.month < b.month ? 1 : a.month > b.month ? -1 : 0) ||
        a.leaseName.localeCompare(b.leaseName) ||
        a.leaseKey.localeCompare(b.leaseKey)
    );
}
