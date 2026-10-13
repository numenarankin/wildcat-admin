"use client";

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { SettingsMessage, SettingsSection } from "@/components/settings/panel";
import { SignatureEditor } from "@/components/admin/email/rich-text";
import { saveEmailSettings } from "@/lib/admin/google/gmail/email-settings-actions";
import {
  EMAIL_FONTS,
  EMAIL_SIZES,
  fontCss,
  sizePx,
  type EmailSettings,
} from "@/lib/admin/google/gmail/email-style";

/**
 * /email's Settings tab: the default font for mail the admin sends, and their
 * signature. One Save for both.
 */
export function EmailSettingsView({
  settings,
  onSaved,
}: {
  settings: EmailSettings;
  onSaved: (settings: EmailSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty =
    draft.fontFamily !== settings.fontFamily ||
    draft.fontSize !== settings.fontSize ||
    draft.signatureHtml !== settings.signatureHtml;

  const change = (next: Partial<EmailSettings>) => {
    setDraft((prev) => ({ ...prev, ...next }));
    setNotice(null);
    setError(null);
  };

  async function save() {
    setSaving(true);
    const res = await saveEmailSettings(draft);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice("Saved.");
    onSaved(draft);
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background-surface">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-8">
        <SettingsSection
          title="Font"
          action={
            <div className="flex items-center gap-3">
              <SettingsMessage error={error} notice={notice} />
              <Button onClick={save} disabled={!dirty || saving}>
                {saving && <Loader2Icon className="animate-spin" />}
                Save
              </Button>
            </div>
          }
        >
          <div className="flex flex-wrap gap-3">
            <Select value={draft.fontFamily} onValueChange={(v) => v && change({ fontFamily: v as EmailSettings["fontFamily"] })}>
              <SelectTrigger className="h-9 w-48">
                <span style={{ fontFamily: fontCss(draft.fontFamily) }}>
                  {EMAIL_FONTS.find((f) => f.id === draft.fontFamily)?.label}
                </span>
              </SelectTrigger>
              <SelectContent className="light">
                {EMAIL_FONTS.map((f) => (
                  <SelectItem key={f.id} value={f.id} style={{ fontFamily: f.css }}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={draft.fontSize} onValueChange={(v) => v && change({ fontSize: v as EmailSettings["fontSize"] })}>
              <SelectTrigger className="h-9 w-32">
                <span>{EMAIL_SIZES.find((s) => s.id === draft.fontSize)?.label}</span>
              </SelectTrigger>
              <SelectContent className="light">
                {EMAIL_SIZES.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>

        <SettingsSection title="Signature">
          <SignatureEditor
            initialHtml={settings.signatureHtml}
            onChange={(html) => change({ signatureHtml: html })}
            fontCss={fontCss(draft.fontFamily)}
            fontPx={sizePx(draft.fontSize)}
          />
        </SettingsSection>
      </div>
    </div>
  );
}
