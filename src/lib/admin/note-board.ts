import type { NoteActions } from "@/components/notes/note-editor";
import {
  createAdminNote,
  deleteAdminNote,
  getAdminNoteById,
  saveAdminNote,
  setAdminNoteTags,
} from "@/lib/admin/note-actions";

/**
 * The note editor's actions on the admin side (`admin_notes`). Every entry is
 * the server action itself, never a wrapper, so the object can also cross from
 * a server component to a client one.
 */
export const ADMIN_NOTE_ACTIONS: NoteActions = {
  createNote: createAdminNote,
  saveNote: saveAdminNote,
  setNoteTags: setAdminNoteTags,
  deleteNote: deleteAdminNote,
  getNoteById: getAdminNoteById,
};
