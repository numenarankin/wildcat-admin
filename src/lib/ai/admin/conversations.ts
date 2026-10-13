import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { hydrateStoredMessages, type Conversation } from "@/lib/ai/conversations";

/**
 * The admin's own Orion history (`admin_conversations` / `admin_messages`,
 * migration 2026091600400). Read as the signed-in user: RLS admits only the
 * writer's rows and only while they are on `platform_admins`. Same shape as
 * the customer history so `OrionWorkspace` renders both.
 */
export async function getAdminConversations(projectId?: string): Promise<Conversation[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  // A project's Orion tab lists only that project's chats; /admin/orion lists
  // all of them, as the customer /orion does.
  // Enrich chats (tagged to a target) belong to the Prospecting page, not here.
  let convQuery = sb.from("admin_conversations").select("id, title, created_at, updated_at").is("target_no", null);
  if (projectId) convQuery = convQuery.eq("project_id", projectId);
  let msgQuery = sb
    .from("admin_messages")
    .select("id, conversation_id, role, parts, position, created_at, admin_conversations!inner(project_id, target_no)")
    .is("admin_conversations.target_no", null);
  if (projectId) msgQuery = msgQuery.eq("admin_conversations.project_id", projectId);
  const [{ data: convs, error: convErr }, { data: msgs, error: msgErr }] = await Promise.all([
    convQuery.order("updated_at", { ascending: false }),
    msgQuery.order("position", { ascending: true }),
  ]);
  if (convErr) throw new Error(`getAdminConversations: ${convErr.message}`);
  if (msgErr) throw new Error(`getAdminConversations: ${msgErr.message}`);

  const byConv = new Map<string, NonNullable<typeof msgs>>();
  const lastWrite = new Map<string, number>();
  for (const m of msgs ?? []) {
    const list = byConv.get(m.conversation_id) ?? [];
    list.push(m);
    byConv.set(m.conversation_id, list);
    const at = new Date(m.created_at).getTime();
    if (at > (lastWrite.get(m.conversation_id) ?? 0)) lastWrite.set(m.conversation_id, at);
  }
  return (convs ?? [])
    .map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: new Date(c.created_at).getTime(),
      updatedAt: lastWrite.get(c.id) ?? new Date(c.updated_at).getTime(),
      messages: hydrateStoredMessages(byConv.get(c.id) ?? []),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A target's Enrich chat, the one conversation tagged to it (the newest, if
 * several were ever written). Null when the company has not been talked
 * about yet; the tab then starts a fresh one.
 */
export async function getEnrichConversation(targetNo: number): Promise<Conversation | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data: conv, error } = await sb
    .from("admin_conversations")
    .select("id, title, created_at, updated_at")
    .eq("target_no", targetNo)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getEnrichConversation: ${error.message}`);
  if (!conv) return null;
  const { data: msgs, error: msgErr } = await sb
    .from("admin_messages")
    .select("id, conversation_id, role, parts, position, created_at")
    .eq("conversation_id", conv.id)
    .order("position", { ascending: true });
  if (msgErr) throw new Error(`getEnrichConversation: ${msgErr.message}`);
  return {
    id: conv.id,
    title: conv.title,
    createdAt: new Date(conv.created_at).getTime(),
    updatedAt: new Date(conv.updated_at).getTime(),
    messages: hydrateStoredMessages(msgs ?? []),
  };
}
