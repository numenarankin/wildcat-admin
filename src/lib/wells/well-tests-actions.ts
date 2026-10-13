"use server";

/**
 * Server actions for well tests + downtime/shut-in (GBC-11) and the Well
 * Performance report loader.
 *
 * Thin wrappers over the `@/lib/wells/well-tests` and `@/lib/wells/well-events`
 * data-access layers: they run through the request-scoped RLS client (org
 * ownership enforced by the `well_tests` / `well_events` policies, writes gated
 * on `manage_well_production`) and revalidate the affected well page so the tab
 * and the weighted derivation both refresh.
 */

import { getRequestSupabase } from "@/lib/supabase/request-client";
import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import {
  addWellTest,
  deleteWellTest,
  listWellTests,
  listWellTestsByWell,
  updateWellTest,
  type WaterNodeRef,
  type WellTest,
  type WellTestInput,
} from "@/lib/wells/well-tests";
import { listReadingsByTank, listTanks } from "@/lib/tanks/tanks";
import { getWellNameMap } from "@/lib/wells/wells";
import {
  checkTestRouting,
  routingRefusalMessage,
} from "@/lib/wells/well-test-routing";
import {
  addWellEvent,
  deleteWellEvent,
  listWellEvents,
  updateWellEvent,
  type WellEvent,
  type WellEventInput,
} from "@/lib/wells/well-events";
import { loadWellPerformanceReport } from "@/lib/wells/well-performance-service";
import type { WellPerformanceReport } from "@/lib/wells/well-performance";

// --- Well tests ------------------------------------------------------------

/** A well's tests + downtime for the well-page Well Tests tab. */
export async function getWellTestsAndEvents(
  wellId: string
): Promise<{ tests: WellTest[]; events: WellEvent[] }> {
  const sb = await getRequestSupabase();
  const [tests, events] = await Promise.all([
    listWellTests(sb, wellId),
    listWellEvents(sb, wellId),
  ]);
  return { tests, events };
}

/**
 * The tests for a SET of wells, newest first — the read-only Well Tests tab on a
 * battery, a tank, or an SWD meter. Those surfaces don't record tests (that
 * happens on the well page); they show the records their split resolves from.
 */
export async function getWellTestsForWells(
  wellIds: string[]
): Promise<WellTest[]> {
  const sb = await getSupabaseServer();
  const byWell = await listWellTestsByWell(sb, wellIds);
  return [...byWell.values()]
    .flat()
    .sort((a, b) => (a.startAt < b.startAt ? 1 : a.startAt > b.startAt ? -1 : 0));
}

/**
 * The window and the routing a well test declares.
 *
 * A test collects no measurements. The pumper gauges the battery on the ordinary
 * round, so the readings are already on file: the test says WHEN it ran and
 * WHICH tanks carried whom, and `resolveWellTestVolumes` reads both sides out of
 * those tanks' standard series over the window, with hauls netted back in. That
 * leaves one source of truth for a gauge, and correcting a reading re-derives
 * every test spanning it without the test being touched.
 *
 * The tested well is on `isolationTankId` BY FIAT for this window, whatever its
 * standing tank allocation says. Every OTHER member of the battery has to be on
 * a tank in `controlTankIds`, which is what `checkTestRouting` enforces.
 */
export interface WellTestEntry {
  /** The tank the tested well was routed to for the window. */
  isolationTankId: string | null;
  /** The tank(s) carrying the rest of the battery over the window. */
  controlTankIds: string[];
  /** Where water was measured, or null when the operator typed the barrels. */
  waterNode: WaterNodeRef | null;
  /** ISO timestamp the test opened. */
  startAt: string;
  /** ISO timestamp it closed, or null to leave the test OPEN. */
  endAt: string | null;
  /** Water produced over the test, typed; used only when `waterNode` is null. */
  waterBbls?: number | null;
  gasMcf?: number | null;
  preTestShutInDays?: number | null;
  notes?: string;
}

/**
 * Why a save was refused: the named tanks do not account for the whole battery.
 *
 * A refusal rather than a warning. The split it would derive is arithmetically
 * fine and simply wrong, by exactly what the unnamed tank made, and nothing
 * downstream can tell afterwards.
 */
export interface RoutingRefusal {
  /** The sentence to show, wells and tanks named. */
  message: string;
  unroutedWellIds: string[];
  foreignTankIds: string[];
}

/** What a save returns: the new/updated id, or the refusal to show. */
export type WellTestSaveResult =
  | { ok: true; id: string }
  | { ok: false; refusal: RoutingRefusal };

/** Run the routing check for a test about to be written; null when it passes. */
async function routingRefusal(
  sb: ServerClient,
  params: {
    wellId: string;
    isolationTankId: string | null;
    controlTankIds: string[];
    startAt: string;
  }
): Promise<RoutingRefusal | null> {
  const check = await checkTestRouting(sb, params);
  if (check.unrouted.length === 0 && check.foreignTankIds.length === 0) {
    return null;
  }
  const [wellNames, tanks] = await Promise.all([
    getWellNameMap(),
    listTanks(sb),
  ]);
  const tankName = (id: string) =>
    tanks.find((t) => t.id === id)?.name ?? "an unknown tank";
  const message = routingRefusalMessage(
    check,
    (id) => wellNames[id] ?? id,
    tankName
  );
  return {
    message: message ?? "The tanks named do not cover the battery.",
    unroutedWellIds: check.unrouted.map((u) => u.wellId),
    foreignTankIds: check.foreignTankIds,
  };
}

type ServerClient = Awaited<ReturnType<typeof getSupabaseServer>>;

/**
 * The gauge stamps available on each tank, ISO and ascending.
 *
 * What the entry form offers as a test window. A test is bounded by the gauges
 * that exist: `seriesCoversWindow` refuses a window a named tank was not
 * observed either side of, so a window typed outside them would record a test
 * that silently derives nothing. Offering the stamps themselves also keeps the
 * test's barrels equal to a real gauge difference rather than a slope
 * interpolated between two readings.
 */
export async function getTankReadingTimes(
  tankIds: string[]
): Promise<Record<string, string[]>> {
  const ids = [...new Set(tankIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const sb = await getRequestSupabase();
  const byTank = await listReadingsByTank(sb, ids);
  const out: Record<string, string[]> = {};
  for (const id of ids) {
    out[id] = (byTank.get(id) ?? [])
      .map((r) => `${r.date}T${(r.time || "00:00").slice(0, 5)}:00Z`)
      .sort();
  }
  return out;
}

/**
 * Record an oil/water well test from the well page: one row naming the tanks and
 * the window. Nothing is written to any reading series, so the pumper's gauges
 * stay the only copy of a level and a test can never file a second one beside
 * them.
 */
export async function recordWellTest(
  wellId: string,
  entry: WellTestEntry
): Promise<WellTestSaveResult> {
  const sb = await getSupabaseServer();
  const refusal = await routingRefusal(sb, {
    wellId,
    isolationTankId: entry.isolationTankId,
    controlTankIds: entry.controlTankIds,
    startAt: entry.startAt,
  });
  if (refusal) return { ok: false, refusal };

  const result = await addWellTest(sb, wellId, {
    startAt: entry.startAt,
    endAt: entry.endAt,
    isolationTankId: entry.isolationTankId,
    controlTankIds: entry.controlTankIds,
    waterNode: entry.waterNode,
    // Typed water only counts when nothing measured it (a node always wins).
    waterBbls: entry.waterNode ? null : (entry.waterBbls ?? null),
    gasMcf: entry.gasMcf ?? null,
    preTestShutInDays: entry.preTestShutInDays ?? null,
    notes: entry.notes,
  });
  revalidateWellTest(wellId);
  return { ok: true, id: result.id };
}

/**
 * Close an OPEN test by setting its end. The window becomes derivable, so the
 * test starts weighting.
 *
 * No routing check: routing is judged on the start date, which closing does not
 * move, and the tanks are unchanged.
 */
export async function closeWellTest(
  wellId: string,
  testId: string,
  endAt: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const tests = await listWellTests(sb, wellId);
  const test = tests.find((t) => t.id === testId);
  if (!test) throw new Error("closeWellTest: test not found.");

  await updateWellTest(sb, wellId, testId, {
    startAt: test.startAt,
    endAt,
    isolationTankId: test.isolationTankId,
    controlTankIds: test.controlTankIds,
    waterNode: test.waterNode,
    waterBbls: test.waterNode ? null : test.waterBbls,
    gasMcf: test.gasMcf,
    preTestShutInDays: test.preTestShutInDays,
    notes: test.notes,
  });
  revalidateWellTest(wellId);
}

/**
 * Revalidate everything one well test can move: the well page, the batteries whose
 * oil split pools its frac, and every water surface (a test's water rate splits
 * water at any tank or meter its well feeds).
 */
function revalidateWellTest(wellId: string): void {
  revalidatePath(`/wells/${wellId}`);
  revalidatePath(`/production/wells/${wellId}`);
  revalidatePath("/batteries");
  revalidatePath("/disposal");
  revalidatePath("/facilities");
}

/** Record a well test from a volume-shaped source (AI / document ingest). */
export async function createWellTest(
  wellId: string,
  input: WellTestInput
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await addWellTest(sb, wellId, input);
  revalidateWellTest(wellId);
  return result;
}

/** Update a well test. */
export async function editWellTest(
  wellId: string,
  id: string,
  input: WellTestInput
): Promise<WellTestSaveResult> {
  const sb = await getSupabaseServer();
  // A correction can re-point the test at different tanks or a different day, so
  // it faces the same routing rule a new test does.
  const refusal = await routingRefusal(sb, {
    wellId,
    isolationTankId: input.isolationTankId ?? null,
    controlTankIds: input.controlTankIds ?? [],
    startAt: input.startAt,
  });
  if (refusal) return { ok: false, refusal };
  await updateWellTest(sb, wellId, id, input);
  revalidateWellTest(wellId);
  return { ok: true, id };
}

/** Delete a well test. */
export async function removeWellTest(
  wellId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  await deleteWellTest(sb, wellId, id);
  revalidateWellTest(wellId);
}

// --- Well events (downtime / shut-in) --------------------------------------

/** A well's downtime / shut-in events for the well-page Downtime tab. */
export async function getWellEvents(wellId: string): Promise<WellEvent[]> {
  const sb = await getRequestSupabase();
  return listWellEvents(sb, wellId);
}

/** Record a downtime / shut-in event; revalidates the well page. */
export async function createWellEvent(
  wellId: string,
  input: WellEventInput
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const result = await addWellEvent(sb, wellId, input);
  revalidatePath(`/wells/${wellId}`);
  return result;
}

/** Update a downtime / shut-in event. */
export async function editWellEvent(
  wellId: string,
  id: string,
  input: WellEventInput
): Promise<void> {
  const sb = await getSupabaseServer();
  await updateWellEvent(sb, wellId, id, input);
  revalidatePath(`/wells/${wellId}`);
}

/** Delete a downtime / shut-in event. */
export async function removeWellEvent(
  wellId: string,
  id: string
): Promise<void> {
  const sb = await getSupabaseServer();
  await deleteWellEvent(sb, wellId, id);
  revalidatePath(`/wells/${wellId}`);
}

// --- Report ----------------------------------------------------------------

/** Load the company-wide Well Test Report (for the hub View modal). */
export async function loadWellPerformanceReportAction(): Promise<WellPerformanceReport> {
  return loadWellPerformanceReport();
}
