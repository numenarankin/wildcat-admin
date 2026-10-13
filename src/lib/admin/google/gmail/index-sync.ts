import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { googleFetch, googleUrl, GoogleApiError } from "@/lib/admin/google/fetch";
import { GMAIL_BASE } from "@/lib/admin/google/gmail/client";
import { decodeEncodedWords, headerValue, parseAddress, splitAddresses } from "@/lib/admin/google/gmail/mime";
import type { GmailMessage } from "@/lib/admin/google/gmail/types";

/**
 * The composer's autofill index (`admin_email_contacts`, `admin_email_subjects`,
 * migration 2026100800200): who the admin has sent to and what subjects
 * they used, from their own Sent mail.
 *
 * Quota: Gmail charges 5 units for messages.list, 20 for messages.get and 2
 * for history.list, against 6,000 a minute per user, with the page's own
 * reads on top. So the first pass takes the Sent folder a page at a time
 * (PAGE messages, about 2,000 units) across visits, remembering where it
 * got to, and once caught up each later sync is one history.list (2 units)
 * plus a get per message sent since.
 *
 * Service role, after the caller's own platform-admin check; `userId` is
 * always the session's.
 */

const PAGE = 100;
const CONCURRENCY = 2;
/** The first pass stops this far back: older contacts are stale anyway. */
const FIRST_PASS_QUERY = "in:sent newer_than:2y";
const HEADERS = ["To", "Cc", "Bcc", "Subject", "Date"];

/** Addresses and subject of one sent message, as the index stores them. */
export interface SentFacts {
  at: number;
  recipients: { email: string; name: string }[];
  subject: string | null;
}

/** Read what the index keeps from a metadata-format message. Pure; tested. */
export function sentFacts(m: GmailMessage): SentFacts {
  const headers = m.payload?.headers;
  const seen = new Set<string>();
  const recipients: SentFacts["recipients"] = [];
  for (const field of ["To", "Cc", "Bcc"]) {
    const value = headerValue(headers, field);
    if (!value) continue;
    for (const raw of splitAddresses(value)) {
      const { name, email } = parseAddress(raw);
      const key = email.toLowerCase();
      if (!key.includes("@") || seen.has(key)) continue;
      seen.add(key);
      recipients.push({ email: key, name: name === email ? "" : name });
    }
  }
  const subjectRaw = headerValue(headers, "Subject");
  const subject = subjectRaw ? decodeEncodedWords(subjectRaw).replace(/\s+/g, " ").trim() : "";
  return {
    at: Number(m.internalDate ?? 0) || Date.now(),
    recipients,
    // Replies and forwards keep their own subject; the prefix is what the
    // composer adds, so the bare subject is what autofill should offer.
    subject: subject ? subject.replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, "").trim() || null : null,
  };
}

interface State {
  history_id: string | null;
  page_token: string | null;
  start_history_id: string | null;
}

async function readState(db: SupabaseClient, userId: string): Promise<State | null> {
  const { data, error } = await db
    .from("admin_email_index_state")
    .select("history_id, page_token, start_history_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`index state: ${error.message}`);
  return (data as State | null) ?? null;
}

/** Fold one sent message's facts into the tables: a use each, latest date wins. */
export async function recordSent(db: SupabaseClient, userId: string, facts: SentFacts): Promise<void> {
  const at = new Date(facts.at).toISOString();
  for (const r of facts.recipients) {
    const { error } = await db.rpc("admin_email_contact_bump", { p_user_id: userId, p_email: r.email, p_name: r.name, p_at: at });
    if (error) throw new Error(`contact bump: ${error.message}`);
  }
  if (facts.subject) {
    const { error } = await db.rpc("admin_email_subject_bump", { p_user_id: userId, p_subject: facts.subject.slice(0, 500), p_at: at });
    if (error) throw new Error(`subject bump: ${error.message}`);
  }
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

async function metadata(userId: string, id: string): Promise<GmailMessage | null> {
  const url = new URL(`${GMAIL_BASE}messages/${id}`);
  url.searchParams.set("format", "metadata");
  for (const h of HEADERS) url.searchParams.append("metadataHeaders", h);
  try {
    return await googleFetch<GmailMessage>(userId, "gmail", url.toString());
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * One step of the sync: a page of the first pass, or the changes since the
 * last sync. Returns how many messages were read. Safe to call often; it
 * does nothing expensive when there is nothing new.
 */
export async function syncSentIndex(userId: string, sb?: SupabaseClient): Promise<number> {
  const db = sb ?? getSupabaseAdmin();
  const state = await readState(db, userId);

  if (!state?.history_id) {
    // First pass, one page per call. The historyId is pinned before the
    // first page so nothing sent during the pass is missed afterwards.
    const pinned = state?.start_history_id ?? (await googleFetch<{ historyId: string }>(userId, "gmail", `${GMAIL_BASE}profile`)).historyId;
    const list = await googleFetch<{ messages?: { id: string }[]; nextPageToken?: string }>(
      userId,
      "gmail",
      googleUrl(`${GMAIL_BASE}messages`, { q: FIRST_PASS_QUERY, maxResults: PAGE, pageToken: state?.page_token ?? undefined })
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    const messages = await mapLimit(ids, CONCURRENCY, (id) => metadata(userId, id));
    for (const m of messages) if (m) await recordSent(db, userId, sentFacts(m));
    const done = !list.nextPageToken;
    const { error } = await db.from("admin_email_index_state").upsert({
      user_id: userId,
      history_id: done ? pinned : null,
      start_history_id: done ? null : pinned,
      page_token: list.nextPageToken ?? null,
      synced_at: new Date().toISOString(),
    });
    if (error) throw new Error(`index state: ${error.message}`);
    return ids.length;
  }

  // Caught up: only what was sent since.
  let history: { history?: { messagesAdded?: { message: { id: string } }[] }[]; historyId?: string; nextPageToken?: string };
  try {
    history = await googleFetch(
      userId,
      "gmail",
      googleUrl(`${GMAIL_BASE}history`, { startHistoryId: state.history_id, labelId: "SENT", historyTypes: "messageAdded", maxResults: 500 })
    );
  } catch (error) {
    // 404: the historyId is too old for Gmail to replay. Start over.
    if (error instanceof GoogleApiError && error.status === 404) {
      await db.from("admin_email_index_state").update({ history_id: null, page_token: null, start_history_id: null }).eq("user_id", userId);
      return 0;
    }
    throw error;
  }
  const ids = [...new Set((history.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((a) => a.message.id)))];
  const messages = await mapLimit(ids, CONCURRENCY, (id) => metadata(userId, id));
  for (const m of messages) if (m) await recordSent(db, userId, sentFacts(m));
  await db
    .from("admin_email_index_state")
    .update({ history_id: history.historyId ?? state.history_id, synced_at: new Date().toISOString() })
    .eq("user_id", userId);
  return ids.length;
}
