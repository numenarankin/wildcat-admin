"use client";

/**
 * The pickers every facility form is built from.
 *
 * One rule holds all of them: whatever a facility is being attached to can be
 * MADE from the list you went looking for it in. A tank needs a battery, a
 * battery needs a lease, a well needs a tank, a meter needs a gatherer — and the
 * moment any of those is missing is the moment somebody is halfway through a
 * form with everything else already typed. Sending them to another page to add
 * it throws that away, so every list ends with "New …" instead.
 *
 * Deliberately domain-free: both take `{ id, name }` and a create function, so
 * the well form, the tank form, the meter form and the battery form share one
 * behaviour rather than four near-copies of it.
 */

import { useState } from "react";
import { CheckIcon, ChevronDownIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { cn } from "@/lib/utils";

/** The "no selection" row's value; empty string is not a legal Select value. */
export const NONE = "__none__";
/** The "New …" row at the bottom of a list. */
const NEW = "__new__";

/** One thing in a list, and the lease it sits on when that is known. */
export interface PickerOption {
  id: string;
  name: string;
  /** Used only for ordering — see {@link sameLeaseFirst}. */
  leaseId?: string | null;
}

/**
 * The lease's own facilities first, then everything else, each half A-Z.
 *
 * Wiring is nearly always within a lease: the tank a well runs to is on that
 * well's lease in all but the exceptions, and in an org with two hundred tanks
 * the four that matter should not be somewhere in the alphabet. The rest stay
 * offered, because the exceptions are real.
 */
export function sameLeaseFirst<T extends PickerOption>(
  options: T[],
  leaseId: string | null | undefined
): T[] {
  const collate = (a: T, b: T) =>
    a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
  if (!leaseId) return [...options].sort(collate);
  const here = options.filter((o) => o.leaseId === leaseId).sort(collate);
  const rest = options.filter((o) => o.leaseId !== leaseId).sort(collate);
  return [...here, ...rest];
}

/** What a quick-add asks for. Usually a name; a tank's is its number. */
export interface QuickAdd {
  /** Runs the create and resolves to the row, which is then selected. */
  create: (value: string, extra?: string) => Promise<{ id: string; name: string }>;
  /** Menu wording, e.g. "New battery". Also the modal's title and its button. */
  label: string;
  /** The modal field's label. "Name" unless the thing is named some other way. */
  field?: string;
  /**
   * A second choice the new thing needs, seeded with the sensible answer: the
   * lease a tank made from a well's form goes on is that well's lease. It stays
   * a picker because the operator may be putting the tank somewhere else, which
   * is the whole reason to ask here rather than to decide for them.
   */
  extra?: {
    label: string;
    options: { id: string; name: string }[];
    value: string;
    placeholder: string;
  };
}

/**
 * A single-choice picker whose LAST option makes the thing being picked.
 *
 * The name is asked for in its own small modal (`elevated`, so it sits over the
 * form that opened it) and the new row is selected the instant it exists — the
 * form behind it keeps everything already typed. Rows made here stay in the list
 * until the page's own data carries them, or the trigger would fall back to the
 * placeholder and read exactly like a create that failed.
 */
export function PickerField({
  label,
  value,
  options,
  placeholder,
  disabled = false,
  leaseId,
  onChange,
  add,
  className,
}: {
  label: string;
  value: string;
  options: PickerOption[];
  /** Extra classes for the trigger (the settings form's RRC-filled mark). */
  className?: string;
  /** What the trigger reads when nothing is chosen ("None", "Standalone"). */
  placeholder: string;
  disabled?: boolean;
  /** Sort this lease's own facilities to the top (see {@link sameLeaseFirst}). */
  leaseId?: string | null;
  onChange: (id: string) => void;
  add?: QuickAdd;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [extra, setExtra] = useState(add?.extra?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<PickerOption[]>([]);
  const all = sameLeaseFirst(
    [...options, ...created.filter((c) => !options.some((o) => o.id === c.id))],
    leaseId
  );
  const selectedName = all.find((o) => o.id === value)?.name;

  async function run() {
    const typed = draft.trim();
    if (!typed || busy || !add) return;
    setBusy(true);
    try {
      const made = await add.create(typed, extra);
      setCreated((prev) => [...prev, made]);
      onChange(made.id);
      setDraft("");
      setAddOpen(false);
    } catch (error) {
      console.error(`Failed: ${add.label}`, error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <Select
        value={value || NONE}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === NEW) {
            setDraft("");
            setExtra(add?.extra?.value ?? "");
            setAddOpen(true);
            return;
          }
          onChange(v && v !== NONE ? v : "");
        }}
      >
        <SelectTrigger className={cn("h-11 w-full", className)}>
          {/* Render the resolved name, not the raw id: Radix's SelectValue
              shows the raw value for a programmatically-set selection. */}
          <span className={selectedName ? "" : "text-muted-foreground"}>
            {selectedName ?? placeholder}
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{placeholder}</SelectItem>
          {all.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
          {add ? (
            <SelectItem value={NEW}>
              <span className="flex items-center gap-2">
                <PlusIcon className="size-4" />
                {add.label}
              </span>
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>

      {add ? (
        <QuickAddModal
          add={add}
          open={addOpen}
          value={draft}
          extra={extra}
          busy={busy}
          onValue={setDraft}
          onExtra={setExtra}
          onClose={() => setAddOpen(false)}
          onSubmit={run}
        />
      ) : null}
    </div>
  );
}

/**
 * Several of the same thing, chosen with checks, and one more made from the same
 * list.
 *
 * A tank belongs to the wells that drain into it, and on a lease that is
 * normally more than one — a single-choice picker makes the commonest case ("all
 * four of them") the one the form cannot express.
 */
export function MultiPicker({
  options,
  selected,
  placeholder,
  empty = "Nothing to pick yet.",
  leaseId,
  onChange,
  add,
}: {
  options: PickerOption[];
  selected: string[];
  placeholder: string;
  /** Shown when there is nothing in the list at all. */
  empty?: string;
  /** Sort this lease's own facilities to the top (see {@link sameLeaseFirst}). */
  leaseId?: string | null;
  onChange: (ids: string[]) => void;
  add?: QuickAdd;
}) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [extra, setExtra] = useState(add?.extra?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<PickerOption[]>([]);
  const all = sameLeaseFirst(
    [...options, ...created.filter((c) => !options.some((o) => o.id === c.id))],
    leaseId
  );

  const toggle = (id: string) =>
    onChange(
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    );

  async function run() {
    const typed = draft.trim();
    if (!typed || busy || !add) return;
    setBusy(true);
    try {
      const made = await add.create(typed, extra);
      setCreated((prev) => [...prev, made]);
      // Made from inside a list of things this one feeds: it is wanted, so it is
      // ticked. Un-ticking it is one click; finding it again is not.
      onChange([...selected, made.id]);
      setDraft("");
      setAddOpen(false);
    } catch (error) {
      console.error(`Failed: ${add.label}`, error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent/50",
            selected.length === 0 && "text-muted-foreground"
          )}
        >
          {selected.length === 0 ? (
            <span className="truncate">{placeholder}</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {selected.map((id) => (
                <span key={id} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
                  {all.find((o) => o.id === id)?.name ?? id}
                </span>
              ))}
            </span>
          )}
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className="max-h-(--available-height) w-(--anchor-width) overflow-y-auto p-1"
        >
          {all.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {empty}
            </p>
          ) : (
            <ul>
              {all.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => toggle(o.id)}
                  >
                    <span className="min-w-0 truncate">{o.name}</span>
                    {selected.includes(o.id) && (
                      <CheckIcon className="size-4 shrink-0" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {add ? (
            <button
              type="button"
              className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded-md border-t px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setDraft("");
                setExtra(add?.extra?.value ?? "");
                setAddOpen(true);
                setOpen(false);
              }}
            >
              <PlusIcon className="size-4" />
              {add.label}
            </button>
          ) : null}
        </PopoverContent>
      </Popover>

      {add ? (
        <QuickAddModal
          add={add}
          open={addOpen}
          value={draft}
          extra={extra}
          busy={busy}
          onValue={setDraft}
          onExtra={setExtra}
          onClose={() => setAddOpen(false)}
          onSubmit={run}
        />
      ) : null}
    </>
  );
}

/** The one-field modal both pickers make things in. */
function QuickAddModal({
  add,
  open,
  value,
  extra,
  busy,
  onValue,
  onExtra,
  onClose,
  onSubmit,
}: {
  add: QuickAdd;
  open: boolean;
  value: string;
  extra: string;
  busy: boolean;
  onValue: (value: string) => void;
  onExtra: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <SwipeUpModal open={open} onClose={onClose} title={add.label} className="max-w-sm" elevated>
      <div className="flex flex-col gap-4 px-5 py-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{add.field ?? "Name"}</span>
          <Input
            autoFocus
            className="h-11"
            value={value}
            onChange={(e) => onValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
        </label>
        {add.extra ? (
          <PickerField
            label={add.extra.label}
            value={extra}
            options={add.extra.options}
            placeholder={add.extra.placeholder}
            onChange={onExtra}
          />
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
        <Button type="button" variant="outline" size="lg" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          size="lg"
          disabled={!value.trim() || busy}
          onClick={onSubmit}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : null}
          {add.label}
        </Button>
      </div>
    </SwipeUpModal>
  );
}
