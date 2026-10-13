/**
 * The meters wired into an SWD/injection well, and the series they produce —
 * the data-access half of `well-series.ts` (which holds the math).
 *
 * A water meter is wired to a disposal well by a water path through
 * `flow_connections`, the same generic edge store the facilities map and the
 * water well tests use — `meter -> well` directly, or through the station's
 * tanks and battery (`meter -> battery -> well`, which is how an SWD is plumbed
 * and how one is seeded). `metersReachingWell` resolves the path and the dates
 * it was live; that path is the whole relationship, and the meter measures what
 * the well took exactly as a gas meter measures a gas well.
 *
 * Client-injected RLS idiom (`getSupabaseServer()` as the first argument);
 * ownership is enforced by the `flow_connections` / `meters` / `meter_readings`
 * policies. Never hand these the service-role client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listFlowConnections } from "@/lib/flow/connections";
import { listMeters, listReadingsByMeter } from "@/lib/meters/meters";
import { listDisposalReadings } from "@/lib/disposal/readings";
import {
  buildDisposalWellSeries,
  windowActiveOn,
  type DisposalMeterFeed,
  type DisposalWellSeries,
  type FlowWindow,
} from "@/lib/disposal/well-series";
import { metersReachingWell } from "@/lib/disposal/meter-reach";
import type { FlowConnection } from "@/lib/flow/types";
import type { Meter } from "@/lib/meters/meters";

type Sb = SupabaseClient;

/** Today as ISO `YYYY-MM-DD` (UTC) — the default "is this well metered" date. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A water meter wired into a well, with the edges that wire it. */
export interface WellMeterLink {
  meter: Meter;
  /**
   * The METER'S OWN edges into this well's chain, oldest first — `meter -> well`
   * on a directly wired meter, `meter -> battery` on a station. What a detach
   * closes: the meter comes off the line, and the battery's own link to the well
   * is untouched.
   */
  edges: FlowConnection[];
  /**
   * When the meter actually measured this well: the intersection of every edge
   * along the path, one window per path. Equal to `edges`' own windows on a
   * directly wired meter.
   */
  windows: FlowWindow[];
  /** True when one of those windows covers the date asked about. */
  active: boolean;
  /** True when the meter reaches the well through a tank or battery. */
  chained: boolean;
}

/**
 * The water meters wired into one injection well (whether or not their edge is
 * still open — a detached meter's history still counts for the dates it covered).
 */
export async function listWellMeterLinks(
  sb: Sb,
  wellId: string,
  onDate: string = todayIso()
): Promise<WellMeterLink[]> {
  // The whole org's edges rather than the well's inbound ones: a chained meter
  // is two or three hops away, so the inbound query would not see it.
  const reach = metersReachingWell(wellId, await listFlowConnections(sb));
  if (reach.size === 0) return [];

  const meters = await listMeters(sb, "water");
  const byId = new Map(meters.map((m) => [m.id, m]));

  return [...reach.values()]
    .flatMap((r) => {
      const meter = byId.get(r.meterId);
      // A path ending at a meter that no longer exists (or isn't visible) is
      // dropped rather than rendered as a ghost row.
      return meter
        ? [
            {
              meter,
              edges: [...r.firstHop].sort((a, b) =>
                a.effectiveFrom.localeCompare(b.effectiveFrom)
              ),
              windows: r.windows,
              active: windowActiveOn(r.windows, onDate),
              chained: r.chained,
            },
          ]
        : [];
    })
    .sort((a, b) => a.meter.name.localeCompare(b.meter.name));
}

/**
 * Derived disposal series for MANY injection wells in a fixed number of queries
 * (edges, meters, readings, hand-entered readings — four, regardless of well
 * count). Wells with neither a meter nor a reading get an empty series, so the
 * caller can render a complete roster.
 */
export async function loadDisposalSeriesByWell(
  sb: Sb,
  wellIds: string[],
  onDate: string = todayIso()
): Promise<Map<string, DisposalWellSeries>> {
  const out = new Map<string, DisposalWellSeries>();
  if (wellIds.length === 0) return out;

  const [connections, manual] = await Promise.all([
    // Every edge, once, for the whole roll-up: the walk to a chained meter
    // leaves the well's own inbound set, and one read serves every well here.
    listFlowConnections(sb),
    listDisposalReadings(sb),
  ]);
  const reachByWell = new Map(
    wellIds.map((id) => [id, metersReachingWell(id, connections)] as const)
  );

  const meterIds = [
    ...new Set([...reachByWell.values()].flatMap((r) => [...r.keys()])),
  ];
  const [meters, readingsByMeter] = await Promise.all([
    meterIds.length > 0 ? listMeters(sb, "water") : Promise.resolve([]),
    listReadingsByMeter(sb, meterIds),
  ]);
  const meterById = new Map(meters.map((m) => [m.id, m]));

  const feedsByWell = new Map<string, Map<string, DisposalMeterFeed>>();
  for (const [wellId, reach] of reachByWell) {
    const feeds = new Map<string, DisposalMeterFeed>();
    for (const r of reach.values()) {
      const meter = meterById.get(r.meterId);
      if (!meter) continue;
      feeds.set(r.meterId, {
        meterId: meter.id,
        meterName: meter.name,
        readings: readingsByMeter.get(meter.id) ?? [],
        // One feed per meter carrying every path's window, so a meter that
        // reaches the well two ways is counted once over the union of them.
        edges: r.windows,
      });
    }
    if (feeds.size > 0) feedsByWell.set(wellId, feeds);
  }

  const manualByWell = new Map<string, typeof manual>();
  for (const r of manual) {
    const list = manualByWell.get(r.wellId);
    if (list) list.push(r);
    else manualByWell.set(r.wellId, [r]);
  }

  for (const wellId of wellIds) {
    out.set(
      wellId,
      buildDisposalWellSeries(
        [...(feedsByWell.get(wellId)?.values() ?? [])],
        manualByWell.get(wellId) ?? [],
        onDate
      )
    );
  }
  return out;
}

/** The derived disposal series for one injection well. */
export async function loadDisposalWellSeries(
  sb: Sb,
  wellId: string,
  onDate: string = todayIso()
): Promise<DisposalWellSeries> {
  const map = await loadDisposalSeriesByWell(sb, [wellId], onDate);
  return map.get(wellId)!;
}

/**
 * Is this well metered right now? The gate every hand-entry write path checks —
 * a metered well's volume comes from its meter, so a new `disposal_readings` row
 * would be a second, conflicting measurement of the same barrels.
 */
export async function isWellMetered(
  sb: Sb,
  wellId: string,
  onDate: string = todayIso()
): Promise<boolean> {
  const links = await listWellMeterLinks(sb, wellId, onDate);
  return links.some((l) => l.active);
}
