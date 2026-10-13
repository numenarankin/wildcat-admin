import type { UIMessage } from "ai";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";

export const NEW_CHAT_TITLE = "New chat";
const MAX_TITLE_LENGTH = 48;

/** A saved Orion conversation. Timestamps are epoch ms for easy sorting. */
export interface Conversation {
  id: string;
  title: string;
  messages: UIMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Derive a short title from the first user text message, if any. */
export function deriveTitle(messages: UIMessage[]): string | null {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null;
  const text = firstUser.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  if (!text) return null;
  return text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`
    : text;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "system" | "user" | "assistant";
  parts: UIMessage["parts"];
  position: number;
  /** Optional: only the listing query selects it. See `getConversations`. */
  created_at?: string;
}

/** Tool-call states that carry a result (and so convert to a `tool_result`). */
const COMPLETE_TOOL_STATES = new Set(["output-available", "output-error"]);

/** True for a tool part that never produced an output — an interrupted stream
 * or a `needsApproval` write the user never resolved. Replayed to the model it
 * becomes a `tool_use` block with no matching `tool_result`, which Anthropic
 * rejects with a 400 ("tool_use ids ... without tool_result blocks"). */
function isDanglingToolPart(part: unknown): boolean {
  const p = part as { type?: unknown; state?: unknown };
  const type = typeof p.type === "string" ? p.type : "";
  const isTool = type === "dynamic-tool" || type.startsWith("tool-");
  return isTool && !COMPLETE_TOOL_STATES.has(p.state as string);
}

/**
 * Rehydrate stored message rows into replayable `UIMessage`s: drop dangling tool
 * calls, and drop any turn left with no content by that strip (e.g. an assistant
 * turn that was only an interrupted tool call). Cleaning at the load boundary
 * keeps resumed conversations replayable without touching what's stored; live
 * approvals are unaffected since they happen in-session, never reloaded here.
 */
export function hydrateStoredMessages(
  rows: {
    id?: string;
    role: "system" | "user" | "assistant";
    parts: UIMessage["parts"] | null;
    created_at?: string;
  }[]
): UIMessage[] {
  const out: UIMessage[] = [];
  for (const m of rows) {
    const parts = (m.parts ?? []).filter((p) => !isDanglingToolPart(p));
    if (parts.length === 0) continue;
    out.push({
      id: m.id ?? crypto.randomUUID(),
      role: m.role,
      parts,
      // When this message was written, carried on the message itself so the
      // transcript can date each turn. `saveMessages` preserves it across the
      // replace-the-thread write, so it is when the message was SAID rather
      // than when the thread was last saved.
      ...(m.created_at ? { metadata: { createdAt: m.created_at } } : {}),
    } as UIMessage);
  }
  return out;
}

/** The timestamp on a message, if it has one. */
export function messageCreatedAt(message: UIMessage): number | null {
  const raw = (message.metadata as { createdAt?: string } | undefined)?.createdAt;
  if (!raw) return null;
  const at = new Date(raw).getTime();
  return Number.isFinite(at) ? at : null;
}

/** Load all conversations (with their messages), most recently updated first. */
/**
 * One conversation with its messages, or null.
 *
 * Separate from `getConversations` on purpose: that one pulls every message row
 * the caller can see and groups them client-side, which is right for the
 * history list and wasteful for an export of a single thread. Both read through
 * the RLS client, so an id belonging to another org simply returns null.
 */
export async function getConversation(
  id: string
): Promise<Conversation | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();

  const { data: conv, error: convErr } = await sb
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (convErr) throw new Error(`getConversation: ${convErr.message}`);
  if (!conv) return null;

  const { data: msgs, error: msgErr } = await sb
    .from("messages")
    .select("id, conversation_id, role, parts, position")
    .eq("conversation_id", id)
    .order("position", { ascending: true });
  if (msgErr) throw new Error(`getConversation: ${msgErr.message}`);

  return {
    id: conv.id,
    title: conv.title,
    createdAt: new Date(conv.created_at).getTime(),
    updatedAt: new Date(conv.updated_at).getTime(),
    messages: hydrateStoredMessages((msgs ?? []) as MessageRow[]),
  };
}

export async function getConversations(): Promise<Conversation[]> {
  if (!hasSupabase()) return [];
  // NOT the request-scoped client: `orion-workspace` (a client component)
  // imports `NEW_CHAT_TITLE` from this module, and the request client pulls
  // `server-only` into the bundle. These reads are this page's alone anyway.
  const sb = await getSupabaseServer();

  // Both in one wave: the messages policy already scopes rows to the caller's
  // own conversations, so the list is not needed to ask for them.
  const [{ data: convs, error: convErr }, { data: msgs, error: msgErr }] = await Promise.all([
    sb
      .from("conversations")
      .select("id, title, created_at, updated_at")
      .order("updated_at", { ascending: false }),
    sb
      .from("messages")
      .select("id, conversation_id, role, parts, position, created_at")
      .order("position", { ascending: true }),
  ]);
  if (convErr) throw new Error(`getConversations: ${convErr.message}`);
  if (!convs || convs.length === 0) return [];
  if (msgErr) throw new Error(`getConversations: ${msgErr.message}`);

  const byConv = new Map<string, MessageRow[]>();
  /** Newest message per conversation. See `updatedAt` below. */
  const lastWrite = new Map<string, number>();
  for (const m of (msgs ?? []) as MessageRow[]) {
    const list = byConv.get(m.conversation_id) ?? [];
    list.push(m);
    byConv.set(m.conversation_id, list);
    const at = m.created_at ? new Date(m.created_at).getTime() : 0;
    if (at > (lastWrite.get(m.conversation_id) ?? 0)) {
      lastWrite.set(m.conversation_id, at);
    }
  }

  return convs
    .map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: new Date(c.created_at).getTime(),
      /*
       * WHEN SOMETHING WAS LAST SAID, not when the row was last written.
       *
       * `conversations.updated_at` moves whenever the row is upserted, which
       * includes saves that carry no new message. A chat created two months ago
       * and merely reopened showed `updated_at` of four minutes ago — so the
       * history panel, which sorts and labels on this, put every conversation
       * the user had CLICKED above the ones they had written in, and reported
       * a two-month-old thread as three minutes old. It reads as history going
       * missing when nothing has been lost at all.
       *
       * The last message's timestamp is the thing a person means by "when was
       * this chat". Falling back to the row keeps a conversation with no
       * messages (a draft) in a sane place rather than at the epoch.
       */
      updatedAt: lastWrite.get(c.id) ?? new Date(c.updated_at).getTime(),
      messages: hydrateStoredMessages(byConv.get(c.id) ?? []),
    }))
    // Re-sorted here: the SQL ordering was on the column we just stopped
    // trusting, so leaving it would keep the panel's order wrong.
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
