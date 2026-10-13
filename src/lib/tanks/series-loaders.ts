import type { SupabaseClient } from "@supabase/supabase-js";
import { hauledBbls } from "@/lib/tanks/run-tickets";
import { waterTankProduction } from "@/lib/tanks/water-production";
import { swdMeterDailyBbls } from "@/lib/meters/swd-meters";
import { cachedBatteries, cachedBatteryAllocation, cachedFlowConnections, cachedLeaseMeters, cachedMeterReadings, cachedMeters, cachedTankReadings, cachedTankTickets, cachedTanks, cachedWellBatteries, cachedWellEvents } from "@/lib/cache/loaders";
import { memo } from "@/lib/cache/request-cache";
import {
  attributeWaterDay,
  type WaterMeasurement,
  type WaterMeasurementKind,
} from "@/lib/flow/water-production";
import { backfillEarliestInbound } from "@/lib/flow/graph";
import type { FlowConnection, FlowNodeType } from "@/lib/flow/types";
import {
  planWaterNodes,
  type PlannableTank,
  type WaterNodePlan,
} from "@/lib/flow/water-nodes";
import { activeAllocations, straightShares } from "@/lib/tanks/allocation";
import { downtimeAdjustedShares } from "@/lib/wells/downtime-shares";
import { isOnlineOn } from "@/lib/wells/well-events";
import { partialTailDate } from "@/lib/production/partial-day";
import {
  type NegativeSegments,
  buildTankLevelSeries,
  deriveSegments,
  dailyProduction,
  sumDailySeries,
  splitDailyByShares,
  type DailyPoint,
  type SeriesMode,
  type SeriesReading,
  type SeriesRun,
} from "@/lib/tanks/tank-series";

/**
 * Server loaders that build the tank-level production series (Phase 2) at each
 * level of the hierarchy — tank, battery, well, lease — from the RLS-scoped
 * client. The pure math lives in `tank-series.ts`; these only fetch and stitch.
 *
 * Same client-injected idiom as the rest of `@/lib/tanks/*`: pass the
 * request-scoped `getSupabaseServer()` so the `tanks` / `tank_readings` /
 * `run_tickets` policies enforce org ownership. Never the service-role client.
 *
 * Oil only (the production overhaul is oil). Gas keeps flowing from meters into
 * `ProductionPoint.gasProduction` separately; the series does not touch it.
 */

type Sb = SupabaseClient;

export interface SeriesOpts {
  from?: string;
  to?: string;
  /** Default `regularized` (Phase 1 decision); the chart toggle flips it. */
  mode?: SeriesMode;
  /** Default `keep`; the dashboard's company rows ask for `unmeasured`. See
   *  `dailyProduction`. */
  negativeSegments?: NegativeSegments;
}

/**
 * Cache key for a window/mode, so two callers asking for the same series share
 * one derivation and two asking for different ones never collide.
 */
const optsKey = (o: SeriesOpts) =>
  `${o.mode ?? "default"}|${o.from ?? ""}|${o.to ?? ""}|${o.negativeSegments ?? "keep"}`;

/** Read a tank's readings + run tickets as the pure builder's inputs. */
async function loadTankInputs(
  sb: Sb,
  tankId: string,
  /** The read window (ISO day). Windowed reads carry the last reading before
   *  it as the opening level, so the first in-window segment is whole. */
  from?: string
): Promise<{ readings: SeriesReading[]; runs: SeriesRun[] }> {
  const [readings, tickets] = await Promise.all([
    cachedTankReadings(sb, tankId, from),
    cachedTankTickets(sb, tankId, from),
  ]);
  return { readings, runs: tickets };
}

/**
 * One tank's daily oil production series. Memoized per request: the company
 * roll-up reaches the same tank once per well sharing its battery.
 */
export async function tankProductionSeries(
  sb: Sb,
  tankId: string,
  opts: SeriesOpts = {}
): Promise<DailyPoint[]> {
  return memo(sb, `tank-series:${tankId}:${optsKey(opts)}`, async () => {
    // `opts.from` windows the READ as well as the output: the level series is
    // rebuilt from the anchor reading the windowed RPC returns, so the days
    // inside the window are the same days full history would have produced.
    const { readings, runs } = await loadTankInputs(sb, tankId, opts.from);
    const segments = deriveSegments(buildTankLevelSeries(readings, runs));
    return dailyProduction(segments, opts);
  });
}

/**
 * A battery's stock (barrels on hand) over time: at each date any member tank of
 * `product` was gauged, the sum of those tanks' most-recent levels as of that
 * date. The Level views of the battery chart — oil by default, water for the
 * saltwater half of a mixed battery.
 *
 * One product at a time, never both summed: a mixed battery's crude and its
 * saltwater are different fluids in different tanks with different ceilings, and
 * a single "barrels on hand" line over the two would be a quantity nobody has.
 */
export async function batteryLevelSeries(
  sb: Sb,
  batteryId: string,
  product: "oil" | "water" = "oil"
): Promise<DailyPoint[]> {
  const tanks = (await cachedTanks(sb)).filter(
    (t) => t.batteryId === batteryId && t.product === product
  );
  const perTank = await Promise.all(
    tanks.map((t) => cachedTankReadings(sb, t.id))
  );
  const dates = new Set<string>();
  for (const readings of perTank) for (const r of readings) dates.add(r.date);

  return [...dates]
    .sort()
    .map((date) => {
      let bbls = 0;
      for (const readings of perTank) {
        // Latest reading on or before `date` (readings are oldest-first).
        let stock = 0;
        for (const r of readings) {
          if (r.date <= date) stock = r.bbls;
          else break;
        }
        bbls += stock;
      }
      return { date, bbls };
    });
}

/**
 * A battery's series: the date-aligned sum of its member oil tanks' series.
 * Memoized per request — every well on the battery asks for the same series.
 */
export async function batteryProductionSeries(
  sb: Sb,
  batteryId: string,
  opts: SeriesOpts = {}
): Promise<DailyPoint[]> {
  return memo(sb, `battery-series:${batteryId}:${optsKey(opts)}`, async () => {
    const tanks = (await cachedTanks(sb)).filter(
      (t) => t.batteryId === batteryId && t.product === "oil"
    );
    const series = await Promise.all(
      tanks.map((t) => tankProductionSeries(sb, t.id, opts))
    );
    return sumDailySeries(series);
  });
}

/**
 * A battery's produced-water series: the date-aligned sum of its member WATER
 * tanks' series — the saltwater mirror of {@link batteryProductionSeries}, and
 * deliberately the same shape of function, because it is the same idea. A
 * battery is how a pumper works a site: several tanks gauged and hauled
 * together, meaning something only when added up.
 *
 * A MIXED battery (oil tanks and water tanks, which is how they are built in the
 * field) contributes only its water tanks here, exactly as the oil twin above
 * contributes only its oil tanks. Neither total can see the other's barrels.
 */
export async function batteryWaterSeries(
  sb: Sb,
  batteryId: string
): Promise<DailyPoint[]> {
  return memo(sb, `battery-water-series:${batteryId}`, async () => {
    const tanks = (await cachedTanks(sb)).filter(
      (t) => t.batteryId === batteryId && t.product === "water"
    );
    const series = await Promise.all(
      tanks.map((t) => terminalWaterTankSeries(sb, t.id))
    );
    return sumDailySeries(series);
  });
}

/** Daily oil production summed over an explicit set of oil tanks. */
async function oilSeriesForTanks(
  sb: Sb,
  tankIds: string[],
  opts: SeriesOpts
): Promise<DailyPoint[]> {
  const series = await Promise.all(
    tankIds.map((id) => tankProductionSeries(sb, id, opts))
  );
  return sumDailySeries(series);
}

/** A lease's series: the sum of the oil tanks whose effective lease is this one. */
export async function leaseProductionSeries(
  sb: Sb,
  leaseId: string,
  opts: SeriesOpts = {}
): Promise<DailyPoint[]> {
  // `Tank.leaseId` already resolves battery-authoritative → tank fallback.
  const tanks = (await cachedTanks(sb)).filter(
    (t) => t.leaseId === leaseId && t.product === "oil"
  );
  return oilSeriesForTanks(sb, tanks.map((t) => t.id), opts);
}

/**
 * The ORG's oil series: every oil tank, summed. Not `Σ leases` — most tanks
 * carry no lease (a lease is only set when a battery is assigned one), so rolling
 * up the lease series would silently drop them. Same math as
 * `leaseProductionSeries` with the lease filter removed, so a lease's figures
 * still reconcile as a subset of this.
 */
export async function orgProductionSeries(
  sb: Sb,
  opts: SeriesOpts = {}
): Promise<DailyPoint[]> {
  const tanks = (await cachedTanks(sb)).filter((t) => t.product === "oil");
  return oilSeriesForTanks(sb, tanks.map((t) => t.id), opts);
}

/** A tank's daily haul-off series (`bbls` per day trucked off), from its run
 * tickets alone — the disposition half of a tank's production, without the gauge
 * change. Used for a NON-terminal water tank, whose gauge would otherwise
 * double-count the meter downstream. */
async function tankHaulSeries(sb: Sb, tankId: string, from?: string): Promise<DailyPoint[]> {
  return memo(sb, `tank-hauls:${tankId}:${from ?? ""}`, async () => {
    const tickets = await cachedTankTickets(sb, tankId, from);
    const byDate = new Map<string, number>();
    for (const r of tickets) {
      const bbls = Number.isFinite(r.grossBbls) ? r.grossBbls : 0;
      if (bbls === 0) continue;
      byDate.set(r.date, (byDate.get(r.date) ?? 0) + bbls);
    }
    return [...byDate.entries()]
      .map(([date, bbls]) => ({ date, bbls }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  });
}

/**
 * A TERMINAL water tank's produced-water series — the SAME haul-aware series the
 * tank's Production tab shows (`waterTankProduction`: gauge fills + hauls, with
 * hauls DRIVING production). The old `tankProductionSeries` (oil model) excludes
 * hauls, so a haul-driven water tank showed production on its own page but fed 0
 * to the well/lease — this reconciles the two to one source of truth.
 */
async function terminalWaterTankSeries(
  sb: Sb,
  tankId: string,
  from?: string
): Promise<DailyPoint[]> {
  return memo(sb, `water-tank-series:${tankId}:${from ?? ""}`, async () => {
    const [readings, tickets] = await Promise.all([
      cachedTankReadings(sb, tankId, from),
      cachedTankTickets(sb, tankId, from),
    ]);
    const hauls = tickets.map((t) => ({
      date: t.date,
      departureTime: t.departureTime,
      hauledBbls: hauledBbls(t),
      closeBbls: t.closeBbls ?? 0,
    }));
    return waterTankProduction(readings, hauls).map((p) => ({
      date: p.date,
      bbls: p.bbls,
    }));
  });
}

/**
 * A lease's produced-water series (`bbls` = produced saltwater that day),
 * following the measured-points model (docs/swd-connections-architecture.md):
 *
 *   water = Σ(terminal water tank gauge+hauls) + Σ(non-terminal tank hauls)
 *         + Σ(water-meter throughput)
 *
 * A water tank is TERMINAL when nothing downstream measures its throughput (no
 * outbound water `flow_connections` edge); its full tank series is the signal.
 * A NON-terminal tank feeds a meter, so its gauge would double-count that meter —
 * only its hauls (which bypass the meter) are added, and the meter's throughput
 * is counted separately. Terminal status is taken as of today (a good proxy; per
 * the model a tank with no chain is terminal). Safety: with no `flow_connections`
 * water edges, every tank is terminal and this reduces EXACTLY to the old
 * "sum of water tanks' series", so numbers don't move until chains are drawn.
 * (Known gap: a tank feeding an SWD well DIRECTLY, no meter and no hauls, isn't
 * measured here — add a water meter on that line to capture it.)
 */
export async function leaseWaterSeries(
  sb: Sb,
  leaseId: string,
  /** `from` windows the read (see `RATE_WINDOW_DAYS`); unset reads whole. */
  opts: { from?: string } = {}
): Promise<DailyPoint[]> {
  const allTanks = await cachedTanks(sb);
  const tanks = allTanks.filter(
    (t) => t.leaseId === leaseId && t.product === "water"
  );
  const meters = await cachedLeaseMeters(sb, leaseId, "water");
  return waterSeriesForNodes(sb, tanks, meters, opts.from);
}

/**
 * The ORG's produced-water series: every water tank and every wired water meter.
 * Same measured-points model as `leaseWaterSeries` with the lease filter removed
 * (most water tanks/meters carry no lease, so `Σ leases` would undercount).
 */
export async function orgWaterSeries(sb: Sb): Promise<DailyPoint[]> {
  const tanks = (await cachedTanks(sb)).filter((t) => t.product === "water");
  const meters = await cachedMeters(sb, "water");
  return waterSeriesForNodes(sb, tanks, meters);
}

/**
 * The measured-points water sum over an explicit node set: each water tank
 * contributes its hauls (non-terminal) or its full gauge+haul series (terminal),
 * and each water meter wired into a chain contributes its throughput. Meters that
 * aren't wired are skipped — counting one would double-count the terminal tank
 * still measuring the same water.
 */
async function waterSeriesForNodes(
  sb: Sb,
  // Carries `injectionWellId` explicitly: a Mode-B node's gauge must not be
  // read, and a narrower parameter type would let a caller drop the field and
  // silently start counting those barrels twice.
  tanks: PlannableTank[],
  meters: { id: string }[],
  from?: string
): Promise<DailyPoint[]> {
  // Active water flow graph: the edges (so battery inheritance can be resolved)
  // and which meters are wired into a chain. Degrades to "no edges" if the table
  // is absent, in which case every node is terminal and this reduces exactly to
  // the pre-battery sum.
  const { edges, wiredMeterIds, injectedBatteryIds } = await waterFlowInfo(sb);
  const today = new Date().toISOString().slice(0, 10);

  // One plan, shared with the per-well attribution below, so the two can never
  // disagree about which nodes were measured or how (`@/lib/flow/water-nodes`).
  const nodeSeries = await Promise.all(
    planWaterNodes(tanks, edges, today, injectedBatteryIds).map((plan) =>
      waterNodeSeries(sb, plan, from)
    )
  );

  const meterSeries = await Promise.all(
    meters
      .filter((m) => wiredMeterIds.has(m.id))
      // The anchor row the windowed read carries is the index the first
      // in-window day's barrels are differenced against.
      .map(async (m) => swdMeterDailyBbls(await cachedMeterReadings(sb, m.id, from)))
  );

  return sumDailySeries([...nodeSeries, ...meterSeries]);
}

/** One planned water node's series: its tanks' full gauge+haul series when
 *  terminal, their hauls alone when something downstream measures them. A
 *  battery is the sum over its members — the saltwater twin of an oil battery
 *  being the sum over its tanks. */
async function waterNodeSeries(
  sb: Sb,
  plan: WaterNodePlan,
  from?: string
): Promise<DailyPoint[]> {
  const parts = await Promise.all(
    plan.tankIds.map((id) =>
      plan.kind === "haul"
        ? tankHaulSeries(sb, id, from)
        : terminalWaterTankSeries(sb, id, from)
    )
  );
  return sumDailySeries(parts);
}

/** The active water `flow_connections` plus the meters with an inbound water
 * edge (wired into a chain). The edges are returned whole rather than reduced to
 * a set of non-terminal tanks, because whether a tank is terminal now depends on
 * its BATTERY's edges too — see `@/lib/flow/battery-edges`. Empty if the table is
 * absent (pre-migration degrade). */
async function waterFlowInfo(sb: Sb): Promise<{
  edges: FlowConnection[];
  wiredMeterIds: Set<string>;
  injectedBatteryIds: Set<string>;
}> {
  return memo(sb, "water-flow-info", async () => {
    const wiredMeterIds = new Set<string>();
    const injectedBatteryIds = new Set<string>();
    let edges: FlowConnection[] = [];
    try {
      // From the battery roster already in the request store, not a third
      // read of `tank_batteries`; the waterfall had this one starting alone
      // after every other wave had landed.
      for (const b of await cachedBatteries(sb)) {
        if (b.injectionWellId) injectedBatteryIds.add(b.id);
      }
    } catch {
      // column not present yet (pre-migration degrade)
    }
    try {
      const conns = await cachedFlowConnections(sb);
      edges = conns.filter((c) => c.substance === "water");
      const t = new Date().toISOString().slice(0, 10);
      for (const c of edges) {
        if (!(c.effectiveFrom <= t && (c.effectiveTo == null || c.effectiveTo >= t))) continue;
        if (c.toType === "meter") wiredMeterIds.add(c.toId);
      }
    } catch {
      // table not present yet
    }
    return { edges, wiredMeterIds, injectedBatteryIds };
  });
}

/**
 * A well's slice of something measured, and the day the MEASUREMENT stops.
 *
 * The two travel together because the boundary cannot be recovered from the
 * rows. A slice's last row can be the last day the tanks were gauged -- a few
 * hours of oil under a whole day's date, which every reader drops -- or the day
 * the well came off the split, which is a whole day it is owed. Same shape, and
 * dropping the second one deletes barrels: a well taken off a battery lost its
 * final day and the org's wells stopped summing to what its tanks measured.
 *
 * So the loader, which is holding the measured series when it cuts the slice out
 * of it, says which day that was. `partialTailDate(rows)` on a well's rows is
 * always wrong; on a tank, battery or lease series it is right, because those
 * ARE the measurement.
 */
export interface AllocatedSeries {
  rows: DailyPoint[];
  /**
   * The last day the measured series behind this slice covers, or null when
   * nothing measured. Feed it to `withoutPartialTail`.
   */
  measuredThrough: string | null;
}

/** The later of two dates, either of which may be missing. */
function laterDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * A well's series: for each battery that feeds the well, take the battery's total
 * daily series (the sum of its member oil tanks), split it to wells by the
 * battery's RESOLVED allocation timeline (manual + well-test periods already
 * reduced to effective-dated straight %s), keep this well's slice, and sum across
 * the batteries. Allocation lives at the battery, not the tank.
 *
 * Returns the batteries' own last measured day alongside (see
 * {@link AllocatedSeries}). Across several batteries it is the LATEST of them,
 * which is the day the union of the measured series runs out.
 */
export async function wellProductionSeries(
  sb: Sb,
  wellId: string,
  opts: SeriesOpts = {}
): Promise<AllocatedSeries> {
  const batteryIds = await cachedWellBatteries(sb, wellId);
  if (batteryIds.length === 0) return { rows: [], measuredThrough: null };

  const perBattery = await Promise.all(
    batteryIds.map(async (batteryId) => {
      const [daily, config] = await Promise.all([
        batteryProductionSeries(sb, batteryId, opts),
        cachedBatteryAllocation(sb, batteryId),
      ]);
      // Downtime reweight: a well down on a day drops to 0% and its online
      // siblings absorb its share (group still sums to 100%). Load the group's
      // events once; `downtimeAdjustedShares` is a no-op on days nobody is down.
      const eventsByWell = await cachedWellEvents(
        sb,
        config.allocations.map((a) => a.wellId)
      );
      // Resolution baked well-test %s into straight rows, so the per-date split is
      // just the active straight shares for that day (then downtime-adjusted).
      const resolver = (date: string) =>
        downtimeAdjustedShares(
          straightShares(activeAllocations(config.allocations, date)),
          eventsByWell,
          date
        );
      const byWell = splitDailyByShares(daily, resolver);
      return {
        rows: byWell.get(wellId) ?? [],
        // `daily` is the MEASURED battery series this slice came out of.
        measuredThrough: partialTailDate(daily),
      };
    })
  );

  return {
    rows: sumDailySeries(perBattery.map((b) => b.rows)),
    measuredThrough: perBattery.reduce<string | null>(
      (acc, b) => laterDate(acc, b.measuredThrough),
      null
    ),
  };
}

/**
 * A well's produced-water series (`bbls` = attributed saltwater that day). The
 * measured-points water model (`leaseWaterSeries`) attributed back to THIS well
 * through `flow_connections`: each measured node's daily volume — water-meter
 * throughput, non-terminal tank hauls, terminal water-tank gauge+hauls — is traced
 * upstream to producing wells on its own date (`attributeWaterProduction`), and
 * this well's slice is summed per day. Uses the SAME node selection as
 * `leaseWaterSeries`, so the per-well slices across a lease sum to the lease total
 * (no double-count). Empty when nothing upstream measures water to the well.
 *
 * The water analogue of `wellProductionSeries` (oil) and `wellGasSeries` (gas).
 */
export async function wellWaterSeries(
  sb: Sb,
  wellId: string,
  /** `from`: window the reads and the attribution to an ISO day (the rate
   *  derivations' 30 days). Omitted, the whole history, from its own cache. */
  opts: { from?: string } = {}
): Promise<AllocatedSeries> {
  // Attribution can only ever reach a well through a water edge leaving it, so
  // a well with none in the effective graph gets an empty series without
  // building the org-wide pipeline below — which reads every water tank's and
  // meter's full history. Most producers have no water wiring; this check is one
  // cached read of the (small) flow_connections table, using the same backfill
  // the attribution itself applies so the two can never disagree about coverage.
  const conns = backfillEarliestInbound(await cachedFlowConnections(sb), "water");
  const feedsWater = conns.some(
    (c) =>
      c.substance === "water" && c.fromType === "well" && c.fromId === wellId
  );
  if (!feedsWater) return { rows: [], measuredThrough: null };

  const { byWell, measured, measuredThrough } = await waterAttribution(sb, opts.from);
  const series = byWell.get(wellId) ?? [];
  if (process.env.WATER_DEBUG === "1") {
    const total = series.reduce((s, p) => s + p.bbls, 0);
    console.log(
      "[saltwater]",
      `well=${wellId}`,
      `step 7 — attribution: ${measured} bbl measured across all nodes → ${total} bbl to this well over ${series.length} days`
    );
    if (measured > 0 && series.length === 0) {
      console.log(
        "[saltwater]",
        `well=${wellId}`,
        "WARNING: water was measured but 0 reached this well — the flow edges don't " +
          "attribute to it (missing/zero split; check the node's Wells tab / well test)."
      );
    }
  }
  return { rows: series, measuredThrough };
}

/**
 * The whole produced-water attribution for the org, computed ONCE per request:
 * every measured node's daily volume traced upstream to producing wells, keyed
 * by well. The inputs (nodes, flow edges, downtime) are org-wide and identical
 * for every well, so the per-well answer is a lookup, not a rebuild — this used
 * to run the entire pipeline (all tanks, all meters, the graph walk over every
 * date) once per well.
 */
async function waterAttribution(sb: Sb, from?: string): Promise<WaterAttribution> {
  return memo(sb, `water-attribution:${from ?? ""}`, () => buildWaterAttribution(sb, from));
}

interface WaterAttribution {
  byWell: Map<string, DailyPoint[]>;
  measured: number;
  /** The last day any water node was measured -- see {@link AllocatedSeries}. */
  measuredThrough: string | null;
}

/**
 * Request every water node's inputs at `from`, so the attribution's node
 * series find them in the store.
 *
 * Which nodes are measured is only known once the effective graph is in, but
 * every water tank's readings and hauls and every water meter's readings at
 * this window are what the node series read, whichever nodes they turn out to
 * be, and the rosters are already in the store. Asked after the graph they
 * were a wave of their own, then the hauls another, on every page with a
 * water series. A page that KNOWS it will draw water (a lease's) calls this
 * beside its rosters, a wave before the attribution itself is reached; the
 * attribution calls it too, for everything else. The result is not consumed:
 * the node series make the same requests and surface any error.
 */
export function primeWaterAttributionInputs(sb: Sb, from?: string): Promise<unknown> {
  return Promise.all([
    cachedTanks(sb).then((ts) =>
      Promise.all(
        ts
          .filter((t) => t.product === "water")
          .flatMap((t) => [cachedTankReadings(sb, t.id, from), cachedTankTickets(sb, t.id, from)])
      )
    ),
    cachedMeters(sb, "water").then((ms) => Promise.all(ms.map((m) => cachedMeterReadings(sb, m.id, from)))),
  ]);
}

async function buildWaterAttribution(sb: Sb, from?: string): Promise<WaterAttribution> {
  // Set WATER_DEBUG=1 to trace the whole saltwater path in the server log.
  const dbg = process.env.WATER_DEBUG === "1";
  const log = (...a: unknown[]) => {
    if (dbg) console.log("[saltwater]", ...a);
  };

  // A well's saltwater = Σ over the water tanks/meters it FEEDS (by allocation /
  // flow edges) of that node's production series × the well's share. So consider
  // ALL water tanks + wired water meters in the org; the attribution below gives
  // each well its allocated slice and 0 for nodes it doesn't feed. NOT lease-scoped:
  // wells and disposal tanks are wired by allocation, and may carry no lease.
  // The measured nodes' inputs, requested in the same tick as the graph
  // (see `primeWaterAttributionInputs`).
  primeWaterAttributionInputs(sb, from).catch(() => {});
  const [allTanks, allWaterMeters, rawConns, flow] = await Promise.all([
    cachedTanks(sb),
    cachedMeters(sb, "water"),
    cachedFlowConnections(sb),
    waterFlowInfo(sb),
  ]);
  const { edges: waterEdges, wiredMeterIds, injectedBatteryIds } = flow;
  const today = new Date().toISOString().slice(0, 10);
  const conns = backfillEarliestInbound(rawConns, "water");

  // Downtime: a producing well down on a date produces no water, so its share of
  // any node measured that date flows to its online siblings. Load events for
  // every well that feeds water anywhere in the graph and bind a per-day predicate
  // (a no-op on days nobody is down; the all-down fallback lives in the graph walk).
  const waterSourceWells = conns
    .filter((c) => c.substance === "water" && c.fromType === "well")
    .map((c) => c.fromId);
  const eventsByWell = await cachedWellEvents(sb, waterSourceWells);
  const isWellDown = (wid: string, date: string) =>
    !isOnlineOn(eventsByWell.get(wid) ?? [], date);

  /*
   * The MEASURED NODES — planned by the same function the roll-ups use, so "what
   * was measured, and how" has exactly one answer. A water tank in a battery is
   * not a node: its battery is, because that is what the water split resolves
   * against (one station, one pooled set of well tests) and because counting
   * both would attribute the same barrels twice.
   */
  const tanks = allTanks.filter((t) => t.product === "water");
  const plans = planWaterNodes(tanks, waterEdges, today, injectedBatteryIds);
  const meters = allWaterMeters.filter((m) => wiredMeterIds.has(m.id));
  log(
    `step 1 — measured water nodes (${plans.length}):`,
    plans.map((p) => ({ node: `${p.node.type}:${p.node.id}`, kind: p.kind, tanks: p.tankIds.length }))
  );
  log(
    `step 2 — wired water meters (${meters.length}) of ${allWaterMeters.length}:`,
    meters.map((m) => ({ id: m.id, name: m.name }))
  );

  // Step 5 — the water edges the attribution walks (well -> node), from the
  // effective flow graph. Empty here means no test/manual split reaches any well.
  log(
    "step 5 — active water edges into these nodes:",
    conns
      .filter(
        (c) =>
          c.substance === "water" &&
          (plans.some((p) => p.node.id === c.toId) ||
            meters.some((m) => m.id === c.toId))
      )
      .map((c) => ({ from: c.fromId, to: `${c.toType}:${c.toId}`, pct: c.sharePct }))
  );

  const measurements: WaterMeasurement[] = [];
  const push = (
    nodeType: FlowNodeType,
    nodeId: string,
    kind: WaterMeasurementKind,
    series: DailyPoint[]
  ) => {
    const total = series.reduce((s, p) => s + p.bbls, 0);
    log(`step 6 — measured ${nodeType}:${nodeId} (${kind}): total ${total} bbl over ${series.length} days`);
    /*
     * ZERO DAYS ARE MEASUREMENTS. A node gauged at nothing on a date is a day
     * the wells behind it made nothing, and dropping it left each well's series
     * made only of its good days — an EMA over a different set of dates than the
     * meter's own. Ten wells on Hughes M1 summed to 158 bbl/d under a meter
     * reading 156 for exactly this reason. The attribution below skips a zero
     * for the split (there is nothing to divide) but still records the day.
     */
    for (const p of series) {
      measurements.push({ nodeType, nodeId, kind, bbls: p.bbls, date: p.date });
    }
  };
  await Promise.all([
    ...plans.map(async (plan) => {
      // One measurement per NODE — never one per member tank, or a station's
      // water reaches its wells once per tank.
      push(plan.node.type, plan.node.id, plan.kind, await waterNodeSeries(sb, plan, from));
    }),
    ...meters.map(async (m) => {
      push(
        "meter",
        m.id,
        "throughput",
        swdMeterDailyBbls(await cachedMeterReadings(sb, m.id, from))
      );
    }),
  ]);

  // Attribute each date's measurements to wells, accumulating EVERY well's daily
  // slice (a zero day drops out, as it did per-well before).
  const byDateByWell = new Map<string, Map<string, number>>();
  let totalMeasured = 0;
  const byDateMeasurements = new Map<string, WaterMeasurement[]>();
  for (const m of measurements) {
    const list = byDateMeasurements.get(m.date);
    if (list) list.push(m);
    else byDateMeasurements.set(m.date, [m]);
  }
  for (const [date, dayMeas] of byDateMeasurements) {
    totalMeasured += dayMeas.reduce((s, m) => s + m.bbls, 0);
    // Every well feeding something measured today, zeros included — see
    // `attributeWaterDay`. That is what makes a meter's card equal the sum of
    // the wells drawn feeding it.
    for (const [wid, v] of attributeWaterDay(dayMeas, conns, isWellDown)) {
      let dates = byDateByWell.get(wid);
      if (!dates) byDateByWell.set(wid, (dates = new Map()));
      dates.set(date, v);
    }
  }
  log(`step 7 — attribution: ${totalMeasured} bbl measured across all nodes → ${byDateByWell.size} wells`);
  if (plans.length === 0 && meters.length === 0) {
    log("WARNING: no water tanks or wired water meters exist in the org.");
  }

  const byWell = new Map<string, DailyPoint[]>();
  for (const [wid, dates] of byDateByWell) {
    byWell.set(
      wid,
      [...dates.entries()]
        .map(([date, bbls]) => ({ date, bbls }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    );
  }
  return {
    byWell,
    measured: totalMeasured,
    // Every measured node-day, not this well's slice of them: a well whose share
    // ended still measured through the last gauge on the node it fed.
    measuredThrough: partialTailDate(measurements),
  };
}
