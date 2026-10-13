import type { SupabaseClient } from "@supabase/supabase-js";
import { memo } from "@/lib/cache/request-cache";
import type {
  FlowConnection,
  FlowNodeRef,
  FlowSubstance,
} from "@/lib/flow/types";
import { planConnectionBridge } from "@/lib/flow/heal";

/**
 * `flow_connections` data-access — the generic flow-graph edge store.
 *
 * Same client-injected idiom as `@/lib/tanks/allocations`: every helper takes the
 * caller's request-scoped RLS client (`getSupabaseServer()`) as its first
 * argument; org ownership is enforced by the `flow_connections` RLS policies
 * (never hand these the service-role admin client). `org_id` is filled by the
 * column default (`current_org_id()`), so inserts never pass it.
 *
 * The graph math is pure (`@/lib/flow/graph`); this module only loads and
 * persists edges. NOTE: nothing live reads this yet — the allocation engines are
 * cut over behind tests in a later step (docs/swd-connections-architecture.md).
 */

type Sb = SupabaseClient;

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

/** PostgREST answers at most this many rows unless you page past it. */
const PAGE = 1000;

/**
 * Every flow edge in the caller's org (the whole-graph loader, like facilities).
 *
 * PAGED, because a plain select stops at 1000 rows with no error and no flag,
 * and this is not a display list: a disposal well's volume comes from the meters
 * this read reaches (`disposal/meter-reach.ts`), so a truncated answer would
 * silently un-meter a well and quietly hand its barrels back to hand entry.
 * Paged by `id` as the tiebreak so a row cannot fall between two pages when
 * several edges share an `effective_from`.
 */
export function listFlowConnections(sb: Sb): Promise<FlowConnection[]> {
  // Once per request per client: several loaders on one page read this
  // table each on their own (measured 3-5x on the disposal well page).
  return memo(sb, "flow-connections:rows", () => loadFlowConnections(sb));
}

async function loadFlowConnections(sb: Sb): Promise<FlowConnection[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("flow_connections")
      .select(COLS)
      .order("effective_from", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listFlowConnections: ${error.message}`);
    const page = (data ?? []) as Row[];
    out.push(...page);
    if (page.length < PAGE) return out.map(mapRow);
  }
}

/** Edges flowing INTO a node (optionally filtered to one substance). */
export async function listInboundConnections(
  sb: Sb,
  node: FlowNodeRef,
  substance?: FlowSubstance,
): Promise<FlowConnection[]> {
  let q = sb
    .from("flow_connections")
    .select(COLS)
    .eq("to_type", node.type)
    .eq("to_id", node.id);
  if (substance) q = q.eq("substance", substance);
  const { data, error } = await q.order("effective_from", { ascending: true });
  if (error) throw new Error(`listInboundConnections: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapRow);
}

/**
 * Edges flowing INTO MANY nodes of one type, in a single round trip — the bulk
 * form of `listInboundConnections` for org-wide roll-ups (the disposal index,
 * the Water Disposed report) that would otherwise fire one query per node.
 */
export async function listInboundConnectionsForNodes(
  sb: Sb,
  type: FlowNodeRef["type"],
  ids: string[],
  substance?: FlowSubstance,
): Promise<FlowConnection[]> {
  if (ids.length === 0) return [];
  let q = sb
    .from("flow_connections")
    .select(COLS)
    .eq("to_type", type)
    .in("to_id", ids);
  if (substance) q = q.eq("substance", substance);
  const { data, error } = await q.order("effective_from", { ascending: true });
  if (error)
    throw new Error(`listInboundConnectionsForNodes: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapRow);
}

/** Edges flowing OUT of a node (optionally filtered to one substance). */
export async function listOutboundConnections(
  sb: Sb,
  node: FlowNodeRef,
  substance?: FlowSubstance,
): Promise<FlowConnection[]> {
  let q = sb
    .from("flow_connections")
    .select(COLS)
    .eq("from_type", node.type)
    .eq("from_id", node.id);
  if (substance) q = q.eq("substance", substance);
  const { data, error } = await q.order("effective_from", { ascending: true });
  if (error) throw new Error(`listOutboundConnections: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapRow);
}

/** The insert payload for one edge (org_id is defaulted by the DB). */
function toInsert(c: FlowConnection) {
  return {
    from_type: c.fromType,
    from_id: c.fromId,
    to_type: c.toType,
    to_id: c.toId,
    substance: c.substance,
    share_pct: c.sharePct,
    effective_from: c.effectiveFrom,
    effective_to: c.effectiveTo,
  };
}

/** Insert edges. Returns the created rows (with ids). */
export async function insertFlowConnections(
  sb: Sb,
  connections: FlowConnection[],
): Promise<FlowConnection[]> {
  if (connections.length === 0) return [];
  const { data, error } = await sb
    .from("flow_connections")
    .insert(connections.map(toInsert))
    .select(COLS);
  if (error) throw new Error(`insertFlowConnections: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapRow);
}

/**
 * Patch one edge: its share of the destination, the date it stops carrying, or
 * both. An `effectiveTo` of null reopens an edge that was closed.
 *
 * Deliberately narrow. The endpoints and the substance are what an edge IS, so
 * changing those is a different connection: close this one and draw that one.
 */
export async function updateFlowConnection(
  sb: Sb,
  id: string,
  patch: { sharePct?: number; effectiveTo?: string | null },
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.sharePct !== undefined) row.share_pct = patch.sharePct;
  if (patch.effectiveTo !== undefined) row.effective_to = patch.effectiveTo;
  if (Object.keys(row).length === 0) return;
  const { error } = await sb.from("flow_connections").update(row).eq("id", id);
  if (error) throw new Error(`updateFlowConnection: ${error.message}`);
}

/** Close a set of edges by id (set `effective_to`), e.g. when a newer test chains. */
export async function closeFlowConnections(
  sb: Sb,
  ids: string[],
  effectiveTo: string,
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await sb
    .from("flow_connections")
    .update({ effective_to: effectiveTo })
    .in("id", ids);
  if (error) throw new Error(`closeFlowConnections: ${error.message}`);
}

/**
 * A facility is going away: rejoin the lines that ran through it, then drop them.
 *
 * `A -> B -> C` with B deleted leaves `A -> C`, which is what the operator's map
 * said before and still says now — see `planConnectionBridge` for the rule and
 * for what it cannot reach. Called by the delete actions themselves rather than
 * by the facilities page, so a tank deleted from its own list heals the same way
 * as one deleted from the map.
 *
 * Bridge first, delete second: a failure in between leaves the stream described
 * twice, which is visible and fixable, rather than severed and invisible.
 */
export async function bridgeAndDropConnections(
  sb: Sb,
  node: FlowNodeRef,
): Promise<void> {
  let all: FlowConnection[];
  try {
    all = await listFlowConnections(sb);
  } catch {
    // The table is applied separately; a fleet without it has no edges to heal.
    return;
  }
  const plan = planConnectionBridge(node, all);
  if (plan.add.length > 0) {
    await insertFlowConnections(
      sb,
      plan.add.map((e) => ({
        fromType: e.from.type,
        fromId: e.from.id,
        toType: e.to.type,
        toId: e.to.id,
        substance: e.substance,
        sharePct: e.sharePct,
        // The bridge starts today; the line it replaces keeps its own history in
        // whatever closed rows the deleted facility leaves behind.
        effectiveFrom: new Date().toISOString().slice(0, 10),
        effectiveTo: null,
      })) as FlowConnection[],
    );
  }
  await deleteFlowConnections(sb, plan.removeIds);
}

/** Hard-delete edges by id (for correcting mistakes in the connection editor). */
export async function deleteFlowConnections(
  sb: Sb,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await sb.from("flow_connections").delete().in("id", ids);
  if (error) throw new Error(`deleteFlowConnections: ${error.message}`);
}
