"use client";

import { useState } from "react";
import { Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { saveProspectingSettings } from "@/lib/admin/outreach/settings-actions";
import { DEFAULT_TEMPLATE, type ProspectingSettings, type SendSchedule } from "@/lib/admin/outreach/types";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The Prospecting page's settings: the template Orion drafts from and the
 * named schedules the compose card's Schedule menu offers. One Save.
 */
export function ProspectingSettingsSheet({
  open,
  onOpenChange,
  settings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ProspectingSettings;
  onSaved: (settings: ProspectingSettings) => void;
}) {
  const [draft, setDraft] = useState<ProspectingSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setSchedule(id: string, patch: Partial<SendSchedule>) {
    setDraft((d) => ({ ...d, schedules: d.schedules.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await saveProspectingSettings(draft);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved(draft);
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Prospecting settings</SheetTitle>
          <SheetDescription>The email template Orion drafts from, and the schedules you can send on.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 px-4 pb-4">
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Email template</h3>
              <Button size="xs" variant="ghost" onClick={() => setDraft((d) => ({ ...d, template: DEFAULT_TEMPLATE }))}>
                Reset
              </Button>
            </div>
            <textarea
              value={draft.template}
              onChange={(e) => setDraft((d) => ({ ...d, template: e.target.value }))}
              rows={12}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <p className="text-xs text-muted-foreground">
              Placeholders: <code>{"{{first_name}}"}</code> <code>{"{{company}}"}</code> <code>{"{{wells}}"}</code>{" "}
              <code>{"{{county}}"}</code>. Your signature is added under the body.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Send schedules</h3>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    schedules: [...d.schedules, { id: crypto.randomUUID(), name: "", weekday: 2, time: "08:00" }],
                  }))
                }
              >
                <PlusIcon className="size-3.5" />
                Add
              </Button>
            </div>
            {draft.schedules.length === 0 ? (
              <p className="text-xs text-muted-foreground">None yet. A schedule is a weekday (or every day) and a Central time.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {draft.schedules.map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <Input
                      value={s.name}
                      onChange={(e) => setSchedule(s.id, { name: e.target.value })}
                      placeholder="Name"
                      className="h-9 flex-1"
                    />
                    <Select
                      value={s.weekday === null ? "daily" : String(s.weekday)}
                      onValueChange={(v) => setSchedule(s.id, { weekday: v === "daily" ? null : Number(v) })}
                    >
                      <SelectTrigger className="h-9 w-32" aria-label="Weekday">
                        <SelectValue>{() => (s.weekday === null ? "Every day" : WEEKDAYS[s.weekday])}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">Every day</SelectItem>
                        {WEEKDAYS.map((w, i) => (
                          <SelectItem key={w} value={String(i)}>
                            {w}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="time"
                      value={s.time}
                      onChange={(e) => setSchedule(s.id, { time: e.target.value })}
                      className="h-9 w-28"
                      aria-label="Time (Central)"
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Remove schedule"
                      onClick={() => setDraft((d) => ({ ...d, schedules: d.schedules.filter((x) => x.id !== s.id) }))}
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2Icon className="animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
