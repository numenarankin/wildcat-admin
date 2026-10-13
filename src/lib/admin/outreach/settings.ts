import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { DEFAULT_SETTINGS, isSendSchedule, type ProspectingSettings } from "@/lib/admin/outreach/types";

/**
 * The session admin's Prospecting settings (`admin_prospecting_settings`,
 * migration 2026100800400): the email template and the named send
 * schedules. Defaults when there is no row.
 */
export async function getProspectingSettings(): Promise<ProspectingSettings> {
  if (!hasSupabase()) return DEFAULT_SETTINGS;
  const user = await getSessionUser();
  if (!user) return DEFAULT_SETTINGS;
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_prospecting_settings")
    .select("template, schedules")
    .eq("user_id", user.id)
    .maybeSingle<{ template: string; schedules: unknown }>();
  if (error) {
    console.error("getProspectingSettings failed", error.message);
    return DEFAULT_SETTINGS;
  }
  if (!data) return DEFAULT_SETTINGS;
  const schedules = Array.isArray(data.schedules) ? data.schedules.filter(isSendSchedule) : [];
  return { template: data.template || DEFAULT_SETTINGS.template, schedules };
}

/** Pending scheduled emails, soonest first, for the Sequence tab's list. */
export interface ScheduledEmail {
  id: string;
  enrollmentId: string | null;
  to: string;
  subject: string;
  sendAt: string;
  scheduleName: string | null;
  status: "pending" | "sent" | "failed" | "canceled";
  error: string | null;
}

export async function getScheduledEmails(): Promise<ScheduledEmail[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_scheduled_emails")
    .select("id, enrollment_id, to_field, subject, send_at, schedule_name, status, error")
    .in("status", ["pending", "failed"])
    .order("send_at", { ascending: true });
  if (error) throw new Error(`getScheduledEmails: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    enrollmentId: (r.enrollment_id as string | null) ?? null,
    to: r.to_field as string,
    subject: r.subject as string,
    sendAt: r.send_at as string,
    scheduleName: (r.schedule_name as string | null) ?? null,
    status: r.status as ScheduledEmail["status"],
    error: (r.error as string | null) ?? null,
  }));
}
