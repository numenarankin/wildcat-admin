/**
 * Pure formatting helpers for notes. No server-only / DOM imports, so they run
 * in unit tests and on either side of the client boundary.
 */

import type { NoteSummary, NoteTag } from "@/lib/notes/types";

/** Longest a card snippet runs before it is truncated with an ellipsis. */
const SNIPPET_MAX = 200;

/**
 * Derive a plain-text preview from a note's HTML body. Strips tags, decodes the
 * handful of entities the TipTap editor emits, collapses whitespace, and
 * truncates. Deliberately regex-based (no DOM) so it runs server-side and in
 * `react-server` unit tests — the input is our own editor's output, not
 * arbitrary untrusted HTML being rendered.
 */
export function snippetFromHtml(html: string): string {
  const text = noteTextFromHtml(html);
  if (text.length <= SNIPPET_MAX) return text;
  return `${text.slice(0, SNIPPET_MAX).trimEnd()}…`;
}

/**
 * The same strip, untruncated: a note's body as plain text.
 *
 * Orion reads notes through this rather than raw HTML — the markup is noise it
 * would have to parse, and the tags carry no meaning the prose doesn't.
 */
export function noteTextFromHtml(html: string): string {
  return (html ?? "")
    // Turn block boundaries into spaces so words don't run together.
    .replace(/<\/(p|div|li|h[1-6]|blockquote|br)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Escape the four characters that would otherwise be read as markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Plain text into the paragraph HTML the note editor round-trips.
 *
 * The inverse of {@link noteTextFromHtml}, for the one writer that produces
 * prose rather than editor output: Orion's create_note. Blank lines separate
 * paragraphs; everything is escaped, because this body came from a model and a
 * stray angle bracket must not become markup in a stored note.
 */
export function htmlFromNoteText(text: string): string {
  const paragraphs = (text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return "";
  return paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** HTML metacharacters, escaped so a note body can never inject markup. */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Wrap PLAIN TEXT into the HTML the notes editor round-trips.
 *
 * `notes.content` stores the TipTap editor's `getHTML()`, but a note can also
 * arrive as plain text — from document ingest, or any other non-editor writer.
 * Rendering raw text into that column would show the paragraph breaks collapsed
 * and would let stray `<` in the source text be parsed as markup, so escape
 * first and emit one `<p>` per blank-line-separated block, with single newlines
 * inside a block becoming `<br>`. The inverse of {@link snippetFromHtml}.
 * Empty or whitespace-only input yields "" — the same value `createNote` seeds,
 * which `isEmptyNote` treats as an empty note.
 */
export function htmlFromPlainText(text: string): string {
  const escaped = (text ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  return escaped
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Does a note match a free-text query? Matches on title, snippet, and any tag
 * label, case-insensitively. Empty query matches everything.
 */
export function noteMatchesQuery(note: NoteSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (note.title.toLowerCase().includes(q)) return true;
  if (note.snippet.toLowerCase().includes(q)) return true;
  return note.tags.some((t) => t.label.toLowerCase().includes(q));
}

/** Group tags by kind for display (facilities, then people, then projects). */
export function groupTagsByKind(tags: NoteTag[]): {
  facilities: NoteTag[];
  people: NoteTag[];
  projects: NoteTag[];
} {
  return {
    facilities: tags.filter((t) => t.kind === "facility"),
    people: tags.filter((t) => t.kind === "person"),
    projects: tags.filter((t) => t.kind === "project"),
  };
}
