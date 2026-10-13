import { cachedTanks } from "@/lib/cache/loaders";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listBatteryAllocations } from "@/lib/batteries/allocations";
import { listTankAllocations } from "@/lib/tanks/allocations";

/**
 * Test routing — the check that a well test's named tanks account for the WHOLE
 * battery over its window.
 *
 * A test no longer carries gauges. It declares a window and a routing: the
 * tested well went to the isolation tank, everyone else kept producing into the
 * control tanks. The split it derives is
 *
 *   frac = isolation ÷ (isolation + control)
 *
 * so the denominator is only the battery if every member well's oil landed in a
 * tank the test names. A member producing into an UNNAMED tank is barrels that
 * happened and were not counted, and the tested well's share comes out high by
 * exactly that much. Nothing downstream can detect it: the arithmetic is
 * internally consistent, the tanks it does name are all gauged, and the number
 * is simply wrong. So it is refused at the point of entry, which is the only
 * place the fact is still recoverable.
 *
 * "Which wells went to which tanks" is not stored on the test: the test names
 * tanks, and `tank_well_allocations` names the wells on each tank over a date
 * range. The tested well is on the isolation tank BY FIAT for this window, which
 * is what a test is, so its standing allocation is not consulted.
 */

type Sb = SupabaseClient;

/** One tank→well link, as much of it as the routing check needs. */
export interface TankAllocationRef {
  tankId: string;
  wellId: string;
  /** ISO `YYYY-MM-DD` the link takes effect. */
  effectiveFrom: string;
  /** ISO `YYYY-MM-DD` it ends, or null while it is still active. */
  effectiveTo: string | null;
}

/** A member well the test's tanks do not account for. */
export interface UnroutedWell {
  wellId: string;
  /**
   * The tanks it WAS on that day, which this test does not name. Empty when the
   * well has no tank at all on that date, which is the other way to fail: its
   * oil has nowhere to have been measured.
   */
  onTankIds: string[];
}

/** Whether an allocation row is live on a given day (`to` is inclusive). */
function activeOn(a: TankAllocationRef, onDate: string): boolean {
  if (a.effectiveFrom > onDate) return false;
  return a.effectiveTo == null || a.effectiveTo >= onDate;
}

/**
 * The battery members a test's tanks fail to account for, on `onDate`.
 *
 * The tested well is excluded: the isolation tank is where it went, whatever its
 * standing allocation says. Order-independent and dependency-free, so it unit
 * tests without a database and can preview live in the entry form.
 */
export function unroutedMembers(
  memberWellIds: string[],
  testedWellId: string,
  namedTankIds: string[],
  allocations: TankAllocationRef[],
  onDate: string
): UnroutedWell[] {
  const named = new Set(namedTankIds.filter(Boolean));
  const live = allocations.filter((a) => activeOn(a, onDate));
  const out: UnroutedWell[] = [];
  for (const wellId of [...new Set(memberWellIds)]) {
    if (wellId === testedWellId) continue;
    const on = live.filter((a) => a.wellId === wellId).map((a) => a.tankId);
    if (on.some((tankId) => named.has(tankId))) continue;
    out.push({ wellId, onTankIds: [...new Set(on)] });
  }
  return out;
}

/** What the routing check found. Clean when both lists are empty. */
export interface RoutingCheck {
  /** The battery the isolation tank belongs to, or null for a standalone tank. */
  batteryId: string | null;
  /** The day routing was judged on: the test's start date, ISO `YYYY-MM-DD`. */
  onDate: string;
  /** Member wells the named tanks do not account for. */
  unrouted: UnroutedWell[];
  /**
   * Named control tanks that are NOT on the isolation tank's battery.
   *
   * A foreign tank adds another battery's production to the denominator, which
   * understates the tested well by however much that tank made.
   */
  foreignTankIds: string[];
}

/**
 * Run the routing check for a test about to be saved.
 *
 * A test naming no isolation tank (document / AI-sourced, volumes stored rather
 * than derived) has no routing to check and passes. So does a standalone tank
 * with no battery: there are no other members to account for.
 */
export async function checkTestRouting(
  sb: Sb,
  params: {
    wellId: string;
    isolationTankId: string | null;
    controlTankIds: string[];
    /** The test's start, ISO timestamp; its date is when routing is judged. */
    startAt: string;
  }
): Promise<RoutingCheck> {
  const onDate = params.startAt.slice(0, 10);
  const clean: RoutingCheck = {
    batteryId: null,
    onDate,
    unrouted: [],
    foreignTankIds: [],
  };
  if (!params.isolationTankId) return clean;

  const tanks = await cachedTanks(sb);
  const isolation = tanks.find((t) => t.id === params.isolationTankId) ?? null;
  if (!isolation?.batteryId) return clean;
  const batteryId = isolation.batteryId;

  const foreignTankIds = params.controlTankIds.filter((id) => {
    const tank = tanks.find((t) => t.id === id);
    return !tank || tank.batteryId !== batteryId;
  });

  const rows = await listBatteryAllocations(sb, batteryId);
  const memberWellIds = [...new Set(rows.map((r) => r.wellId))];
  if (memberWellIds.length === 0) {
    return { batteryId, onDate, unrouted: [], foreignTankIds };
  }

  // Every tank on the battery, not only the named ones: an unrouted well is more
  // useful when it can say which tank its oil actually went to.
  const batteryTankIds = tanks
    .filter((t) => t.batteryId === batteryId)
    .map((t) => t.id);
  const allocations: TankAllocationRef[] = (
    await Promise.all(
      batteryTankIds.map(async (tankId) =>
        (await listTankAllocations(sb, tankId)).map((a) => ({
          tankId,
          wellId: a.wellId,
          effectiveFrom: a.effectiveFrom,
          effectiveTo: a.effectiveTo,
        }))
      )
    )
  ).flat();

  return {
    batteryId,
    onDate,
    unrouted: unroutedMembers(
      memberWellIds,
      params.wellId,
      [params.isolationTankId, ...params.controlTankIds],
      allocations,
      onDate
    ),
    foreignTankIds,
  };
}

/**
 * The refusal a failed check reads as, or null when it passed.
 *
 * Names, not ids: the pumper's fix is to name another tank or to link a well to
 * one, and neither is actionable from a uuid. Pure, so the entry form can render
 * the same sentence live from a preview check.
 */
export function routingRefusalMessage(
  check: RoutingCheck,
  wellName: (id: string) => string,
  tankName: (id: string) => string
): string | null {
  if (check.unrouted.length === 0 && check.foreignTankIds.length === 0) {
    return null;
  }
  const lines = [
    ...check.unrouted.map((u) =>
      u.onTankIds.length > 0
        ? `${wellName(u.wellId)} fed ${u.onTankIds
            .map(tankName)
            .join(", ")}, which this test does not name.`
        : `${wellName(u.wellId)} has no tank on ${check.onDate}.`
    ),
    ...check.foreignTankIds.map(
      (id) => `${tankName(id)} is not on this battery.`
    ),
  ];
  return [
    "The tanks named have to account for the whole battery, or the tested " +
      "well's share comes out high by whatever the missing tank made.",
    ...lines,
  ].join(" ");
}
