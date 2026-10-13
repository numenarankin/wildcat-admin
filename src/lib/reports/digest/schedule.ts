/**
 * Pure scheduling logic for the digest cron — no I/O, no wall-clock reads.
 *
 * `nextDueAt` answers "when is this subscription next owed a send", as a UTC
 * instant, and the anchor (the last day a send covers) is computed by
 * `anchorFor`. Both are deterministic functions of their arguments, so the
 * scheduling rules are unit-testable without mocking the clock.
 *
 * There is deliberately no "is it due right now" predicate. Due-ness is a
 * property of the stored `report_subscriptions.next_due_at` watermark, not of
 * the current hour: a coincidence test loses a send whenever the dispatcher
 * misses its hour, and sends twice whenever it runs twice in one.
 * See `docs/plans/due-report-dispatch.md`.
 *
 * Rules:
 *  - daily:   every day, covering yesterday.
 *  - weekly:  Fridays, covering the 7 days ending yesterday (so a Friday send
 *             reports last Friday through Thursday — seven COMPLETE days, never
 *             a partial today). Always the `estimated` basis: a week never has
 *             settled statement dollars, which arrive monthly.
 *  - monthly: on the 1st for the `estimated` production digest (prior month),
 *             and on the 20th for the `settled` settlement digest (prior month),
 *             once statement prices have had time to land.
 * All fire at the subscription's configured local send hour.
 */

import { shiftDays } from "@/lib/reports/digest/period";
import type { DigestPeriod, RevenueBasis } from "@/lib/reports/digest/types";

/** A wall-clock moment already resolved into a subscription's local timezone. */
export interface LocalTime {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
  /** 0-23. */
  hour: number;
  /** Day of week, 0 = Sunday .. 6 = Saturday. */
  dow: number;
}

/** Day the `settled` monthly settlement digest fires (statements have landed). */
export const SETTLEMENT_SEND_DAY = 20;

/** Day of week the weekly digest fires (0 = Sunday, so 5 = Friday). */
export const WEEKLY_SEND_DOW = 5;

/**
 * The basis a period can actually be reported on.
 *
 * Only the monthly digest can be `settled`: settlement dollars arrive on
 * purchaser statements once a month, so a daily or weekly window has none and
 * must be valued from estimated prices (benchmark × realization factor). This is
 * the one place that rule lives — the cron, the export route, and the settings
 * UI all resolve through it, so a subscription saved as weekly+settled reports
 * an honest `estimated` rather than a window of zeros.
 */
export function effectiveBasis(
  frequency: DigestPeriod,
  requested: RevenueBasis
): RevenueBasis {
  return frequency === "monthly" && requested === "settled"
    ? "settled"
    : "estimated";
}

/** Pad a number to 2 digits. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The local calendar date as an ISO `YYYY-MM-DD` string. */
export function localIso(local: LocalTime): string {
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

/**
 * The anchor a subscription's send at `dueAt` will cover.
 *
 * The ONE place this is computed. The dispatcher needs it to name the period it
 * is delivering, and the nightly compile needs the SAME answer hours earlier to
 * build that period ahead of time. Two copies of "resolve the due instant into
 * the subscription's local calendar, then take the anchor" is two copies that
 * can drift by a day across a timezone or a DST boundary, and a drift here is
 * invisible: the compile writes a row under one key, the dispatcher looks under
 * another, misses, rebuilds, and the whole precompute silently does nothing.
 * See `docs/plans/report-precompute-and-outbox.md`, success criterion 1.
 *
 * The period is read at the DUE instant, never at "now": a send that is six
 * hours late still covers the period it was owed, not the one that has started
 * since.
 */
export function anchorForDue(
  rules: { frequency: DigestPeriod; timezone: string },
  dueAt: Date
): string {
  return anchorFor(rules.frequency, localTimeIn(dueAt, rules.timezone));
}

/**
 * The digest anchor (last day covered) for a subscription firing at `local`:
 * daily/weekly cover through yesterday; monthly covers the previous calendar
 * month (anchor = its last day).
 */
export function anchorFor(frequency: DigestPeriod, local: LocalTime): string {
  const today = localIso(local);
  if (frequency === "monthly") {
    // Last day of the previous month = day before the first of this month.
    return shiftDays(`${local.year}-${pad(local.month)}-01`, -1);
  }
  // daily + weekly: the most recent complete day.
  return shiftDays(today, -1);
}

// --- Local wall-clock <-> UTC instants ---------------------------------------

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Resolve a UTC instant into a timezone's wall-clock parts.
 *
 * Lives here rather than in the cron routes because both of them, and the
 * dispatcher, need the same answer; it was copied into two route files before.
 */
export function localTimeIn(date: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const get = (t: string): string =>
    parts.find((p) => p.type === t)?.value ?? "";
  // Intl returns "24" for midnight in hour12:false on some engines; normalize.
  const hour = Number(get("hour")) % 24;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    dow: Math.max(0, DOW_NAMES.indexOf(get("weekday"))),
  };
}

/** How far `timeZone` is ahead of UTC at a given instant, in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  // Milliseconds are not in the formatted parts; instants here are whole
  // seconds (a send hour), so truncating them is exact rather than lossy.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time in `timeZone`.
 *
 * Two passes, because the offset depends on the instant we are trying to find:
 * the first pass guesses with the offset in force at the naive instant, the
 * second corrects it using the offset actually in force there. That is what
 * makes a 07:00 send stay 07:00 across a DST boundary instead of drifting to
 * 06:00 or 08:00 for half the year.
 *
 * A local time that does not exist (the hour skipped on spring-forward)
 * resolves to the next instant that does; an ambiguous one (the hour repeated
 * on fall-back) resolves to its first occurrence.
 */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour: number },
  timeZone: string
): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour);
  const first = naive - offsetMsAt(new Date(naive), timeZone);
  const corrected = naive - offsetMsAt(new Date(first), timeZone);
  // The correction is right whenever the local time it lands on is the one
  // asked for. When it is not, the requested hour does not exist that day
  // (spring-forward skipped it) and the correction has walked BACK past the
  // gap — 02:00 becoming 01:00. The uncorrected guess is the instant just after
  // the gap (02:00 asked for, 03:00 local), which is the send happening as soon
  // as the day allows rather than an hour early.
  if (localTimeIn(new Date(corrected), timeZone).hour === local.hour) {
    return new Date(corrected);
  }
  return new Date(first);
}

/** Day of week (0 = Sunday) of an ISO `YYYY-MM-DD` calendar date. */
function dowOfIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The scheduling fields of a subscription, and nothing else. */
export interface DueRules {
  frequency: DigestPeriod;
  basis: RevenueBasis;
  /** Local hour of day, 0-23. */
  sendHour: number;
  /** IANA timezone the send hour is read in. */
  timezone: string;
}

/** Whether a local calendar date is one this cadence sends on. */
function sendsOn(rules: DueRules, iso: string): boolean {
  const day = Number(iso.slice(8, 10));
  switch (rules.frequency) {
    case "daily":
      return true;
    case "weekly":
      return dowOfIso(iso) === WEEKLY_SEND_DOW;
    case "monthly":
      // `effectiveBasis` is what decides whether "settled" is real for this
      // cadence, so a weekly+settled row cannot claim the 20th.
      return effectiveBasis(rules.frequency, rules.basis) === "settled"
        ? day === SETTLEMENT_SEND_DAY
        : day === 1;
    default:
      return false;
  }
}

/**
 * The next instant this subscription is owed a send, strictly after `after`.
 *
 * This is the value stored in `report_subscriptions.next_due_at` and the ONLY
 * thing the dispatcher selects on. It is recomputed from the rules after every
 * send rather than advanced by a fixed interval: adding 24h across a DST change
 * moves the send an hour, and adding a month to the 31st is undefined.
 *
 * Walks forward day by day over the LOCAL calendar. A year and a bit is enough
 * for every cadence here (the sparsest fires monthly); exceeding it means the
 * rules disagree with `sendsOn`, which is a bug worth an exception rather than
 * a silently unscheduled subscription.
 */
export function nextDueAt(rules: DueRules, after: Date): Date {
  const local = localTimeIn(after, rules.timezone);
  let iso = localIso(local);
  for (let i = 0; i <= 400; i += 1) {
    if (sendsOn(rules, iso)) {
      const [year, month, day] = iso.split("-").map(Number);
      const candidate = zonedTimeToUtc(
        { year, month, day, hour: rules.sendHour },
        rules.timezone
      );
      // Strictly after: a send that just fired must not immediately re-arm on
      // the same instant, which would loop the dispatcher on one subscription.
      if (candidate.getTime() > after.getTime()) return candidate;
    }
    iso = shiftDays(iso, 1);
  }
  throw new Error(
    `nextDueAt: no send date within 400 days for ${rules.frequency}/${rules.basis}`
  );
}
