/**
 * Tank-report domain types (GBC-10) — pure, no I/O.
 *
 * The three tank-sourced reports (Battery Capacity, Tanks Called In, Tank
 * Measurement Audit) share these shapes. Kept dependency-free (no Supabase, no
 * server-only imports) so the aggregation and export-column specs that build on
 * them stay unit-testable under the Node test runner.
 */

import type { TankProduct } from "@/lib/tanks/tanks";

// --- Battery Capacity -------------------------------------------------------

/** One tank's capacity-vs-used snapshot (inches + barrels + % full). */
export interface BatteryCapacityTank {
  tankId: string;
  tankName: string;
  product: TankProduct;
  /** Shell capacity in barrels, or null if unrecorded. */
  capacityBbls: number | null;
  /** Current barrels on hand (latest gauge reading), 0 if never gauged. */
  usedBbls: number;
  /** Capacity expressed in gauge inches (capacity ÷ bbl-per-inch), or null. */
  capacityInches: number | null;
  /** Current level in gauge inches (used ÷ bbl-per-inch). */
  usedInches: number;
  /** Percent full (0–100), or null when capacity is unknown. */
  pctFull: number | null;
}

/** A battery (facility) roll-up: its tanks plus summed capacity/used. */
export interface BatteryCapacityGroup {
  /** Battery / facility name; "" for standalone tanks (labelled by the UI). */
  battery: string;
  tanks: BatteryCapacityTank[];
  /** Σ capacity across the battery's tanks (tanks without capacity omitted). */
  capacityBbls: number;
  /** Σ current barrels across the battery's tanks. */
  usedBbls: number;
  /** Battery-level percent full (used ÷ capacity × 100), or null. */
  pctFull: number | null;
}

/** The Battery Capacity report: per-battery groups plus a company total. */
export interface BatteryCapacityReport {
  batteries: BatteryCapacityGroup[];
  totalCapacityBbls: number;
  totalUsedBbls: number;
  pctFull: number | null;
}

// --- Tanks Called In --------------------------------------------------------

/** A tank as loaded for the called-in queue (before days-since is computed). */
export interface CalledInTankInput {
  tankId: string;
  tankName: string;
  battery: string;
  product: TankProduct;
  capacityBbls: number | null;
  /** Current barrels on hand (latest gauge reading). */
  stockBbls: number;
  /** The tank's gatherer (from its settings), or "" if none assigned. */
  gatherer: string;
  /** When the tank was called in (ISO timestamp). */
  calledInAt: string;
}

/** One row of the pickup queue, with days-since resolved against "today". */
export interface CalledInTankRow extends CalledInTankInput {
  /** Percent full (0–100), or null when capacity is unknown. */
  pctFull: number | null;
  /** Whole days between the called-in date and the report date (>= 0). */
  daysSinceCalledIn: number;
}

/** The Tanks Called In report: the queue plus a count. */
export interface TanksCalledInReport {
  tanks: CalledInTankRow[];
  totalCalledIn: number;
}

// --- Tank Measurement Audit -------------------------------------------------

/** Lifecycle state of a gauge entry, from its audit columns. */
export type AuditStatus = "active" | "edited" | "deleted";

/** A gauge reading with its create/update/delete audit trail resolved. */
export interface TankAuditRow {
  readingId: string;
  battery: string;
  tankName: string;
  /** Reading date (ISO `YYYY-MM-DD`). */
  readingDate: string;
  gauge: number;
  bbls: number;
  status: AuditStatus;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  deletedBy: string | null;
  deletedAt: string | null;
}

/** The Tank Measurement Audit report: audited gauge rows plus tallies. */
export interface TankAuditReport {
  rows: TankAuditRow[];
  totalEntries: number;
  editedEntries: number;
  deletedEntries: number;
}

/**
 * A raw gauge reading + audit columns as loaded from `tank_readings` (including
 * soft-deleted rows). User ids are auth ids resolved to names by the report.
 */
export interface TankAuditReadingInput {
  readingId: string;
  tankId: string;
  tankName: string;
  battery: string;
  readingDate: string;
  gauge: number;
  bbls: number;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  deletedBy: string | null;
  deletedAt: string | null;
}

// --- Tank Measurements (raw gauge listing) ---------------------------------

/**
 * One gauge reading as loaded from `tank_readings` for the raw measurements
 * listing (the GreaseBook `TankMeasurementsReport` analog). Just the observed
 * values, before per-tank ordering and the change-since-prior derivation.
 */
export interface TankMeasurementInput {
  tankId: string;
  tankName: string;
  battery: string;
  product: TankProduct;
  /** Reading date (ISO `YYYY-MM-DD`). */
  readingDate: string;
  /** Reading time as a 24-hour `HH:MM` string, or "" if none. */
  readingTime: string;
  /** Raw top gauge, in inches. */
  gauge: number;
  /** Derived barrels (gauge × the tank's bbl-per-inch). */
  bbls: number;
}

/**
 * One row of the raw Tank Measurements listing: a gauge reading plus the change
 * in barrels from the previous reading on the SAME tank (null for a tank's first
 * reading). Rows are ordered by battery, tank, then reading time ascending.
 */
export interface TankMeasurementRow extends TankMeasurementInput {
  /** Bbls change from this tank's prior reading; null for the first reading. */
  changeBbls: number | null;
}

/** The Tank Measurements report: every gauge reading plus tallies. */
export interface TankMeasurementsReport {
  rows: TankMeasurementRow[];
  totalReadings: number;
  tankCount: number;
}
