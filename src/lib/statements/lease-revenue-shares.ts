import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { memo } from "@/lib/cache/request-cache";
import {
  cachedBatteryAllocation,
  cachedLeaseMeters,
  cachedMeterAllocationRows,
  cachedTanks,
} from "@/lib/cache/loaders";
import { meterDailySeries } from "@/lib/meters/engine";
import { tankTicketTotals } from "@/lib/tanks/run-tickets";
import {
  blendShares,
  loadRevenueWeighting,
  revenueShares,
  straightPeriodShares,
  type Period,
  type RevenuePoint,
  type RevenueWeighting,
} from "./revenue";

/**
 * A statement line that names a lease and no tank or meter.
 *
 * Revenue is a LEASE-level number: the purchaser settles the lease, and a tank
 * or meter number on the line is the exception, not the rule. So a line with
 * only a lease is not stuck there - it splits across the lease's wells through
 * the same battery / meter allocation the dashboard's well rows use.
 */
export interface LeasePoint {
  type: "lease";
  id: string;
  product: "oil" | "gas";
}

export type RevenueTarget = RevenuePoint | LeasePoint;

/** {@link revenueShares}, extended to the lease-only line. */
export function revenueSharesFor(
  sb: SupabaseClient,
  target: RevenueTarget,
  period: Period,
  weighting?: RevenueWeighting
): Promise<Map<string, number>> {
  return target.type === "lease"
    ? leaseRevenueShares(sb, target.id, target.product, period, weighting)
    : revenueShares(sb, target, period, weighting);
}

/**
 * Per-well shares of a lease's revenue for one product over a period: the same
 * battery / meter allocation math a tank- or meter-keyed line runs
 * ({@link straightPeriodShares}, downtime included), across every sale point
 * the lease has, blended by what each point sold ({@link blendShares}).
 *
 * Oil runs through the lease's oil tanks' batteries, weighted by run tickets
 * off those tanks in the period; gas through the lease's gas meters, weighted
 * by metered MCF. Memoised per lease, product and period: a well page with a
 * year of statements asks twelve times and reads once.
 */
export async function leaseRevenueShares(
  sb: SupabaseClient,
  leaseId: string,
  product: "oil" | "gas",
  period: Period,
  weighting?: RevenueWeighting
): Promise<Map<string, number>> {
  return memo(
    sb,
    `lease-revenue-shares:${leaseId}:${product}:${period.from}:${period.to}`,
    async () => {
      const w = weighting ?? (await loadRevenueWeighting(sb));
      if (product === "oil") {
        const tanks = (await cachedTanks(sb)).filter(
          (t) => t.leaseId === leaseId && t.product === "oil" && t.active && t.batteryId
        );
        const byBattery = new Map<string, string[]>();
        for (const t of tanks) {
          const at = byBattery.get(t.batteryId!) ?? [];
          at.push(t.id);
          byBattery.set(t.batteryId!, at);
        }
        const parts = await Promise.all(
          [...byBattery].map(async ([batteryId, tankIds]) => {
            const { allocations } = await cachedBatteryAllocation(sb, batteryId);
            const shares = straightPeriodShares(allocations, period, w.eventsByWell);
            // One battery needs no weight; only a lease selling from several
            // has to know how much each moved.
            const weight =
              byBattery.size === 1
                ? 1
                : (
                    await Promise.all(
                      tankIds.map((id) => tankTicketTotals(sb, id, period.from, period.to))
                    )
                  ).reduce((a, t) => a + t.total, 0);
            return { shares, weight };
          })
        );
        return blendShares(parts);
      }

      const meters = (await cachedLeaseMeters(sb, leaseId, "gas")).filter((m) => m.active);
      const parts = await Promise.all(
        meters.map(async (m) => {
          const rows = await cachedMeterAllocationRows(sb, m.id);
          const shares = straightPeriodShares(rows, period, w.eventsByWell);
          const weight =
            meters.length === 1
              ? 1
              : (await meterDailySeries(sb, m.id, period.from))
                  .filter((d) => d.date >= period.from && d.date <= period.to)
                  .reduce((a, d) => a + d.bbls, 0);
          return { shares, weight };
        })
      );
      return blendShares(parts);
    }
  );
}
