import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRevenueWeighting } from "./revenue";
import { listAllInterests } from "@/lib/interest/interest";
import { ASSUMED_NRI, operatorNriByLease } from "@/lib/interest/gross-net";
import { revenueSharesFor, type RevenueTarget } from "./lease-revenue-shares";
import {
  asLineProduct,
  asStatus,
  pointsForWell,
  type WellPurchaserSale,
} from "./statements";

type Sb = SupabaseClient;

interface SalesLineRow {
  tank_id: string | null;
  meter_id: string | null;
  lease_id: string | null;
  statement_id: string;
  product: string | null;
  volume: number | null;
  price: number | null;
  gross_value: number | null;
  net_value: number | null;
  statements: {
    period_start: string;
    period_end: string;
    status: string | null;
    purchasers: { name: string | null } | null;
  } | null;
}

const SALES_COLS =
  "tank_id, meter_id, lease_id, statement_id, product, volume, price, gross_value, net_value, " +
  "statements(period_start, period_end, status, purchasers(name))";

/**
 * Read-only purchaser-sales slice for a well: every statement line whose money
 * reaches the well, newest statement first, with volume and net scaled by the
 * well's share of that line over the statement's period. Backs the well page's
 * Revenue tab.
 *
 * Two kinds of line reach a well. One keyed to a tank or meter that allocates
 * to it, split at that point. One keyed to the well's LEASE and nothing finer -
 * the common shape, since a purchaser settles the lease - split across the
 * lease's wells through the same allocation (`leaseRevenueShares`). Same
 * derivation as the ledger's per-well rows, so the two agree.
 */
export async function getWellPurchaserSales(
  sb: Sb,
  wellId: string
): Promise<WellPurchaserSale[]> {
  const [{ tankIds, meterIds }, leaseId, holdings] = await Promise.all([
    pointsForWell(sb, wellId),
    wellLeaseId(sb, wellId),
    listAllInterests(sb),
  ]);
  if (tankIds.length === 0 && meterIds.length === 0 && !leaseId) return [];
  // The well's lease's NRI, the same figure the lease tables net by. Null when
  // none is entered: the column dashes, the net revenue assumes the whole.
  const nri = leaseId ? (operatorNriByLease(holdings)[leaseId] ?? null) : null;

  const queries: PromiseLike<{ data: unknown; error: unknown }>[] = [];
  if (tankIds.length > 0) {
    queries.push(
      sb.from("statement_line_items").select(SALES_COLS).is("deleted_at", null).in("tank_id", tankIds)
    );
  }
  if (meterIds.length > 0) {
    queries.push(
      sb.from("statement_line_items").select(SALES_COLS).is("deleted_at", null).in("meter_id", meterIds)
    );
  }
  if (leaseId) {
    queries.push(
      sb
        .from("statement_line_items")
        .select(SALES_COLS)
        .is("deleted_at", null)
        .eq("lease_id", leaseId)
        .is("tank_id", null)
        .is("meter_id", null)
    );
  }
  const results = await Promise.all(queries);
  const lines: SalesLineRow[] = [];
  for (const res of results) {
    if (res.error) throw new Error(`getWellPurchaserSales: ${String(res.error)}`);
    lines.push(...((res.data ?? []) as unknown as SalesLineRow[]));
  }

  const weighting = await loadRevenueWeighting(sb);
  const out: WellPurchaserSale[] = [];
  for (const l of lines) {
    const period = {
      from: l.statements?.period_start ?? "",
      to: l.statements?.period_end ?? "",
    };
    if (!period.from || !period.to) continue;
    const product = asLineProduct(l.product);
    const target: RevenueTarget | null = l.tank_id
      ? { type: "tank", id: l.tank_id, wellId }
      : l.meter_id
        ? { type: "meter", id: l.meter_id, wellId }
        : l.lease_id
          ? { type: "lease", id: l.lease_id, product }
          : null;
    if (!target) continue;
    const shares = await revenueSharesFor(sb, target, period, weighting);
    const share = shares.get(wellId) ?? 0;
    if (share <= 0) continue;
    const volume = l.volume ?? 0;
    const net = l.net_value ?? 0;
    // Gross is what the purchaser printed; a line captured without one is
    // volume × price. A gas line prints no $/MCF, so its price is gross ÷ volume.
    const gross = l.gross_value ?? (l.price != null ? volume * l.price : net);
    const price = l.price ?? (volume > 0 ? gross / volume : null);
    const netValue = net * share;
    out.push({
      statementId: l.statement_id,
      purchaser: l.statements?.purchasers?.name ?? "",
      periodStart: period.from,
      periodEnd: period.to,
      status: asStatus(l.statements?.status),
      product,
      volume: volume * share,
      price,
      grossValue: gross * share,
      deductions: (gross - net) * share,
      netValue,
      nri,
      netRevenue: netValue * (nri ?? ASSUMED_NRI),
    });
  }
  return out.sort((a, b) => b.periodStart.localeCompare(a.periodStart));
}

/** The lease a well sits on, or null. */
async function wellLeaseId(sb: Sb, wellId: string): Promise<string | null> {
  const { data, error } = await sb.from("wells").select("lease_id").eq("id", wellId).maybeSingle();
  if (error) throw new Error(`getWellPurchaserSales: ${error.message}`);
  return (data as { lease_id: string | null } | null)?.lease_id ?? null;
}
