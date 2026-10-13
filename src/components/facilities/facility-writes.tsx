"use client";

/**
 * Every write the facilities map can make, in one injectable surface.
 *
 * The map's create menu, connect dialog, card-drag and detail modal each used to
 * import their server actions directly, which made the whole editing experience
 * unreachable except against a real org's database. That is the experience most
 * worth putting in front of someone — creating a tank, wiring a well into it,
 * undoing it again is the part that is either obvious or maddening — and it
 * could only be exercised by doing it for real, to real rows.
 *
 * So the actions are reached through this context instead. The default is the
 * real ones, so `/facilities` behaves exactly as it did; the `/dev/facilities`
 * harness supplies an in-memory implementation (`@/lib/dev/facility-sandbox`)
 * and the same UI then edits a make-believe org.
 *
 * The interface is declared with `typeof` on purpose: an implementation cannot
 * drift from the action it stands in for, and adding an argument to an action
 * fails the sandbox at compile time rather than at the click.
 */

import { createContext, useContext, type ReactNode } from "react";
import {
  createFacilityConnection,
  setFacilityLinks,
  setFacilityLease,
  wireWaterMeter,
  deleteFacilityConnection,
  spliceFacilityIntoConnection,
  refreshFacilities,
} from "@/lib/facilities/actions";
import { createWell, deleteWell, updateWell } from "@/lib/wells/actions";
import { addLease } from "@/lib/leases/actions";
import { createGatherer } from "@/lib/people/actions";
import {
  addTank,
  editTank,
  getTankAllocationConfig,
  removeTank,
  removeTankWell,
  removeWellFromOilTank,
  saveTankAllocationConfig,
  setTankWells,
} from "@/lib/tanks/actions";
import {
  addMeter,
  editMeter,
  getMeterAllocationConfig,
  removeMeter,
  removeMeterWell,
  saveMeterAllocationConfig,
  setMeterWells,
} from "@/lib/meters/actions";
import {
  addBattery,
  editBattery,
  getBatteryAllocationConfig,
  removeBattery,
  saveBatteryAllocationConfig,
  saveBatteryTanks,
  setBatteryWells,
} from "@/lib/batteries/actions";

export interface FacilityWrites {
  /** A lease is not a facility, but nothing on this map can be named without
   *  one — see the create menu. */
  addLease: typeof addLease;
  /** Haul-off companies: not facilities either, but a tank picks one. */
  createGatherer: typeof createGatherer;
  createWell: typeof createWell;
  /** Well settings, saved from the map. It went straight to the server action,
   *  so the harness's own wells were edited in a database they do not live in. */
  updateWell: typeof updateWell;
  deleteWell: typeof deleteWell;
  addTank: typeof addTank;
  editTank: typeof editTank;
  removeTank: typeof removeTank;
  removeTankWell: typeof removeTankWell;
  removeWellFromOilTank: typeof removeWellFromOilTank;
  addMeter: typeof addMeter;
  /** Meter settings, saved from the map — the meter analogue of `editTank`. */
  editMeter: typeof editMeter;
  removeMeter: typeof removeMeter;
  removeMeterWell: typeof removeMeterWell;
  addBattery: typeof addBattery;
  editBattery: typeof editBattery;
  removeBattery: typeof removeBattery;
  saveBatteryTanks: typeof saveBatteryTanks;
  /** The settings forms' own wiring pickers. */
  setTankWells: typeof setTankWells;
  setMeterWells: typeof setMeterWells;
  setBatteryWells: typeof setBatteryWells;
  /** The allocation panel: reads the split, writes it back. */
  getTankAllocationConfig: typeof getTankAllocationConfig;
  getMeterAllocationConfig: typeof getMeterAllocationConfig;
  getBatteryAllocationConfig: typeof getBatteryAllocationConfig;
  saveTankAllocationConfig: typeof saveTankAllocationConfig;
  saveMeterAllocationConfig: typeof saveMeterAllocationConfig;
  saveBatteryAllocationConfig: typeof saveBatteryAllocationConfig;
  createFacilityConnection: typeof createFacilityConnection;
  /** The settings forms' "what feeds this / what this feeds" pickers. */
  setFacilityLinks: typeof setFacilityLinks;
  /** Drop a card into another lease's lane: the facility moves onto it. */
  setFacilityLease: typeof setFacilityLease;
  /** A new water meter's whole line at once — the chain rule and the path it
   *  takes over live in `planWaterMeterWiring`, not in the form. */
  wireWaterMeter: typeof wireWaterMeter;
  deleteFacilityConnection: typeof deleteFacilityConnection;
  spliceFacilityIntoConnection: typeof spliceFacilityIntoConnection;
  /**
   * What the refresh button does. On the real page that is re-deriving every
   * cached rate and re-reading the page; a host whose graph never came from the
   * database gives back its own map instead.
   */
  refresh: () => Promise<void> | void;
}

/** The real thing: what `/facilities` runs on. */
export const SERVER_WRITES: FacilityWrites = {
  setTankWells,
  setMeterWells,
  setBatteryWells,
  getTankAllocationConfig,
  getMeterAllocationConfig,
  getBatteryAllocationConfig,
  saveTankAllocationConfig,
  saveMeterAllocationConfig,
  saveBatteryAllocationConfig,
  addLease,
  createGatherer,
  createWell,
  updateWell,
  deleteWell,
  addTank,
  editTank,
  removeTank,
  removeTankWell,
  removeWellFromOilTank,
  addMeter,
  editMeter,
  removeMeter,
  removeMeterWell,
  addBattery,
  editBattery,
  removeBattery,
  saveBatteryTanks,
  createFacilityConnection,
  setFacilityLinks,
  setFacilityLease,
  wireWaterMeter,
  deleteFacilityConnection,
  spliceFacilityIntoConnection,
  refresh: refreshFacilities,
};

const FacilityWritesContext = createContext<FacilityWrites>(SERVER_WRITES);

export function FacilityWritesProvider({
  writes,
  children,
}: {
  writes: FacilityWrites;
  children: ReactNode;
}) {
  return (
    <FacilityWritesContext.Provider value={writes}>
      {children}
    </FacilityWritesContext.Provider>
  );
}

/** The writes in force here — the server's unless a host has replaced them. */
export function useFacilityWrites(): FacilityWrites {
  return useContext(FacilityWritesContext);
}
