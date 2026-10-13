import type { IngestType } from "@/lib/ai/ingest/types";

/** The GreaseBook layouts this module recognizes. */
export type GbReportKind =
  | "tankMeasurements"
  | "waterPage"
  | "transportTickets"
  | "abbrProduction"
  | "gasLog";

/**
 * One extracted record, with the evidence needed to prove it was mapped from the
 * right row and the right column.
 *
 * `derived` holds the values GreaseBook computed and printed beside the raw ones,
 * which this import deliberately DISCARDS (barrels come from the tank's own
 * strapping, disposal volume from consecutive meter indexes). They are kept here
 * only so `verify.ts` can check our reading against GB's own arithmetic: if our
 * gauges do not reproduce GB's printed deltas, we read the wrong column.
 */
export interface GbRow {
  type: IngestType;
  row: Record<string, unknown>;
  /** The series this row belongs to (`section|device`), which is the grain the
   * self-check's row-to-row identities run over. */
  stream: string;
  /** The well/battery heading the row sat under, for the approval modal. */
  section: string;
  derived: {
    /** Printed inch change since the previous reading of this tank. */
    deltaIn?: number | null;
    /** Printed barrels for this row (tank production, or a meter's water). */
    volume?: number | null;
    /** Printed cumulative index (water meter). */
    index?: number | null;
    /** Printed running oil stock (production report). */
    stock?: number | null;
    /** Printed oil sold, needed for the stock identity. */
    sales?: number | null;
    /** Printed oil produced, needed for the stock identity. */
    produced?: number | null;
  };
  /** The source row, verbatim, and where it sat in the grid. */
  source: string[];
  at: number;
}

export interface GbReadResult {
  report: GbReportKind;
  rows: GbRow[];
  /** Rows recognized as data but not placeable, for model escalation. */
  residual: string[][];
  /** Header of the region the residual came from, so escalation keeps meaning. */
  header: string[];
  stats: { dataRows: number; emitted: number; skipped: number };
  /** Anything the operator should be told, e.g. columns with no home here. */
  notes: string[];
}
