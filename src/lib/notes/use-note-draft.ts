"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { blankNote, type NoteDraft } from "@/lib/notes/draft";
import { TAG_KIND_BY_TYPE, type NoteTag, type NoteTagType } from "@/lib/notes/types";

/**
 * Owns the "new note on this facility" draft.
 *
 * Lifted out of `FacilityNotesTab` so a workspace's consolidated Add menu can
 * open a note, rather than the tab carrying its own floating New-note button
 * above the list. A per-list action button is a second, competing place to
 * create things; the header Add menu is the one place.
 */
export function useFacilityNoteDraft({
  targetType,
  targetId,
  targetLabel,
}: {
  targetType: NoteTagType;
  targetId: string;
  /** The facility's display name, snapshotted onto a pre-created tag. */
  targetLabel: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<NoteDraft | null>(null);

  const openNew = useCallback(() => {
    // A blank note pre-tagged to this facility — no fetch, no server call. The
    // row is created lazily by the editor once the note has content (the seed
    // tag rides along with that first create).
    const id = crypto.randomUUID();
    const tag: NoteTag = {
      type: targetType,
      id: targetId,
      label: targetLabel,
      kind: TAG_KIND_BY_TYPE[targetType],
    };
    setDraft({ id, initialNote: blankNote(id, [tag]) });
  }, [targetType, targetId, targetLabel]);

  const openExisting = useCallback((id: string) => setDraft({ id }), []);

  const close = useCallback(() => {
    setDraft(null);
    router.refresh();
  }, [router]);

  return { draft, openNew, openExisting, close };
}
