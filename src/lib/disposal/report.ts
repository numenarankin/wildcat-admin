/**
 * Water Disposed report aggregation — pure, no I/O.
 *
 * Turns each SWD well's resolved disposal rows (`well-series.ts`) into the report
 * shape: a company total plus a per-well roll-up. Rows are what a meter actually
 * measured (or, for an unmetered well, what was hand-entered on the dates no
 * meter covered), so the report cannot disagree with the well pages it summarizes.
 * Kept dependency-free so it is unit-testable without a database.
 */

import type { DisposalRow } from "@/lib/disposal/well-series";
import type {
  WaterDisposedReport,
  WaterDisposedWell,
} from "@/lib/disposal/types";

/** A minimal well descriptor — just what the roll-up needs. */
export interface DisposalWellRef {
  id: string;
  name: string;
}

/**
 * Build the Water Disposed report from injection wells and their disposal rows.
 *
 * Every injection well appears (even with no disposal at all), so the report is a
 * complete SWD roster. Per well: barrels are summed; the injection/casing pressure
 * and cumulative index are taken from that well's most recent row (the
 * representative current snapshot). Wells are ordered by total injected volume
 * descending, then by name.
 */
export function summarizeDisposal(
  wells: DisposalWellRef[],
  rowsByWell: Map<string, DisposalRow[]>
): WaterDisposedReport {
  const rows: WaterDisposedWell[] = wells.map((w) => {
    // Rows arrive oldest-first from the resolver, so the last is the latest.
    const wellRows = rowsByWell.get(w.id) ?? [];
    const latest = wellRows[wellRows.length - 1];
    return {
      wellId: w.id,
      wellName: w.name,
      readingCount: wellRows.length,
      totalInjectedBbls: wellRows.reduce((sum, r) => sum + (r.volume ?? 0), 0),
      injectionPressure: latest?.injectionPressure ?? null,
      casingPressure: latest?.casingPressure ?? null,
      meterReading: latest?.meterReading ?? null,
      lastReadingDate: latest?.date ?? null,
    };
  });

  rows.sort((a, b) =>
    b.totalInjectedBbls !== a.totalInjectedBbls
      ? b.totalInjectedBbls - a.totalInjectedBbls
      : a.wellName.localeCompare(b.wellName)
  );

  return {
    wells: rows,
    totalInjectedBbls: rows.reduce((sum, w) => sum + w.totalInjectedBbls, 0),
    totalReadings: rows.reduce((sum, w) => sum + w.readingCount, 0),
  };
}
