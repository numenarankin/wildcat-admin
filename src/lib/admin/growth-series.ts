/**
 * The admin dashboard's growth figures, derived from the customer list.
 * Pure, so the numbers can be checked against hand-counted fixtures.
 */

export interface MonthPoint {
  /** `YYYY-MM`, UTC. */
  month: string;
  value: number;
}

const DAY_MS = 86_400_000;

/** How many of `dates` fall within the last `days` days of `now` (inclusive of now). */
export function countSince(dates: string[], days: number, now: Date): number {
  const floor = now.getTime() - days * DAY_MS;
  return dates.filter((d) => {
    const t = new Date(d).getTime();
    return t >= floor && t <= now.getTime();
  }).length;
}

const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/**
 * One point per calendar month from the earliest date to `now`, counting the
 * dates in each. Months with nothing in them are present as zero so the line
 * drops to the axis instead of skipping them.
 */
export function monthlyCounts(dates: string[], now: Date): MonthPoint[] {
  if (dates.length === 0) return [];
  const counts = new Map<string, number>();
  let earliest = now;
  for (const d of dates) {
    const date = new Date(d);
    if (date < earliest) earliest = date;
    const key = monthKey(date);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: MonthPoint[] = [];
  const cursor = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), 1));
  const last = monthKey(now);
  for (;;) {
    const key = monthKey(cursor);
    out.push({ month: key, value: counts.get(key) ?? 0 });
    if (key >= last) break;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

export interface WeekPoint {
  /** The week's Monday, `YYYY-MM-DD`, UTC. */
  week: string;
  value: number;
}

/** The Monday (UTC) of the week `t` falls in. */
function weekStart(t: number): number {
  const d = new Date(t);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY_MS;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One point per Monday-to-Sunday week from the earliest date to `now`,
 * counting the dates in each. Empty weeks are present as zero.
 */
export function weeklyCounts(dates: string[], now: Date): WeekPoint[] {
  if (dates.length === 0) return [];
  const counts = new Map<string, number>();
  let earliest = now.getTime();
  for (const d of dates) {
    const t = new Date(d).getTime();
    if (t < earliest) earliest = t;
    const key = dayKey(weekStart(t));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: WeekPoint[] = [];
  const last = weekStart(now.getTime());
  for (let cursor = weekStart(earliest); cursor <= last; cursor += 7 * DAY_MS) {
    const key = dayKey(cursor);
    out.push({ week: key, value: counts.get(key) ?? 0 });
  }
  return out;
}
