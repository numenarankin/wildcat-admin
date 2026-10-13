/**
 * Compact activity age for list rows: `now`, `7m`, `4h`, `19d`.
 *
 * Deliberately terser than the `date-fns` phrasing used inside a conversation
 * ("9 days ago"). A history row is one right-aligned column against a
 * truncating title, so the age has to stay two or three characters wide or it
 * eats the thing the reader is actually scanning for.
 *
 * Shared by the Orion and Support history panels, and matching the staff
 * support inbox (archon `staff-support-app.tsx`) that both are modelled on, so
 * the same thread cannot read as "4h" on one side and "4 hours ago" on the
 * other.
 */
export function relativeAge(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const min = Math.round(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/**
 * The clock under a message in a transcript.
 *
 * Absolute, not relative, and deliberately different from `relativeAge` above.
 * A history row answers "which of these is recent"; a message answers "when was
 * this said", and "19d" is useless for reading back a decision. The date is
 * dropped for today and the year for this year, so the common case stays short
 * enough to sit under a bubble without competing with it.
 */
export function messageTime(epochMs: number, now = Date.now()): string {
  const d = new Date(epochMs);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (sameDay) return time;
  const sameYear = d.getFullYear() === today.getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}
