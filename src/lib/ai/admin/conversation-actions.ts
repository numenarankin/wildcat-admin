"use server";

import type { UIMessage } from "ai";
import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { deriveTitle, NEW_CHAT_TITLE } from "@/lib/ai/conversations";

/**
 * Persistence for the admin Orion, the customer `conversation-actions`
 * pointed at the admin tables. Writes run as the signed-in user, so RLS is
 * the boundary; the explicit gate only turns a silent empty write into an
 * error the client can log.
 */
async function requireAdmin() {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
}

function stripFileBytes(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => (p.type === "file" ? { ...p, url: "" } : p)) as UIMessage["parts"],
  }));
}

/** `projectId` tags the chat to an admin project (its Orion tab), as `folderId` does on the customer side. */
export async function saveAdminMessages(
  id: string,
  messages: UIMessage[],
  projectId?: string,
  /** An Enrich chat: tagged to its target so the Enrich tab finds it again. */
  targetNo?: number
): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { data: conv } = await sb.from("admin_conversations").select("title").eq("id", id).maybeSingle();
  let title = conv?.title ?? NEW_CHAT_TITLE;
  if (title === NEW_CHAT_TITLE) title = deriveTitle(messages) ?? title;
  const row: { id: string; title: string; project_id?: string; target_no?: number } = { id, title };
  if (projectId) row.project_id = projectId;
  if (targetNo != null) row.target_no = targetNo;
  const { error: convErr } = await sb.from("admin_conversations").upsert(row, { onConflict: "id" });
  if (convErr) throw new Error(`saveAdminMessages (conversation): ${convErr.message}`);

  // Replace the thread wholesale, keeping each position's first write time so
  // a message is dated by when it was said.
  const { data: existing } = await sb.from("admin_messages").select("position, created_at").eq("conversation_id", id);
  const firstWritten = new Map((existing ?? []).map((m) => [m.position as number, m.created_at as string]));
  const { error: delErr } = await sb.from("admin_messages").delete().eq("conversation_id", id);
  if (delErr) throw new Error(`saveAdminMessages (clear): ${delErr.message}`);
  // No `id`: the row's id is the database's. A UIMessage id is the AI SDK's
  // own string (not a uuid), and passing it through made every insert fail
  // AFTER the delete above had already cleared the thread, which is how a
  // whole conversation vanished on the first hard refresh.
  const now = new Date().toISOString();
  const rows = stripFileBytes(messages).map((m, position) => ({
    conversation_id: id,
    role: m.role,
    parts: m.parts,
    position,
    created_at: firstWritten.get(position) ?? now,
  }));
  if (rows.length > 0) {
    const { error: insErr } = await sb.from("admin_messages").insert(rows);
    if (insErr) throw new Error(`saveAdminMessages (messages): ${insErr.message}`);
  }
  revalidatePath("/orion");
  if (projectId) revalidatePath("/projects", "layout");
  if (targetNo != null) revalidatePath("/prospecting");
}

export async function deleteAdminConversation(id: string): Promise<void> {
  await requireAdmin();
  const sb = await getSupabaseServer();
  const { error } = await sb.from("admin_conversations").delete().eq("id", id);
  if (error) throw new Error(`deleteAdminConversation: ${error.message}`);
  revalidatePath("/orion");
  revalidatePath("/projects", "layout");
}
