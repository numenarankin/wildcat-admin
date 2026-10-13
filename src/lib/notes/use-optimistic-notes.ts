"use client";

import { useCallback, useMemo, useState } from "react";
import type { NoteSummary } from "@/lib/notes/types";

/**
 * Keeps a note list in sync with the editor WITHOUT waiting for the server.
 *
 * The problem this solves: the editor saves on a 700ms debounce and creates a
 * brand-new note's row lazily, so closing the modal fires `router.refresh()`
 * while the write is still in flight. The refresh returns the list as it was a
 * moment ago — the note the user just wrote is missing, and it looks like the
 * save failed. They reload the page and it's there.
 *
 * So the editor reports each persisted change here and the list renders the
 * merged view immediately. The overlay is additive only: whenever the server
 * list contains an id, the SERVER row wins and the optimistic copy is ignored.
 * That way a refresh always returns authority to the database and there is no
 * way for a stale optimistic snapshot to shadow real data.
 *
 * @param notes the server-rendered list (the RSC prop)
 */
export function useOptimisticNotes(notes: NoteSummary[]) {
  const [added, setAdded] = useState<NoteSummary[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);

  /** Editor persisted a create/edit — show it now, before the refresh lands. */
  const upsert = useCallback((note: NoteSummary) => {
    setAdded((prev) => [note, ...prev.filter((n) => n.id !== note.id)]);
    setRemoved((prev) => prev.filter((id) => id !== note.id));
  }, []);

  /** Editor deleted a note — drop it now, even if the server list still has it. */
  const remove = useCallback((id: string) => {
    setAdded((prev) => prev.filter((n) => n.id !== id));
    setRemoved((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const merged = useMemo(() => {
    const serverIds = new Set(notes.map((n) => n.id));
    const gone = new Set(removed);
    // Optimistic rows are only for notes the server hasn't caught up on yet.
    const pending = added.filter((n) => !serverIds.has(n.id) && !gone.has(n.id));
    if (pending.length === 0 && gone.size === 0) return notes;
    return [...pending, ...notes.filter((n) => !gone.has(n.id))].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }, [notes, added, removed]);

  return { notes: merged, upsert, remove };
}
