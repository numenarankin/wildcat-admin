"use client";

import { TAG_TYPE_LABEL, type NoteSummary } from "@/lib/notes/types";

/** Relative-ish date label: "today", "yesterday", else a short date. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/**
 * One note in the card grid (Apple-Notes-ish): title, a plain-text preview, the
 * facility/people tags, and the last-touched date. Clicking opens the editor.
 */
export function NoteCard({
  note,
  onOpen,
}: {
  note: NoteSummary;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-44 flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
    >
      <h3 className="line-clamp-1 font-heading text-base font-semibold tracking-tight">
        {note.title || "Untitled"}
      </h3>
      <p className="line-clamp-3 flex-1 text-sm text-muted-foreground">
        {note.snippet || "No content yet."}
      </p>
      {note.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1 overflow-hidden">
          {note.tags.slice(0, 3).map((tag) => (
            <span
              key={`${tag.type}:${tag.id}`}
              className="inline-flex max-w-[10rem] items-center gap-1 truncate rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[0.7rem] font-medium"
              title={`${TAG_TYPE_LABEL[tag.type]}: ${tag.label}`}
            >
              <span className="truncate">{tag.label}</span>
            </span>
          ))}
          {note.tags.length > 3 ? (
            <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[0.7rem] font-medium text-muted-foreground">
              +{note.tags.length - 3}
            </span>
          ) : null}
        </div>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {formatDate(note.updatedAt)}
      </span>
    </button>
  );
}
