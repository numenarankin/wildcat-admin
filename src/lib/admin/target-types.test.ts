import { describe, it, expect } from "vitest";
import { compareTargets, EMPTY_TARGET_FILTERS, filterTargets, targetRow, targetTotals, type TargetRow } from "./target-types";
import type { WellPricing } from "@/lib/billing/tiers";

/**
 * The Targets table's figures, against hand-computed values.
 *
 * Revenue: last-12 production ÷ the months it covered, at the given prices
 * (the map's operator hover does the same sum). Subscription: the Stripe
 * monthly well price applied to ACTIVE wells, the dashboard's own pricing;
 * the year is twelve of those months.
 */

const prices = { oilPerBbl: 60, gasPerMcf: 3 };

// Volume, like the live Stripe price (tiers.ts: "one tiered (volume) Price"):
// the whole count bills at the band it lands in, a flat amount for the first
// three bands and per well above 99.
const pricing: WellPricing = {
  month: {
    tiersMode: "volume",
    tiers: [
      { up_to: 24, flat_amount: 50000, unit_amount: null },
      { up_to: 49, flat_amount: 100000, unit_amount: null },
      { up_to: 99, flat_amount: 200000, unit_amount: null },
      { up_to: null, flat_amount: null, unit_amount: 2000 },
    ],
    unitAmount: null,
  },
  // Not read: Sub /yr is twelve months at the monthly price, not the annual one.
  year: { tiersMode: "volume", tiers: [], unitAmount: null },
};

const stored = { operatorNo: 123456, name: "ACME OIL", city: "MIDLAND", state: "TX", createdAt: "2026-10-08T00:00:00Z" };

describe("targetRow", () => {
  it("prices the trailing year per month and the subscription on active wells", () => {
    const row = targetRow(
      stored,
      { wells: { total: 40, active: 30 }, production: { oil: 12_000, gas: 6_000, months: 12 }, countyCodes: [329, 227] },
      prices,
      pricing
    );
    expect(row.counties).toEqual(["Midland", "Howard"]);
    // 1,000 bbl/mo × $60 + 500 MCF/mo × $3 = 61,500
    expect(row.revenueUsd).toBe(61_500);
    // 30 active wells is the 25–49 band: $1,000/mo. Total wells (40) is not what bills.
    expect(row.projectedUsd).toBe(1_000);
    expect(row.projectedYearUsd).toBe(12_000);
    expect(row.activeWells).toBe(30);
    expect(row.totalWells).toBe(40);
  });

  it("bills the top band per well", () => {
    const row = targetRow(stored, { wells: { total: 150, active: 120 } }, prices, pricing);
    expect(row.projectedUsd).toBe(120 * 20);
  });

  it("divides by the months actually reported, not twelve", () => {
    const row = targetRow(stored, { production: { oil: 900, gas: 0, months: 9 } }, prices, pricing);
    expect(row.revenueUsd).toBe(100 * 60);
  });

  it("reads zero wells and no price without live data", () => {
    const row = targetRow(stored, {}, prices, null);
    expect(row.activeWells).toBe(0);
    expect(row.revenueUsd).toBe(0);
    expect(row.projectedUsd).toBeNull();
    expect(row.projectedYearUsd).toBeNull();
  });
});

describe("compareTargets", () => {
  const base: TargetRow = {
    operatorNo: 1, name: "A", city: null, state: null, activeWells: 0, totalWells: 0,
    revenueUsd: 0, projectedUsd: 0, projectedYearUsd: 0, address: null, lng: null, lat: null, hqCountyCode: null, hqCounty: null, countyCodes: [], counties: [], createdAt: "2026-01-01T00:00:00Z",
  };
  it("sorts date added newest first by default direction", () => {
    const older = { ...base, createdAt: "2026-01-01T00:00:00Z" };
    const newer = { ...base, operatorNo: 2, createdAt: "2026-02-01T00:00:00Z" };
    expect([older, newer].sort((a, b) => compareTargets(a, b, "createdAt"))[0]).toBe(newer);
  });
  it("puts an unpriced target below every priced one", () => {
    const unpriced = { ...base, projectedUsd: null };
    const cheap = { ...base, operatorNo: 2, projectedUsd: 1 };
    expect([unpriced, cheap].sort((a, b) => compareTargets(a, b, "projectedUsd"))[0]).toBe(cheap);
  });
});

describe("targetTotals", () => {
  it("sums the subscription columns over the listed rows, unpriced as zero", () => {
    const base: TargetRow = {
      operatorNo: 1, name: "A", city: null, state: null, activeWells: 0, totalWells: 0,
      revenueUsd: 0, projectedUsd: 500, projectedYearUsd: 5_000, address: null, lng: null, lat: null, hqCountyCode: null, hqCounty: null, countyCodes: [], counties: [], createdAt: "2026-01-01T00:00:00Z",
    };
    const rows = [base, { ...base, operatorNo: 2, projectedUsd: 1_000, projectedYearUsd: 10_000 }, { ...base, operatorNo: 3, projectedUsd: null, projectedYearUsd: null }];
    expect(targetTotals(rows)).toEqual({ count: 3, monthUsd: 1_500, yearUsd: 15_000 });
  });
});

describe("filterTargets", () => {
  const base: TargetRow = {
    operatorNo: 1, name: "ACME OIL", city: "MIDLAND", state: "TX", activeWells: 30, totalWells: 30,
    revenueUsd: 50_000, projectedUsd: 1_000, projectedYearUsd: 10_000, address: null, lng: null, lat: null, hqCountyCode: 329, hqCounty: "Midland", countyCodes: [329], counties: ["Midland"],
    createdAt: "2026-01-01T00:00:00Z",
  };
  const small = { ...base, operatorNo: 2, name: "BETA ENERGY", city: "HOUSTON", activeWells: 5, revenueUsd: 2_000, hqCountyCode: 201, hqCounty: "Harris", countyCodes: [227], counties: ["Howard"] };
  const rows = [base, small];

  it("keeps everything with no filters", () => {
    expect(filterTargets(rows, EMPTY_TARGET_FILTERS)).toEqual(rows);
  });
  it("bounds revenue and wells inclusively", () => {
    expect(filterTargets(rows, { ...EMPTY_TARGET_FILTERS, minRevenue: 50_000 })).toEqual([base]);
    expect(filterTargets(rows, { ...EMPTY_TARGET_FILTERS, maxWells: 5 })).toEqual([small]);
  });
  it("matches the band by active wells", () => {
    expect(filterTargets(rows, { ...EMPTY_TARGET_FILTERS, tiers: ["tier_2"] })).toEqual([base]);
    expect(filterTargets(rows, { ...EMPTY_TARGET_FILTERS, tiers: ["tier_1", "tier_2"] })).toEqual(rows);
  });
  it("matches the HQ county, never where the wells are, and searches name or city", () => {
    expect(filterTargets(rows, { ...EMPTY_TARGET_FILTERS, counties: [201] })).toEqual([small]);
    expect(filterTargets(rows, { ...EMPTY_TARGET_FILTERS, counties: [227] })).toEqual([]);
    expect(filterTargets(rows, { ...EMPTY_TARGET_FILTERS, counties: [201, 329] })).toEqual(rows);
    expect(filterTargets(rows, { ...EMPTY_TARGET_FILTERS, query: "houston" })).toEqual([small]);
    expect(filterTargets(rows, { ...EMPTY_TARGET_FILTERS, query: "acme" })).toEqual([base]);
  });
});
