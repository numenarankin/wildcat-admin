import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { buildThreads } from "@/lib/support/threads";
import type { StaffSupportThread, SupportSenderRole, SupportStatus } from "@/lib/support/types";

/**
 * Every customer's support threads, for the staff desk at /admin/support.
 *
 * Service-role reads behind the platform-admin check: a staff viewer owns
 * none of these threads, so RLS as the viewer returns nothing. `buildThreads`
 * is the user side's assembler, run for the STAFF side, so "unread" here
 * means the customer wrote last and staff have not opened it since.
 */
export async function getStaffSupportThreads(): Promise<StaffSupportThread[]> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  const admin = getSupabaseAdmin();

  const { data: threads, error: tErr } = await admin
    .from("support_threads")
    .select("id, owner_id, org_id, subject, status, created_at, updated_at, last_message_at, staff_last_read_at")
    .order("last_message_at", { ascending: false });
  if (tErr) throw new Error(`getStaffSupportThreads: ${tErr.message}`);
  if (!threads || threads.length === 0) return [];

  const ids = threads.map((t) => t.id);
  const ownerIds = [...new Set(threads.map((t) => t.owner_id as string))];
  const orgIds = [...new Set(threads.map((t) => t.org_id as string))];

  const [messages, orgs, profiles, users] = await Promise.all([
    admin
      .from("support_messages")
      .select("id, thread_id, sender_role, body, created_at")
      .in("thread_id", ids)
      .order("position", { ascending: true })
      .then(({ data, error }) => {
        if (error) throw new Error(`getStaffSupportThreads (messages): ${error.message}`);
        return (data ?? []) as { id: string; thread_id: string; sender_role: SupportSenderRole; body: string; created_at: string }[];
      }),
    admin
      .from("organizations")
      .select("id, name")
      .in("id", orgIds)
      .then(({ data, error }) => {
        if (error) throw new Error(`getStaffSupportThreads (orgs): ${error.message}`);
        return new Map((data ?? []).map((o) => [o.id as string, o.name as string]));
      }),
    admin
      .from("profile")
      .select("user_id, name")
      .in("user_id", ownerIds)
      .then(({ data, error }) => {
        if (error) throw new Error(`getStaffSupportThreads (profiles): ${error.message}`);
        return new Map((data ?? []).map((p) => [p.user_id as string, (p.name as string | null) ?? ""]));
      }),
    admin.auth.admin.listUsers({ perPage: 1000 }).then(({ data, error }) => {
      if (error) throw new Error(`getStaffSupportThreads (users): ${error.message}`);
      return new Map(data.users.map((u) => [u.id, u.email ?? null]));
    }),
  ]);

  const messageIds = messages.map((m) => m.id);
  let attachments: { message_id: string; file_id: string; files: { name: string | null; storage_key: string | null } | null }[] = [];
  if (messageIds.length > 0) {
    const { data, error } = await admin
      .from("support_message_files")
      .select("message_id, file_id, files(name, storage_key)")
      .in("message_id", messageIds);
    if (error) throw new Error(`getStaffSupportThreads (attachments): ${error.message}`);
    attachments = (data ?? []) as unknown as typeof attachments;
  }

  const readAt = new Map<string, string | null>(
    threads.map((t) => [t.id as string, (t.staff_last_read_at as string | null) ?? null])
  );
  const built = await buildThreads(
    threads.map((t) => ({
      id: t.id as string,
      subject: t.subject as string,
      status: t.status as SupportStatus,
      created_at: t.created_at as string,
      updated_at: t.updated_at as string,
      last_message_at: t.last_message_at as string,
      user_last_read_at: null,
    })),
    messages,
    attachments,
    "staff",
    readAt
  );

  const byId = new Map(threads.map((t) => [t.id as string, t]));
  return built.map((thread) => {
    const row = byId.get(thread.id)!;
    const email = users.get(row.owner_id as string) ?? null;
    return {
      ...thread,
      customer: {
        name: (profiles.get(row.owner_id as string) ?? "").trim() || email || "Customer",
        email,
        orgName: orgs.get(row.org_id as string) ?? "",
      },
    };
  });
}
