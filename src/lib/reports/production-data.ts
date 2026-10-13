/**
 * Company-wide production data-access for the reports — ONE source of truth.
 *
 * The reports aggregate the SAME per-well series the production pages display:
 * oil `wellProductionSeries`, gas `wellGasSeries`, water `wellWaterSeries`, with
 * the same hand-entered fallback the well page uses (gas/water fall back to the
 * entered `production_readings` value on days no meter/flow covers; oil is
 * series-only, exactly as on the page — `/production/wells/[well]` builds its
 * rows this way). This replaces the previous `production_readings`-anchored
 * overlay, which (a) could only show a well/date that had a hand-entered reading
 * and (b) derived from a different engine than the pages — so reports and the
 * source pages disagreed. Rows now span the union of every date a series OR a
 * reading covers.
 *
 * `oilStock` / `oilSales` have no series (they are tank inventory + runs, entered
 * on `production_readings`), so they stay from the readings, summed per day.
 *
 * Org scoping: ONLY the producing-well list is org-scoped. Every series below is
 * entity-id-scoped off those org-owned well ids (well → its batteries/meters →
 * their tanks/readings), so no cross-org data reaches the result even on the
 * service-role cron path (which passes a {@link ProductionScope}). The one caller
 * that must scope explicitly is the digest cron; the RLS request path omits it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { memoScope, withRequestScope } from "@/lib/cache/request-cache";
import {
  cachedFlowConnections,
  cachedWellTests,
  primeSeriesInputs,
  primeWellEvents,
  primeWellMembership,
} from "@/lib/cache/loaders";
import { getRequestSupabase } from "@/lib/supabase/request-client";
import { markServiceScope } from "@/lib/supabase/service-org";
import { hasSupabase } from "@/lib/env";
import { wellProductionSeries, wellWaterSeries } from "@/lib/tanks/series-loaders";
import { wellGasSeriesMeasured } from "@/lib/meters/engine";
import { cachedWells } from "@/lib/wells/wells";
import type { CompanyProductionRow } from "@/lib/reports/types";
import { assembleWellDayRows } from "@/lib/reports/well-day-rows";

/**
 * Optional read scope. RLS callers omit it (scoped by policy through the
 * request-scoped client). Background jobs with no session (the digest cron) pass
 * a service-role `client` + the `orgId`; only the producing-well query needs it.
 */
export interface ProductionScope {
  client: SupabaseClient;
  orgId: string;
}

/**
 * Every producing well's daily production for the org, oldest first, built by
 * aggregating the same series the production pages display. Pass a
 * {@link ProductionScope} for the service-role cron path; omit it for RLS.
 */
export function getCompanyProduction(
  scope?: ProductionScope,
  opts: ProductionWindow = {}
): Promise<CompanyProductionRow[]> {
  /*
   * Tell the reading loaders which org this service-role client is acting for.
   *
   * Tank gauges and meter readings come through SECURITY DEFINER functions that
   * resolve the org from the caller's JWT. A service-role client has none, so
   * they returned NOTHING and every scheduled digest was assembled from a
   * company with no measurements at all. `markServiceScope` is how the org
   * reaches them without threading an argument through every series loader; see
   * `@/lib/supabase/service-org` and migration 2026081900100.
   */
  if (scope) markServiceScope(scope.client, scope.orgId);
  // Establishes the scope if the caller has not, so the per-well fan-out below
  // shares its org-wide reads even when this is the only entry point. Keyed by
  // org so a cron looping orgs never serves one org's rows to another, and by
  // `since` so a windowed caller can never be served a narrower cached result
  // than it asked for (or vice versa).
  return withRequestScope(() =>
    memoScope(
      `company-production:${scope?.orgId ?? "rls"}:${opts.since ?? "all"}:${
        opts.wellIds ? [...new Set(opts.wellIds)].sort().join(",") : "*"
      }`,
      () => loadCompanyProduction(scope, opts)
    )
  );
}

/**
 * How far back to build. Omit for all history.
 *
 * Every row this produces costs per-well derivation and array work, and the
 * biggest caller — the summary cards — immediately discards everything before
 * its decline cutoff. Deriving only what the caller will read is the difference
 * between "scales with the operator's history" and "scales with the window".
 *
 * Values inside the window are IDENTICAL either way: segments are still built
 * from each tank's full reading history (cached, unwindowed) and only the daily
 * output is bounded, so a narrower window never changes a number it returns.
 */
export interface ProductionWindow {
  /** Inclusive ISO `YYYY-MM-DD` lower bound. */
  since?: string;
  /**
   * Only these wells. A well's rows do not depend on which other wells are
   * derived beside it (each is its own share of its own tanks and meters), so
   * a facility page can ask for its wells alone and get the dashboard's rows
   * for them. The well page used to derive the whole fleet for one row.
   */
  wellIds?: readonly string[];
}

/**
 * The uncached body. Callers use {@link getCompanyProduction}, which memoizes it
 * for the request — several surfaces (the summary cards, the reports, the
 * dashboard brief) each ask for the full company series in the same request, and
 * this is the most expensive read in the app.
 */
/**
 * The producing-well list for the service-role cron path, filtered by `org_id`
 * explicitly. Kept separate from the shared roster because that one is scoped by
 * RLS, which does not apply to a service-role client.
 */
async function loadScopedWells(
  sb: SupabaseClient,
  orgId: string
): Promise<{ id: string; name: string | null }[]> {
  const { data, error } = await sb
    .from("wells")
    .select("id, name")
    .neq("type", "injection")
    .eq("org_id", orgId)
    // RLS hides a soft-deleted well from a signed-in caller (2026081800200);
    // the service role sees straight through it, so the filter is explicit
    // here — a deleted well still carried its hand-entered readings into the
    // cron's rows (one of them dated 2099).
    .is("deleted_at", null);
  if (error) throw new Error(`getCompanyProduction (wells): ${error.message}`);
  return (data ?? []) as { id: string; name: string | null }[];
}

async function loadCompanyProduction(
  scope?: ProductionScope,
  opts: ProductionWindow = {}
): Promise<CompanyProductionRow[]> {
  if (!scope && !hasSupabase()) return [];
  const sb = scope?.client ?? (await getRequestSupabase());
  const orgId = scope?.orgId;

  // Producing wells — the ONLY org-scoped read (series are entity-id-scoped).
  //
  // The RLS path reads the request's shared roster instead of its own `id, name`
  // select, because this function runs TWICE per dashboard render (once windowed
  // to the chart's range, once to the decline cutoff) and each private read cost
  // ~500ms of row-security work on a 104-row table.
  //
  // The cron path cannot share it: it holds a service-role client and must
  // filter `org_id` explicitly, which the RLS-scoped roster does not do.
  //
  // One deliberate difference. `.neq("type", "injection")` also drops a well
  // whose `type` is NULL, because no SQL comparison against NULL is ever true.
  // `cachedWells` maps NULL to "producer" (see `mapWell`), which is how the rest
  // of the app already reads it — `getWellSummaries` lists an untyped well as a
  // producer today. So an untyped well now reaches company production as well,
  // and the chart agrees with the well table beneath it rather than quietly
  // omitting a row from one and not the other.
  // The roster and the hand-entered readings are independent, so they go out
  // together; awaiting the roster first put the readings a round trip later.
  const wellsP = orgId
    ? loadScopedWells(sb, orgId)
    : cachedWells(sb).then((all) =>
        all
          .filter((w) => w.type !== "injection")
          .map((w) => ({ id: w.id, name: w.name as string | null }))
      );

  let readingQuery = sb
    .from("production_readings")
    .select("well_id, reading_date, reading_time, gas_production, salt_water, oil_stock, oil_sales")
    .order("reading_date", { ascending: true })
    .order("reading_time", { ascending: true });
  if (orgId) readingQuery = readingQuery.eq("org_id", orgId);
  if (opts.since) readingQuery = readingQuery.gte("reading_date", opts.since);
  const only = opts.wellIds ? new Set(opts.wellIds) : null;
  if (only) readingQuery = readingQuery.in("well_id", [...only]);
  if (only) {
    // What the per-well loaders below wait on before they can name a single
    // tank or meter: these wells' battery and meter membership, their downtime
    // events, and the water graph's inputs. All keyed by well or org-wide and
    // small, none needing the readings, so they go out in the readings' tick
    // rather than a round trip after it. The readings THEMSELVES are not primed
    // here (see below): that would read every node in the org for a page about
    // a few wells. `.catch` only marks a rejection handled; the loaders make
    // the same requests and surface the error.
    const ids = [...only];
    for (const p of [
      primeWellMembership(sb, ids),
      primeWellEvents(sb, ids),
      cachedWellTests(sb),
      cachedFlowConnections(sb),
    ]) {
      p.catch(() => {});
    }
  }
  const [allWells, { data: prData, error: pErr }] = await Promise.all([wellsP, readingQuery]);
  if (pErr) throw new Error(`getCompanyProduction (readings): ${pErr.message}`);
  const wells = only ? allWells.filter((w) => only.has(w.id)) : allWells;
  if (wells.length === 0) return [];

  // Per well, per date. Stock / sales sum across a day's readings; the gas and
  // water fallbacks are last-wins per day (ordered by date, time above),
  // matching the well page's `rawGasByDate`. A null stays null: the assembler
  // reads "a reading with no gas on it" as unmeasured, not as zero.
  type Reading = { gas: number | null; water: number | null; oilStock: number; oilSales: number };
  const readingsByWell = new Map<string, Map<string, Reading>>();
  for (const r of (prData ?? []) as {
    well_id: string;
    reading_date: string;
    gas_production: number | null;
    salt_water: number | null;
    oil_stock: number | null;
    oil_sales: number | null;
  }[]) {
    let byDate = readingsByWell.get(r.well_id);
    if (!byDate) readingsByWell.set(r.well_id, (byDate = new Map()));
    const cur = byDate.get(r.reading_date) ?? {
      gas: null,
      water: null,
      oilStock: 0,
      oilSales: 0,
    };
    cur.oilStock += r.oil_stock ?? 0;
    cur.oilSales += r.oil_sales ?? 0;
    cur.gas = r.gas_production;
    cur.water = r.salt_water;
    byDate.set(r.reading_date, cur);
  }

  // Two queries for every well's battery + meter membership, instead of two per
  // well once the per-well series loaders start asking for it.
  // Primed AT THE WINDOW the derivations read. Priming whole history while the
  // oil series read `from: since` meant every tank was read twice (whole, then
  // the year), and the whole-history half was the dashboard's compute tail.
  // Bulk-prime the fleet's inputs (memberships, allocation rows, readings for
  // every facility) only for a fleet-wide derivation. For a facility page's
  // handful of wells the per-well loaders coalesce into the same few queries
  // on their own, and the prime would read every tank and meter in the org.
  if (!only) await primeSeriesInputs(sb, wells.map((w) => w.id), opts.since);

  const rows: CompanyProductionRow[] = [];
  await Promise.all(
    wells.map(async (w) => {
      const [oil, gas, water] = await Promise.all([
        wellProductionSeries(sb, w.id, {
          mode: "regularized",
          from: opts.since,
          // A gauge interval that fell with no ticket is a missing haul, not a
          // rate; its days are unmeasured here so the company line carries the
          // last real rate over them (`dailyProduction`, `well-day-rows.ts`).
          negativeSegments: "unmeasured",
        }),
        // Same window as the oil series. The rows before `since` are cut by
        // `assembleWellDayRows` anyway; the anchor reading the windowed RPC
        // carries makes the first in-window day identical to the whole read.
        wellGasSeriesMeasured(sb, w.id, { from: opts.since }),
        wellWaterSeries(sb, w.id, { from: opts.since }),
      ]);
      /*
       * Every series' last day is only covered up to its last READING — a
       * fraction of a day wearing a whole day's date — and each comes off at
       * its own boundary (`assembleWellDayRows`, `partial-day.ts`). Left in, a
       * partial day is the newest point on every chart built from these rows
       * and the one an operator reads as today: the dashboard's most recent
       * bucket sat well under the real rate because its last day was a few
       * hours long. The next reading closes that day and it returns at full
       * length.
       *
       * Each boundary is the MEASURED series' last day (the battery's last
       * gauge, the meter's last reading), which the loader hands back with the
       * slice. A well's own last day can also be the day its split ended, and
       * that one is whole.
       *
       * Gas and water are not windowed at the source (their splits are memoized
       * per meter / per org and shared across wells, so bounding them saves
       * nothing), so `since` bounds the rows instead.
       */
      rows.push(
        ...assembleWellDayRows({
          wellId: w.id,
          wellName: w.name ?? "Unknown well",
          oil,
          gas,
          water,
          readings: readingsByWell.get(w.id) ?? new Map(),
          since: opts.since,
        })
      );
    })
  );

  rows.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.wellId < b.wellId ? -1 : a.wellId > b.wellId ? 1 : 0
  );
  return rows;
}
