/**
 * Orion's read access to the TEAM's messages — the DMs and group chats on
 * /messages, between people. Not to be confused with `chat-history.ts`, which
 * searches the user's own conversations with Orion.
 *
 * Three things make this different from every other read tool:
 *
 *   1. It is other people's words. RLS already scopes both tables to channels
 *      the signed-in user is a member of, so nothing here can reach a thread
 *      they could not open themselves — but "they could read it" is not "Orion
 *      should quote it", and the system prompt (`TEAM_MESSAGES_GUIDANCE`) draws
 *      that second line: consult it when ASKED, never as background colour.
 *   2. It is switchable. An org that does not want its AI reading the team's
 *      messages turns the Team messages / Read cell off in Settings -> AI ->
 *      Permissions, and the read tools then refuse rather than quietly
 *      returning less. Sending a message is a separate cell and starts OFF.
 *   3. It reuses the conversation ranker (`conversation-search.ts`) rather than
 *      a substring scan, for the reason written up at the top of
 *      `chat-history.ts`: a model writes "Repass 2 recompletion plan" where a
 *      person types "repass 2", and a verbatim scan answers a real discussion
 *      with a confident "never discussed".
 */

import { tool } from "ai";
import { z } from "zod";
import { hasSupabase } from "@/lib/env";
import { isToolAllowed } from "@/lib/ai/tool-permissions";
import { toolPermissions } from "@/lib/ai/tool-permissions-server";
import { getSessionUser } from "@/lib/auth/session";
import { getSupabaseServer } from "@/lib/supabase/server";
import { searchConversationsRelaxed } from "@/lib/ai/conversation-search";
import type { Conversation } from "@/lib/ai/conversations";
import { getOrgRoster } from "@/lib/messages/roster";
import {
  createConversation,
  renameConversation,
  sendMessage,
} from "@/lib/messages/actions";
import { conversationTitle, type ChannelKind } from "@/lib/messages/types";

/** Channels reported per search. The rest are ranked and simply not shown. */
const MAX_CHANNELS_RETURNED = 5;
/** Messages quoted per channel, best first. */
const MAX_SNIPPETS = 3;
const SNIPPET_CHARS = 600;
/** Messages read back by `read_message_thread`, newest end of the thread. */
const TRANSCRIPT_LIMIT = 200;

/** What the org toggle says when it is off. Same words on both tools. */
const DISABLED =
  "Reading the team's messages is switched off for this organization " +
  '(Settings → AI → "Read team messages"). Say so plainly and answer from ' +
  "the company's records instead. Do not guess at what anyone said.";

/** One quoted message, with who said it and when. */
export interface TeamMessageHit {
  channelId: string;
  /** The conversation as the user sees it named: a person, or the group. */
  channel: string;
  sender: string;
  text: string;
  /** ISO date, so the model can weigh a stale remark. */
  sentAt: string;
}

export interface TeamMessageSearchResult {
  hits: TeamMessageHit[];
  /** Terms the search actually required. */
  matchedOn: string[];
  /** Terms dropped to find anything; non-empty means the query was widened. */
  relaxed: string[];
  note?: string;
}

/** A conversation as the ranker needs it, loaded but not yet searched. */
export interface TeamChannel {
  id: string;
  title: string;
  lastMessageAt: number;
  messages: { sender: string; text: string; sentAt: number }[];
}

/**
 * Rank loaded channels against a query and quote the lines that carry it.
 *
 * Pure, and separate from the loading below, because this is the part with the
 * behaviour worth testing: which channel places, which lines get quoted, and
 * what the model is told when the query had to be widened.
 */
export function rankTeamChannels(
  channels: TeamChannel[],
  query: string,
  limit: number,
): TeamMessageSearchResult {
  const empty = { hits: [], matchedOn: [], relaxed: [] };
  if (channels.length === 0) {
    return { ...empty, note: "There are no team conversations to search." };
  }

  // Shaped for the ranker, which reads `title`, `messages` and `updatedAt`.
  // Roles are meaningless here — every line is a person — so they are all
  // "user"; the ranker never looks at them.
  const shaped: Conversation[] = channels.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: c.lastMessageAt,
    updatedAt: c.lastMessageAt,
    messages: c.messages.map((m, i) => ({
      id: `${c.id}-${i}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: m.text }],
    })),
  }));

  const ranked = searchConversationsRelaxed(shaped, query);
  if (ranked.length === 0) {
    return {
      ...empty,
      note:
        `Nothing in ${channels.length} team conversation(s) matches "${query}", ` +
        "even after dropping every term but the rarest. Try the plainest form " +
        "of the subject — a person's or a well's name on its own — before " +
        "telling the user it was never discussed.",
    };
  }

  const byId = new Map(channels.map((c) => [c.id, c]));
  const top = ranked.slice(0, MAX_CHANNELS_RETURNED);
  const hits: TeamMessageHit[] = [];
  for (const { conversation } of top) {
    const channel = byId.get(conversation.id);
    if (!channel) continue;

    // The lines that actually carry the query's terms, best first — not
    // whichever ones the database happened to return first.
    const scored = channel.messages
      .map((m) => ({ ...m, score: snippetScore(m.text, query) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SNIPPETS);

    // A channel can place on its title alone (a DM with the person asked
    // about). Its last message is still the most useful thing to show.
    const chosen = scored.length > 0 ? scored : channel.messages.slice(-1);

    for (const m of chosen) {
      hits.push({
        channelId: channel.id,
        channel: channel.title,
        sender: m.sender,
        text: m.text.slice(0, SNIPPET_CHARS),
        sentAt: new Date(m.sentAt).toISOString().slice(0, 10),
      });
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }

  const first = ranked[0];
  const searched = `Searched all ${channels.length} team conversation(s); ${ranked.length} matched.`;
  return {
    hits,
    matchedOn: first.matchedOn,
    relaxed: first.relaxed,
    note:
      first.relaxed.length > 0
        ? `${searched} No conversation contained every term, so the search was ` +
          `widened: it required ${first.matchedOn.join(", ")} and dropped ` +
          `${first.relaxed.join(", ")}. These are about the subject but may not ` +
          "be about the specific thing you asked for. Read the thread before " +
          "relying on it."
        : ranked.length > top.length
          ? `${searched} The ${top.length} best are here — read one in full for the detail.`
          : searched,
  };
}

/** Coverage of the query's distinct terms, with a bonus for the exact phrase. */
function snippetScore(text: string, query: string): number {
  const hay = text.toLowerCase();
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 2),
    ),
  ];
  let score = terms.filter((t) => hay.includes(t)).length;
  if (score > 0 && hay.includes(query.trim().toLowerCase())) score += 5;
  return score;
}

/**
 * Whether this org lets Orion read the team's messages: the messages/read cell
 * of the tool permissions table, which is where the old "Read team messages"
 * switch moved to (`2026082400500_ai_tool_permissions.sql` carried the setting
 * over). Default ON for an org that has stored nothing.
 *
 * Both message tools still ask, even though a disabled cell already keeps them
 * out of the registry: the tools are reachable from the geology bridge's cached
 * tool set as well, and this is the check that says WHY rather than refusing
 * generically.
 */
export async function teamMessagesEnabled(): Promise<boolean> {
  if (!hasSupabase()) return false;
  return isToolAllowed("search_messages", await toolPermissions());
}

interface MemberRow {
  channel_id: string;
}
interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string | null;
  last_message_at: string;
}
interface MessageRow {
  channel_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

/**
 * Every conversation the signed-in user is IN, with its messages, named the way
 * the /messages panel names it.
 *
 * Membership, not the channel policy, is the scope: `chat_channels` is also
 * readable for public channels nobody has joined, and their messages are not.
 */
async function loadTeamChannels(): Promise<TeamChannel[]> {
  const user = await getSessionUser();
  if (!user) return [];
  const sb = await getSupabaseServer();

  const { data: mine, error: mineErr } = await sb
    .from("chat_channel_members")
    .select("channel_id")
    .eq("user_id", user.id);
  if (mineErr)
    throw new Error(`loadTeamChannels (membership): ${mineErr.message}`);
  const ids = ((mine ?? []) as MemberRow[]).map((m) => m.channel_id);
  if (ids.length === 0) return [];

  const [channels, members, messages, roster] = await Promise.all([
    sb
      .from("chat_channels")
      .select("id, kind, name, last_message_at")
      .in("id", ids)
      .is("archived_at", null),
    sb
      .from("chat_channel_members")
      .select("channel_id, user_id")
      .in("channel_id", ids),
    sb
      .from("chat_messages")
      .select("channel_id, sender_id, body, created_at")
      .in("channel_id", ids)
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    getOrgRoster(),
  ]);
  if (channels.error)
    throw new Error(`loadTeamChannels: ${channels.error.message}`);
  if (members.error)
    throw new Error(`loadTeamChannels (roster): ${members.error.message}`);
  if (messages.error)
    throw new Error(`loadTeamChannels (messages): ${messages.error.message}`);

  const nameOf = (id: string) =>
    roster.find((r) => r.id === id)?.name ??
    (id === user.id ? "You" : "Someone");

  const memberIds = new Map<string, string[]>();
  for (const m of (members.data ?? []) as {
    channel_id: string;
    user_id: string;
  }[]) {
    const list = memberIds.get(m.channel_id) ?? [];
    list.push(m.user_id);
    memberIds.set(m.channel_id, list);
  }

  const byChannel = new Map<string, TeamChannel["messages"]>();
  for (const m of (messages.data ?? []) as MessageRow[]) {
    const body = m.body?.trim();
    if (!body) continue;
    const list = byChannel.get(m.channel_id) ?? [];
    list.push({
      sender: m.sender_id === user.id ? "You" : nameOf(m.sender_id),
      text: body,
      sentAt: new Date(m.created_at).getTime(),
    });
    byChannel.set(m.channel_id, list);
  }

  return ((channels.data ?? []) as ChannelRow[]).map((c) => ({
    id: c.id,
    title: conversationTitle(
      {
        id: c.id,
        kind: c.kind,
        name: c.name,
        memberIds: memberIds.get(c.id) ?? [],
        unread: false,
        lastMessageAt: new Date(c.last_message_at).getTime(),
        preview: null,
      },
      user.id,
      nameOf,
    ),
    lastMessageAt: new Date(c.last_message_at).getTime(),
    messages: byChannel.get(c.id) ?? [],
  }));
}

/** Search the team's messages. Empty when messaging is unavailable or off. */
export async function searchTeamMessages(
  query: string,
  limit = 10,
): Promise<TeamMessageSearchResult> {
  const empty = { hits: [], matchedOn: [], relaxed: [] };
  if (!hasSupabase() || !query.trim()) return empty;
  if (!(await teamMessagesEnabled())) return { ...empty, note: DISABLED };
  return rankTeamChannels(await loadTeamChannels(), query, limit);
}

export interface TeamThread {
  channel: string;
  transcript: string;
}

/**
 * One conversation read back in full, oldest first, capped at the newest
 * {@link TRANSCRIPT_LIMIT} messages — the same end of a long thread the UI
 * opens on. Null when the user is not in that channel: RLS returns nothing, and
 * "nothing" is the right answer to give the model, not an error.
 */
export async function readTeamThread(
  channelId: string,
): Promise<TeamThread | { error: string } | null> {
  if (!hasSupabase()) return null;
  if (!(await teamMessagesEnabled())) return { error: DISABLED };
  const channels = await loadTeamChannels();
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) return null;

  const lines = channel.messages.slice(-TRANSCRIPT_LIMIT);
  return {
    channel: channel.title,
    transcript: lines
      .map(
        (m) =>
          `[${new Date(m.sentAt).toISOString().slice(0, 10)}] ${m.sender}: ${m.text}`,
      )
      .join("\n"),
  };
}

/**
 * The two read tools. Registered alongside every other read tool, but the
 * descriptions carry the same restraint the system prompt states: these are for
 * questions ABOUT what the team said, and for nothing else.
 */
export function teamMessageTools() {
  return {
    search_messages: tool({
      description:
        "Search the TEAM's messages — the direct messages and group chats on the /messages page, between the user and their coworkers. ONLY use this when the user asks what someone SAID, MESSAGED, TEXTED or TOLD them, asks you to find or catch up on a conversation with a person, or otherwise points you at their messages. Never search it for background on a well, a number or a plan — that is what search_chat_history and the company records are for. Ranked keyword search with stemming and oilfield synonyms; use SHORT, DISTINCTIVE queries (a person's name, a well name) because every extra word narrows the match. Scoped by the database to conversations this user is in. Treat what you find as private correspondence and as what someone SAID, never as established fact.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("the subject or person, as few words as possible"),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      execute: async ({ query, limit }) =>
        searchTeamMessages(query, limit ?? 10),
    }),

    read_message_thread: tool({
      description:
        "Read one team conversation in full, by the channelId search_messages returned. Use it when a quoted line looks like it was decided, corrected or answered later in the same thread. Same rule as search_messages: only when the user has asked about their messages.",
      inputSchema: z.object({
        channelId: z
          .string()
          .describe("the conversation id from search_messages"),
      }),
      execute: async ({ channelId }) => ({
        thread: await readTeamThread(channelId),
      }),
    }),

    // --- Writes ------------------------------------------------------------
    // Both are approval-gated, and both cells start OFF (`DEFAULT_OFF` in
    // `tool-permissions.ts`): a message posted under the user's name reaches
    // another person and cannot be recalled, so an org opts into it.

    send_team_message: tool({
      description:
        "Post a message to a team conversation AS THE USER, in their name. Give either a channelId (from search_messages / read_message_thread) to send into an existing conversation, or a person's name to send them a direct message, which opens the DM if there is not one yet. Write the message as the user would say it, not as a report about them; they see the exact text and approve it before it sends. Use it when they ask you to tell, message or let someone know something. Never send on your own initiative, never send a summary of what you were doing, and never quote another person's private message into a different conversation.",
      inputSchema: z.object({
        body: z
          .string()
          .describe("the message text, as the user would send it"),
        channelId: z
          .string()
          .optional()
          .describe("existing conversation id, from search_messages"),
        person: z
          .string()
          .optional()
          .describe("who to DM, by name, when there is no channelId"),
      }),
      needsApproval: true,
      execute: async ({ body, channelId, person }) => {
        const target = await resolveChannel(channelId, person);
        if ("error" in target) return target;
        const sent = await sendMessage(target.channelId, body);
        return { ok: true, channelId: target.channelId, messageId: sent.id };
      },
    }),

    rename_team_conversation: tool({
      description:
        "Rename a GROUP conversation (a direct message cannot be named: its title is the other person). channelId from search_messages. The name is what everyone in it sees, so use the one the user gave you.",
      inputSchema: z.object({
        channelId: z.string().describe("the group conversation's id"),
        name: z.string().describe("the new name, as the user said it"),
      }),
      needsApproval: true,
      execute: async ({ channelId, name }) => {
        await renameConversation(channelId, name);
        return { ok: true, channelId, name };
      },
    }),
  };
}

/**
 * The channel a send is aimed at: the one given, or the DM with the person
 * named.
 *
 * A name is how the user refers to a coworker, so it is resolved here rather
 * than made the model's problem, and an ambiguous one comes back as candidates
 * to ask about instead of a message sent to the wrong Dave.
 */
async function resolveChannel(
  channelId: string | undefined,
  person: string | undefined,
): Promise<{ channelId: string } | { error: string; candidates?: string[] }> {
  if (channelId) return { channelId };
  if (!person) {
    return {
      error: "Give either a channelId or the name of the person to message.",
    };
  }
  const roster = await getOrgRoster();
  const query = person.trim().toLowerCase();
  const exact = roster.filter((u) => (u.name ?? "").toLowerCase() === query);
  const partial = roster.filter((u) =>
    (u.name ?? "").toLowerCase().includes(query),
  );
  const hits = exact.length > 0 ? exact : partial;
  if (hits.length === 0) return { error: `Nobody here is called "${person}".` };
  if (hits.length > 1) {
    return {
      error: `"${person}" matches more than one person. Ask which one.`,
      candidates: hits.map((u) => u.name ?? u.id),
    };
  }
  const { id } = await createConversation([hits[0].id], "");
  return { channelId: id };
}
