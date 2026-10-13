import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { searchConversationsRelaxed } from "@/lib/ai/conversation-search";
import type { Conversation } from "@/lib/ai/conversations";

/**
 * ## What was wrong with this
 *
 * The search a model reaches for was a raw case-insensitive SUBSTRING scan:
 * `text.toLowerCase().includes(query.toLowerCase())`. The whole query had to
 * appear verbatim and contiguous in one message.
 *
 * A person types "repass 2" and it works. A model writes what a model writes —
 * "Repass 2 recompletion plan" — and it returns nothing, because nobody ever
 * typed those four words in a row. Orion then told the user, twice, that no
 * such discussion existed, when the plan had been worked over several sessions.
 * A confident denial is far worse than a thin answer, and it was indistinguish-
 * able from a real absence.
 *
 * Meanwhile the good search — BM25 with stemming and domain synonyms — was
 * sitting in `conversation-search.ts`, wired only to the history list in the UI.
 * The model got the worse of the two. This now uses the same ranker, with
 * relaxation so a long query degrades to its distinctive terms instead of to
 * nothing.
 *
 * Two other faults fixed with it: the scan stopped at the first 10 matching
 * MESSAGES in whatever order the rows arrived, so it returned an arbitrary ten
 * rather than the best ten; and 50 conversations was a silent horizon with no
 * mention that anything lay beyond it.
 */

export interface ChatHistoryHit {
  conversationId: string;
  title: string;
  role: string;
  text: string;
  /** When this conversation last moved, so the model can weigh stale advice. */
  updatedAt: string;
}

export interface ChatHistoryResult {
  hits: ChatHistoryHit[];
  /** Terms the search actually required. */
  matchedOn: string[];
  /** Terms dropped to find anything; non-empty means the query was widened. */
  relaxed: string[];
  note?: string;
}

interface PartLike {
  type?: string;
  text?: string;
}

function partsToText(parts: PartLike[] | null): string {
  return (parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join(" ");
}

/**
 * Search past conversations for messages matching a query. Lets Orion recall
 * what was discussed in earlier chats ("what did we decide about the SWD
 * permit?"). Simple case-insensitive match over recent history.
 *
 * When `folderId` is given, only this project's conversations are
 * searched — so the project agent recalls its own history, not other projects'
 * or the global chats.
 */
/*
 * EVERY conversation is searched. There is no horizon.
 *
 * It used to read the 50 most recent, which is a silent horizon: a decision
 * made two months and sixty chats ago simply did not exist, and the answer was
 * "we never discussed that" rather than "I only looked at the recent ones".
 * Recency is a terrible proxy for relevance when the question is "what did we
 * decide about the Repass 2" — that is precisely a question about the past.
 *
 * The cost is bounded in practice and the shape is not new: `getConversations`
 * already loads every conversation and every message for the history list. The
 * ranking itself is BM25 over in-memory token arrays, microseconds per
 * conversation with no index to build. If this ever does become the slow part,
 * the fix is a Postgres full-text index, not a smaller window — a window makes
 * the search WRONG, where a slow search is merely slow.
 */

/** Conversations reported per search. The rest are ranked and simply not shown. */
const MAX_CONVERSATIONS_RETURNED = 5;
/** Snippets per conversation, best first. */
const MAX_SNIPPETS = 3;
const SNIPPET_CHARS = 600;

export async function searchChatHistory(
  query: string,
  limit = 10,
  folderId?: string | null
): Promise<ChatHistoryResult> {
  const empty = { hits: [], matchedOn: [], relaxed: [] };
  if (!hasSupabase() || !query.trim()) return empty;
  const sb = await getSupabaseServer();

  let convQuery = sb
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .order("updated_at", { ascending: false });
  if (folderId) convQuery = convQuery.eq("folder_id", folderId);
  const { data: convs } = await convQuery;
  if (!convs || convs.length === 0) {
    return { ...empty, note: "There are no past conversations to search." };
  }

  const { data: msgs } = await sb
    .from("messages")
    .select("conversation_id, role, parts, position")
    .in(
      "conversation_id",
      convs.map((c) => c.id)
    )
    .order("position", { ascending: true });

  const byConv = new Map<string, { role: string; text: string }[]>();
  for (const m of msgs ?? []) {
    const text = partsToText(m.parts as PartLike[] | null).trim();
    if (!text) continue;
    const list = byConv.get(m.conversation_id) ?? [];
    list.push({ role: m.role, text });
    byConv.set(m.conversation_id, list);
  }

  // Shaped for the ranker, which reads `title`, `messages` and `updatedAt`.
  const conversations: Conversation[] = convs.map((c) => ({
    id: c.id,
    title: c.title ?? "chat",
    createdAt: new Date(c.created_at).getTime(),
    updatedAt: new Date(c.updated_at).getTime(),
    messages: (byConv.get(c.id) ?? []).map((m, i) => ({
      id: `${c.id}-${i}`,
      role: m.role as "user" | "assistant",
      parts: [{ type: "text" as const, text: m.text }],
    })),
  }));

  const ranked = searchConversationsRelaxed(conversations, query);
  if (ranked.length === 0) {
    return {
      ...empty,
      note:
        `Nothing in ${conversations.length} past conversation(s) matches "${query}", ` +
        "even after dropping every term but the rarest. This is a real absence, " +
        "not a narrow query — but try the plainest form of the subject (a well " +
        "name on its own) before telling the user it was never discussed.",
    };
  }

  const top = ranked.slice(0, MAX_CONVERSATIONS_RETURNED);
  const hits: ChatHistoryHit[] = [];
  for (const { conversation } of top) {
    // The messages that actually carry the query's terms, best first, rather
    // than whichever ones came back first from the database.
    const scored = conversation.messages
      .map((m) => {
        const text = (m.parts[0] as { text: string }).text;
        return { role: m.role, text, score: snippetScore(text, query) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SNIPPETS);

    // A conversation can rank on its title or on terms spread across messages
    // with no single message carrying them. Its last exchange is still the most
    // useful thing to show.
    const chosen = scored.length > 0 ? scored : conversation.messages.slice(-1).map((m) => ({
      role: m.role,
      text: (m.parts[0] as { text: string }).text,
    }));

    for (const s of chosen) {
      hits.push({
        conversationId: conversation.id,
        title: conversation.title,
        role: s.role,
        text: s.text.slice(0, SNIPPET_CHARS),
        updatedAt: new Date(conversation.updatedAt).toISOString().slice(0, 10),
      });
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }

  const first = ranked[0];
  const searched = `Searched all ${conversations.length} conversation(s); ${ranked.length} matched.`;
  return {
    hits,
    matchedOn: first.matchedOn,
    relaxed: first.relaxed,
    note:
      first.relaxed.length > 0
        ? `${searched} No conversation contained every term, so the search was ` +
          `widened: it required ${first.matchedOn.join(", ")} and dropped ` +
          `${first.relaxed.join(", ")}. These results are about the subject but may ` +
          "not be about the specific thing you asked for. Read one in full before " +
          "relying on it."
        : ranked.length > top.length
          ? `${searched} The ${top.length} best are here — read one in full for the detail.`
          : searched,
  };
}

/**
 * How well one message answers the query.
 *
 * Deliberately simpler than the conversation ranker: this only picks WHICH
 * lines to show from a conversation already chosen, so distinct-term coverage
 * plus a verbatim-phrase bonus is enough, and it cannot reorder the result.
 */
function snippetScore(text: string, query: string): number {
  const hay = text.toLowerCase();
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 2)
    ),
  ];
  let score = terms.filter((t) => hay.includes(t)).length;
  if (score > 0 && hay.includes(query.trim().toLowerCase())) score += 5;
  return score;
}

export interface ConversationTranscript {
  title: string;
  transcript: string;
}

/**
 * Read one past conversation's full transcript (role-labelled), for when the
 * agent needs the verbatim earlier exchange rather than a snippet. Pairs with
 * search_chat_history, which returns the conversation id.
 */
export async function readConversation(
  conversationId: string
): Promise<ConversationTranscript | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();

  const { data: conv } = await sb
    .from("conversations")
    .select("title")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) return null;

  const { data: msgs } = await sb
    .from("messages")
    .select("role, parts, position")
    .eq("conversation_id", conversationId)
    .order("position", { ascending: true });

  const transcript = (msgs ?? [])
    .map((m) => {
      const text = partsToText(m.parts as PartLike[] | null).trim();
      if (!text) return "";
      const who =
        m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
      return `${who}: ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return { title: conv.title, transcript };
}
