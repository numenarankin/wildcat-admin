import "server-only";

/**
 * Facility comment threads — one implementation for every facility type.
 *
 * A comment is the ops team's running note on a facility: free text, attributed
 * to whoever wrote it, newest first. Wells, tanks and gas meters each used to
 * have their own table and their own copy of this code; they now share
 * `facility_comments`, keyed by `(entity_type, entity_id)` — see
 * `2026072900000_facility_comments.sql` for why the polymorphic key won over a
 * fifth and sixth per-entity table.
 *
 * Three facility types have no table of their own and never needed one, because
 * they are rows in a table that already has a thread:
 *   * an SWD / injection well is a `wells` row (`type = 'injection'`),
 *   * an SWD tank is a `tanks` row,
 *   * an SWD meter is a `meters` row.
 * Their pages therefore read the SAME thread as the production page for that
 * facility. That is deliberate: one facility, one conversation.
 *
 * A thread is two levels deep — comments, and replies to a comment — with the
 * depth capped in SQL (`facility_comments_flatten_depth`, migration
 * `2026082000100`), not here. Roots are newest first, matching the rest of the
 * app; replies under a root run oldest first, because a reply chain is read as
 * a conversation rather than scanned as a feed.
 *
 * Author NAMES are denormalized at insert time — the legacy `users` directory is
 * never populated for real auth accounts, so a join would render "Unknown".
 * Author AVATARS are not: a comment is not a snapshot of someone's face, so the
 * picture is resolved from the author's live profile on every read.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { initialsFrom } from "@/lib/wells/wells";
import { getSessionUser } from "@/lib/auth/session";
import { getAvatarUrls, getProfile } from "@/lib/settings/profile";
import { getOrgRoster } from "@/lib/messages/roster";
import { segmentMentions } from "@/lib/comments/mentions";
import type {
  CommentEntityType,
  CommentItem,
  CommentMember,
  CommentUser,
} from "@/lib/comments/types";

export type { CommentEntityType, CommentItem, CommentMember, CommentUser };

type Sb = SupabaseClient;

/**
 * The `currentUser` every facility page hands the thread. Centralized because
 * six pages were each deriving the same display name the same way.
 */
export async function getCommentUser(): Promise<CommentUser> {
  const [user, profile] = await Promise.all([getSessionUser(), getProfile()]);
  const name = profile.name.trim() || user?.email?.split("@")[0] || "You";
  return {
    name,
    initials: initialsFrom(name),
    authId: user?.id ?? null,
    avatarUrl: profile.avatarUrl,
  };
}

/**
 * Who can be @-mentioned: the org's active members, the same roster Messages
 * addresses. Fetched by the composer on demand rather than rendered into every
 * facility page, since most comments name nobody.
 */
export async function listCommentMembers(): Promise<CommentMember[]> {
  const roster = await getOrgRoster();
  return roster.map((m) => ({
    id: m.id,
    name: m.name,
    initials: m.initials,
    avatarUrl: m.avatarUrl,
  }));
}

interface CommentRow {
  id: string;
  body: string;
  created_at: string;
  author_name: string | null;
  author_auth_id: string | null;
  parent_id: string | null;
  deleted_at: string | null;
}

const COMMENT_COLS =
  "id, body, created_at, author_name, author_auth_id, parent_id, deleted_at";

function mapComment(
  r: CommentRow,
  avatars: Map<string, string>,
  likes: Map<string, { count: number; mine: boolean }>
): CommentItem {
  const name = r.author_name ?? "Unknown";
  const like = likes.get(r.id);
  const deleted = Boolean(r.deleted_at);
  return {
    id: r.id,
    author: name,
    initials: initialsFrom(name),
    avatarUrl: (r.author_auth_id && avatars.get(r.author_auth_id)) || null,
    createdAt: r.created_at,
    // A tombstone must not leak the text it is standing in for.
    body: deleted ? "" : r.body,
    authorAuthId: r.author_auth_id,
    parentId: r.parent_id,
    likeCount: like?.count ?? 0,
    likedByMe: like?.mine ?? false,
    ...(deleted ? { deleted: true } : {}),
  };
}

/**
 * One facility's comments as a two-level tree: roots newest first, each with
 * its replies oldest first.
 *
 * Soft-deleted rows normally leave the thread (they stay in the table as an
 * audit trail). The exception is a deleted ROOT that still has live replies: it
 * renders as a tombstone, because dropping it would take a colleague's answers
 * with it, and deleting your own comment must never erase what someone else
 * wrote.
 */
export async function listComments(
  sb: Sb,
  entityType: CommentEntityType,
  entityId: string
): Promise<CommentItem[]> {
  const { data, error } = await sb
    .from("facility_comments")
    .select(COMMENT_COLS)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listComments(${entityType}): ${error.message}`);

  const all = (data ?? []) as CommentRow[];
  const live = all.filter((r) => !r.deleted_at);

  // Which deleted roots have to stay as tombstones: exactly those still holding
  // a live reply. Every other deleted row leaves the thread entirely.
  const parentsOfLive = new Set(
    live.map((r) => r.parent_id).filter((id): id is string => Boolean(id))
  );
  const visible = all.filter(
    (r) => !r.deleted_at || (r.parent_id === null && parentsOfLive.has(r.id))
  );

  const [avatars, likes] = await Promise.all([
    getAvatarUrls(
      visible
        .map((r) => r.author_auth_id)
        .filter((id): id is string => Boolean(id))
    ),
    loadLikes(sb, visible.map((r) => r.id)),
  ]);

  // Highlighting needs the display names a body mentions, and only a body that
  // contains an "@" can mention anyone — so the roster is loaded for the threads
  // that actually use it and skipped for the many that don't.
  const names = visible.some((r) => !r.deleted_at && r.body.includes("@"))
    ? (await listCommentMembers()).map((m) => m.name)
    : [];

  const items = visible.map((r) => {
    const item = mapComment(r, avatars, likes);
    if (names.length > 0 && item.body.includes("@")) {
      const matched = segmentMentions(item.body, names)
        .filter((seg) => seg.mention)
        .map((seg) => seg.text.slice(1));
      if (matched.length > 0) item.mentionNames = [...new Set(matched)];
    }
    return item;
  });
  const byId = new Map(items.map((c) => [c.id, c]));

  const roots: CommentItem[] = [];
  for (const item of items) {
    if (!item.parentId) {
      item.replies = [];
      roots.push(item);
    }
  }
  // The query came back newest first; replies are pushed in reverse so each
  // chain reads oldest to newest under its root. A reply whose parent is not in
  // `visible` (its root was deleted with no other live reply — impossible while
  // this reply is live, but a forged parent_id would do it) is promoted to a
  // root rather than dropped, so nothing a person wrote silently disappears.
  for (const item of [...items].reverse()) {
    if (!item.parentId) continue;
    const parent = byId.get(item.parentId);
    if (parent) parent.replies!.push(item);
    else {
      item.parentId = null;
      item.replies = [];
      roots.push(item);
    }
  }
  // Newest first. The map above already emits roots in that order; the sort is
  // what keeps a promoted orphan from landing at the bottom regardless of age.
  roots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return roots;
}

/** Like counts for a set of comments, plus whether the caller is one of them. */
async function loadLikes(
  sb: Sb,
  commentIds: string[]
): Promise<Map<string, { count: number; mine: boolean }>> {
  const out = new Map<string, { count: number; mine: boolean }>();
  if (commentIds.length === 0) return out;

  // Every like on these comments, not a count query per comment: threads are
  // small and one round trip beats N.
  const { data, error } = await sb
    .from("facility_comment_likes")
    .select("comment_id, user_id")
    .in("comment_id", commentIds);
  if (error) {
    // A like is decoration; a failure here must not take the thread with it.
    console.error("loadLikes", error.message);
    return out;
  }

  const me = (await getSessionUser())?.id ?? null;
  for (const row of (data ?? []) as { comment_id: string; user_id: string }[]) {
    const entry = out.get(row.comment_id) ?? { count: 0, mine: false };
    entry.count += 1;
    if (me && row.user_id === me) entry.mine = true;
    out.set(row.comment_id, entry);
  }
  return out;
}

/**
 * Drop a facility's whole thread. Called when the facility itself is deleted.
 *
 * A polymorphic `entity_id` can carry no foreign key, so `on delete cascade`
 * cannot clean these up the way the old per-entity tables did — the delete path
 * has to do it explicitly. Best-effort: a failed sweep leaves orphan rows, which
 * nothing reads (every read is by entity), so it must not fail the delete.
 * Likes and replies DO cascade, since both point at `facility_comments.id`.
 */
export async function deleteCommentsFor(
  sb: Sb,
  entityType: CommentEntityType,
  entityId: string
): Promise<void> {
  const { error } = await sb
    .from("facility_comments")
    .delete()
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);
  if (error) {
    console.error(
      `deleteCommentsFor(${entityType}:${entityId})`,
      error.message
    );
  }
}

/**
 * The page a facility's thread lives on, for `revalidatePath` after a write.
 *
 * SWD wells / tanks / meters share their production counterpart's thread, so
 * their disposal routes are revalidated too — the same rows render on both.
 */
export function commentPaths(
  entityType: CommentEntityType,
  entityId: string
): string[] {
  switch (entityType) {
    case "well":
      return [`/wells/${entityId}`, `/disposal/wells/${entityId}`];
    case "tank":
      return [
        `/production/tanks/${entityId}`,
        `/disposal/tanks/${entityId}`,
      ];
    case "meter":
      return [
        `/production/meters/${entityId}`,
        `/disposal/meters/${entityId}`,
      ];
    case "battery":
      return [`/production/batteries/${entityId}`];
    case "lease":
      return [`/leases/${entityId}`];
  }
}
