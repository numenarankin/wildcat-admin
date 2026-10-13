import "server-only";

/**
 * Data access for `recon_alerts` (migration 2026100200100).
 *
 * The RLS half serves the Recon alerts modal: a user sees and edits only their
 * own alerts in the org they are signed into. The service-role half serves the
 * dispatcher, which has no session and filters explicitly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { nextDueAt } from "@/lib/reports/digest/schedule";
import { COUNTY_NAMES } from "@/lib/scout/counties";
import {
  ALERT_FREQUENCIES,
  ALERT_KINDS,
  type AlertFrequency,
  type AlertKind,
  type ReconAlert,
  type ReconAlertInput,
} from "./types";

const SELECT =
  "id, org_id, user_id, name, county_codes, kinds, frequency, send_hour, timezone, enabled, cursor_at, next_due_at";

interface Row {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  county_codes: number[];
  kinds: string[];
  frequency: string;
  send_hour: number;
  timezone: string;
  enabled: boolean;
  cursor_at: string | null;
  next_due_at: string | null;
}

function mapRow(r: Row): ReconAlert {
  return {
    id: r.id,
    orgId: r.org_id,
    userId: r.user_id,
    name: r.name,
    countyCodes: r.county_codes ?? [],
    kinds: (r.kinds ?? []).filter((k): k is AlertKind =>
      (ALERT_KINDS as readonly string[]).includes(k)
    ),
    frequency: r.frequency as AlertFrequency,
    sendHour: r.send_hour,
    timezone: r.timezone,
    enabled: r.enabled,
    cursorAt: r.cursor_at,
    nextDueAt: r.next_due_at,
  };
}

/** The scheduling rules `nextDueAt` reads. Alerts have no revenue basis. */
export function alertRules(a: Pick<ReconAlert, "frequency" | "sendHour" | "timezone">) {
  return {
    frequency: a.frequency,
    basis: "estimated" as const,
    sendHour: a.sendHour,
    timezone: a.timezone,
  };
}

/**
 * Validate and normalise what the form sent. Throws a message fit for a toast.
 *
 * Unknown counties and kinds are dropped rather than stored: the database would
 * accept an even county code and the dispatcher would quietly match nothing.
 */
export function cleanInput(input: ReconAlertInput): ReconAlertInput {
  const countyCodes = [...new Set(input.countyCodes.map(Number))].filter(
    (c) => Number.isInteger(c) && COUNTY_NAMES[c] != null
  );
  const kinds = ALERT_KINDS.filter((k) => input.kinds.includes(k));
  if (!countyCodes.length) throw new Error("Pick at least one county.");
  if (!kinds.length) throw new Error("Pick at least one thing to watch.");
  const frequency = (ALERT_FREQUENCIES as readonly string[]).includes(input.frequency)
    ? input.frequency
    : "daily";
  const sendHour = Number.isInteger(input.sendHour)
    ? Math.min(23, Math.max(0, input.sendHour))
    : 7;
  const name =
    input.name.trim().slice(0, 120) ||
    countyCodes.map((c) => COUNTY_NAMES[c]).join(", ").slice(0, 120);
  return {
    name,
    countyCodes,
    kinds,
    frequency,
    sendHour,
    timezone: input.timezone || "America/Chicago",
    enabled: input.enabled,
  };
}

// --- RLS-scoped (the alerts modal) -------------------------------------------

/** The signed-in user's alerts in the current org, oldest first. */
export async function listMyAlerts(): Promise<ReconAlert[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("recon_alerts")
    .select(SELECT)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listMyAlerts: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapRow);
}

/** One of the user's own alerts, or null (RLS hides everyone else's). */
export async function getMyAlert(id: string): Promise<ReconAlert | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("recon_alerts")
    .select(SELECT)
    .eq("id", id)
    .maybeSingle<Row>();
  if (error) throw new Error(`getMyAlert: ${error.message}`);
  return data ? mapRow(data) : null;
}

/**
 * Create an alert. `cursorAt` is where it starts reading: the newest arrivals
 * run at creation, so a new alert reports from now on and never mails the
 * backlog it was created over.
 */
export async function createAlert(
  input: ReconAlertInput,
  cursorAt: string,
  now: Date = new Date()
): Promise<ReconAlert> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("recon_alerts")
    .insert({
      name: input.name,
      county_codes: input.countyCodes,
      kinds: input.kinds,
      frequency: input.frequency,
      send_hour: input.sendHour,
      timezone: input.timezone,
      enabled: input.enabled,
      cursor_at: cursorAt,
      next_due_at: nextDueAt(alertRules(input), now).toISOString(),
    })
    .select(SELECT)
    .single<Row>();
  if (error) throw new Error(`createAlert: ${error.message}`);
  return mapRow(data);
}

/**
 * Update an alert's editable fields. The cursor is left alone, so editing the
 * counties does not re-send or skip anything; the schedule is re-armed because
 * the hour or cadence may have changed.
 */
export async function updateAlert(
  id: string,
  input: ReconAlertInput,
  now: Date = new Date()
): Promise<ReconAlert> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("recon_alerts")
    .update({
      name: input.name,
      county_codes: input.countyCodes,
      kinds: input.kinds,
      frequency: input.frequency,
      send_hour: input.sendHour,
      timezone: input.timezone,
      enabled: input.enabled,
      next_due_at: nextDueAt(alertRules(input), now).toISOString(),
    })
    .eq("id", id)
    .select(SELECT)
    .single<Row>();
  if (error) throw new Error(`updateAlert: ${error.message}`);
  return mapRow(data);
}

export async function deleteAlert(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("recon_alerts").delete().eq("id", id);
  if (error) throw new Error(`deleteAlert: ${error.message}`);
}

// --- Service-role (dispatcher) -----------------------------------------------

/** Enabled alerts that are due, plus never-armed ones, across every org. */
export async function listDueAlerts(
  admin: SupabaseClient,
  now: Date
): Promise<ReconAlert[]> {
  const { data, error } = await admin
    .from("recon_alerts")
    .select(SELECT)
    .eq("enabled", true)
    .or(`next_due_at.is.null,next_due_at.lte.${now.toISOString()}`);
  if (error) throw new Error(`listDueAlerts: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapRow);
}
