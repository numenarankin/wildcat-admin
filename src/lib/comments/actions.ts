"use server";

/**
 * Server actions for facility comment threads. One set for every facility type
 * (see `./comments` for why the storage is polymorphic).
 *
 * Authorization is RLS: `facility_comments`' policies gate reads and writes on
 * the same capability as the facility itself (production capabilities for
 * wells / tanks / meters / batteries, `view_leases` / `manage_leases` for
 * leases). These actions use the request-scoped client, so they inherit it —
 * there is no service-role path here to check ownership for.
 */

import { getRequestSupabase } from "@/lib/supabase/request-client";
import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { getProfile } from "@/lib/settings/profile";
import { hasSupabase } from "@/lib/env";
import { resolveMentions } from "@/lib/comments/mentions";
import {
  commentPaths,
  listCommentMembers,
  listComments,
  type CommentEntityType,
  type CommentItem,
  type CommentMember,
} from "@/lib/comments/comments";

/** One facility's comments, newest first, replies nested under their root. */
export async function getComments(
  entityType: CommentEntityType,
  entityId: string
): Promise<CommentItem[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  return listComments(sb, entityType, entityId);
}

/**
 * The org roster, for the composer's `@` picker. Fetched on the first `@`
 * keystroke rather than rendered into every facility page — most comments
 * mention nobody, and the roster is the same list Messages already serves.
 */
export async function getCommentMembers(): Promise<CommentMember[]> {
  if (!hasSupabase()) return [];
  return listCommentMembers();
}

/**
 * Post a comment on a facility, or a reply to one (`parentId`).
 *
 * The author's display name is stamped from the signed-in user's profile
 * (falling back to their email local-part) and their auth id kept as the
 * durable link — the legacy `users` directory is never populated for real
 * accounts, so a join at read time would render "Unknown".
 *
 * Mentions are resolved HERE, against the roster as it stands at the moment of
 * writing, and stored on the row. Re-deriving them at read time would let a
 * later rename redirect (or silently drop) a notification the named person had
 * already earned. The client's picker is a convenience only: a name typed by
 * hand resolves the same way, and a client that claims a mention it did not
 * write gets no say, because the ids are computed server-side from the body.
 *
 * `parentId` is taken on trust only as far as the database allows: a reply to a
 * reply is re-parented to its root and a parent on another facility is dropped,
 * both by trigger (`2026082000100`), so the one-level shape cannot be forged.
 */
export async function addComment(
  entityType: CommentEntityType,
  entityId: string,
  body: string,
  parentId?: string | null
): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) return;
  const sb = await getSupabaseServer();

  const [user, profile, members] = await Promise.all([
    getSessionUser(),
    getProfile(),
    listCommentMembers(),
  ]);
  const authorName =
    profile.name.trim() || user?.email?.split("@")[0] || "Unknown";
  // Nobody is notified for naming themselves; the trigger drops the actor, but
  // keeping it off the row means the stored mention list reads as what it is.
  const mentioned = resolveMentions(trimmed, members).filter(
    (id) => id !== user?.id
  );

  const { error } = await sb.from("facility_comments").insert({
    entity_type: entityType,
    entity_id: entityId,
    body: trimmed,
    author_name: authorName,
    author_auth_id: user?.id ?? null,
    parent_id: parentId ?? null,
    mentioned_user_ids: mentioned,
  });
  if (error) throw new Error(`addComment(${entityType}): ${error.message}`);
  for (const path of commentPaths(entityType, entityId)) revalidatePath(path);
}

/**
 * Like or unlike a comment — one toggle rather than two actions, because the
 * button is one control and the row it writes is a fact about one person
 * ("I liked this"), not a counter to increment.
 *
 * The like's identity is `(comment_id, user_id)`, so an unlike is a delete of
 * the caller's own row and a double-like is the same row twice. RLS restricts
 * writes to `user_id = auth.uid()`, so a forged call cannot like on someone
 * else's behalf; the explicit `user_id` here just keeps the insert honest about
 * whose row it is instead of relying on the column default.
 */
export async function toggleCommentLike(
  entityType: CommentEntityType,
  entityId: string,
  commentId: string,
  liked: boolean
): Promise<void> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  if (!user) throw new Error("toggleCommentLike: not signed in");

  const { error } = liked
    ? await sb
        .from("facility_comment_likes")
        .upsert(
          { comment_id: commentId, user_id: user.id },
          { onConflict: "comment_id,user_id" }
        )
    : await sb
        .from("facility_comment_likes")
        .delete()
        .eq("comment_id", commentId)
        .eq("user_id", user.id);
  if (error) throw new Error(`toggleCommentLike: ${error.message}`);
  for (const path of commentPaths(entityType, entityId)) revalidatePath(path);
}

/**
 * Remove a comment — a soft delete, so the row survives as an audit trail while
 * leaving the thread.
 *
 * Only the author may delete their own comment. RLS already limits writes to
 * users who can manage the facility; this narrows it further, because "can edit
 * this well" should not mean "can erase what a colleague wrote". The author
 * check runs as a predicate on the update so it cannot be bypassed by a forged
 * client call.
 *
 * Replies are NOT deleted with their parent, for the same reason: a deleted
 * comment that still has answers renders as a tombstone (see `listComments`)
 * rather than taking the conversation with it.
 */
export async function deleteComment(
  entityType: CommentEntityType,
  entityId: string,
  commentId: string
): Promise<void> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  if (!user) throw new Error("deleteComment: not signed in");

  const { error } = await sb
    .from("facility_comments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", commentId)
    .eq("author_auth_id", user.id)
    .is("deleted_at", null);
  if (error) throw new Error(`deleteComment: ${error.message}`);
  for (const path of commentPaths(entityType, entityId)) revalidatePath(path);
}
