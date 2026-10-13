import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { batched, memo, memoHas } from "@/lib/cache/request-cache";
import { listAllWellTests, listWellTestFracs } from "@/lib/wells/well-tests";
import { listReadingsByTank, listTanks, type TankReading } from "@/lib/tanks/tanks";
import { listTicketsByTank, type RunTicket } from "@/lib/tanks/run-tickets";
import { listBatteries } from "@/lib/batteries/batteries";
import { listLeases } from "@/lib/leases/leases";
import { listStatementRows, mapStatement, type Statement } from "@/lib/statements/statements";
import {
  listMeters,
  listReadingsByMeter,
  type Meter,
  type MeterReading,
} from "@/lib/meters/meters";
import {
  batteryAllocationForTank,
  listBatteryAllocationsForBatteries,
  } from "@/lib/batteries/allocations";
import { listMeterCampaignsForMeters } from "@/lib/meters/gas-campaigns";
import type { GasTestCampaign } from "@/lib/meters/gas-campaigns";
import { listWellEventsForWells, type WellEvent } from "@/lib/wells/well-events";
import {
  meterAllocationForWellSplit,
  listMeterAllocationsForMeters,
  type MeterAllocation,
} from "@/lib/meters/allocations";
import { loadEffectiveFlowConnections } from "@/lib/flow/effective-water";
import type { MeterSubstance } from "@/lib/meters/meters";

/**
 * Request-scoped wrappers over the reads the company-wide aggregations repeat
 * per well. Building every well's oil / gas / water series re-issues the SAME
 * org-wide queries (all tanks, all water meters, the flow graph) and the SAME
 * per-entity queries (a tank's readings + tickets, a meter's readings) once per
 * well — so a company with W wells pays W times for each. These make the request
 * pay once. See `./request-cache` for the scoping guarantees.
 *
 * READ PATHS ONLY. Never call these from a server action that writes and then
 * re-reads in the same request; it would see the pre-write value.
 */

type Sb = SupabaseClient;

/** Every tank in the org. */
export const cachedTanks = (sb: Sb) => memo(sb, "tanks", () => listTanks(sb));

/**
 * The lease roster with its roll-up counts: four reads, so worth sharing.
 * `/leases` issued them twice in one render (the page, then the pricing
 * model's revenue weighting) through two clients that could not see each
 * other's store.
 */
export const cachedLeases = (sb: Sb) => memo(sb, "leases", () => listLeases(sb));

/** The org's statement rows, once per request; the Statements tab and the
 *  payments projection each read the table on /revenue. */
export const cachedStatementRows = (sb: Sb) =>
  memo(sb, "statement-rows", () => listStatementRows(sb));
export const cachedStatements = (sb: Sb): Promise<Statement[]> =>
  cachedStatementRows(sb).then((rows) => rows.map(mapStatement));

/**
 * A lease's meters, cut from the org roster rather than read per lease.
 * `listLeaseMeters` is one query per (lease, substance): the estimate loop on
 * `/leases` ran it eight times against a roster the page already held.
 */
export const cachedLeaseMeters = async (
  sb: Sb,
  leaseId: string,
  substance: MeterSubstance | "all" = "gas"
): Promise<Meter[]> =>
  (await cachedMeters(sb, substance)).filter((m) => m.leaseId === leaseId);

/*
 * Every per-entity accessor below is BATCHED (see `batched` in request-cache):
 * all the ids asked for in one tick go out as one `IN (...)` / RPC call, no
 * matter which caller asked first. The prime functions further down are then
 * just "ask for the whole fleet now", so the batch is as wide as possible.
 */

/**
 * One tank's gauge readings, oldest first.
 *
 * `from` selects a WINDOWED family: readings on or after that day plus the
 * last one before it (see migration 2026090900200), keyed separately from the
 * full history so a chart asking for everything can never be handed a slice.
 * The rate derivations pass their window; everything else reads the whole
 * thing exactly as before.
 */
export const cachedTankReadings = (sb: Sb, tankId: string, from?: string): Promise<TankReading[]> => {
  const wider = from ? widerWindow(sb, "tank-readings", tankId, from) : undefined;
  if (wider !== undefined) {
    return cachedTankReadings(sb, tankId, wider || undefined).then((rows) => windowReadings(rows, from!));
  }
  noteWindow(sb, "tank-readings", from);
  return batched(sb, family("tank-readings", from), tankId, (ids) => listReadingsByTank(sb, ids, from), () => []);
};

/** One tank's run tickets; `from` as for `cachedTankReadings`. */
export const cachedTankTickets = (sb: Sb, tankId: string, from?: string): Promise<RunTicket[]> => {
  // The ticket cut needs the readings' anchor, so both must be in hand at a
  // window at least as wide.
  const wider = from ? widerWindow(sb, "tank-tickets", tankId, from) : undefined;
  const readingsAt = from ? widerWindow(sb, "tank-readings", tankId, from) : undefined;
  if (wider !== undefined && readingsAt !== undefined) {
    return Promise.all([
      cachedTankTickets(sb, tankId, wider || undefined),
      cachedTankReadings(sb, tankId, readingsAt || undefined),
    ]).then(([tickets, readings]) => windowTickets(tickets, readings, from!));
  }
  noteWindow(sb, "tank-tickets", from);
  return batched(sb, family("tank-tickets", from), tankId, (ids) => listTicketsByTank(sb, ids, from), () => []);
};

/** A batch family name that keeps windowed and full reads apart. */
const family = (base: string, from?: string) => (from ? `${base}@${from}` : base);

/*
 * The windows each family has been asked at in this request, per client, so
 * a narrower request can find a wider one to cut from. `""` is the full
 * history. Only windows that went to the database are noted; a derived
 * window is not a source.
 */
const windowsAsked = new WeakMap<object, Map<string, Set<string>>>();

function noteWindow(sb: Sb, base: string, from: string | undefined): void {
  let perFamily = windowsAsked.get(sb);
  if (!perFamily) windowsAsked.set(sb, (perFamily = new Map()));
  let set = perFamily.get(base);
  if (!set) perFamily.set(base, (set = new Set()));
  set.add(from ?? "");
}

/**
 * A window already REQUESTED for this id that contains `from`: the full
 * history (`""`) or a window starting strictly before `from`. Undefined when
 * none is; the widest when several are, so the cut is made once from one
 * source.
 */
function widerWindow(sb: Sb, base: string, id: string, from: string): string | undefined {
  if (memoHas(sb, `${base}:${id}`)) return "";
  const asked = windowsAsked.get(sb)?.get(base);
  if (!asked) return undefined;
  let best: string | undefined;
  for (const at of asked) {
    // The same window is not a source: that request is the memo hit
    // `batched` returns, and cutting from it would recurse forever.
    if (at === "" || at >= from) continue;
    if (memoHas(sb, `${base}@${at}:${id}`) && (best === undefined || at < best)) best = at;
  }
  return best;
}

/*
 * A windowed read served from the FULL read when that one is already in this
 * request. A chart page reads a node's whole history; the rate derivations
 * then ask for the 90-day window of the same node, which was a second RPC a
 * wave later for rows the page already held. The cut below is the windowed
 * RPC's (2026090900200), row for row: readings on or after `from` plus the
 * node's latest one before it (the opening level / counter), tickets from that
 * anchor's day forward, or from `from` when there is no anchor. The full read
 * and the windowed RPC order rows the same way, so a subset keeps the order.
 * The source can also be a WIDER window (`widerWindow`): rows from an
 * earlier day plus its anchor contain everything a later window needs, and
 * the latest row before `from` in that set is the true anchor. Only an entry
 * already REQUESTED counts (`memoHas`); asked the other way round the read
 * goes to the database as before.
 */
function windowReadings<T extends { date: string; time: string }>(rows: T[], from: string): T[] {
  const anchor = latestBefore(rows, from);
  const inWindow = rows.filter((r) => r.date >= from);
  return anchor ? [anchor, ...inWindow] : inWindow;
}

function windowTickets<T extends { date: string }>(
  tickets: T[],
  readings: { date: string; time: string }[],
  from: string
): T[] {
  const start = latestBefore(readings, from)?.date ?? from;
  return tickets.filter((t) => t.date >= start);
}

function latestBefore<T extends { date: string; time: string }>(rows: T[], from: string): T | undefined {
  let best: T | undefined;
  for (const r of rows) {
    if (r.date >= from) continue;
    if (!best || r.date > best.date || (r.date === best.date && r.time >= best.time)) best = r;
  }
  return best;
}

/** Every battery in the org, with its tank count. Shared by the roster and the tab badge. */
export const cachedBatteries = (sb: Sb) => memo(sb, "batteries", () => listBatteries(sb));

/**
 * Every meter of a substance in the org. RLS scope only (no `orgId` override).
 *
 * Reads ALL meters once and filters in memory, rather than keying the memo on
 * the substance. Keying on it meant `cachedMeters(sb, "gas")`,
 * `cachedMeters(sb, "water")` and `cachedMeters(sb, "all")` were three distinct
 * entries and three round trips for one small org-scoped table, which is most of
 * the `meters 5x` a /production render showed. The rows are identical either
 * way; only the number of requests changes.
 */
export const cachedMeters = async (
  sb: Sb,
  substance: MeterSubstance | "all"
): Promise<Meter[]> => {
  const all = await memo(sb, "meters:all", () => listMeters(sb, "all"));
  return substance === "all" ? all : all.filter((m) => m.substance === substance);
};

/** One meter's readings; `from` as for `cachedTankReadings`. */
export const cachedMeterReadings = (sb: Sb, meterId: string, from?: string): Promise<MeterReading[]> => {
  const wider = from ? widerWindow(sb, "meter-readings", meterId, from) : undefined;
  if (wider !== undefined) {
    return cachedMeterReadings(sb, meterId, wider || undefined).then((rows) => windowReadings(rows, from!));
  }
  noteWindow(sb, "meter-readings", from);
  return batched(sb, family("meter-readings", from), meterId, (ids) => listReadingsByMeter(sb, ids, from), () => []);
};

/** The org's effective flow graph (explicit edges ∪ well-test-derived edges). */
export const cachedFlowConnections = (sb: Sb) =>
  memo(sb, "flow-connections", () =>
    // Inputs handed in as PROMISES so the graph's own edge read starts in the
    // same tick rather than after the tests resolve; it awaits them alongside.
    loadEffectiveFlowConnections(sb, {
      tests: cachedWellTests(sb),
      tanks: cachedTanks(sb),
      waterMeters: cachedMeters(sb, "water"),
    })
  );

/**
 * The org-wide well-test frac pool, read ONCE per request.
 *
 * `resolveBatteryTimeline` takes an optional `fracs` and falls back to reading
 * the pool itself, so a page that resolves B batteries read it B times. It is
 * not a per-battery read: it returns every operative test in the org, and each
 * call costs a `well_tests` select plus the bulk reading/ticket loads
 * `resolveWellTestVolumes` needs behind it.
 */
export const cachedWellTestFracs = (sb: Sb) =>
  memo(sb, "well-test-fracs", async () => listWellTestFracs(sb, await cachedWellTests(sb)));

/**
 * The org's well tests, resolved, ONCE per request. Both pools that derive from
 * them (the oil frac pool above, the water-rate pool inside the flow graph)
 * used to read and resolve the table independently, and resolving is three
 * bulk reading loads each time.
 */
export const cachedWellTests = (sb: Sb) =>
  memo(sb, "well-tests:all", () =>
    listAllWellTests(sb, {
      // Batched, so the tanks and meters the tests name ride the same round
      // trips as the fleet's own readings instead of three reads of their own.
      tankReadings: (id, from) => cachedTankReadings(sb, id, from),
      tankTickets: (id, from) => cachedTankTickets(sb, id, from),
      meterReadings: (id, from) => cachedMeterReadings(sb, id, from),
    })
  );

/**
 * Downtime / shut-in events for a set of wells. Keyed on the sorted unique id
 * set, so the same group hits regardless of the order the caller passes.
 */
export const cachedWellEvents = async (
  sb: Sb,
  wellIds: string[]
): Promise<Map<string, WellEvent[]>> => {
  const ids = [...new Set(wellIds)];
  const lists = await Promise.all(ids.map((id) => cachedWellEvent(sb, id)));
  const out = new Map<string, WellEvent[]>();
  ids.forEach((id, i) => {
    if (lists[i].length > 0) out.set(id, lists[i]);
  });
  return out;
};

/** One well's events, batched across wells. Every meter asks for ITS member
 * wells and no two sets match, so a set-keyed memo shared nothing:
 * `well_events` 16x on one render. */
const cachedWellEvent = (sb: Sb, wellId: string): Promise<WellEvent[]> =>
  batched(sb, "well-events", wellId, (ids) => listWellEventsForWells(sb, ids), () => []);

/** The batteries feeding a well. */
export const cachedWellBatteries = (sb: Sb, wellId: string) =>
  batched(sb, "well-batteries", wellId, (ids) => membershipByWell(sb, "battery_well_allocations", "battery_id", ids), () => []);

/** The meters feeding a well. */
export const cachedWellMeters = (sb: Sb, wellId: string) =>
  batched(sb, "well-meters", wellId, (ids) => membershipByWell(sb, "meter_well_allocations", "meter_id", ids), () => []);

/** `well_id -> distinct node ids` for many wells, one read. */
async function membershipByWell(
  sb: Sb,
  table: "battery_well_allocations" | "meter_well_allocations",
  col: "battery_id" | "meter_id",
  wellIds: string[]
): Promise<Map<string, string[]>> {
  const { data, error } = await sb.from(table).select(`well_id, ${col}`).in("well_id", wellIds);
  if (error) throw new Error(`membershipByWell (${table}): ${error.message}`);
  const out = new Map<string, string[]>();
  for (const r of (data ?? []) as Record<string, string>[]) {
    const list = out.get(r.well_id);
    const v = r[col];
    if (list) {
      if (!list.includes(v)) list.push(v);
    } else out.set(r.well_id, [v]);
  }
  return out;
}

/**
 * A battery's resolved allocation timeline.
 *
 * The frac pool is passed IN rather than left to the fallback inside
 * `resolveBatteryTimeline`: it is org-wide, so B batteries would otherwise read
 * it B times. Injecting it here is also what keeps `batteries/allocations.ts`
 * free of a `server-only` import — that module is reachable from the browser
 * (see the note on `resolveBatteryTimeline`), so the sharing has to be arranged
 * from this side.
 */
export const cachedBatteryAllocation = (sb: Sb, batteryId: string) =>
  memo(sb, `battery-allocation:${batteryId}`, async () => {
    const [rows, fracs] = await Promise.all([
      cachedBatteryAllocationRows(sb, batteryId),
      cachedWellTestFracs(sb),
    ]);
    return batteryAllocationForTank(sb, { batteryId }, fracs, rows);
  });

/** One battery's raw split rows, batched across batteries. */
export const cachedBatteryAllocationRows = (sb: Sb, batteryId: string) =>
  batched(sb, "battery-alloc-rows", batteryId, (ids) => listBatteryAllocationsForBatteries(sb, ids), () => []);

/** A meter's resolved straight split rows. */
export const cachedMeterAllocation = (sb: Sb, meterId: string) =>
  memo(sb, `meter-allocation:${meterId}`, async () => {
    const [rows, campaigns] = await Promise.all([
      cachedMeterAllocationRows(sb, meterId),
      cachedMeterCampaigns(sb, meterId),
    ]);
    return meterAllocationForWellSplit(sb, meterId, { rows, campaigns });
  });

/** One meter's raw split rows, batched across meters. */
export const cachedMeterAllocationRows = (sb: Sb, meterId: string): Promise<MeterAllocation[]> =>
  batched(sb, "meter-alloc-rows", meterId, (ids) => listMeterAllocationsForMeters(sb, ids), () => []);

/** One meter's campaigns, batched across meters; rates read off the batched readings. */
export const cachedMeterCampaigns = (sb: Sb, meterId: string): Promise<GasTestCampaign[]> =>
  batched(
    sb,
    "meter-campaigns",
    meterId,
    (ids) => listMeterCampaignsForMeters(sb, ids, (id) => cachedMeterReadings(sb, id)),
    () => []
  );

/**
 * Resolve the battery and meter membership of MANY wells in two queries instead
 * of two per well, seeding the per-well caches above. The company roll-up asks
 * every well for its batteries and its meters, which was ~80 round trips on a
 * 40-well org purely to read two join tables.
 *
 * Scoped by the explicit well id list (not a bare table scan), so this stays
 * correct on the service-role cron path where RLS is not doing the scoping.
 */
export async function primeWellMembership(sb: Sb, wellIds: string[]): Promise<void> {
  const ids = [...new Set(wellIds.filter(Boolean))];
  await Promise.all([
    ...ids.map((id) => cachedWellBatteries(sb, id)),
    ...ids.map((id) => cachedWellMeters(sb, id)),
  ]);
}

/**
 * Ask for MANY tanks' readings + tickets at once. The accessors are batched, so
 * this is two round trips for the whole set however it is later consumed.
 */
export async function primeTankInputs(sb: Sb, tankIds: string[], from?: string): Promise<void> {
  const ids = [...new Set(tankIds.filter(Boolean))];
  await Promise.all([
    ...ids.map((id) => cachedTankReadings(sb, id, from)),
    ...ids.map((id) => cachedTankTickets(sb, id, from)),
  ]);
}

/** One round trip for many meters' readings; see `primeTankInputs`. */
export async function primeMeterReadings(sb: Sb, meterIds: string[], from?: string): Promise<void> {
  const ids = [...new Set(meterIds.filter(Boolean))];
  await Promise.all(ids.map((id) => cachedMeterReadings(sb, id, from)));
}

/**
 * The full prelude for a company-wide roll-up: every well's membership, then the
 * readings of every tank and meter that membership reaches. Turns the per-entity
 * fan-out into a fixed handful of `IN (...)` queries.
 *
 * Call once, with every well the caller is about to derive.
 */
export async function primeSeriesInputs(
  sb: Sb,
  wellIds: string[],
  /** The rate window (ISO day). Primes the windowed reading families the
   *  derivations read; unset primes full history. */
  from?: string
): Promise<void> {
  if (wellIds.length === 0) return;
  /*
   * Everything at once, from the ROSTERS, not from membership.
   *
   * The first version primed membership, then derived which tanks and meters
   * those wells reach, then primed their readings: three waves where the
   * middle one existed only to narrow an org-scoped read by a few rows. The
   * rosters are already in the store (the tab badges loaded them), so every
   * tank, meter and battery in the org is known now, and asking for all of
   * their readings, split rows, campaigns and events in the SAME tick as the
   * membership read puts the whole prelude in one wave. The extra rows for
   * nodes no well reaches are a handful; the wave they used to cost was not.
   */
  const [tanks, meters, batteries] = await Promise.all([
    cachedTanks(sb),
    cachedMeters(sb, "all"),
    cachedBatteries(sb),
  ]);
  const tankIds = tanks.map((t) => t.id);
  const meterIds = meters.map((m) => m.id);
  const batteryIds = batteries.map((b) => b.id);
  await Promise.all([
    primeWellMembership(sb, wellIds),
    primeTankInputs(sb, tankIds, from),
    primeMeterReadings(sb, meterIds, from),
    primeAllocations(sb, batteryIds, meterIds),
    primeWellEvents(sb, wellIds),
    cachedWellTests(sb),
    // The water chain's edge read, so a lease's water series does not wait a
    // wave for it after the tests it is derived beside.
    cachedFlowConnections(sb),
  ]);
}

/**
 * Seed every battery's and meter's split rows, and every meter's campaigns, in
 * three reads. These are what `cachedBatteryAllocation` / `cachedMeterAllocation`
 * inject into the resolvers; without them the resolvers read per entity, which
 * was `battery_well_allocations` 8x, `meter_well_allocations` 16x and
 * `gas_test_campaigns` 14x on one render.
 *
 * Campaign rates are derived from the meter's readings, taken from the memo
 * (already primed above), so the campaign read adds no reading queries.
 */
export async function primeAllocations(
  sb: Sb,
  batteryIds: string[],
  meterIds: string[]
): Promise<void> {
  const bIds = [...new Set(batteryIds.filter(Boolean))];
  const mIds = [...new Set(meterIds.filter(Boolean))];
  await Promise.all([
    ...bIds.map((id) => cachedBatteryAllocationRows(sb, id)),
    ...mIds.map((id) => cachedMeterAllocationRows(sb, id)),
    ...mIds.map((id) => cachedMeterCampaigns(sb, id)),
  ]);
}

/** Every well's downtime events, one read (see `cachedWellEvents`). */
export async function primeWellEvents(sb: Sb, wellIds: string[]): Promise<void> {
  await cachedWellEvents(sb, wellIds);
}
