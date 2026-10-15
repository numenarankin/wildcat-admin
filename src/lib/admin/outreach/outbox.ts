import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Outbox, OutboxEmail } from "@/lib/admin/outreach/outbox-types";

/**
 * The Outbox tab's reads (`admin_outboxes`, `admin_outbox_emails`, migration
 * 2026101500200). Request-scoped client: the rows are the session admin's own.
 */

interface OutboxRow {
  id: string;
  due_at: string;
  schedule_name: string | null;
  status: "open" | "sent";
  sent_at: string | null;
}

interface EmailRow {
  id: string;
  outbox_id: string;
  enrollment_id: string | null;
  to_field: string;
  cc_field: string;
  bcc_field: string;
  subject: string;
  html: string;
  status: OutboxEmail["status"];
  error: string | null;
  sent_at: string | null;
  created_at: string;
  admin_sequence_enrollments: {
    admin_targets: { name: string } | null;
    admin_target_contacts: { name: string | null } | null;
  } | null;
}

export async function getOutboxes(): Promise<Outbox[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const [{ data: boxes, error: bErr }, { data: emails, error: eErr }] = await Promise.all([
    sb.from("admin_outboxes").select("id, due_at, schedule_name, status, sent_at"),
    sb
      .from("admin_outbox_emails")
      .select(
        "id, outbox_id, enrollment_id, to_field, cc_field, bcc_field, subject, html, status, error, sent_at, created_at, admin_sequence_enrollments(admin_targets(name), admin_target_contacts(name))"
      )
      .order("created_at", { ascending: true }),
  ]);
  if (bErr) throw new Error(`getOutboxes: ${bErr.message}`);
  if (eErr) throw new Error(`getOutboxes (emails): ${eErr.message}`);

  const byBox = new Map<string, OutboxEmail[]>();
  for (const r of (emails ?? []) as unknown as EmailRow[]) {
    const list = byBox.get(r.outbox_id) ?? [];
    list.push({
      id: r.id,
      enrollmentId: r.enrollment_id,
      companyName: r.admin_sequence_enrollments?.admin_targets?.name ?? null,
      contactName: r.admin_sequence_enrollments?.admin_target_contacts?.name ?? null,
      to: r.to_field,
      cc: r.cc_field,
      bcc: r.bcc_field,
      subject: r.subject,
      html: r.html,
      status: r.status,
      error: r.error,
      sentAt: r.sent_at,
    });
    byBox.set(r.outbox_id, list);
  }
  return ((boxes ?? []) as OutboxRow[]).map((b) => ({
    id: b.id,
    dueAt: b.due_at,
    scheduleName: b.schedule_name,
    status: b.status,
    sentAt: b.sent_at,
    emails: byBox.get(b.id) ?? [],
  }));
}
