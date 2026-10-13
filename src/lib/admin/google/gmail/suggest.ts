/**
 * Autofill for the composer's To/Cc/Bcc and Subject lines: what the admin
 * has typed so far, completed from what they have sent before. Pure; the
 * index comes from `admin_email_contacts` / `admin_email_subjects`.
 */

export interface ContactEntry {
  email: string;
  name: string;
  uses: number;
  /** Epoch ms of the last send to them. */
  lastUsedAt: number;
}

export interface SubjectEntry {
  subject: string;
  uses: number;
  lastUsedAt: number;
}

export interface EmailIndex {
  contacts: ContactEntry[];
  subjects: SubjectEntry[];
}

/** A completion for the field: the text as it should read, and the grey tail to show. */
export interface Completion {
  value: string;
  tail: string;
}

/** Recent and frequent first: a send today outranks ten from last year. */
function score(e: { uses: number; lastUsedAt: number }, now: number): number {
  const days = Math.max(0, (now - e.lastUsedAt) / 86_400_000);
  return Math.log1p(e.uses) * 10 - days / 30;
}

/** `Name <email>` for the field, or the bare address when there is no name. */
export function formatContact(c: Pick<ContactEntry, "email" | "name">): string {
  const name = c.name.trim();
  return name && name.toLowerCase() !== c.email.toLowerCase() ? `${name} <${c.email}>` : c.email;
}

/**
 * The best contact for what is typed after the last comma, or null. A
 * fragment matches the start of the name, of any word in it, or of the
 * address; the completion replaces the fragment with `Name <email>` and a
 * trailing ", " so the next recipient can be typed at once.
 */
export function completeRecipient(field: string, index: ContactEntry[], now = Date.now()): Completion | null {
  const at = field.lastIndexOf(",");
  const head = at < 0 ? "" : field.slice(0, at + 1);
  const fragment = field.slice(at < 0 ? 0 : at + 1);
  const q = fragment.trimStart().toLowerCase();
  if (q.length < 2) return null;
  const lead = fragment.length - fragment.trimStart().length;
  let best: ContactEntry | null = null;
  let bestScore = -Infinity;
  for (const c of index) {
    const name = c.name.toLowerCase();
    const email = c.email.toLowerCase();
    const hit =
      name.startsWith(q) || email.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q)) || formatContact(c).toLowerCase().startsWith(q);
    if (!hit) continue;
    const s = score(c, now);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  if (!best) return null;
  const typed = fragment.slice(lead);
  const full = formatContact(best);
  // What the user typed stays as typed (their case); the tail is what's missing.
  const tail = tailAfter(typed, full) ?? ` (${full})`;
  const value = `${head}${" ".repeat(lead)}${typed}${tail}, `;
  return { value, tail: `${tail}, ` };
}

/**
 * The rest of `full` after the part `typed` matches, case-insensitive. Null
 * when `typed` isn't a prefix of `full` (it matched a later word or the
 * address instead), in which case the caller shows the whole thing.
 */
function tailAfter(typed: string, full: string): string | null {
  return full.toLowerCase().startsWith(typed.toLowerCase()) ? full.slice(typed.length) : null;
}

/** The best past subject starting with what is typed, or null. */
export function completeSubject(typed: string, index: SubjectEntry[], now = Date.now()): Completion | null {
  const q = typed.trimStart().toLowerCase();
  if (q.length < 2) return null;
  let best: SubjectEntry | null = null;
  let bestScore = -Infinity;
  for (const s of index) {
    if (!s.subject.toLowerCase().startsWith(q) || s.subject.length === q.length) continue;
    const sc = score(s, now);
    if (sc > bestScore) {
      best = s;
      bestScore = sc;
    }
  }
  if (!best) return null;
  const tail = best.subject.slice(q.length);
  return { value: `${typed}${tail}`, tail };
}
