/**
 * The lease → facilities tree behind the sidebar's Leases flyout.
 *
 * Pure: it takes the rows the loaders already read for the lease and facility
 * pages and groups them, so the flyout can be unit-tested without a DB and can
 * never invent a link the destination page won't resolve. The hrefs are the
 * same ones the facility tables build (`tanks-table.tsx`, `meters-table.tsx`,
 * `disposal-wells-table.tsx`, `facility-detail-modal.tsx`): a water tank routes
 * by its service (`@/lib/tanks/water-service`), everything else by its kind.
 *
 * Slugs come in already stamped against the list the destination page resolves
 * a param against — every tank in the org for the tank pages, the SUBSTANCE'S
 * meters for the meter pages (see `withFacilitySlugs`). A row loaded without
 * one falls back to its id, which those pages answer with a redirect.
 */

import type { TankProduct, WaterService } from "@/lib/tanks/tanks";
import type { MeterSubstance } from "@/lib/meters/meters";
import type { WellType } from "@/lib/wells/wells";
import { wellState } from "@/lib/wells/wells-pure";

/** The facility groups a lease is broken into, in the order they are listed. */
export type LeaseNavKind =
  | "activeWell"
  | "oilTank"
  | "waterTank"
  | "gasMeter"
  | "battery"
  | "inactiveWell"
  | "pluggedWell"
  | "swdWell"
  | "swdBattery"
  | "swdTank"
  | "waterMeter";

/**
 * Group order and headings, top to bottom: the /production page's tabs in
 * their order, then the /disposal page's tabs in theirs, so the flyout reads
 * the way the two pages do. A battery holding a saltwater tank at an SWD
 * station is on both pages' Batteries tabs and so in both sections here.
 */
export const LEASE_NAV_SECTIONS: { kind: LeaseNavKind; label: string }[] = [
  { kind: "activeWell", label: "Active wells" },
  { kind: "oilTank", label: "Oil tanks" },
  { kind: "waterTank", label: "Water tanks" },
  { kind: "gasMeter", label: "Gas meters" },
  { kind: "battery", label: "Batteries" },
  { kind: "inactiveWell", label: "Inactive wells" },
  { kind: "pluggedWell", label: "Plugged wells" },
  { kind: "swdWell", label: "SWD wells" },
  { kind: "swdBattery", label: "SWD batteries" },
  { kind: "swdTank", label: "SWD tanks" },
  { kind: "waterMeter", label: "SWD meters" },
];

export interface LeaseNavFacility {
  /** Unique within the flyout — the record id is only unique per kind. */
  key: string;
  name: string;
  href: string;
  kind: LeaseNavKind;
}

export interface LeaseNavSection {
  kind: LeaseNavKind;
  label: string;
  items: LeaseNavFacility[];
}

export interface LeaseNavLease {
  id: string;
  name: string;
  href: string;
  sections: LeaseNavSection[];
  /** Facilities across every section, for the row's count. */
  facilityCount: number;
}

/** Only the fields the tree reads, so any row-shaped object satisfies it. */
export interface LeaseNavInput {
  leases: { id: string; name: string; slug?: string }[];
  tanks: {
    id: string;
    name: string;
    slug?: string;
    leaseId: string | null;
    product: TankProduct;
    waterService: WaterService | null;
    /** The battery the tank sits in, for the SWD batteries section. */
    batteryId?: string | null;
  }[];
  meters: {
    id: string;
    name: string;
    slug?: string;
    leaseId: string | null;
    substance: MeterSubstance;
  }[];
  /** Wells route on their id — `wells.id` IS the slug. */
  wells: {
    id: string;
    name: string;
    leaseId: string | null;
    type: WellType;
    active: boolean;
    pluggedAt: string | null;
  }[];
  batteries: {
    id: string;
    name: string;
    slug?: string;
    leaseId: string | null;
  }[];
}

/**
 * Names as an operator reads them: "Tank 2" before "Tank 10", case-insensitive.
 */
const collator = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base",
});

function param(row: { id: string; slug?: string }): string {
  return row.slug ?? row.id;
}

export function buildLeaseNavTree(input: LeaseNavInput): LeaseNavLease[] {
  const byLease = new Map<string, LeaseNavFacility[]>();
  const add = (leaseId: string | null, facility: LeaseNavFacility) => {
    // Unassigned facilities belong to no lease, and this panel lists leases;
    // they stay reachable from /facilities, which draws them in its own
    // "Unassigned" territory.
    if (!leaseId) return;
    const list = byLease.get(leaseId);
    if (list) list.push(facility);
    else byLease.set(leaseId, [facility]);
  };

  // Batteries holding a disposal-water tank: the /disposal Batteries tab.
  const swdBatteries = new Set<string>();
  for (const tank of input.tanks) {
    const oil = tank.product === "oil";
    // Water routes by service, not by product: a producing lease's water tank
    // lives on /production, an SWD station's on /disposal. A row with no
    // service is disposal, the same fail-safe direction the two lists take
    // (`isDisposalWater`).
    const production = oil || tank.waterService === "production";
    if (!production && tank.batteryId) swdBatteries.add(tank.batteryId);
    add(tank.leaseId, {
      key: `tank:${tank.id}`,
      name: tank.name,
      kind: oil ? "oilTank" : production ? "waterTank" : "swdTank",
      href: `${production ? "/production" : "/disposal"}/tanks/${param(tank)}`,
    });
  }

  for (const meter of input.meters) {
    const gas = meter.substance === "gas";
    add(meter.leaseId, {
      key: `meter:${meter.id}`,
      name: meter.name,
      kind: gas ? "gasMeter" : "waterMeter",
      href: `${gas ? "/production" : "/disposal"}/meters/${param(meter)}`,
    });
  }

  for (const well of input.wells) {
    const injection = well.type === "injection";
    // The three producer states are the three wells tabs on /production
    // (`partitionProducers`): plugged is a date, inactive is the flag.
    const state = wellState(well);
    add(well.leaseId, {
      key: `well:${well.id}`,
      name: well.name,
      kind: injection
        ? "swdWell"
        : state === "plugged"
          ? "pluggedWell"
          : state === "inactive"
            ? "inactiveWell"
            : "activeWell",
      href: `${injection ? "/disposal" : "/production"}/wells/${well.id}`,
    });
  }

  for (const battery of input.batteries) {
    const href = `/production/batteries/${param(battery)}`;
    add(battery.leaseId, {
      key: `battery:${battery.id}`,
      name: battery.name,
      kind: "battery",
      href,
    });
    if (swdBatteries.has(battery.id)) {
      add(battery.leaseId, {
        key: `swd-battery:${battery.id}`,
        name: battery.name,
        kind: "swdBattery",
        href,
      });
    }
  }

  return input.leases
    .map((lease) => {
      const facilities = byLease.get(lease.id) ?? [];
      const sections = LEASE_NAV_SECTIONS.map(({ kind, label }) => ({
        kind,
        label,
        items: facilities
          .filter((f) => f.kind === kind)
          .sort((a, b) => collator.compare(a.name, b.name)),
      })).filter((section) => section.items.length > 0);
      return {
        id: lease.id,
        name: lease.name,
        href: `/leases/${param(lease)}`,
        sections,
        facilityCount: facilities.length,
      };
    })
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** Leases whose name contains the typed text; the whole list when it is blank. */
export function filterLeaseNav(
  leases: LeaseNavLease[],
  query: string
): LeaseNavLease[] {
  const q = query.trim().toLowerCase();
  if (!q) return leases;
  return leases.filter((l) => l.name.toLowerCase().includes(q));
}
