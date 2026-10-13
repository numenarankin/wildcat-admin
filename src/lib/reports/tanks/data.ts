/**
 * RLS-scoped data-access for the three tank reports (GBC-10).
 *
 * Every helper takes the caller's Supabase client as its first argument — pass
 * the request-scoped RLS client (`getSupabaseServer()`); the `tanks` /
 * `tank_readings` policies scope every read to the caller's org, so nothing
 * outside it is ever returned regardless of the ids passed. Never hand these the
 * service-role admin client — that would bypass RLS. The aggregation itself is
 * the pure `summarize*` functions; these just load the rows they consume.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { bblsFromGauge } from "@/lib/tanks/strapping";
import { listTanks, latestBblsByTank } from "@/lib/tanks/tanks";
import { tankDisplayName } from "@/lib/tanks/tank-name";
import { summarizeBatteryCapacity } from "@/lib/reports/tanks/battery-capacity";
import { summarizeTanksCalledIn } from "@/lib/reports/tanks/tanks-called-in";
import { summarizeTankAudit } from "@/lib/reports/tanks/tank-audit";
import { summarizeTankMeasurements } from "@/lib/reports/tanks/tank-measurements";
import type {
  BatteryCapacityReport,
  CalledInTankInput,
  TankAuditReadingInput,
  TankAuditReport,
  TankMeasurementInput,
  TankMeasurementsReport,
  TanksCalledInReport,
} from "@/lib/reports/tanks/types";

type Sb = SupabaseClient;

// --- Battery Capacity -------------------------------------------------------

/** Load + aggregate the Battery Capacity report (tank roster + current bbls). */
export async function loadBatteryCapacity(
  sb: Sb
): Promise<BatteryCapacityReport> {
  const [tanks, currentByTank] = await Promise.all([
    listTanks(sb),
    latestBblsByTank(sb),
  ]);
  return summarizeBatteryCapacity(
    tanks.map((t) => ({
      id: t.id,
      name: t.name,
      product: t.product,
      battery: t.battery,
      bblPerInch: t.bblPerInch,
      capacityBbls: t.capacityBbls,
    })),
    currentByTank
  );
}

// --- Tanks Called In --------------------------------------------------------

interface CalledInRow {
  id: string;
  tank_no: string | null;
  /** The tank's own lease (the fallback half of the name's lease). */
  lease: { name: string | null } | null;
  battery: string | null;
  /** Battery name AND its lease — the authoritative half. */
  battery_rel: {
    name: string | null;
    lease: { name: string | null } | null;
  } | null;
  product: string | null;
  capacity_bbls: number | null;
  called_in_at: string | null;
  gatherer: { name: string | null } | null;
}

/** The lease that names a tank row: its battery's, else its own. */
function rowLease(r: {
  lease?: { name: string | null } | null;
  battery_rel?: { lease?: { name: string | null } | null } | null;
}): string {
  return r.battery_rel?.lease?.name ?? r.lease?.name ?? "";
}

/**
 * Load + aggregate the Tanks Called In pickup queue. Only tanks with
 * `called_in_at` set are returned; `today` (ISO date) fixes days-since so the
 * export route and modal agree.
 */
export async function loadTanksCalledIn(
  sb: Sb,
  today: string
): Promise<TanksCalledInReport> {
  const [{ data, error }, currentByTank] = await Promise.all([
    sb
      .from("tanks")
      .select(
        "id, tank_no, lease:leases!lease_id(name), battery, " +
          "battery_rel:tank_batteries!battery_id(name, lease:leases!lease_id(name)), " +
          "product, capacity_bbls, called_in_at, " +
          "gatherer:gatherers!gatherer_id(name)"
      )
      .not("called_in_at", "is", null),
    latestBblsByTank(sb),
  ]);
  if (error) throw new Error(`loadTanksCalledIn: ${error.message}`);

  const inputs: CalledInTankInput[] = ((data ?? []) as unknown as CalledInRow[])
    .filter((r) => r.called_in_at)
    .map((r) => ({
      tankId: r.id,
      tankName: tankDisplayName(
        rowLease(r),
        r.tank_no,
        r.product === "water" ? "water" : "oil"
      ),
      battery: r.battery_rel?.name ?? r.battery ?? "",
      product: r.product === "water" ? "water" : "oil",
      capacityBbls: r.capacity_bbls,
      stockBbls: currentByTank[r.id] ?? 0,
      gatherer: r.gatherer?.name ?? "",
      calledInAt: r.called_in_at!,
    }));

  return summarizeTanksCalledIn(inputs, today);
}

// --- Tank Measurement Audit -------------------------------------------------

interface AuditRow {
  id: string;
  reading_date: string;
  gauge: number | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  deleted_by: string | null;
  deleted_at: string | null;
  tank: {
    tank_no: string | null;
    /** What the tank holds — the letter in its derived name (T / W). */
    product: string | null;
    battery: string | null;
    bbl_per_inch: number | null;
    lease: { name: string | null } | null;
    battery_rel: {
      name: string | null;
      lease: { name: string | null } | null;
    } | null;
  } | null;
}

/**
 * Auth-user-id → display name (name, else email) for the org's members, read
 * through RLS so it stays org-scoped. Used to humanize the audit trail's
 * created/updated/deleted-by ids without touching the admin client.
 */
async function memberNamesByUserId(sb: Sb): Promise<Record<string, string>> {
  const { data, error } = await sb
    .from("org_members")
    .select("auth_user_id, name, email");
  if (error) throw new Error(`memberNamesByUserId: ${error.message}`);
  const out: Record<string, string> = {};
  for (const m of (data ?? []) as {
    auth_user_id: string | null;
    name: string | null;
    email: string | null;
  }[]) {
    if (!m.auth_user_id) continue;
    const label = m.name?.trim() || m.email?.trim();
    if (label) out[m.auth_user_id] = label;
  }
  return out;
}

/**
 * Load + aggregate the Tank Measurement Audit report. Includes soft-deleted
 * readings (no `deleted_at is null` filter) so the audit trail is complete.
 */
export async function loadTankAudit(sb: Sb): Promise<TankAuditReport> {
  const [{ data, error }, nameByUser] = await Promise.all([
    sb
      .from("tank_readings")
      .select(
        "id, reading_date, gauge, created_by, created_at, updated_by, " +
          "updated_at, deleted_by, deleted_at, " +
          "tank:tanks(tank_no, product, battery, bbl_per_inch, lease:leases!lease_id(name), " +
          "battery_rel:tank_batteries!battery_id(name, lease:leases!lease_id(name)))"
      )
      .order("created_at", { ascending: false }),
    memberNamesByUserId(sb),
  ]);
  if (error) throw new Error(`loadTankAudit: ${error.message}`);

  const readings: TankAuditReadingInput[] = (
    (data ?? []) as unknown as AuditRow[]
  ).map((r) => ({
    readingId: r.id,
    tankId: "",
    tankName: r.tank
      ? tankDisplayName(
          rowLease(r.tank),
          r.tank.tank_no,
          r.tank.product === "water" ? "water" : "oil"
        )
      : "",
    battery: r.tank?.battery_rel?.name ?? r.tank?.battery ?? "",
    readingDate: r.reading_date,
    gauge: r.gauge ?? 0,
    // Derived at read time from the tank's current strapping factor.
    bbls: bblsFromGauge(r.gauge ?? 0, r.tank?.bbl_per_inch ?? 1),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    deletedBy: r.deleted_by,
    deletedAt: r.deleted_at,
  }));

  return summarizeTankAudit(readings, nameByUser);
}

// --- Tank Measurements (raw gauge listing) ---------------------------------

interface MeasurementRow {
  id: string;
  tank_id: string;
  reading_date: string;
  reading_time: string | null;
  gauge: number | null;
  tank: {
    tank_no: string | null;
    product: string | null;
    battery: string | null;
    bbl_per_inch: number | null;
    lease: { name: string | null } | null;
    battery_rel: {
      name: string | null;
      lease: { name: string | null } | null;
    } | null;
  } | null;
}

/**
 * Load + aggregate the raw Tank Measurements listing (the plain field log of
 * gauge readings, per tank, with the change since each tank's prior reading).
 * Excludes soft-deleted rows (this is the operational log, not the audit trail).
 */
export async function loadTankMeasurements(
  sb: Sb
): Promise<TankMeasurementsReport> {
  const { data, error } = await sb
    .from("tank_readings")
    .select(
      "id, tank_id, reading_date, reading_time, gauge, " +
        "tank:tanks(tank_no, product, battery, bbl_per_inch, " +
        "lease:leases!lease_id(name), " +
        "battery_rel:tank_batteries!battery_id(name, lease:leases!lease_id(name)))"
    )
    .is("deleted_at", null)
    .order("reading_date", { ascending: true });
  if (error) throw new Error(`loadTankMeasurements: ${error.message}`);

  const readings: TankMeasurementInput[] = (
    (data ?? []) as unknown as MeasurementRow[]
  ).map((r) => ({
    tankId: r.tank_id,
    tankName: r.tank
      ? tankDisplayName(
          rowLease(r.tank),
          r.tank.tank_no,
          r.tank.product === "water" ? "water" : "oil"
        )
      : "",
    battery: r.tank?.battery_rel?.name ?? r.tank?.battery ?? "",
    product: r.tank?.product === "water" ? "water" : "oil",
    readingDate: r.reading_date,
    readingTime: r.reading_time ?? "",
    gauge: r.gauge ?? 0,
    bbls: bblsFromGauge(r.gauge ?? 0, r.tank?.bbl_per_inch ?? 1),
  }));

  return summarizeTankMeasurements(readings);
}
