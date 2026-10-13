"use server";

/**
 * Facilities page data-access — assembles the cross-substance facility graph from
 * the existing facility tables + allocation wiring, then hands it to the pure
 * `buildFacilityGraph`. Reads go through the request-scoped RLS client so every
 * facility and allocation is org-scoped by its own policies.
 *
 * Allocation edges are filtered to those ACTIVE today (`effective_from <= today`
 * and `effective_to` null or in the future) so the map shows current wiring, not
 * historical splits.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/permissions";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getWells } from "@/lib/wells/wells";
import { getCompanyRates } from "@/lib/analytics/company-rates";
import { invalidateWellProductionRates } from "@/lib/wells/rate-cache";
import { getTanks, getTankLevels } from "@/lib/tanks/actions";
import { listMeterReadings, listMeters } from "@/lib/meters/meters";
import { swdMeterDailyBbls, swdMeterStats } from "@/lib/meters/swd-meters";
import { latestDailyEma } from "@/lib/wells/arps";
import {
  partialTailDate,
  withoutPartialTail,
} from "@/lib/production/partial-day";
import { getBatteries } from "@/lib/batteries/actions";
import { ensureBatteryMembership } from "@/lib/batteries/allocations";
import { fillPercent } from "@/lib/tanks/capacity";
import { getLeases } from "@/lib/leases/actions";
import { getGatherers } from "@/lib/people/people";
import { getLeaseOptions } from "@/lib/leases/actions";
import type { FacilityCatalog } from "@/components/facilities/facility-create-menu";
import { loadDisposalSeriesByWell } from "@/lib/disposal/well-meters";
import { getFleetPermittedRates } from "@/lib/rrc/link";
import { meterDailySeries } from "@/lib/meters/engine";
import {
  buildFacilityGraph,
  type FacilityGraph,
  type GraphAllocation,
} from "@/lib/facilities/graph";
import { withFlowConnections } from "@/lib/facilities/flow-edges";
import {
  insertFlowConnections,
  deleteFlowConnections,
  updateFlowConnection,
  listFlowConnections,
} from "@/lib/flow/connections";
import { loadEffectiveFlowConnections } from "@/lib/flow/effective-water";
import type {
  FlowConnection,
  FlowNodeType,
  FlowSubstance,
} from "@/lib/flow/types";
import { activeConnections, attributeToWells } from "@/lib/flow/graph";
import {
  planWaterMeterWiring,
  type WaterMeterPicks,
} from "@/lib/facilities/meter-wiring";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Operator-drawn `flow_connections` active today, or [] if the table isn't there
 * yet (the migration is applied separately). Degrading gracefully keeps the map
 * working pre-migration instead of 500-ing on a missing relation.
 */
async function activeFlowConnections(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
): Promise<FlowConnection[]> {
  const t = today();
  try {
    const all = await loadEffectiveFlowConnections(sb);
    return all.filter(
      (c) =>
        c.effectiveFrom <= t && (c.effectiveTo == null || c.effectiveTo >= t),
    );
  } catch {
    return [];
  }
}

/** Active-today rows from one `*_well_allocations` table, normalized. */
async function activeAllocations(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  table:
    | "tank_well_allocations"
    | "meter_well_allocations"
    | "battery_well_allocations",
  facilityCol: "tank_id" | "meter_id" | "battery_id",
): Promise<GraphAllocation[]> {
  const t = today();
  const { data, error } = await sb
    .from(table)
    .select(
      `${facilityCol}, well_id, straight_pct, effective_from, effective_to`,
    )
    .lte("effective_from", t)
    .or(`effective_to.is.null,effective_to.gte.${t}`);
  if (error) throw new Error(`activeAllocations(${table}): ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    facilityId: String(r[facilityCol]),
    wellId: String(r.well_id),
    straightPct: Number(r.straight_pct) || 0,
  }));
}

/**
 * The refresh button on the map.
 *
 * `router.refresh()` alone re-renders the page against whatever the caches
 * already hold, and the per-well rates behind every card are cached in
 * `well_production_rates` for fifteen minutes — so a soft refresh could show
 * numbers a browser reload would also show, but neither is what the operator
 * pressed the button for. This drops those rows first, so the next render
 * re-derives every rate from the readings. That makes the button STRONGER than a
 * hard reload, which is the only sensible thing for a control labelled refresh.
 */
export async function refreshFacilities(): Promise<void> {
  await requirePermission(["view_facilities"]);
  const sb = await getSupabaseServer();
  await invalidateWellProductionRates(sb);
  revalidatePath("/facilities");
}

/** The org's full facility graph for the Facilities canvas. */
export async function getFacilityGraph(): Promise<FacilityGraph> {
  await requirePermission(["view_facilities"]);
  const sb = await getSupabaseServer();

  const [
    wells,
    tanks,
    meters,
    batteries,
    leases,
    gatherers,
    tankAlloc,
    meterAlloc,
    batteryAlloc,
    flowConns,
  ] = await Promise.all([
    getWells(),
    getTanks(),
    // All meters: gas meters are cards, water meters are wiring the builder
    // splices connections across (they are not drawn).
    listMeters(sb, "all"),
    getBatteries(),
    getLeases(),
    getGatherers(),
    activeAllocations(sb, "tank_well_allocations", "tank_id"),
    activeAllocations(sb, "meter_well_allocations", "meter_id"),
    activeAllocations(sb, "battery_well_allocations", "battery_id"),
    activeFlowConnections(sb),
  ]);

  /*
   * ACTIVE wells only. An inactive well is one the operator has taken out of
   * service, and drawing it keeps a dead card (and its edges) in the middle of
   * the flow as though the stream still ran through it. Its allocation rows
   * survive the deactivation, so nothing upstream removes it — this does.
   *
   * Filtered before anything derives rates or builds edges, so a P&A'd well
   * cannot contribute a lane, a stage column, or a feeder row either.
   */
  const activeWells = wells.filter((w) => w.active);

  /*
   * MEASURED rates, and only measured rates — the same per-well 14-day EMAs the
   * analytics headline is the SUM of (`@/lib/analytics/company-rates`).
   *
   * Two reasons this is not the wells table's `withDisplayRates`:
   *
   *  1. The `wells.oil_production` columns are unset on every well in a real
   *     account — production is derived from tank gauges and meters — so reading
   *     them left every producer card blank.
   *  2. `withDisplayRates` falls back to the STATE'S RECORD where nothing has
   *     been gauged, and an estimate has no business on a flow map. A well whose
   *     only gas number came from a Texas filing was drawn feeding a meter that
   *     had never measured it, at a rate the meter did not agree with.
   *
   * This map draws what was measured, so a well's card and the card it feeds
   * quote the same series: on a one-well meter the well's share IS the meter's
   * reading, and the two must be equal.
   */
  const { perWell } = await getCompanyRates();

  const ratedWells = activeWells.map((w) => ({
    ...w,
    oilProduction: perWell.get(w.id)?.oil ?? 0,
    gasProduction: perWell.get(w.id)?.gas ?? 0,
    saltWater: perWell.get(w.id)?.water ?? 0,
  }));

  // What each SWD well took, and what it is allowed to take.
  //
  // The rate uses the same loader as the Disposal page's Wells tab
  // (`loadDisposalSeriesByWell`) and a DIFFERENT statistic on purpose: this map
  // is one chain of rates, so every card on it — well, meter and SWD well — is
  // the 14-day EMA over the days each was read, and the meters feeding a
  // disposal well therefore sum to it. That table answers a different question
  // (volume over the last 30 days ÷ 30, unread days counted as nothing), so the
  // two figures will not match and the table names its window. The ceiling is
  // the state's UIC permit, caught rather than
  // awaited bare: the map is our operation, and a mirror outage must cost the
  // capacity line and nothing else.
  const injectionIds = activeWells
    .filter((w) => w.type === "injection")
    .map((w) => w.id);
  const [swdSeries, permitted] = await Promise.all([
    injectionIds.length
      ? loadDisposalSeriesByWell(sb, injectionIds)
      : Promise.resolve(new Map()),
    getFleetPermittedRates().catch((err) => {
      console.error("[facilities] permitted rates unavailable", err);
      return new Map();
    }),
  ]);
  /**
   * An SWD well's card: the 14-day EMA of its daily disposed barrels.
   *
   * EVERY rate on this page is that same statistic — well, meter and SWD well —
   * because they are terms of one another: the meters feeding a disposal well
   * sum to it, and the producing wells behind those meters sum to them. A
   * 30-day average here (`swdWellIndicators`) made the last card in the chain
   * quote a different window from everything pointing at it.
   */
  const disposalEma = (rows: { date: string; volume: number | null }[]) => {
    const byDate = new Map<string, number>();
    for (const r of rows) {
      if (r.volume == null) continue;
      byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.volume);
    }
    // Same cut as the meters feeding it: the newest day ends at the last
    // reading, so it is a part-day that the EMA weights hardest.
    const all = [...byDate.keys()].sort();
    const boundary = partialTailDate(all.map((date) => ({ date })));
    const dates = all.filter((d) => boundary == null || d < boundary);
    if (dates.length === 0) return null;
    return latestDailyEma(
      dates.map((date) => ({
        date,
        oilProduction: byDate.get(date)!,
        gasProduction: 0,
      })),
      "oil",
    );
  };

  const graph = buildFacilityGraph({
    wells: ratedWells.map((w) => ({
      id: w.id,
      name: w.name,
      type: w.type,
      leaseId: w.leaseId,
      oilProduction: w.oilProduction,
      gasProduction: w.gasProduction,
      saltWater: w.saltWater,
      revenue: w.revenue,
      pl: w.pl,
      disposalBblPerDay:
        w.type === "injection"
          ? disposalEma(swdSeries.get(w.id)?.rows ?? [])
          : null,
      permittedBblPerDay: permitted.get(w.id)?.permittedBblPerDay ?? null,
    })),
    tanks: tanks.map((t) => ({
      id: t.id,
      name: t.name,
      product: t.product,
      leaseId: t.leaseId,
      batteryId: t.batteryId,
      injectionWellId: t.injectionWellId,
      tankNo: t.tankNo,
    })),
    meters: meters.map((m) => ({
      id: m.id,
      name: m.name,
      leaseId: m.leaseId,
      meterNo: m.meterNo,
      substance:
        m.substance === "water" ? ("water" as const) : ("gas" as const),
    })),
    batteries: batteries.map((b) => ({
      id: b.id,
      name: b.name,
      leaseId: b.leaseId,
      injectionWellId: b.injectionWellId,
    })),
    gatherers: gatherers.map((g) => ({ id: g.id, name: g.name })),
    leases: leases.map((l) => ({
      id: l.id,
      // Name only (not the lease number) per the Facilities label convention.
      label: l.name || l.leaseNo,
    })),
    tankAllocations: tankAlloc,
    meterAllocations: meterAlloc,
    batteryAllocations: batteryAlloc,
  });

  // Overlay operator-drawn connections (the write path); no-op pre-migration.
  // Membership travels with them so an edge drawn on a water tank that sits on a
  // battery lands on the battery node that stands in for it.
  const batteryByTank = Object.fromEntries(
    tanks.map((t) => [t.id, t.batteryId]),
  );
  return withFlowConnections(graph, flowConns, batteryByTank);
}

// --- Connection write path (flow_connections) ------------------------------

/** A connection the inspector asks to create, in facility terms. */
export interface FacilityConnectionInput {
  fromType: FlowNodeType;
  fromId: string;
  toType: FlowNodeType;
  toId: string;
  substance: FlowSubstance;
  /** To-normalized share (0-100); defaults to 100 for a sole feeder. */
  sharePct?: number;
}

/**
 * The battery an OIL connection from a well lands on, or null when it is not one
 * — the endpoint is a battery, or a tank that sits on one.
 */
async function oilBatteryTarget(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  input: FacilityConnectionInput,
): Promise<string | null> {
  if (input.substance !== "oil" || input.fromType !== "well") return null;
  if (input.toType === "battery") return input.toId;
  if (input.toType !== "tank") return null;
  const { data, error } = await sb
    .from("tanks")
    .select("battery_id")
    .eq("id", input.toId)
    .maybeSingle();
  if (error) throw new Error(`oilBatteryTarget: ${error.message}`);
  return (data as { battery_id: string | null } | null)?.battery_id ?? null;
}

/**
 * Draw a connection between two facilities.
 *
 * Most connections are a `flow_connections` row — the generic edge table the
 * water model traces through. OIL is the exception, and drawing one used to be a
 * lie: nothing derives oil from `flow_connections`, it comes from the battery's
 * split and only from there (`allocationForTank`), so a well drawn into a tank
 * appeared on the map carrying no barrels and reported none on any page. That is
 * how a well feeding a battery across a lease line ended up producing zero.
 *
 * So an oil connection from a well writes the thing the engine reads: membership
 * in that tank's battery (`ensureBatteryMembership` — 100% when it is the first
 * well on the battery, else 0% for the operator to split). The map redraws the
 * edge from that membership, so no `flow_connections` row is written for it and
 * there is one record of the well feeding the battery rather than two that can
 * disagree. An oil tank with NO battery has nothing to allocate at, so it keeps
 * the drawn edge and stays as inert as it was.
 */
export async function createFacilityConnection(
  input: FacilityConnectionInput,
): Promise<void> {
  await requirePermission(["manage_facilities"]);
  const sb = await getSupabaseServer();

  const battery = await oilBatteryTarget(sb, input);
  if (battery) {
    await ensureBatteryMembership(sb, battery, input.fromId);
    await invalidateWellProductionRates(sb);
    revalidatePath("/facilities");
    revalidatePath("/production");
    revalidatePath("/production/batteries", "layout");
    revalidatePath(`/production/wells/${input.fromId}`);
    return;
  }

  await insertFlowConnections(sb, [
    {
      fromType: input.fromType,
      fromId: input.fromId,
      toType: input.toType,
      toId: input.toId,
      substance: input.substance,
      sharePct: input.sharePct ?? 100,
      effectiveFrom: today(),
      effectiveTo: null,
    },
  ]);
  revalidatePath("/facilities");
}

/**
 * Put a new facility IN THE MIDDLE of an existing connection: `A -> B` becomes
 * `A -> new -> B`.
 *
 * Only an operator-drawn connection can be spliced. The other edges on this map
 * are derived from the allocation tables (`tank_well_allocations` and friends) —
 * they are not rows this can delete, so splicing one would draw the new path
 * beside the old one instead of in place of it, and the map would claim the
 * stream goes both ways. The caller refuses the drop rather than making that
 * mess; see `spliceable` in the flow map.
 *
 * Both new edges inherit the original's substance and share, so the volume
 * arriving at B is the volume that was arriving before.
 */
export async function spliceFacilityIntoConnection(input: {
  /** The `flow_connections` row being replaced. */
  connectionId: string;
  fromType: FlowNodeType;
  fromId: string;
  toType: FlowNodeType;
  toId: string;
  /** The facility to stand between them. */
  viaType: FlowNodeType;
  viaId: string;
  substance: FlowSubstance;
  sharePct?: number;
}): Promise<void> {
  await requirePermission(["manage_facilities"]);
  const sb = await getSupabaseServer();
  const share = input.sharePct ?? 100;
  // Insert first, delete second: a failure part-way leaves the stream drawn
  // twice, which is visible and fixable, rather than severed and invisible.
  await insertFlowConnections(sb, [
    {
      fromType: input.fromType,
      fromId: input.fromId,
      toType: input.viaType,
      toId: input.viaId,
      substance: input.substance,
      sharePct: share,
      effectiveFrom: today(),
      effectiveTo: null,
    },
    {
      fromType: input.viaType,
      fromId: input.viaId,
      toType: input.toType,
      toId: input.toId,
      substance: input.substance,
      sharePct: share,
      effectiveFrom: today(),
      effectiveTo: null,
    },
  ]);
  await deleteFlowConnections(sb, [input.connectionId]);
  revalidatePath("/facilities");
}

/** Remove an operator-drawn connection by its `flow_connections` id. */
/**
 * Make this facility's connections on one side exactly these, and no others.
 *
 * The settings forms' own wiring: "the meters that feed this tank", "the wells
 * this disposal well takes water from". Drawing them one at a time on the map is
 * fine for a chain being sketched; a facility that already exists is easier to
 * describe by listing what is on each end of it.
 *
 * Only operator-drawn `flow_connections` are touched. An edge the graph DERIVED
 * from an allocation table is not a row this can delete — it is unwired where it
 * lives, on the split — so it is left alone rather than silently duplicated.
 */
export async function setFacilityLinks(input: {
  node: { type: FlowNodeType; id: string };
  /** `upstream` = what feeds this node; `downstream` = what it feeds. */
  side: "upstream" | "downstream";
  substance: FlowSubstance;
  others: { type: FlowNodeType; id: string }[];
}): Promise<void> {
  await requirePermission(["manage_facilities"]);
  const sb = await getSupabaseServer();
  const all = await activeFlowConnections(sb);

  const isEnd = (c: FlowConnection) =>
    input.side === "upstream"
      ? c.toType === input.node.type && c.toId === input.node.id
      : c.fromType === input.node.type && c.fromId === input.node.id;
  const otherOf = (c: FlowConnection) =>
    input.side === "upstream"
      ? { type: c.fromType, id: c.fromId }
      : { type: c.toType, id: c.toId };

  const mine = all.filter((c) => c.substance === input.substance && isEnd(c));
  const wanted = input.others;
  const same = (a: { type: FlowNodeType; id: string }, b: typeof a) =>
    a.type === b.type && a.id === b.id;

  const gone = mine
    .filter((c) => !wanted.some((w) => same(w, otherOf(c))))
    .map((c) => c.id)
    .filter((id): id is string => Boolean(id));
  if (gone.length > 0) await deleteFlowConnections(sb, gone);

  const missing = wanted.filter((w) => !mine.some((c) => same(w, otherOf(c))));
  if (missing.length > 0) {
    await insertFlowConnections(
      sb,
      missing.map((other) => ({
        fromType: input.side === "upstream" ? other.type : input.node.type,
        fromId: input.side === "upstream" ? other.id : input.node.id,
        toType: input.side === "upstream" ? input.node.type : other.type,
        toId: input.side === "upstream" ? input.node.id : other.id,
        substance: input.substance,
        sharePct: 100,
        effectiveFrom: today(),
        effectiveTo: null,
      })) as FlowConnection[],
    );
  }
  revalidatePath("/facilities");
  revalidatePath("/disposal");
  revalidatePath("/production");
}

/**
 * Wire a newly created WATER meter into the saltwater line its pickers describe.
 *
 * The rule is `planWaterMeterWiring`'s — a tank and a hole picked together are a
 * chain through the tank, and a well already wired straight to that hole hands
 * the connection over rather than keeping a second route to it. This is the
 * write half: read what is drawn today, apply the plan.
 */
export async function wireWaterMeter(picks: WaterMeterPicks): Promise<void> {
  await requirePermission(["manage_facilities"]);
  const sb = await getSupabaseServer();
  const existing = (await activeFlowConnections(sb)).filter(
    (c) => c.substance === "water",
  );
  const plan = planWaterMeterWiring(picks, existing);

  if (plan.add.length > 0) {
    await insertFlowConnections(
      sb,
      plan.add.map((e) => ({
        fromType: e.from.type,
        fromId: e.from.id,
        toType: e.to.type,
        toId: e.to.id,
        substance: "water",
        sharePct: 100,
        effectiveFrom: today(),
        effectiveTo: null,
      })) as FlowConnection[],
    );
  }
  if (plan.removeIds.length > 0)
    await deleteFlowConnections(sb, plan.removeIds);

  revalidatePath("/facilities");
  revalidatePath("/disposal");
}

/**
 * Move a facility onto another lease — what dropping its card into a different
 * lease's lane on the map means.
 *
 * One action for every kind because the gesture is one gesture: the map knows a
 * card and a lane, not which table the lease column is in. A well, tank, meter
 * and battery each keep it in their own row; a tank standing on a BATTERY does
 * not keep it at all (the battery's lease cascades to its tanks by trigger), so
 * moving one of those moves the battery, which is the only answer that leaves
 * the two agreeing.
 */
export async function setFacilityLease(input: {
  kind: "well" | "injection" | "tank" | "meter" | "battery";
  id: string;
  leaseId: string | null;
}): Promise<void> {
  await requirePermission(["manage_facilities"]);
  const sb = await getSupabaseServer();
  const table =
    input.kind === "well" || input.kind === "injection"
      ? "wells"
      : input.kind === "tank"
        ? "tanks"
        : input.kind === "meter"
          ? "meters"
          : "tank_batteries";

  let id = input.id;
  let target: string = table;
  if (input.kind === "tank") {
    const { data, error } = await sb
      .from("tanks")
      .select("battery_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`setFacilityLease: ${error.message}`);
    const batteryId = (data as { battery_id: string | null } | null)
      ?.battery_id;
    if (batteryId) {
      // The tank's lease IS its battery's. Moving the tank alone would be undone
      // by the next cascade.
      id = batteryId;
      target = "tank_batteries";
    }
  }

  const { error } = await sb
    .from(target)
    .update({ lease_id: input.leaseId })
    .eq("id", id);
  if (error) throw new Error(`setFacilityLease: ${error.message}`);

  revalidatePath("/facilities");
  revalidatePath("/production");
  revalidatePath("/disposal");
}

/**
 * Change an operator-drawn connection: its share of the destination, the date it
 * stops carrying, or both.
 *
 * Retiring beats deleting. Setting `effectiveTo` leaves the edge in place with
 * an end date, so an allocation for a period before that date still resolves the
 * way it did at the time; a delete rewrites history. `deleteFacilityConnection`
 * stays for correcting an edge that should never have been drawn.
 *
 * Returns what the destination's inbound shares now total for that substance.
 * Sources into one node are meant to sum to 100, and moving one share without
 * moving its siblings is how a node ends up fed 130%: the number comes back so
 * the caller can see it did that, rather than finding out in an allocation.
 */
export async function updateFacilityConnection(input: {
  connectionId: string;
  sharePct?: number;
  effectiveTo?: string | null;
}): Promise<{ siblingTotalPct: number }> {
  await requirePermission(["manage_facilities"]);
  const sb = await getSupabaseServer();

  const all = await listFlowConnections(sb);
  const target = all.find((c) => c.id === input.connectionId);
  if (!target) throw new Error("No such connection.");

  await updateFlowConnection(sb, input.connectionId, {
    sharePct: input.sharePct,
    effectiveTo: input.effectiveTo,
  });

  const share = input.sharePct ?? target.sharePct;
  const closed =
    input.effectiveTo !== undefined
      ? input.effectiveTo !== null
      : target.effectiveTo !== null;
  const siblingTotalPct = all
    .filter(
      (c) =>
        c.toType === target.toType &&
        c.toId === target.toId &&
        c.substance === target.substance &&
        c.effectiveTo === null,
    )
    .reduce((sum, c) => {
      if (c.id !== target.id) return sum + c.sharePct;
      return closed ? sum : sum + share;
    }, 0);

  revalidatePath("/facilities");
  revalidatePath("/production");
  revalidatePath("/disposal");
  return { siblingTotalPct };
}

export async function deleteFacilityConnection(
  connectionId: string,
): Promise<void> {
  await requirePermission(["manage_facilities"]);
  const sb = await getSupabaseServer();
  await deleteFlowConnections(sb, [connectionId]);
  revalidatePath("/facilities");
}

// --- Card readouts ----------------------------------------------------------

/**
 * The number each card carries on the flow map, per facility kind. Loaded
 * separately from the graph because these are current-state readings, not
 * wiring: a well's rate is already on the graph, a tank's fill and a meter's
 * last reading are not.
 */
export interface FacilityReadouts {
  /** Percent full (0-100) per tank id, absent when the tank has no capacity on
   *  file. Same level ÷ capacity the Tanks table shows (`fillPercent`). */
  tankFillPct: Record<string, number>;
  /**
   * Current rate per GAS meter id, in MCF/day: the 14-day EMA of its daily
   * readings, which is what the meter's own page headlines and what the wells
   * feeding it are measured by. Water meters are not in here — see
   * `waterMeterBblPerDay`.
   */
  meterLatest: Record<string, number>;
  /**
   * Disposal RATE per water meter id, bbl/day.
   *
   * A water meter stores a cumulative barrel index, and the card used to print
   * that index raw: a six-figure odometer reading beside tanks showing "% full"
   * and wells showing bbl/d. It is not a rate, it does not compare to anything
   * else on the map, and it grows forever. This is the same
   * `swdMeterStats().latestRatePerDay` the SWD meter page headlines, so the card
   * and the page it opens quote one number.
   */
  waterMeterBblPerDay: Record<string, number>;
}

/**
 * The operator-drawn `flow_connections` rows themselves — ids, shares, and the
 * dates each edge is in force.
 *
 * `getFacilityGraph` returns the edges as the map DRAWS them: today's wiring,
 * flattened, with the derived allocation edges mixed in. This is the underlying
 * record, so a reader can see an edge that has been closed, or one dated to
 * start later, and can name a connection by its id.
 */
export async function listFacilityConnections(): Promise<FlowConnection[]> {
  await requirePermission(["view_facilities"]);
  return listFlowConnections(await getSupabaseServer());
}

/**
 * Where a facility's substance comes FROM and goes TO, walked through the flow
 * graph on one date.
 *
 * `upstream` is the producing wells behind the node with the fraction each is
 * credited (what an allocation actually divides by), not just the node one hop
 * up. `downstream` is the nodes it feeds directly. `unattributed` is the share
 * that dead-ends at a node with no producing well behind it — a wiring gap, and
 * the reason a total can come up short.
 */
export async function traceFacilityFlow(input: {
  type: FlowNodeType;
  id: string;
  substance: FlowSubstance;
  onDate?: string;
}): Promise<{
  upstream: { wellId: string; share: number }[];
  downstream: { type: FlowNodeType; id: string; sharePct: number }[];
  unattributed: number;
  cycle: boolean;
}> {
  await requirePermission(["view_facilities"]);
  const sb = await getSupabaseServer();
  const onDate = input.onDate ?? new Date().toISOString().slice(0, 10);
  const connections = await listFlowConnections(sb);
  const attribution = attributeToWells(
    { type: input.type, id: input.id },
    input.substance,
    onDate,
    connections,
  );
  const downstream = activeConnections(connections, input.substance, onDate)
    .filter((c) => c.fromType === input.type && c.fromId === input.id)
    .map((c) => ({ type: c.toType, id: c.toId, sharePct: c.sharePct }));
  return {
    upstream: [...attribution.shares].map(([wellId, share]) => ({
      wellId,
      share,
    })),
    downstream,
    unattributed: attribution.unattributed,
    cycle: attribution.cycle,
  };
}

export async function getFacilityReadouts(): Promise<FacilityReadouts> {
  await requirePermission(["view_facilities"]);
  const sb = await getSupabaseServer();
  const [tanks, levels, gasMeters, waterMeters] = await Promise.all([
    getTanks(),
    getTankLevels(),
    listMeters(sb, "gas"),
    listMeters(sb, "water"),
  ]);

  const tankFillPct: Record<string, number> = {};
  for (const t of tanks) {
    const pct = fillPercent(levels[t.id] ?? 0, t.capacityBbls);
    if (pct != null) tankFillPct[t.id] = pct;
  }

  /*
   * A gas meter's rate is the 14-DAY EMA of its daily MCF, not its latest
   * reading.
   *
   * The wells feeding it carry the EMA of their allocated share of this very
   * series (`wellGasSeries` → `getWellProductionRates`), so quoting the raw last
   * reading here made a one-well meter disagree with the single well feeding it:
   * Repass 1 read 31 mcf/d into a meter labelled 27, which is not a rounding
   * difference but two different statistics of one stream. It is also what the
   * meter's OWN page headlines, so the card and the page it opens now agree too.
   */
  const meterLatest: Record<string, number> = {};
  const gasRates = await Promise.all(
    gasMeters
      .filter((m) => m.active)
      .map(async (m) => {
        // `meterDailySeries` — the resampled daily MCF the wells on this meter
        // are each a share of. Anything else and one well on one meter can
        // disagree with it, which is two answers for one stream of gas.
        const daily = await meterDailySeries(sb, m.id);
        if (daily.length === 0) return [m.id, null] as const;
        return [
          m.id,
          latestDailyEma(
            daily.map((p) => ({
              date: p.date,
              oilProduction: p.bbls,
              gasProduction: 0,
            })),
            "oil",
          ),
        ] as const;
      }),
  );
  for (const [id, rate] of gasRates) {
    if (rate != null) meterLatest[id] = rate;
  }

  /*
   * A water meter's rate is the 14-DAY EMA of its daily disposed barrels — the
   * SAME series, through the SAME estimator, that the wells feeding it are
   * attributed from (`swdMeterDailyBbls` → `buildWaterAttribution` →
   * `latestDailyEma`).
   *
   * It used to be `swdMeterStats().latestRatePerDay`, the last segment's
   * normalized rate, and that is a different statistic of the same stream: on
   * Hughes M1 it read 164 bbl/d over ten wells carrying 15.8 each — 158 — and
   * the meter IS where that water is measured, so the card contradicted its own
   * source. An EMA is linear, and the shares of a day's volume sum to that day's
   * volume, so summing the feeders now lands back on the meter (to the tenth the
   * cards are printed at).
   */
  const waterMeterBblPerDay: Record<string, number> = {};
  const rates = await Promise.all(
    waterMeters.map(async (m) => {
      const readings = await listMeterReadings(sb, m.id);
      /*
       * The last day comes off, exactly as it does on the wells this meter
       * feeds (`company-rates`): its final segment ends at the last reading, so
       * it holds part of a day's barrels under a whole day's date. Both sides
       * have to drop the SAME day or the wells stop summing to the meter, which
       * is the one thing this card is checked against.
       */
      const rawDaily = swdMeterDailyBbls(readings);
      const daily = withoutPartialTail(rawDaily, partialTailDate(rawDaily));
      if (daily.length === 0) {
        return [m.id, swdMeterStats(readings).latestRatePerDay] as const;
      }
      return [
        m.id,
        latestDailyEma(
          daily.map((p) => ({
            date: p.date,
            oilProduction: p.bbls,
            gasProduction: 0,
          })),
          "oil",
        ),
      ] as const;
    }),
  );
  for (const [id, rate] of rates) {
    if (rate != null) waterMeterBblPerDay[id] = rate;
  }

  return { tankFillPct, meterLatest, waterMeterBblPerDay };
}

/**
 * Everything a facility form's pickers offer, in one read.
 *
 * The settings forms are shared components, but WHAT THEY COULD OFFER used to
 * be whatever its host page happened to have loaded: the well page handed the
 * form its oil tanks and nothing else, so the same modal opened from
 * /production listed no tanks at all and the one on the facilities map listed
 * everything. Same form, three different sets of choices.
 *
 * So the choices come from here instead, loaded when a settings modal opens
 * rather than on every page render — a well page is visited far more often than
 * its settings are edited, and this is six queries.
 *
 * Shape is `FacilityCatalog`, the same one `/facilities` builds inline for its
 * create menu (`facilities/page.tsx`).
 */
export async function getFacilityCatalog(): Promise<FacilityCatalog> {
  await requirePermission(["view_facilities"]);
  const [wells, tanks, batteries, gatherers, leases, meters] =
    await Promise.all([
      getWells(),
      getTanks(),
      getBatteries(),
      getGatherers(),
      getLeaseOptions(),
      listMeters(await getSupabaseServer(), "all"),
    ]);

  return {
    wells: wells
      .filter((w) => w.type === "producer")
      .map((w) => ({ id: w.id, name: w.name, leaseId: w.leaseId })),
    injectionWells: wells
      .filter((w) => w.type === "injection")
      .map((w) => ({ id: w.id, name: w.name, leaseId: w.leaseId })),
    batteries: batteries.map((b) => ({
      id: b.id,
      name: b.name,
      leaseId: b.leaseId,
    })),
    gatherers: gatherers.map((g) => ({ id: g.id, name: g.name })),
    // Lease NAMES: a new tank or meter's lease becomes half of its name, so the
    // option has to read the way the name will ("Dofflemeyer M1234").
    leases: leases.map((l) => ({ id: l.id, name: l.name })),
    tanks: tanks.map((t) => ({
      id: t.id,
      name: t.name,
      battery: t.battery,
      bblPerInch: t.bblPerInch,
      leaseId: t.leaseId,
      product: t.product,
    })),
    meters: meters.map((m) => ({
      id: m.id,
      name: m.name,
      leaseId: m.leaseId,
      substance: m.substance,
    })),
  };
}
