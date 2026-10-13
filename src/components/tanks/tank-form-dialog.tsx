"use client";

import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import {
  MultiPicker,
  PickerField,
  type QuickAdd,
} from "@/components/ui/entity-picker";
import { leaseForBattery } from "@/lib/tanks/tank-lease";
import { leaseName } from "@/lib/leases/label";
import type { TankProduct, WaterService } from "@/lib/tanks/tanks";

/** The editable shape of a tank, shared by the create and edit flows. */
export interface TankFormValues {
  product: TankProduct;
  /**
   * Which page a WATER tank belongs on — production (a lease battery's tank,
   * catching water off the separator) or disposal (a station tank holding water
   * before injection). Null on an oil tank, and the pair is chosen as one from
   * the Product select.
   */
  waterService: WaterService | null;
  /** The tank battery this tank is linked to, "" for a standalone tank. */
  batteryId: string;
  /**
   * The tank's identifier number (purchaser / gatherer run number). Required:
   * a tank has no stored name, so this and its lease ARE its name — "Roach
   * T123" (`tankDisplayName`).
   */
  tankNo: string;
  /**
   * The lease this tank sits on, or "" for unassigned — the OTHER half of the
   * tank's name. A tank inside a battery takes its battery's lease instead (the
   * battery is authoritative; see `mapTank`), which is why choosing a battery
   * below fills this in.
   */
  leaseId: string;
  /** Assigned gatherer id, or "" for none. */
  gathererId: string;
  /**
   * The wells whose oil lands in this tank, seeding one allocation row each.
   * Empty for a shared / unassigned tank. A tank on a lease usually takes
   * several, which is why this is a list and not the single owner it was.
   */
  wellIds: string[];
  /** Water tanks only: the water meters whose measured volume lands here. Drawn
   *  as `flow_connections`, which is what the water model traces. */
  meterIds?: string[];
  /** Linear strapping factor (barrels per inch of gauge). */
  bblPerInch: number;
  /** Shell capacity in barrels, or null when unrecorded. */
  capacityBbls: number | null;
  /** For a water/disposal tank (Mode B): the SWD/injection well it feeds, "" if
   * none. Only surfaced when the form is given `injectionWells`. */
  injectionWellId?: string;
  /** This tank's fixed % of its SWD well under the `straight` method, or null. */
  injectionSharePct?: number | null;
  active: boolean;
}

/**
 * The three things a tank can be, as one select. `product` + `waterService` are
 * stored separately (the service is a role, orthogonal to the fluid), but they
 * are ANSWERED together, so the form collapses them into one control and maps
 * back on the way out.
 */
type TankKind = "oil" | "water-production" | "water-disposal";

const TANK_KINDS: TankKind[] = ["oil", "water-production", "water-disposal"];

const TANK_KIND_LABEL: Record<TankKind, string> = {
  oil: "Oil",
  "water-production": "Saltwater (Production)",
  "water-disposal": "Saltwater (Disposal)",
};

/** The kind a draft currently is. A water tank with no service reads as
 *  disposal, the page every water tank was on before the split. */
function tankKindOf(v: Pick<TankFormValues, "product" | "waterService">): TankKind {
  if (v.product !== "water") return "oil";
  return v.waterService === "production" ? "water-production" : "water-disposal";
}

/** The two stored fields a kind stands for. */
function kindToProduct(kind: TankKind): Pick<TankFormValues, "product" | "waterService"> {
  if (kind === "oil") return { product: "oil", waterService: null };
  return {
    product: "water",
    waterService: kind === "water-production" ? "production" : "disposal",
  };
}

export const EMPTY_TANK: TankFormValues = {
  product: "oil",
  waterService: null,
  batteryId: "",
  tankNo: "",
  leaseId: "",
  gathererId: "",
  wellIds: [],
  meterIds: [],
  bblPerInch: 1,
  capacityBbls: null,
  injectionWellId: "",
  injectionSharePct: null,
  active: true,
};

const NONE = "__none__";

/**
 * Create/edit modal for a tank — the config surface (strapping, capacity,
 * product, well/battery association). Mirrors `WellInfoDialog`: raw text is held
 * for the decimal/number fields so partial input types smoothly, parsed back
 * into the numeric draft on change.
 */
export function TankFormDialog({
  open,
  onOpenChange,
  inline = false,
  elevated = false,
  values,
  wells,
  injectionWells = [],
  batteries = [],
  leases = [],
  gatherers = [],
  onCreateGatherer,
  onCreateBattery,
  onCreateLease,
  onCreateWell,
  onCreateInjectionWell,
  waterMeters = [],
  onCreateWaterMeter,
  onSave,
  title = "Tank",
  submitLabel = "Save",
  showActive = false,
  showWellPicker = false,
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

  values: TankFormValues;
  wells: { id: string; name: string; leaseId?: string | null }[];
  /** SWD/injection wells a WATER tank can be linked to (Mode B). When non-empty
   * and the product is water, the form shows an SWD-well selector + share. */
  injectionWells?: { id: string; name: string; leaseId?: string | null }[];
  /** Tank batteries to link to (Production → Batteries). `leaseId` is what the
   *  Battery picker cascades into the Lease field; without it there is nothing
   *  to cascade and the Lease field is simply left alone. */
  batteries?: {
    id: string;
    name: string;
    leaseId?: string | null;
    /** Set when the battery itself is wired to an SWD well (Mode B). Its member
     *  tanks then defer to it rather than carrying their own link. */
    injectionWellId?: string | null;
  }[];
  /** Lease options for the Lease picker. Empty hides it (nothing to pick). */
  leases?: { id: string; name: string }[];
  /** Gatherers to choose from (People → Gatherers). */
  gatherers?: { id: string; name: string }[];
  /** Quick-add a gatherer by name; resolves to the created row so it can be
   * selected immediately. Omit to hide the inline add affordance. */
  onCreateGatherer?: (name: string) => Promise<{ id: string; name: string }>;
  /** Quick-add a battery by name, from inside the Battery picker. The tank being
   *  made is often the first thing ON that battery, so leaving the form to go
   *  create one throws away everything typed. Omit to hide the option. */
  onCreateBattery?: (
    name: string
  ) => Promise<{ id: string; name: string; leaseId?: string | null }>;
  /** Quick-add for the remaining lists. Each is hidden when not supplied, so a
   *  caller that cannot create leases or wells simply does not offer to. */
  onCreateLease?: (name: string) => Promise<{ id: string; name: string }>;
  /** The lease comes with them: a well made from a tank's form is nearly always
   *  on the tank's own lease, and half of everything's name is its lease. */
  onCreateWell?: (
    name: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  onCreateInjectionWell?: (
    name: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  /** Water meters, for a water tank's feeder picker. */
  waterMeters?: { id: string; name: string; leaseId?: string | null }[];
  onCreateWaterMeter?: (
    meterNo: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  onSave: (values: TankFormValues) => void;
  title?: string;
  submitLabel?: string;
  /** Show the active/retired toggle (edit only). */
  showActive?: boolean;
  /**
   * Show the wells picker. On create it seeds the tank's allocation rows; in
   * settings it EDITS them, so a well can be joined from the facility being
   * looked at rather than only from the other end. The allocation panel still
   * owns the percentages.
   */
  showWellPicker?: boolean;
  /** Widen the modal (e.g. for the settings dialog's allocation section). */
  className?: string;
  /**
   * Extra section rendered below the config fields — used by the tank settings
   * dialog to host the allocation panel. Rendered outside the `<form>`, so its
   * own controls/buttons don't submit the tank-config form.
   */
  children?: React.ReactNode;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<TankFormValues>(values);
  const [ratioInput, setRatioInput] = useState(String(values.bblPerInch));
  const [capacityInput, setCapacityInput] = useState(
    values.capacityBbls == null ? "" : String(values.capacityBbls)
  );
  const [shareInput, setShareInput] = useState(
    values.injectionSharePct == null ? "" : String(values.injectionSharePct)
  );

  // Re-seed from the latest values on each open (render-time pattern, no effect;
  // matches MeterFormDialog).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(values);
      setRatioInput(String(values.bblPerInch));
      setCapacityInput(
        values.capacityBbls == null ? "" : String(values.capacityBbls)
      );
      setShareInput(
        values.injectionSharePct == null ? "" : String(values.injectionSharePct)
      );
    }
  }

  function handleShareChange(raw: string) {
    setShareInput(raw);
    if (raw.trim() === "") {
      setDraft((d) => ({ ...d, injectionSharePct: null }));
      return;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      setDraft((d) => ({ ...d, injectionSharePct: parsed }));
    }
  }

  function handleRatioChange(raw: string) {
    setRatioInput(raw);
    const parsed = raw.trim() === "" ? 1 : Number(raw);
    if (Number.isFinite(parsed)) setDraft((d) => ({ ...d, bblPerInch: parsed }));
  }

  function handleCapacityChange(raw: string) {
    setCapacityInput(raw);
    if (raw.trim() === "") {
      setDraft((d) => ({ ...d, capacityBbls: null }));
      return;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      setDraft((d) => ({ ...d, capacityBbls: parsed }));
    }
  }

  /**
   * Choosing a battery moves the tank onto that battery's lease
   * (`leaseForBattery` — the rule and its edges are stated there).
   *
   * Without this the Lease field below would sit empty under a battery that
   * plainly has one, and a tank saved from here would be stored with no lease at
   * all — which is how a fleet ends up with tanks named "T486296" instead of
   * "Roach Parrott T486296".
   */
  function pickBattery(
    d: TankFormValues,
    choice: string | null
  ): TankFormValues {
    const batteryId = choice && choice !== NONE ? choice : "";
    return {
      ...d,
      batteryId,
      leaseId: leaseForBattery(d.leaseId, batteryId, batteries),
    };
  }

  // The battery's lease wins on read, so while the tank is in a battery that has
  // one, this field reports that lease and cannot be edited — a different lease
  // chosen here would never be the one displayed.
  /**
   * Lease NAMES only, where most pickers in the app show the number in front.
   *
   * Same rule as the meter dialog (`meter-form-dialog.tsx`) and the same reason:
   * this picker NAMES the tank. What is chosen here becomes the "Roach" in
   * "Roach T123" (`tankDisplayName`), so the option should read as the name the
   * tank is about to take rather than carrying an identifier that will not
   * appear in it. `leaseName` is the strip half of `leaseLabel`, kept in the
   * same file so the join and the strip cannot drift.
   */
  const leaseOptions = useMemo(
    () => leases.map((l) => ({ ...l, name: leaseName(l.name) })),
    [leases]
  );

  /* The battery's own disposal well, when it has one. A station points at its
   * well once, on the battery, and every water tank on it feeds that well — so
   * the tank's own picker would be a second, contradictory answer. */
  const batteryInjectionWellId = draft.batteryId
    ? (batteries.find((b) => b.id === draft.batteryId)?.injectionWellId ?? null)
    : null;
  const batteryLease = draft.batteryId
    ? (batteries.find((b) => b.id === draft.batteryId)?.leaseId ?? null)
    : null;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    onSave({ ...draft, tankNo: draft.tankNo.trim() });
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
            className="grid grid-cols-2 gap-4"
          >
            {/* The tank's identity, and the only half of its name an operator
                types — the other half is the lease it sits on. */}
            <Field label="Tank #">
              <Input
                autoFocus
                className="h-11"
                value={draft.tankNo}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, tankNo: e.target.value }))
                }
                placeholder="123"
              />
            </Field>
            {/* Product and water service are ONE choice: what the tank holds
                and, for water, which end of the cycle it sits at. Splitting
                them into two controls would let a tank be saved as water with
                no service, which the DB refuses and which would leave it on
                neither page. */}
            <Field label="Product">
              <Select
                value={tankKindOf(draft)}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, ...kindToProduct(v as TankKind) }))
                }
              >
                <SelectTrigger className="h-11 w-full">
                  <span>{TANK_KIND_LABEL[tankKindOf(draft)]}</span>
                </SelectTrigger>
                <SelectContent>
                  {TANK_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {TANK_KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {/* Battery first, then lease: a battery decides the lease, and the
                lease is half the tank's name — both are answered before it
                matters which wells feed it. */}
            <PickerField
              label="Battery"
              value={draft.batteryId}
              options={batteries}
              placeholder="Standalone"
              leaseId={draft.leaseId}
              onChange={(id) => setDraft((d) => pickBattery(d, id))}
              add={
                onCreateBattery
                  ? {
                      label: "New battery",
                      create: async (name: string) => {
                      const created = await onCreateBattery(name);
                      // The picker only knows ids; the new battery is not in
                      // `batteries` until the page comes back, so its lease is
                      // applied here rather than through `pickBattery`.
                      setDraft((d) => ({
                        ...d,
                        batteryId: created.id,
                        leaseId: created.leaseId ?? d.leaseId,
                      }));
                      return created;
                      },
                    }
                  : undefined
              }
            />
            {leases.length > 0 || onCreateLease ? (
              <PickerField
                label="Lease"
                value={draft.leaseId}
                options={leaseOptions}
                placeholder="Unassigned"
                disabled={batteryLease != null}
                onChange={(id) => setDraft((d) => ({ ...d, leaseId: id }))}
                add={quickAdd(onCreateLease, "New lease")}
              />
            ) : null}
            {showWellPicker ? (
              <Field label="Wells">
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
            {draft.product === "water" &&
            (waterMeters.length > 0 || onCreateWaterMeter) ? (
              <Field label="Water meters">
                <MultiPicker
                  options={waterMeters}
                  leaseId={draft.leaseId}
                  selected={draft.meterIds ?? []}
                  placeholder="None"
                  empty="No water meters yet."
                  onChange={(ids) => setDraft((d) => ({ ...d, meterIds: ids }))}
                  add={
                    onCreateWaterMeter
                      ? {
                          label: "New water meter",
                          field: "Meter #",
                          extra: {
                            label: "Lease",
                            options: leases,
                            value: draft.leaseId,
                            placeholder: "Unassigned",
                          },
                          create: (meterNo: string, leaseId?: string) =>
                            onCreateWaterMeter(meterNo, leaseId || null),
                        }
                      : undefined
                  }
                />
              </Field>
            ) : null}
                        <PickerField
              label="Gatherer"
              value={draft.gathererId}
              options={gatherers}
              placeholder="None"
              onChange={(id) => setDraft((d) => ({ ...d, gathererId: id }))}
              add={quickAdd(onCreateGatherer, "New gatherer")}
            />
            <Field label="Strapping (bbl/in)">
              <Input
                className="h-11"
                inputMode="decimal"
                placeholder="1"
                value={ratioInput}
                onChange={(e) => handleRatioChange(e.target.value)}
              />
            </Field>
            <Field label="Capacity (bbl)">
              <Input
                className="h-11"
                inputMode="decimal"
                placeholder="—"
                value={capacityInput}
                onChange={(e) => handleCapacityChange(e.target.value)}
              />
            </Field>
            {draft.product === "water" && batteryInjectionWellId ? (
              <Field label="SWD Well (disposal)">
                <div className="flex h-11 items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground">
                  {injectionWells.find((w) => w.id === batteryInjectionWellId)
                    ?.name ?? "Set on the battery"}
                </div>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Set on this tank&apos;s battery, which every tank on it
                  follows.
                </span>
              </Field>
            ) : draft.product === "water" &&
              (injectionWells.length > 0 || onCreateInjectionWell) ? (
              <>
                <PickerField
                  label="SWD Well (disposal)"
                  value={draft.injectionWellId ?? ""}
                  options={injectionWells}
                  leaseId={draft.leaseId}
                  placeholder="Not disposal-linked"
                  onChange={(id) =>
                    setDraft((d) => ({ ...d, injectionWellId: id }))
                  }
                  add={wellQuickAdd(
                    onCreateInjectionWell,
                    "New disposal well",
                    draft.leaseId,
                    leases
                  )}
                />
                {draft.injectionWellId ? (
                  <Field label="SWD Share % (straight)">
                    <Input
                      className="h-11"
                      inputMode="decimal"
                      placeholder="auto (100% if sole tank)"
                      value={shareInput}
                      onChange={(e) => handleShareChange(e.target.value)}
                    />
                  </Field>
                ) : null}
              </>
            ) : null}
            {showActive ? (
              <Field label="Status">
                <Select
                  value={draft.active ? "active" : "inactive"}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, active: v === "active" }))
                  }
                >
                  <SelectTrigger className="h-11 w-full">
                    <span>{draft.active ? "Active" : "Inactive"}</span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
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
            disabled={!draft.tankNo.trim()}
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

/**
 * A quick-add for a WELL, which needs its lease as well as its name — seeded
 * with the lease of the form it is being made from, and still a picker because
 * a tank on one lease can be fed by a well on another.
 */
export function wellQuickAdd(
  create:
    | ((name: string, leaseId: string | null) => Promise<{ id: string; name: string }>)
    | undefined,
  label: string,
  leaseId: string,
  leases: { id: string; name: string }[]
): QuickAdd | undefined {
  return create
    ? {
        label,
        create: (name, lease) => create(name, lease || null),
        extra: {
          label: "Lease",
          options: leases,
          value: leaseId,
          placeholder: "Unassigned",
        },
      }
    : undefined;
}

/** A quick-add from an optional create function, or nothing to offer. */
export function quickAdd(
  create: ((name: string) => Promise<{ id: string; name: string }>) | undefined,
  label: string,
  field?: string
): QuickAdd | undefined {
  return create ? { create, label, field } : undefined;
}

/**
 * The gatherer picker, as the meter form still takes it. The list plus a way to
 * add one, which is now {@link PickerField}.
 */
export function GathererField({
  gatherers,
  value,
  onChange,
  onCreate,
}: {
  gatherers: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  onCreate?: (name: string) => Promise<{ id: string; name: string }>;
}) {
  return (
    <PickerField
      label="Gatherer"
      value={value}
      options={gatherers}
      placeholder="None"
      onChange={onChange}
      add={quickAdd(onCreate, "New gatherer")}
    />
  );
}
