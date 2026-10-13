import type { Task, TaskStatus } from "@/lib/tasks/tasks";

/**
 * Google Tasks <-> the board's `Task`. Pure, so it is tested directly.
 *
 * Google stores a title, plain-text notes, a due DATE (its API drops any time)
 * and open / completed. Board ids are `<listId>::<taskId>` so every write can
 * name its list without trusting a second field, and `folderId` carries the
 * list id because that is what `TasksBoard` tags new tasks with.
 */

export interface GoogleTaskList {
  id: string;
  title: string;
}

/** Tasks API v1 `Task` resource, the fields read here. */
export interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  status: "needsAction" | "completed";
  /** RFC 3339; only the date part is meaningful. */
  due?: string;
  position?: string;
  parent?: string;
  deleted?: boolean;
  hidden?: boolean;
}

const SEP = "::";

export function boardTaskId(listId: string, taskId: string): string {
  return `${listId}${SEP}${taskId}`;
}

/** The list and task ids in a board id, or null when it is not one of ours. */
export function parseBoardTaskId(id: string): { listId: string; taskId: string } | null {
  const at = id.indexOf(SEP);
  if (at <= 0 || at + SEP.length >= id.length) return null;
  const listId = id.slice(0, at);
  const taskId = id.slice(at + SEP.length);
  // Google ids are URL-safe tokens; anything else is not a Google id.
  const ok = /^[A-Za-z0-9_-]+$/;
  return ok.test(listId) && ok.test(taskId) ? { listId, taskId } : null;
}

export function isGoogleListId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** The board's rich-text description as Google's plain-text notes, one line per block. */
export function htmlToNotes(html: string | undefined): string {
  if (!html) return "";
  return html
    // TipTap wraps each list item's text in a <p>; one line per item, not two.
    .replace(/<\/p>\s*<\/li>/gi, "</li>")
    .replace(/<li[^>]*>\s*<p[^>]*>/gi, "<li>")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|blockquote|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e])
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Google's notes as the editor's HTML: one paragraph per line. */
export function notesToHtml(notes: string | undefined): string | undefined {
  if (!notes || !notes.trim()) return undefined;
  return notes
    .split("\n")
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<p></p>"))
    .join("");
}

export function toBoardTask(listId: string, t: GoogleTask): Task {
  return {
    id: boardTaskId(listId, t.id),
    title: t.title?.trim() || "(untitled)",
    description: notesToHtml(t.notes),
    status: t.status === "completed" ? "done" : "planned",
    // Google has no priority; the board hides it (`hiddenFields`).
    priority: "Medium",
    deadline: t.due ? t.due.slice(0, 10) : undefined,
    folderId: listId,
  };
}

/** Board order: Google's own `position` (what its apps show), parents before their subtasks. */
export function sortGoogleTasks(tasks: GoogleTask[]): GoogleTask[] {
  const byPos = (a: GoogleTask, b: GoogleTask) => (a.position ?? "").localeCompare(b.position ?? "");
  const top = tasks.filter((t) => !t.parent).sort(byPos);
  const children = tasks.filter((t) => t.parent);
  const out: GoogleTask[] = [];
  for (const parent of top) {
    out.push(parent);
    out.push(...children.filter((c) => c.parent === parent.id).sort(byPos));
  }
  // Subtasks whose parent is not in the list still show.
  const placed = new Set(out.map((t) => t.id));
  out.push(...children.filter((c) => !placed.has(c.id)).sort(byPos));
  return out;
}

/** Fields a board write sends to Google. */
export interface GoogleTaskWrite {
  title: string;
  notes: string;
  status: "needsAction" | "completed";
  due: string | null;
  /** Cleared on reopen, or Google keeps the task completed. */
  completed?: null;
}

export function statusToGoogle(status: TaskStatus): "needsAction" | "completed" {
  return status === "done" ? "completed" : "needsAction";
}

export function toGoogleWrite(input: Pick<Task, "title" | "description" | "status" | "deadline">): GoogleTaskWrite {
  const status = statusToGoogle(input.status);
  return {
    title: input.title,
    notes: htmlToNotes(input.description),
    status,
    due: input.deadline ? `${input.deadline}T00:00:00.000Z` : null,
    ...(status === "needsAction" ? { completed: null } : {}),
  };
}
