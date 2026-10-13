/**
 * Saltwater disposal / injection domain types (GBC-9) — pure, no I/O.
 *
 * Kept dependency-free (no Supabase, no server-only imports) so the report
 * aggregation and export column specs that build on them stay unit-testable
 * under the Node test runner.
 */

/** One daily injection-log entry for an SWD/injection well. */
export interface DisposalReading {
  /** Row id (absent for unsaved/optimistic rows). */
  id?: string;
  /** The injection well this reading logs. */
  wellId: string;
  /** Reading date as an ISO `YYYY-MM-DD` string. */
  date: string;
  /** Reading time as a 24-hour `HH:MM` string, or "" if none. */
  time: string;
  /**
   * Water transferred on this reading, in barrels, or null when not entered.
   * This is the manual / override volume (Mode B): when present it wins over the
   * computed meter delta; when null the disposal series uses the meter delta
   * (`meterReading` minus the prior reading). Stored in the legacy
   * `injected_bbls` column.
   */
  injectedBbls: number | null;
  /** Injection (tubing) pressure, psi, or null. */
  injectionPressure: number | null;
  /** Casing pressure, psi, or null. */
  casingPressure: number | null;
  /** Cumulative flow-meter reading, barrels, or null — the Mode B volume source. */
  meterReading: number | null;
  /** Optional producing well whose water was disposed here, or null. */
  sourceWellId: string | null;
  /** Free-text remarks, or "". */
  notes: string;
  /** Auth user id of whoever recorded it (`created_by`), when read. */
  createdBy?: string | null;
}

/** A disposal reading as supplied by the UI, before it has a row id. */
export interface DisposalReadingInput {
  date: string;
  time?: string;
  /** Water transferred (barrels), or null when not entered (meter delta is used). */
  injectedBbls: number | null;
  injectionPressure?: number | null;
  casingPressure?: number | null;
  meterReading?: number | null;
  sourceWellId?: string | null;
  notes?: string;
}

/** Per-SWD-well roll-up in the Water Disposed report. */
export interface WaterDisposedWell {
  wellId: string;
  wellName: string;
  /** Number of disposal readings in the report window. */
  readingCount: number;
  /** Total barrels injected / disposed. */
  totalInjectedBbls: number;
  /** Pressures + meter from the most recent reading (representative snapshot). */
  injectionPressure: number | null;
  casingPressure: number | null;
  meterReading: number | null;
  /** Date of the most recent reading, ISO `YYYY-MM-DD`, or null. */
  lastReadingDate: string | null;
}

/** The Water Disposed report: company total plus per-SWD-well detail. */
export interface WaterDisposedReport {
  wells: WaterDisposedWell[];
  /** Company-wide total barrels injected / disposed. */
  totalInjectedBbls: number;
  /** Company-wide count of disposal readings. */
  totalReadings: number;
}
