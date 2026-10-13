import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getBatteryAllocationConfig } from "@/lib/batteries/actions";
import { getMeterAllocationConfig } from "@/lib/meters/actions";
import { getTankAllocationConfig } from "@/lib/tanks/actions";
import { listBatteries } from "@/lib/batteries/batteries";
import { listMeters } from "@/lib/meters/meters";
import { listTanks } from "@/lib/tanks/tanks";
import { getWells } from "@/lib/wells/wells";
import { cachedWellBatteries, cachedWellMeters } from "@/lib/cache/loaders";
import { formatHandle, type Handle } from "./handles";

/**
 * `allocation_basis`: why a well's number is the size it is.
 *
 * ## The failure this exists for
 *
 * A well's allocated production is a facility measurement divided by a share, and
 * that share is a TIMELINE, not a number. `get_links` returned only the period in
 * effect today, so a battery that ran 90/10 for five years and was re-split to
 * 50/50 last month looked like it had always been 50/50 — and the five years of
 * history, correctly computed against the 90%, looked like it disagreed with the
 * configuration. It does not. There was nothing to reconcile.
 *
 * A single current share cannot explain a historical number, so this returns
 * every period, with its dates and its METHOD.
 *
 * ## Manual and well-test periods are not the same claim
 *
 * A `manual` period is a number somebody typed. A `well-test` period is derived
 * from filed test rates and carries the tests behind it. They sit in one timeline
 * and read identically once resolved, which is exactly why a 50/50 with no test
 * behind it can look as authoritative as a measured split. Every period says
 * which it is, and a manual period with no test anywhere near it is called out.
 *
 * ## Dead configuration
 *
 * Oil allocation lives at the BATTERY. A tank that carries its own allocation
 * rows while belonging to a battery is leftover config that governs nothing, and
 * it misleads whoever reads the tank page next. Reported, not silently ignored.
 */

type Sb = SupabaseClient;

export interface AllocationPeriodView {
  method: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** True while this period is the one in force. */
  current: boolean;
  /** Well-test periods only: when the governing test ended. */
  wellTestDate: string | null;
  shares: { handle: string; name: string; pct: number }[];
  note?: string;
}

export interface AllocationBasis {
  handle: string;
  name: string;
  substance: "oil" | "gas" | "water";
  periods: AllocationPeriodView[];
  /** Configuration that exists but governs nothing. */
  deadConfig: { handle: string; name: string; why: string }[];
  note?: string;
}

const MAX_DATE = "9999-12-31";

function isCurrent(from: string, to: string | null, today: string): boolean {
  return from <= today && (to ?? MAX_DATE) >= today;
}

/**
 * Turn a resolved timeline into periods a reader can defend.
 *
 * Periods come back oldest first, which is the order a history is read in, and
 * the one in force is marked rather than assumed to be the last.
 */
function viewPeriods(
  periods: {
    method: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    wellTestDate?: string | null;
    shares: { wellId: string; pct: number }[];
  }[],
  nameFor: (wellId: string) => string,
  today: string
): AllocationPeriodView[] {
  return [...periods]
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
    .map((p) => ({
      method: p.method,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
      current: isCurrent(p.effectiveFrom, p.effectiveTo, today),
      wellTestDate: p.wellTestDate ?? null,
      shares: p.shares.map((s) => ({
        handle: formatHandle("well", s.wellId),
        name: nameFor(s.wellId),
        pct: s.pct,
      })),
      ...(p.method === "manual"
        ? {
            note: "Hand-entered. No well test stands behind this split, so it is somebody's judgement about how the wells divide, not a measurement.",
          }
        : {}),
    }));
}

/**
 * The whole allocation story for a facility, or for the facility a well sits on.
 *
 * A well handle resolves to whichever facility governs the substance asked for:
 * oil at its battery, gas at its meter. That is the one the number actually comes
 * from, and pointing a reader at the well itself would explain nothing.
 */
export async function allocationBasis(
  sb: Sb,
  handle: Handle,
  substance: "oil" | "gas" | "water" = "oil",
  today = new Date().toISOString().slice(0, 10)
): Promise<AllocationBasis | { ok: false; error: string }> {
  const [wells, tanks, batteries, meters] = await Promise.all([
    getWells(),
    listTanks(sb),
    listBatteries(sb),
    listMeters(sb, "all"),
  ]);
  const nameFor = (id: string) => wells.find((w) => w.id === id)?.name ?? id;

  // A well points at whatever governs the substance asked about.
  let target = handle;
  if (handle.type === "well") {
    const ids =
      substance === "oil"
        ? await cachedWellBatteries(sb, handle.id)
        : await cachedWellMeters(sb, handle.id);
    if (ids.length === 0) {
      return {
        ok: false,
        error: `${nameFor(handle.id)} is on no ${substance === "oil" ? "battery" : "meter"}, so nothing allocates ${substance} to it. Its ${substance} figure is empty because nothing measures it, not because it produced none.`,
      };
    }
    if (ids.length > 1) {
      // Summing across facilities is a different question; say so rather than
      // picking one and presenting its timeline as the whole basis.
      return {
        ok: false,
        error: `${nameFor(handle.id)} takes ${substance} from ${ids.length} facilities, so there is no single allocation behind its number. Ask for each: ${ids.map((id) => formatHandle(substance === "oil" ? "battery" : "meter", id)).join(", ")}.`,
      };
    }
    target = { type: substance === "oil" ? "battery" : "meter", id: ids[0] };
  }

  const deadConfig: AllocationBasis["deadConfig"] = [];

  if (target.type === "battery") {
    const battery = batteries.find((b) => b.id === target.id);
    const config = await getBatteryAllocationConfig(target.id);

    // Oil allocation lives at the battery. A member tank carrying its own rows
    // is leftover configuration that governs nothing.
    const members = tanks.filter((t) => t.batteryId === target.id);
    const tankConfigs = await Promise.all(
      members.map(async (t) => ({ tank: t, config: await getTankAllocationConfig(t.id) }))
    );
    for (const { tank, config: tc } of tankConfigs) {
      if (tc.allocations.length > 0) {
        deadConfig.push({
          handle: formatHandle("tank", tank.id),
          name: tank.name,
          why: "This tank carries its own well split, but it belongs to a battery and oil allocation lives at the battery. These rows govern nothing and will mislead whoever reads the tank page.",
        });
      }
    }

    return {
      handle: formatHandle("battery", target.id),
      name: battery?.name ?? target.id,
      substance,
      periods: viewPeriods(config.periods, nameFor, today),
      deadConfig,
      ...(config.periods.length === 0
        ? { note: "No allocation is configured, so nothing here divides to a well." }
        : {}),
    };
  }

  if (target.type === "meter") {
    const meter = meters.find((m) => m.id === target.id);
    const config = await getMeterAllocationConfig(target.id);
    return {
      handle: formatHandle("meter", target.id),
      name: meter?.name || meter?.meterNo || target.id,
      substance: meter?.substance === "water" ? "water" : "gas",
      periods: viewPeriods(config.periods, nameFor, today),
      deadConfig,
    };
  }

  if (target.type === "tank") {
    const tank = tanks.find((t) => t.id === target.id);
    const config = await getTankAllocationConfig(target.id);
    return {
      handle: formatHandle("tank", target.id),
      name: tank?.name ?? target.id,
      substance,
      // A tank's rows are straight percentages with no timeline of their own.
      periods: config.allocations.length
        ? [
            {
              method: config.method,
              effectiveFrom: "",
              effectiveTo: null,
              current: !tank?.batteryId,
              wellTestDate: null,
              shares: config.allocations.map((a) => ({
                handle: formatHandle("well", a.wellId),
                name: nameFor(a.wellId),
                pct: a.straightPct,
              })),
            },
          ]
        : [],
      deadConfig,
      ...(tank?.batteryId
        ? {
            note: "This tank belongs to a battery, and oil allocation lives at the battery. Any split shown here governs nothing — read the battery's timeline instead.",
          }
        : {}),
    };
  }

  return { ok: false, error: `Nothing allocates through a ${handle.type}.` };
}
