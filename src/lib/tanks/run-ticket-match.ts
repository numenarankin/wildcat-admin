import { runTicketKey } from "@/lib/ai/ingest/dedup-keys";

/**
 * Which ticket on file, if any, a proposed run is (docs/plans/
 * run-ticket-revenue.md, step 5).
 *
 * `runTicketKey` is still the identity. What this adds is what a match DOES:
 * a run that brings the purchaser's dollars to a ticket that lacks them fills
 * that ticket instead of being dropped as a duplicate. The card
 * (`suppress.ts`) and the writers (`ingest/actions.ts`) both ask here, so what
 * the reviewer is shown and what approving writes cannot disagree.
 *
 * Pure: one tank's proposed runs against that tank's live tickets.
 */

/** A live ticket on the tank, as much of it as matching needs. */
export interface TicketOnFile {
  id: string;
  ticketNo: string | null;
  date: string;
  grossBbls: number | null;
  netBbls: number | null;
  price: number | null;
  grossValue: number | null;
  taxes: number | null;
  netValue: number | null;
}

/** A proposed run, as much of it as matching needs. */
export interface RunToMatch {
  ticketNo?: string | null;
  date: string;
  grossBbls: number;
  netBbls?: number | null;
  price?: number | null;
  grossValue?: number | null;
  taxes?: number | null;
  netValue?: number | null;
}

export type RunMatch =
  /** Already on file with nothing to add (or a repeat inside the batch). */
  | { kind: "same" }
  /** On file; the run's dollars are missing from it or differ. `byDate` when
   *  the ticket was found by its date because it carries no number. */
  | { kind: "fill"; ticket: TicketOnFile; byDate: boolean }
  /** Not on file by key, but a ticket shares the date: the reviewer decides. */
  | { kind: "flag" }
  | { kind: "new" };

/**
 * How far a pumper's gauged barrels may sit from the purchaser's corrected
 * barrels and still be the same haul, for the by-date match only.
 */
export const SAME_HAUL_BBLS_TOLERANCE = 0.05;

const effectiveBbls = (t: { grossBbls: number | null; netBbls?: number | null }) =>
  t.netBbls ?? t.grossBbls;

const cents = (n: number) => Math.round(n * 100);
/** Statement prices print to four decimals (`roundPrice`). */
const tenThousandths = (n: number) => Math.round(n * 10_000);

/** True when the run carries any of the four revenue figures. */
export function runHasRevenue(run: RunToMatch): boolean {
  return (
    run.price != null ||
    run.grossValue != null ||
    run.taxes != null ||
    run.netValue != null
  );
}

/** True when a figure the run carries is missing from the ticket or differs. */
function revenueDiffers(run: RunToMatch, ticket: TicketOnFile): boolean {
  const differs = (
    a: number | null | undefined,
    b: number | null,
    unit: (n: number) => number
  ) => a != null && (b == null || unit(a) !== unit(b));
  return (
    differs(run.price, ticket.price, tenThousandths) ||
    differs(run.grossValue, ticket.grossValue, cents) ||
    differs(run.taxes, ticket.taxes, cents) ||
    differs(run.netValue, ticket.netValue, cents)
  );
}

function withinTolerance(run: RunToMatch, ticket: TicketOnFile): boolean {
  const a = effectiveBbls(run);
  const b = effectiveBbls(ticket);
  if (a == null || b == null || !(b > 0)) return false;
  // In hundredths of a barrel, the precision a ticket prints, so a difference
  // of exactly 5% is not pushed over the line by float division.
  return (
    Math.round(Math.abs(a - b) * 100) <=
    Math.round(b * SAME_HAUL_BBLS_TOLERANCE * 100)
  );
}

/**
 * Match every proposed run on ONE tank, in order. The result lines up with
 * `runs` index for index.
 */
export function matchRunsToTickets(
  runs: RunToMatch[],
  tickets: TicketOnFile[]
): RunMatch[] {
  const byKey = new Map<string, TicketOnFile>();
  for (const t of tickets) {
    const key = runTicketKey(t.ticketNo, t.date, effectiveBbls(t));
    if (!byKey.has(key)) byKey.set(key, t);
  }

  const out: (RunMatch | null)[] = runs.map(() => null);
  const batchKeys = new Set<string>();
  const claimed = new Set<string>();
  /** Runs no key matched, by date: these are what the date rules look at. */
  const pending = new Map<string, number[]>();

  runs.forEach((run, i) => {
    const key = runTicketKey(run.ticketNo, run.date, effectiveBbls(run));
    if (batchKeys.has(key)) {
      out[i] = { kind: "same" };
      return;
    }
    batchKeys.add(key);
    const ticket = byKey.get(key);
    if (ticket) {
      claimed.add(ticket.id);
      out[i] = revenueDiffers(run, ticket)
        ? { kind: "fill", ticket, byDate: false }
        : { kind: "same" };
      return;
    }
    const list = pending.get(run.date);
    if (list) list.push(i);
    else pending.set(run.date, [i]);
  });

  for (const [date, indexes] of pending) {
    const onDate = tickets.filter((t) => t.date === date);
    if (onDate.length === 0) {
      // Nothing on file that day. A second run for the same day inside the
      // batch is still worth a look, as it was before fills existed.
      indexes.forEach((i, n) => {
        out[i] = n === 0 ? { kind: "new" } : { kind: "flag" };
      });
      continue;
    }
    // The one case a date alone settles: a single ticket entered with no
    // number, and a single run for that day bringing dollars for about the
    // same barrels. Two of either is two hauls or a guess, so it is flagged.
    const unnumbered = onDate.filter(
      (t) => !(t.ticketNo ?? "").trim() && !claimed.has(t.id)
    );
    const run = runs[indexes[0]];
    if (
      indexes.length === 1 &&
      unnumbered.length === 1 &&
      runHasRevenue(run) &&
      withinTolerance(run, unnumbered[0])
    ) {
      out[indexes[0]] = { kind: "fill", ticket: unnumbered[0], byDate: true };
      continue;
    }
    for (const i of indexes) out[i] = { kind: "flag" };
  }

  return out.map((m) => m ?? { kind: "new" });
}

/** What a fill writes: the figures the run carries, never a blank over a value. */
export interface RunRevenueFill {
  price?: number;
  grossValue?: number;
  taxes?: number;
  netValue?: number;
  /** Only for a by-date fill of a ticket that has no number of its own. */
  ticketNo?: string;
}

export function revenueFillFor(
  run: RunToMatch,
  match: Extract<RunMatch, { kind: "fill" }>
): RunRevenueFill {
  const fill: RunRevenueFill = {};
  if (run.price != null) fill.price = run.price;
  if (run.grossValue != null) fill.grossValue = run.grossValue;
  if (run.taxes != null) fill.taxes = run.taxes;
  if (run.netValue != null) fill.netValue = run.netValue;
  const no = (run.ticketNo ?? "").trim();
  if (match.byDate && no && !(match.ticket.ticketNo ?? "").trim()) {
    fill.ticketNo = no;
  }
  return fill;
}

/** The note a fill row carries on its approval card. */
export function fillNotice(
  run: RunToMatch,
  match: Extract<RunMatch, { kind: "fill" }>
): string {
  if (!match.byDate) {
    const no = (match.ticket.ticketNo ?? "").trim();
    return no
      ? `Ticket ${no} is already on file. Approving adds its revenue.`
      : `This run is already on file. Approving adds its revenue.`;
  }
  return (run.ticketNo ?? "").trim()
    ? `A run with no ticket number is on file for this tank on ${run.date}. Approving adds this revenue and ticket number to it.`
    : `A run with no ticket number is on file for this tank on ${run.date}. Approving adds this revenue to it.`;
}

/**
 * A run's net value: as printed, else gross less taxes, the convention the
 * statement lines use. Null when there is no gross to work from.
 */
export function runNetValue(
  gross: number | null | undefined,
  taxes: number | null | undefined,
  net: number | null | undefined
): number | null {
  if (net != null) return net;
  if (gross == null) return null;
  return Math.round((gross - (taxes ?? 0)) * 100) / 100;
}
