"use client";

/**
 * Recon alerts: the signed-in user's saved areas and what to email about them.
 *
 * Opened from the Alerts button in the Recon bar, or by `/recon?alerts=1`, the
 * "Manage alerts" link every alert email carries. A list of alerts, and a form
 * that replaces it for creating or editing one. A new alert starts on the
 * counties the map is showing.
 *
 * Laid out like the reports delivery modal (`ReportScheduleTable`): plain rules,
 * no frame, controls flush right.
 */

import { useEffect, useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CountyPicker } from "./map-filters";
import { COUNTY_NAMES } from "@/lib/scout/counties";
import {
  deleteReconAlert,
  listReconAlerts,
  saveReconAlert,
  setReconAlertEnabled,
} from "@/lib/recon-alerts/actions";
import {
  ALERT_KINDS,
  KIND_LABEL,
  type AlertFrequency,
  type ReconAlert,
  type ReconAlertInput,
} from "@/lib/recon-alerts/types";

const TIMEZONES = [
  { value: "America/Chicago", label: "Central" },
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Los_Angeles", label: "Pacific" },
];

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const FREQUENCY_LABEL: Record<AlertFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly (Fridays)",
};

function hourLabel(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${h < 12 ? "AM" : "PM"}`;
}

function countyLabel(codes: number[]): string {
  const names = codes.map((c) => COUNTY_NAMES[c] ?? String(c));
  return names.length <= 3
    ? names.join(", ")
    : `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function blank(counties: number[]): ReconAlertInput {
  return {
    name: "",
    countyCodes: counties,
    kinds: [...ALERT_KINDS],
    frequency: "daily",
    sendHour: 7,
    timezone: "America/Chicago",
    enabled: true,
  };
}

export function ReconAlertsModal({
  open,
  onClose,
  currentCounties,
}: {
  open: boolean;
  onClose: () => void;
  /** The counties the map is filtered to, as a new alert's starting area. */
  currentCounties: number[];
}) {
  const [alerts, setAlerts] = useState<ReconAlert[] | null>(null);
  /** The form: null = the list; `id: null` = a new alert. */
  const [editing, setEditing] = useState<{ id: string | null; draft: ReconAlertInput } | null>(null);
  const [deleting, setDeleting] = useState<ReconAlert | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listReconAlerts()
      .then((rows) => {
        if (!cancelled) setAlerts(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          setAlerts([]);
          toast.error(e instanceof Error ? e.message : "Could not load your alerts.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const close = () => {
    setEditing(null);
    onClose();
  };

  const save = () => {
    if (!editing) return;
    const { id, draft } = editing;
    startTransition(async () => {
      try {
        const saved = await saveReconAlert(id, draft);
        setAlerts((prev) =>
          id ? (prev ?? []).map((a) => (a.id === id ? saved : a)) : [...(prev ?? []), saved]
        );
        setEditing(null);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save the alert.");
      }
    });
  };

  const toggle = (alert: ReconAlert, enabled: boolean) => {
    setAlerts((prev) => (prev ?? []).map((a) => (a.id === alert.id ? { ...a, enabled } : a)));
    startTransition(async () => {
      try {
        await setReconAlertEnabled(alert.id, enabled);
      } catch (e) {
        setAlerts((prev) =>
          (prev ?? []).map((a) => (a.id === alert.id ? { ...a, enabled: !enabled } : a))
        );
        toast.error(e instanceof Error ? e.message : "Could not update the alert.");
      }
    });
  };

  const remove = (alert: ReconAlert) => {
    startTransition(async () => {
      try {
        await deleteReconAlert(alert.id);
        setAlerts((prev) => (prev ?? []).filter((a) => a.id !== alert.id));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not delete the alert.");
      }
    });
  };

  return (
    <SwipeUpModal
      open={open}
      onClose={close}
      title={editing ? (editing.id ? "Edit alert" : "New alert") : "Recon alerts"}
      // A fixed height, so the card does not jump between the list, an empty
      // list and the form; a long list scrolls inside it. Capped to the
      // viewport for short screens.
      className="h-[min(36rem,85vh)] max-w-5xl"
      headerAction={
        !editing ? (
          <Button size="sm" onClick={() => setEditing({ id: null, draft: blank(currentCounties) })}>
            New alert
          </Button>
        ) : undefined
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {editing ? (
          <AlertForm
            draft={editing.draft}
            onChange={(draft) => setEditing({ ...editing, draft })}
            onCancel={() => setEditing(null)}
            onSave={save}
            saving={pending}
          />
        ) : alerts == null ? null : alerts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No alerts yet.</p>
        ) : (
          <table className="w-full table-auto border-collapse text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="w-1/4 py-2 pr-4 text-left font-medium">Alert</th>
                <th scope="col" className="py-2 pr-4 text-left font-medium">Counties</th>
                <th scope="col" className="py-2 pr-4 text-left font-medium">Watching</th>
                <th scope="col" className="py-2 pr-4 text-left font-medium">Sent</th>
                <th scope="col" className="w-24 py-2 pl-4 text-right font-medium">On</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="py-3 pr-4 font-medium">{a.name}</td>
                  <td className="py-3 pr-4 text-muted-foreground">{countyLabel(a.countyCodes)}</td>
                  <td className="py-3 pr-4 text-muted-foreground">
                    {a.kinds.map((k) => KIND_LABEL[k]).join(", ")}
                  </td>
                  <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
                    {FREQUENCY_LABEL[a.frequency]} · {hourLabel(a.sendHour)}
                  </td>
                  <td className="py-3 pl-4">
                    <div className="flex items-center justify-end gap-1">
                      <Switch
                        checked={a.enabled}
                        onCheckedChange={(v) => toggle(a, v)}
                        aria-label={`${a.enabled ? "Turn off" : "Turn on"} ${a.name}`}
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Edit ${a.name}`}
                        onClick={() =>
                          setEditing({
                            id: a.id,
                            draft: {
                              name: a.name,
                              countyCodes: a.countyCodes,
                              kinds: a.kinds,
                              frequency: a.frequency,
                              sendHour: a.sendHour,
                              timezone: a.timezone,
                              enabled: a.enabled,
                            },
                          })
                        }
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${a.name}`}
                        onClick={() => setDeleting(a)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove(deleting)}
        title={`Delete ${deleting?.name ?? "alert"}?`}
        description="You will stop receiving it."
        confirmLabel="Delete"
        destructive
        elevated
      />
    </SwipeUpModal>
  );
}

function AlertForm({
  draft,
  onChange,
  onCancel,
  onSave,
  saving,
}: {
  draft: ReconAlertInput;
  onChange: (d: ReconAlertInput) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const set = (patch: Partial<ReconAlertInput>) => onChange({ ...draft, ...patch });
  const canSave = draft.countyCodes.length > 0 && draft.kinds.length > 0 && !saving;
  return (
    <div className="flex w-full flex-col gap-4">
      <Field label="Name">
        <Input
          className="w-64"
          value={draft.name}
          maxLength={120}
          placeholder={countyLabel(draft.countyCodes) || "Alert name"}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <Field label="Counties">
        <CountyPicker codes={draft.countyCodes} onChange={(countyCodes) => set({ countyCodes })} />
      </Field>
      <Field label="Watch">
        {ALERT_KINDS.map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.kinds.includes(k)}
              onCheckedChange={(on) =>
                set({
                  kinds: on
                    ? ALERT_KINDS.filter((x) => x === k || draft.kinds.includes(x))
                    : draft.kinds.filter((x) => x !== k),
                })
              }
            />
            {KIND_LABEL[k]}
          </label>
        ))}
      </Field>
      <Field label="Frequency">
        <Select
          value={draft.frequency}
          onValueChange={(v) => set({ frequency: (v as AlertFrequency) ?? draft.frequency })}
        >
          <SelectTrigger className="w-44">
            <span>{FREQUENCY_LABEL[draft.frequency]}</span>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FREQUENCY_LABEL) as AlertFrequency[]).map((f) => (
              <SelectItem key={f} value={f}>
                {FREQUENCY_LABEL[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Arrives at">
        <Select
          value={String(draft.sendHour)}
          onValueChange={(h) => set({ sendHour: Number(h ?? draft.sendHour) })}
        >
          <SelectTrigger className="w-32">
            <span>{hourLabel(draft.sendHour)}</span>
          </SelectTrigger>
          <SelectContent>
            {HOURS.map((h) => (
              <SelectItem key={h} value={String(h)}>
                {hourLabel(h)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={draft.timezone}
          onValueChange={(tz) => set({ timezone: tz ?? draft.timezone })}
        >
          <SelectTrigger className="w-36">
            <span>{TIMEZONES.find((t) => t.value === draft.timezone)?.label ?? draft.timezone}</span>
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz.value} value={tz.value}>
                {tz.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={!canSave}>
          Save
        </Button>
      </div>
    </div>
  );
}

/** A form row: its label on the left, its control flush to the right. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <span className="text-sm">{label}</span>
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}
