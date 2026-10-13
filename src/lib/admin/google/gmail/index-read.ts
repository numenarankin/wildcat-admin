import "server-only";
import { after } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { syncSentIndex } from "@/lib/admin/google/gmail/index-sync";
import type { EmailIndex } from "@/lib/admin/google/gmail/suggest";

const SYNC_EVERY_MS = 60 * 60 * 1000;
/** When each user's sync last ran on this server. */
const lastSync = new Map<string, number>();

/**
 * The composer's autofill index for `userId` (the session's admin, already
 * checked), read through RLS. Each read also moves the Sent sync one step
 * after the response (`after`): on every read while the first pass runs,
 * hourly once caught up. Empty when the tables aren't on this database yet.
 */
export async function readEmailIndex(userId: string): Promise<EmailIndex> {
  const sb = await getSupabaseServer();
  const [contacts, subjects, state] = await Promise.all([
    sb.from("admin_email_contacts").select("email, name, uses, last_used_at").eq("user_id", userId).limit(5000),
    sb.from("admin_email_subjects").select("subject, uses, last_used_at").eq("user_id", userId).limit(5000),
    sb.from("admin_email_index_state").select("history_id").eq("user_id", userId).maybeSingle(),
  ]);
  if (contacts.error || subjects.error || state.error) {
    console.error("gmail index read failed", contacts.error?.message ?? subjects.error?.message ?? state.error?.message);
    return { contacts: [], subjects: [] };
  }

  const caughtUp = Boolean(state.data?.history_id);
  const at = lastSync.get(userId) ?? 0;
  if (!caughtUp || Date.now() - at > SYNC_EVERY_MS) {
    lastSync.set(userId, Date.now());
    after(async () => {
      try {
        await syncSentIndex(userId);
      } catch (error) {
        console.error("gmail index sync failed", error);
      }
    });
  }

  return {
    contacts: contacts.data.map((c) => ({ email: c.email, name: c.name ?? "", uses: c.uses, lastUsedAt: Date.parse(c.last_used_at) })),
    subjects: subjects.data.map((s) => ({ subject: s.subject, uses: s.uses, lastUsedAt: Date.parse(s.last_used_at) })),
  };
}
