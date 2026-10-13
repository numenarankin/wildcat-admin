import type { SupabaseClient } from "@supabase/supabase-js";
import type { TankProduct, TankReading } from "@/lib/tanks/tanks";
import type { AllocationMethod } from "@/lib/tanks/allocations";
import {
  activeAllocations,
  straightShares,
  type AllocationRow,
} from "@/lib/tanks/allocation";
import { latestReading } from "@/lib/tanks/capacity";
import { listTanks, listTankReadings } from "@/lib/tanks/tanks";
import { listTankAllocations } from "@/lib/tanks/allocations";
import { batteryAllocationForTank } from "@/lib/batteries/allocations";
import {
  listTankTickets,
  tankTicketTotals,
  ticketNetBbls,
} from "@/lib/tanks/run-tickets";
import {
  weightedAllocation,
  type WeightingContext,
} from "@/lib/tanks/weighted";
import { listAllWellTests, type WellTest } from "@/lib/wells/well-tests";
import {
  isOnlineOn,
  listAllWellEvents,
  type WellEvent,
} from "@/lib/wells/well-events";

/**
 * Allocation engine (GBC-2) — turns tank measurements into per-well production.
 *
 * For a period, a tank's production is `tank_total = Δ stock + dispositions`
 * (barrels the tank gained in inventory plus everything drawn off it via run
 * tickets). That total is split to the tank's wells by the tank's allocation
 * **method**, and direct-meter volumes (wells with no tank) are added on top:
 *
 *   well_production = Σ over its tanks (share × tank_total) + direct-meter
 *
 * The math is pure and dependency-free (types only) so it unit-tests without a
 * database; `deriveWellProductionForPeriod` is the thin DB wrapper that loads
 * readings / splits / ticket totals and hands them to the pure core.
 *
 * Method dispatch is a registry (`METHODS`): `straight` (fixed %, effective-
 * dated) ships now; `weighted` (GBC-11, well-test rates) registers its own
 * share function later and every derivation path picks it up. Until then a
 * weighted-flagged tank falls back to the straight split so it still allocates.
 *
 * Supersedes the GBC-4 minimal slice in `@/lib/tanks/allocation.ts` (that file's
 * pure helpers are reused here); the read-only well-tab snapshot in
 * `actions.ts` (`getWellTankProduction`) can be reconciled onto this next.
 */

/** Inclusive date window, ISO `YYYY-MM-DD` bounds. */
export interface Period {
  from: string;
  to: string;
}

/** One tank's inputs for a period's derivation. */
export interface TankPeriodInput {
  method: AllocationMethod;
  allocations: AllocationRow[];
  readings: TankReading[];
  /** Net barrels drawn off the tank in the period (runs + transfers + dispositions). */
  dispositionsBbls: number;
  /** Product stream (weighted allocation picks the matching test rate); default oil. */
  product?: TankProduct;
}

/**
 * Per-well tests + downtime that the `weighted` method needs, keyed by well id.
 * Threaded through the derivation so a weighted tank splits by `test_rate ×
 * online_days`; absent (or for straight tanks) the split stays straight.
 */
export interface EngineWeighting {
  testsByWell: Map<string, WellTest[]>;
  eventsByWell: Map<string, WellEvent[]>;
  /** Test freshness window in days (stale → straight fallback). */
  freshnessDays?: number;
}

/** Build a tank's weighting context for a period, or undefined if none supplied. */
function weightingCtx(
  weighting: EngineWeighting | undefined,
  period: Period,
  product: TankProduct
): WeightingContext | undefined {
  if (!weighting) return undefined;
  return {
    period,
    product,
    testsByWell: weighting.testsByWell,
    eventsByWell: weighting.eventsByWell,
    freshnessDays: weighting.freshnessDays,
  };
}

/** Derived production for one well over a period. */
export interface WellProduction {
  wellId: string;
  /** Barrels allocated to the well from its tanks. */
  tankBbls: number;
  /** Barrels reported by a direct meter (no tank), passed straight through. */
  directBbls: number;
  /** `tankBbls + directBbls`. */
  totalBbls: number;
}

// --- Tank total (Δ stock + dispositions) -----------------------------------

/** Barrels on hand at the close of `onDate` — latest reading dated ≤ onDate, or null. */
function stockAsOf(readings: TankReading[], onDate: string): number | null {
  const r = latestReading(readings.filter((x) => x.date <= onDate));
  return r ? r.bbls : null;
}

/** Barrels on hand entering `from` — latest reading dated strictly before it, or null. */
function stockBefore(readings: TankReading[], from: string): number | null {
  const r = latestReading(readings.filter((x) => x.date < from));
  return r ? r.bbls : null;
}

/**
 * A tank's period production: `(closing − opening) + dispositions`, where
 * opening is the last reading before the period (0 when the tank is brand new,
 * so a first-ever fill counts as production) and closing is the last reading on
 * or before `to` (a stale reading carries forward, giving Δ = 0). Negative
 * results are returned as-is — a real signal the exception report surfaces.
 */
export function tankPeriodTotal(
  readings: TankReading[],
  dispositionsBbls: number,
  period: Period
): number {
  const closing = stockAsOf(readings, period.to) ?? 0;
  const opening = stockBefore(readings, period.from) ?? 0;
  const disp = Number.isFinite(dispositionsBbls) ? dispositionsBbls : 0;
  return closing - opening + disp;
}

// --- Method dispatch -------------------------------------------------------

/**
 * A method's per-well shares (well id → fraction in [0,1]) as of a date. The
 * optional `weighting` context carries the tests + downtime the `weighted`
 * method needs; straight ignores it, and weighted falls back to straight when
 * it's absent (so the snapshot / no-test-data paths behave exactly as before).
 */
export type ShareFn = (
  allocations: AllocationRow[],
  onDate: string,
  weighting?: WeightingContext
) => Map<string, number>;

/**
 * Straight method — the fixed % split, DOWNTIME-ADJUSTED. When a weighting
 * context is supplied (it carries per-well downtime events), any well shut in on
 * `onDate` drops out and its fixed % flows to the wells still online, because
 * `straightShares` renormalizes among whoever's left. This is what makes a fixed
 * percentage "adjust for downtime" — the denominator is the online wells' %s.
 * Downtime is whole-day binary (`isOnlineOn`). All wells offline (or all-zero %)
 * → empty map: `0/0` allocates nothing rather than dividing by zero, and there's
 * no production to allocate on a day every well is down anyway.
 *
 * With no weighting context (unit tests, the getWellTankProduction snapshot) it
 * degrades to the plain fixed split.
 */
const straight: ShareFn = (allocations, onDate, weighting) => {
  const active = activeAllocations(allocations, onDate);
  const online = weighting
    ? active.filter((a) =>
        isOnlineOn(weighting.eventsByWell.get(a.wellId) ?? [], onDate)
      )
    : active;
  return straightShares(online);
};

/**
 * Allocation-method registry (GBC-2 seam). `weighted` (GBC-11) splits by
 * `test_rate × online_days` when a weighting context is supplied, with a
 * straight fallback for wells whose test is missing/stale — and degrades to the
 * (downtime-adjusted) straight split entirely when no weighting data is passed.
 */
const weighted: ShareFn = (allocations, onDate, weighting) =>
  weighting
    ? weightedAllocation(allocations, onDate, weighting).shares
    : straight(allocations, onDate, weighting);

const METHODS: Record<AllocationMethod, ShareFn> = {
  straight,
  weighted,
};

/** Per-well shares for a tank under its method, effective-dated to `onDate`. */
export function methodShares(
  method: AllocationMethod,
  allocations: AllocationRow[],
  onDate: string,
  weighting?: WeightingContext
): Map<string, number> {
  return (METHODS[method] ?? straight)(allocations, onDate, weighting);
}

// --- Derivation ------------------------------------------------------------

/**
 * Allocate every tank's period total to wells, then add direct-meter volumes.
 * The split active at the period's `to` date governs the period (the current
 * straight split rarely changes mid-period; GBC-11's weighted method refines
 * per-period selection). Result is sorted by well id for stable output.
 */
export function deriveWellProduction(
  tanks: TankPeriodInput[],
  period: Period,
  directBblsByWell: Map<string, number> = new Map(),
  weighting?: EngineWeighting
): WellProduction[] {
  const tankAgg = new Map<string, number>();
  for (const t of tanks) {
    const total = tankPeriodTotal(t.readings, t.dispositionsBbls, period);
    const ctx = weightingCtx(weighting, period, t.product ?? "oil");
    const shares = methodShares(t.method, t.allocations, period.to, ctx);
    for (const [wellId, share] of shares) {
      tankAgg.set(wellId, (tankAgg.get(wellId) ?? 0) + share * total);
    }
  }

  const wellIds = new Set<string>([
    ...tankAgg.keys(),
    ...directBblsByWell.keys(),
  ]);
  const out: WellProduction[] = [];
  for (const wellId of wellIds) {
    const tankBbls = tankAgg.get(wellId) ?? 0;
    const directBbls = directBblsByWell.get(wellId) ?? 0;
    out.push({ wellId, tankBbls, directBbls, totalBbls: tankBbls + directBbls });
  }
  return out.sort((a, b) => a.wellId.localeCompare(b.wellId));
}

// --- Daily derivation (for the production reports) --------------------------

/** Derived barrels per product for one well-day; null = not tank-derived. */
export interface DailyProduction {
  oil: number | null;
  water: number | null;
}

/** One tank's inputs for a multi-day derivation. */
export interface DailyTankInput {
  product: TankProduct;
  method: AllocationMethod;
  allocations: AllocationRow[];
  readings: TankReading[];
  /** date (`YYYY-MM-DD`) → net barrels drawn off the tank that day. */
  dispositionsByDate: Map<string, number>;
}

function addProduct(
  slot: DailyProduction,
  product: TankProduct,
  bbls: number
): void {
  if (product === "water") slot.water = (slot.water ?? 0) + bbls;
  else slot.oil = (slot.oil ?? 0) + bbls;
}

/**
 * Per-well, per-day derived production for the requested dates. Each tank's
 * daily total is `tankPeriodTotal` over that single day (Δ stock since the prior
 * reading + that day's dispositions), split to wells by the method active that
 * day and routed to oil or water by the tank's product. Daily deltas telescope,
 * so summing a well's days equals its period total. A day contributes only when
 * the tank has a reading on/before it or a disposition that day, so days before
 * a tank had any data don't fabricate a zero. Result is sparse: a (well, date)
 * key exists only where some tank derived a value.
 */
export function dailyWellProduction(
  tanks: DailyTankInput[],
  dates: string[],
  weighting?: EngineWeighting
): Map<string, Map<string, DailyProduction>> {
  const out = new Map<string, Map<string, DailyProduction>>();
  const slot = (wellId: string, date: string): DailyProduction => {
    let byDate = out.get(wellId);
    if (!byDate) out.set(wellId, (byDate = new Map()));
    let d = byDate.get(date);
    if (!d) byDate.set(date, (d = { oil: null, water: null }));
    return d;
  };

  for (const t of tanks) {
    for (const date of dates) {
      const disp = t.dispositionsByDate.get(date) ?? 0;
      const hasReading = t.readings.some((r) => r.date <= date);
      if (!hasReading && disp === 0) continue; // no basis to derive from
      const dayPeriod = { from: date, to: date };
      const total = tankPeriodTotal(t.readings, disp, dayPeriod);
      const ctx = weightingCtx(weighting, dayPeriod, t.product);
      const shares = methodShares(t.method, t.allocations, date, ctx);
      for (const [wellId, share] of shares) {
        addProduct(slot(wellId, date), t.product, share * total);
      }
    }
  }
  return out;
}

// --- DB service ------------------------------------------------------------

type Sb = SupabaseClient;

/**
 * Load org-wide well tests + downtime into an `EngineWeighting`, keyed by well
 * id. Downtime events are ALWAYS loaded — the straight method down-weights wells
 * offline on a day, so downtime must apply even to straight-only orgs. Tests are
 * loaded only when a tank actually uses the weighted method. Shared by the period
 * and daily derivations so both weight identically.
 */
async function loadWeighting(
  sb: Sb,
  tanksUseWeighted: boolean
): Promise<EngineWeighting> {
  const [tests, events] = await Promise.all([
    tanksUseWeighted
      ? listAllWellTests(sb)
      : Promise.resolve([] as WellTest[]),
    listAllWellEvents(sb),
  ]);
  const testsByWell = new Map<string, WellTest[]>();
  for (const t of tests) {
    (testsByWell.get(t.wellId) ?? testsByWell.set(t.wellId, []).get(t.wellId)!)
      .push(t);
  }
  const eventsByWell = new Map<string, WellEvent[]>();
  for (const e of events) {
    (eventsByWell.get(e.wellId) ??
      eventsByWell.set(e.wellId, []).get(e.wellId)!).push(e);
  }
  return { testsByWell, eventsByWell };
}

/**
 * Derive per-well production for a period from the tanks in the org. Same
 * client-injected idiom as the rest of `@/lib/tanks/*`: pass the request-scoped
 * RLS client so ownership is enforced by the `tanks` / `tank_readings` /
 * `run_tickets` policies. `product` restricts to oil or water tanks;
 * `directBblsByWell` supplies any non-tank (direct-meter) volumes to fold in.
 */
export async function deriveWellProductionForPeriod(
  sb: Sb,
  period: Period,
  opts: { product?: TankProduct; directBblsByWell?: Map<string, number> } = {}
): Promise<WellProduction[]> {
  const tanks = (await listTanks(sb)).filter(
    (t) => t.active && (!opts.product || t.product === opts.product)
  );

  const inputs: TankPeriodInput[] = await Promise.all(
    tanks.map(async (t) => {
      const [readings, config, totals] = await Promise.all([
        listTankReadings(sb, t.id),
        allocationForTank(sb, t),
        tankTicketTotals(sb, t.id, period.from, period.to),
      ]);
      return {
        method: config.method,
        allocations: config.allocations,
        readings,
        dispositionsBbls: totals.total,
        product: t.product,
      };
    })
  );

  const weighting = await loadWeighting(
    sb,
    inputs.some((i) => i.method === "weighted")
  );

  return deriveWellProduction(
    inputs,
    period,
    opts.directBblsByWell ?? new Map(),
    weighting
  );
}

/**
 * The allocation + method a tank's production is split by. OIL splits at the tank
 * BATTERY (oil allocation moved there); WATER still splits at the tank (disposal
 * source-attribution). An oil tank with no battery allocates to nothing.
 */
async function allocationForTank(
  sb: Sb,
  tank: { id: string; product: TankProduct; batteryId: string | null; allocationMethod: AllocationMethod }
): Promise<{ method: AllocationMethod; allocations: AllocationRow[] }> {
  if (tank.product === "oil") return batteryAllocationForTank(sb, tank);
  return { method: tank.allocationMethod, allocations: await listTankAllocations(sb, tank.id) };
}

/**
 * Per-well, per-day derived production across the org for a set of dates. Same
 * client-injected RLS idiom as above. Pairs with the reports' overlay
 * (`overlayDerivedProduction`) so the derivable production reports show gauge-
 * derived oil / water wherever a tank covers the well, falling back to the
 * hand-entered figure elsewhere.
 */
export async function deriveDailyWellProduction(
  sb: Sb,
  dates: string[],
  opts?: { orgId?: string }
): Promise<Map<string, Map<string, DailyProduction>>> {
  if (dates.length === 0) return new Map();
  // `orgId` scopes admin (service-role) reads that lack RLS org context (digest
  // cron); RLS callers omit it. Passed straight through to `listTanks`.
  const tanks = (await listTanks(sb, opts)).filter((t) => t.active);

  const inputs: DailyTankInput[] = await Promise.all(
    tanks.map(async (t) => {
      const [readings, config, tickets] = await Promise.all([
        listTankReadings(sb, t.id),
        allocationForTank(sb, t),
        listTankTickets(sb, t.id),
      ]);
      const dispositionsByDate = new Map<string, number>();
      for (const tk of tickets) {
        dispositionsByDate.set(
          tk.date,
          (dispositionsByDate.get(tk.date) ?? 0) + ticketNetBbls(tk)
        );
      }
      return {
        product: t.product,
        method: config.method,
        allocations: config.allocations,
        readings,
        dispositionsByDate,
      };
    })
  );

  const weighting = await loadWeighting(
    sb,
    inputs.some((i) => i.method === "weighted")
  );

  return dailyWellProduction(inputs, dates, weighting);
}
