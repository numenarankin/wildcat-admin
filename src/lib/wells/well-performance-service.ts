/**
 * Server-side loader for the Well Test Report (GBC-11).
 *
 * Loads the org's wells + tests + downtime through the request-scoped RLS client
 * (so everything is org-scoped) and hands them to the pure aggregation. Shared
 * by the reports-hub View modal (via a `"use server"` wrapper) and the export
 * route, so both render identical figures. Plain server module (not
 * `"use server"`) so the export route can import it directly.
 */

import { getSupabaseServer } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { getWells } from "@/lib/wells/wells";
import { listAllWellTests } from "@/lib/wells/well-tests";
import { listAllWellEvents } from "@/lib/wells/well-events";
import {
  summarizeWellPerformance,
  type WellPerformanceReport,
} from "@/lib/wells/well-performance";

/** Today as an ISO `YYYY-MM-DD` string (the report's default as-of date). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the company-wide Well Test Report as of today. Producers only
 * (injection/SWD wells aren't rate-tested for allocation). Empty when Supabase
 * isn't configured (local/preview) so the modal still renders.
 */
export async function loadWellPerformanceReport(): Promise<WellPerformanceReport> {
  const asOf = today();
  if (!hasSupabase()) {
    return summarizeWellPerformance([], [], [], { asOf });
  }
  const sb = await getSupabaseServer();
  const [wells, tests, events] = await Promise.all([
    getWells(),
    listAllWellTests(sb),
    listAllWellEvents(sb),
  ]);
  const producers = wells
    .filter((w) => w.type !== "injection")
    .map((w) => ({ id: w.id, name: w.name }));
  return summarizeWellPerformance(producers, tests, events, { asOf });
}
