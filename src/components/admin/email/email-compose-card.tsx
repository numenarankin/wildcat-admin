"use client";

import { useMemo, useState } from "react";
import { CalendarClockIcon, ChevronDownIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SendSchedule } from "@/lib/admin/outreach/types";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/projects/markdown-editor";
import { sendGmailMessage } from "@/lib/admin/google/gmail-actions";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { SLICE_PRIORITY } from "@/lib/ai/page-context";
import type { EmailDraftDirective } from "@/lib/admin/google/gmail/draft-spec";
import { composeSeed, fontCss, sizePx, type EmailSettings } from "@/lib/admin/google/gmail/email-style";
import { emailDocument } from "@/lib/admin/google/gmail/view";
import type { GmailAttachment } from "@/lib/admin/google/gmail/types";
import { EMAIL_TEXT_STYLE } from "@/components/admin/email/rich-text";
import { GhostInput } from "@/components/admin/email/ghost-input";
import { completeRecipient, completeSubject, type EmailIndex } from "@/lib/admin/google/gmail/suggest";

/** What a compose card starts from: blank, a reply, or a forward. */
export interface ComposeInit {
  to?: string;
  cc?: string;
  subject?: string;
  /** The message being answered or forwarded, as Gmail quotes it; sent under the body. */
  quoted?: string;
  /** Reply: the thread and the message it answers, for threading. */
  reply?: { threadId: string; inReplyTo: string | null; references: string | null };
  /** Forward: the original's attachments, carried along. */
  forward?: { messageId: string; attachments: GmailAttachment[] };
}

/**
 * A draft: Gmail's compose window. To, Cc/Bcc on request, Subject, the body
 * in the notes editor with Send and formatting under it. A reply or a forward
 * shows what it quotes under the body, folded behind "•••", and sends it
 * along. Nothing is saved to Gmail until Send; closing discards the draft.
 *
 * Orion can fill it (`draft`, from the `draft_email` tool) and can never
 * send it: Send is this form's submit, refused unless the browser marks the
 * event as the user's own (`isTrusted`). A script, or anything Orion could
 * cause, cannot produce a trusted event.
 */
export function EmailComposeCard({
  cardKey,
  init,
  settings,
  index,
  draft,
  onSent,
  onSubjectChange,
  schedule,
}: {
  cardKey: string;
  init: ComposeInit;
  /** Past recipients and subjects, for the inline autofill (Tab accepts). */
  index: EmailIndex;
  /** The admin's font and signature (/email Settings). */
  settings: EmailSettings;
  /** Orion's latest draft for this card; a new `nonce` applies it once. */
  draft?: { nonce: number; directive: EmailDraftDirective } | null;
  onSent: (threadId: string) => void;
  /** The card's tab and title follow the subject. */
  onSubjectChange: (subject: string) => void;
  /**
   * Scheduled sending (the Prospecting Sequence tab): a Schedule menu beside
   * Send with the page's named schedules and a one-off time. The handler
   * queues the message for the cron; the card closes when it resolves true.
   */
  schedule?: {
    options: SendSchedule[];
    onSchedule: (
      form: { to: string; cc: string; bcc: string; subject: string; html: string },
      when: { at: string } | { scheduleId: string }
    ) => Promise<boolean>;
  };
}) {
  const [form, setForm] = useState(() => ({
    to: init.to ?? "",
    cc: init.cc ?? "",
    bcc: "",
    subject: init.subject ?? "",
    html: composeSeed(settings.signatureHtml),
  }));
  // The body the editor mounts with; a new key remounts it with a new seed.
  const [seedHtml, setSeedHtml] = useState(() => composeSeed(settings.signatureHtml));
  const [editorKey, setEditorKey] = useState(0);
  const [showCopies, setShowCopies] = useState(Boolean(init.cc));
  const [showQuoted, setShowQuoted] = useState(false);
  const [attachments, setAttachments] = useState(init.forward?.attachments ?? []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The one-off time being picked for Schedule, as the input's local value. */
  const [pickAt, setPickAt] = useState<string | null>(null);

  async function handleSchedule(when: { at: string } | { scheduleId: string }) {
    if (!schedule || sending) return;
    if (!(form.to.trim() || form.cc.trim() || form.bcc.trim())) {
      setError("Add a recipient.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const html = init.quoted ? `${form.html}<br>${init.quoted}` : form.html;
      const ok = await schedule.onSchedule({ ...form, html }, when);
      if (!ok) setError("Couldn't schedule the email.");
    } finally {
      setSending(false);
      setPickAt(null);
    }
  }

  // Orion's draft, applied once per nonce (render-time, as `CustomerPanelModal` re-seeds).
  const [appliedNonce, setAppliedNonce] = useState<number | null>(null);
  if (draft && draft.nonce !== appliedNonce) {
    setAppliedNonce(draft.nonce);
    const d = draft.directive;
    setForm((prev) => ({
      ...prev,
      to: d.to ?? prev.to,
      cc: d.cc ?? prev.cc,
      bcc: d.bcc ?? prev.bcc,
      subject: d.subject ?? prev.subject,
    }));
    if (d.cc || d.bcc) setShowCopies(true);
    if (d.html !== undefined) {
      // Orion's body, then the signature, as the user would have it.
      const html = composeSeed(settings.signatureHtml, d.html);
      setSeedHtml(html);
      setForm((prev) => ({ ...prev, html }));
      setEditorKey((k) => k + 1);
    }
    setError(null);
  }

  usePageContextSlice(`admin-email-compose-${cardKey}`, {
    priority: SLICE_PRIORITY.modal,
    label: init.reply ? "Open: a reply they are writing (not sent)" : init.forward ? "Open: a forward they are writing (not sent)" : "Open: a new email they are writing (not sent)",
    lines: [
      `To: ${form.to || "(empty)"}${form.cc ? `; Cc: ${form.cc}` : ""}${form.bcc ? `; Bcc: ${form.bcc}` : ""}`,
      `Subject: ${form.subject || "(empty)"}`,
    ],
  });

  const set = (key: keyof typeof form) => (value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === "subject") onSubjectChange(value);
    setError(null);
  };

  const quotedDoc = useMemo(() => (init.quoted ? emailDocument(init.quoted, true) : null), [init.quoted]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Only the user's own click or Enter sends. Never remove this check.
    if (!e.nativeEvent.isTrusted) return;
    if (sending) return;
    setSending(true);
    setError(null);
    const html = init.quoted ? `${form.html}<br>${init.quoted}` : form.html;
    const res = await sendGmailMessage(
      { ...form, html },
      {
        reply: init.reply,
        forward: init.forward ? { messageId: init.forward.messageId, partIds: attachments.map((a) => a.partId) } : undefined,
      }
    );
    setSending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast.success("Sent.");
    onSent(res.data.threadId);
  }

  /**
   * One Gmail-style header row: a muted label (or placeholder) and a bare
   * input on a rule, completing from what the admin has sent before.
   */
  const row = (key: "to" | "cc" | "bcc" | "subject", label: string, extra?: React.ReactNode) => (
    <label className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-sm">
      {key !== "subject" && <span className="text-muted-foreground">{label}</span>}
      <GhostInput
        inputMode={key === "subject" ? undefined : "email"}
        autoFocus={key === "to" && !init.to}
        placeholder={key === "subject" ? label : undefined}
        aria-label={label}
        value={form[key]}
        onChange={set(key)}
        complete={(v) => (key === "subject" ? completeSubject(v, index.subjects) : completeRecipient(v, index.contacts))}
      />
      {extra}
    </label>
  );

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      {row(
        "to",
        "To",
        !showCopies && (
          <button type="button" onClick={() => setShowCopies(true)} className="text-muted-foreground hover:text-foreground">
            Cc Bcc
          </button>
        )
      )}
      {showCopies && row("cc", "Cc")}
      {showCopies && row("bcc", "Bcc")}
      {row("subject", "Subject")}
      {error && <p className="shrink-0 px-4 pt-2 text-sm text-destructive">{error}</p>}
      <div className="flex min-h-0 flex-1 flex-col" style={{ fontFamily: fontCss(settings.fontFamily), fontSize: sizePx(settings.fontSize) }}>
        <MarkdownEditor
          key={editorKey}
          fileId={`compose-${cardKey}-${editorKey}`}
          initialContent={seedHtml}
          onChange={set("html")}
          contentClassName="px-4 py-3 [&_p]:my-0 [&_a]:text-blue-600! [&_a]:underline"
          extraExtensions={EMAIL_TEXT_STYLE}
          toolbarBottom
          toolbarEnd={
            <div className="flex items-center gap-2">
              {schedule && pickAt !== null && (
                <>
                  <input
                    type="datetime-local"
                    value={pickAt}
                    onChange={(e) => setPickAt(e.target.value)}
                    aria-label="Send at"
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9"
                    disabled={sending || !pickAt}
                    onClick={() => pickAt && handleSchedule({ at: new Date(pickAt).toISOString() })}
                  >
                    Schedule
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel" onClick={() => setPickAt(null)}>
                    <XIcon />
                  </Button>
                </>
              )}
              {schedule && pickAt === null && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button type="button" variant="outline" className="h-9 rounded-full px-4" disabled={sending} />}
                  >
                    <CalendarClockIcon />
                    Schedule
                    <ChevronDownIcon className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {schedule.options.map((s) => (
                      <DropdownMenuItem key={s.id} className="cursor-pointer" onClick={() => handleSchedule({ scheduleId: s.id })}>
                        {s.name}
                      </DropdownMenuItem>
                    ))}
                    {schedule.options.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem className="cursor-pointer" onClick={() => setPickAt("")}>
                      Pick a time…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button type="submit" className="h-9 rounded-full px-5 shadow-[0_0_8px_rgba(0,0,0,0.18)]" disabled={sending || !(form.to.trim() || form.cc.trim() || form.bcc.trim())}>
                {sending && <Loader2Icon className="animate-spin" />}
                Send
              </Button>
            </div>
          }
          footer={
            (quotedDoc || attachments.length > 0) && (
              <div className="flex flex-col gap-2 px-4 pb-3">
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {attachments.map((a) => (
                      <span
                        key={a.partId}
                        className="ty-caption flex items-center gap-1 rounded-md border border-border bg-background py-1 pr-1 pl-2 text-primary-text"
                      >
                        <PaperclipIcon className="size-3.5 text-tertiary-text" />
                        <span className="max-w-[180px] truncate">{a.filename}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${a.filename}`}
                          onClick={() => setAttachments((prev) => prev.filter((x) => x.partId !== a.partId))}
                          className="rounded p-0.5 text-tertiary-text hover:text-primary-text"
                        >
                          <XIcon className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {quotedDoc && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowQuoted((v) => !v)}
                      aria-label={showQuoted ? "Hide quoted text" : "Show quoted text"}
                      title={showQuoted ? "Hide quoted text" : "Show quoted text"}
                      className="inline-flex h-4 items-center rounded-full bg-muted px-2 text-[10px] leading-none tracking-widest text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      •••
                    </button>
                    {showQuoted && (
                      <iframe
                        title="Quoted message"
                        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                        referrerPolicy="no-referrer"
                        srcDoc={quotedDoc}
                        className="mt-2 block h-72 w-full rounded border border-border bg-white"
                      />
                    )}
                  </div>
                )}
              </div>
            )
          }
        />
      </div>
    </form>
  );
}
