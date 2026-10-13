import "server-only";
import type { GmailThread, GmailThreadSummary } from "@/lib/admin/google/gmail/types";

/**
 * What this server already fetched from Gmail, so it never asks twice.
 *
 * Gmail allows 6,000 quota units a minute per user, and a threads.get costs
 * 40. Every thread is stored with its `historyId`, which Gmail bumps on ANY
 * change to the thread (a new message, read/unread, a label). threads.list
 * (10 units) returns each thread's current historyId, so a list refresh
 * re-fetches only the threads that changed; an unchanged inbox costs 10.
 *
 * Per server process, in memory, bounded. Never shared between users.
 */

const MAX_THREADS_PER_USER = 1_000;
const MAX_FULL_PER_USER = 200;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

interface Entry {
  historyId: string;
  summary?: GmailThreadSummary;
  /** The format=full thread, kept for the reading pane and attachments. */
  full?: GmailThread;
}

const threads = new Map<string, Map<string, Entry>>();
const fullCount = new Map<string, number>();

function userMap(userId: string): Map<string, Entry> {
  let m = threads.get(userId);
  if (!m) threads.set(userId, (m = new Map()));
  return m;
}

/** Touch: a Map iterates oldest first, so re-inserting marks it newest. */
function touch(m: Map<string, Entry>, id: string, entry: Entry): void {
  m.delete(id);
  m.set(id, entry);
}

function evict(userId: string, m: Map<string, Entry>): void {
  while (m.size > MAX_THREADS_PER_USER) {
    const [id, e] = m.entries().next().value!;
    if (e.full) fullCount.set(userId, (fullCount.get(userId) ?? 1) - 1);
    m.delete(id);
  }
  // Too many full bodies: drop the oldest bodies, keep their summaries.
  for (const [, e] of m) {
    if ((fullCount.get(userId) ?? 0) <= MAX_FULL_PER_USER) break;
    if (e.full) {
      e.full = undefined;
      fullCount.set(userId, (fullCount.get(userId) ?? 1) - 1);
    }
  }
}

/** A cached summary, if the thread hasn't changed since (same historyId). */
export function cachedSummary(userId: string, id: string, historyId: string | undefined): GmailThreadSummary | null {
  const e = threads.get(userId)?.get(id);
  if (!e || !historyId || e.historyId !== historyId) return null;
  return e.summary ?? null;
}

/** A cached full thread; with `historyId`, only if it matches. */
export function cachedFull(userId: string, id: string, historyId?: string): GmailThread | null {
  const e = threads.get(userId)?.get(id);
  if (!e?.full) return null;
  if (historyId && e.historyId !== historyId) return null;
  return e.full;
}

export function rememberSummary(userId: string, id: string, historyId: string, summary: GmailThreadSummary): void {
  const m = userMap(userId);
  const prev = m.get(id);
  const keepFull = prev?.full && prev.historyId === historyId ? prev.full : undefined;
  if (prev?.full && !keepFull) fullCount.set(userId, (fullCount.get(userId) ?? 1) - 1);
  touch(m, id, { historyId, summary, full: keepFull });
  evict(userId, m);
}

export function rememberFull(userId: string, thread: GmailThread, summary: GmailThreadSummary): void {
  if (!thread.historyId) return;
  const m = userMap(userId);
  const prev = m.get(thread.id);
  if (!prev?.full) fullCount.set(userId, (fullCount.get(userId) ?? 0) + 1);
  touch(m, thread.id, { historyId: thread.historyId, summary, full: thread });
  evict(userId, m);
}

/** Find a message's raw payload in any cached full thread. */
export function cachedMessage(userId: string, messageId: string) {
  for (const e of threads.get(userId)?.values() ?? []) {
    const m = e.full?.messages?.find((x) => x.id === messageId);
    if (m) return m;
  }
  return null;
}

// Attachment bytes: immutable per (message, part), so cached outright.
const attachments = new Map<string, { filename: string; mimeType: string; bytes: Uint8Array }>();
let attachmentBytes = 0;

export function cachedAttachment(userId: string, messageId: string, partId: string) {
  const key = `${userId}:${messageId}:${partId}`;
  const hit = attachments.get(key);
  if (hit) {
    attachments.delete(key);
    attachments.set(key, hit);
  }
  return hit ?? null;
}

export function rememberAttachment(
  userId: string,
  messageId: string,
  partId: string,
  file: { filename: string; mimeType: string; bytes: Uint8Array }
): void {
  if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES / 4) return;
  const key = `${userId}:${messageId}:${partId}`;
  if (attachments.has(key)) return;
  attachments.set(key, file);
  attachmentBytes += file.bytes.byteLength;
  while (attachmentBytes > MAX_ATTACHMENT_BYTES) {
    const [k, v] = attachments.entries().next().value!;
    attachments.delete(k);
    attachmentBytes -= v.bytes.byteLength;
  }
}
