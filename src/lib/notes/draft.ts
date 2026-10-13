/**
 * Client-side new-note draft helpers. Pure (no server-only imports) so the
 * workspaces can build a blank, instantly-editable note before its row exists.
 */

import type { Note, NoteTag } from "@/lib/notes/types";

/** What a note surface tracks for the open editor. */
export interface NoteDraft {
  id: string;
  /** A blank seed for a brand-new note (skips the fetch); absent for existing notes. */
  initialNote?: Note;
}

/** A blank note, seeded client-side so a new note opens with no fetch. */
export function blankNote(id: string, tags: NoteTag[] = []): Note {
  return {
    id,
    title: "Untitled",
    content: "",
    tags,
    updatedAt: "",
    createdAt: "",
    author: null,
    authorAuthId: null,
  };
}
