import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoScope } from "@/lib/cache/request-cache";
import { PERF_ENABLED, countQueries, timedFetch } from "@/lib/perf/query-probe";
import { record } from "@/lib/perf/timeline";
import { getSupabaseServer } from "@/lib/supabase/server";
import * as serverModule from "@/lib/supabase/server";

/**
 * The request's ONE RLS Supabase client.
 *
 * `getSupabaseServer()` deliberately builds a fresh client per call, and cannot
 * memoize itself: `@/lib/supabase/server` is transitively imported by client
 * components for its types and constants, so it must not pull in `server-only`
 * or `node:async_hooks`. That constraint is real and stays.
 *
 * The cost of it is that `@/lib/cache/request-cache` keys its store on the client
 * OBJECT, so two loaders that each call `getSupabaseServer()` get two clients and
 * therefore two stores, and share nothing — even inside a `withRequestScope`. A
 * page that awaits eight loaders was building eight clients and eight caches.
 *
 * This module is the server-only seam that fixes that: within a scope every
 * caller gets the same instance, so the `cached*` accessors in `@/lib/cache/loaders`
 * actually collapse to one read per query per request. Outside a scope it falls
 * through to a fresh client, so scripts, tests and any not-yet-wrapped caller keep
 * working exactly as before.
 *
 * READ PATHS. A server action that writes and then re-reads through a `cached*`
 * accessor in the same scope would see the pre-write value; use
 * `getSupabaseServer()` directly there (see the warning in `./cache/loaders`).
 */
export function getRequestSupabase(): Promise<SupabaseClient> {
  return memoScope("supabase-client", async () =>
    // Both inert unless PERF_LOG=1; see `@/lib/perf/query-probe`. `countQueries`
    // tallies which tables were hit, `timedFetch` times the wire underneath —
    // the count alone cannot tell a serial page from a slow one.
    countQueries(
      await getSupabaseServer(
        // The timeline fetch is ALWAYS installed; `timedFetch` (the PERF_LOG
        // probe) only wraps it when that is switched on. Two layers because they
        // answer different questions: the probe breaks a render down by table
        // for a developer chasing a query, the timeline sums Supabase against
        // RRC and Yahoo so a slow page can be attributed to a dependency at all.
        PERF_ENABLED ? timedFetch(timelineFetch) : timelineFetch
      )
    )
  );
}

/**
 * `fetch` that records each Supabase REST call on the request timeline.
 *
 * Labelled by PostgREST path, which is the table (or `rpc/<name>`), so the
 * summary reads the same way the probe's breakdown does.
 */
/**
 * Artificial per-call latency, MEASUREMENT ONLY. Set by the page performance
 * harness so a local database that answers in 20ms behaves like the production
 * one at several hundred; races that only exist at that speed (a per-entity
 * read issued before its bulk prime lands) are invisible without it. Unset in
 * every real environment, and a no-op when unset.
 */
const INJECTED_LATENCY_MS = Number(process.env.PERF_LATENCY_MS ?? 0) || 0;

/**
 * `PERF_TRACE_STACK=1` prints the app frames behind each call, so a read the
 * timeline shows twice can be attributed to its two callers without guessing.
 * Measurement only: capturing a stack per call is not free.
 */
const TRACE_STACK = process.env.PERF_TRACE_STACK === "1";

const timelineFetch: typeof fetch = async (input, init) => {
  const startedAt = performance.now();
  const label = supabasePath(input, init);
  if (TRACE_STACK) {
    const frames = (new Error().stack ?? "")
      .split("\n")
      .filter((l) => l.includes("/src/") && !l.includes("request-client"))
      .map((l) => l.trim().replace(/^at /, "").replace(/.*\/src\//, "src/").replace(/\?.*$/, ""))
      .slice(0, 4);
    console.info(`[stack] ${label} <- ${frames.join(" <- ")}`);
  }
  try {
    if (INJECTED_LATENCY_MS > 0) await new Promise((r) => setTimeout(r, INJECTED_LATENCY_MS));
    return await fetch(input, init);
  } finally {
    record("supabase", label, performance.now() - startedAt, startedAt);
  }
};

// Every client from `getSupabaseServer()` reports on the timeline too; see the
// note on `setDefaultSupabaseFetch`. Guarded: tests mock that module with only
// `getSupabaseServer`, and a module-level call on a missing export takes the
// whole import graph down with it.
try {
  // vitest's module mock THROWS on access to an export the mock did not
  // define, so the guard has to be a try, not a typeof.
  serverModule.setDefaultSupabaseFetch?.(timelineFetch);
} catch {
  // mocked module without the hook: nothing to register
}

function supabasePath(input: RequestInfo | URL, init?: RequestInit): string {
  try {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const table = u.pathname.replace("/rest/v1/", "").replace(/^\//, "") || "auth";
    /*
     * An RPC's arguments travel in the POST body and its page in the Range
     * header, and without them two reads of one function are indistinguishable:
     * a windowed read from a whole-history one, a first page from a third, a
     * chunk of 8 ids from a single straggler. `/leases` showed six
     * `tank_readings_for_tanks` calls in four waves and nothing in the label
     * said which were which.
     */
    if (table.startsWith("rpc/")) {
      const parts: string[] = [];
      try {
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        if (body) {
          for (const [k, v] of Object.entries(body)) {
            if (Array.isArray(v)) parts.push(`${v.length} ${k}`);
            else if (typeof v === "string" || typeof v === "number") parts.push(`${k} ${v}`);
          }
        }
      } catch {
        // not JSON; nothing to say about it
      }
      // postgrest-js encodes `.range()` as query params, not a Range header.
      const offset = u.searchParams.get("offset");
      const limit = u.searchParams.get("limit");
      if (offset || limit) parts.push(`offset ${offset ?? 0} limit ${limit ?? "all"}`);
      return parts.length > 0 ? `${table} [${parts.join(", ")}]` : table;
    }
    /*
     * The projection, so two reads of one table are distinguishable in the
     * timeline. `wells` read three times in a render is three different
     * callers with three different `select`s, and a label of just the table
     * cannot say which one is the stray. Truncated: joins run long.
     */
    const select = u.searchParams.get("select");
    return select && select !== "*" ? `${table} [${select.slice(0, 48)}]` : table;
  } catch {
    return "unknown";
  }
}
