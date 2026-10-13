"use server";

import { revalidatePath } from "next/cache";
import type { UIMessage } from "ai";
import { getSupabaseServer } from "@/lib/supabase/server";
import {
  NEW_CHAT_TITLE,
  deriveTitle,
  hydrateStoredMessages,
  type Conversation,
} from "@/lib/ai/conversations";
import { refreshProjectMemory as refreshProjectMemoryImpl } from "@/lib/ai/project-memory";

/**
 * Server-action entry point to regenerate a project's curated
 * memory after a turn. Thin wrapper so client components can invoke it; the work
 * lives in lib/ai/project-memory.ts.
 */
export async function refreshProjectMemory(folderId: string): Promise<void> {
  await refreshProjectMemoryImpl(folderId);
}

interface FolderMessageRow {
  conversation_id: string;
  role: "system" | "user" | "assistant";
  parts: UIMessage["parts"];
  position: number;
}

/**
 * All conversations scoped to one project (folder), with their
 * messages, most recently updated first. Powers the per-project chat-history
 * dropdown; the messages let a picked chat rehydrate without a second round trip.
 */
export async function getFolderConversations(
  folderId: string
): Promise<Conversation[]> {
  const sb = await getSupabaseServer();

  const { data: convs, error: convErr } = await sb
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("folder_id", folderId)
    .order("updated_at", { ascending: false });
  if (convErr) throw new Error(`getFolderConversations: ${convErr.message}`);
  if (!convs || convs.length === 0) return [];

  const ids = convs.map((c) => c.id);
  const { data: msgs, error: msgErr } = await sb
    .from("messages")
    .select("conversation_id, role, parts, position")
    .in("conversation_id", ids)
    .order("position", { ascending: true });
  if (msgErr) throw new Error(`getFolderConversations: ${msgErr.message}`);

  const byConv = new Map<string, FolderMessageRow[]>();
  for (const m of (msgs ?? []) as FolderMessageRow[]) {
    const list = byConv.get(m.conversation_id) ?? [];
    list.push(m);
    byConv.set(m.conversation_id, list);
  }

  return convs.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: new Date(c.created_at).getTime(),
    updatedAt: new Date(c.updated_at).getTime(),
    messages: hydrateStoredMessages(byConv.get(c.id) ?? []),
  }));
}

/**
 * Drop heavy base64 file bytes before persisting. Keeps the attachment's
 * metadata (filename/type) so chips still render, without storing megabytes.
 */
function stripFileBytes(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) =>
      p.type === "file" ? { ...p, url: "" } : p
    ) as UIMessage["parts"],
  }));
}

/** Create a new conversation; returns its id. */
export async function createConversation(): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("conversations")
    .insert({ title: NEW_CHAT_TITLE })
    .select("id")
    .single();
  if (error) throw new Error(`createConversation: ${error.message}`);
  revalidatePath("/orion");
  return { id: data.id };
}

/** Delete a conversation (messages cascade). */
export async function deleteConversation(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("conversations").delete().eq("id", id);
  if (error) throw new Error(`deleteConversation: ${error.message}`);
  revalidatePath("/orion");
}

/** Rename a conversation. */
export async function renameConversation(
  id: string,
  title: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("conversations")
    .update({ title: title.trim() || NEW_CHAT_TITLE })
    .eq("id", id);
  if (error) throw new Error(`renameConversation: ${error.message}`);
  revalidatePath("/orion");
}

/**
 * Persist the full message list for a conversation. Replaces the rows and bumps
 * the title (derived from the first user message while still untitled). Does NOT
 * revalidate — it's a silent background save during/after a chat turn.
 */
export async function saveMessages(
  id: string,
  messages: UIMessage[],
  folderId?: string
): Promise<void> {
  const sb = await getSupabaseServer();

  const { data: conv } = await sb
    .from("conversations")
    .select("title")
    .eq("id", id)
    .maybeSingle();
  let title = conv?.title ?? NEW_CHAT_TITLE;
  if (title === NEW_CHAT_TITLE) {
    title = deriveTitle(messages) ?? title;
  }

  // Ensure the conversation row exists (drafts are only persisted here, on the
  // first save) and update its title / updated_at. `folder_id` scopes the chat
  // to a project; only set on insert so it isn't clobbered.
  const row: { id: string; title: string; folder_id?: string } = { id, title };
  if (folderId) row.folder_id = folderId;
  const { error: convErr } = await sb
    .from("conversations")
    .upsert(row, { onConflict: "id" });
  if (convErr) throw new Error(`saveMessages (conversation): ${convErr.message}`);

  /*
   * A message keeps the timestamp it was FIRST written with.
   *
   * This replaces the whole thread on every save, so without carrying the old
   * timestamps forward every row is re-stamped `now()` each time — measured on
   * live data, a 22-message conversation had all 22 rows sharing one timestamp,
   * and "when was this last said" was really "when was this last saved". That
   * made the history panel's clock a record of activity rather than of
   * conversation, which is what put two-month-old chats at the top reading as
   * three minutes old.
   *
   * Read by POSITION, because message ids are regenerated on each save and are
   * not a stable key across one.
   */
  const { data: existing } = await sb
    .from("messages")
    .select("position, created_at")
    .eq("conversation_id", id);
  const firstWritten = new Map(
    (existing ?? []).map((m) => [m.position as number, m.created_at as string])
  );

  const stripped = stripFileBytes(messages);
  /*
   * `created_at` is written on EVERY row, never left to the column default.
   *
   * PostgREST builds one column list for a bulk insert from the union of the
   * keys across the rows, and a row missing a key gets NULL rather than the
   * column's DEFAULT. So a save that mixed carried-forward timestamps with new
   * messages sent `created_at` for all of them and NULL for the new ones,
   * which is a not-null violation on `messages.created_at`.
   *
   * That is every ordinary turn: some messages already saved, one or two just
   * said. The turn 500s, and the delete above has already run, so the retry
   * finds an empty thread, takes the all-new path, and succeeds having lost
   * exactly the timestamps this block exists to preserve. Both the crash and
   * the silent data loss come from relying on a default in a bulk insert.
   */
  const now = new Date().toISOString();
  const rows = stripped.map((m, i) => ({
    conversation_id: id,
    role: m.role,
    parts: m.parts,
    position: i,
    created_at: firstWritten.get(i) ?? now,
  }));

  const { error: delErr } = await sb
    .from("messages")
    .delete()
    .eq("conversation_id", id);
  if (delErr) throw new Error(`saveMessages (delete): ${delErr.message}`);

  if (rows.length > 0) {
    const { error: insErr } = await sb.from("messages").insert(rows);
    if (insErr) throw new Error(`saveMessages (insert): ${insErr.message}`);
  }
}
