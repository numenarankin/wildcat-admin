"use client";

import { PlusIcon, StickyNoteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NoteCard } from "@/components/notes/note-card";
import { NoteModal } from "@/components/notes/note-modal";
import type { NoteActions } from "@/components/notes/note-editor";
import { useFacilityNoteDraft } from "@/lib/notes/use-note-draft";
import { useOptimisticNotes } from "@/lib/notes/use-optimistic-notes";
import type { NoteSummary, NoteTagType } from "@/lib/notes/types";

/**
 * The Notes tab shown on a facility page: a card grid of the notes tagged to
 * this facility. Mirrors how `CommentsThread` mounts per workspace — the notes
 * are server-rendered and passed in; edits refresh the page.
 *
 * Creating a note is NOT a button on this tab. It lives in the workspace's
 * consolidated Add menu, so there is one place to add things rather than a
 * per-list action floating above the content. The workspace owns the draft via
 * {@link useFacilityNoteDraft} and passes it down; the only affordance here is
 * the empty state, where there is no list to compete with.
 *
 * The grid renders `notes` through {@link useOptimisticNotes}: the editor saves
 * on a debounce, so a note written and immediately closed lands AFTER the
 * close-time refresh has already fetched the list. Without the overlay the card
 * simply isn't there and the user reloads the page to find their note.
 */
export function FacilityNotesTab({
  notes,
  canManage = true,
  draft,
  onNewNote,
  onOpenNote,
  onCloseNote,
  actions,
  showTags,
  emptyLabel = "No notes tagged to this facility yet.",
}: {
  targetType?: NoteTagType;
  targetId?: string;
  targetLabel?: string;
  notes: NoteSummary[];
  /** False → read-only (no create); matches the facility's write capability. */
  canManage?: boolean;
  draft: ReturnType<typeof useFacilityNoteDraft>["draft"];
  onNewNote: () => void;
  onOpenNote: (id: string) => void;
  onCloseNote: () => void;
  /** Where notes are saved; the customer notes by default. */
  actions?: NoteActions;
  showTags?: boolean;
  /** The empty state's line. */
  emptyLabel?: string;
}) {
  const { notes: visible, upsert, remove } = useOptimisticNotes(notes);

  return (
    <div className="flex flex-col gap-4">
      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-12 text-center">
          <StickyNoteIcon className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {emptyLabel}
          </p>
          {canManage ? (
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={onNewNote}
            >
              <PlusIcon />
              New note
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onOpen={() => onOpenNote(note.id)}
            />
          ))}
        </div>
      )}

      <NoteModal
        noteId={draft?.id ?? null}
        initialNote={draft?.initialNote}
        onClose={onCloseNote}
        onChanged={upsert}
        onDeleted={remove}
        actions={actions}
        showTags={showTags}
      />
    </div>
  );
}
