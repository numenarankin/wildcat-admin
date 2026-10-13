import { NextResponse } from "next/server";
import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { hasRrcDb } from "@/lib/scout/rrc-db";
import { rrcQuery } from "@/lib/scout/rrc-db";
import { allocatedByTestBatch, getCycleEdge } from "@/lib/scout/rrc-queries";
import {
  GAS_KEYS,
  monthlyRate,
  OIL_KEYS,
} from "@/lib/scout/allocate-months";

/**
 * Test-weighted production for a handful of wells, for map hover.
 *
 * A map cannot carry rates in its source data: the statewide layer holds every
 * hole in Texas and the dossier maps are built from a list that has no volumes
 * on it. So the rate is fetched for the hole under the cursor, in batches, and
 * cached client-side.
 *
 * Platform admins only, like every route in this app.
 */
export async function GET(request: Request) {
  // First, before even the empty answer: an outsider gets the admin side's
  // 404 whatever the query, so the route does not show itself.
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const url = new URL(request.url);
  const apis = (url.searchParams.get("api") ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 25);
  if (apis.length === 0) return NextResponse.json({ rates: {} });
  if (!hasRrcDb()) return NextResponse.json({ rates: {} });

  try {
    // The name too: a map dot carries an API and nothing else, and "Roach 7"
    // is what a reader recognises.
    const names = rrcQuery<{
      api_number: string;
      lease_name: string | null;
      well_no: string | null;
    }>(
      `select distinct on (api_number) api_number, lease_name, well_no
         from rrc.wellbore
        where api_number = any($1)
        order by api_number, on_schedule desc nulls last`,
      [apis.map((a) => a.replace(/\D/g, "").slice(-8))]
    );

    /*
     * THE SAME SERIES THE WELL'S OWN PAGE DRAWS.
     *
     * `allocatedByTest` is what `getWellDossier` puts on the Production tab, and
     * `trailingVolume` is what that tab's headline sums, so the hover label and
     * the modal cannot disagree. They did: the hover used to take the latest
     * month with any volume and multiply by a share, which reported a rate for
     * wells that had been shut in for years and a gas figure the modal showed as
     * zero.
     */
    const { reported } = await getCycleEdge();
    const rates: Record<
      string,
      { name?: string; oil: number; gas: number; cycle: string }
    > = {};
    /*
     * ONE batched read for the whole request, not one per API.
     *
     * `allocatedByTestBatch` reads each RECORD once for every well in the
     * batch, which is the thing it exists for: a map view's wells share leases,
     * so 25 holes are a handful of records. Mapping the single-well
     * `allocatedByTest` over the batch defeated that completely, because
     * `loadRecordSlices` caches on the exact API set - 25 single-well calls are
     * 25 cache keys, 25 `wellbore` reads, 25 `w10_test` reads, and one
     * `lease_production` read per WELL rather than per record.
     *
     * Measured over 150 wells, which is one map settle's prefetch: 511 queries
     * and 3.1-5.8 s against 13 queries and 371 ms. The pool is 20 connections
     * wide, so the fan-out also queued whatever the user clicked next behind
     * it. See docs/scout-load-profile.md.
     */
    // Only `monthlyRate`'s trailing year is read off each series below.
    const byApi = await allocatedByTestBatch(apis, reported, { trailing: 12 });
    for (const api of apis) {
      // Keyed back to the string the caller asked with; the batch keys by
      // 8-digit API, the same normalisation `apiDigits` applies.
      const months = byApi.get(api.replace(/\D/g, "").slice(-8)) ?? [];
      if (months.length === 0) continue;
      const last = [...months].reverse().find((m) => m.reported);
      rates[api] = {
        oil: monthlyRate(months, OIL_KEYS),
        gas: monthlyRate(months, GAS_KEYS),
        cycle: last?.cycle ?? "",
      };
    }

    for (const row of await names) {
      const label = [row.lease_name?.trim(), row.well_no?.trim()]
        .filter(Boolean)
        .join(" ");
      if (!label) continue;
      const at = rates[row.api_number];
      if (at) at.name = label;
      else rates[row.api_number] = { name: label, oil: 0, gas: 0, cycle: "" };
    }
    return NextResponse.json({ rates });
  } catch (error) {
    // A rate is context, not content: the popup keeps its identity lines.
    console.error("[scout] well-rate lookup failed", error);
    return NextResponse.json({ rates: {} });
  }
}
