/**
 * The admin dashboard's business figures, computed from the subscription
 * history and the customer list. Pure, so every number has a hand oracle.
 *
 * Definitions (the cards and the chart use exactly these):
 *   Paying users  subscriptions live at `at`: customers who went through the
 *           payment step and hold a card, including those still in trial. A
 *           sign-up without a subscription is not one.
 *   ARR     recurring revenue per year of every subscription live at `at`.
 *   ACV     ARR ÷ live subscriptions (average annual contract), null with none.
 *   Growth  MONTHLY, over the trailing 30 days: the ARR added by subscriptions
 *           that started in the last 30 days and are still live, over the ARR
 *           that existed 30 days ago. Not annualized. Null when there was
 *           nothing 30 days ago to grow from.
 *   Referral coefficient  referred sign-ups per customer: customers who came
 *           in on another's code ÷ all customers, as of `at`.
 */

export interface RecurringSubscription {
  id: string;
  /** Epoch ms the subscription started billing. */
  startedAt: number;
  /** Epoch ms it stopped, or null while it runs. */
  endedAt: number | null;
  /** Recurring revenue per year at its current price and quantity, USD. */
  annualUsd: number;
  /**
   * Spans when charging was paused (`pauseSpans`): live but not paying, so
   * out of every figure. Absent means never paused.
   */
  pauses?: Pause[];
}

/** A stretch of a subscription with no payment: epoch ms, `to` null while it lasts. */
export interface Pause {
  from: number;
  to: number | null;
}

/**
 * When a subscription was paused, read from its invoices, because Stripe keeps
 * no record of when a pause began (its event log lasts 30 days).
 *
 * A paused subscription (`pause_collection: void`) still raises its invoices
 * and voids each one, and voided invoices stay in Stripe for good. So a run of
 * voided invoices is a stretch they did not pay: it starts at the first voided
 * invoice (the first payment skipped, which is when paying actually stopped)
 * and ends at the next finalized invoice that is not void. A run with nothing
 * after it is still going when the subscription is paused now; when it is not,
 * it was resumed and the next invoice has not been raised yet, so it ends now.
 *
 * Paused now with no voided invoice yet (a trial, or a pause made since the
 * last bill) counts from now: a paused customer is not paying, whether or not
 * Stripe has had a bill to void.
 *
 * Drafts are skipped: a draft raised during a pause is voided at finalization,
 * and one raised after it is not yet a payment either way.
 */
export function pauseSpans(
  invoices: { created: number; status: string | null }[],
  pausedNow: boolean,
  now: number
): Pause[] {
  const finalized = invoices
    .filter((i) => i.status && i.status !== "draft")
    .sort((a, b) => a.created - b.created);
  const spans: Pause[] = [];
  let from: number | null = null;
  for (const inv of finalized) {
    if (inv.status === "void") {
      if (from === null) from = inv.created;
    } else if (from !== null) {
      spans.push({ from, to: inv.created });
      from = null;
    }
  }
  if (from !== null) spans.push({ from, to: pausedNow ? null : now });
  else if (pausedNow) spans.push({ from: now, to: null });
  return spans;
}

export interface SignupRecord {
  signedUpAt: string;
  referredByOrg: string | null;
}

/**
 * Each subscription dated by its customer's SIGN-UP rather than by when Stripe
 * started billing it: a customer counts as paying from the day they signed
 * up. A subscription no customer holds keeps its Stripe start.
 */
export function datedBySignup(
  subs: RecurringSubscription[],
  customers: { signedUpAt: string; subscriptionId: string | null }[]
): RecurringSubscription[] {
  const signedUp = new Map(
    customers
      .filter((c) => c.subscriptionId)
      .map((c) => [c.subscriptionId as string, Date.parse(c.signedUpAt)])
  );
  return subs.map((s) => {
    const at = signedUp.get(s.id);
    return at === undefined || Number.isNaN(at) ? s : { ...s, startedAt: at };
  });
}

export interface MetricPoint {
  /** `YYYY-MM`, UTC. */
  month: string;
  value: number;
}

const DAY_MS = 86_400_000;
export const GROWTH_WINDOW_DAYS = 30;

/** Running and paying at `at`: started, not ended, not inside a pause. */
export function liveAt(sub: RecurringSubscription, at: number): boolean {
  return (
    sub.startedAt <= at &&
    (sub.endedAt === null || sub.endedAt > at) &&
    !(sub.pauses ?? []).some((p) => p.from <= at && (p.to === null || p.to > at))
  );
}

export function payingAt(subs: RecurringSubscription[], at: number): number {
  return subs.filter((s) => liveAt(s, at)).length;
}

export function arrAt(subs: RecurringSubscription[], at: number): number {
  return subs.filter((s) => liveAt(s, at)).reduce((sum, s) => sum + s.annualUsd, 0);
}

export function acvAt(subs: RecurringSubscription[], at: number): number | null {
  const live = subs.filter((s) => liveAt(s, at));
  if (live.length === 0) return null;
  return live.reduce((sum, s) => sum + s.annualUsd, 0) / live.length;
}

export function monthlyGrowthAt(
  subs: RecurringSubscription[],
  at: number,
  windowDays = GROWTH_WINDOW_DAYS
): number | null {
  const start = at - windowDays * DAY_MS;
  const base = arrAt(subs, start);
  if (base <= 0) return null;
  const added = subs
    .filter((s) => s.startedAt > start && liveAt(s, at))
    .reduce((sum, s) => sum + s.annualUsd, 0);
  return added / base;
}

export function referralCoefficientAt(customers: SignupRecord[], at: number): number | null {
  const existing = customers.filter((c) => new Date(c.signedUpAt).getTime() <= at);
  if (existing.length === 0) return null;
  const referred = existing.filter((c) => c.referredByOrg).length;
  return referred / existing.length;
}

/** The moves a headline card shows: against 7 days ago and against 30 days ago. */
export interface Moves {
  week: number | null;
  month: number | null;
}

/** Relative change from `then` to `now` (0.25 = up 25%); null when there is nothing to compare against. */
export function changePct(now: number | null, then: number | null): number | null {
  if (now == null || then == null || then === 0) return null;
  return (now - then) / then;
}

/** A figure's moves, from the same function evaluated at the two earlier instants. */
export function movesFor(value: (at: number) => number | null, nowMs: number): Moves {
  const now = value(nowMs);
  return {
    week: changePct(now, value(nowMs - 7 * DAY_MS)),
    month: changePct(now, value(nowMs - 30 * DAY_MS)),
  };
}

/** Sign-ups in the `days` before `at` (for the New customers card's moves). */
export function countBetween(dates: string[], days: number, at: number): number {
  const floor = at - days * DAY_MS;
  return dates.filter((d) => {
    const t = new Date(d).getTime();
    return t > floor && t <= at;
  }).length;
}

const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** The instant each month is measured at: its last millisecond, or now for the current month. */
export function monthEnds(fromMs: number, nowMs: number): { month: string; at: number }[] {
  const out: { month: string; at: number }[] = [];
  const from = new Date(fromMs);
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor.getTime() <= nowMs) {
    const next = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1);
    out.push({ month: monthKey(cursor.getTime()), at: Math.min(next - 1, nowMs) });
    cursor.setTime(next);
  }
  return out;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The instant each UTC day is measured at: its last millisecond, or now for today. */
export function dayEnds(fromMs: number, nowMs: number): { day: string; at: number }[] {
  const out: { day: string; at: number }[] = [];
  const from = new Date(fromMs);
  let cursor = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  while (cursor <= nowMs) {
    const next = cursor + DAY_MS;
    out.push({ day: dayKey(cursor), at: Math.min(next - 1, nowMs) });
    cursor = next;
  }
  return out;
}

export interface DayPoint {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  value: number;
}

/** One point per day for each figure, each measured at that day's end. */
export function dailySeries(
  subs: RecurringSubscription[],
  customers: SignupRecord[],
  fromMs: number,
  nowMs: number
): { paying: DayPoint[]; arr: DayPoint[]; acv: DayPoint[]; arrGrowth: DayPoint[]; referral: DayPoint[] } {
  const ends = dayEnds(fromMs, nowMs);
  const pick = (f: (at: number) => number | null) =>
    ends.flatMap(({ day, at }) => {
      const value = f(at);
      return value === null ? [] : [{ day, value }];
    });
  return {
    paying: pick((at) => payingAt(subs, at)),
    arr: pick((at) => arrAt(subs, at)),
    acv: pick((at) => acvAt(subs, at)),
    arrGrowth: pick((at) => monthlyGrowthAt(subs, at)),
    referral: pick((at) => referralCoefficientAt(customers, at)),
  };
}

/** One point per month for each figure, each measured at that month's end. */
export function metricSeries(
  subs: RecurringSubscription[],
  customers: SignupRecord[],
  fromMs: number,
  nowMs: number
): { paying: MetricPoint[]; arr: MetricPoint[]; acv: MetricPoint[]; arrGrowth: MetricPoint[]; referral: MetricPoint[] } {
  const ends = monthEnds(fromMs, nowMs);
  const pick = (f: (at: number) => number | null) =>
    ends.flatMap(({ month, at }) => {
      const value = f(at);
      return value === null ? [] : [{ month, value }];
    });
  return {
    paying: pick((at) => payingAt(subs, at)),
    arr: pick((at) => arrAt(subs, at)),
    acv: pick((at) => acvAt(subs, at)),
    arrGrowth: pick((at) => monthlyGrowthAt(subs, at)),
    referral: pick((at) => referralCoefficientAt(customers, at)),
  };
}
