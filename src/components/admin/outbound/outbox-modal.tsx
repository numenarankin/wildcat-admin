"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { MarkdownEditor } from "@/components/projects/markdown-editor";
import { EMAIL_TEXT_STYLE } from "@/components/admin/email/rich-text";
import { cn } from "@/lib/utils";
import { fontCss, sizePx, type EmailSettings } from "@/lib/admin/google/gmail/email-style";
import { removeOutboxEmail, sendOutbox, updateOutboxEmail } from "@/lib/admin/outreach/outbox-actions";
import { unsentEmails, type Outbox, type OutboxEmail } from "@/lib/admin/outreach/outbox-types";

const when = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Chicago",
});

/** Edits reach the row this long after the last keystroke. */
const SAVE_DELAY_MS = 600;

function statusLabel(e: OutboxEmail): { text: string; className: string } {
  if (e.status === "sent") return { text: "Sent", className: "text-muted-foreground" };
  if (e.status === "failed") return { text: "Failed", className: "text-red-600 dark:text-red-400" };
  return { text: "", className: "" };
}

/**
 * One outbox, open: every recipient down the left, the selected email on the
 * right where its subject and body can be changed in place, and Send to all
 * at the bottom. Edits save as the admin types; Send asks once, then sends
 * each unsent email through their Gmail and reports what went and what did
 * not. A sent outbox opens the same way, read only.
 */
export function OutboxModal({
  outbox,
  emailSettings,
  onClose,
  onChanged,
}: {
  outbox: Outbox;
  emailSettings: EmailSettings;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(outbox.emails[0]?.id ?? null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  // The edits in flight, by email id, so switching recipients and the server
  // refresh never roll the text back under the cursor.
  const [edits, setEdits] = useState<Record<string, { subject: string; html: string }>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const selected = outbox.emails.find((e) => e.id === selectedId) ?? outbox.emails[0] ?? null;
  const shown = selected ? (edits[selected.id] ?? { subject: selected.subject, html: selected.html }) : null;
  const unsent = useMemo(() => unsentEmails(outbox), [outbox]);
  const readOnly = outbox.status === "sent" || sending;

  useEffect(() => {
    const pending = timers.current;
    return () => Object.values(pending).forEach(clearTimeout);
  }, []);

  function edit(id: string, patch: Partial<{ subject: string; html: string }>) {
    const base = edits[id] ?? (() => {
      const row = outbox.emails.find((e) => e.id === id)!;
      return { subject: row.subject, html: row.html };
    })();
    const next = { ...base, ...patch };
    setEdits((prev) => ({ ...prev, [id]: next }));
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => {
      updateOutboxEmail(id, patch).catch((error) => {
        console.error("Failed to save the email", error);
        toast.error("Couldn't save that change.");
      });
    }, SAVE_DELAY_MS);
  }

  function remove(e: OutboxEmail) {
    startTransition(async () => {
      try {
        await removeOutboxEmail(e.id);
        if (outbox.emails.length === 1) onClose();
      } catch (error) {
        console.error("Failed to remove the email", error);
        toast.error("Couldn't remove it.");
      }
      onChanged();
    });
  }

  async function send() {
    setSending(true);
    try {
      // Flush edits still waiting on their timer before anything goes out.
      for (const [id, t] of Object.entries(timers.current)) {
        clearTimeout(t);
        const e = edits[id];
        if (e) await updateOutboxEmail(id, e);
      }
      timers.current = {};
      const report = await sendOutbox(outbox.id);
      if (report.failed.length === 0) {
        toast.success(`Sent ${report.sent} ${report.sent === 1 ? "email" : "emails"}.`);
        onClose();
      } else {
        toast.error(`Sent ${report.sent}, ${report.failed.length} failed. The failed ones stay in the outbox.`);
      }
    } catch (error) {
      console.error("Failed to send the outbox", error);
      toast.error(error instanceof Error ? error.message : "Couldn't send the outbox.");
    } finally {
      setSending(false);
      onChanged();
    }
  }

  return (
    <SwipeUpModal
      open
      onClose={onClose}
      title={outbox.scheduleName ?? "Outbox"}
      description={`${when.format(new Date(outbox.dueAt))} Central`}
      className="sm:max-w-6xl"
    >
      <div className="flex h-[80vh] max-h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1">
          <ul className="w-72 shrink-0 overflow-y-auto border-r">
            {outbox.emails.map((e) => {
              const status = statusLabel(e);
              const isSelected = selected?.id === e.id;
              return (
                <li key={e.id} className="group/row relative">
                  <button
                    type="button"
                    onClick={() => setSelectedId(e.id)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left text-sm hover:bg-accent/50",
                      isSelected && "bg-accent"
                    )}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate font-medium">{e.companyName ?? e.to}</span>
                      {status.text && <span className={cn("shrink-0 text-xs", status.className)}>{status.text}</span>}
                    </span>
                    <span className="w-full truncate text-xs text-muted-foreground">
                      {e.contactName ? `${e.contactName} · ${e.to}` : e.to}
                    </span>
                  </button>
                  {e.status !== "sent" && !readOnly && (
                    <button
                      type="button"
                      aria-label={`Remove ${e.to} from the outbox`}
                      onClick={() => remove(e)}
                      className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-destructive group-hover/row:opacity-100 focus-visible:opacity-100"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex min-h-0 flex-1 flex-col">
            {selected && shown ? (
              <>
                <label className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-sm">
                  <span className="text-muted-foreground">To</span>
                  <span className="truncate">{[selected.to, selected.cc, selected.bcc].filter(Boolean).join(", ")}</span>
                </label>
                <label className="flex h-10 shrink-0 items-center border-b px-4 text-sm">
                  <input
                    aria-label="Subject"
                    value={shown.subject}
                    readOnly={readOnly}
                    onChange={(ev) => edit(selected.id, { subject: ev.target.value })}
                    className="w-full bg-transparent outline-none placeholder:text-muted-foreground"
                    placeholder="Subject"
                  />
                </label>
                {selected.status === "failed" && selected.error && (
                  <p className="shrink-0 px-4 pt-2 text-sm text-destructive">{selected.error}</p>
                )}
                <div
                  className="flex min-h-0 flex-1 flex-col overflow-y-auto"
                  style={{ fontFamily: fontCss(emailSettings.fontFamily), fontSize: sizePx(emailSettings.fontSize) }}
                >
                  <MarkdownEditor
                    key={`${selected.id}-${readOnly}`}
                    fileId={`outbox-${selected.id}`}
                    initialContent={shown.html}
                    onChange={(html) => edit(selected.id, { html })}
                    readOnly={readOnly}
                    embedded
                    contentClassName="px-4 py-3 [&_p]:my-0 [&_a]:text-blue-600! [&_a]:underline"
                    extraExtensions={EMAIL_TEXT_STYLE}
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Nothing in this outbox.</div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3 border-t px-4 py-3">
          {outbox.status === "sent" ? (
            <span className="text-sm text-muted-foreground">Sent {outbox.sentAt ? `${when.format(new Date(outbox.sentAt))} Central` : ""}</span>
          ) : (
            <Button className="h-9 rounded-full px-5" disabled={sending || unsent.length === 0} onClick={() => setConfirming(true)}>
              {sending && <Loader2Icon className="animate-spin" />}
              Send to all
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void send()}
        title={`Send ${unsent.length} ${unsent.length === 1 ? "email" : "emails"}?`}
        description="Each goes out now through your Gmail. This can't be undone."
        confirmLabel="Send"
        elevated
      />
    </SwipeUpModal>
  );
}
