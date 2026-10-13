import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A per-request timeline of what the server actually waited on.
 *
 * `query-probe.ts` answers "which Supabase table cost what", and only when
 * `PERF_LOG=1`. It cannot see the two other things a `/production` render waits
 * on, and after the RLS work those are most of the time: the RRC mirror on Tiger
 * Cloud (`src/lib/scout/rrc-db.ts`, a different database entirely, reached
 * through `pg` rather than PostgREST) and the Yahoo price feed
 * (`src/lib/pricing/feed.ts`, an external HTTP call). A page can therefore show
 * a tiny `db busy` and still take four seconds, which is exactly what happened.
 *
 * This is always on. It is a handful of `performance.now()` calls and array
 * pushes per request, which is nothing beside the round trips it measures, and
 * an instrument that has to be switched on is an instrument nobody has switched
 * on when they need it.
 *
 * Storage rides the existing request scope so entries die with the request and
 * two concurrent renders cannot mix. Outside a scope every function here is a
 * no-op, so scripts, tests and route handlers are unaffected.
 */

export interface Span {
  /** Coarse bucket, so a reader can sum by dependency rather than by call. */
  source: "supabase" | "rrc" | "http" | "phase";
  label: string;
  ms: number;
  /**
   * When the call STARTED, ms after the timeline opened. Counts and durations
   * say how much a page waits; only start offsets say how deep the dependency
   * chain is. A page issuing 36 calls at 3.7x concurrency is ~10 serial round
   * trips deep, and that depth, not the count, is what is left to cut once the
   * fan-outs are gone.
   */
  at: number;
}

/**
 * Its own AsyncLocalStorage rather than a slot in the memo store.
 *
 * The memo store holds PROMISES, and `record` is called from `finally` blocks
 * where there is nothing to await. A first cut tried to read the promise
 * synchronously and silently recorded nothing. Storing the array directly keeps
 * every function here synchronous, which is what the call sites need.
 */
const timelines = new AsyncLocalStorage<{
  spans: Span[];
  openedAt: number;
  /** `process.cpuUsage()` when the timeline opened; see `readCpuMs`. */
  cpuAt: NodeJS.CpuUsage;
}>();

function spans(): Span[] | null {
  return timelines.getStore()?.spans ?? null;
}

/**
 * Run `fn` with a timeline open. Nested calls reuse the outer one, matching
 * `withRequestScope`, so wrapping an inner aggregation is safe.
 */
export function withTimeline<T>(fn: () => Promise<T>): Promise<T> {
  const existing = timelines.getStore();
  if (existing) return fn();
  return timelines.run({ spans: [], openedAt: performance.now(), cpuAt: process.cpuUsage() }, fn);
}

/**
 * CPU the PROCESS has spent since the timeline opened, user plus system, ms.
 *
 * Process-wide, so on a busy dev server it can include a compile or another
 * request; on an idle one it is this render's compute. It exists because a
 * render whose reads end at 1.5s and whose wall is 3.3s has 1.8s that no span
 * explains, and without this line that gap looked like a missing instrument
 * rather than what it was: series derivation over years of readings.
 */
export function readCpuMs(): number | null {
  const store = timelines.getStore();
  if (!store) return null;
  const d = process.cpuUsage(store.cpuAt);
  return Math.round((d.user + d.system) / 1000);
}

/** When the last recorded span ENDED, ms after the timeline opened. */
export function lastSpanEndMs(list: Span[] = readTimeline()): number {
  let end = 0;
  for (const s of list) end = Math.max(end, s.at + s.ms);
  return end;
}

/** Record a completed span. No-op outside a request that opened a timeline. */
export function record(source: Span["source"], label: string, ms: number, startedAt?: number): void {
  const store = timelines.getStore();
  if (!store) return;
  const at = startedAt == null ? performance.now() - ms : startedAt;
  store.spans.push({ source, label, ms: Math.round(ms), at: Math.round(at - store.openedAt) });
}

/** Time `fn` and record it. Records on failure too: a slow error still waited. */
export async function timed<T>(
  source: Span["source"],
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    record(source, label, performance.now() - startedAt, startedAt);
  }
}

/** Everything recorded so far, newest last. */
export function readTimeline(): Span[] {
  return spans() ?? [];
}

/**
 * Collapse the timeline into one line per (source, label), with call counts.
 *
 * Summing is the point: 33 RRC calls of 100ms each is a different problem from
 * one call of 3.3s, and a raw list of spans hides which it is.
 */
export function summarize(list: Span[] = readTimeline()) {
  const byKey = new Map<string, { source: Span["source"]; label: string; n: number; ms: number }>();
  for (const s of list) {
    const k = `${s.source}:${s.label}`;
    const cur = byKey.get(k);
    if (cur) {
      cur.n += 1;
      cur.ms += s.ms;
    } else {
      byKey.set(k, { source: s.source, label: s.label, n: 1, ms: s.ms });
    }
  }
  const rows = [...byKey.values()].sort((a, b) => b.ms - a.ms);
  const totals = { supabase: 0, rrc: 0, http: 0, phase: 0 };
  for (const r of rows) totals[r.source] += r.ms;
  return { rows, totals };
}
