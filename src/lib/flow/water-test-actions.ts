"use server";

/**
 * Server actions for a water node's MANUAL split override — the allocation card on
 * a water tank or SWD meter.
 *
 * The split itself is not stored: it resolves live from the node's member wells'
 * WELL TESTS (`@/lib/flow/effective-water`), which are recorded on the well page.
 * What lives here is the operator's override — real `flow_connections` water edges
 * that WIN over the computed split for the dates they cover. Request-scoped RLS
 * throughout: the `flow_connections` policies gate writes on `manage_disposal`.
 */

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { nodeEffectiveWaterSplit } from "@/lib/flow/effective-water";
import {
  getNodeWaterAllocation,
  saveNodeManualWaterSplit,
  type NodeWaterAllocation,
} from "@/lib/flow/node-water-allocation";
import type { MeterAllocationInput } from "@/lib/meters/allocations";
import type { FlowNodeRef } from "@/lib/flow/types";

/** A tank/meter node, as the client passes it. */
type WaterTestNode = { type: "tank" | "meter"; id: string };

function nodePagePath(node: WaterTestNode): string {
  return node.type === "meter"
    ? `/disposal/meters/${node.id}`
    : `/disposal/tanks/${node.id}`;
}

/** Revalidate everything a split change can move: the node page, Disposal, facilities. */
function revalidateNode(node: WaterTestNode): void {
  revalidatePath("/disposal");
  revalidatePath(nodePagePath(node));
  revalidatePath("/facilities");
}

/**
 * A node's effective water split today as `{ wellId: pct }` (manual override wins,
 * else the pooled well-test split) — what the Wells tab shows for water.
 */
export async function getNodeEffectiveWaterSplit(
  node: WaterTestNode
): Promise<Record<string, number>> {
  const sb = await getSupabaseServer();
  const shares = await nodeEffectiveWaterSplit(sb, node as FlowNodeRef);
  const out: Record<string, number> = {};
  for (const s of shares) out[s.wellId] = s.pct;
  return out;
}

/** The node's water allocation timeline (manual periods + the derived well-test
 *  period), for the allocation card. */
export async function getNodeWaterAllocationAction(
  node: WaterTestNode
): Promise<NodeWaterAllocation> {
  const sb = await getSupabaseServer();
  return getNodeWaterAllocation(sb, node as FlowNodeRef);
}

/** Save the node's MANUAL water split rows (the override that beats the tests). */
export async function saveNodeManualWaterSplitAction(
  node: WaterTestNode,
  rows: MeterAllocationInput[]
): Promise<void> {
  const sb = await getSupabaseServer();
  await saveNodeManualWaterSplit(sb, node as FlowNodeRef, rows);
  revalidateNode(node);
}
