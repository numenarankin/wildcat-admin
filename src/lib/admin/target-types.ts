import type { CommodityPrices } from "@/lib/analytics/types";
import { monthlyUsdForWells, type WellPricing } from "@/lib/billing/tiers";
import { perMonth } from "@/lib/scout/format";
import { monthlyRevenue } from "@/lib/scout/revenue";
import { COUNTY_NAMES } from "@/lib/scout/counties";
import { recommendTier, type TierKey } from "@/lib/billing/tiers";

/**
 * A prospecting target as the Targets table lists it. Pure derivation over
 * the stored identity + the live figures, so the numbers the table prints can
 * be checked by hand; `targets.ts` does the reads.
 */

/** What the map hands over when an operator is checked and added. */
export interface TargetInput {
  operatorNo: number;
  name: string;
  city: string | null;
  state: string | null;
}

export interface TargetRow {
  operatorNo: number;
  name: string;
  city: string | null;
  state: string | null;
  /** Active (non-plugged) wells, the count a subscription would bill. */
  activeWells: number;
  /** Every wellbore the operator holds, plugged included. */
  totalWells: number;
  /** Trailing-year production at today's prices, per month (`monthlyRevenue`). */
  revenueUsd: number;
  /**
   * What the operator would pay Wildcat per month: the Stripe monthly well
   * price applied to `activeWells`, the way a customer's own subscription is
   * priced. Null when the price could not be read.
   */
  projectedUsd: number | null;
  /** Twelve months of `projectedUsd`: the year at the monthly price. */
  projectedYearUsd: number | null;
  /** The P-5 mailing address's street line, from the operator points. */
  address: string | null;
  /** Where the P-5 mailing address is (its ZIP's centroid); null when unplaced. */
  lng: number | null;
  lat: number | null;
  /**
   * The county the P-5 mailing address (the HQ) is in: its ZIP centroid
   * placed on the Texas county outlines. Null outside Texas or unplaced.
   */
  hqCountyCode: number | null;
  hqCounty: string | null;
  /** RRC county codes where the operator holds wells, most wells first. */
  countyCodes: number[];
  /** The same as names (`COUNTY_NAMES`), in the same order. */
  counties: string[];
  createdAt: string;
}

export interface TargetLive {
  /** From the operator points file. */
  wells?: { total: number; active: number };
  /** The same file's mailing address and its placement. */
  address?: string | null;
  position?: { lng: number; lat: number };
  /** From `getOperatorsLast12`. */
  production?: { oil: number; gas: number; months: number };
  /** From `getOperatorCounties`, most wells first. */
  countyCodes?: number[];
  /** `countyAt` on `position`. */
  hqCountyCode?: number | null;
}

export function targetRow(
  stored: TargetInput & { createdAt: string },
  live: TargetLive,
  prices: CommodityPrices,
  pricing: WellPricing | null
): TargetRow {
  const activeWells = live.wells?.active ?? 0;
  const p = live.production;
  return {
    operatorNo: stored.operatorNo,
    name: stored.name,
    city: stored.city,
    state: stored.state,
    activeWells,
    totalWells: live.wells?.total ?? 0,
    address: live.address ?? null,
    lng: live.position?.lng ?? null,
    lat: live.position?.lat ?? null,
    revenueUsd: monthlyRevenue(
      perMonth(p?.oil, p?.months),
      perMonth(p?.gas, p?.months),
      prices
    ),
    projectedUsd: pricing ? monthlyUsdForWells(activeWells, pricing) : null,
    projectedYearUsd: pricing ? monthlyUsdForWells(activeWells, pricing) * 12 : null,
    hqCountyCode: live.hqCountyCode ?? null,
    hqCounty: live.hqCountyCode != null ? COUNTY_NAMES[live.hqCountyCode] ?? null : null,
    countyCodes: live.countyCodes ?? [],
    counties: (live.countyCodes ?? []).map((c) => COUNTY_NAMES[c] ?? String(c)),
    createdAt: stored.createdAt,
  };
}

export type TargetSortKey =
  | "name"
  | "county"
  | "activeWells"
  | "revenueUsd"
  | "projectedUsd"
  | "projectedYearUsd"
  | "createdAt";

/**
 * Descending order for a column. A target with no projected price sorts
 * below every priced one whichever way the column goes.
 */
export function compareTargets(a: TargetRow, b: TargetRow, key: TargetSortKey): number {
  switch (key) {
    case "name":
      return b.name.localeCompare(a.name);
    case "county":
      return (b.hqCounty ?? "").localeCompare(a.hqCounty ?? "");
    case "createdAt":
      return b.createdAt.localeCompare(a.createdAt);
    case "projectedUsd":
    case "projectedYearUsd":
      return (b[key] ?? -1) - (a[key] ?? -1);
    default:
      return b[key] - a[key];
  }
}

/** What the listed targets would pay in all: the Sub /mo and Sub /yr columns summed. */
export function targetTotals(rows: TargetRow[]): { count: number; monthUsd: number; yearUsd: number } {
  return {
    count: rows.length,
    monthUsd: rows.reduce((sum, r) => sum + (r.projectedUsd ?? 0), 0),
    yearUsd: rows.reduce((sum, r) => sum + (r.projectedYearUsd ?? 0), 0),
  };
}

/**
 * The Targets filter bar's state. A null bound is open; an empty list is
 * "any" (the map bar's rule: nothing ticked is not asking for nobody).
 */
export interface TargetFilters {
  /** Name or city contains this, case-insensitive. */
  query: string;
  minRevenue: number | null;
  maxRevenue: number | null;
  minWells: number | null;
  maxWells: number | null;
  /** Subscription bands by active wells (`recommendTier`). */
  tiers: TierKey[];
  /** RRC county codes; a target matches when its HQ is in ANY of them. */
  counties: number[];
}

export const EMPTY_TARGET_FILTERS: TargetFilters = {
  query: "",
  minRevenue: null,
  maxRevenue: null,
  minWells: null,
  maxWells: null,
  tiers: [],
  counties: [],
};

export function hasTargetFilters(f: TargetFilters): boolean {
  return (
    f.minRevenue != null ||
    f.maxRevenue != null ||
    f.minWells != null ||
    f.maxWells != null ||
    f.tiers.length > 0 ||
    f.counties.length > 0
  );
}

/** The rows a filter set keeps. Bounds are inclusive. */
export function filterTargets(rows: TargetRow[], f: TargetFilters): TargetRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter(
    (t) =>
      (!q || t.name.toLowerCase().includes(q) || (t.city ?? "").toLowerCase().includes(q)) &&
      (f.minRevenue == null || t.revenueUsd >= f.minRevenue) &&
      (f.maxRevenue == null || t.revenueUsd <= f.maxRevenue) &&
      (f.minWells == null || t.activeWells >= f.minWells) &&
      (f.maxWells == null || t.activeWells <= f.maxWells) &&
      (f.tiers.length === 0 || f.tiers.includes(recommendTier(t.activeWells).key)) &&
      (f.counties.length === 0 || (t.hqCountyCode != null && f.counties.includes(t.hqCountyCode)))
  );
}
