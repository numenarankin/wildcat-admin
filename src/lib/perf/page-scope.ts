import "server-only";
import { withRequestScope } from "@/lib/cache/request-cache";
// Side effect: installs the timeline fetch on every Supabase client, including
// the ones built by `getSupabaseServer()` directly. Without it a page whose
// loaders never touch the shared client reports a wall time with no rows.
import "@/lib/supabase/request-client";
import { probe } from "@/lib/perf/query-probe";
import { withTimeline, summarize, readTimeline, readCpuMs, lastSpanEndMs } from "@/lib/perf/timeline";

/**
 * What a page body should be wrapped in.
 *
 * Does two things that belong together:
 *
 * 1. Opens the request's memo scope. Every company-wide aggregation opens its own
 *    scope when none encloses it, so as siblings on one page they each got a
 *    private store AND a private Supabase client and shared nothing — on
 *    /production that meant `getWellProductionRates()` and `getAnalyticsSummary()`
 *    derived the same per-well series twice over. One outer scope collapses them.
 * 2. Reports what the render actually cost, under `PERF_LOG=1`. The caching work
 *    is close to invisible in wall-clock on a small org and obvious in query
 *    count, so every phase in `performance-audit.md` is signed off against this,
 *    not against "the page still renders".
 *
 * Both halves are no-ops in the wrong context: outside a request the memo is
 * skipped, and without `PERF_LOG=1` the probe calls straight through.
 */
export function scopedPage<T>(route: string, load: () => Promise<T>): Promise<T> {
  // `PERF_NO_SCOPE=1` drops the shared scope, reproducing pre-Phase-0 behaviour
  // (every aggregation with its own store and client) so a before/after can be
  // measured on ONE build instead of comparing two. Measurement only — never set
  // it in a deployed environment.
  // The timeline is outermost and always on: it must be open before any loader
  // runs, and unlike the probe it is not gated, because the question it answers
  // ("which dependency was slow") is the one asked when a page is already slow.
  const inner = () =>
    process.env.PERF_NO_SCOPE === "1"
      ? probe(route, load)
      : withRequestScope(() => probe(route, load));

  return withTimeline(async () => {
    const startedAt = performance.now();
    const stopProfile = await startProfileIfAsked(route);
    try {
      await flushIfAsked();
      return await inner();
    } finally {
      reportTimeline(route, Math.round(performance.now() - startedAt));
      await stopProfile();
    }
  });
}

/**
 * `PERF_CPU_PROFILE=<dir>` (the harness's server only) writes a V8 CPU profile
 * of each scoped render to that directory, so a compute tail can be attributed
 * to a function rather than guessed at. `--cpu-prof` on the process was the
 * obvious route and does not work here: the profile is written at exit, and
 * the harness kills the server.
 */
async function startProfileIfAsked(route: string): Promise<() => Promise<void>> {
  const dir = process.env.PERF_CPU_PROFILE;
  if (!dir) return async () => {};
  const { Session } = await import("node:inspector");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const session = new Session();
  session.connect();
  const post = (method: string) =>
    new Promise<unknown>((resolve, reject) =>
      session.post(method, (err, result) => (err ? reject(err) : resolve(result)))
    );
  await post("Profiler.enable");
  await post("Profiler.start");
  return async () => {
    const { profile } = (await post("Profiler.stop")) as { profile: unknown };
    session.disconnect();
    await mkdir(dir, { recursive: true });
    const file = `${dir}/${route.replace(/\//g, "_")}-${Date.now()}.cpuprofile`;
    await writeFile(file, JSON.stringify(profile));
    console.info(`[timeline] ${route} cpu profile written: ${file}`);
  };
}

/**
 * `PERF_RRC_FLUSH=1` (the harness's server only) lets a request carrying
 * `x-perf-rrc-cold: 1` start with the RRC process caches empty, so the render
 * measured is the cold one. Off, and not reachable, in every real environment.
 */
async function flushIfAsked(): Promise<void> {
  if (process.env.PERF_RRC_FLUSH !== "1") return;
  const { headers } = await import("next/headers");
  if ((await headers()).get("x-perf-rrc-cold") !== "1") return;
  const { clearRrcCaches } = await import("@/lib/rrc/record-split");
  clearRrcCaches();
}

/**
 * Print the timeline to the SERVER log, always, in the same shape the browser
 * console gets.
 *
 * Two readers, one format. A person debugging reads it in devtools; the page
 * performance harness (`scripts/perf-page.ts`) parses it out of the server's
 * stdout, because a harness cannot open a browser console and an instrument
 * only one of them can read is an instrument that stops being run.
 *
 * `PERF_TIMELINE=0` silences it for anyone who finds it noisy.
 */
function reportTimeline(route: string, wallMs: number): void {
  if (process.env.PERF_TIMELINE === "0") return;
  const all = readTimeline();
  const { rows, totals } = summarize(all);
  if (rows.length === 0) return;
  const width = Math.max(...rows.map((r) => r.label.length), 12);
  const lines = rows.map(
    (r) =>
      `  ${r.source.padEnd(9)} ${r.label.padEnd(width)}  ${String(r.n).padStart(3)}x  ${String(r.ms).padStart(6)}ms`
  );
  /*
   * The waterfall: every call in START order with its offset. This is the
   * only view that shows serial depth. Two calls at the same offset ran in
   * parallel; a call that starts when another ends was waiting on it.
   */
  const waterfall = [...all]
    .sort((a, b) => a.at - b.at)
    .map(
      (s) =>
        `    ${String(s.at).padStart(5)}ms +${String(s.ms).padStart(4)}  ${s.source.padEnd(8)} ${s.label}`
    );
  const cpu = readCpuMs();
  // The tail: wall time after the last dependency answered. Compute, or a
  // wait on something not instrumented; either way it is not the database.
  const tail = Math.max(0, wallMs - lastSpanEndMs(all));
  console.info(
    [
      `[timeline] ${route} server ${wallMs}ms${cpu == null ? "" : ` (cpu ${cpu}ms, tail after last read ${tail}ms)`}`,
      `  supabase ${totals.supabase}ms | rrc ${totals.rrc}ms | http ${totals.http}ms`,
      ...lines,
      `  waterfall (start offset, duration):`,
      ...waterfall,
    ].join("\n")
  );
}
