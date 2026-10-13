"use server";

/**
 * Server actions for notes. Authorization is RLS: the `notes` / `note_tags`
 * policies gate reads on `view_notes` (or `manage_notes`) and writes on
 * `manage_notes`, so these actions inherit it through the request-scoped client
 * — there is no service-role path here to check ownership for.
 *
 * The data loaders (`getNotes`, `getNotesForTarget`, `getNoteById`,
 * `getTaggableTargets`) are exposed as actions so client surfaces — the tag
 * picker especially — can pull data on demand without every facility page
 * pre-loading the full taggable-target list.
 */

import { getRequestSupabase } from "@/lib/supabase/request-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { getProfile } from "@/lib/settings/profile";
import { hasSupabase } from "@/lib/env";
import {
  getNote,
  getTaggableTargets as loadTaggableTargets,
  listNotes,
  listNotesForTarget,
} from "@/lib/notes/notes";
import {
  TAG_KIND_BY_TYPE,
  type Note,
  type NoteSummary,
  type NoteTag,
  type NoteTagType,
  type TagTarget,
} from "@/lib/notes/types";

/** Replace a note's tag set. Non-exported: shared by create + setNoteTags. */
async function writeTags(
  sb: SupabaseClient,
  noteId: string,
  tags: NoteTag[]
): Promise<void> {
  if (tags.length === 0) return;
  const rows = tags.map((t) => ({
    note_id: noteId,
    target_kind: TAG_KIND_BY_TYPE[t.type],
    target_type: t.type,
    target_id: t.id,
    label: t.label,
  }));
  const { error } = await sb
    .from("note_tags")
    .upsert(rows, { onConflict: "note_id,target_type,target_id" });
  if (error) throw new Error(`writeTags: ${error.message}`);
}

/**
 * Create an empty note, optionally pre-tagged (e.g. from a facility's tab). The
 * caller may supply the `id` so the client can open the editor on it instantly
 * and let this insert settle in the background.
 */
export async function createNote(
  initialTags: NoteTag[] = [],
  id?: string
): Promise<{ id: string }> {
  const sb = await getSupabaseServer();
  const user = await getSessionUser();
  const profile = await getProfile();
  const authorName =
    profile.name.trim() || user?.email?.split("@")[0] || "Unknown";

  const { data, error } = await sb
    .from("notes")
    .insert({
      ...(id ? { id } : {}),
      title: "Untitled",
      content: "",
      author_name: authorName,
      author_auth_id: user?.id ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createNote: ${error.message}`);

  const newId = (data as { id: string }).id;
  if (initialTags.length > 0) await writeTags(sb, newId, initialTags);
  revalidatePath("/notes");
  return { id: newId };
}

/** Save a note's title and/or body. Empty patch is a no-op. */
export async function saveNote(
  id: string,
  patch: { title?: string; content?: string }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.title !== undefined) update.title = patch.title.trim() || "Untitled";
  if (patch.content !== undefined) update.content = patch.content;
  if (Object.keys(update).length === 0) return;

  const sb = await getSupabaseServer();
  const { error } = await sb.from("notes").update(update).eq("id", id);
  if (error) throw new Error(`saveNote: ${error.message}`);
  revalidatePath("/notes");
}

/**
 * Replace a note's tags wholesale. The set is small and edited as a unit, so a
 * clear-then-write is simpler than diffing and stays correct under concurrent
 * edits (last write wins, same as the body).
 */
export async function setNoteTags(id: string, tags: NoteTag[]): Promise<void> {
  const sb = await getSupabaseServer();
  const { error: delErr } = await sb
    .from("note_tags")
    .delete()
    .eq("note_id", id);
  if (delErr) throw new Error(`setNoteTags (clear): ${delErr.message}`);
  await writeTags(sb, id, tags);
  // Touch the note so it sorts to the top and its updated_at reflects the edit.
  await sb.from("notes").update({ updated_at: new Date().toISOString() }).eq("id", id);
  revalidatePath("/notes");
}

/** Soft-delete a note, matching facility_comments — the row stays as an audit trail. */
export async function deleteNote(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`deleteNote: ${error.message}`);
  revalidatePath("/notes");
}

/** Every note in the org (list/card view). */
export async function getNotes(): Promise<NoteSummary[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  return listNotes(sb);
}

/** Notes tagging one facility/person (the facility Notes tab). */
export async function getNotesForTarget(
  type: NoteTagType,
  id: string
): Promise<NoteSummary[]> {
  if (!hasSupabase()) return [];
  const sb = await getRequestSupabase();
  return listNotesForTarget(sb, type, id);
}

/** One note in full, for the editor. */
export async function getNoteById(id: string): Promise<Note | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  return getNote(sb, id);
}

/** The tag picker's candidate list, loaded on demand when a note opens. */
export async function getTaggableTargets(): Promise<TagTarget[]> {
  if (!hasSupabase()) return [];
  return loadTaggableTargets();
}
