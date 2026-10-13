import { hasSupabase } from "@/lib/env";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import type {
  SupportAttachment,
  SupportMessage,
  SupportSenderRole,
  SupportStatus,
  SupportThread,
} from "@/lib/support/types";

const FILES_BUCKET = "files";
const SIGNED_URL_TTL = 60 * 60; // one hour, matches getDownloadUrl

interface ThreadRow {
  id: string;
  subject: string;
  status: SupportStatus;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  user_last_read_at: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  sender_role: SupportSenderRole;
  body: string;
  created_at: string;
}

interface AttachmentRow {
  message_id: string;
  file_id: string;
  files: { name: string | null; storage_key: string | null } | null;
}

/**
 * Mint short-lived signed URLs for a set of file storage keys. The caller has
 * already passed RLS on the owning rows, so the admin client (which reaches the
 * private bucket) is safe here.
 */
async function signStorageKeys(
  keys: string[]
): Promise<Map<string, string>> {
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
 * Assemble message + attachment rows into the client `SupportThread[]` shape,
 * computing the unread flag for the given side. Shared by the user-side loader
 * here and reused (via the same row shapes) on the platform side.
 */
export async function buildThreads(
  threadRows: ThreadRow[],
  messageRows: MessageRow[],
  attachmentRows: AttachmentRow[],
  side: "user" | "staff",
  readAtByThread: Map<string, string | null>
): Promise<SupportThread[]> {
  // Sign every attachment's bytes once.
  const keyByFile = new Map<string, string>();
  for (const a of attachmentRows) {
    if (a.files?.storage_key) keyByFile.set(a.file_id, a.files.storage_key);
  }
  const signed = await signStorageKeys([...new Set(keyByFile.values())]);

  const attachmentsByMessage = new Map<string, SupportAttachment[]>();
  for (const a of attachmentRows) {
    const list = attachmentsByMessage.get(a.message_id) ?? [];
    const key = keyByFile.get(a.file_id);
    list.push({
      id: a.file_id,
      name: a.files?.name ?? "file",
      url: key ? (signed.get(key) ?? null) : null,
    });
    attachmentsByMessage.set(a.message_id, list);
  }

  const messagesByThread = new Map<string, SupportMessage[]>();
  for (const m of messageRows) {
    const list = messagesByThread.get(m.thread_id) ?? [];
    list.push({
      id: m.id,
      threadId: m.thread_id,
      senderRole: m.sender_role,
      body: m.body,
      createdAt: new Date(m.created_at).getTime(),
      attachments: attachmentsByMessage.get(m.id) ?? [],
    });
    messagesByThread.set(m.thread_id, list);
  }

  // The side that unread is measured for is the OPPOSITE sender: a user's
  // unread means the last message came from staff, and vice versa.
  const fromOther: SupportSenderRole = side === "user" ? "staff" : "user";

  return threadRows.map((t) => {
    const messages = messagesByThread.get(t.id) ?? [];
    const last = messages[messages.length - 1];
    const readAt = readAtByThread.get(t.id) ?? null;
    const lastMessageAt = new Date(t.last_message_at).getTime();
    const unread =
      !!last &&
      last.senderRole === fromOther &&
      (readAt === null || lastMessageAt > new Date(readAt).getTime());
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      createdAt: new Date(t.created_at).getTime(),
      updatedAt: new Date(t.updated_at).getTime(),
      lastMessageAt,
      unread,
      messages,
    };
  });
}

/**
 * Load the signed-in user's support threads (with messages + attachments),
 * most-recent-activity first. RLS guarantees a user only ever sees their own.
 */
export async function getSupportThreads(): Promise<SupportThread[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();

  const { data: threads, error: tErr } = await sb
    .from("support_threads")
    .select(
      "id, subject, status, created_at, updated_at, last_message_at, user_last_read_at"
    )
    .order("last_message_at", { ascending: false });
  if (tErr) throw new Error(`getSupportThreads: ${tErr.message}`);
  if (!threads || threads.length === 0) return [];

  const ids = threads.map((t) => t.id);

  const { data: messages, error: mErr } = await sb
    .from("support_messages")
    .select("id, thread_id, sender_role, body, created_at")
    .in("thread_id", ids)
    .order("position", { ascending: true });
  if (mErr) throw new Error(`getSupportThreads (messages): ${mErr.message}`);

  const messageIds = (messages ?? []).map((m) => m.id);
  let attachments: AttachmentRow[] = [];
  if (messageIds.length > 0) {
    const { data: att, error: aErr } = await sb
      .from("support_message_files")
      .select("message_id, file_id, files(name, storage_key)")
      .in("message_id", messageIds);
    if (aErr) throw new Error(`getSupportThreads (attachments): ${aErr.message}`);
    attachments = (att ?? []) as unknown as AttachmentRow[];
  }

  const readAt = new Map<string, string | null>(
    (threads as ThreadRow[]).map((t) => [t.id, t.user_last_read_at])
  );

  return buildThreads(
    threads as ThreadRow[],
    (messages ?? []) as MessageRow[],
    attachments,
    "user",
    readAt
  );
}
