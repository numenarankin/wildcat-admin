import type { SupabaseClient } from "@supabase/supabase-js";
import { listWellTestWaterRates, type WellTest } from "@/lib/wells/well-tests";
import { dayBefore } from "@/lib/tanks/allocation";
import {
  latestRatePerWell,
  nodeTestShares,
  waterTestPeriods,
  WATER_MIN_DATE,
  type CombinableTest,
  type WaterTestPeriod,
  type WaterTestShare,
} from "@/lib/flow/water-test-combine";
import type { FlowConnection, FlowNodeRef } from "@/lib/flow/types";

/**
 * Effective water edges — the "water follows the WELL TEST" resolver.
 *
 * Water production measured at a tank or a meter splits back to its wells by the
 * ratio of their water RATES, and those rates come from the wells' own tests
 * (`well_tests`, recorded on the well page). A test is a record of the WELL, not of
 * the node it was measured at, so a node's split is not a set of stored
 * `well -> node` test edges — it is COMPUTED live from the pool of tests over the
 * node's own member wells (each well's latest measured rate, to-normalized;
 * untested members drop to 0%). Manual overrides in the allocation card are real
 * stored edges and WIN: the computed split only fills the dates a manual edge
 * doesn't cover.
 *
 * `loadEffectiveFlowConnections` returns the same shape as `listFlowConnections`
 * (all substances), but with the stale per-node test edges dropped and the live
 * group-pooled water split spliced in. Every attribution reader (series-loaders,
 * facilities) and the allocation-card read go through it, so all surfaces agree
 * and a test edited once updates every node sharing its wells.
 *
 * Client-injected RLS idiom; org ownership from the underlying table policies.
 */

type Sb = SupabaseClient;

/** Lower bound a gap-filling computed edge starts from (covers all prior history). */
const MIN_DATE = WATER_MIN_DATE;

/** One day after an ISO `YYYY-MM-DD` date (UTC). */
function dayAfter(iso: string): string {
  const ms = Date.parse(`${iso}T00:00:00Z`) + 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** A covered date range (`to` null = open-ended). */
interface Range {
  from: string;
  to: string | null;
}

/**
 * The complement of a set of covered ranges over `[MIN_DATE, +inf)` — the dates a
 * computed test split is allowed to fill (manual wins, so it fills only the gaps).
 * Pure and unit-tested.
 */
export function uncoveredGaps(covered: Range[]): Range[] {
  if (covered.length === 0) return [{ from: MIN_DATE, to: null }];
  const norm = covered
    .map((r) => ({ from: r.from || MIN_DATE, to: r.to }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  // Merge overlapping / adjacent covered ranges.
  const merged: Range[] = [];
  for (const r of norm) {
    const last = merged[merged.length - 1];
    if (last && (last.to === null || r.from <= dayAfter(last.to))) {
      // `last` already runs to +inf, or `r` touches it — extend.
      if (last.to !== null && (r.to === null || r.to > last.to)) last.to = r.to;
    } else {
      merged.push({ ...r });
    }
  }

  const gaps: Range[] = [];
  let cursor: string | null = MIN_DATE;
  for (const m of merged) {
    if (cursor !== null && m.from > cursor) {
      gaps.push({ from: cursor, to: dayBefore(m.from) });
    }
    if (m.to === null) {
      cursor = null;
      break;
    }
    cursor = dayAfter(m.to);
  }
  if (cursor !== null) gaps.push({ from: cursor, to: null });
  return gaps;
}

/** The overlap of two ranges, or null when they don't touch. */
function intersectRange(a: Range, b: Range): Range | null {
  const from = a.from > b.from ? a.from : b.from;
  const to =
    a.to == null ? b.to : b.to == null ? a.to : a.to < b.to ? a.to : b.to;
  if (to != null && to < from) return null;
  return { from, to };
}

/**
 * Build the computed `well -> node` water edges for one node: the node's test
 * TIMELINE (one dated split per test, see `waterTestPeriods`) clipped to the dates
 * no manual edge covers. Manual wins, so each period contributes only where it
 * overlaps a gap. Pure.
 */
export function computedWaterEdgesForNode(
  node: FlowNodeRef,
  periods: WaterTestPeriod[],
  manualRanges: Range[]
): FlowConnection[] {
  const gaps = uncoveredGaps(manualRanges);
  const edges: FlowConnection[] = [];
  for (const p of periods) {
    const positive = p.shares.filter((s) => s.pct > 0);
    if (positive.length === 0) continue;
    for (const g of gaps) {
      const range = intersectRange({ from: p.effectiveFrom, to: p.effectiveTo }, g);
      if (!range) continue;
      for (const s of positive) {
        edges.push({
          fromType: "well",
          fromId: s.wellId,
          toType: node.type,
          toId: node.id,
          substance: "water",
          sharePct: s.pct,
          effectiveFrom: range.from,
          effectiveTo: range.to,
        });
      }
    }
  }
  return edges;
}

// --- Data access ------------------------------------------------------------

/**
 * Every operative well test in the org as a `CombinableTest` — one measurement
 * each, since a test measures ONE well. The operative date is the day the test's
 * window CLOSED (not when someone published it), so "latest wins" means most
 * recently measured. Node-agnostic: this is the whole pool, since a test applies
 * wherever its well flows.
 */
export async function listWellTestWaterPool(
  sb: Sb,
  have?: { tests?: WellTest[] }
): Promise<CombinableTest[]> {
  const rates = await listWellTestWaterRates(sb, have?.tests);
  return rates.map((r) => ({
    date: r.date,
    at: r.endAt,
    measurements: [
      {
        wellId: r.wellId,
        waterBbls: r.waterBbls,
        intervalDays: r.intervalDays,
      },
    ],
  }));
}

/** A water node and its currently-active member wells (its allocation set). */
export interface WaterNodeMembers {
  node: FlowNodeRef;
  memberWellIds: string[];
}

/** Today as ISO `YYYY-MM-DD` (UTC). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Every water node (a `product='water'` tank or a `substance='water'` meter) with
 * its active member wells, from the same allocation tables the pages use
 * (`tank_well_allocations` / `meter_well_allocations`). These are the candidate
 * nodes a group-pooled test can drive.
 */
export async function listWaterNodesWithMembers(
  sb: Sb,
  /**
   * The rosters when the caller already holds them. The cache layer loads every
   * tank and meter once per request; reading two projections of the same tables
   * again here was one more round trip on the water path's critical chain.
   */
  have?: { tanks?: { id: string; batteryId?: string | null; product: string }[]; waterMeters?: { id: string }[] }
): Promise<WaterNodeMembers[]> {
  const today = todayIso();
  const activeMembers = (rows: {
    node_id: string;
    well_id: string;
    effective_from: string;
    effective_to: string | null;
  }[]): Map<string, string[]> => {
    const by = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.effective_from > today) continue;
      if (r.effective_to != null && r.effective_to < today) continue;
      (by.get(r.node_id) ?? by.set(r.node_id, new Set()).get(r.node_id)!).add(
        r.well_id
      );
    }
    const out = new Map<string, string[]>();
    for (const [id, set] of by) out.set(id, [...set]);
    return out;
  };

  let waterTanks: { id: string; battery_id: string | null }[];
  let meterRows: { id: string }[];
  if (have?.tanks && have?.waterMeters) {
    waterTanks = have.tanks
      .filter((t) => t.product === "water")
      .map((t) => ({ id: t.id, battery_id: t.batteryId ?? null }));
    meterRows = have.waterMeters.map((m) => ({ id: m.id }));
  } else {
    const [tanksRes, metersRes] = await Promise.all([
      sb.from("tanks").select("id, battery_id").eq("product", "water"),
      sb.from("meters").select("id").eq("substance", "water"),
    ]);
    if (tanksRes.error) throw new Error(`listWaterNodesWithMembers (tanks): ${tanksRes.error.message}`);
    if (metersRes.error) throw new Error(`listWaterNodesWithMembers (meters): ${metersRes.error.message}`);
    waterTanks = (tanksRes.data ?? []) as { id: string; battery_id: string | null }[];
    meterRows = (metersRes.data ?? []) as { id: string }[];
  }
  const tankIds = waterTanks.map((t) => t.id);
  /* Which battery each water tank sits on. A tank in a battery is not a node of
   * its own: the BATTERY is, pooling its members' wells into one split, so one
   * station has one set of shares rather than one per tank. */
  const batteryOf = new Map<string, string>();
  for (const t of waterTanks) if (t.battery_id) batteryOf.set(t.id, t.battery_id);
  const meterIds = meterRows.map((m) => m.id);

  const [tankAlloc, meterAlloc] = await Promise.all([
    tankIds.length
      ? sb
          .from("tank_well_allocations")
          .select("tank_id, well_id, effective_from, effective_to")
          .in("tank_id", tankIds)
      : Promise.resolve({ data: [], error: null }),
    meterIds.length
      ? sb
          .from("meter_well_allocations")
          .select("meter_id, well_id, effective_from, effective_to")
          .in("meter_id", meterIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (tankAlloc.error) throw new Error(`listWaterNodesWithMembers (tank alloc): ${tankAlloc.error.message}`);
  if (meterAlloc.error) throw new Error(`listWaterNodesWithMembers (meter alloc): ${meterAlloc.error.message}`);

  const tankMembers = activeMembers(
    ((tankAlloc.data ?? []) as { tank_id: string; well_id: string; effective_from: string; effective_to: string | null }[]).map(
      (r) => ({ node_id: r.tank_id, well_id: r.well_id, effective_from: r.effective_from, effective_to: r.effective_to })
    )
  );
  const meterMembers = activeMembers(
    ((meterAlloc.data ?? []) as { meter_id: string; well_id: string; effective_from: string; effective_to: string | null }[]).map(
      (r) => ({ node_id: r.meter_id, well_id: r.well_id, effective_from: r.effective_from, effective_to: r.effective_to })
    )
  );

  // A well test is a record of the WELL, not of a node, so membership comes from
  // the allocation tables alone: a node with no wells allocated to it splits to
  // nobody (the allocation card shows that as an empty state).
  const out: WaterNodeMembers[] = [];
  // Member tanks fold into their battery, unioning their wells: the station's
  // pool is every well that feeds any of its tanks.
  const batteryMembers = new Map<string, Set<string>>();
  for (const [id, wells] of tankMembers) {
    const batteryId = batteryOf.get(id);
    if (batteryId) {
      const set = batteryMembers.get(batteryId) ?? new Set<string>();
      for (const w of wells) set.add(w);
      batteryMembers.set(batteryId, set);
      continue;
    }
    out.push({ node: { type: "tank", id }, memberWellIds: wells });
  }
  for (const [id, wells] of batteryMembers) {
    out.push({ node: { type: "battery", id }, memberWellIds: [...wells] });
  }
  for (const [id, wells] of meterMembers) out.push({ node: { type: "meter", id }, memberWellIds: wells });
  return out;
}

/**
 * One node's member wells — the wells its water splits to: its allocation set
 * (`tank_well_allocations` / `meter_well_allocations`), active today. Well tests no
 * longer confer membership (a test belongs to its well, not to the node it was
 * measured at), so a node has to have its wells allocated to it to split anything.
 */
export async function nodeMemberWells(
  sb: Sb,
  node: FlowNodeRef
): Promise<string[]> {
  if (node.type === "battery") return batteryMemberWells(sb, node.id);
  if (node.type !== "tank" && node.type !== "meter") return [];
  const today = todayIso();
  const table = node.type === "tank" ? "tank_well_allocations" : "meter_well_allocations";
  const fk = node.type === "tank" ? "tank_id" : "meter_id";
  const wells = new Set<string>();

  const { data, error } = await sb
    .from(table)
    .select("well_id, effective_from, effective_to")
    .eq(fk, node.id);
  if (error) throw new Error(`nodeMemberWells: ${error.message}`);
  for (const r of (data ?? []) as {
    well_id: string;
    effective_from: string;
    effective_to: string | null;
  }[]) {
    if (r.effective_from > today) continue;
    if (r.effective_to != null && r.effective_to < today) continue;
    wells.add(r.well_id);
  }

  return [...wells];
}

/**
 * A BATTERY's member wells: the union of its member water tanks' allocation
 * sets. The station pools its tanks' wells into one group, which is the whole
 * point of treating the battery as the node — one set of shares for the site
 * instead of one per tank, so a well test recorded once moves one split.
 */
async function batteryMemberWells(sb: Sb, batteryId: string): Promise<string[]> {
  const today = todayIso();
  const { data: tankRows, error: tankErr } = await sb
    .from("tanks")
    .select("id")
    .eq("battery_id", batteryId)
    .eq("product", "water");
  if (tankErr) throw new Error(`nodeMemberWells: ${tankErr.message}`);
  const tankIds = ((tankRows ?? []) as { id: string }[]).map((t) => t.id);
  if (tankIds.length === 0) return [];

  const { data, error } = await sb
    .from("tank_well_allocations")
    .select("well_id, effective_from, effective_to")
    .in("tank_id", tankIds);
  if (error) throw new Error(`nodeMemberWells: ${error.message}`);
  const wells = new Set<string>();
  for (const r of (data ?? []) as {
    well_id: string;
    effective_from: string;
    effective_to: string | null;
  }[]) {
    if (r.effective_from > today) continue;
    if (r.effective_to != null && r.effective_to < today) continue;
    wells.add(r.well_id);
  }
  return [...wells];
}

/**
 * The node a water split actually resolves against.
 *
 * A water tank IN A BATTERY is not its own node: the battery is, because that is
 * the node its production is measured at (`planWaterNodes`) and therefore the node
 * attribution walks edges into. Resolving here means every water read — the split
 * card, revenue, the well page's tank list — asks the same node the series layer
 * measured, instead of pooling one tank's wells against a station's barrels.
 * Anything that is not a battery-member water tank passes through unchanged.
 */
export async function resolveWaterNode(
  sb: Sb,
  node: FlowNodeRef
): Promise<FlowNodeRef> {
  if (node.type !== "tank") return node;
  const { data, error } = await sb
    .from("tanks")
    .select("battery_id, product")
    .eq("id", node.id)
    .maybeSingle();
  if (error) throw new Error(`resolveWaterNode: ${error.message}`);
  const row = (data ?? null) as {
    battery_id: string | null;
    product: string | null;
  } | null;
  if (!row || row.product !== "water" || !row.battery_id) return node;
  return { type: "battery", id: row.battery_id };
}

/** The group-pooled water split for one node today (member wells × pooled tests). */
export async function nodeWaterTestShares(
  sb: Sb,
  ref: FlowNodeRef
): Promise<WaterTestShare[]> {
  const node = await resolveWaterNode(sb, ref);
  const [tests, members] = await Promise.all([
    listWellTestWaterPool(sb),
    nodeMemberWells(sb, node),
  ]);
  return nodeTestShares(members, latestRatePerWell(tests));
}

/**
 * A node's EFFECTIVE water split today — the same allocation attribution uses:
 * manual overrides active today WIN (normalized to 100); otherwise the pooled
 * well-test split. This is what the Wells tab shows for a water node, not the
 * legacy `tank_well_allocations.straight_pct`.
 */
export async function nodeEffectiveWaterSplit(
  sb: Sb,
  ref: FlowNodeRef
): Promise<WaterTestShare[]> {
  const node = await resolveWaterNode(sb, ref);
  const today = todayIso();
  const { data, error } = await sb
    .from("flow_connections")
    .select("from_id, share_pct, effective_from, effective_to")
    .eq("to_type", node.type)
    .eq("to_id", node.id)
    .eq("substance", "water");
  if (error) throw new Error(`nodeEffectiveWaterSplit: ${error.message}`);
  const manualActive = ((data ?? []) as {
    from_id: string;
    share_pct: number | null;
    effective_from: string;
    effective_to: string | null;
  }[]).filter(
    (e) => e.effective_from <= today && (e.effective_to == null || e.effective_to >= today)
  );
  if (manualActive.length > 0) {
    const total = manualActive.reduce((s, e) => s + (e.share_pct ?? 0), 0);
    if (total > 0) {
      return manualActive.map((e) => ({
        wellId: e.from_id,
        pct: ((e.share_pct ?? 0) / total) * 100,
      }));
    }
  }
  return nodeWaterTestShares(sb, node);
}

interface EdgeRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  substance: string;
  share_pct: number | null;
  effective_from: string;
  effective_to: string | null;
}

/**
 * Load ALL flow edges with the live, well-test-derived water split spliced in over
 * the dates no manual edge covers. This is the single seam every attribution
 * reader goes through in place of `listFlowConnections`.
 */
type MaybePromise<T> = T | Promise<T>;

export async function loadEffectiveFlowConnections(
  sb: Sb,
  have?: {
    tests?: MaybePromise<WellTest[]>;
    tanks?: MaybePromise<{ id: string; batteryId?: string | null; product: string }[]>;
    waterMeters?: MaybePromise<{ id: string }[]>;
  }
): Promise<FlowConnection[]> {
  /*
   * All inputs at once, INCLUDING the ones handed in. They may still be in
   * flight (the cache layer passes its promises), and the edge read below must
   * not wait for them: it depends on nothing, so it goes out in the same tick.
   */
  const edgesQuery = sb
    .from("flow_connections")
    .select(
      "id, from_type, from_id, to_type, to_id, substance, share_pct, effective_from, effective_to"
    )
    .order("effective_from", { ascending: true });
  /*
   * The node membership needs only the rosters (already in the store, so they
   * resolve at once); the test pool needs the resolved tests, which are a
   * round trip. Awaiting them together held the two allocation reads behind
   * the tests read for no reason: one more wave on the water path's chain.
   */
  const nodesP = (async () =>
    listWaterNodesWithMembers(
      sb,
      have ? { tanks: await have.tanks, waterMeters: await have.waterMeters } : undefined
    ))();
  const testsP = (async () =>
    listWellTestWaterPool(sb, have ? { tests: await have.tests } : undefined))();
  const [edgesRes, tests, nodes] = await Promise.all([edgesQuery, testsP, nodesP]);
  const { data, error } = edgesRes;
  if (error) throw new Error(`loadEffectiveFlowConnections: ${error.message}`);
  const rows = (data ?? []) as EdgeRow[];

  // Every stored water edge is a MANUAL override now (test edges are never
  // materialized — the split is computed below and fills only the gaps).
  const base: FlowConnection[] = [];
  const manualWaterByNode = new Map<string, Range[]>();
  for (const r of rows) {
    const edge: FlowConnection = {
      id: r.id,
      fromType: r.from_type as FlowConnection["fromType"],
      fromId: r.from_id,
      toType: r.to_type as FlowConnection["toType"],
      toId: r.to_id,
      substance: r.substance as FlowConnection["substance"],
      sharePct: r.share_pct ?? 0,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    };
    base.push(edge);
    if (edge.substance === "water") {
      const key = `${edge.toType}:${edge.toId}`;
      (manualWaterByNode.get(key) ?? manualWaterByNode.set(key, []).get(key)!).push({
        from: edge.effectiveFrom,
        to: edge.effectiveTo,
      });
    }
  }

  const computed: FlowConnection[] = [];
  for (const { node, memberWellIds } of nodes) {
    const periods = waterTestPeriods(memberWellIds, tests);
    if (periods.length === 0) continue;
    const manualRanges = manualWaterByNode.get(`${node.type}:${node.id}`) ?? [];
    computed.push(...computedWaterEdgesForNode(node, periods, manualRanges));
  }

  return [...base, ...computed];
}
