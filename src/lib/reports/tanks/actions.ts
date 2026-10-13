"use server";

/**
 * Server actions for the tank reports (GBC-10) — the View modals' data source
 * and the "called in" state setter.
 *
 * Reads go through the request-scoped RLS client so every figure is org-scoped
 * (the `tanks` / `tank_readings` policies do the enforcing); the export routes
 * re-derive the same reports server-side, so the client never supplies numbers.
 * In dev with no Supabase configured, the loaders return empty reports rather
 * than throwing, matching the other report actions.
 */

import { revalidatePath } from "next/cache";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import {
  clearOpenTankCallIns,
  deleteTankCallIn,
  hasOpenTankCallIn,
  insertTankCallIn,
  listTankCallIns,
  type TankCallIn,
} from "@/lib/tanks/call-ins";
import {
  loadBatteryCapacity,
  loadTanksCalledIn,
  loadTankAudit,
  loadTankMeasurements,
} from "@/lib/reports/tanks/data";
import type {
  BatteryCapacityReport,
  TankAuditReport,
  TankMeasurementsReport,
  TanksCalledInReport,
} from "@/lib/reports/tanks/types";

const EMPTY_BATTERY: BatteryCapacityReport = {
  batteries: [],
  totalCapacityBbls: 0,
  totalUsedBbls: 0,
  pctFull: null,
};
const EMPTY_CALLED_IN: TanksCalledInReport = { tanks: [], totalCalledIn: 0 };
const EMPTY_AUDIT: TankAuditReport = {
  rows: [],
  totalEntries: 0,
  editedEntries: 0,
  deletedEntries: 0,
};
const EMPTY_MEASUREMENTS: TankMeasurementsReport = {
  rows: [],
  totalReadings: 0,
  tankCount: 0,
};

/** Today as an ISO `YYYY-MM-DD` string (UTC) — the report's reference date. */
export async function today(): Promise<string> {
  return new Date().toISOString().slice(0, 10);
}

/** Battery Capacity report (per-tank capacity vs used + per-battery summary). */
export async function loadBatteryCapacityReport(): Promise<BatteryCapacityReport> {
  if (!hasSupabase()) return EMPTY_BATTERY;
  const sb = await getSupabaseServer();
  return loadBatteryCapacity(sb);
}

/** Tanks Called In pickup queue (stock, % full, purchaser, days since). */
export async function loadTanksCalledInReport(): Promise<TanksCalledInReport> {
  if (!hasSupabase()) return EMPTY_CALLED_IN;
  const sb = await getSupabaseServer();
  return loadTanksCalledIn(sb, new Date().toISOString().slice(0, 10));
}

/** Tank Measurement Audit (create/update/delete trail per gauge entry). */
export async function loadTankAuditReport(): Promise<TankAuditReport> {
  if (!hasSupabase()) return EMPTY_AUDIT;
  const sb = await getSupabaseServer();
  return loadTankAudit(sb);
}

/** Tank Measurements (raw gauge log per tank + change since prior reading). */
export async function loadTankMeasurementsReport(): Promise<TankMeasurementsReport> {
  if (!hasSupabase()) return EMPTY_MEASUREMENTS;
  const sb = await getSupabaseServer();
  return loadTankMeasurements(sb);
}

/**
 * Put a tank in — or take it out of — the pickup queue.
 *
 * TWO WRITES, ONE CALL. `tanks.called_in_at` is the queue STATE the pickup
 * report scans; `tank_call_ins` is the log of every call. Both are maintained
 * here and nowhere else, so the tank's column and the log's open row always
 * agree on whether the tank is waiting. The log tolerates its table being
 * absent (pre-migration), so queueing a tank never fails for want of history.
 *
 * Pass the call-in moment as an ISO timestamp to queue it, optionally with the
 * purchaser's confirmation number; pass null to clear it once the crude is
 * hauled, which stamps the open log row as cleared. Writes go through RLS
 * (`manage_well_production`), so a caller can never mark a tank outside their
 * org.
 */
export async function setTankCalledIn(
  tankId: string,
  calledInAt: string | null,
  confirmationNo?: string | null
): Promise<void> {
  const sb = await getSupabaseServer();

  if (calledInAt === null) {
    const { error } = await sb
      .from("tanks")
      .update({ called_in_at: null, called_in_by: null })
      .eq("id", tankId);
    if (error) throw new Error(`setTankCalledIn (clear): ${error.message}`);
    // Cleared NOW, not at some date the caller supplies: this is the moment the
    // tank left the queue, and it is what "waited N days" is measured against.
    await clearOpenTankCallIns(sb, tankId, new Date().toISOString());
  } else {
    const user = await getSessionUser();
    const { error } = await sb
      .from("tanks")
      .update({
        called_in_at: calledInAt,
        called_in_by: user?.id ?? null,
      })
      .eq("id", tankId);
    if (error) throw new Error(`setTankCalledIn (set): ${error.message}`);
    // Who was called, read off the tank at call time so a later reassignment
    // doesn't rewrite the record. Same field the queue report calls Purchaser.
    const { data: tank } = await sb
      .from("tanks")
      .select("gatherer:gatherers!gatherer_id(name)")
      .eq("id", tankId)
      .maybeSingle();
    const gatherer =
      (tank as { gatherer?: { name: string | null } | null } | null)?.gatherer
        ?.name ?? "";
    await insertTankCallIn(sb, {
      tankId,
      calledInAt,
      confirmationNo,
      gatherer,
    });
  }

  revalidatePath("/production");
  revalidatePath("/reports");
}

/**
 * Delete a logged call-in (a correction).
 *
 * If that leaves the tank with no OUTSTANDING call, the tank comes out of the
 * pickup queue too: the header badge and this log are two views of the same
 * fact, and deleting the only open call while the tank still reads "called in"
 * would leave a badge with nothing behind it. A tank with another open call
 * stays queued.
 */
export async function removeTankCallIn(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const deleted = await deleteTankCallIn(sb, id);
  if (!deleted) return;

  if (!(await hasOpenTankCallIn(sb, deleted.tankId))) {
    const { error } = await sb
      .from("tanks")
      .update({ called_in_at: null, called_in_by: null })
      .eq("id", deleted.tankId);
    if (error) throw new Error(`removeTankCallIn (dequeue): ${error.message}`);
  }

  revalidatePath("/production");
  revalidatePath("/reports");
}

/** A tank's call-in history, newest first — the tank page's Call-Ins tab. */
export async function loadTankCallIns(tankId: string): Promise<TankCallIn[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  return listTankCallIns(sb, tankId);
}
