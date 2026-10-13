"use client";

/**
 * "New facility" on the flow map — one menu of every facility type an operator
 * can add, each opening the SAME create dialog that facility's own page uses
 * (`TankFormDialog`, `MeterFormDialog`, `BatteryFormDialog`). The map is a place
 * to see the operation; adding from here must not become a second, thinner way
 * to define a tank.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDownIcon,
  CircleDotIcon,
  CylinderIcon,
  DropletIcon,
  GaugeIcon,
  LayersIcon,
  MapIcon,
  PlusIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TierUpgradeDeclined,
  useTierUpgradeGate,
} from "@/components/billing/tier-upgrade-gate";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  TankFormDialog,
  EMPTY_TANK,
  type TankFormValues,
} from "@/components/tanks/tank-form-dialog";
import {
  MeterFormDialog,
  EMPTY_METER,
  type MeterFormValues,
} from "@/components/meters/meter-form-dialog";
import {
  WellInfoDialog,
  type WellInfo,
} from "@/components/wells/well-info-dialog";
import {
  EMPTY_LEASE,
  LeaseFormDialog,
  type LeaseFormValues,
} from "@/components/leases/lease-form-dialog";
import {
  BatteryFormDialog,
  EMPTY_BATTERY,
  type BatteryFormValues,
  type BatteryTankOption,
} from "@/components/batteries/battery-form-dialog";
import { tankDisplayName } from "@/lib/tanks/tank-name";
import type { WaterService } from "@/lib/tanks/tanks";
import { meterDisplayName } from "@/lib/meters/meter-name";
import { nodeId, type FacilityNode, type Substance } from "@/lib/facilities/graph";
import { useFacilityWrites } from "@/components/facilities/facility-writes";
import { useCan } from "@/components/auth/permissions-context";

/** Everything the create dialogs need to offer their pickers. */
export interface FacilityCatalog {
  /** Every list carries its lease, so a picker can put the lease being worked on
   *  at the top of it (`sameLeaseFirst`). */
  wells: { id: string; name: string; leaseId?: string | null }[];
  injectionWells: { id: string; name: string; leaseId?: string | null }[];
  batteries: { id: string; name: string; leaseId?: string | null }[];
  gatherers: { id: string; name: string }[];
  /** Leases, for the meter dialog's Lease picker (half a meter's name). */
  leases: { id: string; name: string }[];
  /**
   * Every meter, with its substance: a producing well sells through GAS meters
   * and a disposal well is measured by WATER ones, so the well form picks the
   * list from the well rather than being handed one.
   */
  meters: {
    id: string;
    name: string;
    leaseId?: string | null;
    substance?: "gas" | "water";
  }[];
  tanks: BatteryTankOption[];
}

export type Draft =
  | "lease"
  | "producing-well"
  | "disposal-well"
  | "oil-tank"
  // Two water drafts, not one with a picker inside: which page the tank lands
  // on is the thing being chosen, so it is chosen from the menu.
  | "water-tank-production"
  | "water-tank-disposal"
  | "gas-meter"
  | "battery";

/** A blank well, seeded with the type the menu item chose. */
const emptyWell = (type: "producer" | "injection"): WellInfo => ({
  name: "",
  type,
  formation: "",
  county: "",
  depth: 0,
  perforations: "",
  dateDrilled: "",
  coordinates: "",
  oilBblPerInch: 1,
  oilTankIds: [],
  apiWellNo: "",
  rrcLeaseId: "",
  rrcOperatorNo: "",
  plungerSize: "",
  leaseId: null,
  active: true,
  pluggedAt: null,
  wellboreProfile: null,
});

export function FacilityCreateMenu({
  catalog,
  className,
  align = "end",
  elevated = false,
  onCreated,
  draft: draftProp,
  onDraftChange,
  hideTrigger = false,
}: {
  catalog: FacilityCatalog;
  /** Trigger classes, so the menu can sit in a toolbar or inside a dialog. */
  className?: string;
  align?: "start" | "end";
  /** Opened from inside another modal: the create form dims and blurs it. */
  elevated?: boolean;
  /**
   * A facility was just created. Handed over as a NODE so a host that is in the
   * middle of something — the connect dialog, mid-chain — can offer it at once
   * instead of waiting for the page data to come back around.
   */
  onCreated?: (node: FacilityNode) => void;
  /**
   * Drive the open form from outside — a facility dropped onto a connection
   * opens the matching create dialog without the menu ever being clicked.
   * Uncontrolled (the menu owns its own state) when omitted.
   */
  draft?: Draft | null;
  onDraftChange?: (draft: Draft | null) => void;
  /** Hide the button: the host is driving this purely through `draft`. */
  hideTrigger?: boolean;
}) {
  const router = useRouter();
  const writes = useFacilityWrites();
  /*
   * Leases are their own capability, and `leases_write` RLS enforces it
   * (`2026070602100_leases.sql:69`). A facilities manager without it would fill
   * the form and watch the row bounce off the database with nothing to read, so
   * the item is not offered.
   */
  const canManageLeases = useCan("manage_leases");
  const [, startWrite] = useTransition();
  const [ownDraft, setOwnDraft] = useState<Draft | null>(null);
  const controlled = onDraftChange != null;
  const draft = controlled ? draftProp ?? null : ownDraft;
  const setDraft = (next: Draft | null) => {
    if (controlled) onDraftChange?.(next);
    else setOwnDraft(next);
  };
  const close = () => setDraft(null);

  /*
   * Close first, write second.
   *
   * Every caller closes its dialog on submit and the host draws the new facility
   * optimistically, so holding the form open through a server action plus a
   * `router.refresh()` bought nothing but the impression that the click had not
   * landed. The refresh still runs — it is what replaces the optimistic card
   * with the real one — it just no longer blocks the UI.
   */
  // Wells are the billed unit, so a create that crosses the org's band asks
  // first. Every well made from this menu goes through it.
  const { guard, gate } = useTierUpgradeGate();

  const write = (run: () => Promise<unknown>, what: string) => {
    close();
    startWrite(async () => {
      try {
        await run();
        router.refresh();
      } catch (error) {
        console.error(`Failed to create ${what}`, error);
      }
    });
  };

  /** A lease's name, for the derived tank/meter names (`tankDisplayName`). */
  const leaseName = (id: string | null | undefined) =>
    catalog.leases.find((l) => l.id === id)?.name ?? null;

  /** Announce a fresh facility as the node the map would have built for it. */
  const announce = (
    kind: FacilityNode["kind"],
    refId: string,
    name: string,
    leaseId: string | null,
    substances: Substance[]
  ) =>
    onCreated?.({
      id: nodeId(kind, refId),
      kind,
      refId,
      name,
      leaseId,
      substances,
      flow: null,
      hasEquipment: kind === "well" || kind === "injection",
    });

  /*
   * The quick-adds every picker in these forms offers.
   *
   * Whatever a facility is being attached to can be made from the list it was
   * looked for in: a tank's battery, a battery's lease, a well's tank. They all
   * write through the same actions the menu's own items do, so a thing made
   * mid-form is the same row as one made from the menu — there is no lighter
   * "quick" version of a facility.
   */
  const newLease = async (name: string) => {
    const { id } = await writes.addLease({ name });
    router.refresh();
    return { id, name };
  };
  const newGatherer = async (name: string) => {
    const g = await writes.createGatherer({
      name,
      phone: "",
      email: "",
      status: "Active",
      description: "",
    });
    router.refresh();
    return { id: g.id, name: g.name };
  };
  const newBattery = async (name: string) => {
    const { id } = await writes.addBattery({ name });
    // Straight onto the map, like anything made from the menu itself: the
    // refresh behind it is what replaces the optimistic card with the real one.
    announce("battery", id, name, null, []);
    router.refresh();
    return { id, name };
  };
  const newWell =
    (type: "producer" | "injection") =>
    async (name: string, leaseId: string | null) => {
      // A well that crosses the org's band is refused until the price is
      // accepted (see `useTierUpgradeGate`). This picker's contract must
      // resolve to the well it made, so a decline throws instead.
      const created = await guard(() =>
        writes.createWell({
          ...emptyWell(type),
          name,
          leaseId,
        })
      );
      if (!created) throw new TierUpgradeDeclined();
      const { id } = created;
      announce(
        type === "injection" ? "injection" : "well",
        id,
        name,
        leaseId,
        type === "injection" ? ["water"] : ["oil", "gas", "water"]
      );
      router.refresh();
      return { id, name };
    };
  /** A meter made from another form: its number, and the lease it lands on. */
  const newMeter = async (
    meterNo: string,
    leaseId: string | null,
    substance: "gas" | "water" = "gas"
  ) => {
    const { id } = await writes.addMeter({ meterNo, leaseId, substance }, null);
    const name = meterDisplayName(leaseName(leaseId), meterNo);
    announce("meter", id, name, leaseId, [substance]);
    router.refresh();
    return { id, name };
  };

  /** A tank made from another form: its number, and the lease it lands on. */
  const newTank = async (
    tankNo: string,
    leaseId: string | null,
    product: "oil" | "water" = "oil",
    waterService: WaterService = "disposal"
  ) => {
    const { id } = await writes.addTank(
      {
        product,
        waterService: product === "water" ? waterService : null,
        bblPerInch: 1,
        tankNo,
        leaseId,
      },
      null
    );
    const name = tankDisplayName(leaseName(leaseId), tankNo, product);
    announce("tank", id, name, leaseId, [product]);
    router.refresh();
    return { id, name, bblPerInch: 1 };
  };

  function saveLease(values: LeaseFormValues) {
    // No `announce`: a lease has no card on the map. What it changes is the
    // lease pickers in every other dialog here, which the refresh brings back.
    write(
      () =>
        writes.addLease({
          leaseNo: values.leaseNo,
          name: values.name,
          county: values.county,
        }),
      "lease"
    );
  }

  function saveWell(info: WellInfo) {
    write(async () => {
      // Only an ACTIVE new well can cross the band, so only that one asks for a
      // price. See `handleCreateWell` in `tanks-list.tsx` for the rule.
      const created = info.active
        ? await guard(() => writes.createWell(info))
        : await writes.createWell(info);
      if (!created) return;
      const { id } = created;
      const injection = info.type === "injection";
      // The water wiring is drawn edges, so it is written after the well exists
      // to point at. A disposal well takes water FROM producers; a producer
      // sends its water TO tanks and holes — one write per side, since each
      // replaces that side's water edges wholesale.
      if (injection && info.feederWellIds?.length) {
        await writes.setFacilityLinks({
          node: { type: "well", id },
          side: "upstream",
          substance: "water",
          others: info.feederWellIds.map((wellId) => ({
            type: "well" as const,
            id: wellId,
          })),
        });
      }
      // Its saltwater tanks went in with the well itself (an allocation on the
      // tank, like its oil tanks); the disposal wells it feeds are edges.
      if (!injection && info.injectionWellIds?.length) {
        await writes.setFacilityLinks({
          node: { type: "well", id },
          side: "downstream",
          substance: "water",
          others: info.injectionWellIds.map((wellId) => ({
            type: "well" as const,
            id: wellId,
          })),
        });
      }
      announce(
        injection ? "injection" : "well",
        id,
        info.name,
        info.leaseId ?? null,
        // A brand new well has produced nothing, so nothing says which streams
        // it carries. It carries all of them until the readings say otherwise.
        injection ? ["water"] : ["oil", "gas", "water"]
      );
    }, "well");
  }

  function saveTank(values: TankFormValues) {
    write(
      async () => {
        const { id } = await writes.addTank(
          {
            product: values.product,
            waterService: values.waterService,
            batteryId: values.batteryId || null,
            tankNo: values.tankNo,
            leaseId: values.leaseId || null,
            gathererId: values.gathererId || null,
            bblPerInch: values.bblPerInch,
            capacityBbls: values.capacityBbls,
            injectionWellId: values.injectionWellId || null,
            injectionSharePct: values.injectionSharePct ?? null,
            active: values.active,
          },
          values.wellIds
        );
        if (values.product === "water" && values.meterIds?.length) {
          await writes.setFacilityLinks({
            node: { type: "tank", id },
            side: "upstream",
            substance: "water",
            others: values.meterIds.map((meterId) => ({
              type: "meter" as const,
              id: meterId,
            })),
          });
        }
        // A tank on a battery inherits that battery's lease server-side; until
        // the page comes back its provisional name is just its number.
        announce(
          "tank",
          id,
          tankDisplayName(leaseName(values.leaseId), values.tankNo, values.product),
          values.leaseId || null,
          [values.product]
        );
      },
      "tank"
    );
  }

  function saveMeter(values: MeterFormValues, substance: "gas" | "water") {
    write(
      async () => {
        const { id } = await writes.addMeter(
          {
            meterNo: values.meterNo,
            leaseId: values.leaseId || null,
            gathererId: values.gathererId || null,
            substance,
            active: values.active,
          },
          values.wellIds
        );
        /*
         * The meter's place in the saltwater line, as one write. A tank and a
         * hole picked together mean the water goes through the tank and then
         * down the hole — not out of the meter to both — and a well already
         * wired straight to that hole hands its connection over rather than
         * keeping a second route to it. Both rules live in
         * `planWaterMeterWiring`, so the map and the lab agree on them.
         */
        if (substance === "water") {
          await writes.wireWaterMeter({
            meterId: id,
            wellIds: values.wellIds,
            feedTankIds: values.feedTankIds ?? [],
            outTankIds: values.tankIds ?? [],
            injectionWellIds: values.injectionWellIds ?? [],
          });
        }
        announce(
          "meter",
          id,
          meterDisplayName(leaseName(values.leaseId), values.meterNo),
          values.leaseId || null,
          [substance]
        );
      },
      "meter"
    );
  }

  function saveBattery(values: BatteryFormValues) {
    write(async () => {
      const { id } = await writes.addBattery({ name: values.name, active: values.active });
      if (values.leaseId) await writes.editBattery(id, { leaseId: values.leaseId });
      if (values.tankIds.length > 0) await writes.saveBatteryTanks(id, values.tankIds);
      // A battery is a station, not a stream: what it carries is whatever its
      // tanks hold, which is nothing yet.
      announce("battery", id, values.name, values.leaseId || null, []);
    }, "battery");
  }

  return (
    <>
      {hideTrigger ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="sm" variant="outline" className={cn("h-10", className)} />}
        >
          <PlusIcon className="size-4" />
          New facility
          <ChevronDownIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-52">
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => setDraft("producing-well")}
          >
            <CircleDotIcon />
            Producing well
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => setDraft("disposal-well")}
          >
            <DropletIcon />
            Disposal well
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer" onClick={() => setDraft("oil-tank")}>
            <CylinderIcon />
            Oil tank
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => setDraft("water-tank-production")}
          >
            <CylinderIcon />
            Saltwater tank (production)
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => setDraft("water-tank-disposal")}
          >
            <CylinderIcon />
            Saltwater tank (disposal)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer" onClick={() => setDraft("gas-meter")}>
            <GaugeIcon />
            Gas meter
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* A lease is not a facility — it is the property the facilities sit
              on — but every tank and meter takes its NAME from one, so making
              one has to be reachable from here or the first card an operator
              creates is called "T104" in an Unassigned lane. */}
          {canManageLeases && (
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => setDraft("lease")}
            >
              <MapIcon />
              Lease
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="cursor-pointer" onClick={() => setDraft("battery")}>
            <LayersIcon />
            Tank battery
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      )}

      <LeaseFormDialog
        open={draft === "lease"}
        onOpenChange={(open) => !open && close()}
        values={EMPTY_LEASE}
        onSave={saveLease}
        title="New lease"
        submitLabel="Create lease"
      />

      <WellInfoDialog
        elevated={elevated}
        open={draft === "producing-well" || draft === "disposal-well"}
        onOpenChange={(open) => !open && close()}
        info={emptyWell(draft === "disposal-well" ? "injection" : "producer")}
        showActive
        leases={catalog.leases}
        tanks={catalog.tanks}
        meters={catalog.meters}
        producingWells={catalog.wells}
        injectionWells={catalog.injectionWells}
        onCreateLease={newLease}
        onCreateTank={newTank}
        onCreateMeter={newMeter}
        onCreateProducingWell={newWell("producer")}
        onCreateInjectionWell={newWell("injection")}
        onSave={saveWell}
        title={draft === "disposal-well" ? "New Disposal Well" : "New Producing Well"}
        submitLabel="Create"
        className="max-w-3xl"
      />

      <TankFormDialog
        className="max-w-3xl"
        elevated={elevated}
        open={
          draft === "oil-tank" ||
          draft === "water-tank-production" ||
          draft === "water-tank-disposal"
        }
        onOpenChange={(open) => !open && close()}
        values={
          draft === "oil-tank"
            ? { ...EMPTY_TANK, product: "oil", waterService: null }
            : {
                ...EMPTY_TANK,
                product: "water",
                waterService:
                  draft === "water-tank-disposal" ? "disposal" : "production",
              }
        }
        wells={catalog.wells}
        injectionWells={catalog.injectionWells}
        batteries={catalog.batteries}
        leases={catalog.leases}
        gatherers={catalog.gatherers}
        // The tank being made is often the first thing on a battery that does
        // not exist yet, and the hauler is picked at the same moment. Both are
        // made from inside the picker rather than by leaving the form.
        onCreateBattery={newBattery}
        onCreateGatherer={newGatherer}
        onCreateLease={newLease}
        onCreateWell={newWell("producer")}
        onCreateInjectionWell={newWell("injection")}
        onSave={saveTank}
        title={
          draft === "water-tank-production"
            ? "New Saltwater Tank (Production)"
            : draft === "water-tank-disposal"
              ? "New Saltwater Tank (Disposal)"
              : "New Oil Tank"
        }
        submitLabel="Create"
        showWellPicker
      />

      {/* Gas only. Water meters are not cards on this map (wiring behind the
          SWD well), so the map does not make them either. */}
      <MeterFormDialog
        className="max-w-3xl"
        elevated={elevated}
        open={draft === "gas-meter"}
        onOpenChange={(open) => !open && close()}
        values={EMPTY_METER}
        substance="gas"
        wells={catalog.wells}
        leases={catalog.leases}
        gatherers={catalog.gatherers}
        onCreateGatherer={newGatherer}
        onCreateLease={newLease}
        onCreateWell={newWell("producer")}
        onSave={(values) => saveMeter(values, "gas")}
        title="New Gas Meter"
        submitLabel="Create"
        showWellPicker
      />

      <BatteryFormDialog
        className="max-w-3xl"
        elevated={elevated}
        open={draft === "battery"}
        onOpenChange={(open) => !open && close()}
        values={EMPTY_BATTERY}
        tanks={catalog.tanks}
        leases={catalog.leases}
        injectionWells={catalog.injectionWells}
        onCreateLease={newLease}
        onCreateInjectionWell={newWell("injection")}
        onCreateTank={newTank}
        onSave={saveBattery}
        title="New Tank Battery"
        submitLabel="Create"
      />
      {gate}
    </>
  );
}
