import "server-only";

import { hasSupabase } from "@/lib/env";
import { getSessionUser } from "@/lib/auth/session";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { getOrgRoster } from "@/lib/messages/roster";
import type {
  ChannelKind,
  ChatAttachment,
  ChatMessage,
  ChatUser,
  Conversation,
} from "@/lib/messages/types";

const FILES_BUCKET = "files";
const SIGNED_URL_TTL = 60 * 60; // one hour, matching the support chat

/** Newest messages loaded when a conversation is opened. */
export const MESSAGE_PAGE_SIZE = 200;

interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string | null;
  last_message_at: string;
}

interface MemberRow {
  channel_id: string;
  user_id: string;
  last_read_at: string;
}

interface PreviewRow {
  channel_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  has_attachment: boolean;
}

interface MessageRow {
  id: string;
  channel_id: string;
  sender_id: string;
  body: string;
  edited_at: string | null;
  created_at: string;
}

interface AttachmentRow {
  message_id: string;
  file_id: string;
  files: { name: string | null; storage_key: string | null } | null;
}

/**
 * Sign a set of storage keys. The caller has already passed RLS on the rows
 * that reference them, so the admin client (which reaches the private bucket)
 * is safe here — the same reasoning as `support/threads.ts`.
 */
async function signStorageKeys(keys: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (keys.length === 0) return urls;
  const admin = getSupabaseAdmin();
  await Promise.all(
    keys.map(async (key) => {
      const { data } = await admin.storage
        .from(FILES_BUCKET)
        .createSignedUrl(key, SIGNED_URL_TTL);
      if (data?.signedUrl) urls.set(key, data.signedUrl);
    })
  );
  return urls;
}

/**
 * Every conversation the signed-in user belongs to, newest activity first.
 *
 * Four reads, none of them per-conversation: my membership rows (which carry my
 * read watermark), the channels themselves, the full rosters, and one preview
 * row per channel from `chat_channel_previews()`. RLS scopes all four to
 * channels I am a member of, so nothing here filters by org by hand.
 */
export async function getConversations(): Promise<Conversation[]> {
  if (!hasSupabase()) return [];
  const user = await getSessionUser();
  if (!user) return [];
  const sb = await getSupabaseServer();

  // The previews RPC is keyed on the caller, not on the channel list, so it
  // goes out with the membership read rather than a round trip after it.
  // `Promise.resolve` because a PostgREST builder is lazy: nothing is sent
  // until something calls `then` on it.
  const previewsP = Promise.resolve(sb.rpc("chat_channel_previews"));
  const { data: mine, error: mineErr } = await sb
    .from("chat_channel_members")
    .select("channel_id, last_read_at")
    .eq("user_id", user.id);
  if (mineErr) throw new Error(`getConversations (membership): ${mineErr.message}`);
  const ids = (mine ?? []).map((m) => m.channel_id as string);
  if (ids.length === 0) {
    await previewsP;
    return [];
  }

  const readAt = new Map<string, string>(
    (mine ?? []).map((m) => [m.channel_id as string, m.last_read_at as string])
  );

  const [channels, members, previews] = await Promise.all([
    sb
      .from("chat_channels")
      .select("id, kind, name, last_message_at")
      .in("id", ids)
      .is("archived_at", null)
      .order("last_message_at", { ascending: false }),
    sb
      .from("chat_channel_members")
      .select("channel_id, user_id, last_read_at")
      .in("channel_id", ids),
    previewsP,
  ]);

  if (channels.error)
    throw new Error(`getConversations (channels): ${channels.error.message}`);
  if (members.error)
    throw new Error(`getConversations (members): ${members.error.message}`);
  if (previews.error)
    throw new Error(`getConversations (previews): ${previews.error.message}`);

  const membersByChannel = new Map<string, string[]>();
  for (const m of (members.data ?? []) as MemberRow[]) {
    const list = membersByChannel.get(m.channel_id) ?? [];
    list.push(m.user_id);
    membersByChannel.set(m.channel_id, list);
  }

  const previewByChannel = new Map<string, PreviewRow>();
  for (const p of (previews.data ?? []) as PreviewRow[]) {
    previewByChannel.set(p.channel_id, p);
  }

  return ((channels.data ?? []) as ChannelRow[]).map((c) => {
    const preview = previewByChannel.get(c.id) ?? null;
    const seenAt = readAt.get(c.id);
    // Unread means someone ELSE said something after my watermark. Your own
    // message is never unread — the insert trigger advances the watermark, and
    // this second clause covers the window before that lands.
    const unread =
      !!preview &&
      preview.sender_id !== user.id &&
      (!seenAt ||
        new Date(preview.created_at).getTime() > new Date(seenAt).getTime());

    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      memberIds: membersByChannel.get(c.id) ?? [],
      unread,
      lastMessageAt: new Date(c.last_message_at).getTime(),
      preview: preview
        ? {
            senderId: preview.sender_id,
            body: preview.body,
            hasAttachment: preview.has_attachment,
          }
        : null,
    } satisfies Conversation;
  });
}

/**
 * Everything the Messages page renders on the server: the panel, the roster the
 * pickers and the sender names come from, and one clock reading.
 *
 * The clock is read here rather than in the page component because reading it
 * during render is impure (`react-hooks/purity`) and because the "Today" /
 * "Yesterday" dividers have to derive from the SAME value on the server render
 * and on hydration, or every date label mismatches.
 */
export async function getMessagesPageData(): Promise<{
  conversations: Conversation[];
  roster: ChatUser[];
  now: number;
}> {
  const [conversations, roster] = await Promise.all([
    getConversations(),
    getOrgRoster(),
  ]);
  return { conversations, roster, now: Date.now() };
}

/**
 * The messages of one conversation, oldest first, capped at the newest
 * {@link MESSAGE_PAGE_SIZE}.
 *
 * The cap is taken from the newest end and then reversed, so opening a
 * long-running conversation shows the recent end of it rather than its first
 * page. RLS does the access check: a non-member's read simply returns nothing.
 */
export async function getChannelMessages(
  channelId: string
): Promise<ChatMessage[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();

  const { data, error } = await sb
    .from("chat_messages")
    .select("id, channel_id, sender_id, body, edited_at, created_at")
    .eq("channel_id", channelId)
    .is("deleted_at", null)
    // `id` is the tiebreak, matching `chat_channel_previews()`: two messages
    // can share a `created_at`, and without a second key their order would
    // differ between reads.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);
  if (error) throw new Error(`getChannelMessages: ${error.message}`);

  const rows = ((data ?? []) as MessageRow[]).reverse();
  if (rows.length === 0) return [];

  const { data: links, error: linkErr } = await sb
    .from("chat_files")
    .select("message_id, file_id, files(name, storage_key)")
    .in(
      "message_id",
      rows.map((r) => r.id)
    );
  if (linkErr)
    throw new Error(`getChannelMessages (attachments): ${linkErr.message}`);

  const attachmentRows = (links ?? []) as unknown as AttachmentRow[];
  const keyByFile = new Map<string, string>();
  for (const a of attachmentRows) {
    if (a.files?.storage_key) keyByFile.set(a.file_id, a.files.storage_key);
  }
  const signed = await signStorageKeys([...new Set(keyByFile.values())]);

  const byMessage = new Map<string, ChatAttachment[]>();
  for (const a of attachmentRows) {
    const list = byMessage.get(a.message_id) ?? [];
    const key = keyByFile.get(a.file_id);
    list.push({
      id: a.file_id,
      name: a.files?.name ?? "file",
      url: key ? (signed.get(key) ?? null) : null,
    });
    byMessage.set(a.message_id, list);
  }

  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    senderId: r.sender_id,
    body: r.body,
    createdAt: new Date(r.created_at).getTime(),
    editedAt: r.edited_at ? new Date(r.edited_at).getTime() : null,
    attachments: byMessage.get(r.id) ?? [],
  }));
}
