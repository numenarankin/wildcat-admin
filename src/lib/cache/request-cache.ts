import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped memoization for repeated reads inside one aggregation.
 *
 * The company-wide production build (`getCompanyProduction`) fans out per well,
 * and each well's series independently re-loads the SAME org-wide data: every
 * tank, every water meter, the whole flow graph, each tank's readings + run
 * tickets. With W wells that is W identical copies of each query (measured at
 * 1,005 queries / 5.7s for a 40-well org). Nothing mutates mid-read, so every
 * copy after the first is pure waste.
 *
 * Why AsyncLocalStorage and not React's `cache()`: `cache()` is only scoped
 * inside a React render. In a Route Handler it silently re-invokes on every
 * call (verified against Next 16.2.9 — two calls to one cached function in one
 * request returned two different objects), and the dashboard brief IS a Route
 * Handler, so a `cache()`-based memo would do nothing exactly where it matters
 * most. ALS is scoped by {@link withRequestScope} and behaves the same in a
 * Server Component, a Route Handler, a Server Action and a cron script.
 *
 * Scoping rules that keep this from ever serving the wrong rows:
 *
 * 1. **Per scope.** Entries live in the store created by `withRequestScope` and
 *    die with it. Outside any scope, memoization is skipped entirely.
 * 2. **Per Supabase client.** Keyed on the client object, so an RLS client and a
 *    service-role client (which see different rows) can never read each other's
 *    entries, and a cron looping orgs keeps one cache per org's client.
 *
 * Only READ paths use this. A write followed by a re-read in the same scope
 * would see the pre-write value, so mutations must not route through it.
 */

type Store = Map<string, Promise<unknown>>;

const scopes = new AsyncLocalStorage<WeakMap<object, Store>>();

/**
 * Run `fn` with a memo scope. Nested calls reuse the outer scope, so wrapping an
 * inner aggregation is safe and lets sibling aggregations in one request share
 * their reads when an outer wrapper exists.
 */
export function withRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  const existing = scopes.getStore();
  if (existing) return fn();
  return scopes.run(new WeakMap(), () => batches.run(new WeakMap(), fn));
}

/**
 * Run `load()` at most once per (`scope`, `key`) within the enclosing
 * {@link withRequestScope}. `scope` is the Supabase client the read goes
 * through; `key` must fully identify the query, including every argument that
 * changes its result.
 */
export function memo<T>(
  scope: object,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const byClient = scopes.getStore();
  if (!byClient) return load(); // no scope established — no memoization
  let store = byClient.get(scope);
  if (!store) byClient.set(scope, (store = new Map()));
  const hit = store.get(key);
  if (hit) return hit as Promise<T>;
  // Drop a rejected promise so a transient failure isn't cached for the scope.
  const pending = load().catch((err) => {
    store.delete(key);
    throw err;
  });
  store.set(key, pending);
  return pending;
}

/**
 * Memoize a value that belongs to the scope itself rather than to a client (the
 * request's Supabase client, a whole aggregation's result). Same lifetime rules.
 */
const SCOPE_KEY = {};
export function memoScope<T>(key: string, load: () => Promise<T>): Promise<T> {
  return memo(SCOPE_KEY, key, load);
}

/**
 * The entry already in the scope under `key`, or `undefined` if there is none.
 *
 * For the case where one cached read is a SUPERSET of another: a caller that
 * wants a narrower slice can check whether the wider one is already in hand and
 * narrow it in memory rather than issuing a second query for rows the request
 * has already paid for. Unlike {@link memo} this never starts a load, so a miss
 * costs nothing and the caller simply proceeds as before.
 *
 * Returns the PENDING promise when the wider read is still in flight, which is
 * the common case for siblings inside one `Promise.all` — awaiting it is what
 * makes the two share a single round trip.
 */
export function memoScopePeek<T>(key: string): Promise<T> | undefined {
  const byClient = scopes.getStore();
  if (!byClient) return undefined;
  return byClient.get(SCOPE_KEY)?.get(key) as Promise<T> | undefined;
}

/**
 * Whether `key` is already held for `scope`, without starting a load.
 *
 * The prime loaders use this to fetch ONLY the ids that are not yet in hand.
 * Without it, two callers priming overlapping id sets each issued the whole bulk
 * query again, because the bulk memo was keyed on the exact id list: measured as
 * `rpc/meter_readings_for_meters` 20x on one render, every call a different
 * subset of the same meters.
 */
export function memoHas(scope: object, key: string): boolean {
  const byClient = scopes.getStore();
  if (!byClient) return false;
  return byClient.get(scope)?.has(key) ?? false;
}

/**
 * Seed an entry that a batch read already resolved, so the per-entity accessor
 * finds it instead of issuing its own query. Lets one `IN (...)` query stand in
 * for N single-row ones without changing what the callers ask for. Never
 * overwrites an entry already present. No-op outside a scope.
 */
export function memoPreset<T>(scope: object, key: string, value: T): void {
  const byClient = scopes.getStore();
  if (!byClient) return;
  let store = byClient.get(scope);
  if (!store) byClient.set(scope, (store = new Map()));
  if (!store.has(key)) store.set(key, Promise.resolve(value));
}


/* ------------------------------------------------------------------ *
 * Per-entity reads that coalesce into one query per tick
 * ------------------------------------------------------------------ */

interface Batch<T> {
  ids: Set<string>;
  waiters: Map<string, { resolve: (v: T) => void; reject: (e: unknown) => void }>;
  scheduled: boolean;
}

const batches = new AsyncLocalStorage<WeakMap<object, Map<string, Batch<unknown>>>>();

/**
 * A per-entity read that is issued as ONE bulk query for every id requested in
 * the same tick.
 *
 * Why priming alone was not enough. `primeSeriesInputs` bulk-loads and seeds
 * the per-entity entries, but only once its own reads return; any caller that
 * asks for an entity BEFORE that (the pricing path runs concurrently in the
 * same `Promise.all`) misses and fetches alone. On a database answering in
 * 20ms the prime always won that race and the harness saw one RPC. On the
 * production database at ~500ms per call it always lost: measured at
 * `rpc/meter_readings_for_meters` 20x and `rpc/tank_readings_for_tanks` 8x in
 * one render. A race cannot be fixed by getting to the line first.
 *
 * So the per-entity accessor itself coalesces. The first request for a family
 * in a tick opens a batch and schedules a flush on the next macrotask; every
 * further request in that window joins it; the flush runs `loadMany` once and
 * settles each waiter. Whoever asks first, and in whatever order, N concurrent
 * requests become one round trip. Priming becomes an optimisation (it fills
 * the batch early with the whole fleet) rather than a requirement.
 *
 * Each id's promise is stored in the memo the moment it is requested, so a
 * repeat request for the same id in any later tick is a memo hit, and
 * `memoHas` reports it present while still in flight. Outside a request scope
 * the read is issued directly for that one id, unchanged behaviour.
 */
export function batched<T>(
  scope: object,
  family: string,
  id: string,
  loadMany: (ids: string[]) => Promise<Map<string, T>>,
  empty: () => T
): Promise<T> {
  const byClient = scopes.getStore();
  const batchStore = batches.getStore();
  if (!byClient || !batchStore) {
    return loadMany([id]).then((m) => m.get(id) ?? empty());
  }
  const key = `${family}:${id}`;
  let store = byClient.get(scope);
  if (!store) byClient.set(scope, (store = new Map()));
  const hit = store.get(key);
  if (hit) return hit as Promise<T>;

  let perScope = batchStore.get(scope);
  if (!perScope) batchStore.set(scope, (perScope = new Map()));
  let batch = perScope.get(family) as Batch<T> | undefined;
  if (!batch) {
    batch = { ids: new Set(), waiters: new Map(), scheduled: false };
    perScope.set(family, batch as Batch<unknown>);
  }

  const promise = new Promise<T>((resolve, reject) => {
    batch!.ids.add(id);
    batch!.waiters.set(id, { resolve, reject });
  });
  store.set(key, promise);

  if (!batch.scheduled) {
    batch.scheduled = true;
    const current = batch;
    // A macrotask, not a microtask: callers inside `Promise.all` register
    // across several microtask turns, and a microtask flush would split them
    // into several queries. One timer tick gathers the whole wave.
    // Where a batch was opened from, for `PERF_TRACE_BATCH=1`: a batch that
    // flushes a wave late is only fixable once its first requester is known.
    const openedBy =
      process.env.PERF_TRACE_BATCH === "1" ? new Error().stack?.split("\n")[3]?.trim() : undefined;
    setTimeout(() => {
      perScope!.delete(family);
      const ids = [...current.ids];
      if (openedBy) console.info(`[batch] ${family} x${ids.length} opened by ${openedBy}`);
      loadMany(ids).then(
        (m) => {
          for (const [wid, w] of current.waiters) w.resolve(m.get(wid) ?? empty());
        },
        (err) => {
          for (const [wid, w] of current.waiters) {
            // Drop the failed entry so a later request retries rather than
            // re-throwing a stale error for the rest of the request.
            store!.delete(`${family}:${wid}`);
            w.reject(err);
          }
        }
      );
    }, 0);
  }
  return promise;
}
