"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { getSessionUser } from "@/lib/auth/session";
import { getProspectingSettings } from "@/lib/admin/outreach/settings";
import { recordStep } from "@/lib/admin/outreach/sequence-actions";
import { nextOccurrence, type SendSchedule } from "@/lib/admin/outreach/types";
import { buildMessage, toRaw, validateCompose } from "@/lib/admin/google/gmail/compose";
import { sendMessage } from "@/lib/admin/google/gmail/send";
import { getEmailSettings } from "@/lib/admin/google/gmail/email-settings";

/**
 * Writes for the Outbox tab: add an email to a batch, edit it there, drop
 * it, and send the batch. Every one is the user's click. `sendOutbox` is
 * the only sender and is imported by the Outbox modal alone, so nothing
 * Orion loads reaches it (`lib/ai/admin/no-send.test.ts`).
 */

const PATHS = ["/prospecting", "/outbound"];
const revalidate = () => PATHS.forEach((p) => revalidatePath(p));

async function requireAdminUser() {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  const user = await getSessionUser();
  if (!user) throw new Error("Sign in required.");
  return user;
}

export interface AddToOutboxInput {
  enrollmentId: string | null;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  /** One of: an open outbox, a moment, or a named schedule from the page settings. */
  when: OutboxWhen;
}

/** Which outbox: an open one by id, or the one at a moment (made if absent). */
export type OutboxWhen = { outboxId: string } | { at: string } | { scheduleId: string };

/**
 * The open outbox for `when`: the one named, the one at that `due_at`, or a
 * new one there.
 */
async function resolveOutbox(
  sb: Awaited<ReturnType<typeof getSupabaseServer>>,
  userId: string,
  when: OutboxWhen
): Promise<{ outboxId: string; dueAt: string }> {
  if ("outboxId" in when) {
    const { data, error } = await sb
      .from("admin_outboxes")
      .select("id, due_at")
      .eq("id", when.outboxId)
      .eq("status", "open")
      .maybeSingle<{ id: string; due_at: string }>();
    if (error) throw new Error(`resolveOutbox: ${error.message}`);
    if (!data) throw new Error("That outbox is gone.");
    return { outboxId: data.id, dueAt: data.due_at };
  }
  let dueAt: Date;
  let scheduleName: string | null = null;
  if ("at" in when) {
    dueAt = new Date(when.at);
    if (Number.isNaN(dueAt.getTime())) throw new Error("Pick a valid time.");
  } else {
    const settings = await getProspectingSettings();
    const schedule: SendSchedule | undefined = settings.schedules.find((s) => s.id === when.scheduleId);
    if (!schedule) throw new Error("No such schedule.");
    dueAt = nextOccurrence(schedule);
    scheduleName = schedule.name;
  }
  const dueIso = dueAt.toISOString();
  const { data: existing, error: findErr } = await sb
    .from("admin_outboxes")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("due_at", dueIso)
    .maybeSingle<{ id: string }>();
  if (findErr) throw new Error(`resolveOutbox (find): ${findErr.message}`);
  if (existing) return { outboxId: existing.id, dueAt: dueIso };
  const { data: created, error: createErr } = await sb
    .from("admin_outboxes")
    .insert({ user_id: userId, due_at: dueIso, schedule_name: scheduleName })
    .select("id")
    .single<{ id: string }>();
  if (createErr) throw new Error(`resolveOutbox (create): ${createErr.message}`);
  return { outboxId: created.id, dueAt: dueIso };
}

/** An empty outbox for a moment, from the Outbox tab's New outbox. */
export async function createOutbox(when: { at: string } | { scheduleId: string }): Promise<{ outboxId: string; dueAt: string }> {
  const user = await requireAdminUser();
  const sb = await getSupabaseServer();
  const made = await resolveOutbox(sb, user.id, when);
  revalidate();
  return made;
}

/**
 * Put an email in an outbox. The enrollment's step moves on now, the sent
 * event lands when the batch goes.
 */
export async function addToOutbox(input: AddToOutboxInput): Promise<{ outboxId: string; dueAt: string }> {
  const user = await requireAdminUser();
  if (!input.to.trim()) throw new Error("Add a recipient.");
  const sb = await getSupabaseServer();
  const { outboxId, dueAt: dueIso } = await resolveOutbox(sb, user.id, input.when);

  const { error } = await sb.from("admin_outbox_emails").insert({
    outbox_id: outboxId,
    user_id: user.id,
    enrollment_id: input.enrollmentId,
    to_field: input.to.trim(),
    cc_field: input.cc?.trim() ?? "",
    bcc_field: input.bcc?.trim() ?? "",
    subject: input.subject.slice(0, 998),
    html: input.html,
  });
  if (error) throw new Error(`addToOutbox: ${error.message}`);
  if (input.enrollmentId) {
    await recordStep(input.enrollmentId, "email", "outboxed", `In the outbox for ${dueIso}`);
  }
  revalidate();
  return { outboxId, dueAt: dueIso };
}

/** The modal's edits to one email, saved as the admin types. */
export async function updateOutboxEmail(id: string, patch: { subject?: string; html?: string }): Promise<void> {
  await requireAdminUser();
  const sb = await getSupabaseServer();
  const row: { subject?: string; html?: string } = {};
  if (patch.subject !== undefined) row.subject = patch.subject.slice(0, 998);
  if (patch.html !== undefined) row.html = patch.html;
  if (Object.keys(row).length === 0) return;
  const { error } = await sb.from("admin_outbox_emails").update(row).eq("id", id).neq("status", "sent");
  if (error) throw new Error(`updateOutboxEmail: ${error.message}`);
  revalidate();
}

/** Drop an unsent email from its outbox; an emptied open outbox goes with it. */
export async function removeOutboxEmail(id: string): Promise<void> {
  await requireAdminUser();
  const sb = await getSupabaseServer();
  const { data: row, error: readErr } = await sb
    .from("admin_outbox_emails")
    .select("outbox_id")
    .eq("id", id)
    .maybeSingle<{ outbox_id: string }>();
  if (readErr) throw new Error(`removeOutboxEmail (read): ${readErr.message}`);
  if (!row) return;
  const { error } = await sb.from("admin_outbox_emails").delete().eq("id", id).neq("status", "sent");
  if (error) throw new Error(`removeOutboxEmail: ${error.message}`);
  const { count } = await sb.from("admin_outbox_emails").select("id", { count: "exact", head: true }).eq("outbox_id", row.outbox_id);
  if (count === 0) await sb.from("admin_outboxes").delete().eq("id", row.outbox_id).eq("status", "open");
  revalidate();
}

export interface OutboxSendReport {
  sent: number;
  failed: { id: string; to: string; error: string }[];
}

interface UnsentRow {
  id: string;
  enrollment_id: string | null;
  to_field: string;
  cc_field: string;
  bcc_field: string;
  subject: string;
  html: string;
}

/**
 * Send every unsent email in the outbox through the admin's own Gmail, one at
 * a time, marking each row as it goes. A failed row keeps its error and stays
 * in the outbox for another try; the outbox closes once nothing is left.
 */
export async function sendOutbox(outboxId: string): Promise<OutboxSendReport> {
  const user = await requireAdminUser();
  const sb = await getSupabaseServer();
  const { data: rows, error: readErr } = await sb
    .from("admin_outbox_emails")
    .select("id, enrollment_id, to_field, cc_field, bcc_field, subject, html")
    .eq("outbox_id", outboxId)
    .neq("status", "sent")
    .order("created_at", { ascending: true });
  if (readErr) throw new Error(`sendOutbox: ${readErr.message}`);
  const style = await getEmailSettings();

  const report: OutboxSendReport = { sent: 0, failed: [] };
  for (const row of (rows ?? []) as UnsentRow[]) {
    try {
      const checked = validateCompose({ to: row.to_field, cc: row.cc_field, bcc: row.bcc_field, subject: row.subject, html: row.html });
      if (!checked.ok) throw new Error(checked.error);
      const message = buildMessage(
        { recipients: checked.recipients, subject: row.subject.slice(0, 998), html: row.html, style },
        `wc_${crypto.randomUUID().replace(/-/g, "")}`
      );
      const sent = await sendMessage(user.id, toRaw(message));
      await sb
        .from("admin_outbox_emails")
        .update({ status: "sent", sent_at: new Date().toISOString(), gmail_thread_id: sent.threadId, error: null })
        .eq("id", row.id);
      if (row.enrollment_id) {
        const { data: e } = await sb
          .from("admin_sequence_enrollments")
          .select("step_index")
          .eq("id", row.enrollment_id)
          .maybeSingle<{ step_index: number }>();
        await sb.from("admin_sequence_events").insert({
          enrollment_id: row.enrollment_id,
          // The step was advanced when the email went in the outbox; the send
          // is the prior step's doing.
          step_index: Math.max(0, (e?.step_index ?? 1) - 1),
          action: "email",
          outcome: "sent",
          note: `Sent from the outbox to ${row.to_field}`,
        });
      }
      report.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed.push({ id: row.id, to: row.to_field, error: message });
      await sb.from("admin_outbox_emails").update({ status: "failed", error: message.slice(0, 1_000) }).eq("id", row.id);
    }
  }
  if (report.failed.length === 0) {
    await sb.from("admin_outboxes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", outboxId);
  }
  revalidate();
  return report;
}
