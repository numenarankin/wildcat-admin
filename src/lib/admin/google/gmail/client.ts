import "server-only";
import { GoogleApiError, googleFetch, googleUrl } from "@/lib/admin/google/fetch";
import {
  cachedAttachment,
  cachedFull,
  cachedMessage,
  cachedSummary,
  rememberAttachment,
  rememberFull,
  rememberSummary,
} from "@/lib/admin/google/gmail/cache";
import {
  decodeEncodedWords,
  decodeHtmlEntities,
  findPart,
  headerValue,
  inlineCidImages,
  parseAddress,
  parseMessagePayload,
  splitAddresses,
} from "@/lib/admin/google/gmail/mime";
import {
  GMAIL_FILTERS,
  GMAIL_NO_SUBJECT,
  type GmailFilter,
  type GmailMessage,
  type GmailMessageView,
  type GmailThread,
  type GmailThreadList,
  type GmailThreadPage,
  type GmailThreadSummary,
  type GmailThreadView,
} from "@/lib/admin/google/gmail/types";

/**
 * Gmail API v1 reads, plus mark read. Every call takes the SESSION's user id
 * (from `guard.ts`). Sending lives in `send.ts`, which Orion's tools never
 * load (`lib/ai/admin/no-send.test.ts`).
 * Plan: docs/plans/google-integration.md section 7.1.
 */

export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
export const GMAIL_PAGE_SIZE = 25;
const CONCURRENCY = 10;

/** The attachment route for one part, which also serves inline images. */
export function attachmentUrl(messageId: string, partId: string): string {
  return `/api/admin/google/gmail/attachment?m=${encodeURIComponent(messageId)}&p=${encodeURIComponent(partId)}`;
}

/** Gmail ids (threads, messages) and part ids: nothing that could leave the path segment. */
export function isGmailId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

export function isPartId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+(\.[0-9]+)*$/.test(value) && value.length <= 64;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function metadataUrl(threadId: string): string {
  const url = new URL(`${GMAIL_BASE}threads/${threadId}`);
  url.searchParams.set("format", "metadata");
  for (const h of ["From", "To", "Subject", "Date"]) url.searchParams.append("metadataHeaders", h);
  return url.toString();
}

function isMine(m: GmailMessage): boolean {
  return m.labelIds?.includes("SENT") ?? false;
}

function subjectOf(messages: GmailMessage[]): string {
  const raw = headerValue(messages[0]?.payload?.headers, "Subject");
  const subject = raw ? decodeEncodedWords(raw).trim() : "";
  return subject || GMAIL_NO_SUBJECT;
}

function firstRecipientName(m: GmailMessage): string {
  const to = headerValue(m.payload?.headers, "To");
  const first = to ? splitAddresses(to)[0] : undefined;
  return first ? parseAddress(first).name : "";
}

/** A `format=metadata` thread to its list row. */
export function summarizeThread(thread: GmailThread): GmailThreadSummary {
  const messages = thread.messages ?? [];
  const last = messages[messages.length - 1];
  const lastFromOther = [...messages].reverse().find((m) => !isMine(m));
  let who: string;
  if (lastFromOther) {
    const from = headerValue(lastFromOther.payload?.headers, "From");
    who = from ? parseAddress(from).name : "";
  } else {
    const name = last ? firstRecipientName(last) : "";
    who = name ? `To: ${name}` : "";
  }
  return {
    id: thread.id,
    who: who || "(unknown)",
    subject: subjectOf(messages),
    snippet: decodeHtmlEntities(last?.snippet ?? thread.snippet ?? ""),
    lastIsMine: last ? isMine(last) : false,
    unread: messages.some((m) => m.labelIds?.includes("UNREAD")),
    starred: messages.some((m) => m.labelIds?.includes("STARRED")),
    lastMessageAt: Math.max(0, ...messages.map((m) => Number(m.internalDate ?? 0))),
    messageCount: messages.length,
  };
}

/**
 * threads.list (10 units), then threads.get?format=metadata (40 units each)
 * ONLY for threads that changed since this server last saw them: each listed
 * thread carries its historyId, and an unchanged one comes from `cache.ts`.
 */
export async function listThreads(
  userId: string,
  opts: { filter: GmailFilter; q?: string; pageToken?: string }
): Promise<GmailThreadPage> {
  const labelId = GMAIL_FILTERS.find((f) => f.id === opts.filter)?.labelId ?? undefined;
  const list = await googleFetch<GmailThreadList>(
    userId,
    "gmail",
    googleUrl(`${GMAIL_BASE}threads`, {
      maxResults: GMAIL_PAGE_SIZE,
      labelIds: labelId,
      q: opts.q?.trim() || undefined,
      pageToken: opts.pageToken || undefined,
    })
  );
  const rows = await mapLimit(list.threads ?? [], CONCURRENCY, async (t) => {
    const hit = cachedSummary(userId, t.id, t.historyId);
    if (hit) return hit;
    const full = cachedFull(userId, t.id, t.historyId);
    if (full && t.historyId) {
      const summary = { ...summarizeThread(full), historyId: t.historyId };
      rememberSummary(userId, t.id, t.historyId, summary);
      return summary;
    }
    try {
      const thread = await googleFetch<GmailThread>(userId, "gmail", metadataUrl(t.id));
      const historyId = thread.historyId ?? t.historyId;
      const summary = { ...summarizeThread(thread), historyId };
      if (historyId) rememberSummary(userId, t.id, historyId, summary);
      return summary;
    } catch (error) {
      // Deleted between the list and the get: drop the row, not the page.
      if (error instanceof GoogleApiError && error.status === 404) return null;
      throw error;
    }
  });
  return {
    threads: rows.filter((r): r is GmailThreadSummary => r !== null),
    nextPageToken: list.nextPageToken ?? null,
  };
}

async function attachmentData(userId: string, messageId: string, attachmentId: string): Promise<string> {
  const res = await googleFetch<{ size: number; data: string }>(
    userId,
    "gmail",
    `${GMAIL_BASE}messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`
  );
  return res.data;
}

/**
 * A message for the reading pane. Inline (cid:) images point at the
 * attachment route rather than being fetched here, so the thread comes back
 * after one Google call and the browser loads the images in parallel.
 */
export function messageView(m: GmailMessage): GmailMessageView {
  const parsed = parseMessagePayload(m.payload);
  let html = parsed.html;
  if (html !== null && parsed.inline.length > 0) {
    const urls = new Map<string, string>();
    // Escaped: the URL goes into the email's HTML as an attribute value.
    for (const img of parsed.inline) urls.set(img.contentId, attachmentUrl(m.id, img.partId).replace(/&/g, "&amp;"));
    html = inlineCidImages(html, urls);
  }
  const headers = m.payload?.headers;
  const fromRaw = headerValue(headers, "From") ?? "";
  const from = parseAddress(fromRaw);
  const to = headerValue(headers, "To");
  const cc = headerValue(headers, "Cc");
  const addresses = (v: string | null) => (v ? splitAddresses(v).map((a) => decodeEncodedWords(a).trim()) : []);
  return {
    id: m.id,
    fromName: from.name,
    fromEmail: from.email,
    to: to ? splitAddresses(to).map((a) => parseAddress(a).name).join(", ") : "",
    toAddresses: addresses(to),
    ccAddresses: addresses(cc),
    replyTo: addresses(headerValue(headers, "Reply-To"))[0] ?? decodeEncodedWords(fromRaw).trim(),
    rfcMessageId: headerValue(headers, "Message-ID") ?? headerValue(headers, "Message-Id"),
    references: headerValue(headers, "References"),
    date: Number(m.internalDate ?? 0),
    mine: isMine(m),
    html,
    text: parsed.text,
    attachments: parsed.attachments.map((a) => ({ messageId: m.id, ...a })),
  };
}

/** threads.get?format=full, every message parsed for its body and attachments. */
export async function getThread(userId: string, threadId: string, historyId?: string): Promise<GmailThreadView> {
  // The list's historyId for this thread: a cached copy at that stamp is current.
  let thread = historyId ? cachedFull(userId, threadId, historyId) : null;
  if (!thread) {
    thread = await googleFetch<GmailThread>(
      userId,
      "gmail",
      googleUrl(`${GMAIL_BASE}threads/${threadId}`, { format: "full" })
    );
    if (thread.historyId) rememberFull(userId, thread, { ...summarizeThread(thread), historyId: thread.historyId });
  }
  const messages = thread.messages ?? [];
  return { id: thread.id, historyId: thread.historyId, subject: subjectOf(messages), messages: messages.map(messageView) };
}

/** The labels the page may add or remove: read state, star, inbox. */
export const THREAD_LABELS = ["UNREAD", "STARRED", "INBOX"] as const;
export type ThreadLabel = (typeof THREAD_LABELS)[number];

/** threads.modify on every message in the thread. */
export async function modifyThreadLabels(
  userId: string,
  threadId: string,
  change: { add?: ThreadLabel[]; remove?: ThreadLabel[] }
): Promise<void> {
  await googleFetch(userId, "gmail", `${GMAIL_BASE}threads/${threadId}/modify`, {
    method: "POST",
    json: { addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] },
  });
}

/** threads.modify removing UNREAD from every message in the thread. */
export async function markThreadRead(userId: string, threadId: string): Promise<void> {
  await modifyThreadLabels(userId, threadId, { remove: ["UNREAD"] });
}

/** threads.trash: to Trash, where Gmail keeps it 30 days. No permanent delete. */
export async function trashThread(userId: string, threadId: string): Promise<void> {
  await googleFetch(userId, "gmail", `${GMAIL_BASE}threads/${threadId}/trash`, { method: "POST" });
}

/**
 * One attachment's bytes, by message and part id. Served from `cache.ts`
 * when seen before (bytes never change). Otherwise the part is found in the
 * cached thread when there is one, else a fresh messages.get; Gmail's
 * attachmentId is not stable between fetches, so a stale one is retried
 * against a fresh message once. Null when there is no such part.
 */
export async function getAttachment(
  userId: string,
  messageId: string,
  partId: string
): Promise<{ filename: string; mimeType: string; bytes: Uint8Array } | null> {
  const hit = cachedAttachment(userId, messageId, partId);
  if (hit) return hit;
  const fresh = () =>
    googleFetch<GmailMessage>(userId, "gmail", googleUrl(`${GMAIL_BASE}messages/${messageId}`, { format: "full" }));
  const read = async (message: GmailMessage) => {
    const part = findPart(message.payload, partId);
    if (!part || part.mimeType.toLowerCase().startsWith("multipart/")) return null;
    const data = part.body?.data ?? (part.body?.attachmentId ? await attachmentData(userId, messageId, part.body.attachmentId) : null);
    if (data === null) return null;
    return {
      filename: part.filename ? decodeEncodedWords(part.filename) : "attachment",
      mimeType: part.mimeType.toLowerCase(),
      bytes: new Uint8Array(Buffer.from(data, "base64url")),
    };
  };
  const known = cachedMessage(userId, messageId);
  let file = null;
  if (known) {
    try {
      file = await read(known);
    } catch (error) {
      if (!(error instanceof GoogleApiError && error.status >= 400 && error.status < 500)) throw error;
      file = await read(await fresh());
    }
  } else {
    file = await read(await fresh());
  }
  if (file) rememberAttachment(userId, messageId, partId, file);
  return file;
}
