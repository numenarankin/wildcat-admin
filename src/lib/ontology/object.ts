import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listBatteries } from "@/lib/batteries/batteries";
import { getLeases } from "@/lib/leases/actions";
import { listMeters } from "@/lib/meters/meters";
import { listTanks } from "@/lib/tanks/tanks";
import { getWells } from "@/lib/wells/wells";
import { formatHandle, type Handle } from "./handles";
import { loadRoster } from "./entities";
import { measure, METRICS, type Metric } from "./measure";

/**
 * `object`: everything known about one entity, in one call.
 *
 * Describing a well currently costs eight tool calls, and the model assembles
 * the picture in prose between them. Each hop is a chance to attach a number to
 * the wrong entity, and the last hop is where the model runs out of patience and
 * starts inferring. One fat bundle is cheaper than the round trips and leaves
 * nothing to infer.
 *
 * The rates come through `measure`, not through the static columns on `wells`.
 * `wells.oil_production`, `gas_production`, `salt_water`, `revenue` and `pl` are
 * hand-entered fields that predate the production engines and disagree with
 * them; reporting one here would put a stale number in front of the model with
 * the authority of the well's own record.
 */

type Sb = SupabaseClient;

/** How far back the headline rates look. */
export const RATE_WINDOW_DAYS = 90;

export interface CurrentRate {
  metric: Metric;
  unit: string;
  /** Average over the whole window, including days with no production. */
  perDay: number | null;
  /**
   * Rate over the days the entity actually produced.
   *
   * Higher than `perDay` whenever the window is thinner than the data, and the
   * gap between them is itself the signal: a well at 6 while producing and 0.67
   * across the window has been down for most of it.
   */
  whileProducing: number | null;
  basis: string;
  windowDays: number;
}

export interface ObjectResult {
  handle: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  rates?: CurrentRate[];
  note?: string;
}

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD`, `days` before `asOf`. UTC so a timezone cannot shift the window. */
function daysBefore(asOf: Date, days: number): string {
  return new Date(asOf.getTime() - days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The trailing rate for each metric the entity can carry.
 *
 * A metric the entity cannot be measured for is omitted rather than reported as
 * null, because "no gas figure exists for a tank" and "this tank made no gas"
 * are different statements and only one of them is true.
 */
async function currentRates(
  sb: Sb,
  handle: Handle,
  metrics: readonly Metric[],
  asOf: Date
): Promise<CurrentRate[]> {
  // Inclusive of both ends, so the window is RATE_WINDOW_DAYS long and not one
  // more. Off by one here would divide a 90-day total by 91 while the result
  // says `windowDays: 90`, which is a small error that cannot be checked by
  // anyone reading the output.
  const from = daysBefore(asOf, RATE_WINDOW_DAYS - 1);
  const to = asOf.toISOString().slice(0, 10);
  const out = await Promise.all(
    metrics.map(async (metric) => {
      const result = await measure(sb, handle, metric, { from, to, grain: "month" });
      return {
        metric,
        unit: result.unit,
        perDay: result.perWindowDay,
        whileProducing: result.perDay,
        basis: result.basis,
        windowDays: RATE_WINDOW_DAYS,
      };
    })
  );
  return out;
}

export async function describeObject(
  sb: Sb,
  handle: Handle,
  asOf: Date = new Date()
): Promise<ObjectResult> {
  const base = { handle: formatHandle(handle.type, handle.id), type: handle.type };

  if (handle.type === "well") {
    const well = (await getWells()).find((w) => w.id === handle.id);
    if (!well) return { ...base, name: handle.id, properties: {}, note: "No such well." };
    const leases = await getLeases();
    const lease = leases.find((l) => l.id === well.leaseId);
    return {
      ...base,
      name: well.name,
      properties: {
        wellType: well.type,
        active: well.active,
        lease: lease ? { handle: formatHandle("lease", lease.id), name: lease.name } : null,
        county: well.county,
        zone: well.zone,
        perforations: well.perforations,
        depthFt: well.depth,
        dateDrilled: well.dateDrilled,
        apiWellNo: well.apiWellNo,
        rrcLeaseId: well.rrcLeaseId,
        coordinates: well.coordinates,
      },
      rates: await currentRates(sb, handle, METRICS, asOf),
    };
  }

  if (handle.type === "lease") {
    const lease = (await getLeases()).find((l) => l.id === handle.id);
    if (!lease) return { ...base, name: handle.id, properties: {}, note: "No such lease." };
    return {
      ...base,
      name: lease.name || lease.leaseNo,
      properties: {
        leaseNo: lease.leaseNo,
        county: lease.county,
        active: lease.active,
        wellCount: lease.wellCount,
        tankCount: lease.tankCount,
        meterCount: lease.meterCount,
      },
      rates: await currentRates(sb, handle, METRICS, asOf),
    };
  }

  if (handle.type === "tank") {
    const tank = (await listTanks(sb)).find((t) => t.id === handle.id);
    if (!tank) return { ...base, name: handle.id, properties: {}, note: "No such tank." };
    return {
      ...base,
      name: tank.name,
      properties: {
        product: tank.product,
        tankNo: tank.tankNo,
        battery: tank.battery,
        batteryId: tank.batteryId,
        gatherer: tank.gatherer,
        capacityBbls: tank.capacityBbls,
        bblPerInch: tank.bblPerInch,
        active: tank.active,
      },
      // Only an oil tank has a production series; a water tank's volume reaches
      // the model through the water metric on its wells.
      rates:
        tank.product === "oil" ? await currentRates(sb, handle, ["oil"], asOf) : undefined,
    };
  }

  if (handle.type === "battery") {
    const battery = (await listBatteries(sb)).find((b) => b.id === handle.id);
    if (!battery) return { ...base, name: handle.id, properties: {}, note: "No such battery." };
    return {
      ...base,
      name: battery.name,
      properties: {
        tankCount: battery.tankCount,
        leaseId: battery.leaseId,
        active: battery.active,
      },
      rates: await currentRates(sb, handle, ["oil"], asOf),
    };
  }

  if (handle.type === "meter") {
    const meter = (await listMeters(sb, "all")).find((m) => m.id === handle.id);
    if (!meter) return { ...base, name: handle.id, properties: {}, note: "No such meter." };
    return {
      ...base,
      name: meter.name,
      properties: {
        substance: meter.substance,
        meterNo: meter.meterNo,
        gatherer: meter.gatherer,
        leaseId: meter.leaseId,
        allocationMethod: meter.method,
        active: meter.active,
      },
    };
  }

  // People and counterparties: the roster already carries the identity and the
  // one-line detail, and there is nothing further to load for them.
  const { candidates } = await loadRoster(sb);
  const found = candidates.find((c) => c.type === handle.type && c.id === handle.id);
  if (!found) {
    return { ...base, name: handle.id, properties: {}, note: `No such ${handle.type}.` };
  }
  return { ...base, name: found.name, properties: { detail: found.detail ?? null } };
}
