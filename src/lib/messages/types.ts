/**
 * Shared messaging types and the pure helpers both sides need.
 *
 * Plain module (no `server-only`): the client components, the server reads, and
 * the actions all import from here, the way `@/lib/support/types` serves the
 * support chat.
 */

export type ChannelKind = "dm" | "channel";

/** A person in the org roster, as the message UI needs them. */
export interface ChatUser {
  /** `auth.users.id` — the id every messaging table keys off. */
  id: string;
  name: string;
  initials: string;
  avatarUrl: string | null;
}

/** A file on a message. `url` is a short-lived signed link. */
export interface ChatAttachment {
  id: string;
  name: string;
  url: string | null;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  senderId: string;
  body: string;
  /** Epoch ms. */
  createdAt: number;
  /** Set on an edit; the client shows nothing for it yet. */
  editedAt: number | null;
  attachments: ChatAttachment[];
}

/**
 * A conversation as the panel needs it: identity, roster, and just enough of
 * the last message to draw the preview line.
 *
 * Messages are NOT part of this. The panel lists every conversation the user is
 * in, and loading every message of each to render one line of preview is the
 * kind of read that is free with four conversations and ruinous with four
 * hundred. The open thread loads its own (`getChannelMessages`).
 */
export interface Conversation {
  id: string;
  kind: ChannelKind;
  name: string | null;
  /** Auth ids of every member, including the viewer. */
  memberIds: string[];
  unread: boolean;
  lastMessageAt: number;
  preview: {
    senderId: string;
    body: string;
    hasAttachment: boolean;
  } | null;
}

/** Two-letter initials for an avatar fallback, matching `initialsFrom`. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * The stable identity of a direct message, and what stops a second thread from
 * being opened with someone you already talk to.
 *
 * Sorted so the key does not depend on who clicked first, and joined with a
 * character that cannot occur in a uuid. Backed by a unique index on
 * `(org_id, dm_key)` — the DB, not this function, is what actually enforces it.
 */
export function dmKey(memberIds: string[]): string {
  return [...new Set(memberIds)].sort().join(":");
}

/**
 * What the panel row and the thread header call a conversation.
 *
 * A DM is titled by the OTHER person, never by a stored name: each side has to
 * see the other, so there is no one string to store. A group uses the name it
 * was given and falls back to its roster until someone names it, which keeps an
 * unnamed group identifiable instead of blank.
 */
export function conversationTitle(
  conversation: Conversation,
  viewerId: string,
  nameOf: (userId: string) => string
): string {
  const others = conversation.memberIds.filter((id) => id !== viewerId);
  if (conversation.kind === "dm") {
    // A DM with nobody else in it is your own note to self; name it for you.
    return others.length > 0 ? nameOf(others[0]) : nameOf(viewerId);
  }
  if (conversation.name?.trim()) return conversation.name.trim();
  if (others.length === 0) return "Empty group";
  return others.map((id) => nameOf(id).split(" ")[0]).join(", ");
}

/**
 * Everyone a message could be addressed to, in `@Name` form.
 *
 * Longest name first so "@Dana Whitaker" is matched before "@Dana": otherwise a
 * full name resolves to the wrong half of itself the moment two people share a
 * first name.
 */
export function findMentions(
  body: string,
  roster: ChatUser[]
): string[] {
  const ordered = [...roster].sort((a, b) => b.name.length - a.name.length);
  const hit = new Set<string>();
  for (const user of ordered) {
    for (const form of mentionForms(user.name)) {
      if (body.toLowerCase().includes(`@${form.toLowerCase()}`)) {
        hit.add(user.id);
        break;
      }
    }
  }
  return [...hit];
}

/** `@Dana Whitaker` and `@Dana` both address Dana. */
export function mentionForms(name: string): string[] {
  const full = name.trim();
  if (!full) return [];
  const first = full.split(/\s+/)[0];
  return first && first !== full ? [full, first] : [full];
}
