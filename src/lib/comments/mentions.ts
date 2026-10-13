/**
 * @mention parsing for comment threads.
 *
 * A mention is stored as plain text — `@Jane Doe` sits in the body like any
 * other words — and resolved against the org roster. There is no markup and no
 * id embedded in the prose, for two reasons: the body has to stay readable
 * anywhere it is echoed (notification emails, the bell, a CSV export), and a
 * person who types a colleague's name without using the picker should be
 * understood just the same.
 *
 * The cost is that matching is by display name, so two members with the SAME
 * name are ambiguous. {@link resolveMentions} notifies both — being told you
 * might have been meant beats silently telling neither.
 *
 * Plain module (no `server-only`): the composer highlights mentions with the
 * same matcher the server resolves them with, so the two cannot disagree about
 * what counts as a mention.
 */

import type { CommentMember } from "@/lib/comments/types";

/** A run of body text, flagged as a mention or as ordinary prose. */
export interface MentionSegment {
  text: string;
  /** True when this run is an `@Name` that matched a member. */
  mention: boolean;
}

/**
 * Longest name first, so `@Jane Doe` matches the full name rather than
 * stopping at a colleague who happens to be called `Jane`.
 */
function byLengthDesc(names: string[]): string[] {
  return [...names].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * The character before an `@` must not be part of a word, or an email address
 * (`ops@example.com`) would read as a mention of a member called "example".
 */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s(\[{<"'—-]/.test(char);
}

/**
 * A matched name must end at a word boundary too, so `@Jan` does not match
 * inside `@January`.
 */
function endsCleanly(body: string, end: number): boolean {
  const next = body[end];
  return next === undefined || !/[A-Za-z0-9_]/.test(next);
}

/**
 * Walk the body once, reporting every `@Name` that matches one of `names`.
 * Both the highlighter and the resolver run off this, so they agree by
 * construction.
 */
function scan(
  body: string,
  names: string[]
): Array<{ start: number; end: number; name: string }> {
  const ordered = byLengthDesc(names.filter((n) => n.trim().length > 0));
  const hits: Array<{ start: number; end: number; name: string }> = [];
  const lower = body.toLowerCase();

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "@" || !isBoundary(body[i - 1])) continue;
    for (const name of ordered) {
      const end = i + 1 + name.length;
      if (
        lower.startsWith(name.toLowerCase(), i + 1) &&
        endsCleanly(body, end)
      ) {
        hits.push({ start: i, end, name });
        i = end - 1; // Resume after the mention, never inside it.
        break;
      }
    }
  }
  return hits;
}

/**
 * The auth ids a body mentions, deduped. Called by `addComment` at write time
 * and stored on the row: the roster changes, and a rename must not redirect a
 * notification that was already earned by the person named at the time.
 */
export function resolveMentions(
  body: string,
  members: readonly CommentMember[]
): string[] {
  const byName = new Map<string, string[]>();
  for (const m of members) {
    const key = m.name.trim().toLowerCase();
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), m.id]);
  }

  const ids = new Set<string>();
  for (const hit of scan(body, [...byName.keys()])) {
    for (const id of byName.get(hit.name.toLowerCase()) ?? []) ids.add(id);
  }
  return [...ids];
}

/**
 * Split a body into runs for rendering, so the composer and the thread can
 * tint mentions without building HTML from user text.
 */
export function segmentMentions(
  body: string,
  /**
   * The display names to tint. The thread passes the names the server already
   * matched when the comment was written (`CommentItem.mentionNames`), so
   * rendering a thread never has to load the roster.
   */
  names: readonly string[]
): MentionSegment[] {
  const hits = scan(body, names.map((n) => n.trim()).filter(Boolean));
  if (hits.length === 0) return [{ text: body, mention: false }];

  const out: MentionSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor)
      out.push({ text: body.slice(cursor, hit.start), mention: false });
    out.push({ text: body.slice(hit.start, hit.end), mention: true });
    cursor = hit.end;
  }
  if (cursor < body.length) out.push({ text: body.slice(cursor), mention: false });
  return out;
}

/**
 * The in-progress `@query` the caret sits in, or null when the caret is not in
 * one. Drives the picker: it opens on `@`, filters as the user types, and
 * closes as soon as the token stops looking like a name being typed.
 */
export function mentionQueryAt(
  body: string,
  caret: number
): { query: string; start: number } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const char = body[i];
    if (char === "@") {
      if (!isBoundary(body[i - 1])) return null;
      return { query: body.slice(i + 1, caret), start: i };
    }
    // A name is at most two words; a newline or a third space means the user
    // has moved on and the picker should be gone.
    if (char === "\n") return null;
    if (caret - i > 40) return null;
  }
  return null;
}
