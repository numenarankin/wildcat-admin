/**
 * Shared comment shapes. Plain module (no `server-only`): imported by the client
 * thread component as well as the server data layer, so it must stay free of
 * server-only imports.
 */

/** Which facility a thread hangs off. Mirrors the SQL check constraint. */
export type CommentEntityType =
  | "well"
  | "tank"
  | "meter"
  | "battery"
  | "lease";

/** The signed-in user as the thread renders them: avatar, byline, delete rights. */
export interface CommentUser {
  name: string;
  initials: string;
  /** Auth id — the thread offers Delete only on rows this id authored. */
  authId: string | null;
  /** Signed avatar URL, or null to fall back to initials. */
  avatarUrl: string | null;
}

/**
 * Someone who can be @-mentioned: the org's active members. Fetched on demand
 * by the composer (the first `@` keystroke), not passed down from the page, so
 * a thread can be dropped onto a facility page without threading a roster
 * through it.
 */
export interface CommentMember {
  /** Auth user id — what a resolved mention stores. */
  id: string;
  name: string;
  initials: string;
  avatarUrl: string | null;
}

/** A single comment, as rendered by the shared thread. */
export interface CommentItem {
  id: string;
  author: string;
  /** Author initials, for the avatar fallback. */
  initials: string;
  /**
   * The author's current avatar, resolved from their profile at read time. Not
   * stored on the comment: a comment is not a snapshot of someone's face, and a
   * changed profile picture should update everywhere at once.
   */
  avatarUrl: string | null;
  /** Creation time as an ISO timestamp. */
  createdAt: string;
  body: string;
  /**
   * The author's auth id, or null for pre-auth rows. The thread compares it
   * against the signed-in user to decide whether to offer Delete.
   */
  authorAuthId?: string | null;
  /** The comment this one answers, or null for a top-level comment. */
  parentId?: string | null;
  /** Replies to this comment, oldest first. Empty on a reply (one level only). */
  replies?: CommentItem[];
  /**
   * The display names this comment @-mentions, matched server-side. The thread
   * tints exactly these, so highlighting costs no roster fetch in the browser
   * and can never disagree with who was actually notified.
   */
  mentionNames?: string[];
  /** How many people have liked this comment. */
  likeCount: number;
  /** Whether the signed-in user is one of them. */
  likedByMe: boolean;
  /**
   * A deleted comment that still has replies renders as a tombstone rather than
   * vanishing — dropping it would take a colleague's answers with it, and
   * deleting your own comment must never erase what someone else wrote.
   */
  deleted?: boolean;
}
