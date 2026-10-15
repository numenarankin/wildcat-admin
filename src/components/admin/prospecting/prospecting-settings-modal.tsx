"use client";

import { useState } from "react";
import { Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { SignatureEditor } from "@/components/admin/email/rich-text";
import { cleanSignature, fontCss, hasContent, sizePx, type EmailSettings } from "@/lib/admin/google/gmail/email-style";
import { saveProspectingSettings } from "@/lib/admin/outreach/settings-actions";
import { DEFAULT_SUBJECT, DEFAULT_TEMPLATE, templateHtml, type ProspectingSettings, type SendSchedule } from "@/lib/admin/outreach/types";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The outreach settings: the email template Orion drafts from, in the same
 * rich editor as the signature (Settings > Email), with that signature shown
 * under it the way the sent mail carries it; and the named schedules the
 * compose card's Schedule menu offers. One Save.
 */
export function ProspectingSettingsModal({
  open,
  onOpenChange,
  settings,
  emailSettings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ProspectingSettings;
  /** The sender's font, size and signature (Settings > Email). */
  emailSettings: EmailSettings;
  onSaved: (settings: ProspectingSettings) => void;
}) {
  const [draft, setDraft] = useState<ProspectingSettings>(() => ({ ...settings, template: templateHtml(settings.template) }));
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const font = fontCss(emailSettings.fontFamily);
  const px = sizePx(emailSettings.fontSize);
  const signature = hasContent(emailSettings.signatureHtml) ? cleanSignature(emailSettings.signatureHtml) : "";

  function setSchedule(id: string, patch: Partial<SendSchedule>) {
    setDraft((d) => ({ ...d, schedules: d.schedules.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  }

  function resetTemplate() {
    setDraft((d) => ({ ...d, subject: DEFAULT_SUBJECT, template: DEFAULT_TEMPLATE }));
    setEditorKey((k) => k + 1);
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
    <SwipeUpModal open={open} onClose={() => onOpenChange(false)} title="Outreach settings" className="sm:max-w-2xl">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Email template</h3>
            <Button size="xs" variant="ghost" onClick={resetTemplate}>
              Reset
            </Button>
          </div>
          <Input
            value={draft.subject}
            onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
            placeholder="Subject"
            aria-label="Subject"
            className="h-9"
          />
          <SignatureEditor
            key={editorKey}
            initialHtml={draft.template}
            onChange={(html) => setDraft((d) => ({ ...d, template: html }))}
            fontCss={font}
            fontPx={px}
            trailer={
              signature ? (
                <div
                  aria-label="Signature"
                  className="mt-4 select-none opacity-70 [&_a]:text-blue-600! [&_a]:underline [&_p]:my-0"
                  dangerouslySetInnerHTML={{ __html: signature }}
                />
              ) : null
            }
          />
          <p className="text-xs text-muted-foreground">
            Placeholders: <code>{"{{first_name}}"}</code> <code>{"{{company}}"}</code> <code>{"{{wells}}"}</code>{" "}
            <code>{"{{county}}"}</code>
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
    </SwipeUpModal>
  );
}
