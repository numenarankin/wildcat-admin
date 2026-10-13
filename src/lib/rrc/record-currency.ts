import "server-only";

import { hasRrcDb, rrcQuery } from "@/lib/scout/rrc-db";
import { memoScope, withRequestScope } from "@/lib/cache/request-cache";

/**
 * How current the state's production record is — the newest month Texas has
 * collected from anybody, not from any one lease.
 *
 * This is the HORIZON a public-record rate is read against. Texas requires a
 * monthly filing from every producing lease, so once the record covers a month,
 * a lease absent from it made nothing that month. That is what lets a missing
 * month be read as a zero (`emaAsOf`) instead of as "no data", which is the
 * difference between a well that stopped in 2002 showing 0.6 bbl/d forever and
 * showing nothing.
 *
 * It has to be measured, not assumed, in both directions:
 *
 *  - A CONSTANT LAG would be wrong on the near side. The state runs two to three
 *    months behind and the gap moves; take today minus a guessed 90 days and
 *    every producing well in the fleet decays toward zero the moment the real lag
 *    runs longer than the guess.
 *  - THE LEASE'S OWN LAST MONTH would be wrong on the far side. A lease that
 *    stopped filing in 2010 has a record ending in 2010, and reading its rate as
 *    of its own last month is the original bug with extra steps: it never goes
 *    stale relative to itself.
 *
 * `prod_report_filed = 'Y'` for the same reason `monthlyForKey` uses it: the
 * months Texas has not collected are stored as unfiled zeros, and counting them
 * would put the horizon two to three months ahead of the data.
 *
 * Memoized per request scope — one round trip (~100ms warm) shared by every well
 * and lease on the page. Null when the mirror is not configured or the query
 * fails, which callers must treat as "no horizon": leave the rate as the series
 * left it rather than decaying it against a date we could not establish.
 */
const LOG = "[rrc-currency]";

export function rrcProductionHorizon(): Promise<string | null> {
  return withRequestScope(() => memoScope("rrc-production-horizon", loadHorizon));
}

/**
 * Process-wide cache of the horizon, one hour.
 *
 * The request memo above still dedupes within a render, but every render paid
 * the `max(cycle)` read against a 48M-row hypertable: measured at 1.6s on the
 * mirror, per page view. The answer is a month boundary that moves when Texas
 * publishes, i.e. monthly; an hour of staleness cannot change what a page
 * shows, and a null (mirror down) is deliberately NOT cached so the next render
 * retries rather than serving "no horizon" for an hour.
 */
const HORIZON_TTL_MS = 60 * 60_000;
let horizonCache: { at: number; value: string } | null = null;
let horizonInflight: Promise<string | null> | null = null;

async function loadHorizon(): Promise<string | null> {
  if (!hasRrcDb()) return null;
  if (horizonCache && Date.now() - horizonCache.at < HORIZON_TTL_MS) return horizonCache.value;
  if (horizonInflight) return horizonInflight;
  horizonInflight = queryHorizon().finally(() => {
    horizonInflight = null;
  });
  return horizonInflight;
}

async function queryHorizon(): Promise<string | null> {
  try {
    const rows = await rrcQuery<{ cycle: string | null }>(
      `select max(cycle)::text as cycle
         from rrc.lease_production
        where prod_report_filed = 'Y'`,
      []
    );
    const cycle = rows[0]?.cycle ?? null;
    if (!cycle) {
      console.warn(`${LOG} no filed cycles in the mirror`);
      return null;
    }
    // The LAST day of that month: the record covers the whole month, so a stream
    // that stopped mid-month is stale from the day after its last point, not
    // from the first of the month.
    const horizon = endOfMonth(cycle.slice(0, 7));
    console.info(`${LOG} public record is current through ${horizon}`);
    horizonCache = { at: Date.now(), value: horizon };
    return horizon;
  } catch (error) {
    console.error(`${LOG} failed`, error);
    return null;
  }
}

/** `2026-05` → `2026-05-31`. */
function endOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}
