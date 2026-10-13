import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listBatteries } from "@/lib/batteries/batteries";
import { getLeases } from "@/lib/leases/actions";
import { listMeters } from "@/lib/meters/meters";
import { listTanks } from "@/lib/tanks/tanks";
import { getWells, type Well, type WellType } from "@/lib/wells/wells";
import { cachedWellBatteries, cachedWellMeters } from "@/lib/cache/loaders";
import { formatHandle, type EntityType } from "./handles";

/**
 * `select`: build a set of handles.
 *
 * Every fleet-scale question starts here. Without it the model has to list every
 * well and filter in its own head, which works at twenty wells, silently drops
 * some at two hundred, and cannot be cited either way.
 *
 * The filters are the ones the schema actually supports. Anything needing a
 * derived quantity ("wells under 5 bbl/d") is a `rank` over a `measure`, not a
 * filter here, because the cut-off belongs with the number it cuts.
 */

type Sb = SupabaseClient;

export interface Selection {
  handles: string[];
  members: { handle: string; name: string }[];
  count: number;
  /** What was asked for, echoed so a surprising count can be diagnosed. */
  filter: Record<string, unknown>;
  note?: string;
}

export interface WellFilter {
  /**
   * Producing or injection. Omitted means both.
   *
   * Typed as `WellType` rather than spelled out, because the literal is
   * `producer` and not `production`. Writing it by hand once produced a filter
   * that matched every injection well and NO producers, and TypeScript allowed
   * the comparison because the two unions overlap on "injection".
   */
  wellType?: WellType;
  /** Default true: retired wells are kept for history and are rarely wanted. */
  activeOnly?: boolean;
  leaseId?: string;
  county?: string;
}

/**
 * The pure well filter.
 *
 * `activeOnly` defaults to TRUE. An inactive well is shut in, plugged or sold,
 * and including it silently is how a fleet average gets dragged down by wells
 * nobody operates. A caller that wants them has to say so.
 */
export function filterWells(wells: Well[], filter: WellFilter = {}): Well[] {
  const activeOnly = filter.activeOnly ?? true;
  const county = filter.county?.trim().toLowerCase();
  return wells.filter((w) => {
    if (activeOnly && !w.active) return false;
    if (filter.wellType && w.type !== filter.wellType) return false;
    if (filter.leaseId && w.leaseId !== filter.leaseId) return false;
    if (county && (w.county ?? "").trim().toLowerCase() !== county) return false;
    return true;
  });
}

const asMembers = (rows: { id: string; name: string }[], type: EntityType) =>
  rows.map((r) => ({ handle: formatHandle(type, r.id), name: r.name }));

function selection(
  members: { handle: string; name: string }[],
  filter: Record<string, unknown>,
  note?: string
): Selection {
  return {
    handles: members.map((m) => m.handle),
    members,
    count: members.length,
    filter,
    ...(note ? { note } : {}),
  };
}

/** Wells, filtered. */
export async function selectWells(filter: WellFilter = {}): Promise<Selection> {
  const wells = filterWells(await getWells(), filter);
  return selection(
    asMembers(wells, "well"),
    { ...filter, activeOnly: filter.activeOnly ?? true },
    wells.length === 0 ? "No well matches that filter." : undefined
  );
}

/** The wells on a battery, tank or meter, from its allocation membership. */
export async function selectWellsOn(
  sb: Sb,
  parent: { type: "battery" | "meter"; id: string }
): Promise<Selection> {
  const wells = await getWells();
  const nameById = new Map(wells.map((w) => [w.id, w.name]));

  // Membership is per well in the cached loaders, so this asks each well which
  // parents it is on rather than the reverse. The roster is small and both
  // loaders are memoized per request.
  const onIt: { id: string; name: string }[] = [];
  await Promise.all(
    wells.map(async (w) => {
      const ids =
        parent.type === "battery"
          ? await cachedWellBatteries(sb, w.id)
          : await cachedWellMeters(sb, w.id);
      if (ids.includes(parent.id)) {
        onIt.push({ id: w.id, name: nameById.get(w.id) ?? w.id });
      }
    })
  );
  onIt.sort((a, b) => a.name.localeCompare(b.name));
  return selection(asMembers(onIt, "well"), { on: `${parent.type}:${parent.id}` });
}

export async function selectLeases(activeOnly = true): Promise<Selection> {
  const leases = (await getLeases()).filter((l) => !activeOnly || l.active);
  return selection(
    asMembers(
      leases.map((l) => ({ id: l.id, name: l.name || l.leaseNo })),
      "lease"
    ),
    { activeOnly }
  );
}

export async function selectTanks(
  sb: Sb,
  opts: { product?: "oil" | "water"; leaseId?: string; activeOnly?: boolean } = {}
): Promise<Selection> {
  const activeOnly = opts.activeOnly ?? true;
  const tanks = (await listTanks(sb)).filter(
    (t) =>
      (!activeOnly || t.active) &&
      (!opts.product || t.product === opts.product) &&
      (!opts.leaseId || t.leaseId === opts.leaseId)
  );
  return selection(asMembers(tanks, "tank"), { ...opts, activeOnly });
}

export async function selectBatteries(
  sb: Sb,
  opts: { leaseId?: string; activeOnly?: boolean } = {}
): Promise<Selection> {
  const activeOnly = opts.activeOnly ?? true;
  const batteries = (await listBatteries(sb)).filter(
    (b) => (!activeOnly || b.active) && (!opts.leaseId || b.leaseId === opts.leaseId)
  );
  return selection(asMembers(batteries, "battery"), { ...opts, activeOnly });
}

export async function selectMeters(
  sb: Sb,
  opts: { substance?: "gas" | "water"; leaseId?: string; activeOnly?: boolean } = {}
): Promise<Selection> {
  const activeOnly = opts.activeOnly ?? true;
  const meters = (await listMeters(sb, opts.substance ?? "all")).filter(
    (m) => (!activeOnly || m.active) && (!opts.leaseId || m.leaseId === opts.leaseId)
  );
  return selection(
    asMembers(
      meters.map((m) => ({ id: m.id, name: m.name })),
      "meter"
    ),
    { ...opts, activeOnly }
  );
}
