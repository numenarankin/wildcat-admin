/**
 * `disposal_readings` data-access — the hand-entered injection log.
 *
 * A leaf module (client-injected, no other disposal imports) so both the disposal
 * facade (`disposal.ts`) and the series loader (`well-meters.ts`) can read these
 * rows without importing each other.
 *
 * These readings are the UNMETERED fallback. Once a water meter is wired into a
 * well, the meter is that well's measurement and these rows stop counting on the
 * dates it covers — see `well-series.ts`. Nothing here decides that; it loads rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { memo } from "@/lib/cache/request-cache";
import type { DisposalReading } from "@/lib/disposal/types";

interface DisposalReadingRow {
  id: string;
  injection_well_id: string;
  reading_date: string;
  reading_time: string | null;
  injected_bbls: number | null;
  injection_pressure: number | null;
  casing_pressure: number | null;
  meter_reading: number | null;
  source_well_id: string | null;
  notes: string | null;
}

const READING_COLS =
  "id, injection_well_id, reading_date, reading_time, injected_bbls, " +
  "injection_pressure, casing_pressure, meter_reading, source_well_id, notes";

function mapReading(r: DisposalReadingRow): DisposalReading {
  return {
    id: r.id,
    wellId: r.injection_well_id,
    date: r.reading_date,
    time: (r.reading_time ?? "").slice(0, 5),
    injectedBbls: r.injected_bbls ?? null,
    injectionPressure: r.injection_pressure,
    casingPressure: r.casing_pressure,
    meterReading: r.meter_reading,
    sourceWellId: r.source_well_id,
    notes: r.notes ?? "",
  };
}

/**
 * Hand-entered disposal readings, oldest first. Pass `wellId` for one well, or
 * omit it for the whole org. RLS scopes the read to the caller's org.
 */
export function listDisposalReadings(
  sb: SupabaseClient,
  wellId?: string
): Promise<DisposalReading[]> {
  // Once per request per client: several loaders on one page read this
  // table each on their own (measured 3-5x on the disposal well page).
  return memo(sb, `disposal-readings:${wellId ?? "all"}`, () => loadDisposalReadings(sb, wellId));
}

async function loadDisposalReadings(
  sb: SupabaseClient,
  wellId?: string
): Promise<DisposalReading[]> {
  let q = sb.from("disposal_readings").select(READING_COLS);
  if (wellId) q = q.eq("injection_well_id", wellId);
  const { data, error } = await q
    .order("reading_date", { ascending: true })
    .order("reading_time", { ascending: true });
  if (error) throw new Error(`listDisposalReadings: ${error.message}`);
  return ((data ?? []) as unknown as DisposalReadingRow[]).map(mapReading);
}
