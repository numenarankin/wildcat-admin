import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Well events (GBC-11) — downtime / shut-in periods that reduce a well's ONLINE
 * days in weighted allocation and feed the Well Test Report.
 *
 * A well offline for part of a period made less than a neighbour that ran the
 * whole time, so weighted allocation weights by `test_rate × online_days`.
 * `online_days = period_days − downtime/shut-in overlapping the period`; the
 * overlap math is pure and dependency-free so it unit-tests without a database.
 *
 * Data-access follows the `@/lib/tanks/tanks` idiom: every helper takes the
 * caller's request-scoped RLS client (`getSupabaseServer()`) first; the
 * `well_events` RLS policies scope reads/writes to the caller's org.
 */

/** downtime = a partial-day / operational stoppage; shut_in = the well is off. */
export type WellEventType = "downtime" | "shut_in";

/** One downtime / shut-in period on a well. */
export interface WellEvent {
  id: string;
  wellId: string;
  eventType: WellEventType;
  /** Start date, ISO `YYYY-MM-DD`. */
  startDate: string;
  /** End date, ISO `YYYY-MM-DD`, or null while the well is still down. */
  endDate: string | null;
  /**
   * Explicit days attributed to the event, or null to derive from the date
   * span (clipped to the period being computed).
   */
  daysApplied: number | null;
  /** Short reason (e.g. "pump failure"), or "". */
  reason: string;
  /** Free-text comments, or "". */
  comments: string;
}

/** A well event as supplied by the UI, before it has a row id. */
export interface WellEventInput {
  eventType: WellEventType;
  startDate: string;
  endDate?: string | null;
  daysApplied?: number | null;
  reason?: string;
  comments?: string;
}

// --- Online-days math (pure) -----------------------------------------------

/** Inclusive day count between two ISO dates, or 0 when `to < from`/invalid. */
export function daysInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Days one event takes a well offline within `[from, to]`. When `daysApplied`
 * is set it's used verbatim (capped at the period length); otherwise the
 * event's span is clipped to the period and counted inclusively. An open-ended
 * event (no `end_date`) runs through the period's end.
 */
export function eventOfflineDays(
  event: WellEvent,
  from: string,
  to: string
): number {
  const periodDays = daysInclusive(from, to);
  if (periodDays === 0) return 0;
  if (event.daysApplied != null && Number.isFinite(event.daysApplied)) {
    return Math.max(0, Math.min(periodDays, event.daysApplied));
  }
  const start = event.startDate > from ? event.startDate : from;
  const end = event.endDate == null || event.endDate > to ? to : event.endDate;
  return Math.min(periodDays, daysInclusive(start, end));
}

/**
 * A well's online days over `[from, to]` — period days minus the union-capped
 * offline days from its events. Overlapping events can't push offline days
 * above the period length (so online days never goes negative), but this sums
 * per-event offline days, so heavily overlapping events are a conservative
 * (never-negative) approximation rather than a true set union.
 */
export function onlineDays(
  events: WellEvent[],
  from: string,
  to: string
): number {
  const periodDays = daysInclusive(from, to);
  if (periodDays === 0) return 0;
  const offline = events.reduce(
    (sum, e) => sum + eventOfflineDays(e, from, to),
    0
  );
  return Math.max(0, periodDays - Math.min(periodDays, offline));
}

/**
 * The day count a listing shows for one event. Explicit `daysApplied` wins;
 * otherwise it is derived from the dates the same way `eventOfflineDays`
 * counts them: the inclusive span for a bounded event, and start through
 * `today` for one still open. Null only when the start date is unparseable.
 */
export function eventDays(
  event: Pick<WellEvent, "startDate" | "endDate" | "daysApplied">,
  today: string = new Date().toISOString().slice(0, 10)
): number | null {
  if (event.daysApplied != null && Number.isFinite(event.daysApplied)) {
    return event.daysApplied;
  }
  const end = event.endDate ?? today;
  const days = daysInclusive(event.startDate, end);
  return days === 0 && Number.isNaN(Date.parse(`${event.startDate}T00:00:00Z`))
    ? null
    : days;
}

/**
 * Whole-day online check: a well is OFFLINE on `date` when any of its
 * downtime/shut-in events' date range covers that day (`start ≤ date ≤ end`, an
 * open-ended event running from `start` onward). Binary by design — it ignores
 * the fractional `daysApplied` (a period-level concept), so it can drive the
 * per-day straight split where a day is simply on or off. Used by the allocation
 * engine's downtime-adjusted straight method for both tanks and meters.
 */
export function isOnlineOn(events: WellEvent[], date: string): boolean {
  for (const e of events) {
    if (e.startDate <= date && (e.endDate == null || e.endDate >= date)) {
      return false;
    }
  }
  return true;
}

// --- Data-access -----------------------------------------------------------

type Sb = SupabaseClient;

const EVENT_COLS =
  "id, well_id, event_type, start_date, end_date, days_applied, reason, comments";

interface WellEventRow {
  id: string;
  well_id: string;
  event_type: string;
  start_date: string;
  end_date: string | null;
  days_applied: number | null;
  reason: string | null;
  comments: string | null;
}

function mapEvent(r: WellEventRow): WellEvent {
  return {
    id: r.id,
    wellId: r.well_id,
    eventType: r.event_type === "shut_in" ? "shut_in" : "downtime",
    startDate: r.start_date,
    endDate: r.end_date,
    daysApplied: r.days_applied,
    reason: r.reason ?? "",
    comments: r.comments ?? "",
  };
}

function eventRow(wellId: string, input: WellEventInput) {
  return {
    well_id: wellId,
    event_type: input.eventType,
    start_date: input.startDate,
    end_date: input.endDate || null,
    days_applied:
      input.daysApplied != null && Number.isFinite(input.daysApplied)
        ? input.daysApplied
        : null,
    reason: input.reason?.trim() || null,
    comments: input.comments?.trim() || null,
  };
}

/** A well's downtime / shut-in events, most recent first. */
export async function listWellEvents(
  sb: Sb,
  wellId: string
): Promise<WellEvent[]> {
  const { data, error } = await sb
    .from("well_events")
    .select(EVENT_COLS)
    .eq("well_id", wellId)
    .order("start_date", { ascending: false });
  if (error) throw new Error(`listWellEvents: ${error.message}`);
  return ((data ?? []) as unknown as WellEventRow[]).map(mapEvent);
}

/** Every well event in the org (for the Well Test Report). */
export async function listAllWellEvents(sb: Sb): Promise<WellEvent[]> {
  const { data, error } = await sb
    .from("well_events")
    .select(EVENT_COLS)
    .order("start_date", { ascending: false });
  if (error) throw new Error(`listAllWellEvents: ${error.message}`);
  return ((data ?? []) as unknown as WellEventRow[]).map(mapEvent);
}

/**
 * Downtime / shut-in events for a SET of wells, in one query — the bulk feed for
 * the downtime-aware allocation reweight (`downtimeAdjustedShares` and the water
 * graph walk), so a series build loads events once instead of per-well/per-day.
 * Returns a `wellId -> events` map; wells with no events are absent (callers
 * default to `[]`). Empty input short-circuits to an empty map.
 */
export async function listWellEventsForWells(
  sb: Sb,
  wellIds: string[]
): Promise<Map<string, WellEvent[]>> {
  const out = new Map<string, WellEvent[]>();
  const ids = [...new Set(wellIds)];
  if (ids.length === 0) return out;
  const { data, error } = await sb
    .from("well_events")
    .select(EVENT_COLS)
    .in("well_id", ids);
  if (error) throw new Error(`listWellEventsForWells: ${error.message}`);
  for (const row of (data ?? []) as unknown as WellEventRow[]) {
    const e = mapEvent(row);
    const list = out.get(e.wellId);
    if (list) list.push(e);
    else out.set(e.wellId, [e]);
  }
  return out;
}

/** Record a well event; returns the new row id. */
export async function addWellEvent(
  sb: Sb,
  wellId: string,
  input: WellEventInput
): Promise<{ id: string }> {
  const { data, error } = await sb
    .from("well_events")
    .insert(eventRow(wellId, input))
    .select("id")
    .single();
  if (error) throw new Error(`addWellEvent: ${error.message}`);
  return { id: data.id };
}

/** Update a well event, scoped to its well. */
export async function updateWellEvent(
  sb: Sb,
  wellId: string,
  id: string,
  input: WellEventInput
): Promise<void> {
  const { error } = await sb
    .from("well_events")
    .update(eventRow(wellId, input))
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`updateWellEvent: ${error.message}`);
}

/** Delete a well event, scoped to its well. */
export async function deleteWellEvent(
  sb: Sb,
  wellId: string,
  id: string
): Promise<void> {
  const { error } = await sb
    .from("well_events")
    .delete()
    .eq("id", id)
    .eq("well_id", wellId);
  if (error) throw new Error(`deleteWellEvent: ${error.message}`);
}
