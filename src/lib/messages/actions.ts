"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { getOrgRoster } from "@/lib/messages/roster";
import { getChannelMessages } from "@/lib/messages/conversations";
import {
  dmKey,
  findMentions,
  type ChatAttachment,
  type ChatMessage,
} from "@/lib/messages/types";
import {
  CHAT_FILES_BUCKET,
  attachmentKey,
  registerAttachment,
  resolveOrgId,
} from "@/lib/messages/attachments";

/**
 * Open a conversation with the given people, creating it if it does not exist.
 *
 * One other person is a DM and is deduped on `dm_key`: asking twice returns the
 * same conversation, which is the entire reason that column exists. Two or more
 * is a channel (a group chat), and those are NOT deduped — the same roster can
 * legitimately run two conversations, which is what the optional name is for.
 *
 * The unique index is the real dedupe, not the lookup above it: two clicks in
 * the same second both miss the select and both insert, and the second one gets
 * a 23505 that resolves to the row the first just made.
 */
export async function createConversation(
  memberIds: string[],
  name: string
): Promise<{ id: string }> {
  const user = await requireUser();
  const sb = await getSupabaseServer();

  const others = [...new Set(memberIds)].filter((id) => id !== user.id);
  if (others.length === 0) {
    throw new Error("createConversation: pick at least one other person");
  }
  const all = [user.id, ...others];
  const isDm = others.length === 1;
  const key = isDm ? dmKey(all) : null;

  if (key) {
    const { data: existing } = await sb
      .from("chat_channels")
      .select("id")
      .eq("kind", "dm")
      .eq("dm_key", key)
      .maybeSingle();
    if (existing?.id) return { id: existing.id as string };
  }

  const { data: channel, error } = await sb
    .from("chat_channels")
    .insert({
      kind: isDm ? "dm" : "channel",
      name: isDm ? null : name.trim() || null,
      dm_key: key,
      created_by: user.id,
      // Stated rather than left to the column default: everything created here
      // is a chosen set of people, and a public channel would be readable (its
      // name and existence, not its messages) by the whole org.
      is_private: true,
    })
    .select("id")
    .single();

  if (error) {
    // Someone else (or another tab) created the same DM between the select and
    // the insert. Read theirs rather than failing the click.
    if (error.code === "23505" && key) {
      const { data: raced } = await sb
        .from("chat_channels")
        .select("id")
        .eq("kind", "dm")
        .eq("dm_key", key)
        .maybeSingle();
      if (raced?.id) return { id: raced.id as string };
    }
    throw new Error(`createConversation: ${error.message}`);
  }

  const { error: memberErr } = await sb.from("chat_channel_members").insert(
    all.map((id) => ({
      channel_id: channel.id,
      user_id: id,
      // The creator is the channel admin; the schema keeps the distinction even
      // though every member can currently rename and add.
      role: id === user.id ? "admin" : "member",
    }))
  );
  if (memberErr) {
    throw new Error(`createConversation (members): ${memberErr.message}`);
  }

  revalidatePath("/messages");
  return { id: channel.id as string };
}

/**
 * Upload attachments for a message into the shared `files` bucket.
 *
 * Admin client for the same reason support uploads do: a member may not hold
 * `manage_files`, and these files are reachable only through the message they
 * are linked to, never through the Files tree.
 */
export async function uploadMessageAttachments(
  formData: FormData
): Promise<ChatAttachment[]> {
  const user = await requireUser();
  const admin = getSupabaseAdmin();
  const orgId = await resolveOrgId(admin, user.id);
  if (!orgId) throw new Error("uploadMessageAttachments: no organization found");

  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File);

  const out: ChatAttachment[] = [];
  for (const file of files) {
    // Org-namespaced key, the convention `attachmentKey` documents and the
    // phone's finalize route verifies. (Rows written before this change carry a
    // bare uuid; nothing derives a key from an id, so both still sign.)
    const storageKey = attachmentKey(orgId);
    const bytes = await file.arrayBuffer();

    const { error: upErr } = await admin.storage
      .from(CHAT_FILES_BUCKET)
      .upload(storageKey, bytes, {
        contentType: file.type || undefined,
        upsert: false,
      });
    if (upErr) {
      throw new Error(`uploadMessageAttachments (storage): ${upErr.message}`);
    }

    out.push(
      await registerAttachment(admin, {
        orgId,
        userId: user.id,
        storageKey,
        name: file.name,
        mime: file.type || null,
        size: file.size,
      })
    );
  }
  return out;
}

/**
 * Post a message. Returns the stored row so the sender's client can render it
 * without waiting for the realtime echo.
 *
 * Mentions are resolved here, at write time, into `chat_mentions`. Doing it
 * on read would mean scanning bodies for every name in the org on every render;
 * doing it here costs one roster read and gives "mentions of me" an index.
 */
export async function sendMessage(
  channelId: string,
  body: string,
  fileIds: string[] = []
): Promise<ChatMessage> {
  const user = await requireUser();
  const sb = await getSupabaseServer();

  const text = body.trim();
  if (!text && fileIds.length === 0) {
    throw new Error("sendMessage: empty message");
  }

  const { data: inserted, error } = await sb
    .from("chat_messages")
    .insert({ channel_id: channelId, sender_id: user.id, body: text })
    .select("id, channel_id, sender_id, body, edited_at, created_at")
    .single();
  if (error) throw new Error(`sendMessage: ${error.message}`);

  let attachments: ChatAttachment[] = [];
  if (fileIds.length > 0) {
    const { error: linkErr } = await sb
      .from("chat_files")
      .insert(fileIds.map((fileId) => ({ message_id: inserted.id, file_id: fileId })));
    if (linkErr) throw new Error(`sendMessage (attachments): ${linkErr.message}`);
    // Re-read the message so its attachments come back with signed URLs from
    // the one place that mints them, instead of a second signing path here.
    const reloaded = (await getChannelMessages(channelId)).find(
      (m) => m.id === inserted.id
    );
    attachments = reloaded?.attachments ?? [];
  }

  if (text) {
    const roster = await getOrgRoster();
    // Only people actually in the conversation: an @mention of someone who
    // cannot read the message is not a mention, it is a dangling row.
    const { data: members } = await sb
      .from("chat_channel_members")
      .select("user_id")
      .eq("channel_id", channelId);
    const inChannel = new Set(
      (members ?? []).map((m) => m.user_id as string)
    );
    const mentioned = findMentions(
      text,
      roster.filter((u) => inChannel.has(u.id) && u.id !== user.id)
    );
    if (mentioned.length > 0) {
      // Best-effort: a failed mention row must not lose the message that is
      // already committed above.
      const { error: mErr } = await sb
        .from("chat_mentions")
        .upsert(
          mentioned.map((id) => ({ message_id: inserted.id, user_id: id })),
          { onConflict: "message_id,user_id", ignoreDuplicates: true }
        );
      if (mErr) console.error("sendMessage: mentions failed", mErr.message);
    }
  }

  revalidatePath("/messages");
  return {
    id: inserted.id as string,
    channelId: inserted.channel_id as string,
    senderId: inserted.sender_id as string,
    body: inserted.body as string,
    createdAt: new Date(inserted.created_at as string).getTime(),
    editedAt: null,
    attachments,
  };
}

/** The open conversation's messages, for the client to load on select. */
export async function loadMessages(channelId: string): Promise<ChatMessage[]> {
  await requireUser();
  return getChannelMessages(channelId);
}

/** Stamp the viewer's read watermark, clearing the conversation's unread dot. */
export async function markConversationRead(channelId: string): Promise<void> {
  const user = await requireUser();
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("chat_channel_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("channel_id", channelId)
    .eq("user_id", user.id);
  if (error) throw new Error(`markConversationRead: ${error.message}`);
}

/**
 * Name a group chat, or clear the name back to its roster fallback.
 *
 * DMs are rejected rather than silently ignored: their title is derived per
 * viewer, so a stored name would show the other person a title they never
 * chose.
 */
export async function renameConversation(
  channelId: string,
  name: string
): Promise<void> {
  await requireUser();
  const sb = await getSupabaseServer();
  const { data: channel, error: readErr } = await sb
    .from("chat_channels")
    .select("kind")
    .eq("id", channelId)
    .single();
  if (readErr) throw new Error(`renameConversation: ${readErr.message}`);
  if (channel.kind === "dm") {
    throw new Error("renameConversation: a direct message cannot be named");
  }

  const trimmed = name.trim();
  const { error } = await sb
    .from("chat_channels")
    .update({ name: trimmed || null })
    .eq("id", channelId);
  if (error) throw new Error(`renameConversation: ${error.message}`);
  revalidatePath("/messages");
}

/**
 * Add someone to a group chat.
 *
 * DMs are refused for the reason `GroupMembersModal` hides the control: adding
 * a third person would turn the other party's private thread into a group
 * without their say. Start a group instead.
 */
export async function addConversationMember(
  channelId: string,
  userId: string
): Promise<void> {
  await requireUser();
  const sb = await getSupabaseServer();
  const { data: channel, error: readErr } = await sb
    .from("chat_channels")
    .select("kind")
    .eq("id", channelId)
    .single();
  if (readErr) throw new Error(`addConversationMember: ${readErr.message}`);
  if (channel.kind === "dm") {
    throw new Error("addConversationMember: a direct message has a fixed roster");
  }

  const { error } = await sb
    .from("chat_channel_members")
    .upsert(
      { channel_id: channelId, user_id: userId },
      { onConflict: "channel_id,user_id", ignoreDuplicates: true }
    );
  if (error) throw new Error(`addConversationMember: ${error.message}`);
  revalidatePath("/messages");
}

/**
 * Remove someone from a group chat.
 *
 * You cannot remove yourself here. Leaving is a different act with different
 * consequences (your read state, your notifications), and it must not be one
 * click away from removing someone else.
 */
export async function removeConversationMember(
  channelId: string,
  userId: string
): Promise<void> {
  const user = await requireUser();
  if (userId === user.id) {
    throw new Error("removeConversationMember: use leave, not remove, for yourself");
  }
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("chat_channel_members")
    .delete()
    .eq("channel_id", channelId)
    .eq("user_id", userId);
  if (error) throw new Error(`removeConversationMember: ${error.message}`);
  revalidatePath("/messages");
}
