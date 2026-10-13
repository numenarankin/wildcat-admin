"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { MultiPicker, PickerField } from "@/components/ui/entity-picker";
import { RrcSyncButton } from "@/components/facilities/rrc-sync-button";
import { syncWellFromRrc } from "@/lib/rrc/facility-sync";
import type { RrcWellFill } from "@/lib/rrc/facility-fill";
import { useTierUpgradeGate } from "@/components/billing/tier-upgrade-gate";
import { cn } from "@/lib/utils";
import type { WellboreProfile, WellType } from "@/lib/wells/wells";
import { statusPatch, wellState, type WellState } from "@/lib/wells/wells-pure";


/*
 * Radix's Select cannot hold "" as a value, so unknown needs a sentinel of its
 * own. It maps back to null on the way out: a well whose geometry nobody knows
 * must store null, not the empty string, because the column is constrained and
 * because "" would read as a value that had been set.
 */
const NO_PROFILE = "__unknown__";

/**
 * A box the RRC filled on this open, and that has not been saved yet.
 *
 * Amber is the app's "worth a second look" accent (the same one the readings
 * tables and the ingest badges use). It lasts until Save, after which the value
 * is the operator's own and is styled like everything else they typed.
 */
const RRC_FILLED_FIELD =
  "border-amber-500/70 bg-amber-500/5 dark:border-amber-400/60";

const PROFILE_ORDER: readonly WellboreProfile[] = [
  "vertical",
  "horizontal",
  "directional",
  "sidetrack",
];

const PROFILE_LABELS: Record<WellboreProfile, string> = {
  vertical: "Vertical",
  horizontal: "Horizontal",
  directional: "Directional",
  sidetrack: "Sidetrack",
};

const STATUS_LABELS: Record<WellState, string> = {
  active: "Active",
  inactive: "Inactive",
  plugged: "Plugged",
};

export interface WellInfo {
  name: string;
  /** Producer (production) vs injection (disposal) well. */
  type: WellType;
  formation: string;
  /** County the surface location sits in. */
  county: string;
  /** Total measured depth, in feet. */
  depth: number;
  /** Perforation interval, e.g. "9,800–11,120". */
  perforations: string;
  /** ISO date string (YYYY-MM-DD), or "" if unknown. */
  dateDrilled: string;
  /** Surface-location coordinates, free-form (e.g. "31.9686, -102.0779"). */
  coordinates: string;
  /**
   * Barrels of oil per inch of tank gauge — derived from the well's linked oil
   * tank (set via `oilTankId`), not edited directly here. Oil readings are
   * entered in gauge inches and displayed as barrels using this ratio.
   */
  oilBblPerInch: number;
  /** The oil tank this well goes to (`tanks.id`), or null if unassigned. Set via
   * the Tank dropdown; its strapping factor becomes `oilBblPerInch`. */
  /**
   * The oil tanks this well runs to. Several is ordinary — a lease with two
   * tanks fills whichever is open — and the strapping factor below follows the
   * FIRST of them, since a gauge reading has to be converted by the tank it was
   * taken on.
   */
  oilTankIds: string[];
  /**
   * The gas meters this well sells through. Same shape as the tanks above, and
   * for the same reason: a lease split across two meters is ordinary.
   *
   * OPTIONAL, and undefined is not the same as empty: a form that does not show
   * the picker leaves it undefined and the write path leaves the well's meters
   * alone, where an empty list means "on none of them" and detaches.
   */
  meterIds?: string[];
  /**
   * Disposal wells only: the producing wells whose water comes down this hole.
   *
   * Drawn as `flow_connections` rather than an allocation row — the water side
   * traces through that table (`attributeToWells`), and everything downstream of
   * a well inherits it from there.
   */
  feederWellIds?: string[];
  /**
   * Producing wells only, and the mirror of `feederWellIds`: where this well's
   * SALTWATER goes — the tanks it stands in and the holes it goes down.
   *
   * A producer makes water whether or not anyone meant it to, and until it is
   * said where that water went, the disposal side of the map starts at a tank
   * with nothing above it. Both lists are `flow_connections` (a well's water is
   * not an allocation on the receiving facility — see the disposal-well picker
   * above), so they are written together as this well's downstream water: one
   * write for both, because that table's edit is "these, exactly" per side and
   * substance, and two writes would delete each other.
   */
  waterTankIds?: string[];
  injectionWellIds?: string[];
  /** API well number (regulatory identity), or "" if unset. */
  apiWellNo: string;
  /** Texas RRC lease / gas ID, or "" if unset. Producers only: an injection
   *  well files under its API / UIC permit, not a lease or gas ID. */
  rrcLeaseId: string;
  /** Operator's RRC operator number, or "" if unset. */
  rrcOperatorNo: string;
  /**
   * Injection-pump plunger size, as written in the field (`2 1/4"`), or "" if
   * unset. NOT edited here — the dialog only carries it so a save round-trips
   * the stored value instead of clearing the column. It belongs on the Info
   * sheet with the rest of the pump, where the pumper reads it.
   */
  plungerSize: string;
  /** The lease this well is assigned to (`wells.lease_id`), or null. */
  leaseId: string | null;
  /**
   * How the hole was drilled, or null when nobody has said.
   *
   * Null is a real value here and is the honest answer for most older wells:
   * it is seeded from the RRC completion packet, which only reaches back a few
   * years. The blank option below MEANS unknown; it does not mean vertical.
   */
  wellboreProfile: WellboreProfile | null;
  /** Whether the well is active (vs. retired: shut-in or sold). */
  active: boolean;
  /** The date the hole was plugged (`YYYY-MM-DD`), or null. Set means plugged,
   * and a plugged well is always inactive. */
  pluggedAt: string | null;
}

interface WellInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Render in place (no modal shell) — used by the facilities detail modal's
   *  Settings tab, so the same form serves both. */
  inline?: boolean;
  /** Raise above the modal that opened this one, so its backdrop blurs it. */
  elevated?: boolean;

  info: WellInfo;
  onSave: (info: WellInfo) => void;
  /** Dialog heading. Defaults to "Well info". */
  title?: string;
  /** Submit button label. Defaults to "Save". */
  submitLabel?: string;
  /** Leases to choose from. When omitted, the lease selector is hidden (e.g.
   * the create-well flow, where the lease is set later from the lease page). */
  leases?: { id: string; name: string }[];
  /** Oil tanks the well can be assigned to. When omitted, the Tank selector is
   * hidden (e.g. the create-well flow, before any tank exists for the well). */
  tanks?: {
    id: string;
    name: string;
    bblPerInch: number;
    leaseId?: string | null;
    /** Defaults to oil. A disposal well's tanks are the saltwater ones. */
    product?: "oil" | "water";
  }[];
  /** Gas meters the well can sell through; omit to hide the picker. */
  meters?: {
    id: string;
    name: string;
    leaseId?: string | null;
    /** Defaults to gas. A disposal well is measured by water meters. */
    substance?: "gas" | "water";
  }[];
  /** Quick-adds for the two lists above: a well is usually the first thing on a
   *  new lease, and the tank it fills may not exist yet either. Omit to hide. */
  onCreateLease?: (name: string) => Promise<{ id: string; name: string }>;
  onCreateTank?: (
    tankNo: string,
    /** The lease the well is on: half the tank's name, so it is not left off. */
    leaseId: string | null,
    product: "oil" | "water",
    /** Which page a new water tank lands on; see `WaterService`. */
    waterService?: "production" | "disposal"
  ) => Promise<{ id: string; name: string; bblPerInch: number }>;
  onCreateMeter?: (
    meterNo: string,
    leaseId: string | null,
    substance: "gas" | "water"
  ) => Promise<{ id: string; name: string }>;
  /** Producing wells, for a disposal well's feeder picker. */
  producingWells?: { id: string; name: string; leaseId?: string | null }[];
  onCreateProducingWell?: (
    name: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  /** Disposal wells, for a producing well's water pickers. The saltwater tanks
   *  beside them come out of `tanks` above — the water-product ones. */
  injectionWells?: { id: string; name: string; leaseId?: string | null }[];
  onCreateInjectionWell?: (
    name: string,
    leaseId: string | null
  ) => Promise<{ id: string; name: string }>;
  /** Show the active/inactive toggle (edit/settings only — a new well is always
   * active). */
  showActive?: boolean;
  /**
   * Offer Sync with RRC (settings only). A well being CREATED has no name the
   * state would recognise yet, and the button would have nothing to search on.
   */
  showRrcSync?: boolean;
  /** Extra classes for the modal shell (e.g. `max-w-2xl` to widen the settings
   * dialog to match the tank settings modal). */
  className?: string;
}

/** The stored depth as an editable string; 0 and non-numbers read as blank so a
 *  well nobody has measured shows an empty box rather than a made-up zero. */
function depthToText(depth: number): string {
  return Number.isFinite(depth) && depth !== 0 ? String(depth) : "";
}

/** The typed depth back to the stored number. Anything unparseable (blank, a
 *  stray unit) is 0 — the same "unset" the field shows as blank. */
function textToDepth(text: string): number {
  const n = Number(text.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function WellInfoDialog({
  open,
  onOpenChange,
  inline = false,
  elevated = false,
  info,
  onSave,
  title = "Well info",
  submitLabel = "Save",
  leases,
  onCreateLease,
  onCreateTank,
  onCreateMeter,
  tanks,
  meters,
  producingWells,
  onCreateProducingWell,
  injectionWells,
  onCreateInjectionWell,
  showActive = false,
  showRrcSync = false,
  className,
}: WellInfoDialogProps) {
  const [draft, setDraft] = useState<WellInfo>(info);
  const { guard, gate } = useTierUpgradeGate();
  /*
   * A disposal well has no oil tank and no gas meter. It takes saltwater down a
   * hole: its facilities are the water tank the fluid stands in and the water
   * meter that counts what went down, so both lists follow the well's TYPE
   * rather than being handed a single flavour by the caller.
   */
  const disposal = draft.type === "injection";
  const tankOptions = (tanks ?? []).filter(
    (t) => (t.product ?? "oil") === (disposal ? "water" : "oil")
  );
  const meterOptions = (meters ?? []).filter(
    (m) => (m.substance ?? "gas") === (disposal ? "water" : "gas")
  );
  /** The saltwater tanks, for the producer's water pickers below. On a disposal
   *  well these ARE `tankOptions`, and the pickers are hidden. */
  const waterTanks = (tanks ?? []).filter((t) => t.product === "water");
  /*
   * Depth is held as the TEXT the user typed, not as a number, and parsed once
   * on save.
   *
   * Storing it as a number meant every keystroke round-tripped through
   * `Number(...)` and back into the field, so the field fought whoever was
   * typing in it: clearing it re-rendered a `0` that could not be deleted, and a
   * half-typed decimal ("7." on the way to "7.5") parsed to 7 and threw the
   * point away. A plain text box holds what was typed until there is a reason to
   * interpret it, which is the moment the form is submitted.
   */
  const [depthText, setDepthText] = useState(() => depthToText(info.depth));

  /*
   * Which boxes the RRC just filled, so they can be marked until the form is
   * saved. Keys of `WellInfo`, and a key leaves the set the moment the user
   * types over it — the mark says "this came from the state record", and a
   * value someone has since edited did not.
   */
  const [rrcFilled, setRrcFilled] = useState<ReadonlySet<string>>(new Set());
  const rrcMark = (key: keyof WellInfo) =>
    rrcFilled.has(key) ? RRC_FILLED_FIELD : undefined;

  function unmark(keys: string[]) {
    setRrcFilled((filled) => {
      if (!keys.some((k) => filled.has(k))) return filled;
      const next = new Set(filled);
      for (const k of keys) next.delete(k);
      return next;
    });
  }

  /** Edit one or more fields, dropping their RRC mark. */
  function edit(patch: Partial<WellInfo>) {
    setDraft((d) => ({ ...d, ...patch }));
    unmark(Object.keys(patch));
  }

  const draftState = wellState(draft);

  /**
   * Picking a state writes both columns; `statusPatch` is that rule, and it is
   * shared with the tests rather than restated here. The date defaults to today
   * so the field is never empty while Plugged is selected; an operator who knows
   * the real date changes it.
   */
  function setState(next: WellState) {
    edit(
      statusPatch(next, {
        existing: draft.pluggedAt ?? info.pluggedAt,
        today: format(new Date(), "yyyy-MM-dd"),
      })
    );
  }

  function applyRrc(values: RrcWellFill) {
    setDraft((d) => ({ ...d, ...values }));
    if (values.depth !== undefined) setDepthText(depthToText(values.depth));
    setRrcFilled(new Set(Object.keys(values)));
  }

  // Re-seed the form from the latest info whenever the dialog (re)opens — done in
  // render (not an effect) to match the other dialogs and avoid cascading renders.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(info);
      setDepthText(depthToText(info.depth));
      setRrcFilled(new Set());
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Bringing a retired well back is a billable well appearing, so it asks the
    // same question a create does. Gated HERE rather than in each settings
    // surface: this dialog is the one place that knows both the well's previous
    // state and the draft. `updateWell` still enforces the cap server-side.
    //
    // Un-plugging goes through the same gate for the same reason: it lands on
    // `active: true` (a plugged well is inactive), so it is one more well on the
    // bill either way.
    if (info.active === false && draft.active === true) {
      const consented = await guard(async () => true);
      if (!consented) return;
    }
    onSave({
      ...draft,
      name: draft.name.trim() || info.name,
      depth: textToDepth(depthText),
    });
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
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="grid flex-1 grid-cols-2 content-start gap-4 overflow-y-auto px-5 py-5">
          <Field label="Name">
            <Input
              className="h-11"
              value={draft.name}
              onChange={(e) =>
                setDraft((d) => ({ ...d, name: e.target.value }))
              }
            />
          </Field>
          {(leases || onCreateLease) && (
            <PickerField
              label="Lease"
              className={rrcMark("leaseId")}
              value={draft.leaseId ?? ""}
              options={leases ?? []}
              placeholder="Unassigned"
              onChange={(id) => edit({ leaseId: id || null })}
              add={
                onCreateLease
                  ? { label: "New lease", create: onCreateLease }
                  : undefined
              }
            />
          )}
          <Field label="Type">
            <Select
              value={draft.type}
              onValueChange={(v) =>
                setDraft((d) => ({ ...d, type: v as WellType }))
              }
            >
              <SelectTrigger className="h-11 w-full">
                <span>
                  {draft.type === "injection" ? "Disposal" : "Production"}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="producer">Production</SelectItem>
                <SelectItem value="injection">Disposal</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Formation">
            <Input
              className={cn("h-11", rrcMark("formation"))}
              value={draft.formation}
              onChange={(e) => edit({ formation: e.target.value })}
            />
          </Field>
          <Field label="County">
            <Input
              className={cn("h-11", rrcMark("county"))}
              value={draft.county}
              onChange={(e) => edit({ county: e.target.value })}
            />
          </Field>

          <Field label="Wellbore profile">
            <Select
              value={draft.wellboreProfile ?? NO_PROFILE}
              onValueChange={(v) =>
                edit({
                  wellboreProfile:
                    v === NO_PROFILE ? null : (v as WellboreProfile),
                })
              }
            >
              <SelectTrigger
                className={cn("h-11 w-full", rrcMark("wellboreProfile"))}
              >
                <span>
                  {draft.wellboreProfile
                    ? PROFILE_LABELS[draft.wellboreProfile]
                    : "Unknown"}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROFILE}>Unknown</SelectItem>
                {PROFILE_ORDER.map((profile) => (
                  <SelectItem key={profile} value={profile}>
                    {PROFILE_LABELS[profile]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Depth (ft)">
            {/* A plain text box: `inputMode` still brings up the numeric
                keypad on a tablet, without the spinner and the per-keystroke
                re-parse that made this unusable. */}
            <Input
              className={cn("h-11", rrcMark("depth"))}
              inputMode="decimal"
              value={depthText}
              onChange={(e) => {
                setDepthText(e.target.value);
                unmark(["depth"]);
              }}
            />
          </Field>
          <Field label="Date drilled">
            <DatePicker
              value={draft.dateDrilled ? parseISO(draft.dateDrilled) : null}
              onChange={(d) =>
                edit({ dateDrilled: d ? format(d, "yyyy-MM-dd") : "" })
              }
              className={cn("h-11 w-full", rrcMark("dateDrilled"))}
            />
          </Field>

          <Field label="Perforations">
            <Input
              className={cn("h-11", rrcMark("perforations"))}
              value={draft.perforations}
              onChange={(e) => edit({ perforations: e.target.value })}
            />
          </Field>
          <Field label="Coordinates">
            <Input
              className={cn("h-11", rrcMark("coordinates"))}
              value={draft.coordinates}
              onChange={(e) => edit({ coordinates: e.target.value })}
            />
          </Field>

          {/* Regulatory identity. The API number is the one an operator knows and
              types; the RRC lease / gas ID and operator number are the state
              record's own keys and are written by the RRC match
              (`rrc/link.ts:404`), so typing them here was a second, hand-kept
              copy of a fact the match already owns. */}
          <Field label="API well #">
            <Input
              className={cn("h-11", rrcMark("apiWellNo"))}
              value={draft.apiWellNo}
              onChange={(e) => edit({ apiWellNo: e.target.value })}
            />
          </Field>
          {/* Assignments + status — the oil tank (its strapping factor) and
              active/inactive. Shown only where the option data is supplied
              (settings). The lease sits at the top, beside the name: it is half
              of what every facility on this well is called. */}
          {/* "Tanks" alone, next to the saltwater ones below, said nothing about
              which — and on a disposal well this list IS the saltwater tanks.
              Each says its product. */}
          {(tanks || onCreateTank) && (
            <Field label={disposal ? "Saltwater tanks" : "Oil tanks"}>
              <MultiPicker
              options={tanks ?? []}
              leaseId={draft.leaseId}
              selected={draft.oilTankIds}
              placeholder="Unassigned"
              empty={disposal ? "No saltwater tanks yet." : "No oil tanks yet."}
              onChange={(ids) => {
                const first = tankOptions.find((t) => t.id === ids[0]);
                setDraft((d) => ({
                  ...d,
                  oilTankIds: ids,
                  // Mirror the first tank's strapping factor so oil readings
                  // convert with it right away (the edit-data modal reads
                  // oilBblPerInch); with none chosen it falls back to 1.
                  oilBblPerInch: first ? first.bblPerInch : 1,
                }));
              }}
              add={
                onCreateTank
                  ? {
                      label: "New tank",
                      // A tank has no name of its own — the number painted on it
                      // plus its lease IS the name (`tankDisplayName`), so both
                      // are asked for. The lease starts on the well's own, which
                      // is where a tank made from this form nearly always goes,
                      // and stays editable for the time it does not.
                      field: "Tank #",
                      extra: {
                        label: "Lease",
                        options: leases ?? [],
                        value: draft.leaseId ?? "",
                        placeholder: "Unassigned",
                      },
                      create: async (tankNo: string, leaseId?: string) => {
                        const made = await onCreateTank(
                          tankNo,
                          leaseId || null,
                          disposal ? "water" : "oil",
                          // An SWD well's own tank sits at the station.
                          "disposal"
                        );
                        setDraft((d) => ({ ...d, oilBblPerInch: made.bblPerInch }));
                        return made;
                      },
                    }
                  : undefined
              }
              />
            </Field>
          )}
          {disposal && (producingWells || onCreateProducingWell) && (
            <Field label="Producing wells">
              <MultiPicker
                options={producingWells ?? []}
                leaseId={draft.leaseId}
                selected={draft.feederWellIds ?? []}
                placeholder="None"
                empty="No producing wells yet."
                onChange={(ids) =>
                  setDraft((d) => ({ ...d, feederWellIds: ids }))
                }
                add={
                  onCreateProducingWell
                    ? {
                        label: "New well",
                        extra: {
                          label: "Lease",
                          options: leases ?? [],
                          value: draft.leaseId ?? "",
                          placeholder: "Unassigned",
                        },
                        create: (name: string, leaseId?: string) =>
                          onCreateProducingWell(name, leaseId || null),
                      }
                    : undefined
                }
              />
            </Field>
          )}
          {(meters || onCreateMeter) && (
            <Field label={disposal ? "Water meters" : "Gas meters"}>
              <MultiPicker
                options={meterOptions}
                leaseId={draft.leaseId}
                selected={draft.meterIds ?? []}
                placeholder="Unassigned"
                empty={disposal ? "No water meters yet." : "No gas meters yet."}
                onChange={(ids) => setDraft((d) => ({ ...d, meterIds: ids }))}
                add={
                  onCreateMeter
                    ? {
                        label: "New meter",
                        // A meter's name is its lease plus the number the
                        // gatherer's statements carry (`meterDisplayName`).
                        field: "Meter #",
                        extra: {
                          label: "Lease",
                          options: leases ?? [],
                          value: draft.leaseId ?? "",
                          placeholder: "Unassigned",
                        },
                        create: (meterNo: string, leaseId?: string) =>
                          onCreateMeter(
                            meterNo,
                            leaseId || null,
                            disposal ? "water" : "gas"
                          ),
                      }
                    : undefined
                }
              />
            </Field>
          )}
          {/* Where this producer's water goes. Hidden on a disposal well, whose
              own water pickers are the two above (its tanks and its meters) —
              a hole does not send water anywhere. */}
          {!disposal && (tanks || onCreateTank) && (
            <Field label="Saltwater tanks">
              <MultiPicker
                options={waterTanks}
                leaseId={draft.leaseId}
                selected={draft.waterTankIds ?? []}
                placeholder="None"
                empty="No saltwater tanks yet."
                onChange={(ids) => setDraft((d) => ({ ...d, waterTankIds: ids }))}
                add={
                  onCreateTank
                    ? {
                        label: "New tank",
                        field: "Tank #",
                        extra: {
                          label: "Lease",
                          options: leases ?? [],
                          value: draft.leaseId ?? "",
                          placeholder: "Unassigned",
                        },
                        /* A PRODUCER's saltwater tank: it catches water off
                           this well's separator, so it belongs to production,
                           not to a disposal station. */
                        create: (tankNo: string, leaseId?: string) =>
                          onCreateTank(
                            tankNo,
                            leaseId || null,
                            "water",
                            "production"
                          ),
                      }
                    : undefined
                }
              />
            </Field>
          )}
          {!disposal && (injectionWells || onCreateInjectionWell) && (
            <Field label="Disposal wells">
              <MultiPicker
                options={injectionWells ?? []}
                leaseId={draft.leaseId}
                selected={draft.injectionWellIds ?? []}
                placeholder="None"
                empty="No disposal wells yet."
                onChange={(ids) =>
                  setDraft((d) => ({ ...d, injectionWellIds: ids }))
                }
                add={
                  onCreateInjectionWell
                    ? {
                        label: "New disposal well",
                        extra: {
                          label: "Lease",
                          options: leases ?? [],
                          value: draft.leaseId ?? "",
                          placeholder: "Unassigned",
                        },
                        create: (name: string, leaseId?: string) =>
                          onCreateInjectionWell(name, leaseId || null),
                      }
                    : undefined
                }
              />
            </Field>
          )}
          {showActive && (
            <Field label="Status">
              <Select
                value={draftState}
                onValueChange={(v) => setState(v as WellState)}
              >
                <SelectTrigger className="h-11 w-full">
                  <span>{STATUS_LABELS[draftState]}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="plugged">Plugged</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {showActive && draftState === "plugged" && (
            <Field label="Plugged">
              <DatePicker
                value={draft.pluggedAt ? parseISO(draft.pluggedAt) : null}
                onChange={(d) =>
                  // Never back to null while Plugged is selected: the date IS
                  // the flag, and clearing it would silently un-plug the well.
                  edit({
                    pluggedAt: d ? format(d, "yyyy-MM-dd") : draft.pluggedAt,
                  })
                }
                className="h-11 w-full"
              />
            </Field>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
          {showRrcSync ? (
            <RrcSyncButton
              disabled={!draft.name.trim() && !draft.apiWellNo.trim()}
              sync={(apiNumber) =>
                syncWellFromRrc({
                  name: draft.name,
                  apiWellNo: apiNumber ?? draft.apiWellNo,
                })
              }
              onFilled={applyRrc}
            />
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={!draft.name.trim()}>
            {submitLabel}
          </Button>
        </div>
      </form>
      {gate}
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
