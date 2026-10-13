"use client";

import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { GathererField, wellQuickAdd } from "@/components/tanks/tank-form-dialog";
import { leaseName } from "@/lib/leases/label";
import { cn } from "@/lib/utils";
import { MultiPicker, PickerField } from "@/components/ui/entity-picker";

/** The editable shape of a meter, shared by the create and edit flows. */
export interface MeterFormValues {
  /**
   * The meter's identifier number — on a GAS meter the gatherer's statement
   * number, on a water meter just the meter's own tag. Required: a meter has no
   * stored name, so this and its lease ARE its name — "Dofflemeyer M1234"
   * (`meterDisplayName`).
   */
  meterNo: string;
  /**
   * The lease this meter sits on, or "" for unassigned. The other half of the
   * meter's name, so it is entered here rather than inherited: unlike a tank,
   * which takes its lease from its battery, a meter has no parent to take one
   * from.
   */
  leaseId: string;
  /** Assigned gatherer id, or "" for none. Never set when `showGatherer` is off
   *  (water meters): nobody gathers disposed water, so the field stays "". */
  gathererId: string;
  /** Owning well id, or "" for a shared / unassigned meter. */
  /** The wells this meter measures. Several is ordinary — a gas sales meter
   *  usually carries a whole lease — so each one seeds an allocation row. */
  wellIds: string[];
  /**
   * Water meters only, all drawn as `flow_connections`.
   *
   * A meter sits IN the saltwater line, so tanks appear on both sides of it and
   * one list could not say which: `feedTankIds` are the tanks whose water comes
   * through the meter, `tankIds` the ones it fills. Same tank can be neither,
   * either or (on a recycle loop) both, and the two are written as separate
   * sides — see `setFacilityLinks`.
   */
  feedTankIds?: string[];
  tankIds?: string[];
  injectionWellIds?: string[];
  active: boolean;
}

export const EMPTY_METER: MeterFormValues = {
  meterNo: "",
  leaseId: "",
  gathererId: "",
  wellIds: [],
  feedTankIds: [],
  tankIds: [],
  injectionWellIds: [],
  active: true,
};


/**
 * Create/edit modal for a meter — the meter analogue of `TankFormDialog`.
 * Captures name, meter #, gatherer (shared picker with inline add), and the
 * well (or shared). The `children` slot hosts the allocation panel for shared
 * meters, mirroring the tank settings dialog.
 *
 * Shared with the WATER meters under /disposal, which pass `showGatherer={false}`.
 * A gatherer buys and takes away gas; disposed saltwater is injected, sold to
 * nobody and gathered by nobody, so the picker (and the statement-number framing
 * of Meter #) is a gas concept that only ever read as noise on that page.
 */
export function MeterFormDialog({
  open,
  onOpenChange,
  inline = false,
  elevated = false,
  values,
  wells,
  leases = [],
  gatherers = [],
  onCreateGatherer,
  onCreateLease,
  onCreateWell,
  waterTanks = [],
  injectionWells = [],
  onCreateWaterTank,
  onCreateInjectionWell,
  onSave,
  title = "Meter",
  submitLabel = "Save",
  showActive = false,
  showWellPicker = false,
  showGatherer = true,
  substance = "gas",
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Render in place (no modal shell) — used by the facilities detail modal's
   *  Settings tab, so the same form serves both. */
  inline?: boolean;
  /** Raise above the modal that opened this one, so its backdrop blurs it. */
  elevated?: boolean;

  values: MeterFormValues;
  wells: { id: string; name: string; leaseId?: string | null }[];
  /** Lease options for the Lease picker. Empty hides it (nothing to pick). */
  leases?: { id: string; name: string }[];
  gatherers?: { id: string; name: string }[];
  onCreateGatherer?: (name: string) => Promise<{ id: string; name: string }>;
  /** Quick-adds for the lease and well lists; omit to hide the option. */
  onCreateLease?: (name: string) => Promise<{ id: string; name: string }>;
  onCreateWell?: (
    name: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  /** A water meter's downstream: the saltwater tanks and disposal wells it
   *  feeds. Omit either list to hide its picker. */
  waterTanks?: { id: string; name: string; leaseId?: string | null }[];
  injectionWells?: { id: string; name: string; leaseId?: string | null }[];
  onCreateWaterTank?: (
    tankNo: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  onCreateInjectionWell?: (
    name: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  onSave: (values: MeterFormValues) => void;
  title?: string;
  submitLabel?: string;
  showActive?: boolean;
  /**
   * Show the wells picker. On create it seeds the meter's allocation rows; in
   * settings it EDITS them, so a well can be joined from either end.
   */
  showWellPicker?: boolean;
  /** Show the gatherer picker. Off for water meters — see above. */
  showGatherer?: boolean;
  /**
   * What this meter measures. Gas unless said otherwise; a water meter's
   * downstream (saltwater tanks, disposal wells) is offered only on water.
   */
  substance?: "gas" | "water";
  className?: string;
  children?: React.ReactNode;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<MeterFormValues>(values);

  /*
   * Lease NAMES only, where every other picker in the app shows the number in
   * front of them. This one is naming the meter: what is picked here becomes
   * the "Dofflemeyer" in "Dofflemeyer M1234" (`meterDisplayName`), so the
   * option should read as the name the meter is about to take rather than
   * carrying an identifier that will not appear in it.
   */
  const leaseOptions = useMemo(
    () => leases.map((l) => ({ ...l, name: leaseName(l.name) })),
    [leases]
  );

  // Re-seed from the latest values on each open (render-time pattern, no effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(values);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    onSave({ ...draft, meterNo: draft.meterNo.trim() });
    onOpenChange(false);
  }

  return (
    <SwipeUpModal
      inline={inline}
      elevated={elevated}
      open={open}
      onClose={() => onOpenChange(false)}
      title={title}
      className={className}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
          <form
            id={formId}
            onSubmit={handleSubmit}
            className="flex flex-col gap-4"
          >
            {/* One column throughout. The fields below are pickers over long
                lists of wells and tanks, and side by side each got half the
                width to show a name in. */}
            <Field label="Meter #">
              <Input
                autoFocus
                className="h-11"
                value={draft.meterNo}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, meterNo: e.target.value }))
                }
                placeholder="1234"
              />
            </Field>
            {leases.length > 0 || onCreateLease ? (
              <PickerField
                label="Lease"
                value={draft.leaseId}
                options={leaseOptions}
                placeholder="Unassigned"
                onChange={(id) => setDraft((d) => ({ ...d, leaseId: id }))}
                add={
                  onCreateLease
                    ? { label: "New lease", create: onCreateLease }
                    : undefined
                }
              />
            ) : null}

            {/* Skipped entirely when neither control is shown (a water meter
                being edited), so the form does not carry an empty grid row. */}
            <div
              className={cn(
                "flex flex-col gap-4",
                !showWellPicker && !showGatherer && "hidden"
              )}
            >
              {/* A water meter sits IN the line, so its tanks come in two
                  lists: what runs through it and what it fills. The hole leads,
                  since that is what a disposal meter is for. */}
              {substance === "water" &&
              (injectionWells.length > 0 || onCreateInjectionWell) ? (
                <Field label="Disposal wells">
                  <MultiPicker
                    options={injectionWells}
                    leaseId={draft.leaseId}
                    selected={draft.injectionWellIds ?? []}
                    placeholder="None"
                    empty="No disposal wells yet."
                    onChange={(ids) =>
                      setDraft((d) => ({ ...d, injectionWellIds: ids }))
                    }
                    add={wellQuickAdd(
                      onCreateInjectionWell,
                      "New disposal well",
                      draft.leaseId,
                      leases
                    )}
                  />
                </Field>
              ) : null}
              {showWellPicker ? (
                /* On a water meter "Wells" sat right under the disposal-well
                   picker and said nothing about which kind these are. */
                <Field label={substance === "water" ? "Producing wells" : "Wells"}>
                  <MultiPicker
                    options={wells}
                    leaseId={draft.leaseId}
                    selected={draft.wellIds}
                    placeholder="Shared / unassigned"
                    empty="No wells yet."
                    onChange={(ids) => setDraft((d) => ({ ...d, wellIds: ids }))}
                    add={wellQuickAdd(onCreateWell, "New well", draft.leaseId, leases)}
                  />
                </Field>
              ) : null}
              {substance === "water" &&
              (waterTanks.length > 0 || onCreateWaterTank) ? (
                <Field label="Inflow saltwater tanks">
                  <MultiPicker
                    options={waterTanks}
                    leaseId={draft.leaseId}
                    selected={draft.feedTankIds ?? []}
                    placeholder="None"
                    empty="No saltwater tanks yet."
                    onChange={(ids) => setDraft((d) => ({ ...d, feedTankIds: ids }))}
                    add={
                      onCreateWaterTank
                        ? {
                            label: "New saltwater tank",
                            field: "Tank #",
                            extra: {
                              label: "Lease",
                              options: leases,
                              value: draft.leaseId,
                              placeholder: "Unassigned",
                            },
                            create: (tankNo: string, leaseId?: string) =>
                              onCreateWaterTank(tankNo, leaseId || null),
                          }
                        : undefined
                    }
                  />
                </Field>
              ) : null}
              {substance === "water" &&
              (waterTanks.length > 0 || onCreateWaterTank) ? (
                <Field label="Outflow saltwater tanks">
                  <MultiPicker
                    options={waterTanks}
                    leaseId={draft.leaseId}
                    selected={draft.tankIds ?? []}
                    placeholder="None"
                    empty="No saltwater tanks yet."
                    onChange={(ids) => setDraft((d) => ({ ...d, tankIds: ids }))}
                    add={
                      onCreateWaterTank
                        ? {
                            label: "New saltwater tank",
                            field: "Tank #",
                            extra: {
                              label: "Lease",
                              options: leases,
                              value: draft.leaseId,
                              placeholder: "Unassigned",
                            },
                            create: (tankNo: string, leaseId?: string) =>
                              onCreateWaterTank(tankNo, leaseId || null),
                          }
                        : undefined
                    }
                  />
                </Field>
              ) : null}
                            {showGatherer ? (
                <GathererField
                  gatherers={gatherers}
                  value={draft.gathererId}
                  onChange={(id) => setDraft((d) => ({ ...d, gathererId: id }))}
                  onCreate={onCreateGatherer}
                />
              ) : null}
            </div>

            {showActive ? (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={draft.active}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, active: checked }))
                  }
                />
                <span className="text-sm font-medium">Active</span>
              </label>
            ) : null}
          </form>

          {children ? (
            <div className="flex flex-col gap-4 border-t pt-5">{children}</div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            size="lg"
            disabled={!draft.meterNo.trim()}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </SwipeUpModal>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
