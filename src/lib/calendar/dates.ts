/**
 * Pure date helpers shared by the calendar's server data layer and its client
 * views. Everything works in local time and avoids any "now" lookups so it is
 * safe to call during render on both the server and the client.
 */

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export const WEEKDAYS_SHORT = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Formats a date as an ISO `YYYY-MM-DD` string in local time. */
export function toISO(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses an ISO `YYYY-MM-DD` string into a local-midnight `Date`. */
export function fromISO(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Returns a new date `n` days after `date` (negative `n` goes backward). */
export function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** Returns a new date `n` months after `date`, anchored to the 1st. */
export function addMonths(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}

/** The Sunday that starts the week containing `date`. */
export function startOfWeek(date: Date): Date {
  return addDays(date, -date.getDay());
}

/** The seven dates (Sun–Sat) of the week containing `date`. */
export function weekDays(date: Date): Date[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * The full grid of dates for a month view: complete weeks (Sun–Sat) covering
 * the month, including the leading/trailing days of adjacent months.
 */
export function monthCells(year: number, month: number): Date[] {
  const leading = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const total = Math.ceil((leading + daysInMonth) / 7) * 7;
  return Array.from({ length: total }, (_, i) =>
    new Date(year, month, i - leading + 1)
  );
}

/** Minutes since local midnight for an `HH:MM` string. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Converts a 24-hour `HH:MM` string to a compact 12-hour label, e.g. `7:05a`. */
export function to12Hour(hhmm: string): string {
  if (!hhmm || !hhmm.includes(":")) {
    return hhmm;
  }
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "a" : "p";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12}${suffix}` : `${hour12}:${pad(m)}${suffix}`;
}

/** Label for an hour-of-day (0–23), e.g. `6 AM`, `12 PM`. */
export function hourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}
