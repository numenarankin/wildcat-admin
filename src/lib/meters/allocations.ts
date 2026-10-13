import type { SupabaseClient } from "@supabase/supabase-js";
import { validateStraightAllocations } from "@/lib/tanks/allocations";
import type { AllocationRow } from "@/lib/tanks/allocation";
import { dayBefore } from "@/lib/tanks/allocation";
import {
  listMeterCampaigns,
  type GasTestCampaign,
} from "@/lib/meters/gas-campaigns";
import { shutInFrac } from "@/lib/meters/gas-campaign";
import {
  wellTestBatteryPeriods,
  type FracSample,
} from "@/lib/wells/well-test-derive";

/**
 * Meter → well allocation config data-access — the gas analogue of the battery's
 * allocation layer. A gas meter's MCF is split to its wells by a PER-PERIOD
 * timeline: MANUAL periods (explicit from/to, typed %) plus WELL-TEST periods
 * DERIVED from gas campaigns (subtractive shut-in, computed on read). The old
 * per-meter method toggle (straight | weighted) and the meter's use of the
 * weighted engine are retired: the timeline resolves to plain STRAIGHT rows,
 * mirroring `batteryAllocationForTank`. Same client-injected RLS idiom as the
 * rest; org ownership is enforced by the `meter_well_allocations` policies.
 *
 * The straight-set validation is shared with tanks (`validateStraightAllocations`)
 * so both enforce the same "[0,100] and sum to 100" rule.
 */

/** One meter→well split row (also defines commingled-meter membership). */
export interface MeterAllocation {
  id: string;
  meterId: string;
  wellId: string;
  /** Fixed % of the meter's gas going to this well (0–100). */
  straightPct: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** A split row as supplied by the config UI (no id for new rows). */
export interface MeterAllocationInput {
  wellId: string;
  straightPct: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

type Sb = SupabaseClient;

const ALLOC_COLS =
  "id, meter_id, well_id, straight_pct, effective_from, effective_to";

interface AllocationRowDb {
  id: string;
  meter_id: string;
  well_id: string;
  straight_pct: number | null;
  effective_from: string;
  effective_to: string | null;
}

function mapAllocation(r: AllocationRowDb): MeterAllocation {
  return {
    id: r.id,
    meterId: r.meter_id,
    wellId: r.well_id,
    straightPct: r.straight_pct ?? 0,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

// --- Allocation rows -------------------------------------------------------

/** A meter's split rows, oldest effective-date first. */
/**
 * Every split row of MANY meters in one read, grouped by meter. Meters with no
 * rows are present with an empty list. Same columns and mapper as the
 * per-meter read, so the two cannot disagree.
 */
export async function listMeterAllocationsForMeters(
  sb: Sb,
  meterIds: string[],
): Promise<Map<string, MeterAllocation[]>> {
  const out = new Map<string, MeterAllocation[]>();
  const ids = [...new Set(meterIds.filter(Boolean))];
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  const { data, error } = await sb
    .from("meter_well_allocations")
    .select(ALLOC_COLS)
    .in("meter_id", ids)
    .order("effective_from", { ascending: true });
  if (error) throw new Error(`listMeterAllocationsForMeters: ${error.message}`);
  for (const r of (data ?? []) as AllocationRowDb[]) {
    const a = mapAllocation(r);
    out.get(a.meterId)?.push(a);
  }
  return out;
}

export async function listMeterAllocations(
  sb: Sb,
  meterId: string,
): Promise<MeterAllocation[]> {
  const { data, error } = await sb
    .from("meter_well_allocations")
    .select(ALLOC_COLS)
    .eq("meter_id", meterId)
    .order("effective_from", { ascending: true });
  if (error) throw new Error(`listMeterAllocations: ${error.message}`);
  return ((data ?? []) as AllocationRowDb[]).map(mapAllocation);
}

/**
 * Replace a meter's split rows with the supplied set (delete-then-insert). The
 * config UI hands the full desired list; `org_id` comes from the RLS default.
 * A blank `wellId` row is skipped.
 */
export async function replaceMeterAllocations(
  sb: Sb,
  meterId: string,
  rows: MeterAllocationInput[],
): Promise<void> {
  const check = validateStraightAllocations(rows);
  if (!check.ok) throw new Error(`replaceMeterAllocations: ${check.error}`);

  const del = await sb
    .from("meter_well_allocations")
    .delete()
    .eq("meter_id", meterId);
  if (del.error)
    throw new Error(`replaceMeterAllocations (delete): ${del.error.message}`);

  // Never `undefined`: supabase-js gives every object in an array insert the same
  // keys, filling the gaps with an explicit NULL, and an explicit NULL does not
  // fall back to the column's `default current_date` — it violates NOT NULL. A
  // row with no start date begins today.
  const today = new Date().toISOString().slice(0, 10);
  const payload = rows
    .filter((r) => r.wellId)
    .map((r) => ({
      meter_id: meterId,
      well_id: r.wellId,
      straight_pct: Number.isFinite(r.straightPct) ? r.straightPct : 0,
      effective_from: r.effectiveFrom || today,
      effective_to: r.effectiveTo ?? null,
    }));
  if (payload.length === 0) return;

  const { error } = await sb.from("meter_well_allocations").insert(payload);
  if (error)
    throw new Error(`replaceMeterAllocations (insert): ${error.message}`);
}

/**
 * Add one or more wells to a meter as split rows — the targeted insert behind the
 * Wells tab's "Add Well" action. Each new well lands at 0% (the operator sets the
 * real split in the Allocation panel); wells already on the meter are skipped.
 */
export async function addMeterAllocationsForWells(
  sb: Sb,
  meterId: string,
  wellIds: string[],
  straightPct = 0,
): Promise<void> {
  const ids = [...new Set(wellIds.filter(Boolean))];
  if (ids.length === 0) return;

  const { data: existing, error: exErr } = await sb
    .from("meter_well_allocations")
    .select("well_id")
    .eq("meter_id", meterId)
    .in("well_id", ids);
  if (exErr)
    throw new Error(`addMeterAllocationsForWells (check): ${exErr.message}`);

  const have = new Set(
    ((existing ?? []) as { well_id: string }[]).map((r) => r.well_id),
  );
  const payload = ids
    .filter((id) => !have.has(id))
    .map((wellId) => ({
      meter_id: meterId,
      well_id: wellId,
      straight_pct: straightPct,
    }));
  if (payload.length === 0) return;

  const { error } = await sb.from("meter_well_allocations").insert(payload);
  if (error) throw new Error(`addMeterAllocationsForWells: ${error.message}`);
}

/**
 * Set a single well's straight % on a meter — the Wells tab's inline edit.
 * Upserts just that well's row: updates it if present, else inserts one (so the
 * primary well of a single-well meter can be edited before it has a split row).
 * No sum-to-100 enforcement here; the DB's per-row [0, 100] bound is respected.
 */
export async function setMeterAllocationPct(
  sb: Sb,
  meterId: string,
  wellId: string,
  straightPct: number,
): Promise<void> {
  const pct = Number.isFinite(straightPct)
    ? Math.min(100, Math.max(0, straightPct))
    : 0;
  const { data, error } = await sb
    .from("meter_well_allocations")
    .update({ straight_pct: pct })
    .eq("meter_id", meterId)
    .eq("well_id", wellId)
    .select("id");
  if (error)
    throw new Error(`setMeterAllocationPct (update): ${error.message}`);
  if (data && data.length > 0) return;

  const { error: insErr } = await sb
    .from("meter_well_allocations")
    .insert({ meter_id: meterId, well_id: wellId, straight_pct: pct });
  if (insErr)
    throw new Error(`setMeterAllocationPct (insert): ${insErr.message}`);
}

/**
 * Remove a single well's split row(s) from a meter — the targeted delete behind
 * the Wells tab's "remove well" action. Only the meter↔well allocation is
 * removed; the well itself is untouched.
 */
export async function deleteMeterAllocationForWell(
  sb: Sb,
  meterId: string,
  wellId: string,
): Promise<void> {
  const { error } = await sb
    .from("meter_well_allocations")
    .delete()
    .eq("meter_id", meterId)
    .eq("well_id", wellId);
  if (error) throw new Error(`deleteMeterAllocationForWell: ${error.message}`);
}

/** Distinct meters a well is a member of (its `meter_well_allocations` rows). The
 *  gas analogue of `listWellBatteries`. */
export async function listWellMeters(
  sb: Sb,
  wellId: string,
): Promise<string[]> {
  const { data, error } = await sb
    .from("meter_well_allocations")
    .select("meter_id")
    .eq("well_id", wellId);
  if (error) throw new Error(`listWellMeters: ${error.message}`);
  return [
    ...new Set(((data ?? []) as { meter_id: string }[]).map((r) => r.meter_id)),
  ];
}

// --- Per-period timeline (manual + gas-campaign periods) -------------------

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

export type AllocationPeriodMethod = "manual" | "welltest";

/** One resolved allocation period on a meter's timeline. */
export interface AllocationPeriod {
  method: AllocationPeriodMethod;
  effectiveFrom: string;
  /** Chained (among campaigns): the day before the next period's start; null for
   * the latest. Manual periods keep their explicit stored end. */
  effectiveTo: string | null;
  /** Well-test periods only: the source gas campaign's id. */
  campaignId: string | null;
  /** Well-test periods only: the campaign's start date (equals `effectiveFrom`). */
  wellTestDate: string | null;
  shares: { wellId: string; pct: number }[];
}

/**
 * PURE: build a meter's allocation timeline from its stored MANUAL rows and its
 * gas CAMPAIGNS. Manual periods keep their EXPLICIT stored `[from, to]`. Each
 * campaign becomes one well-test period whose `effectiveFrom` is the campaign's
 * first measurement date; campaign periods chain among THEMSELVES (a period runs
 * until the day before the next campaign's start, or is open when latest). The
 * campaign's % come from the subtractive shut-in math ({@link gasCampaignShares})
 * over the meter's member wells (the manual rows' wells). Manual and well-test
 * periods return on one date-sorted list, clipped against each other so that on
 * any day the one entered for the LATER start date governs. Mirrors the battery's
 * `buildBatteryTimeline`.
 */
export function buildMeterTimeline(
  manualRows: {
    wellId: string;
    straightPct: number;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[],
  memberWellIds: string[],
  campaigns: GasTestCampaign[],
): AllocationPeriod[] {
  // Manual periods: group by the explicit (from, to) range.
  const manualGroups = new Map<string, AllocationPeriod>();
  const manualPeriods: AllocationPeriod[] = [];
  for (const r of manualRows) {
    const to = r.effectiveTo ?? null;
    const key = `${r.effectiveFrom}|${to ?? ""}`;
    let p = manualGroups.get(key);
    if (!p) {
      p = {
        method: "manual",
        effectiveFrom: r.effectiveFrom,
        effectiveTo: to,
        campaignId: null,
        wellTestDate: null,
        shares: [],
      };
      manualGroups.set(key, p);
      manualPeriods.push(p);
    }
    p.shares.push({ wellId: r.wellId, pct: r.straightPct });
  }

  // A meter with exactly ONE member well allocates 100% to it: with no other well
  // to split against, the sole well receives all the meter's gas (the sum-to-100
  // invariant for a single-well period). Otherwise the 0% seed a freshly added
  // well carries would resolve to nothing.
  if (memberWellIds.length === 1) {
    for (const p of manualPeriods) {
      for (const s of p.shares) s.pct = 100;
    }
  }

  /*
   * Well-test periods, POOLED per well exactly as the battery pools its oil
   * tests (`wellTestBatteryPeriods`).
   *
   * A gas test is one well and one window: shut that well in, and the drop off
   * the baseline is its share. So one test derives one well's frac, never a
   * whole split, and the split for a date is every member well's LATEST frac as
   * of it. That is what lets a pumper test one well this week and another next
   * week, which is how the job is actually done, instead of having to shut in
   * the whole meter in one sitting before anything counts.
   *
   * An old campaign carrying several shut-ins reduces to the same thing: each of
   * its measurements is one well's sample.
   */
  const samples: FracSample[] = campaigns.flatMap((c) =>
    c.measurements
      .filter((m) => m.role === "shutin" && m.shutInWellId && m.endAt)
      .map((m) => ({
        wellId: m.shutInWellId as string,
        endDate: m.endAt.slice(0, 10),
        frac: shutInFrac(m.baselineMcfPerDay ?? null, m.mcfPerDay),
        testId: c.id,
      })),
  );
  const wellTestPeriods: AllocationPeriod[] = wellTestBatteryPeriods(
    samples,
    memberWellIds,
  ).map((p) => ({
    method: "welltest",
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo,
    // The test that OPENED the period, for drill-through. A period's start is a
    // test's end date, so that is the one to point at.
    campaignId:
      samples.find((x) => x.endDate === p.effectiveFrom)?.testId ?? null,
    wellTestDate: p.effectiveFrom,
    shares: p.shares,
  }));

  /*
   * THE LATER START WINS, exactly as on the battery
   * (`buildBatteryTimeline`): a campaign supersedes the splits that were in force
   * when it was run, and a manual split entered for dates after a campaign
   * supersedes that campaign from its own start date. Campaign periods are
   * open-ended until the next campaign, so clipping in one direction only used to
   * delete any manual split starting after the latest campaign outright.
   *
   * A manual period here keeps its typed end rather than chaining, so a campaign
   * clipped by one RESUMES after it: the days on either side of a manual window
   * still belong to the measurement.
   *
   * Ties go to the CAMPAIGN: a manual split starting on a campaign's own date is
   * cut away (`>=` below), which keeps the measurement in charge of the date it
   * began. A meter split is usually typed from the start of the record, so a
   * campaign that opens on that same date has to win or it would never apply.
   */
  const manualCuts = manualPeriods.map(
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

  const clippedManual = manualPeriods.flatMap((m) =>
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

/** Load + resolve a meter's full allocation timeline (manual ∪ campaigns). */
export async function resolveMeterTimeline(
  sb: Sb,
  meterId: string,
  /**
   * The meter's split rows and campaigns, when the caller already has them.
   * Injected so a fleet-wide derivation can bulk-load both tables once instead
   * of once per meter (`cache/loaders.ts`). Either half may be given alone.
   */
  have: { rows?: MeterAllocation[]; campaigns?: GasTestCampaign[] } = {},
): Promise<AllocationPeriod[]> {
  const [rows, allCampaigns] = await Promise.all([
    have.rows ?? listMeterAllocations(sb, meterId),
    have.campaigns ?? listMeterCampaigns(sb, meterId),
  ]);
  // Only PUBLISHED campaigns are operative; drafts are saved but excluded so a
  // half-recorded test never moves allocation until it is published.
  const campaigns = allCampaigns.filter((c) => c.publishedAt != null);
  const memberWellIds = [...new Set(rows.map((r) => r.wellId))];
  const manualRows = rows.map((r) => ({
    wellId: r.wellId,
    straightPct: r.straightPct,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));
  return buildMeterTimeline(manualRows, memberWellIds, campaigns);
}

/**
 * PURE: flatten a resolved timeline to straight split rows for the ENGINE. The
 * chronologically FIRST period is backward-looking — its `effectiveFrom` extends
 * to `MIN_DATE` so production before the first test/manual split is still
 * allocated (complete history, not just from the well-test date onward). The
 * displayed timeline keeps each period's real dates; only the engine flatten
 * backfills. Well-test periods are already computed %s with chained `effectiveTo`.
 */
export function flattenTimelineForEngine(
  periods: AllocationPeriod[],
): AllocationRow[] {
  const sorted = [...periods].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom
      ? -1
      : a.effectiveFrom > b.effectiveFrom
        ? 1
        : 0,
  );
  return sorted.flatMap((p, i) =>
    p.shares.map((s) => ({
      wellId: s.wellId,
      straightPct: s.pct,
      // Earliest period is backward-looking: cover all history before it.
      effectiveFrom: i === 0 ? MIN_DATE : p.effectiveFrom,
      effectiveTo: p.effectiveTo,
    })),
  );
}

/**
 * The allocation a meter's gas is split by — its fully-RESOLVED timeline flattened
 * to straight split rows (`flattenTimelineForEngine`, so the earliest period covers
 * all prior history). Mirrors `batteryAllocationForTank`.
 */
export async function meterAllocationForWellSplit(
  sb: Sb,
  meterId: string,
  have: { rows?: MeterAllocation[]; campaigns?: GasTestCampaign[] } = {},
): Promise<AllocationRow[]> {
  const periods = await resolveMeterTimeline(sb, meterId, have);
  return flattenTimelineForEngine(periods);
}
