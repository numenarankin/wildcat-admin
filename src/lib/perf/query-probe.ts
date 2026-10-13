import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-render query counter + timer, for measuring the phases in
 * `performance-audit.md` against the REAL database.
 *
 * Why counting and not just wall-clock: the caching phases are invisible in
 * wall-clock on a warm connection and a small org, and very visible in query
 * count. A page can feel identical and be doing five times the work, which is
 * exactly how the per-well fan-out went unnoticed. Wall-clock alone would have
 * let it through.
 *
 * Entirely inert unless `PERF_LOG=1`: {@link countQueries} hands back the client
 * untouched and {@link probe} calls straight through, so there is no proxy and no
 * bookkeeping on a normal request.
 *
 * Usage:
 *   PERF_LOG=1 npm run build && PERF_LOG=1 npm start
 *   # then load a page and read the server console:
 *   # [perf] /production 1840ms 214 queries | tank_readings×61 wells×40 …
 */

export const PERF_ENABLED = process.env.PERF_LOG === "1";

/** Per-endpoint timing, so the cost breakdown is by table rather than by count. */
interface Timing {
  n: number;
  totalMs: number;
  maxMs: number;
}

interface Counter {
  tables: Map<string, number>;
  /**
   * Wire time keyed by PostgREST table (or `auth:*`). The `tables` count above
   * cannot stand in for this: a table read twice can outweigh one read fourteen
   * times, and the count says the opposite.
   */
  timings: Map<string, Timing>;
  /** HTTP calls timed by {@link timedFetch} (queries + auth, not just `.from`). */
  httpCalls: number;
  /** Summed duration of every HTTP call. Exceeds wall-clock when they overlap. */
  summedMs: number;
  /** Wall-clock time with AT LEAST ONE call in flight. Never exceeds wall-clock. */
  busyMs: number;
  /** Most calls in flight at once. 1 means the page is fully serialized. */
  peakInFlight: number;
  inFlight: number;
  busySince: number;
}

const counters = new AsyncLocalStorage<Counter>();

/**
 * Time one page render and report the queries it issued. `label` is the route.
 * Logs on the way out even if the render throws, so a failed page still reports.
 *
 * The three timing numbers answer different questions, and the query COUNT alone
 * cannot separate them:
 *
 * - `busy` is wall-clock with at least one request open. `render − busy` is time
 *   the page spent NOT waiting on the network, which is CPU (deriving segments,
 *   splitting daily series, the water graph walk) plus framework overhead.
 * - `summed` is every call's duration added up. `summed / busy` is the effective
 *   concurrency: at 1.0 the page is issuing its requests one after another and
 *   the fix is fewer dependency waves; at 8.0 it is already fanning out and the
 *   fix is fewer or cheaper queries.
 * - `peak` is the most in flight at once, which catches a connection-pool ceiling
 *   that `summed / busy` would otherwise read as "the code is serial".
 */
export async function probe<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!PERF_ENABLED) return fn();

  const counter: Counter = {
    tables: new Map(),
    timings: new Map(),
    httpCalls: 0,
    summedMs: 0,
    busyMs: 0,
    peakInFlight: 0,
    inFlight: 0,
    busySince: 0,
  };
  const startedAt = performance.now();
  try {
    return await counters.run(counter, fn);
  } finally {
    const ms = Math.round(performance.now() - startedAt);
    let total = 0;
    for (const n of counter.tables.values()) total += n;
    // Busiest tables first. Show a long list: truncating it once hid the fact
    // that a page was issuing queries the summary line never mentioned.
    const breakdown = [...counter.tables.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([table, n]) => `${table}×${n}`)
      .join(" ");
    const busy = Math.round(counter.busyMs);
    const summed = Math.round(counter.summedMs);
    const concurrency = busy > 0 ? (counter.summedMs / counter.busyMs).toFixed(1) : "0";
    console.log(
      `[perf] ${label} ${ms}ms ${total} queries | ` +
        `db busy ${busy}ms, off-db ${ms - busy}ms, summed ${summed}ms ` +
        `across ${counter.httpCalls} http, concurrency ${concurrency}x, peak ${counter.peakInFlight} | ` +
        breakdown
    );
    // Second line, by COST rather than by count — the one that says what to fix.
    const byCost = [...counter.timings.entries()]
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .slice(0, 15)
      .map(
        ([name, t]) =>
          `${name} ${t.n}× ${Math.round(t.totalMs)}ms (max ${Math.round(t.maxMs)}ms)`
      )
      .join(", ");
    console.log(`[perf] ${label} cost by table | ${byCost}`);
  }
}

/**
 * A `fetch` that reports how long the Supabase client spends on the wire, into
 * the enclosing {@link probe}.
 *
 * Timing at the fetch layer rather than around the query builder is what makes
 * this honest: it catches the paginated `range()` loops and the auth round trips,
 * neither of which is one `.from()` call, and it measures the request the client
 * actually issued rather than the moment a caller awaited it.
 *
 * Injected into the client by `@/lib/supabase/request-client` so that
 * `@/lib/supabase/server` stays free of `server-only` / `node:async_hooks` —
 * that module is transitively imported by client components and must not pull
 * either in.
 */
/**
 * The table a Supabase request is against, from its URL — `/rest/v1/<table>` for
 * a query, `/auth/v1/<action>` for a session call. Reading it here rather than at
 * `.from()` is what lets the breakdown include the auth round trips and count a
 * paginated `range()` loop as the N requests it really is.
 */
function endpointOf(input: Parameters<typeof fetch>[0]): string {
  try {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const { pathname } = new URL(href);
    // Name the function, not just "rpc" — the whole point of the RPC migration
    // is that a function call and a direct table read cost wildly different
    // amounts, so a breakdown that cannot tell them apart hides the answer.
    const rpc = pathname.match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (rpc) return `rpc:${rpc[1]}`;
    const rest = pathname.match(/\/rest\/v1\/([^/?]+)/);
    if (rest) return rest[1];
    const auth = pathname.match(/\/auth\/v1\/([^/?]+)/);
    if (auth) return `auth:${auth[1]}`;
    return pathname;
  } catch {
    return "unknown";
  }
}

export function timedFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const counter = counters.getStore();
    if (!counter) return base(input, init);

    const endpoint = endpointOf(input);
    const startedAt = performance.now();
    if (counter.inFlight === 0) counter.busySince = startedAt;
    counter.inFlight += 1;
    counter.httpCalls += 1;
    if (counter.inFlight > counter.peakInFlight) {
      counter.peakInFlight = counter.inFlight;
    }
    try {
      return await base(input, init);
    } finally {
      const now = performance.now();
      const took = now - startedAt;
      counter.summedMs += took;
      const t = counter.timings.get(endpoint) ?? { n: 0, totalMs: 0, maxMs: 0 };
      t.n += 1;
      t.totalMs += took;
      if (took > t.maxMs) t.maxMs = took;
      counter.timings.set(endpoint, t);
      counter.inFlight -= 1;
      // Close the busy window only when the LAST open call finishes, so
      // overlapping calls count once against wall-clock rather than N times.
      if (counter.inFlight === 0) counter.busyMs += now - counter.busySince;
    }
  };
}

/**
 * Wrap a Supabase client so every `.from(table)` is tallied against the enclosing
 * {@link probe}. Only `from` is intercepted and the underlying builder is returned
 * untouched, so query construction, RLS and results are all unchanged — this
 * cannot alter what a page reads, only observe that it read.
 */
export function countQueries(client: SupabaseClient): SupabaseClient {
  if (!PERF_ENABLED) return client;

  return new Proxy(client, {
    get(target, prop) {
      // `target` as the receiver, not the proxy: supabase-js reads private
      // fields off `this`, and handing it the proxy would break them.
      const value = Reflect.get(target, prop, target);
      if (prop !== "from" || typeof value !== "function") return value;

      return (...args: unknown[]) => {
        const counter = counters.getStore();
        if (counter) {
          const table = String(args[0]);
          counter.tables.set(table, (counter.tables.get(table) ?? 0) + 1);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
