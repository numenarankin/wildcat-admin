"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { getSessionUser } from "@/lib/auth/session";
import { getDefaultSequence, getSequence } from "@/lib/admin/outreach/sequences";
import {
  advance,
  nextOccurrence,
  stepDueOn,
  todayInAdminZone,
  type EnrollmentState,
  type EventOutcome,
  type SendSchedule,
  type SequenceAction,
} from "@/lib/admin/outreach/types";
import { getProspectingSettings } from "@/lib/admin/outreach/settings";

/**
 * Writes for the Sequence tab: enroll, record a step, stop, and schedule an
 * email for the cron to send. Every one is the user's click; Orion has no
 * tool that reaches any of these.
 */

// The Sequence tab on /prospecting and the Queue tab on /outbound show the same rows.
const PATHS = ["/prospecting", "/outbound"];
const revalidate = () => PATHS.forEach((p) => revalidatePath(p));

async function requireAdmin() {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
}

/**
 * Enroll a target in the default sequence, once per chosen contact (one
 * enrollment with no contact when none is chosen: the calls go to the P-5
 * phone). A contact already enrolled and active is left alone.
 */
export async function enrollTarget(operatorNo: number, contactIds: string[]): Promise<{ enrolled: number }> {
  await requireAdmin();
  const sequence = await getDefaultSequence();
  if (!sequence) throw new Error("No default sequence. Apply migration 2026100800400.");
  const sb = await getSupabaseServer();
  const today = todayInAdminZone();
  const wanted: (string | null)[] = contactIds.length ? contactIds : [null];

  const { data: existing } = await sb
    .from("admin_sequence_enrollments")
    .select("contact_id")
    .eq("operator_no", operatorNo)
    .eq("state", "active");
  const active = new Set((existing ?? []).map((e) => (e.contact_id as string | null) ?? "none"));
  const rows = wanted
    .filter((c) => !active.has(c ?? "none"))
    .map((contact_id) => ({
      operator_no: operatorNo,
      contact_id,
      sequence_id: sequence.id,
      step_index: 0,
      next_due_on: stepDueOn(today, sequence.steps, 0),
      state: "active" as const,
      enrolled_on: today,
    }));
  if (rows.length > 0) {
    const { error } = await sb.from("admin_sequence_enrollments").insert(rows);
    if (error) throw new Error(`enrollTarget: ${error.message}`);
  }
  // The research card reads "enrolled" from here on.
  await sb.from("admin_target_research").update({ status: "enrolled" }).eq("operator_no", operatorNo);
  revalidate();
  return { enrolled: rows.length };
}

/**
 * Record what happened at the current step and move the enrollment on. A
 * reply or a meeting ends the sequence (the point of it was reached).
 */
export async function recordStep(
  enrollmentId: string,
  action: SequenceAction,
  outcome: EventOutcome,
  note?: string
): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { data: e, error: readErr } = await sb
    .from("admin_sequence_enrollments")
    .select("id, sequence_id, step_index, enrolled_on, state")
    .eq("id", enrollmentId)
    .maybeSingle<{ id: string; sequence_id: string; step_index: number; enrolled_on: string; state: EnrollmentState }>();
  if (readErr) throw new Error(`recordStep: ${readErr.message}`);
  if (!e) throw new Error("No such enrollment.");

  const { error: evErr } = await sb.from("admin_sequence_events").insert({
    enrollment_id: enrollmentId,
    step_index: e.step_index,
    action,
    outcome,
    note: note?.slice(0, 2_000) ?? null,
  });
  if (evErr) throw new Error(`recordStep (event): ${evErr.message}`);

  let patch: { step_index?: number; next_due_on?: string | null; state: EnrollmentState };
  if (outcome === "replied" || outcome === "meeting") {
    patch = { state: outcome, next_due_on: null };
  } else {
    const sequence = await getSequence(e.sequence_id);
    const next = advance({ enrolledOn: e.enrolled_on, stepIndex: e.step_index }, sequence?.steps ?? []);
    patch = { step_index: next.stepIndex, next_due_on: next.nextDueOn, state: next.state };
  }
  const { error } = await sb.from("admin_sequence_enrollments").update(patch).eq("id", enrollmentId);
  if (error) throw new Error(`recordStep (advance): ${error.message}`);
  revalidate();
}

export async function stopEnrollment(enrollmentId: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("admin_sequence_enrollments")
    .update({ state: "stopped", next_due_on: null })
    .eq("id", enrollmentId);
  if (error) throw new Error(`stopEnrollment: ${error.message}`);
  revalidate();
}

/**
 * Once a target has no enrollment left, its research card stops reading
 * "enrolled": back to reviewed, the status it had when the user enrolled it.
 */
async function unmarkEnrolled(sb: Awaited<ReturnType<typeof getSupabaseServer>>, operatorNos: number[]) {
  if (operatorNos.length === 0) return;
  const { data } = await sb.from("admin_sequence_enrollments").select("operator_no").in("operator_no", operatorNos);
  const still = new Set((data ?? []).map((r) => r.operator_no as number));
  const bare = operatorNos.filter((n) => !still.has(n));
  if (bare.length === 0) return;
  await sb.from("admin_target_research").update({ status: "reviewed" }).in("operator_no", bare).eq("status", "enrolled");
}

/**
 * Delete an enrollment outright: its events go with it, and any email still
 * queued for it is canceled so the cron never sends for a row that is gone.
 */
export async function deleteEnrollment(enrollmentId: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { data: row, error: readErr } = await sb
    .from("admin_sequence_enrollments")
    .select("operator_no")
    .eq("id", enrollmentId)
    .maybeSingle<{ operator_no: number }>();
  if (readErr) throw new Error(`deleteEnrollment (read): ${readErr.message}`);
  if (!row) return;
  await sb.from("admin_scheduled_emails").update({ status: "canceled" }).eq("enrollment_id", enrollmentId).eq("status", "pending");
  const { error } = await sb.from("admin_sequence_enrollments").delete().eq("id", enrollmentId);
  if (error) throw new Error(`deleteEnrollment: ${error.message}`);
  await unmarkEnrolled(sb, [row.operator_no]);
  revalidate();
}

/** Empty the Sequence tab: every enrollment, its events and its pending emails. */
export async function clearEnrollments(): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { data: rows, error: readErr } = await sb.from("admin_sequence_enrollments").select("operator_no");
  if (readErr) throw new Error(`clearEnrollments (read): ${readErr.message}`);
  await sb.from("admin_scheduled_emails").update({ status: "canceled" }).not("enrollment_id", "is", null).eq("status", "pending");
  const { error } = await sb.from("admin_sequence_enrollments").delete().gte("step_index", 0);
  if (error) throw new Error(`clearEnrollments: ${error.message}`);
  await unmarkEnrolled(sb, [...new Set((rows ?? []).map((r) => r.operator_no as number))]);
  revalidate();
}

export interface ScheduleEmailInput {
  enrollmentId: string | null;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  /** One of: a moment, or a named schedule from the page settings. */
  when: { at: string } | { scheduleId: string };
}

/**
 * Queue an email for the cron. The row is the user's (their Gmail sends it)
 * and the time is resolved here, from the schedule they named, so the cron
 * only ever compares `send_at` with the clock.
 */
export async function scheduleEmail(input: ScheduleEmailInput): Promise<{ id: string; sendAt: string }> {
  await requireAdmin();
  const user = await getSessionUser();
  if (!user) throw new Error("Sign in required.");
  let sendAt: Date;
  let scheduleName: string | null = null;
  const when = input.when;
  if ("at" in when) {
    sendAt = new Date(when.at);
    if (Number.isNaN(sendAt.getTime())) throw new Error("Pick a valid time.");
  } else {
    const settings = await getProspectingSettings();
    const schedule: SendSchedule | undefined = settings.schedules.find((s) => s.id === when.scheduleId);
    if (!schedule) throw new Error("No such schedule.");
    sendAt = nextOccurrence(schedule);
    scheduleName = schedule.name;
  }
  if (!input.to.trim()) throw new Error("Add a recipient.");
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_scheduled_emails")
    .insert({
      user_id: user.id,
      enrollment_id: input.enrollmentId,
      to_field: input.to.trim(),
      cc_field: input.cc?.trim() ?? "",
      bcc_field: input.bcc?.trim() ?? "",
      subject: input.subject.slice(0, 998),
      html: input.html,
      send_at: sendAt.toISOString(),
      schedule_name: scheduleName,
    })
    .select("id")
    .single<{ id: string }>();
  if (error) throw new Error(`scheduleEmail: ${error.message}`);
  if (input.enrollmentId) {
    // The step is spoken for: the row moves on, and the sent event lands
    // when the cron sends it.
    await recordStep(input.enrollmentId, "email", "scheduled", `Scheduled for ${sendAt.toISOString()}`);
  }
  revalidate();
  return { id: data.id, sendAt: sendAt.toISOString() };
}

export async function cancelScheduledEmail(id: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("admin_scheduled_emails")
    .update({ status: "canceled" })
    .eq("id", id)
    .eq("status", "pending");
  if (error) throw new Error(`cancelScheduledEmail: ${error.message}`);
  revalidate();
}
