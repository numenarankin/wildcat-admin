import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getBatteryAllocationConfig } from "@/lib/batteries/actions";
import { listBatteries } from "@/lib/batteries/batteries";
import { getMeterAllocationConfig } from "@/lib/meters/actions";
import { listMeters } from "@/lib/meters/meters";
import { getLeases } from "@/lib/leases/actions";
import { getLeaseRoyaltyOwners } from "@/lib/people/people";
import { getTankAllocationConfig } from "@/lib/tanks/actions";
import { listTanks } from "@/lib/tanks/tanks";
import { cachedWellBatteries, cachedWellMeters } from "@/lib/cache/loaders";
import { getWells } from "@/lib/wells/wells";
import { formatHandle, type Handle } from "./handles";

/**
 * `links`: the typed edges out of one entity.
 *
 * Traversal is the thing the tool set has never had. "Where does this well's oil
 * go", "which wells feed this tank", "what is on this lease" are all one hop in
 * the data and several unrelated queries in the current tools, so the model
 * answers them by assembling list calls and guessing at membership.
 *
 * The edges are the ones that already exist: `wells.lease_id`, `tanks.battery_id`,
 * the three allocation tables, and the effective-lease cascade the loaders
 * already resolve. Nothing new is inferred here.
 *
 * Shares travel with the edge where there is one. A well on a battery at 40% and
 * a well on it at 5% are not the same relationship, and an edge list that hides
 * that invites an answer that treats them alike.
 */

type Sb = SupabaseClient;

export interface Edge {
  /** What the relationship is, from the subject's point of view. */
  rel: string;
  handle: string;
  name: string;
  /** Current allocation share, where the edge carries one. */
  pct?: number;
  detail?: string;
}

export interface LinksResult {
  handle: string;
  name: string;
  edges: Edge[];
  note?: string;
}

/**
 * The share in force TODAY, and how many periods stand behind it.
 *
 * An allocation is a dated timeline, not a number. Returning only the latest
 * period made a battery that ran 90/10 for five years and was re-split to 50/50
 * last month look as though it had always been 50/50 — so five years of
 * correctly-computed history read as though it disagreed with the config. It did
 * not. There was nothing to reconcile, and the answer said there was.
 *
 * So an edge carries the current share AND the period count, and anything above
 * one says out loud that the history is not this number. The full timeline is
 * `allocation_basis`; putting it on every edge would bury the traversal.
 */
function currentShares(
  periods: {
    effectiveFrom: string;
    effectiveTo?: string | null;
    shares: { wellId: string; pct: number }[];
  }[],
  today = new Date().toISOString().slice(0, 10)
): { shares: Map<string, number>; periods: number } {
  const inForce =
    periods.find(
      (p) => p.effectiveFrom <= today && (p.effectiveTo ?? "9999-12-31") >= today
    ) ?? [...periods].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  return {
    shares: new Map((inForce?.shares ?? []).map((s) => [s.wellId, s.pct])),
    periods: periods.length,
  };
}

export async function links(sb: Sb, handle: Handle): Promise<LinksResult> {
  const [wells, leases, tanks, batteries, meters] = await Promise.all([
    getWells(),
    getLeases(),
    listTanks(sb),
    listBatteries(sb),
    listMeters(sb, "all"),
  ]);
  const wellName = new Map(wells.map((w) => [w.id, w.name]));
  // A lease edge naming a uuid is unreadable and unciteable. The lease roster is
  // already loaded, so the name is free.
  const leaseName = new Map(
    leases.map((l) => [l.id, (l.name || l.leaseNo || l.id).trim()])
  );
  const tankName = new Map(tanks.map((t) => [t.id, t.name]));
  const batteryName = new Map(batteries.map((b) => [b.id, b.name]));
  const meterName = new Map(meters.map((m) => [m.id, m.name]));

  const edges: Edge[] = [];
  const subjectName =
    wellName.get(handle.id) ??
    leaseName.get(handle.id) ??
    tankName.get(handle.id) ??
    batteryName.get(handle.id) ??
    meterName.get(handle.id) ??
    handle.id;

  if (handle.type === "well") {
    const well = wells.find((w) => w.id === handle.id);
    if (!well) return { handle: formatHandle("well", handle.id), name: handle.id, edges: [], note: "No such well." };

    if (well.leaseId) {
      edges.push({
        rel: "on lease",
        handle: formatHandle("lease", well.leaseId),
        name: leaseName.get(well.leaseId) ?? well.leaseId,
      });
    }

    const [batteryIds, meterIds] = await Promise.all([
      cachedWellBatteries(sb, handle.id),
      cachedWellMeters(sb, handle.id),
    ]);

    // The share is what makes this edge actionable: it is the divisor behind
    // every allocated number the well reports.
    //
    // Every config is fetched at once: a well on four batteries and three meters
    // was seven round trips stacked end to end, and none of them depends on
    // another.
    const [batteryConfigs, meterConfigs] = await Promise.all([
      Promise.all(batteryIds.map((id) => getBatteryAllocationConfig(id))),
      Promise.all(meterIds.map((id) => getMeterAllocationConfig(id))),
    ]);

    for (const [i, batteryId] of batteryIds.entries()) {
      const config = batteryConfigs[i];
      const { shares, periods } = currentShares(config.periods);
      const pct = shares.get(handle.id);
      edges.push({
        rel: "produces oil to battery",
        handle: formatHandle("battery", batteryId),
        name: batteryName.get(batteryId) ?? batteryId,
        ...(pct === undefined ? {} : { pct }),
        ...(periods > 1
          ? {
              detail: `${pct}% today, across ${periods} dated periods — earlier production was split differently. Call allocation_basis before explaining any historical figure.`,
            }
          : {}),
      });
      for (const tank of tanks.filter((t) => t.batteryId === batteryId)) {
        edges.push({
          rel: `oil tank on that battery`,
          handle: formatHandle("tank", tank.id),
          name: tank.name,
          detail: tank.product,
        });
      }
    }

    for (const [i, meterId] of meterIds.entries()) {
      const config = meterConfigs[i];
      const { shares, periods } = currentShares(config.periods);
      const pct = shares.get(handle.id);
      const meter = meters.find((m) => m.id === meterId);
      edges.push({
        rel: `produces ${meter?.substance ?? "gas"} to meter`,
        handle: formatHandle("meter", meterId),
        name: meterName.get(meterId) ?? meterId,
        ...(pct === undefined ? {} : { pct }),
        ...(periods > 1
          ? {
              detail: `${pct}% today, across ${periods} dated periods. Call allocation_basis before explaining any historical figure.`,
            }
          : {}),
      });
    }

    return {
      handle: formatHandle("well", handle.id),
      name: well.name,
      edges,
      ...(batteryIds.length === 0 && meterIds.length === 0
        ? {
            note: "This well is on no battery and no meter, so nothing measures its production. Any production figure for it will be empty, which is a wiring gap rather than a dry well.",
          }
        : {}),
    };
  }

  if (handle.type === "battery") {
    const battery = batteries.find((b) => b.id === handle.id);
    if (!battery) return { handle: formatHandle("battery", handle.id), name: handle.id, edges: [] };
    if (battery.leaseId) {
      edges.push({
        rel: "on lease",
        handle: formatHandle("lease", battery.leaseId),
        name: leaseName.get(battery.leaseId) ?? battery.leaseId,
      });
    }
    for (const tank of tanks.filter((t) => t.batteryId === handle.id)) {
      edges.push({ rel: "holds tank", handle: formatHandle("tank", tank.id), name: tank.name, detail: tank.product });
    }
    const config = await getBatteryAllocationConfig(handle.id);
    const { shares, periods } = currentShares(config.periods);
    for (const wellId of config.memberWellIds) {
      edges.push({
        rel: "allocates oil to well",
        handle: formatHandle("well", wellId),
        name: wellName.get(wellId) ?? wellId,
        ...(shares.has(wellId) ? { pct: shares.get(wellId) } : {}),
      });
    }
    return {
      handle: formatHandle("battery", handle.id),
      name: battery.name,
      edges,
      ...(periods > 1
        ? {
            note: `These shares are the period in force today. This battery has ${periods} dated allocation periods, so a figure from an earlier month was split differently — allocation_basis has the timeline.`,
          }
        : {}),
    };
  }

  if (handle.type === "tank") {
    const tank = tanks.find((t) => t.id === handle.id);
    if (!tank) return { handle: formatHandle("tank", handle.id), name: handle.id, edges: [] };
    if (tank.batteryId) {
      edges.push({
        rel: "on battery",
        handle: formatHandle("battery", tank.batteryId),
        name: batteryName.get(tank.batteryId) ?? tank.batteryId,
      });
    }
    if (tank.leaseId) {
      edges.push({
        rel: "on lease",
        handle: formatHandle("lease", tank.leaseId),
        name: leaseName.get(tank.leaseId) ?? tank.leaseId,
      });
    }
    if (tank.gathererId) {
      edges.push({ rel: "hauled by", handle: formatHandle("gatherer", tank.gathererId), name: tank.gatherer });
    }
    const config = await getTankAllocationConfig(handle.id);
    for (const a of config.allocations) {
      edges.push({
        rel: "allocates to well",
        handle: formatHandle("well", a.wellId),
        name: wellName.get(a.wellId) ?? a.wellId,
        pct: a.straightPct,
      });
    }
    return {
      handle: formatHandle("tank", handle.id),
      name: tank.name,
      edges,
      ...(tank.batteryId
        ? {}
        : {
            note: "This tank is on no battery. Oil allocation lives at the battery, so a standalone tank's production reaches no well.",
          }),
    };
  }

  if (handle.type === "meter") {
    const meter = meters.find((m) => m.id === handle.id);
    if (!meter) return { handle: formatHandle("meter", handle.id), name: handle.id, edges: [] };
    if (meter.leaseId) {
      edges.push({
        rel: "on lease",
        handle: formatHandle("lease", meter.leaseId),
        name: leaseName.get(meter.leaseId) ?? meter.leaseId,
      });
    }
    if (meter.gathererId) {
      edges.push({ rel: "gathered by", handle: formatHandle("gatherer", meter.gathererId), name: meter.gatherer });
    }
    const config = await getMeterAllocationConfig(handle.id);
    const { shares } = currentShares(config.periods);
    for (const [wellId, pct] of shares) {
      edges.push({
        rel: `allocates ${meter.substance} to well`,
        handle: formatHandle("well", wellId),
        name: wellName.get(wellId) ?? wellId,
        pct,
      });
    }
    return { handle: formatHandle("meter", handle.id), name: meter.name, edges };
  }

  if (handle.type === "lease") {
    for (const well of wells.filter((w) => w.leaseId === handle.id)) {
      edges.push({
        rel: "holds well",
        handle: formatHandle("well", well.id),
        name: well.name,
        detail: well.type === "injection" ? "injection" : "producer",
      });
    }
    for (const battery of batteries.filter((b) => b.leaseId === handle.id)) {
      edges.push({ rel: "holds battery", handle: formatHandle("battery", battery.id), name: battery.name });
    }
    for (const tank of tanks.filter((t) => t.leaseId === handle.id)) {
      edges.push({ rel: "holds tank", handle: formatHandle("tank", tank.id), name: tank.name, detail: tank.product });
    }
    for (const meter of meters.filter((m) => m.leaseId === handle.id)) {
      edges.push({
        rel: "holds meter",
        handle: formatHandle("meter", meter.id),
        name: meter.name,
        detail: meter.substance,
      });
    }
    for (const owner of await getLeaseRoyaltyOwners(handle.id)) {
      edges.push({ rel: "royalty owner", handle: formatHandle("owner", owner.id), name: owner.name });
    }
    return { handle: formatHandle("lease", handle.id), name: subjectName, edges };
  }

  return {
    handle: formatHandle(handle.type, handle.id),
    name: subjectName,
    edges: [],
    note: `No edges are defined for a ${handle.type} yet. Edges exist for well, lease, tank, battery and meter.`,
  };
}
