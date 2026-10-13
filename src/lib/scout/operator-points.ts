import type { OperatorPoint } from "@/lib/scout/types";

/**
 * Load + cache the operator points (placed by mailing ZIP) for operator mode.
 *
 * Archon fetches `/operators.json` straight out of `public/`; Scout goes through
 * the gated `/api/scout/operators` route instead, since the payload must not be
 * publicly reachable. Same shape, same client-side cache.
 */

let operatorsCache: OperatorPoint[] | null = null;

export async function loadOperatorPoints(): Promise<OperatorPoint[]> {
  if (operatorsCache) return operatorsCache;
  // `no-cache` = always revalidate with the server (a conditional request that
  // 304s when the file is unchanged), never serve a stale body from the HTTP
  // cache. This matters because the payload's SHAPE changes when the sync script
  // adds fields: an early build of this route sent `max-age=86400`, so browsers
  // held a pre-production copy for a day and every production/revenue filter
  // silently matched nothing. Revalidating costs one round-trip per page load.
  const res = await fetch("/api/scout/operators", { cache: "no-cache" });
  if (!res.ok) throw new Error(`operators ${res.status}`);
  operatorsCache = (await res.json()) as OperatorPoint[];
  return operatorsCache;
}
