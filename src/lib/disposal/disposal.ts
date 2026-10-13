/**
 * Saltwater disposal / injection data-access (GBC-9).
 *
 * Reads go through the request-scoped RLS client (`getSupabaseServer`), so the
 * `disposal_readings` policies scope every read to the caller's org — a well or
 * reading outside their org simply isn't returned. Injection wells are ordinary
 * `wells` rows with `type = 'injection'`.
 */

import { hasSupabase } from "@/lib/env";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getWells, type Well } from "@/lib/wells/wells";
import { listInjectionTanks } from "@/lib/tanks/tanks";
import { listInjectionBatteries } from "@/lib/batteries/batteries";
import { attributeToWells, backfillEarliestInbound } from "@/lib/flow/graph";
import { loadEffectiveFlowConnections } from "@/lib/flow/effective-water";
import { listDisposalReadings } from "@/lib/disposal/readings";
import { loadDisposalWellSeries } from "@/lib/disposal/well-meters";
import type { FlowConnection, FlowNodeRef } from "@/lib/flow/types";
import type { DisposalReading } from "@/lib/disposal/types";

/** Far-past start for a synthesized legacy edge, so it covers all history. */
const LEGACY_EDGE_FROM = "1900-01-01";

/** Injection / SWD wells (type = 'injection'), ordered by name. */
export async function getInjectionWells(): Promise<Well[]> {
  const wells = await getWells();
  return wells.filter((w) => w.type === "injection");
}

/** An injection well's hand-entered disposal readings, oldest first. */
export async function getDisposalReadings(
  wellId: string
): Promise<DisposalReading[]> {
  if (!hasSupabase()) return [];
  return listDisposalReadings(await getSupabaseServer(), wellId);
}

/** A producing well's attributed slice of an SWD well's disposal (volume). */
export interface DisposalSourceRow {
  wellId: string;
  wellName: string;
  volume: number;
  share: number;
}

/**
 * Attribute an SWD well's disposed volume back to the producing wells whose water
 * it took, by walking `flow_connections` upstream (`attributeToWells`) — the same
 * engine and the same edges the facilities map and produced-water attribution use.
 *
 * Attribution happens PER MEASURED ROW, at the node that measured it:
 *  - a meter row traces upstream from THAT meter, so with two meters on the well
 *    each one's barrels go to its own wells rather than to a blended split;
 *  - a hand-entered row (unmetered well) traces upstream from the well itself.
 * Each row is attributed on its own date, so a split that changed mid-history
 * applies to the volume it actually governed.
 *
 * `tanks.injection_well_id` is folded in as a synthesized tank -> well water edge:
 * that FK predates `flow_connections` and was never backfilled, so a tank wired
 * straight to an SWD well would otherwise attribute nothing. A BATTERY's own
 * link (`tank_batteries.injection_well_id`) is folded in the same way, and a
 * member tank of such a battery does NOT also get an edge — the station reaches
 * the well once, however many tanks sit on it.
 *
 * `share` is each well's fraction of the well's TOTAL disposal, so shares that
 * don't sum to 100% honestly show volume the graph couldn't attribute.
 */
export async function getDisposalBySourceWell(
  injectionWellId: string
): Promise<DisposalSourceRow[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();

  const series = await loadDisposalWellSeries(sb, injectionWellId);
  if (!(series.total > 0)) return [];

  const [connections, wells, tanks, batteries] = await Promise.all([
    loadEffectiveFlowConnections(sb),
    getWells(),
    listInjectionTanks(sb, injectionWellId),
    listInjectionBatteries(sb, injectionWellId),
  ]);

  const linkedBatteryIds = new Set(batteries.map((b) => b.id));
  const legacyTankEdges: FlowConnection[] = tanks
    // A tank whose battery carries the link is covered by the battery's edge
    // below; giving it one of its own would feed the well twice.
    .filter((t) => !(t.batteryId && linkedBatteryIds.has(t.batteryId)))
    .map((t) => ({
      fromType: "tank" as const,
      fromId: t.id,
      toType: "well" as const,
      toId: injectionWellId,
      substance: "water" as const,
      sharePct: t.injectionSharePct ?? 100,
      effectiveFrom: LEGACY_EDGE_FROM,
      effectiveTo: null,
    }));
  const legacyBatteryEdges: FlowConnection[] = batteries.map((b) => ({
    fromType: "battery",
    fromId: b.id,
    toType: "well",
    toId: injectionWellId,
    substance: "water",
    sharePct: b.injectionSharePct ?? 100,
    effectiveFrom: LEGACY_EDGE_FROM,
    effectiveTo: null,
  }));
  // Retroactive earliest-inbound backfill, so volume dated before a node's first
  // split is still attributed by that split (the read-side rule in flow/graph).
  const edges = backfillEarliestInbound(
    [...connections, ...legacyTankEdges, ...legacyBatteryEdges],
    "water"
  );

  const byWell = new Map<string, number>();
  for (const row of series.rows) {
    if (!row.volume) continue;
    const measuredAt: FlowNodeRef =
      row.source === "meter" && row.sourceId
        ? { type: "meter", id: row.sourceId }
        : { type: "well", id: injectionWellId };
    const { shares } = attributeToWells(measuredAt, "water", row.date, edges);
    for (const [wellId, share] of shares) {
      const volume = row.volume * share;
      if (volume > 0) byWell.set(wellId, (byWell.get(wellId) ?? 0) + volume);
    }
  }

  const nameById = new Map(wells.map((w) => [w.id, w.name]));
  return [...byWell.entries()]
    .map(([wellId, volume]) => ({
      wellId,
      wellName: nameById.get(wellId) ?? wellId,
      volume,
      share: volume / series.total,
    }))
    .sort((a, b) => b.volume - a.volume);
}

/** Every hand-entered disposal reading in the org. */
export async function getAllDisposalReadings(): Promise<DisposalReading[]> {
  if (!hasSupabase()) return [];
  return listDisposalReadings(await getSupabaseServer());
}
