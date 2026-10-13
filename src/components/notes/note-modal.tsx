"use client";

import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { NoteEditor, type NoteActions } from "@/components/notes/note-editor";
import type { Note, NoteSummary } from "@/lib/notes/types";

/**
 * Hosts the note editor in the shared swipe-up modal, widened for a document.
 * Used by both the Notes page and every facility's Notes tab — a note opens in
 * place rather than navigating away.
 *
 * A new note is passed `initialNote` (a blank draft) so the modal opens as an
 * instantly-editable input with no loading state; its row is created lazily by
 * the editor once the note actually has content.
 */
export function NoteModal({
  noteId,
  initialNote,
  onClose,
  onChanged,
  onDeleted,
  actions,
  showTags,
}: {
  /** The note to edit, or null when closed. */
  noteId: string | null;
  initialNote?: Note;
  onClose: () => void;
  /** Called after a persisted create/edit, with the saved note, so the list can
   * show it without waiting for a server refresh. */
  onChanged?: (note: NoteSummary) => void;
  /** Called after a delete lands. */
  onDeleted?: (id: string) => void;
  /** Where the note is saved; the customer notes by default. */
  actions?: NoteActions;
  showTags?: boolean;
}) {
  return (
    <SwipeUpModal
      open={noteId !== null}
      onClose={onClose}
      title="Note"
      className="h-[90vh] max-w-7xl"
    >
      {noteId !== null ? (
        <NoteEditor
          noteId={noteId}
          initialNote={initialNote}
          onClose={onClose}
          onChanged={onChanged}
          onDeleted={onDeleted}
          actions={actions}
          showTags={showTags}
        />
      ) : null}
    </SwipeUpModal>
  );
}
