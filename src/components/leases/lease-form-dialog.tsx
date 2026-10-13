"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { RrcSyncButton } from "@/components/facilities/rrc-sync-button";
import { syncLeaseFromRrc } from "@/lib/rrc/facility-sync";
import type { RrcLeaseFill } from "@/lib/rrc/facility-fill";
import { cn } from "@/lib/utils";

/**
 * A box the RRC filled on this open, and that has not been saved yet. Matches
 * the well settings form (`well-info-dialog.tsx`), which is the other half of
 * the same button.
 */
const RRC_FILLED_FIELD =
  "border-amber-500/70 bg-amber-500/5 dark:border-amber-400/60";

/** The editable shape of a lease. */
export interface LeaseFormValues {
  /** The lease number — optional, unique per org when set. */
  leaseNo: string;
  name: string;
  county: string;
  active: boolean;
}

export const EMPTY_LEASE: LeaseFormValues = {
  leaseNo: "",
  name: "",
  county: "",
  active: true,
};

/**
 * Create/edit modal for a lease — mirrors `TankFormDialog`. `onSave` receives
 * the trimmed draft; the caller persists it via the lease server actions.
 */
export function LeaseFormDialog({
  open,
  onOpenChange,
  values,
  onSave,
  title = "Lease",
  submitLabel = "Save",
  showActive = false,
  showRrcSync = false,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  values: LeaseFormValues;
  onSave: (values: LeaseFormValues) => void;
  title?: string;
  submitLabel?: string;
  /** Show the active/inactive status selector (edit/settings only). */
  showActive?: boolean;
  /**
   * Offer Sync with RRC (settings only). A lease being CREATED has no name the
   * state would recognise yet, and the button would have nothing to search on.
   */
  showRrcSync?: boolean;
  /** Extra classes for the modal shell (e.g. `max-w-2xl` for settings). */
  className?: string;
}) {
  const [draft, setDraft] = useState<LeaseFormValues>(values);
  /*
   * Which boxes the RRC just filled, so they can be marked until the form is
   * saved. A key leaves the set the moment the user types over it: the mark
   * says "this came from the state record", and an edited value did not.
   */
  const [rrcFilled, setRrcFilled] = useState<ReadonlySet<string>>(new Set());
  const rrcMark = (key: keyof LeaseFormValues) =>
    rrcFilled.has(key) ? RRC_FILLED_FIELD : undefined;

  /** Edit one or more fields, dropping their RRC mark. */
  function edit(patch: Partial<LeaseFormValues>) {
    setDraft((d) => ({ ...d, ...patch }));
    setRrcFilled((filled) => {
      const keys = Object.keys(patch);
      if (!keys.some((k) => filled.has(k))) return filled;
      const next = new Set(filled);
      for (const k of keys) next.delete(k);
      return next;
    });
  }

  function applyRrc(fill: RrcLeaseFill) {
    setDraft((d) => ({ ...d, ...fill }));
    setRrcFilled(new Set(Object.keys(fill)));
  }

  // Re-seed the form whenever the dialog (re)opens — done in render (not an
  // effect) to match the other dialogs and avoid cascading renders.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(values);
      setRrcFilled(new Set());
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    onSave({
      ...draft,
      leaseNo: draft.leaseNo.trim(),
      name: draft.name.trim(),
    });
    onOpenChange(false);
  }

  return (
    <SwipeUpModal
      open={open}
      onClose={() => onOpenChange(false)}
      title={title}
      className={className}
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
          <Field label="Name">
            <Input
              className="h-11"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Smith A"
            />
          </Field>
          <Field label="Lease number (optional)">
            <Input
              className={cn("h-11", rrcMark("leaseNo"))}
              value={draft.leaseNo}
              onChange={(e) => edit({ leaseNo: e.target.value })}
              placeholder="12345"
            />
          </Field>
          <Field label="County">
            <Input
              className={cn("h-11", rrcMark("county"))}
              value={draft.county}
              onChange={(e) => edit({ county: e.target.value })}
              placeholder="Reagan"
            />
          </Field>
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
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
          {showRrcSync ? (
            <RrcSyncButton
              disabled={!draft.name.trim() && !draft.leaseNo.trim()}
              sync={() =>
                syncLeaseFromRrc({ name: draft.name, leaseNo: draft.leaseNo })
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
