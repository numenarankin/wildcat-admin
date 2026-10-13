/**
 * Facility graph (Facilities page) — the pure, dependency-free model of an
 * operation's physical flow across all three substances. Wells, tanks, meters,
 * batteries, and SWD wells are NODES; the directional "one facility feeds
 * another" links are EDGES, colored by the substance moving along them.
 *
 * The edges are exactly the FK/allocation wiring that already exists (see
 * `saltwater-measurement-architecture.md`):
 *
 *   well  -> battery   (battery_well_allocations)   oil
 *   well  -> meter     (meter_well_allocations)     gas
 *   well  -> tank      (tank_well_allocations)      oil or water (by tank product)
 *   tank  -> battery   (tanks.battery_id)           oil   (member rollup)
 *   tank  -> SWD well  (tanks.injection_well_id)    water (flow-through, Mode B)
 *
 * A node belongs to a lease (its `leaseId`), which the Facilities canvas draws as
 * a territory. This module is pure so it unit-tests without a DB and can re-derive
 * live in the browser as the graph is edited.
 */

import { tankDisplayName } from "@/lib/tanks/tank-name";
import { meterDisplayName } from "@/lib/meters/meter-name";

export type Substance = "oil" | "gas" | "water";

export type FacilityKind =
  | "well"
  | "injection"
  | "tank"
  | "meter"
  | "battery"
  | "gatherer";

/** One node on the facilities canvas. */
export interface FacilityNode {
  /** Stable id, unique across kinds (kind-prefixed — see `nodeId`). */
  id: string;
  kind: FacilityKind;
  /** Underlying record id (well slug, tank/meter/battery uuid). */
  refId: string;
  name: string;
  /** Lease this node sits in (`null` = unassigned → the "Unassigned" territory). */
  leaseId: string | null;
  /** Substances this node handles, for coloring/badging. */
  substances: Substance[];
  /** Headline daily flow/production for the node (bbl/d or mcf/d), or null. */
  flow: number | null;
  /**
   * The rate this node is ALLOWED to run at, in the same unit as `flow`, or
   * null when nothing limits it.
   *
   * Injection wells only, and it comes from the state's UIC permit rather than
   * from anything we measured — so it is a ceiling on `flow`, never a
   * substitute for it. A node with a capacity and no flow means "permitted, no
   * throughput logged", which is a different thing from "at zero".
   */
  capacity?: number | null;
  /** True when a full equipment list is meaningful for this node (wells only). */
  hasEquipment: boolean;
  /** Producing-well scalars for the summary rollup (rates in bbl/d or mcf/d, $/mo
   * for revenue/pl). Present on producer wells only. */
  metrics?: WellMetrics;
  /**
   * The commodities this well holds a SPLIT ROW for, whatever that row says —
   * oil when it is on a battery, gas/water when it is on a meter of that
   * substance, water when it is on a water tank.
   *
   * It separates the two ways a card can have no number: a well nobody has
   * allocated (nothing to show) from one allocated 0% or shut in (making
   * nothing, which is a measurement). The first stays blank, the second reads
   * "0" — see `nodeRate`.
   */
  allocated?: Substance[];
  /** Client-only: a palette-dropped node not yet persisted. Never set by the
   * builder; the canvas sets it on provisional placements. */
  provisional?: boolean;
}

/** Producing-well production + economics, summed for the Facilities stat card. */
export interface WellMetrics {
  oil: number;
  gas: number;
  water: number;
  /** Monthly gross revenue, US$. */
  revenue: number;
  /** Monthly profit/loss, US$. */
  pl: number;
}

/** A directional flow link between two nodes. */
export interface FacilityEdge {
  id: string;
  /** Source node id (upstream — where the substance comes from). */
  from: string;
  /** Target node id (downstream — where it flows to). */
  to: string;
  substance: Substance;
  /** Approximate daily flow along the edge (share × source rate), or null. */
  flow: number | null;
  /** True for an operator-drawn `flow_connections` edge (deletable), vs an edge
   * derived from the legacy FK/allocation tables. */
  custom?: boolean;
  /** The `flow_connections` row id, when this is a custom edge (for deletion). */
  connectionId?: string;
}

/** A lease territory: the nodes grouped under one lease. */
export interface Territory {
  /** Lease id, or `null` for the catch-all unassigned territory. */
  leaseId: string | null;
  name: string;
  nodeIds: string[];
}

export interface FacilityGraph {
  nodes: FacilityNode[];
  edges: FacilityEdge[];
  territories: Territory[];
}

// --- Inputs (structurally satisfied by the lib row types) -------------------

export interface GraphWell {
  id: string;
  name: string;
  type: "producer" | "injection";
  /** SWD only: 30-day disposal rate, bbl/d, from `swdWellIndicators`. */
  disposalBblPerDay?: number | null;
  /** SWD only: the UIC permit's authorised rate, bbl/d. */
  permittedBblPerDay?: number | null;
  leaseId: string | null;
  oilProduction: number;
  gasProduction: number;
  saltWater: number;
  /** Monthly gross revenue, US$ (defaults to 0). */
  revenue?: number;
  /** Monthly profit/loss, US$ (defaults to 0). */
  pl?: number;
}

export interface GraphTank {
  id: string;
  name: string;
  product: "oil" | "water";
  leaseId: string | null;
  batteryId: string | null;
  injectionWellId: string | null;
  /** The number painted on the tank — half its name (`tankDisplayName`). Needed
   *  to re-derive that name when the map resolves a lease the row lacks. */
  tankNo?: string | null;
}

export interface GraphMeter {
  id: string;
  name: string;
  leaseId: string | null;
  /** What the meter measures — gas (mcf) or water (bbl). Defaults to gas. */
  substance?: Substance;
  /** The meter number — half its name (`meterDisplayName`); see `tankNo`. */
  meterNo?: string | null;
}

/** A haul-off / off-site destination (a gatherer or disposal company). */
export interface GraphGatherer {
  id: string;
  name: string;
}

export interface GraphBattery {
  id: string;
  name: string;
  leaseId: string | null;
  /** Mode B: the SWD well this battery's WATER feeds (`docs/swd-batteries-plan.md`
   *  §2). Replaces the member tanks' own links while they are on it. */
  injectionWellId?: string | null;
}

export interface GraphLease {
  id: string;
  /** Display label (e.g. "1234 · North Unit"). */
  label: string;
}

/** One `*_well_allocations` row, generalized across the three split tables. */
export interface GraphAllocation {
  /** Facility (tank / meter / battery) record id. */
  facilityId: string;
  wellId: string;
  /** Fixed share 0-100; used to scale the edge's flow label. */
  straightPct: number;
}

export interface GraphInput {
  wells: GraphWell[];
  tanks: GraphTank[];
  meters: GraphMeter[];
  batteries: GraphBattery[];
  leases: GraphLease[];
  /** Haul-off destinations (nodes for `tank -> gatherer` split flows). */
  gatherers?: GraphGatherer[];
  /** well -> tank splits (`tank_well_allocations`). */
  tankAllocations: GraphAllocation[];
  /** well -> meter splits (`meter_well_allocations`). */
  meterAllocations: GraphAllocation[];
  /** well -> battery splits (`battery_well_allocations`). */
  batteryAllocations: GraphAllocation[];
}

// --- Node id helpers --------------------------------------------------------

/** Kind-prefixed node id, unique across facility kinds (well slugs ≠ tank uuids). */
export function nodeId(kind: FacilityKind, refId: string): string {
  return `${kind}:${refId}`;
}

const UNASSIGNED = "Unassigned";

// --- Build ------------------------------------------------------------------

/**
 * Assemble the facility graph from the org's facilities + allocation wiring.
 * Pure: no DB, no ordering assumptions (inputs may arrive in any order). Edges
 * to/from a facility that isn't in the node set are dropped (a dangling
 * allocation never fabricates a phantom node).
 */
export function buildFacilityGraph(input: GraphInput): FacilityGraph {
  const nodes: FacilityNode[] = [];
  const byId = new Map<string, FacilityNode>();
  const add = (n: FacilityNode) => {
    nodes.push(n);
    byId.set(n.id, n);
  };

  // Per-well, per-substance rates so an edge's flow uses the RIGHT stream (a gas
  // edge scales by the well's gas rate, not its oil headline).
  const rateByWell = new Map<string, Record<Substance, number>>();
  for (const w of input.wells) {
    rateByWell.set(w.id, {
      oil: w.oilProduction,
      gas: w.gasProduction,
      water: w.saltWater,
    });
  }

  // A well with no lease of its own inherits the lease of a battery it feeds:
  // being on a battery on a lease means the well is on that lease.
  const leaseByBattery = new Map(input.batteries.map((b) => [b.id, b.leaseId]));
  const leaseFromBattery = new Map<string, string>();
  for (const a of input.batteryAllocations) {
    if (leaseFromBattery.has(a.wellId)) continue;
    const l = leaseByBattery.get(a.facilityId);
    if (l) leaseFromBattery.set(a.wellId, l);
  }
  const effectiveLease = (w: GraphWell): string | null =>
    w.leaseId ?? leaseFromBattery.get(w.id) ?? null;

  /*
   * A tank or meter with no lease of its own takes the lease of the wells
   * feeding it — but only when they all agree.
   *
   * This is the same rule already applied one line up (a well on a battery is on
   * that battery's lease), read the other way down the chain: a tank fed only by
   * Roach wells is a Roach tank, whatever `tanks.lease_id` was left at. It
   * decides two things together — which lease lane the card sits in, and its
   * NAME, since a tank's name IS its lease plus its number (`tankDisplayName`).
   * Deriving one without the other is what puts "T488568" in a lane labelled
   * Roach.
   *
   * Feeders on two different leases resolve to nothing: a shared facility has no
   * single lease, and guessing one would name it after half its inputs.
   */
  const leaseByWell = new Map(input.wells.map((w) => [w.id, effectiveLease(w)]));
  const leaseFromFeeders = (allocations: GraphAllocation[]) => {
    const byFacility = new Map<string, Set<string | null>>();
    for (const a of allocations) {
      const set = byFacility.get(a.facilityId) ?? new Set<string | null>();
      set.add(leaseByWell.get(a.wellId) ?? null);
      byFacility.set(a.facilityId, set);
    }
    const out = new Map<string, string>();
    for (const [facilityId, leases] of byFacility) {
      const named = [...leases].filter((l): l is string => l != null);
      if (named.length === 1 && leases.size === 1) out.set(facilityId, named[0]);
    }
    return out;
  };
  const tankLeaseFromWells = leaseFromFeeders(input.tankAllocations);
  const meterLeaseFromWells = leaseFromFeeders(input.meterAllocations);
  const leaseNameById = new Map(input.leases.map((l) => [l.id, l.label]));

  /*
   * Which commodities each well is ALLOCATED for. Oil is allocated at the
   * battery and nowhere else (`allocationForTank`), so a `tank_well_allocations`
   * row on an OIL tank does not count — it is the strapping link, and treating
   * it as a split is what made a connected well read as producing.
   */
  const allocatedByWell = new Map<string, Set<Substance>>();
  const markAllocated = (wellId: string, substance: Substance) => {
    const set = allocatedByWell.get(wellId);
    if (set) set.add(substance);
    else allocatedByWell.set(wellId, new Set([substance]));
  };
  for (const a of input.batteryAllocations) markAllocated(a.wellId, "oil");
  {
    const meterSubstance = new Map(
      input.meters.map((m) => [m.id, m.substance === "water" ? "water" : "gas"] as const)
    );
    for (const a of input.meterAllocations) {
      markAllocated(a.wellId, meterSubstance.get(a.facilityId) ?? "gas");
    }
    const waterTanks = new Set(
      input.tanks.filter((t) => t.product === "water").map((t) => t.id)
    );
    for (const a of input.tankAllocations) {
      if (waterTanks.has(a.facilityId)) markAllocated(a.wellId, "water");
    }
  }

  for (const w of input.wells) {
    const injection = w.type === "injection";
    const substances: Substance[] = injection ? ["water"] : substancesOf(w);
    add({
      id: nodeId(injection ? "injection" : "well", w.id),
      kind: injection ? "injection" : "well",
      refId: w.id,
      name: w.name,
      leaseId: effectiveLease(w),
      substances,
      // An SWD well produces nothing, so its headline is what it TOOK: the same
      // 30-day rate the Disposal page's Wells tab shows, passed in rather than
      // recomputed here so the map and that table cannot quote different
      // numbers for one well.
      flow: injection ? (w.disposalBblPerDay ?? null) : headlineFlow(w),
      capacity: injection ? (w.permittedBblPerDay ?? null) : null,
      hasEquipment: true,
      allocated: injection ? undefined : [...(allocatedByWell.get(w.id) ?? [])],
      metrics: injection
        ? undefined
        : {
            oil: w.oilProduction,
            gas: w.gasProduction,
            water: w.saltWater,
            revenue: w.revenue ?? 0,
            pl: w.pl ?? 0,
          },
    });
  }

  /*
   * NO BATTERY NODES, and no water-meter nodes. `docs/swd-batteries-plan.md`
   * §Surfaces had a battery holding water tanks stand in for them as one
   * station card, with the SWD meters beside it; both were taken off this map
   * (2026-09-13). A battery is a grouping of tanks on every other surface and
   * is one here too, for water as for oil: each water tank is its own card,
   * and a station-level disposal link is drawn from every member tank. A
   * water meter is wiring, not a facility on the picture: what it measures is
   * the SWD well's card, and a connection drawn through one is spliced across
   * it (`flow-edges.ts`).
   */
  const waterTanksByBattery = new Map<string, string[]>();
  for (const t of input.tanks) {
    if (t.product === "water" && t.batteryId) {
      const list = waterTanksByBattery.get(t.batteryId) ?? [];
      list.push(t.id);
      waterTanksByBattery.set(t.batteryId, list);
    }
  }

  for (const t of input.tanks) {
    const inferredLease = t.leaseId ?? tankLeaseFromWells.get(t.id) ?? null;
    add({
      id: nodeId("tank", t.id),
      kind: "tank",
      refId: t.id,
      // Re-derived only when the map resolved a lease the row did not carry —
      // a tank named on its own lease already reads "Roach T123".
      name:
        t.leaseId == null && inferredLease != null
          ? tankDisplayName(leaseNameById.get(inferredLease), t.tankNo, t.product)
          : t.name,
      leaseId: inferredLease,
      substances: [t.product === "water" ? "water" : "oil"],
      flow: null,
      hasEquipment: false,
    });
  }

  for (const m of input.meters) {
    if (m.substance === "water") continue; // wiring, not a card (see above)
    const inferredLease = m.leaseId ?? meterLeaseFromWells.get(m.id) ?? null;
    add({
      id: nodeId("meter", m.id),
      kind: "meter",
      refId: m.id,
      name:
        m.leaseId == null && inferredLease != null
          ? meterDisplayName(leaseNameById.get(inferredLease), m.meterNo)
          : m.name,
      leaseId: inferredLease,
      substances: [m.substance ?? "gas"],
      flow: null,
      hasEquipment: false,
    });
  }

  // Haul-off / off-site destinations, so a tank's water can split between an SWD
  // well and a hauler (`tank -> gatherer` edges are drawn via flow_connections).
  for (const g of input.gatherers ?? []) {
    add({
      id: nodeId("gatherer", g.id),
      kind: "gatherer",
      refId: g.id,
      name: g.name,
      leaseId: null,
      substances: [],
      flow: null,
      hasEquipment: false,
    });
  }

  // --- Edges ---------------------------------------------------------------
  const edges: FacilityEdge[] = [];
  const seen = new Set<string>();
  const pushEdge = (
    from: string,
    to: string,
    substance: Substance,
    flow: number | null
  ) => {
    if (!byId.has(from) || !byId.has(to)) return; // drop dangling
    const id = `${from}->${to}:${substance}`;
    if (seen.has(id)) return; // a well fed via both a battery and a direct alloc
    seen.add(id);
    edges.push({ id, from, to, substance, flow });
  };

  // well -> tank (substance = tank product), scaled by the well's matching rate.
  const tankById = new Map(input.tanks.map((t) => [t.id, t]));
  for (const a of input.tankAllocations) {
    const tank = tankById.get(a.facilityId);
    if (!tank) continue;
    const substance: Substance = tank.product === "water" ? "water" : "oil";
    pushEdge(
      nodeId("well", a.wellId),
      nodeId("tank", a.facilityId),
      substance,
      wellFlowShare(rateByWell, a.wellId, substance, a.straightPct)
    );
  }

  // well -> meter (substance follows the meter: gas meters carry gas, SWD/water
  // meters carry water).
  const meterSubstanceById = new Map(
    input.meters.map((m) => [m.id, m.substance ?? "gas"] as const)
  );
  for (const a of input.meterAllocations) {
    const meterSub = meterSubstanceById.get(a.facilityId) ?? "gas";
    if (meterSub === "water") continue; // no node to point at
    pushEdge(
      nodeId("well", a.wellId),
      nodeId("meter", a.facilityId),
      meterSub,
      wellFlowShare(rateByWell, a.wellId, meterSub, a.straightPct)
    );
  }

  // well -> battery: fan out to every tank in the battery (oil). The well's
  // battery contribution is spread across the battery's tanks so the per-tank
  // edges sum back to it.
  const tanksByBattery = new Map<string, string[]>();
  for (const t of input.tanks) {
    if (t.batteryId) {
      (tanksByBattery.get(t.batteryId) ?? tanksByBattery.set(t.batteryId, []).get(t.batteryId)!).push(t.id);
    }
  }
  for (const a of input.batteryAllocations) {
    const tankIds = tanksByBattery.get(a.facilityId) ?? [];
    if (tankIds.length === 0) continue;
    const whole = wellFlowShare(rateByWell, a.wellId, "oil", a.straightPct);
    const each = whole != null ? whole / tankIds.length : null;
    for (const tankId of tankIds) {
      pushEdge(nodeId("well", a.wellId), nodeId("tank", tankId), "oil", each);
    }
  }

  // tank -> SWD well. A tank's own link first; a station-level link (the
  // battery's `injection_well_id`, plan §Mode B) is drawn from every member
  // water tank that has no link of its own, since the battery is not a card.
  const batteryInjection = new Map(
    input.batteries
      .filter((b) => b.injectionWellId)
      .map((b) => [b.id, b.injectionWellId as string])
  );
  for (const t of input.tanks) {
    const wellId =
      t.injectionWellId ??
      (t.product === "water" && t.batteryId ? batteryInjection.get(t.batteryId) : null);
    if (!wellId) continue;
    pushEdge(nodeId("tank", t.id), nodeId("injection", wellId), "water", null);
  }

  // --- Territories ---------------------------------------------------------
  const labelByLease = new Map(input.leases.map((l) => [l.id, l.label]));
  const territoryOrder: (string | null)[] = [];
  const nodesByLease = new Map<string | null, string[]>();
  for (const n of nodes) {
    const key = n.leaseId;
    if (!nodesByLease.has(key)) {
      nodesByLease.set(key, []);
      territoryOrder.push(key);
    }
    nodesByLease.get(key)!.push(n.id);
  }
  const territories: Territory[] = territoryOrder.map((leaseId) => ({
    leaseId,
    name:
      leaseId == null
        ? UNASSIGNED
        : labelByLease.get(leaseId) ?? UNASSIGNED,
    nodeIds: nodesByLease.get(leaseId)!,
  }));

  /*
   * A lease with NOTHING on it is still a territory.
   *
   * It has no nodes, so nothing above produced one, and a lease the operator
   * has just created would simply not exist on this map — which is what makes
   * creating one from here feel like it failed. It carries an empty `nodeIds`,
   * and the layout draws it as an empty lane: the place the first tank goes.
   */
  for (const lease of input.leases) {
    if (nodesByLease.has(lease.id)) continue;
    territories.push({ leaseId: lease.id, name: lease.label, nodeIds: [] });
  }

  return { nodes, edges, territories };
}

// --- Helpers ----------------------------------------------------------------

function substancesOf(w: GraphWell): Substance[] {
  const out: Substance[] = [];
  if (w.oilProduction > 0) out.push("oil");
  if (w.gasProduction > 0) out.push("gas");
  if (w.saltWater > 0) out.push("water");
  return out.length > 0 ? out : ["oil"];
}

/** A producing well's headline flow: oil rate, else gas, else water. */
function headlineFlow(w: GraphWell): number | null {
  if (w.oilProduction > 0) return w.oilProduction;
  if (w.gasProduction > 0) return w.gasProduction;
  if (w.saltWater > 0) return w.saltWater;
  return null;
}

/** The well's rate for a substance × the allocation share (0-100), or null. */
function wellFlowShare(
  rateByWell: Map<string, Record<Substance, number>>,
  wellId: string,
  substance: Substance,
  straightPct: number
): number | null {
  const rates = rateByWell.get(wellId);
  if (!rates) return null;
  const rate = rates[substance];
  if (!(rate > 0)) return null;
  const pct = Number.isFinite(straightPct) ? straightPct : 0;
  return (rate * pct) / 100;
}
