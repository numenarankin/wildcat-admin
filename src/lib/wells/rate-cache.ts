import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasSupabase } from "@/lib/env";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { memoScope, withRequestScope } from "@/lib/cache/request-cache";
import { primeSeriesInputs } from "@/lib/cache/loaders";
import { wellProductionSeries } from "@/lib/tanks/series-loaders";
import { withoutPartialTail } from "@/lib/production/partial-day";
import { wellGasSeries } from "@/lib/meters/engine";
import { latestDailyEma } from "@/lib/wells/arps";
import { cachedWells } from "@/lib/wells/wells";
import { after } from "next/server";

/**
 * The /production wells table's Oil / Gas / Revenue columns, and the cache that
 * keeps deriving them off the page-load critical path.
 *
 * The derivation ({@link deriveWellProductionRates}) is the source of truth and
 * is unchanged: oil from the REGULARIZED tank-battery series, gas from the meter
 * series, zipped by date and run through the same `latestDailyEma` the well
 * page's own headline uses — so a well's row in the table equals its own page.
 *
 * What changed is when it runs. Deriving is O(wells x days) in Node, which put
 * ~530ms of pure CPU on every /production render and grew with the operator's
 * well count. {@link getWellProductionRates} now reads the last computed answer
 * out of `well_production_rates` and only derives the wells it has no row for.
 *
 * The cache can be STALE. It cannot be WRONG: nothing writes a number here that
 * the engine did not produce, and any well the table does not cover is derived
 * live. Staleness is also cheap in this particular case — the figure is a 14-day
 * EMA, so one new gauge reading moves it by roughly a fourteenth.
 */

type Sb = SupabaseClient;

/** A well's current derived rates, in bbl/day and MCF/day. */
export interface WellProductionRate {
  oilPerDay: number;
  gasPerDay: number;
}

/**
 * How much history the rate derivation reads. The rate is a 14-day EMA and at
 * span 14 a sample k days back carries (1-2/15)^k. At 90 days the discarded
 * head could move the answer by a millionth; at 30 it can move it by up to
 * ~1.4% (7% measured on a haul-cycle sawtooth), and after trying 30 the
 * operator settled on 90 (2026-09-09): the read saving was mostly in the
 * years of history a whole read drags in, not in the last two months, and 90
 * keeps every displayed rate identical. `ema-window.test.ts` pins the bound.
 * The window is applied
 * at the READ (migration 2026090900200: the RPCs return the window plus each
 * node's last reading before it, the anchor the first day needs), not just in
 * memory afterwards, which is where the saving is.
 */
export const RATE_WINDOW_DAYS = Number(process.env.PERF_RATE_WINDOW_DAYS ?? 90) || 90;
// `PERF_RATE_WINDOW_DAYS` is MEASUREMENT ONLY, for trying another window on
// the harness without editing this constant. Unset in real environments.

/** The ISO day the rate window opens on, for readers that take one. */
export function rateWindowFrom(now = Date.now()): string {
  return new Date(now - RATE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Derive the rates for a set of wells, straight from the engines. This is the
 * authoritative computation; the table below only stores what it returns.
 */
export async function deriveWellProductionRates(
  sb: Sb,
  wellIds: string[]
): Promise<Map<string, WellProductionRate>> {
  if (wellIds.length === 0) return new Map();

  const from = rateWindowFrom();
  // Membership + every tank/meter reading those wells reach, in a handful of
  // `IN (...)` queries rather than a pair per well. Windowed: the derivation
  // below never looks past `from`, so neither should the read.
  await primeSeriesInputs(sb, wellIds, from);

  const entries = await Promise.all(
    wellIds.map(async (wellId) => {
      // Exactly the two series the well page zips into `chartRows` before taking
      // `latestDailyEma`: regularized oil + meter gas.
      const [oilRaw, gasSeries] = await Promise.all([
        wellProductionSeries(sb, wellId, { mode: "regularized", from }),
        wellGasSeries(sb, wellId, { from }),
      ]);
      /*
       * The oil series' last day ends at its last GAUGE, not at midnight, so it
       * holds a few hours of barrels under a whole day's date. It is the newest
       * and therefore heaviest sample in a 14-day EMA — the well page's own
       * table drops it (`withoutPartialTail`), and leaving it in here is what
       * had every headline rate reading under the chart above it. Gas is not
       * cut: a meter's day is entered as a day's volume.
       *
       * Cut at the BATTERY's last gauged day, which comes back with the slice. A
       * well's own last row can instead be the day its split ended -- a whole
       * day, and dropping it understated the well by one full day's rate.
       */
      const oilSeries = withoutPartialTail(oilRaw.rows, oilRaw.measuredThrough);
      /*
       * EACH STREAM OVER ITS OWN DAYS.
       *
       * The two series used to be zipped onto the union of their dates, which
       * filled the gas stream with a zero on every day the well was gauged for
       * oil and its meter was not read. Those zeros are not measurements — they
       * are days the gas series does not cover — and they dragged the well's gas
       * rate below the very meter it is the only well on. Same the other way for
       * oil. A real zero (a meter reading of nothing) is in its own series
       * already and still counts.
       */
      const rate: WellProductionRate = {
        oilPerDay: latestDailyEma(
          oilSeries.map((p) => ({
            date: p.date,
            oilProduction: p.bbls,
            gasProduction: 0,
          })),
          "oil"
        ),
        gasPerDay: latestDailyEma(
          gasSeries.map((p) => ({
            date: p.date,
            oilProduction: 0,
            gasProduction: p.bbls,
          })),
          "gas"
        ),
      };
      return [wellId, rate] as const;
    })
  );
  return new Map(entries);
}

interface RateRow {
  well_id: string;
  oil_per_day: number | null;
  gas_per_day: number | null;
  computed_at: string | null;
}

/**
 * How long a cached row is trusted before it is derived again.
 *
 * The class comment above says staleness is cheap because the figure is a
 * 14-day EMA that one gauge reading moves by a fourteenth. That is true of a
 * READING and false of everything structural. Wire a battery to two wells and
 * their rate does not move by a fourteenth — it moves from 0 to whatever the
 * battery makes, because until that allocation existed no series reached them at
 * all. Roy Corbett 2 and 4 were cached at 0/0 the first time /production
 * rendered, gained a 50/50 battery split later, and stayed at 0/0: nothing in
 * the app ever called {@link refreshWellProductionRates}, and the reader only
 * derives wells it has NO row for, so the first answer was also the last one.
 *
 * {@link invalidateWellProductionRates} is the real repair — every write that
 * changes what feeds a well drops its row and the next read derives it. This is
 * the backstop for the writers nobody wired up: an AI tool, an approved ingest
 * proposal, a hand-run SQL statement. Fifteen minutes because the worst case is
 * one request paying the ~530ms full-fleet derivation the cache was added to
 * avoid, which is exactly what every request paid before it existed.
 */
const RATE_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Read the cached rates, skipping rows that have gone stale. Returns an empty
 * map (not an error) when the table is absent, so a deploy that runs ahead of
 * `supabase db push` degrades to deriving live rather than failing the page.
 * That is a real state in this project — see the migration-drift note in the
 * workspace memory.
 */
async function readCached(
  sb: Sb,
  wellIds: string[]
): Promise<Map<string, WellProductionRate>> {
  const out = new Map<string, WellProductionRate>();
  if (wellIds.length === 0) return out;

  const { data, error } = await sb
    .from("well_production_rates")
    .select("well_id, oil_per_day, gas_per_day, computed_at")
    .in("well_id", wellIds);
  if (error) {
    // 42P01 = undefined_table. Anything else is a genuine fault worth surfacing
    // in the log, but neither should take the page down when we can derive.
    console.warn(`well_production_rates unavailable, deriving live: ${error.message}`);
    return out;
  }
  const oldest = Date.now() - RATE_CACHE_TTL_MS;
  let stale = 0;
  for (const r of (data ?? []) as RateRow[]) {
    // A row with no stamp is from before the column was populated: treat it as
    // stale rather than trusting it forever.
    const at = r.computed_at ? Date.parse(r.computed_at) : NaN;
    if (!Number.isFinite(at) || at < oldest) {
      stale += 1;
      continue;
    }
    out.set(r.well_id, {
      oilPerDay: Number(r.oil_per_day ?? 0),
      gasPerDay: Number(r.gas_per_day ?? 0),
    });
  }
  if (stale > 0) {
    console.info(`well_production_rates: ${stale} stale row(s), deriving again`);
  }
  return out;
}

/**
 * Drop cached rates so the next read derives them again. With no `wellIds`, the
 * caller's whole org — RLS scopes the delete.
 *
 * Call after ANY write that changes what feeds a well's rate: an allocation
 * added, moved, re-split or removed.
 *
 * THE WHOLE ORG, on purpose. The wells named in an allocation request are not
 * the wells the change affects. Re-splitting a tank changes every OTHER well on
 * it; removing a well from a battery changes both the well that left and the
 * ones that absorbed its share; and oil reaches a well through a battery → tank
 * → allocation chain, so the set is not even local to the row being written.
 * Enumerating it correctly means reading the before-state at every call site and
 * getting the chain right each time. Clearing the org cannot miss one, and the
 * cost is a single fleet derivation on the next page load — the ~530ms that
 * every /production render paid before this cache existed, now paid on the rare
 * day somebody rewires a battery.
 *
 * Deleting rather than recomputing keeps the write path cheap: the reader
 * already derives every well it has no row for and writes the answer back, so
 * this hands the work to whoever looks next instead of making the person who
 * dragged a percentage wait for it.
 *
 * Never throws. A failed invalidation leaves a stale row, which the TTL clears
 * within the quarter hour; failing the allocation write over it would trade a
 * stale number for a lost edit.
 */
export async function invalidateWellProductionRates(
  sb: Sb,
  wellIds?: string[]
): Promise<void> {
  let q = sb.from("well_production_rates").delete();
  if (wellIds) {
    const ids = [...new Set(wellIds.filter(Boolean))];
    if (ids.length === 0) return;
    q = q.in("well_id", ids);
  } else {
    // PostgREST refuses an unfiltered DELETE; the primary key is never null, so
    // this is "every row I am allowed to see".
    q = q.not("well_id", "is", null);
  }
  const { error } = await q;
  if (error) {
    console.warn(`well_production_rates invalidation failed: ${error.message}`);
  }
}

/**
 * Recompute and store the rates for `wellIds` (default: every producing well the
 * caller can see). Returns what it wrote.
 *
 * Call from the refresh cron, and after a write that moves a well's production.
 * Uses whatever client it is handed, so the cron can pass a service-role client
 * with its own org scope.
 */
export async function refreshWellProductionRates(
  sb: Sb,
  wellIds?: string[],
  opts: {
    /**
     * Rates already derived by the caller. The reader derives on the request
     * path and writes back AFTER the response; handing the answer in here means
     * the deferred write costs one roster read and one upsert, not a second
     * full derivation competing with the user's next navigation.
     */
    rates?: Map<string, WellProductionRate>;
  } = {}
): Promise<Map<string, WellProductionRate>> {
  // `org_id` comes back with the roster, never from the column's
  // `current_org_id()` default. That default is NULL for a service-role client,
  // which has no session and therefore no active org — so the very caller this
  // function documents (a cron passing its own client) had every upsert rejected
  // by the not-null constraint, warned, and returned as though it had written.
  let roster: { id: string; org_id: string }[];
  if (wellIds) {
    const { data, error } = await sb
      .from("wells")
      .select("id, org_id")
      .in("id", wellIds);
    if (error) throw new Error(`refreshWellProductionRates: ${error.message}`);
    roster = (data ?? []) as { id: string; org_id: string }[];
  } else {
    const { data, error } = await sb
      .from("wells")
      .select("id, org_id")
      .neq("type", "injection");
    if (error) throw new Error(`refreshWellProductionRates: ${error.message}`);
    roster = (data ?? []) as { id: string; org_id: string }[];
  }
  const ids = roster.map((r) => r.id);
  if (ids.length === 0) return new Map();
  const orgByWell = new Map(roster.map((r) => [r.id, r.org_id]));

  const rates = opts.rates ?? (await deriveWellProductionRates(sb, ids));
  const rows = [...rates.entries()].map(([wellId, r]) => ({
    well_id: wellId,
    org_id: orgByWell.get(wellId),
    oil_per_day: r.oilPerDay,
    gas_per_day: r.gasPerDay,
    computed_at: new Date().toISOString(),
  }));
  const { error } = await sb
    .from("well_production_rates")
    .upsert(rows, { onConflict: "well_id" });
  if (error) {
    // A failed refresh must not fail the caller: the reader derives live for any
    // well it has no row for, so the worst case is the cost we already paid.
    console.warn(`well_production_rates upsert failed: ${error.message}`);
  }
  return rates;
}

/**
 * Per-well current oil/gas rates for the /production wells table. Cached where
 * available, derived where not — the return contract is identical either way, so
 * callers cannot tell which wells came from where.
 */
export function getWellProductionRates(): Promise<
  Map<string, WellProductionRate>
> {
  return withRequestScope(() =>
    memoScope("well-production-rates", loadWellProductionRates)
  );
}

async function loadWellProductionRates(): Promise<
  Map<string, WellProductionRate>
> {
  if (!hasSupabase()) return new Map();
  const sb = await getRequestSupabase();

  // The page has already loaded the roster; reuse it rather than issuing a
  // second `wells` select that differs only in its projection.
  const wellIds = (await cachedWells(sb))
    .filter((w) => w.type !== "injection")
    .map((w) => w.id);
  if (wellIds.length === 0) return new Map();

  const cached = await readCached(sb, wellIds);
  const missing = wellIds.filter((id) => !cached.has(id));
  if (missing.length === 0) return cached;

  // Cold wells: derive them now so the table is never wrong, and write them back
  // so the next render does not pay again. A brand-new org derives everything on
  // its first load and nothing thereafter.
  const derived = await deriveWellProductionRates(sb, missing);
  for (const [id, rate] of derived) cached.set(id, rate);

  /*
   * The write-back runs AFTER the response, not on the critical path. It was
   * one more serial round trip (plus a `wells` read for org ids) that the user
   * waited on for numbers they were already looking at. A failure only means
   * the next render derives again, which is the fallback the reader has anyway.
   */
  await afterResponse(() =>
    refreshWellProductionRates(sb, missing, { rates: derived }).then(() => undefined)
  );
  return cached;
}

/**
 * Run `fn` once the response has been sent, or right now when there is no
 * response to wait for.
 *
 * `after()` from next/server does the deferral inside a request and throws
 * outside one (a test, a script, a cron). The contract callers rely on is
 * "this work happens"; WHEN is an optimisation, so the fallback is to do it
 * inline rather than to drop it. That is also what lets a unit test observe
 * the write-back synchronously.
 */
async function afterResponse(fn: () => Promise<void>): Promise<void> {
  try {
    after(fn);
  } catch {
    await fn();
  }
}
