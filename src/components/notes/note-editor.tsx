"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/projects/markdown-editor";
import { TagPicker } from "@/components/notes/tag-picker";
import { snippetFromHtml } from "@/lib/notes/format";
import {
  createNote,
  deleteNote,
  getNoteById,
  saveNote,
  setNoteTags,
} from "@/lib/notes/actions";
import type { Note, NoteSummary, NoteTag } from "@/lib/notes/types";

/**
 * The writes and the load behind the editor. The customer note actions by
 * default; the admin side passes its own table's (`@/lib/admin/note-actions`).
 */
export interface NoteActions {
  createNote: (initialTags?: NoteTag[], id?: string) => Promise<{ id: string }>;
  saveNote: (id: string, patch: { title?: string; content?: string }) => Promise<void>;
  setNoteTags: (id: string, tags: NoteTag[]) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  getNoteById: (id: string) => Promise<Note | null>;
}

const CUSTOMER_NOTE_ACTIONS: NoteActions = {
  createNote,
  saveNote,
  setNoteTags,
  deleteNote,
  getNoteById,
};

type SaveStatus = "idle" | "saving" | "saved";

/** A note is empty (not worth saving) when it has no body text and no real title. */
function isEmptyNote(title: string, contentHtml: string): boolean {
  const bodyEmpty = snippetFromHtml(contentHtml).trim() === "";
  const t = title.trim();
  const titleEmpty = t === "" || t === "Untitled";
  return bodyEmpty && titleEmpty;
}

/**
 * The note editing surface: an editable title and a tag picker over the same
 * TipTap markdown editor the Files feature uses.
 *
 * A NEW note (given `initialNote`) opens instantly with no fetch and no loading,
 * and — crucially — its row is NOT created until the note actually has content
 * (body text or a real title). Open a blank note and close it without typing and
 * nothing is persisted. The row is created lazily on the first content-bearing
 * save, carrying whatever tags are set at that moment. An EXISTING note loads its
 * body once and saves edits normally.
 */
export function NoteEditor({
  noteId,
  initialNote,
  onClose,
  onChanged,
  onDeleted,
  actions = CUSTOMER_NOTE_ACTIONS,
  showTags = true,
}: {
  noteId: string;
  /** A blank/seed note for the new-note flow: seeds state, skips the fetch, and
   * defers row creation until there is content. */
  initialNote?: Note;
  /** Close the surrounding modal. */
  onClose: () => void;
  /**
   * Called after any persisted create/edit with a summary of what was just
   * written, so the list can show it immediately rather than waiting for the
   * server round-trip. Fires from the unmount flush too — the last debounced
   * edit lands after the modal has closed, and that is exactly the case where
   * a plain refresh would miss the note.
   */
  onChanged?: (note: NoteSummary) => void;
  /** Called after a delete lands, so the list can drop the card at once. */
  onDeleted?: (id: string) => void;
  /** Where the note is loaded and saved (see `NoteActions`). */
  actions?: NoteActions;
  /** Show the tag picker. Off where a note's home is fixed (an admin project). */
  showTags?: boolean;
}) {
  const [title, setTitle] = useState(initialNote?.title ?? "Untitled");
  const [content, setContent] = useState(initialNote?.content ?? "");
  const [tags, setTags] = useState<NoteTag[]>(initialNote?.tags ?? []);
  const [loaded, setLoaded] = useState(Boolean(initialNote));
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [deleting, setDeleting] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(initialNote?.content ?? "");
  const titleRef = useRef(initialNote?.title ?? "Untitled");
  const tagsRef = useRef<NoteTag[]>(initialNote?.tags ?? []);
  const changedRef = useRef(onChanged);
  useEffect(() => {
    changedRef.current = onChanged;
  }, [onChanged]);
  // Author isn't editable here; carried through so an optimistic card matches
  // the server row it stands in for.
  const authorRef = useRef<string | null>(initialNote?.author ?? null);

  /**
   * A card-shaped snapshot of what was just saved. Built from the refs (not
   * state) so the unmount flush can still report accurately after the component
   * has been torn down.
   */
  function summarize(): NoteSummary {
    return {
      id: noteId,
      title: titleRef.current || "Untitled",
      snippet: snippetFromHtml(contentRef.current),
      tags: tagsRef.current,
      updatedAt: new Date().toISOString(),
      author: authorRef.current,
    };
  }

  // Whether the note's row exists yet. Existing notes (no seed) already do; new
  // notes create lazily on first content-bearing save.
  const createdRef = useRef(!initialNote);
  // Dedupes concurrent create calls into one insert.
  const createPromiseRef = useRef<Promise<void> | null>(null);

  /** Create the row once (with the current tags), or return the in-flight/done create. */
  function ensureCreated(): Promise<void> {
    if (createdRef.current) return Promise.resolve();
    if (!createPromiseRef.current) {
      createPromiseRef.current = actions.createNote(tagsRef.current, noteId).then(() => {
        createdRef.current = true;
      });
    }
    return createPromiseRef.current;
  }

  useEffect(() => {
    // Seeded new note: nothing to fetch.
    if (initialNote && initialNote.id === noteId) return;

    let active = true;
    setLoaded(false);
    actions.getNoteById(noteId)
      .then((note) => {
        if (!active || !note) {
          if (active) setLoaded(true);
          return;
        }
        setTitle(note.title);
        titleRef.current = note.title;
        setContent(note.content);
        contentRef.current = note.content;
        setTags(note.tags);
        tagsRef.current = note.tags;
        authorRef.current = note.author;
        setLoaded(true);
      })
      .catch((error) => {
        console.error("Failed to load note", error);
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
      // Flush a pending body edit — but never create an empty note on the way out.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const html = contentRef.current;
        if (createdRef.current || !isEmptyNote(titleRef.current, html)) {
          ensureCreated()
            .then(() => actions.saveNote(noteId, { content: html }))
            .then(() => changedRef.current?.(summarize()))
            .catch((error) => console.error("Failed to save note", error));
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  async function persistContent(next: string) {
    // Don't create (or save) a note that still has no content.
    if (!createdRef.current && isEmptyNote(titleRef.current, next)) {
      setStatus("idle");
      return;
    }
    setStatus("saving");
    try {
      await ensureCreated();
      await actions.saveNote(noteId, { content: next });
      setStatus("saved");
      onChanged?.(summarize());
    } catch (error) {
      console.error("Failed to save note", error);
      setStatus("idle");
    }
  }

  function handleContentChange(html: string) {
    contentRef.current = html;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Only signal "saving" when there is actually something to persist.
    if (createdRef.current || !isEmptyNote(titleRef.current, html)) {
      setStatus("saving");
    }
    saveTimer.current = setTimeout(() => persistContent(html), 700);
  }

  async function commitTitle() {
    const trimmed = title.trim() || "Untitled";
    setTitle(trimmed);
    if (trimmed === titleRef.current) return;
    titleRef.current = trimmed;
    // A default/empty title on an as-yet-empty note isn't content.
    if (!createdRef.current && isEmptyNote(trimmed, contentRef.current)) return;
    try {
      setStatus("saving");
      await ensureCreated();
      await actions.saveNote(noteId, { title: trimmed });
      setStatus("saved");
      onChanged?.(summarize());
    } catch (error) {
      console.error("Failed to rename note", error);
      setStatus("idle");
    }
  }

  async function handleTagsChange(next: NoteTag[]) {
    setTags(next);
    tagsRef.current = next;
    // Tags alone don't make a note worth saving; they'll be written when the
    // note first gains content (ensureCreated carries the current tags). Once
    // the row exists, tag edits persist immediately.
    if (!createdRef.current) return;
    try {
      setStatus("saving");
      await actions.setNoteTags(noteId, next);
      setStatus("saved");
      onChanged?.(summarize());
    } catch (error) {
      console.error("Failed to update tags", error);
      setStatus("idle");
    }
  }

  async function handleDelete() {
    if (deleting) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // An empty, never-created note: just close, nothing to delete.
    if (!createdRef.current) {
      onClose();
      return;
    }
    setDeleting(true);
    try {
      await actions.deleteNote(noteId);
      onDeleted?.(noteId);
      onClose();
    } catch (error) {
      console.error("Failed to delete note", error);
      setDeleting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 px-5 pb-3 pt-4">
        <div className="flex items-center gap-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label="Note title"
            placeholder="Untitled"
            className="min-w-0 flex-1 rounded px-1 font-heading text-xl font-semibold tracking-tight outline-none focus:bg-muted/40"
          />
          <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
            {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Delete note"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            disabled={deleting}
            onClick={handleDelete}
          >
            {deleting ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <Trash2Icon />
            )}
          </Button>
        </div>
        {showTags && <TagPicker value={tags} onChange={handleTagsChange} />}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border">
        {loaded ? (
          <MarkdownEditor
            key={noteId}
            fileId={noteId}
            initialContent={content}
            onChange={handleContentChange}
            contentClassName="px-5 py-6"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center py-16">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        )}
      </div>
    </div>
  );
}
