import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMessage, toRaw, validateCompose } from "@/lib/admin/google/gmail/compose";
import { sendMessage } from "@/lib/admin/google/gmail/send";
import { DEFAULT_EMAIL_SETTINGS, isEmailFont, isEmailSize } from "@/lib/admin/google/gmail/email-style";

/**
 * The cron's half of scheduled sending: every pending row whose time has
 * come goes out through ITS OWN user's Gmail, one at a time, and is marked
 * sent or failed. Service-role client (the cron has no session); the rows
 * were written by the user who scheduled them, which is who they send as.
 *
 * Orion never reaches this: it is loaded by the cron route only
 * (`lib/ai/admin/no-send.test.ts` walks the chat routes' imports).
 */

const BATCH = 20;

interface DueRow {
  id: string;
  user_id: string;
  enrollment_id: string | null;
  to_field: string;
  cc_field: string;
  bcc_field: string;
  subject: string;
  html: string;
}

export interface SendReport {
  sent: string[];
  failed: { id: string; error: string }[];
}

async function emailStyleFor(admin: SupabaseClient, userId: string) {
  const { data } = await admin
    .from("admin_email_settings")
    .select("font_family, font_size")
    .eq("user_id", userId)
    .maybeSingle<{ font_family: string; font_size: string }>();
  return {
    fontFamily: isEmailFont(data?.font_family) ? data!.font_family : DEFAULT_EMAIL_SETTINGS.fontFamily,
    fontSize: isEmailSize(data?.font_size) ? data!.font_size : DEFAULT_EMAIL_SETTINGS.fontSize,
  };
}

/** Send one row; returns the error text on failure. */
async function sendRow(admin: SupabaseClient, row: DueRow): Promise<string | null> {
  const checked = validateCompose({
    to: row.to_field,
    cc: row.cc_field,
    bcc: row.bcc_field,
    subject: row.subject,
    html: row.html,
  });
  if (!checked.ok) return checked.error;
  const style = await emailStyleFor(admin, row.user_id);
  const message = buildMessage(
    { recipients: checked.recipients, subject: row.subject.slice(0, 998), html: row.html, style },
    `wc_${crypto.randomUUID().replace(/-/g, "")}`
  );
  const sent = await sendMessage(row.user_id, toRaw(message));
  await admin
    .from("admin_scheduled_emails")
    .update({ status: "sent", sent_at: new Date().toISOString(), gmail_thread_id: sent.threadId, error: null })
    .eq("id", row.id);
  if (row.enrollment_id) {
    const { data: e } = await admin
      .from("admin_sequence_enrollments")
      .select("step_index")
      .eq("id", row.enrollment_id)
      .maybeSingle<{ step_index: number }>();
    await admin.from("admin_sequence_events").insert({
      enrollment_id: row.enrollment_id,
      // The step was advanced when the email was scheduled; the send is the
      // prior step's doing.
      step_index: Math.max(0, (e?.step_index ?? 1) - 1),
      action: "email",
      outcome: "sent",
      note: `Sent on schedule to ${row.to_field}`,
      created_by: row.user_id,
    });
  }
  return null;
}

/**
 * Claim and send what is due. A row is claimed by flipping it to `sending`
 * is not a status here; instead each row is sent then marked, and a crash
 * between the two is caught by the Gmail thread id check on the next run
 * being absent: the row sends again. Runs are five minutes apart, batches
 * small, so a double send needs two crashes in a row on the same row.
 */
export async function sendDueScheduledEmails(admin: SupabaseClient, now = new Date()): Promise<SendReport> {
  const { data, error } = await admin
    .from("admin_scheduled_emails")
    .select("id, user_id, enrollment_id, to_field, cc_field, bcc_field, subject, html")
    .eq("status", "pending")
    .lte("send_at", now.toISOString())
    .order("send_at", { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`sendDueScheduledEmails: ${error.message}`);
  const report: SendReport = { sent: [], failed: [] };
  for (const row of (data ?? []) as DueRow[]) {
    try {
      const failure = await sendRow(admin, row);
      if (failure) throw new Error(failure);
      report.sent.push(row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed.push({ id: row.id, error: message });
      await admin.from("admin_scheduled_emails").update({ status: "failed", error: message.slice(0, 1_000) }).eq("id", row.id);
    }
  }
  return report;
}
