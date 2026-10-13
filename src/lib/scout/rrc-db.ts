import { timed } from "@/lib/perf/timeline";

const INJECTED_LATENCY_MS = Number(process.env.PERF_LATENCY_MS ?? 0) || 0;
import "server-only";

import { Pool, types, type QueryResultRow } from "pg";

// pg returns int8 and numeric as STRINGS, because either can exceed
// Number.MAX_SAFE_INTEGER. Every value in this mirror is a production volume, a
// count, or a depth — the largest is statewide monthly oil at ~1.4e8, eight
// orders of magnitude below the safe limit. Left as strings they would silently
// concatenate instead of summing in any chart code, so parse them here once.
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.NUMERIC, (v) =>
  v === null ? null : Number(v)
);

/**
 * Read-only client for the Tiger Cloud RRC mirror — the Texas Railroad
 * Commission's public record, loaded and verified per
 * `docs/plans/scout-tiger-wiring.md`.
 *
 * This is a DIFFERENT SERVER from both Wildcat's and Archon's Supabase
 * projects. `@supabase/supabase-js` speaks PostgREST and cannot reach it, which
 * is why this module uses `pg` directly.
 *
 * Why no RLS and no per-user client: everything in the `rrc` schema is public
 * state record data with no per-tenant rows — there is nothing to hide from one
 * signed-in user versus another. Access control here is about the CREDENTIAL, not
 * about row visibility: this connection bypasses RLS, so an ungated caller is a
 * scraping endpoint. **This module carries no authorization of its own.** Every caller MUST gate first, exactly as `archon-db.ts` requires:
 *
 *   - pages          -> `requirePlatformAdmin()`
 *   - server actions -> `assertPlatformAdmin()`
 *   - route handlers -> `notFoundUnlessPlatformAdmin()`
 *
 * `server-only` keeps the connection string out of every client bundle.
 */

let pool: Pool | null = null;

/** True when the mirror is configured (else the RRC screens should 503). */
export function hasRrcDb(): boolean {
  return Boolean(process.env.RRC_DATABASE_URL);
}

/**
 * Tiger issues its certificate from a chain Node does not trust by default.
 *
 * As of pg 8.22, `sslmode=require` in a connection string is treated as
 * `verify-full`, so the URL Tiger hands you fails with
 * SELF_SIGNED_CERT_IN_CHAIN. `uselibpqcompat=true` restores libpq's meaning of
 * `require` — the connection is still encrypted, the certificate chain is not
 * verified — which is what the URL was always intended to say.
 *
 * This is transport encryption without server identity verification. Acceptable
 * here because the mirror holds only public state records and the credential is
 * scoped to it; it would NOT be acceptable for customer data.
 */
function normalizeUrl(url: string): string {
  if (url.includes("uselibpqcompat")) return url;
  return url + (url.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

export function getRrcPool(): Pool {
  const raw = process.env.RRC_DATABASE_URL;
  if (!raw) {
    throw new Error("The RRC mirror is not configured: set RRC_DATABASE_URL");
  }
  const url = normalizeUrl(raw);
  // Cached at module scope: a pool per request would exhaust the service, which
  // reports max_connections = 105. Every query this app issues is indexed or
  // pre-aggregated and returns in well under a second; what sizes the pool is
  // CONCURRENCY, since the record split reads one slice per lease record at
  // once. At 10, a 14-record fleet's cold wave split into a 190ms group and a
  // 385ms group (the four queued behind the first ten); 20 covers a fleet
  // twice that size in one wave.
  pool ??= new Pool({
    connectionString: url,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // The guard rail from the wiring plan §5: every legitimate query measured
    // between 23 ms and 193 ms, while an unaggregated scan of the 78.6M-row
    // lease table takes ~16 s. A statement timeout turns "one bad query took the
    // page down" into a single failed request.
    statement_timeout: 5_000,
  });
  return pool;
}

/** Run a parameterised read. Never interpolate user input into `text`. */
export async function rrcQuery<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  // Timed because the RRC mirror is a SEPARATE database and is invisible to the
  // Supabase probe. After the RLS work it is one of the largest remaining costs
  // on /production, and nothing was measuring it.
  return timed("rrc", rrcLabel(text), async () => {
    // Measurement-only latency; see `PERF_LATENCY_MS` in request-client.ts.
    if (INJECTED_LATENCY_MS > 0) await new Promise((r) => setTimeout(r, INJECTED_LATENCY_MS));
    const res = await getRrcPool().query<T>(text, params as unknown[]);
    return res.rows;
  });
}

/**
 * A stable, short label for a query: the first table it names. The full SQL
 * would be unreadable in a log line and unstable across whitespace edits.
 */
function rrcLabel(text: string): string {
  const m = /\bfrom\s+([a-z_][a-z0-9_.]*)/i.exec(text);
  return m ? m[1] : "query";
}

/**
 * Run a read that is KNOWN to exceed the pool's 5 s budget.
 *
 * Raising the global timeout would remove the guard that stops an accidental
 * full scan taking the page down, so the budget is lifted per query on a
 * dedicated connection instead. `SET LOCAL` scopes it to the transaction, so
 * the connection returns to the pool with the normal limit.
 *
 * There is exactly one caller today: operator-grain disposition, which spans
 * every lease an operator has ever held across 48.5M rows. Adding a second
 * caller should prompt an aggregate, not another exemption.
 */
export async function rrcQuerySlow<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  timeoutMs = 30_000
): Promise<T[]> {
  return timed("rrc", `${rrcLabel(text)} (slow)`, () =>
    rrcQuerySlowInner<T>(text, params, timeoutMs)
  );
}

async function rrcQuerySlowInner<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[],
  timeoutMs: number
): Promise<T[]> {
  const client = await getRrcPool().connect();
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = ${Number(timeoutMs)}`);
    const res = await client.query<T>(text, params as unknown[]);
    await client.query("commit");
    return res.rows;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** First row or null — for the many "fetch one dossier header" reads. */
export async function rrcQueryOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T | null> {
  const rows = await rrcQuery<T>(text, params);
  return rows[0] ?? null;
}
