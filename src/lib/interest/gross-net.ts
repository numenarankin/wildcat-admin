/**
 * Volume-level Gross-vs-Net math (GBC-8): pure and dependency-free so it runs
 * in the browser (the View modal) and on the server (the export route) from one
 * source of truth, and is unit-testable in isolation.
 *
 * The interest model keeps the fractions DISTINCT (never conflated):
 *   - working_interest      (WI)  -> applied to COSTS elsewhere; here it's the
 *                                    Gross-Working-Interest (GWI) share of volume.
 *   - net_revenue_interest  (NRI) -> the revenue/volume share the ORG keeps,
 *                                    summed over every holding that belongs to
 *                                    the org (see `isHouseHolding`) whatever its
 *                                    type. NRI is DERIVED and never held: the
 *                                    types a holding can carry are WI, RI, ORRI
 *                                    and NPRI.
 *   - royalty interest      (RI)  -> the volume owed to THIRD-PARTY royalty and
 *                                    overriding-royalty holders, its own column
 *                                    so the org can see what leaves the lease
 *                                    before its own share.
 * This module applies those fractions to a well's GROSS volumes to produce the
 * Gross / GWI / NRI / RI columns for oil, oil sales, gas, and water.
 */

import type {
  InterestHolding,
  MonthlyWellVolumes,
} from "@/lib/interest/interest";

/**
 * A holding that belongs to the ORG rather than to a third party.
 *
 * Two kinds, and both are the user. `isOperator` is the operating position: the
 * entity that holds the P-5 and carries the liability, one row per lease.
 * `wiOwnerId` names one of the org's other legal entities (`org_wi_owners`) -
 * the working-interest-owning companies an operator splits its assets into.
 * That split is legal rather than functional, so a fraction held by either is a
 * fraction the user keeps.
 */
export function isHouseHolding(
  h: Pick<InterestHolding, "isOperator" | "wiOwnerId">
): boolean {
  return h.isOperator || h.wiOwnerId != null;
}

/** The org's aggregate interest fractions for one well. */
export interface WellVolumeInterest {
  /** Gross working interest: the org's share of raw volume (0..1). */
  gwi: number;
  /**
   * Net revenue interest: the share of revenue the ORG keeps (0..1), summed
   * over every house holding whatever its type. A working interest net of
   * royalties and an override the org bought are both money it keeps, so both
   * are in here.
   */
  nri: number;
  /**
   * Royalty interest: the RI + ORRI share of volume owed to THIRD PARTIES
   * (0..1). Royalty the org itself holds is not in here, it is in `nri`.
   * Absent on older callers, which report 0 rather than guessing.
   */
  ri?: number;
}

/**
 * Resolve a well's GWI/NRI from its interest holdings, applying the org's
 * position to volumes. WI and NRI are summed SEPARATELY so the two are never
 * conflated.
 *
 * The org's rows are the house holdings ({@link isHouseHolding}): the operator
 * row plus any held by one of the org's own companies. If none are flagged
 * (older data seeded before an operator holding was entered), fall back to the
 * working-interest rows (`interestType === "WI"`), which represent the
 * operating side, so a report still shows a sensible net where a WI row exists,
 * and a pure royalty ownership set yields GWI/NRI of 0 (gross-only), never
 * garbage.
 *
 * `gwi` needs no type test of its own: a royalty holding's `working_interest`
 * is 0 by definition, so an override the org bought moves the working figure by
 * nothing while still counting toward what the org keeps.
 */
export function wellVolumeInterest(
  holdings: InterestHolding[]
): WellVolumeInterest {
  const houseRows = holdings.filter(isHouseHolding);
  const rows =
    houseRows.length > 0
      ? houseRows
      : holdings.filter((h) => h.interestType === "WI");
  let gwi = 0;
  let nri = 0;
  for (const h of rows) {
    gwi += clamp(h.workingInterest);
    nri += clamp(h.netRevenueInterest);
  }
  // Royalty owed to OTHER PEOPLE, which is exactly what the org cannot see from
  // its own position. House rows are excluded: once the org can buy an override
  // on its own lease, counting that override here as well as in `nri` reports
  // the same barrels twice, once as revenue kept and once as volume that left.
  let ri = 0;
  for (const h of holdings) {
    if (isHouseHolding(h)) continue;
    if (h.interestType === "RI" || h.interestType === "ORRI") {
      ri += clamp(h.netRevenueInterest);
    }
  }
  return { gwi, nri, ri };
}

/** The parts of a holding that decide which fraction the holder owns. */
type HoldingShare = Pick<
  InterestHolding,
  "interestType" | "workingInterest" | "netRevenueInterest" | "isOperator"
>;

/**
 * Does this holder own a WORKING interest — a share of the well and its costs —
 * rather than a royalty off the top? The operator always does, whatever its row
 * says, because the operator row IS the operating position.
 */
export function isWorkingHolder(h: HoldingShare): boolean {
  return h.isOperator || h.interestType === "WI";
}

/**
 * The fraction this holder OWNS — what the lease's "Interest %" column shows.
 *
 * Which stored fraction that is depends on the type, and the two are never
 * conflated. A working-interest holder owns `working_interest`: their share of
 * the well, which is what costs are billed against. A royalty holder (RI / ORRI
 * / NPRI) owns no part of the well at all — what they own is a share of the
 * revenue, stored as `net_revenue_interest`, which is exactly the field
 * `wellVolumeInterest` above sums when it works out what leaves the lease. A
 * royalty holder's `working_interest` is 0 by definition, which is why a single
 * "Working %" column read as a table of zeros to anyone with royalty owners.
 */
export function ownedInterest(h: HoldingShare): number {
  return isWorkingHolder(h) ? h.workingInterest : h.netRevenueInterest;
}

/** A single stream's gross barrels/mcf split into Gross / GWI / NRI / RI. */
export interface StreamVolumes {
  gross: number;
  gwi: number;
  /** The org's net revenue volume: the part of this stream it keeps. */
  nri: number;
  /** Volume owed to THIRD-PARTY royalty + overriding-royalty holders. */
  ri: number;
}

/**
 * The ORG's net revenue interest in one lease, the share of that lease's
 * revenue it keeps, or NULL when the lease carries no position of the org's.
 *
 * Null rather than 0 on purpose. Zero is a claim (the org keeps nothing); a
 * lease nobody has entered interest for is an unknown, and every surface that
 * shows this must dash it rather than multiply money by it.
 *
 * A position is any house holding ({@link isHouseHolding}), so a lease where
 * the org holds nothing but an override it bought reports that override rather
 * than an unknown: the org does keep a share of that lease, and it is exactly
 * this figure.
 *
 * Resolution is `wellVolumeInterest`'s, so the NRI card, the roster's NRI
 * column, the net revenue estimates and the Gross/NRI volume columns all read
 * the org's position the same way, including a position held across several
 * rows and several of the org's companies.
 */
export function operatorNri(holdings: InterestHolding[]): number | null {
  const hasPosition = holdings.some(
    (h) => isHouseHolding(h) || h.interestType === "WI"
  );
  return hasPosition ? wellVolumeInterest(holdings).nri : null;
}

/**
 * {@link operatorNri} for many leases at once, keyed by lease id — what the
 * /leases roster needs from one read of every holding. Leases with no operating
 * position are ABSENT from the map rather than present as 0, keeping the same
 * unknown-is-not-zero distinction.
 */
/**
 * The interest a lease is netted at until someone records one: all of it. The
 * counterpart of the realization prior (`priorModel(1)`, the benchmark as-is),
 * so an account with no interests and no settlements still opens to a revenue
 * figure, gross until the data says otherwise. Every net revenue surface
 * (dashboard rows and card, /leases roster, lease page) nets through this;
 * the NRI columns themselves still show a dash, because those report what was
 * recorded.
 */
export const ASSUMED_NRI = 1;

export function operatorNriByLease(
  holdings: InterestHolding[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [leaseId, rows] of groupByLease(holdings)) {
    const nri = operatorNri(rows);
    if (nri != null) out[leaseId] = nri;
  }
  return out;
}

/**
 * {@link operatorNri} resolved per WELL, keyed by well id. Interest is held on
 * the lease, so a well inherits its lease's. Wells with no lease, or whose lease
 * carries no operating position, are ABSENT rather than 0 — the same
 * unknown-is-not-zero rule the per-lease map keeps.
 *
 * Distinct from `wellInterestFromLease`, which reports 0 for a lease whose
 * holdings are pure royalty. That is the right answer for a VOLUME column (the
 * operator's share of those barrels really is nothing) and the wrong one for a
 * revenue headline, where 0 and "nobody has entered the interest yet" must not
 * render as the same $0.
 */
export function operatorNriByWell(
  holdings: InterestHolding[],
  wellLease: Record<string, string | null>
): Record<string, number> {
  const byLease = operatorNriByLease(holdings);
  const out: Record<string, number> = {};
  for (const [wellId, leaseId] of Object.entries(wellLease)) {
    const nri = leaseId ? byLease[leaseId] : undefined;
    if (nri != null) out[wellId] = nri;
  }
  return out;
}

/**
 * The operator's effective NRI for a shared FACILITY (a meter or tank), blended
 * across the wells it is allocated to and weighted by their allocation shares.
 *
 * A meter's gas leaves through several wells, and those wells can sit on
 * different leases with different interest. What the operator keeps off that
 * meter is therefore the share-weighted average of its wells' NRIs, not any one
 * lease's figure.
 *
 * Weights are normalized by the shares actually present, so the result is an
 * average interest rather than a fraction of one: a split that has drifted off
 * 100% (or is expressed out of 1) must not quietly scale the money down.
 *
 * NULL when the facility has no allocated wells, when every share is zero, or
 * when ANY contributing well's NRI is unknown — a blend over the wells that
 * happen to have interest entered would understate what the rest are worth, and
 * the caller must dash rather than show a number built on the gap.
 */
export function facilityNri(
  shares: { wellId: string; pct: number }[],
  nriByWell: Record<string, number>
): number | null {
  const contributing = shares.filter((s) => s.pct > 0);
  if (contributing.length === 0) return null;
  let weight = 0;
  let weighted = 0;
  for (const s of contributing) {
    const nri = nriByWell[s.wellId];
    if (nri == null) return null;
    weight += s.pct;
    weighted += s.pct * nri;
  }
  return weight > 0 ? weighted / weight : null;
}

/** Apply the interest fractions to one gross volume figure. */
export function applyInterest(
  gross: number,
  interest: WellVolumeInterest
): StreamVolumes {
  const g = Number.isFinite(gross) ? gross : 0;
  return {
    gross: g,
    gwi: g * interest.gwi,
    nri: g * interest.nri,
    ri: g * (interest.ri ?? 0),
  };
}

/** The four production streams the Gross-vs-Net report covers. */
export interface StreamTotals {
  oil: number;
  oilSales: number;
  gas: number;
  water: number;
}

/** One facility (well) row of the Gross-vs-Net report. */
export interface GrossVsNetRow {
  wellId: string;
  wellName: string;
  gwi: number;
  nri: number;
  oil: StreamVolumes;
  oilSales: StreamVolumes;
  gas: StreamVolumes;
  water: StreamVolumes;
}

/** Build one facility row from its gross stream volumes + interest. */
export function buildGrossVsNetRow(
  wellId: string,
  wellName: string,
  gross: StreamTotals,
  interest: WellVolumeInterest
): GrossVsNetRow {
  return {
    wellId,
    wellName,
    gwi: interest.gwi,
    nri: interest.nri,
    oil: applyInterest(gross.oil, interest),
    oilSales: applyInterest(gross.oilSales, interest),
    gas: applyInterest(gross.gas, interest),
    water: applyInterest(gross.water, interest),
  };
}

/** The stream keys, in report column order. */
export const GROSS_NET_STREAMS = ["oil", "oilSales", "gas", "water"] as const;
export type GrossNetStream = (typeof GROSS_NET_STREAMS)[number];

/** Column labels (with units) for each stream. */
export const STREAM_LABELS: Record<GrossNetStream, string> = {
  oil: "Oil (bbl)",
  oilSales: "Oil Sales (bbl)",
  gas: "Gas (mcf)",
  water: "Water (bbl)",
};

/** Sum a set of facility rows into a company total row (interest left 0). */
export function totalGrossVsNet(rows: GrossVsNetRow[]): GrossVsNetRow {
  const zero = (): StreamVolumes => ({ gross: 0, gwi: 0, nri: 0, ri: 0 });
  const total: GrossVsNetRow = {
    wellId: "",
    wellName: "Total",
    gwi: 0,
    nri: 0,
    oil: zero(),
    oilSales: zero(),
    gas: zero(),
    water: zero(),
  };
  for (const r of rows) {
    for (const s of GROSS_NET_STREAMS) {
      total[s].gross += r[s].gross;
      total[s].gwi += r[s].gwi;
      total[s].nri += r[s].nri;
      total[s].ri += r[s].ri;
    }
  }
  return total;
}

/** Clamp a fraction to a finite, non-negative number. */
function clamp(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

// --- Report assembly (shared by the View modal and the export route) --------

/** Every holding bucketed by the lease it is held in. */
function groupByLease(
  holdings: InterestHolding[]
): Map<string, InterestHolding[]> {
  const grouped = new Map<string, InterestHolding[]>();
  for (const h of holdings) {
    const rows = grouped.get(h.leaseId);
    if (rows) rows.push(h);
    else grouped.set(h.leaseId, [h]);
  }
  return grouped;
}

/** Per-lease operator GWI/NRI, resolved from every holding grouped by lease. */
export function interestByLease(
  holdings: InterestHolding[]
): Record<string, WellVolumeInterest> {
  const out: Record<string, WellVolumeInterest> = {};
  for (const [leaseId, rows] of groupByLease(holdings)) {
    out[leaseId] = wellVolumeInterest(rows);
  }
  return out;
}

/**
 * Resolve per-WELL operator GWI/NRI from per-lease interest + a well→lease map.
 * Interest is held per lease; each well inherits its lease's interest. Wells
 * with no lease (or whose lease has no interest) get 0 (gross-only). Keeps the
 * Gross-vs-Net report per-well while ownership lives on the lease.
 */
export function wellInterestFromLease(
  byLease: Record<string, WellVolumeInterest>,
  wellLease: Record<string, string | null>
): Record<string, WellVolumeInterest> {
  const out: Record<string, WellVolumeInterest> = {};
  for (const [wellId, leaseId] of Object.entries(wellLease)) {
    if (leaseId && byLease[leaseId]) out[wellId] = byLease[leaseId];
  }
  return out;
}

/** The full data of one month's Gross-vs-Net report: facility rows + total. */
export interface GrossVsNetReport {
  month: string;
  rows: GrossVsNetRow[];
  total: GrossVsNetRow;
}

/**
 * Assemble one month's report from gross monthly volumes, per-well operator
 * interest, and a well-name lookup. Wells with production in the month are
 * included (interest defaults to 0 → gross-only) and sorted by name.
 */
export function assembleGrossVsNet(
  month: string,
  volumes: MonthlyWellVolumes[],
  interest: Record<string, WellVolumeInterest>,
  wellName: (wellId: string) => string
): GrossVsNetReport {
  const rows = volumes
    .filter((v) => v.month === month)
    .map((v) =>
      buildGrossVsNetRow(
        v.wellId,
        wellName(v.wellId) || v.wellId,
        { oil: v.oil, oilSales: v.oilSales, gas: v.gas, water: v.water },
        interest[v.wellId] ?? { gwi: 0, nri: 0 }
      )
    )
    .sort((a, b) => a.wellName.localeCompare(b.wellName));
  return { month, rows, total: totalGrossVsNet(rows) };
}

/** Distinct months present in a volume set, newest first. */
export function grossVsNetMonths(volumes: MonthlyWellVolumes[]): string[] {
  const set = new Set(volumes.map((v) => v.month));
  return [...set].sort((a, b) => (a < b ? 1 : -1));
}

// --- Typed interest validation ----------------------------------------------

/**
 * What a typed interest has to be: a fraction of the lease, not a percentage.
 * Shared by every field that takes one (the Add Interest modal, the interest
 * panel's editors) so the rule is stated once and identically.
 */
export const INTEREST_FRACTION_MESSAGE =
  "Interests are decimal fractions between 0 and 1 — enter 0.125 for 12.5%.";

/**
 * True when typed text is not a usable fraction. Blank is NOT invalid — it means
 * "leave the interest alone", which is different from claiming zero.
 */
export function isInterestFractionInvalid(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const n = Number(trimmed);
  return !Number.isFinite(n) || n > 1 || n < 0;
}

