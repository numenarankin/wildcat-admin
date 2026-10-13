/**
 * Slack's payloads mapped to what /admin/slack draws. Pure, so every rule has
 * a hand oracle (`map.test.ts`); the calls are in `client.ts`.
 */

export type SlackConversationKind = "channel" | "private" | "dm" | "group";

export interface SlackConversation {
  id: string;
  kind: SlackConversationKind;
  /** Channel name without the "#"; null for a DM. */
  name: string | null;
  /** A DM's other person. */
  dmUserId: string | null;
  /** A group DM's members' handles, parsed from Slack's `mpdm-a--b--c-1` name. */
  groupHandles: string[];
}

export interface SlackPerson {
  id: string;
  /** Handle (`name`), what a group DM's name is built from. */
  handle: string;
  /** Display name, else real name, else handle. */
  name: string;
  avatarUrl: string | null;
  initials: string;
  isBot: boolean;
  deleted: boolean;
}

export interface SlackFile {
  name: string;
  url: string | null;
}

export interface SlackMessage {
  /** Slack's id for a message within its conversation. */
  ts: string;
  /** Epoch ms, from `ts`. */
  at: number;
  /** Null for a bot or integration message. */
  userId: string | null;
  /** A bot or integration's name, when it has no user. */
  botName: string | null;
  /** Slack's text, still in its markup; `slackTextParts` reads it. */
  text: string;
  /** Set on a thread's parent and its replies. */
  threadTs: string | null;
  replyCount: number;
  files: SlackFile[];
  subtype: string | null;
  edited: boolean;
}

/** The fields of `users.conversations` read here. */
export interface RawSlackConversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  user?: string;
}

export interface RawSlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string; image_48?: string; image_72?: string };
}

export interface RawSlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  edited?: unknown;
  files?: { name?: string; title?: string; permalink?: string }[];
}

/** `mpdm-alice--bob--carol-1` → alice, bob, carol. */
export function groupHandles(name: string): string[] {
  const m = name.match(/^mpdm-(.*)-\d+$/);
  return m ? m[1].split("--").filter(Boolean) : [];
}

export function toSlackConversation(c: RawSlackConversation): SlackConversation {
  const kind: SlackConversationKind = c.is_im ? "dm" : c.is_mpim ? "group" : c.is_private ? "private" : "channel";
  return {
    id: c.id,
    kind,
    name: kind === "dm" ? null : (c.name ?? null),
    dmUserId: kind === "dm" ? (c.user ?? null) : null,
    groupHandles: kind === "group" && c.name ? groupHandles(c.name) : [],
  };
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function toSlackPerson(u: RawSlackUser): SlackPerson {
  const handle = u.name ?? u.id;
  const name = u.profile?.display_name || u.profile?.real_name || u.real_name || handle;
  return {
    id: u.id,
    handle,
    name,
    avatarUrl: u.profile?.image_72 ?? u.profile?.image_48 ?? null,
    initials: initialsOf(name),
    isBot: Boolean(u.is_bot),
    deleted: Boolean(u.deleted),
  };
}

/** `"1727800000.000100"` → epoch ms. */
export const tsToMs = (ts: string) => Math.round(Number(ts) * 1000);

export function toSlackMessage(m: RawSlackMessage): SlackMessage {
  return {
    ts: m.ts,
    at: tsToMs(m.ts),
    userId: m.user ?? null,
    botName: m.user ? null : (m.bot_profile?.name ?? m.username ?? null),
    text: m.text ?? "",
    threadTs: m.thread_ts ?? null,
    replyCount: m.reply_count ?? 0,
    files: (m.files ?? []).map((f) => ({ name: f.title || f.name || "file", url: f.permalink ?? null })),
    subtype: m.subtype ?? null,
    edited: Boolean(m.edited),
  };
}

/**
 * Fold a re-read page into what is on screen: one row per `ts`, the fresh copy
 * winning (an edit or a new reply count), oldest first. Older pages already
 * loaded stay.
 */
export function mergeSlackMessages(prev: SlackMessage[], fresh: SlackMessage[]): SlackMessage[] {
  const byTs = new Map(prev.map((m) => [m.ts, m]));
  for (const m of fresh) byTs.set(m.ts, m);
  return [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** A conversation's title, with people resolved through the member list. */
export function conversationTitle(c: SlackConversation, people: Map<string, SlackPerson>, byHandle: Map<string, SlackPerson>): string {
  if (c.kind === "dm") return (c.dmUserId && people.get(c.dmUserId)?.name) || "Direct message";
  if (c.kind === "group") {
    const names = c.groupHandles.map((h) => byHandle.get(h)?.name ?? h);
    return names.length ? names.join(", ") : (c.name ?? "Group");
  }
  return `#${c.name ?? c.id}`;
}

/** Channels first (alphabetical), then DMs and group DMs (by title). Deactivated people's DMs drop out. */
export function sortConversations(
  list: SlackConversation[],
  people: Map<string, SlackPerson>,
  byHandle: Map<string, SlackPerson>
): SlackConversation[] {
  const isChannel = (c: SlackConversation) => c.kind === "channel" || c.kind === "private";
  return list
    .filter((c) => !(c.kind === "dm" && c.dmUserId && people.get(c.dmUserId)?.deleted))
    .sort((a, b) => {
      if (isChannel(a) !== isChannel(b)) return isChannel(a) ? -1 : 1;
      return conversationTitle(a, people, byHandle).localeCompare(conversationTitle(b, people, byHandle));
    });
}

// --- Slack's message markup -------------------------------------------------

export type SlackTextPart =
  | { kind: "text"; text: string }
  | { kind: "user"; id: string; label: string | null }
  | { kind: "channel"; id: string; label: string | null }
  | { kind: "link"; url: string; label: string }
  | { kind: "broadcast"; label: string };

/** Slack escapes exactly three characters; `&amp;` is undone last. */
export function unescapeSlack(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** For text going TO Slack: `&` first, so the other two are not escaped twice. */
export function escapeSlackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Slack's `<...>` controls split out of plain text: `<@U1>` a person, `<#C1|name>`
 * a channel, `<!here>` a broadcast, `<!subteam^S1|@team>` a group, `<!date^…|fallback>`
 * its fallback text, anything else a link (`<url|label>`).
 * https://docs.slack.dev/messaging/formatting-message-text
 */
export function slackTextParts(text: string): SlackTextPart[] {
  const parts: SlackTextPart[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last?.kind === "text") last.text += t;
    else parts.push({ kind: "text", text: t });
  };
  let at = 0;
  for (const m of text.matchAll(/<([^<>]+)>/g)) {
    pushText(unescapeSlack(text.slice(at, m.index)));
    at = m.index + m[0].length;
    const [target, label] = splitLabel(m[1]);
    if (target.startsWith("@")) parts.push({ kind: "user", id: target.slice(1), label });
    else if (target.startsWith("#")) parts.push({ kind: "channel", id: target.slice(1), label });
    else if (target.startsWith("!subteam^")) parts.push({ kind: "broadcast", label: label ?? "@group" });
    else if (target.startsWith("!date^")) pushText(label ?? "");
    else if (target.startsWith("!")) parts.push({ kind: "broadcast", label: `@${target.slice(1)}` });
    else parts.push({ kind: "link", url: target, label: label ?? target.replace(/^mailto:/, "") });
  }
  pushText(unescapeSlack(text.slice(at)));
  return parts;
}

function splitLabel(inner: string): [string, string | null] {
  const bar = inner.indexOf("|");
  if (bar < 0) return [unescapeSlack(inner), null];
  return [unescapeSlack(inner.slice(0, bar)), unescapeSlack(inner.slice(bar + 1))];
}
