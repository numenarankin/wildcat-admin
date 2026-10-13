import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computedWaterEdgesForNode,
  nodeMemberWells,
  listWellTestWaterPool,
  resolveWaterNode,
} from "@/lib/flow/effective-water";
import { waterTestPeriods } from "@/lib/flow/water-test-combine";
import type {
  AllocationPeriod,
  MeterAllocationInput,
} from "@/lib/meters/allocations";
import type { FlowConnection, FlowNodeRef, FlowSubstance } from "@/lib/flow/types";

/**
 * A node's water allocation on `flow_connections` — the SAME store water well
 * tests write to, so a manual split drives attribution identically. Modeled to
 * feed the shared `MeterAllocationPanel`: it returns PER-PERIOD allocation
 * (manual periods the operator edits + well-test periods derived from published
 * tests), exactly like a gas meter's `resolveMeterTimeline`, but the periods are
 * read from / written to `flow_connections` instead of `meter_well_allocations`
 * + campaigns.
 *
 *  - Manual periods are the node's STORED water edges — the operator's override.
 *  - The well-test periods are COMPUTED (never stored) from the member wells' test
 *    history — one dated split per test — and fill only the dates no manual edge
 *    covers.
 *
 * Non-overlap (attribution normalizes ALL active edges together) therefore falls
 * out of the model rather than needing a rebuild step: manual wins, computed fills
 * the gaps.
 *
 * Client-injected RLS idiom; org ownership from the `flow_connections` policies.
 */

type Sb = SupabaseClient;

/** Manual periods with no explicit start begin at a far-past sentinel so they
 * cover all history a test hasn't claimed; surfaced to the UI as a blank start. */
const MANUAL_FROM = "1900-01-01";

const COLS =
  "id, from_type, from_id, to_type, to_id, substance, share_pct, effective_from, effective_to";

interface Row {
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

function mapRow(r: Row): FlowConnection {
  return {
    id: r.id,
    fromType: r.from_type as FlowConnection["fromType"],
    fromId: r.from_id,
    toType: r.to_type as FlowConnection["toType"],
    toId: r.to_id,
    substance: r.substance as FlowSubstance,
    sharePct: r.share_pct ?? 0,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

/** A node's water allocation for the shared allocation panel. */
export interface NodeWaterAllocation {
  /** Manual + well-test periods, date-sorted — feeds `MeterAllocationPanel`. */
  periods: AllocationPeriod[];
  /** Every well appearing in any period, for the panel's well pickers. */
  memberWellIds: string[];
  /** True when a published well test governs today's split (manual is the fallback). */
  testGovernsToday: boolean;
}

/** Today as ISO `YYYY-MM-DD` (UTC). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load a node's water allocation as manual + well-test periods.
 *
 * MANUAL periods are the node's own stored water edges — real
 * overrides the operator set here. The WELL-TEST periods are COMPUTED live from
 * the pool of WELL TESTS over the node's member wells (each test date cuts a
 * period holding the rates known as of that date), NOT read from stored per-node
 * test edges. Manual WINS: the computed split only fills the dates a manual edge
 * doesn't cover.
 */
export async function getNodeWaterAllocation(
  sb: Sb,
  ref: FlowNodeRef
): Promise<NodeWaterAllocation> {
  // A water tank in a battery resolves at its battery — the node its water is
  // measured and attributed at (`resolveWaterNode`).
  const node = await resolveWaterNode(sb, ref);
  // Manual overrides (stored, editable).
  const { data, error } = await sb
    .from("flow_connections")
    .select(COLS)
    .eq("to_type", node.type)
    .eq("to_id", node.id)
    .eq("substance", "water");
  if (error) throw new Error(`getNodeWaterAllocation: ${error.message}`);
  const manualEdges = ((data ?? []) as Row[]).map(mapRow);

  // Group-pooled test split for this node's member wells.
  const [tests, members] = await Promise.all([
    listWellTestWaterPool(sb),
    nodeMemberWells(sb, node),
  ]);
  const testPeriods = waterTestPeriods(members, tests);
  const manualRanges = manualEdges.map((e) => ({
    from: e.effectiveFrom,
    to: e.effectiveTo,
  }));
  const computed = computedWaterEdgesForNode(node, testPeriods, manualRanges);

  // Manual periods: group by explicit [from, to]; the MIN sentinel start shows "".
  const manualByRange = new Map<string, AllocationPeriod>();
  for (const e of manualEdges) {
    const from = e.effectiveFrom === MANUAL_FROM ? "" : e.effectiveFrom;
    const key = `${from}|${e.effectiveTo ?? ""}`;
    let p = manualByRange.get(key);
    if (!p) {
      p = {
        method: "manual",
        effectiveFrom: from,
        effectiveTo: e.effectiveTo,
        campaignId: null,
        wellTestDate: null,
        shares: [],
      };
      manualByRange.set(key, p);
    }
    p.shares.push({ wellId: e.fromId, pct: e.sharePct });
  }

  // Well-test periods: group the computed split by its gap range (read-only).
  const testByRange = new Map<string, AllocationPeriod>();
  for (const e of computed) {
    const from = e.effectiveFrom === MANUAL_FROM ? "" : e.effectiveFrom;
    const key = `${from}|${e.effectiveTo ?? ""}`;
    let p = testByRange.get(key);
    if (!p) {
      p = {
        method: "welltest",
        effectiveFrom: from,
        effectiveTo: e.effectiveTo,
        campaignId: null,
        wellTestDate: from,
        shares: [],
      };
      testByRange.set(key, p);
    }
    p.shares.push({ wellId: e.fromId, pct: e.sharePct });
  }

  const periods = [...manualByRange.values(), ...testByRange.values()].sort(
    (a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0)
  );

  // A test governs today when the computed split covers today (i.e. today is in a
  // gap no manual edge claims) and there are shares to apply.
  const today = todayIso();
  const testGovernsToday = computed.some(
    (e) => e.effectiveFrom <= today && (e.effectiveTo == null || e.effectiveTo >= today)
  );

  const memberWellIds = [
    ...new Set([...members, ...manualEdges.map((e) => e.fromId)]),
  ];

  return { periods, memberWellIds, testGovernsToday };
}

/**
 * Replace a node's MANUAL water periods with a new set (the allocation panel's
 * Save), then re-clip against published tests. Each row becomes a `well -> node`
 * manual edge over its [from, to] range; a blank start uses the MIN sentinel.
 * Shares are stored verbatim (attribution normalizes); 0% / empty rows drop out.
 */
export async function saveNodeManualWaterSplit(
  sb: Sb,
  ref: FlowNodeRef,
  rows: MeterAllocationInput[]
): Promise<void> {
  // Write the override where attribution reads it: the battery, for a member tank.
  const node = await resolveWaterNode(sb, ref);
  const del = await sb
    .from("flow_connections")
    .delete()
    .eq("to_type", node.type)
    .eq("to_id", node.id)
    .eq("substance", "water");
  if (del.error) {
    throw new Error(`saveNodeManualWaterSplit (clear): ${del.error.message}`);
  }

  const inserts = rows
    .filter((r) => r.wellId && r.straightPct > 0)
    .map((r) => ({
      from_type: "well",
      from_id: r.wellId,
      to_type: node.type,
      to_id: node.id,
      substance: "water",
      share_pct: r.straightPct,
      effective_from: r.effectiveFrom || MANUAL_FROM,
      effective_to: r.effectiveTo ?? null,
    }));
  if (inserts.length > 0) {
    const { error } = await sb.from("flow_connections").insert(inserts);
    if (error) throw new Error(`saveNodeManualWaterSplit (insert): ${error.message}`);
  }
  // No materialized test edges to reconcile: manual edges are the override and the
  // group-pooled test split fills the gaps live at read time (see effective-water).
}
