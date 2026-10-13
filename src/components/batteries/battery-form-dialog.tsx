"use client";

import { useId, useState } from "react";
import { PlusIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { MultiPicker, PickerField } from "@/components/ui/entity-picker";
import { wellQuickAdd } from "@/components/tanks/tank-form-dialog";


/** A tank the battery picker can choose from. */
export interface BatteryTankOption {
  id: string;
  name: string;
  /** Battery this tank currently belongs to (name), or "" if unassigned. */
  battery: string;
  /** Barrels per inch of gauge — the well form mirrors it onto a well when the
   *  tank is picked there, so a placeholder would convert readings wrongly. */
  bblPerInch: number;
  /** Oil or water: a disposal well's tanks are the saltwater ones. */
  product?: "oil" | "water";
  leaseId?: string | null;
}

/** The editable shape of a tank battery, shared by the create and edit flows. */
export interface BatteryFormValues {
  name: string;
  /**
   * Whether the battery is in service. NOT edited in this form — it is carried
   * through untouched, so a save cannot retire a battery as a side effect of
   * renaming it. A new battery is active.
   */
  active: boolean;
  /**
   * The lease this battery sits on, "" for unassigned. AUTHORITATIVE: saving it
   * cascades down to every member tank's lease (`tank_batteries_cascade_lease`),
   * which is why the tank form disables its own lease picker on a battery tank.
   */
  leaseId: string;
  /** Ids of the tanks that belong to this battery. */
  tankIds: string[];
  /**
   * The producing wells whose oil this battery receives.
   *
   * Oil allocates at the battery and nowhere else, so this is the oil side's
   * one wiring point — a tank on the battery inherits it.
   */
  wellIds: string[];
  /**
   * Mode B: the SWD/injection well this battery's WATER feeds, "" for none.
   *
   * Set it and the battery is FLOW-THROUGH — its water tanks' level stops being
   * a production signal and the disposal well's own meter is the volume source.
   * A saltwater station points at its well once here, instead of once per member
   * tank, and the members' own links are ignored while it is set.
   */
  injectionWellId: string;
}

export const EMPTY_BATTERY: BatteryFormValues = {
  name: "",
  active: true,
  leaseId: "",
  injectionWellId: "",
  tankIds: [],
  wellIds: [],
};

/**
 * Create/edit modal for a tank battery — the minimal analogue of
 * `TankFormDialog`/`MeterFormDialog`. A battery is a named facility that groups
 * tanks, so it captures a name (plus the active toggle when editing) and the set
 * of member tanks.
 */
export function BatteryFormDialog({
  open,
  onOpenChange,
  inline = false,
  elevated = false,
  /*
   * Wide AND tall on purpose: two columns of fields beside a membership list
   * that is the reason anyone opens this. Sized off the viewport so it uses the
   * screen it is on; `SwipeUpModal` still caps the card at 90vh.
   */
  className = "h-[85vh] max-w-4xl",
  values,
  tanks = [],
  wells = [],
  leases = [],
  injectionWells = [],
  onCreateLease,
  onCreateInjectionWell,
  onCreateWell,
  onCreateTank,
  onSave,
  title = "Battery",
  submitLabel = "Save",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Render in place (no modal shell) — used by the facilities detail modal's
   *  Settings tab, so the same form serves both. */
  inline?: boolean;
  /** Card width, when the host wants it wider than the default. */
  className?: string;
  /** Raise above the modal that opened this one, so its backdrop blurs it. */
  elevated?: boolean;

  values: BatteryFormValues;
  /** All tanks in the org, for the membership picker. */
  tanks?: BatteryTankOption[];
  /** Producing wells, for the oil-side picker; omit to hide it. */
  wells?: { id: string; name: string; leaseId?: string | null }[];
  /** Leases to assign the battery to; omit to hide the picker. */
  leases?: { id: string; name: string }[];
  /** SWD/injection wells this battery's water can feed (Mode B); omit to hide
   *  the picker — an oil-only battery has no use for it. */
  injectionWells?: { id: string; name: string; leaseId?: string | null }[];
  /** Quick-adds for the three lists below; omit one to hide its option. */
  onCreateLease?: (name: string) => Promise<{ id: string; name: string }>;
  onCreateInjectionWell?: (
    name: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  onCreateWell?: (
    name: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  onCreateTank?: (
    tankNo: string,
    /** The battery's lease, which its tanks all follow. */
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  onSave: (values: BatteryFormValues) => void;
  title?: string;
  submitLabel?: string;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<BatteryFormValues>(values);

  // Re-seed from the latest values on each open (render-time pattern, no effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(values);
  }

  const selected = new Set(draft.tankIds);

  /*
   * The membership list is every tank in the org, which on a real fleet is
   * hundreds of rows to scroll for the four that belong here. Filtering is on
   * the NAME, which already carries the lease ("Roach T123"), so typing a lease
   * narrows to its tanks and typing a number finds the one tank.
   *
   * A tank already on the battery stays visible whatever is typed: it is the
   * half of the list that says what the battery IS, and a search that hides the
   * current members reads as having emptied it.
   */
  const [tankQuery, setTankQuery] = useState("");
  const q = tankQuery.trim().toLowerCase();
  const shownTanks = q
    ? tanks.filter(
        (t) => selected.has(t.id) || t.name.toLowerCase().includes(q)
      )
    : tanks;

  function toggleTank(id: string) {
    setDraft((d) => {
      const next = new Set(d.tankIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...d, tankIds: [...next] };
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    onSave({ ...draft, name: draft.name.trim() });
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
          {/* Two columns: what the battery IS on the left, what is ON it on the
              right. The membership list is the tall control, so beside the
              fields it fills the height they leave rather than pushing them off
              the top of a scroll. One column below `md`, where there is no room
              to put a checkbox list next to anything. */}
          <div className="grid min-h-0 flex-1 gap-5 md:grid-cols-2">
          <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Name</span>
              <Input
                className="h-11"
                autoFocus
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
                placeholder="North Battery"
              />
            </label>

            {leases.length > 0 || onCreateLease ? (
              <div className="flex flex-col gap-1.5">
                <PickerField
                  label="Lease"
                  value={draft.leaseId}
                  options={leases}
                  placeholder="Unassigned"
                  onChange={(id) => setDraft((d) => ({ ...d, leaseId: id }))}
                  add={
                    onCreateLease
                      ? { label: "New lease", create: onCreateLease }
                      : undefined
                  }
                />
                <span className="text-xs text-muted-foreground">
                  Every tank on this battery follows this lease.
                </span>
              </div>
            ) : null}

            {wells.length > 0 || onCreateWell ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Wells</span>
                <MultiPicker
                  options={wells}
                  leaseId={draft.leaseId}
                  selected={draft.wellIds}
                  placeholder="None"
                  empty="No wells yet."
                  onChange={(ids) => setDraft((d) => ({ ...d, wellIds: ids }))}
                  add={wellQuickAdd(onCreateWell, "New well", draft.leaseId, leases)}
                />
                <span className="text-xs text-muted-foreground">
                  Oil allocates here, so these are the wells every tank on this
                  battery holds oil for.
                </span>
              </div>
            ) : null}

            {injectionWells.length > 0 || onCreateInjectionWell ? (
              <div className="flex flex-col gap-1.5">
                <PickerField
                  label="Disposal well"
                  value={draft.injectionWellId}
                  options={injectionWells}
                  leaseId={draft.leaseId}
                  placeholder="None"
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
                <span className="text-xs text-muted-foreground">
                  Where this battery&apos;s saltwater is injected. Its water
                  tanks stop being measured by level.
                </span>
              </div>
            ) : null}
          </form>

          <div className="flex min-h-0 flex-col gap-1.5">
            <span className="text-sm font-medium">
              Tanks
              {draft.tankIds.length > 0 ? (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {draft.tankIds.length} selected
                </span>
              ) : null}
            </span>
            {tanks.length === 0 && !onCreateTank ? (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                No tanks yet. Add tanks first, then group them here.
              </p>
            ) : (
              /* Fills whatever height the card has left. `min-h-64` is the
                 floor for the stacked single-column layout, where there is no
                 tall neighbour to borrow height from. */
              <div className="flex min-h-64 flex-1 flex-col overflow-hidden rounded-md border">
                <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                  <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                  <Input
                    value={tankQuery}
                    onChange={(e) => setTankQuery(e.target.value)}
                    placeholder="Search tanks…"
                    className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                {shownTanks.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No tank matches “{tankQuery.trim()}”.
                  </p>
                ) : null}
                {shownTanks.map((t) => {
                  const checked = selected.has(t.id);
                  return (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-center gap-2.5 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleTank(t.id)}
                      />
                      <span className="text-sm font-medium">{t.name}</span>
                    </label>
                  );
                })}
                </div>
                {/* The battery is often made BEFORE the tanks that go on it, so
                    one can be made from the list rather than from another page.
                    It joins the battery straight away — that is why it was made
                    here. */}
                {onCreateTank ? (
                  <div className="shrink-0 border-t p-2">
                    <NewTankButton
                      onCreate={(tankNo) =>
                        onCreateTank(tankNo, draft.leaseId || null)
                      }
                      onCreated={(id) =>
                        setDraft((d) => ({ ...d, tankIds: [...d.tankIds, id] }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            )}
          </div>

          </div>
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
            disabled={!draft.name.trim()}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </SwipeUpModal>
  );
}

/**
 * "New tank" under the membership list.
 *
 * A tank's identity is the number painted on it, so that is all this asks for;
 * everything else about the tank (its lease, its strapping) follows from the
 * battery it just joined and is edited on the tank itself.
 */
function NewTankButton({
  onCreate,
  onCreated,
}: {
  onCreate: (tankNo: string) => Promise<{ id: string; name: string }>;
  onCreated: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tankNo, setTankNo] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const value = tankNo.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const made = await onCreate(value);
      onCreated(made.id);
      setTankNo("");
      setOpen(false);
    } catch (error) {
      console.error("Failed to add tank", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={() => {
          setTankNo("");
          setOpen(true);
        }}
      >
        <PlusIcon className="size-4" />
        New tank
      </Button>
      <SwipeUpModal
        open={open}
        onClose={() => setOpen(false)}
        title="New tank"
        className="max-w-sm"
        elevated
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Tank #</span>
            <Input
              autoFocus
              className="h-11"
              value={tankNo}
              onChange={(e) => setTankNo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" size="lg" disabled={!tankNo.trim() || busy} onClick={() => void add()}>
            New tank
          </Button>
        </div>
      </SwipeUpModal>
    </>
  );
}
