/**
 * When the owner can take an on-site demo (docs/plans/demo-booking.md, "Rules"
 * and "The availability check"). Pure: busy events arrive with their drive
 * times to and from the visitor already worked out.
 */

export const ZONE = "America/Chicago";
export const HOME_ADDRESS = "805 Secretariat Trail, Keller, TX 76248";
export const MEETING_MINUTES = 120;
export const BUFFER_MINUTES = 30;
export const SLOT_STEP_MINUTES = 30;
export const LAST_SLOT_MINUTES = 16 * 60;
export const BOOKING_WINDOW_DAYS = 45;

/** First slot of each weekday (0 = Sunday), in minutes after midnight Central; absent = no demos. */
export const FIRST_SLOT_BY_WEEKDAY: Partial<Record<number, number>> = {
  1: 9 * 60,
  3: 13 * 60 + 30,
  4: 9 * 60,
  5: 9 * 60,
};

const MINUTE = 60_000;

/** A busy stretch on the owner's calendar, in epoch ms. */
export interface Busy {
  start: number;
  end: number;
  /** An all-day event: the whole day is blocked. */
  allDay?: boolean;
  /** Minutes to drive from this event to the visitor; null when there is no road route. */
  toVisitor: number | null;
  /** Minutes to drive from the visitor to this event; null when there is no road route. */
  fromVisitor: number | null;
}

/** Drive times are rounded up to the next 5 minutes. */
export function roundDrive(seconds: number): number {
  return Math.ceil(seconds / 60 / 5) * 5;
}

/** A Central calendar date as `YYYY-MM-DD` (0-based month in, like Date). */
export function dateKey(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m, d));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDaysKey(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return dateKey(y, m - 1, d + n);
}

/** Central's offset from UTC at an instant, in minutes (-300 in CDT, -360 in CST). */
function centralOffset(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((wall - Math.floor(ms / MINUTE) * MINUTE) / MINUTE);
}

/** The instant of a Central wall-clock time: `minutes` after midnight on `date`. */
export function centralInstant(date: string, minutes: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let t = wall - centralOffset(wall) * MINUTE;
  const again = centralOffset(t);
  if (wall - again * MINUTE !== t) t = wall - again * MINUTE;
  return t;
}

/** The Central date an instant falls on. */
export function centralDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return dateKey(get("year"), get("month") - 1, get("day"));
}

/** Every slot start on a date the rules allow, before any calendar check. */
export function candidateSlots(date: string): number[] {
  const first = FIRST_SLOT_BY_WEEKDAY[weekdayOf(date)];
  if (first === undefined) return [];
  const out: number[] = [];
  for (let m = first; m <= LAST_SLOT_MINUTES; m += SLOT_STEP_MINUTES) out.push(centralInstant(date, m));
  return out;
}

/** The slot starts on `date` the owner can reach and leave in time for whatever follows. */
export function openSlots(date: string, busy: readonly Busy[]): number[] {
  const dayStart = centralInstant(date, 0);
  const dayEnd = centralInstant(addDaysKey(date, 1), 0);
  const today = busy.filter((b) => b.start < dayEnd && b.end > dayStart);
  if (today.some((b) => b.allDay)) return [];

  return candidateSlots(date).filter((s) => {
    const e = s + MEETING_MINUTES * MINUTE;
    if (today.some((b) => b.start < e && b.end > s)) return false;

    const before = today.filter((b) => b.end <= s);
    if (before.length) {
      const prev = before.reduce((a, b) => (b.end > a.end ? b : a));
      if (prev.toVisitor === null) return false;
      if (prev.end + (BUFFER_MINUTES + prev.toVisitor) * MINUTE > s) return false;
    }

    const after = today.filter((b) => b.start >= e);
    if (after.length) {
      const next = after.reduce((a, b) => (b.start < a.start ? b : a));
      if (next.fromVisitor === null) return false;
      if (e + (BUFFER_MINUTES + next.fromVisitor) * MINUTE > next.start) return false;
    }
    return true;
  });
}

/** Bookable dates: tomorrow (Central) through the window's end. */
export function bookingDates(now: number): string[] {
  const today = centralDate(now);
  return Array.from({ length: BOOKING_WINDOW_DAYS }, (_, i) => addDaysKey(today, i + 1));
}
