import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The call-in log — one row per time a pumper phoned a tank in for pickup.
 *
 * `tanks.called_in_at` remains the QUEUE STATE (is this tank waiting right now),
 * which is what the pickup-queue report scans. This is the history behind that
 * state: the next call-in overwrites the tank's column, but never a row here.
 * Both are written by `setTankCalledIn`, the single write path, so the open row
 * here and the tank's column can't disagree about whether a tank is waiting.
 *
 * See `supabase/migrations/2026081600100_tank_call_ins.sql`.
 */

type Sb = SupabaseClient;

/** Postgres "relation does not exist" — the migration hasn't been pushed yet. */
const UNDEFINED_TABLE = "42P01";

export interface TankCallIn {
  id: string;
  tankId: string;
  /** ISO timestamp of the call. */
  calledInAt: string;
  /** The purchaser's reference for the pickup, or "" when none was given. */
  confirmationNo: string;
  /** Who was called, snapshotted at call time; "" when the tank had no gatherer. */
  gatherer: string;
  /** ISO timestamp the tank left the queue (crude hauled), or null if waiting. */
  clearedAt: string | null;
}

interface CallInRow {
  id: string;
  tank_id: string;
  called_in_at: string;
  confirmation_no: string | null;
  gatherer: string | null;
  cleared_at: string | null;
}

function toCallIn(r: CallInRow): TankCallIn {
  return {
    id: r.id,
    tankId: r.tank_id,
    calledInAt: r.called_in_at,
    confirmationNo: r.confirmation_no ?? "",
    gatherer: r.gatherer ?? "",
    clearedAt: r.cleared_at,
  };
}

const COLUMNS = "id, tank_id, called_in_at, confirmation_no, gatherer, cleared_at";

/**
 * A tank's call-ins, newest first. Returns [] rather than throwing when the
 * table is absent, so a database that hasn't taken the migration renders an
 * empty tab instead of a broken page.
 */
export async function listTankCallIns(
  sb: Sb,
  tankId: string
): Promise<TankCallIn[]> {
  const { data, error } = await sb
    .from("tank_call_ins")
    .select(COLUMNS)
    .eq("tank_id", tankId)
    .order("called_in_at", { ascending: false });
  if (error) {
    if (error.code === UNDEFINED_TABLE) return [];
    throw new Error(`listTankCallIns: ${error.message}`);
  }
  return ((data ?? []) as unknown as CallInRow[]).map(toCallIn);
}

/**
 * The call-ins of a SET of tanks, newest first across all of them.
 *
 * The battery page's Call-Ins tab: a battery is a display level over its member
 * tanks, so its log is theirs pooled, and the rows carry `tankId` so the table
 * can say which tank was phoned in. One round trip rather than one per tank.
 *
 * Same missing-table tolerance as {@link listTankCallIns}, for the same reason.
 */
export async function listCallInsForTanks(
  sb: Sb,
  tankIds: string[]
): Promise<TankCallIn[]> {
  const ids = [...new Set(tankIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const { data, error } = await sb
    .from("tank_call_ins")
    .select(COLUMNS)
    .in("tank_id", ids)
    .order("called_in_at", { ascending: false });
  if (error) {
    if (error.code === UNDEFINED_TABLE) return [];
    throw new Error(`listCallInsForTanks: ${error.message}`);
  }
  return ((data ?? []) as unknown as CallInRow[]).map(toCallIn);
}

/** Record a call. `gatherer` is snapshotted by the caller from the tank. */
export async function insertTankCallIn(
  sb: Sb,
  input: {
    tankId: string;
    calledInAt: string;
    confirmationNo?: string | null;
    gatherer?: string | null;
  }
): Promise<void> {
  const { error } = await sb.from("tank_call_ins").insert({
    tank_id: input.tankId,
    called_in_at: input.calledInAt,
    confirmation_no: input.confirmationNo?.trim() || null,
    gatherer: input.gatherer ?? "",
  });
  if (error && error.code !== UNDEFINED_TABLE) {
    throw new Error(`insertTankCallIn: ${error.message}`);
  }
}

/**
 * Close the outstanding call for a tank — the crude was hauled.
 *
 * Only the OPEN rows are stamped, and with the moment the tank actually left
 * the queue, so a second "Mark Picked Up" can't backdate a call that was
 * already closed. A tank with no open row (called in before this log existed)
 * simply has nothing to close.
 */
/**
 * Delete a logged call — a correction, for a call recorded by mistake or
 * against the wrong tank. Returns the tank it belonged to, so the caller can
 * reconcile the tank's queue state, or null when the row was already gone.
 */
export async function deleteTankCallIn(
  sb: Sb,
  id: string
): Promise<{ tankId: string } | null> {
  const { data, error } = await sb
    .from("tank_call_ins")
    .delete()
    .eq("id", id)
    .select("tank_id")
    .maybeSingle();
  if (error) {
    if (error.code === UNDEFINED_TABLE) return null;
    throw new Error(`deleteTankCallIn: ${error.message}`);
  }
  const row = data as { tank_id: string } | null;
  return row ? { tankId: row.tank_id } : null;
}

/** Whether a tank still has an outstanding (uncleared) call logged. */
export async function hasOpenTankCallIn(
  sb: Sb,
  tankId: string
): Promise<boolean> {
  const { data, error } = await sb
    .from("tank_call_ins")
    .select("id")
    .eq("tank_id", tankId)
    .is("cleared_at", null)
    .limit(1);
  if (error) {
    if (error.code === UNDEFINED_TABLE) return false;
    throw new Error(`hasOpenTankCallIn: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

export async function clearOpenTankCallIns(
  sb: Sb,
  tankId: string,
  clearedAt: string
): Promise<void> {
  const { error } = await sb
    .from("tank_call_ins")
    .update({ cleared_at: clearedAt })
    .eq("tank_id", tankId)
    .is("cleared_at", null);
  if (error && error.code !== UNDEFINED_TABLE) {
    throw new Error(`clearOpenTankCallIns: ${error.message}`);
  }
}
