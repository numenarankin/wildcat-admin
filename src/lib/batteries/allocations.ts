import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AllocationMethod,
  AllocationRow,
  AllocationValidation,
} from "@/lib/tanks/allocation";
import {
  dayBefore,
  validateStraightAllocationSet,
} from "@/lib/tanks/allocation";
import {
  wellTestBatteryPeriods,
  type FracSample,
} from "@/lib/wells/well-test-derive";
import { listWellTestFracs } from "@/lib/wells/well-tests";

/**
 * Battery → well allocation config. A tank BATTERY is the allocation unit: its
 * total production (the sum of its member tanks' derived series) is split to
 * wells by a per-battery method (straight | weighted) and per-well straight
 * percentages. Mirrors the client-injected idiom of `@/lib/tanks/*` — every
 * helper takes the request-scoped RLS client; org ownership is enforced by the
 * `tank_batteries` / `battery_well_allocations` policies (never the admin
 * client). The pure derivation (`@/lib/tanks/allocation`, `engine`, `weighted`)
 * is identity-agnostic and consumes these rows unchanged.
 */

export type { AllocationMethod };

/** One battery→well split row (also defines which wells a battery feeds). */
export interface BatteryAllocation extends AllocationRow {
  id: string;
  batteryId: string;
}

/** A split row as the config UI supplies it (no id for new rows). */
export interface BatteryAllocationInput {
  wellId: string;
  straightPct: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

type Sb = SupabaseClient;

const ALLOC_COLS =
  "id, battery_id, well_id, straight_pct, effective_from, effective_to";

interface AllocationRowDb {
  id: string;
  battery_id: string;
  well_id: string;
  straight_pct: number | null;
  effective_from: string;
  effective_to: string | null;
}

// --- Validation (pure) -----------------------------------------------------

export type { AllocationValidation };

/**
 * Validate a battery's straight-split set. Delegates to the shared per-period
 * validator: every % in [0, 100], each effective date range sums to 100, and no
 * two ranges overlap (which would double-allocate the overlap days). An empty or
 * all-zero set is valid (the battery simply derives nothing).
 */
export function validateStraightAllocations(
  rows: BatteryAllocationInput[],
): AllocationValidation {
  return validateStraightAllocationSet(rows);
}

function mapAllocation(r: AllocationRowDb): BatteryAllocation {
  return {
    id: r.id,
    batteryId: r.battery_id,
    wellId: r.well_id,
    straightPct: r.straight_pct ?? 0,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

// --- Allocation rows -------------------------------------------------------

/** A battery's split rows, oldest effective-date first. */
/**
 * Every split row of MANY batteries in one read, grouped by battery. Batteries
 * with no rows are present with an empty list, so a caller can tell "loaded,
 * empty" from "not loaded". Same columns and mapper as the per-battery read.
 */
export async function listBatteryAllocationsForBatteries(
  sb: Sb,
  batteryIds: string[],
): Promise<Map<string, BatteryAllocation[]>> {
  const out = new Map<string, BatteryAllocation[]>();
  const ids = [...new Set(batteryIds.filter(Boolean))];
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  const { data, error } = await sb
    .from("battery_well_allocations")
    .select(ALLOC_COLS)
    .in("battery_id", ids)
    .order("effective_from", { ascending: true });
  if (error) throw new Error(`listBatteryAllocationsForBatteries: ${error.message}`);
  for (const r of (data ?? []) as AllocationRowDb[]) {
    const a = mapAllocation(r);
    out.get(a.batteryId)?.push(a);
  }
  return out;
}

export async function listBatteryAllocations(
  sb: Sb,
  batteryId: string,
): Promise<BatteryAllocation[]> {
  const { data, error } = await sb
    .from("battery_well_allocations")
    .select(ALLOC_COLS)
    .eq("battery_id", batteryId)
    .order("effective_from", { ascending: true });
  if (error) throw new Error(`listBatteryAllocations: ${error.message}`);
  return ((data ?? []) as AllocationRowDb[]).map(mapAllocation);
}

/** The battery ids feeding a well (the wells in each battery's split), for well
 * production. Method no longer lives at the battery — it is per allocation period,
 * resolved by {@link resolveBatteryTimeline}. */
export async function listWellBatteries(
  sb: Sb,
  wellId: string,
): Promise<string[]> {
  const { data, error } = await sb
    .from("battery_well_allocations")
    .select("battery_id")
    .eq("well_id", wellId);
  if (error) throw new Error(`listWellBatteries: ${error.message}`);
  return [
    ...new Set(
      ((data ?? []) as { battery_id: string }[]).map((r) => r.battery_id),
    ),
  ];
}

// --- Per-group timeline (manual + well-test periods, from-only & chained) -----

export type AllocationPeriodMethod = "manual" | "welltest";

/** One resolved allocation period on a battery's timeline. */
export interface AllocationPeriod {
  method: AllocationPeriodMethod;
  effectiveFrom: string;
  /** Chained: the day before the next period's start; null for the latest one. */
  effectiveTo: string | null;
  /** Well-test periods only: the date the period's newest test ended. */
  wellTestDate: string | null;
  /** Well-test periods only: the tests whose fracs produced these shares. */
  wellTestIds: string[];
  shares: { wellId: string; pct: number }[];
}

/** Open-period sentinel end date, for interval math. */
const MAX_DATE = "9999-12-31";

/** Open-period sentinel START date: the earliest resolved period extends back to
 *  this so production before the first test/manual split is still allocated. */
const MIN_DATE = "0001-01-01";

/** ISO `YYYY-MM-DD` one day after `iso`. */
function dayAfter(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Subtract each `[cut-from, cut-to]` interval from `[from, to]` (inclusive
 * bounds), returning the remaining sub-intervals. A cut in the middle splits the
 * range in two; a cut covering it entirely removes it.
 */
function subtractCuts(
  from: string,
  to: string,
  cuts: [string, string][],
): [string, string][] {
  let segments: [string, string][] = [[from, to]];
  for (const [cf, ct] of cuts) {
    const next: [string, string][] = [];
    for (const [sf, st] of segments) {
      if (ct < sf || cf > st) {
        next.push([sf, st]); // disjoint from this cut
        continue;
      }
      if (cf > sf) next.push([sf, dayBefore(cf)]); // the part before the cut
      if (ct < st) next.push([dayAfter(ct), st]); // the part after the cut
    }
    segments = next;
  }
  return segments.filter(([a, b]) => a <= b);
}

/**
 * PURE: build a battery's allocation timeline from its stored MANUAL rows and its
 * member wells' WELL TESTS. Manual periods are keyed by their stored start date
 * and then CHAINED — each runs until the day before the next begins, and the last
 * runs open-ended — so exactly one manual split governs any given day and none of
 * the battery's production falls between two of them.
 *
 * Well-test periods are POOLED, not one-per-test: at each distinct test end date,
 * every member well contributes its LATEST frac as of that date
 * ({@link wellTestBatteryPeriods}), so testing one well re-cuts the timeline from
 * its date while the others keep their earlier fracs — which is what makes
 * well-at-a-time entry work. A date whose split can't be derived (more than one
 * member well untested) is dropped so the manual split covers it.
 *
 * Manual and well-test periods are returned on one date-sorted list. Where two of
 * them cover the same day, the one entered for the LATER start date governs it:
 * a test supersedes the splits it was run against, and a manual split entered for
 * dates after a test supersedes that test from its own start date.
 */
export function buildBatteryTimeline(
  manualRows: {
    wellId: string;
    straightPct: number;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[],
  memberWellIds: string[],
  fracs: FracSample[],
): AllocationPeriod[] {
  // Manual periods: group by the explicit (from, to) range.
  const manualGroups = new Map<string, AllocationPeriod>();
  const manualPeriods: AllocationPeriod[] = [];
  for (const r of manualRows) {
    const to = r.effectiveTo ?? null;
    // Keyed by START alone: the end is chained below, so two rows that begin on
    // the same day are one split even if their stored ends differ.
    const key = r.effectiveFrom;
    let p = manualGroups.get(key);
    if (!p) {
      p = {
        method: "manual",
        effectiveFrom: r.effectiveFrom,
        effectiveTo: to,
        wellTestDate: null,
        wellTestIds: [],
        shares: [],
      };
      manualGroups.set(key, p);
      manualPeriods.push(p);
    }
    p.shares.push({ wellId: r.wellId, pct: r.straightPct });
  }

  // A battery with exactly ONE member well allocates 100% to it: with no other
  // well to split against, the sole well receives all the battery's oil (the
  // sum-to-100 invariant for a single-well period). Otherwise the 0% seed a freshly
  // added well carries would resolve to nothing. Mirrors the meter side.
  if (memberWellIds.length === 1) {
    for (const p of manualPeriods) {
      for (const s of p.shares) s.pct = 100;
    }
  }

  /*
   * Manual periods CHAIN: each runs until the day before the next one starts,
   * and the last one runs forward with no end.
   *
   * They used to keep their stored `[from, to]` verbatim, which let two of them
   * be active on the same day. `straightShares` then normalized across the union
   * and summed per well, so an old split did not get superseded by a newer one —
   * it diluted it, silently and in proportion to its percentages. It also left a
   * gap unallocated whenever a period carried an explicit end and the next began
   * later, and the barrels in that gap reached no well at all.
   *
   * Chaining makes the timeline total: every day from the first period onward
   * belongs to exactly one manual split, the newest one on or before it. Paired
   * with the earliest period's back-extension in `batteryAllocationForTank`,
   * every barrel the battery ever made lands on the split that was in force.
   */
  manualPeriods.sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom
      ? -1
      : a.effectiveFrom > b.effectiveFrom
        ? 1
        : 0,
  );
  for (let i = 0; i < manualPeriods.length; i++) {
    const next = manualPeriods[i + 1];
    manualPeriods[i].effectiveTo = next ? dayBefore(next.effectiveFrom) : null;
  }
  // Two groups keyed to the same start date collapse into one day-wide period
  // above; drop the empty ones so they cannot mask the split that follows.
  const chained = manualPeriods.filter(
    (p) => p.effectiveTo == null || p.effectiveFrom <= p.effectiveTo,
  );

  // Well-test periods: pooled latest-frac-per-well at each distinct test date.
  const wellTestPeriods: AllocationPeriod[] = wellTestBatteryPeriods(
    fracs,
    memberWellIds,
  ).map((p) => ({
    method: "welltest" as const,
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo,
    wellTestDate: p.effectiveFrom,
    wellTestIds: p.wellTestIds,
    shares: p.shares,
  }));

  /*
   * THE LATER START WINS. Manual and well-test periods clip each other, and on
   * the days two of them cover, the one entered for the later date governs: a
   * well test supersedes the splits already in force when it was run, and a
   * manual split entered for dates after a test supersedes the test from its own
   * start date until the next manual split or the next test.
   *
   * Well tests used to win outright. Since the newest well-test period is
   * open-ended, that deleted any manual split starting after the latest test: the
   * operator's entry was stored, governed no day, and disappeared from the config
   * panel, which seeds its editor from these periods -- so the next save dropped
   * the row from the database. A test measures the days it covers; it is not a
   * statement about every day that follows it, and the operator entering a split
   * for a later date is the newer statement about those days.
   *
   * Ties go to the WELL TEST: a manual split starting on a test's own date is cut
   * away (`>=` below). A split is usually typed from the start of the record, and
   * a test that opens on that same date has to win or it would never apply.
   *
   * Manual periods are already chained so no two of them overlap, and well-test
   * periods chain among themselves, so the only clipping here is across the two
   * kinds.
   */
  const manualCuts = chained.map(
    (p) => [p.effectiveFrom, p.effectiveTo ?? MAX_DATE] as [string, string],
  );
  const testCuts = wellTestPeriods.map(
    (p) => [p.effectiveFrom, p.effectiveTo ?? MAX_DATE] as [string, string],
  );
  const clip = (
    period: AllocationPeriod,
    cuts: [string, string][],
  ): AllocationPeriod[] =>
    subtractCuts(
      period.effectiveFrom,
      period.effectiveTo ?? MAX_DATE,
      cuts,
    ).map(([from, to]) => ({
      ...period,
      effectiveFrom: from,
      effectiveTo: to === MAX_DATE ? null : to,
    }));

  const clippedManual = chained.flatMap((m) =>
    clip(
      m,
      testCuts.filter(([from]) => from >= m.effectiveFrom),
    ),
  );
  const clippedTests = wellTestPeriods.flatMap((t) =>
    clip(
      t,
      manualCuts.filter(([from]) => from > t.effectiveFrom),
    ),
  );

  return [...clippedManual, ...clippedTests].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom
      ? -1
      : a.effectiveFrom > b.effectiveFrom
        ? 1
        : 0,
  );
}

/** Load + resolve a battery's full allocation timeline (manual ∪ well tests).
 *  Pass a preloaded `fracs` pool when resolving several batteries at once so the
 *  org's tests (and the tank series behind them) load once, not per battery.
 *
 *  The fallback reads the pool DIRECTLY rather than through
 *  `cache/loaders.ts`. This module is reachable from the browser — the comment
 *  toast derives a tank's name with the user's own RLS client
 *  (`notifications/facility-name.ts`), which imports `tanks/tanks.ts`, which
 *  imports this — and `cache/loaders.ts` is `server-only` over
 *  `node:async_hooks`. Importing it here is what broke the production build.
 *  The request-scoped read lives on the server side of that line, in
 *  `cachedBatteryAllocation`, which passes the pool in through `fracs`. */
export async function resolveBatteryTimeline(
  sb: Sb,
  batteryId: string,
  fracs?: FracSample[],
  /**
   * The battery's split rows, when the caller already has them. Injected the
   * same way `fracs` is, and for the same reason: a page resolving B batteries
   * read this table B times, once per battery, when one `IN (...)` read had
   * every row. `cache/loaders.ts` bulk-loads and hands them in.
   */
  rows?: BatteryAllocation[],
): Promise<AllocationPeriod[]> {
  const allocRows = rows ?? (await listBatteryAllocations(sb, batteryId));
  const memberWellIds = [...new Set(allocRows.map((r) => r.wellId))];
  // An OPEN test (close observation pending) resolves no frac, so it is absent
  // from this pool and moves nothing until it is closed.
  const pool = fracs ?? (await listWellTestFracs(sb));
  const manualRows = allocRows.map((r) => ({
    wellId: r.wellId,
    straightPct: r.straightPct,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));
  return buildBatteryTimeline(manualRows, memberWellIds, pool);
}

/**
 * The allocation an OIL tank's production/revenue is split by — its battery's
 * fully-RESOLVED timeline flattened to straight split rows. Well-test periods have
 * already been converted to computed percentages and every period has a chained
 * `effectiveTo`, so downstream consumers treat the whole thing as one effective-
 * dated STRAIGHT split (method is always `straight` after resolution). Since the
 * shares are linear in the total, splitting each member tank's total by the
 * battery's % and summing equals splitting the battery total by %. Empty when the
 * tank has no battery — an ungrouped oil tank allocates to nothing.
 */
export async function batteryAllocationForTank(
  sb: Sb,
  tank: { batteryId: string | null },
  fracs?: FracSample[],
  rows?: BatteryAllocation[],
): Promise<{ method: AllocationMethod; allocations: AllocationRow[] }> {
  if (!tank.batteryId) return { method: "straight", allocations: [] };
  const periods = await resolveBatteryTimeline(sb, tank.batteryId, fracs, rows);
  // periods are sorted ascending by `effectiveFrom`; the earliest one is
  // backward-looking (extends to MIN_DATE) so production before the first
  // test/manual split is still allocated. Mirrors the gas side.
  const allocations: AllocationRow[] = periods.flatMap((p, i) =>
    p.shares.map((s) => ({
      wellId: s.wellId,
      straightPct: s.pct,
      effectiveFrom: i === 0 ? MIN_DATE : p.effectiveFrom,
      effectiveTo: p.effectiveTo,
    })),
  );
  return { method: "straight", allocations };
}

/**
 * The date a battery's history begins — the earliest reading/run across its
 * member tanks, ISO `YYYY-MM-DD`, or null when it has no history yet. The default
 * `effective_from` when a well is linked, so the split covers the battery's whole
 * derived production rather than only from the day it was linked.
 */
export async function batteryHistoryStartDate(
  sb: Sb,
  batteryId: string,
): Promise<string | null> {
  const { data: tanks } = await sb
    .from("tanks")
    .select("id")
    .eq("battery_id", batteryId);
  const tankIds = ((tanks ?? []) as { id: string }[]).map((t) => t.id);
  if (tankIds.length === 0) return null;
  const [reading, ticket] = await Promise.all([
    sb
      .from("tank_readings")
      .select("reading_date")
      .in("tank_id", tankIds)
      .is("deleted_at", null)
      .order("reading_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    sb
      .from("run_tickets")
      .select("ticket_date")
      .in("tank_id", tankIds)
      .is("deleted_at", null)
      .order("ticket_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  const dates = [
    (reading.data as { reading_date?: string } | null)?.reading_date,
    (ticket.data as { ticket_date?: string } | null)?.ticket_date,
  ].filter((d): d is string => Boolean(d));
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (d < min ? d : min));
}

/**
 * Replace a battery's split rows with the supplied set (delete-then-insert). A
 * row without an explicit `effectiveFrom` — the panel's blank "Battery start" —
 * is resolved here to the battery's history start (so the split covers its whole
 * production), or to today when the battery has no readings or runs yet.
 */
export async function replaceBatteryAllocations(
  sb: Sb,
  batteryId: string,
  rows: BatteryAllocationInput[],
): Promise<void> {
  const check = validateStraightAllocations(rows);
  if (!check.ok) throw new Error(`replaceBatteryAllocations: ${check.error}`);

  const del = await sb
    .from("battery_well_allocations")
    .delete()
    .eq("battery_id", batteryId);
  if (del.error)
    throw new Error(`replaceBatteryAllocations (delete): ${del.error.message}`);

  const valid = rows.filter((r) => r.wellId);
  if (valid.length === 0) return;
  // "Battery start" (a blank From in the panel) resolves HERE, to a real date.
  // It cannot be left to the column's `default current_date`: supabase-js
  // normalizes an array insert so every object carries the same keys, filling
  // the gaps with an explicit NULL — and an explicit NULL does not trigger a
  // default, it violates the NOT NULL. So a blank From must become a date now.
  //
  // A battery with no readings or run tickets yet has no history to start from,
  // and today is the honest answer: nothing is produced before the split exists.
  // It costs nothing either way, because the EARLIEST period is extended back to
  // MIN_DATE when the timeline is read (see `batteryAllocationForTank`), so
  // production predating this date is still allocated by it.
  const historyStart = valid.some((r) => !r.effectiveFrom)
    ? ((await batteryHistoryStartDate(sb, batteryId)) ??
      new Date().toISOString().slice(0, 10))
    : null;
  const payload = valid.map((r) => ({
    battery_id: batteryId,
    well_id: r.wellId,
    straight_pct: Number.isFinite(r.straightPct) ? r.straightPct : 0,
    effective_from: r.effectiveFrom || historyStart,
    effective_to: r.effectiveTo ?? null,
  }));

  const { error } = await sb.from("battery_well_allocations").insert(payload);
  if (error)
    throw new Error(`replaceBatteryAllocations (insert): ${error.message}`);
}

/**
 * Add one or more wells to a battery as split rows. Each new well lands at
 * `straightPct` (default 0 — the operator sets the real split in the Allocation
 * panel); wells already on the battery are skipped. `effective_from` defaults to
 * the battery's history start so the split covers its whole production.
 */
export async function addBatteryAllocationsForWells(
  sb: Sb,
  batteryId: string,
  wellIds: string[],
  straightPct = 0,
): Promise<void> {
  const ids = [...new Set(wellIds.filter(Boolean))];
  if (ids.length === 0) return;

  const { data: existing, error: exErr } = await sb
    .from("battery_well_allocations")
    .select("well_id")
    .eq("battery_id", batteryId)
    .in("well_id", ids);
  if (exErr)
    throw new Error(`addBatteryAllocationsForWells (check): ${exErr.message}`);

  const have = new Set(
    ((existing ?? []) as { well_id: string }[]).map((r) => r.well_id),
  );
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length === 0) return;

  // Always a real date, never undefined — see `replaceBatteryAllocations`: an
  // array insert fills missing keys with an explicit NULL, which the column's
  // `default current_date` does not rescue.
  const historyStart =
    (await batteryHistoryStartDate(sb, batteryId)) ??
    new Date().toISOString().slice(0, 10);
  const payload = missing.map((wellId) => ({
    battery_id: batteryId,
    well_id: wellId,
    straight_pct: straightPct,
    effective_from: historyStart,
  }));

  const { error } = await sb.from("battery_well_allocations").insert(payload);
  if (error) throw new Error(`addBatteryAllocationsForWells: ${error.message}`);
}

/**
 * Make sure a well is a MEMBER of a battery's split, without disturbing the
 * shares already there.
 *
 * Oil is allocated at the battery and nowhere else (`allocationForTank` in
 * `@/lib/tanks/engine`), so a well that reaches a battery's tanks through any
 * other link — the well form's oil-tank picker, a connection drawn on the flow
 * map — produces exactly nothing until it has a row here. That gap reads as a
 * well making zero oil while the map draws it feeding a tank, which is why every
 * write path that wires a well to an oil tank calls this.
 *
 * The pct is deliberate: the FIRST well on a battery takes 100% (it is the only
 * thing feeding it, so the split is not in question), and any later one lands at
 * 0% so the shares that were already set still total 100. A 0% well is visible in
 * the Allocation panel with a share to give it — a decision for the operator,
 * not for this function.
 */
export async function ensureBatteryMembership(
  sb: Sb,
  batteryId: string,
  wellId: string,
): Promise<void> {
  if (!batteryId || !wellId) return;
  const existing = await listBatteryAllocations(sb, batteryId);
  if (existing.some((r) => r.wellId === wellId)) return;
  await addBatteryAllocationsForWells(
    sb,
    batteryId,
    [wellId],
    existing.length === 0 ? 100 : 0,
  );
}

/** Clamp a percentage to the DB's per-row [0, 100] bound. */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/** Set a single well's straight % on a battery — the Wells tab's inline edit. */
export async function setBatteryAllocationPct(
  sb: Sb,
  batteryId: string,
  wellId: string,
  straightPct: number,
): Promise<void> {
  const pct = clampPct(straightPct);
  const { data, error } = await sb
    .from("battery_well_allocations")
    .update({ straight_pct: pct })
    .eq("battery_id", batteryId)
    .eq("well_id", wellId)
    .select("id");
  if (error)
    throw new Error(`setBatteryAllocationPct (update): ${error.message}`);
  if (data && data.length > 0) return;

  const historyStart =
    (await batteryHistoryStartDate(sb, batteryId)) ??
    new Date().toISOString().slice(0, 10);
  const { error: insErr } = await sb.from("battery_well_allocations").insert({
    battery_id: batteryId,
    well_id: wellId,
    straight_pct: pct,
    effective_from: historyStart,
  });
  if (insErr)
    throw new Error(`setBatteryAllocationPct (insert): ${insErr.message}`);
}

/** Remove a single well's split row(s) from a battery. */
export async function deleteBatteryAllocationForWell(
  sb: Sb,
  batteryId: string,
  wellId: string,
): Promise<void> {
  const { error } = await sb
    .from("battery_well_allocations")
    .delete()
    .eq("battery_id", batteryId)
    .eq("well_id", wellId);
  if (error)
    throw new Error(`deleteBatteryAllocationForWell: ${error.message}`);
}
