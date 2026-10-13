/** Pricing-page shared types. Pure module, safe on client and server. */

export type Commodity = "oil" | "gas";

/** A single dated price (ISO date string, USD). */
export interface PricePoint {
  date: string;
  price: number;
}

/** Per-commodity display metadata for the pricing page. */
export interface CommodityMeta {
  commodity: Commodity;
  /** Tab/toggle label, e.g. "Oil". */
  label: string;
  /** Benchmark series name, e.g. "WTI". */
  benchmark: string;
  /** Price unit suffix, e.g. "/bbl". */
  unit: string;
  /** Line color for the posted-price series. */
  postedColor: string;
}

export const COMMODITIES: Record<Commodity, CommodityMeta> = {
  oil: {
    commodity: "oil",
    label: "Oil",
    benchmark: "WTI",
    unit: "/bbl",
    postedColor: "#059669",
  },
  gas: {
    commodity: "gas",
    label: "Gas",
    benchmark: "Henry Hub",
    unit: "/MCF",
    postedColor: "#800000",
  },
};
