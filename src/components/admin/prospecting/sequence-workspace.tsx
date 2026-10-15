"use client";

import { useState, useTransition } from "react";
import { Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ACCOUNTING_HEADER_CLASS,
  ACCOUNTING_HEADER_ROW_CLASS,
  ACCOUNTING_ROW_CLASS,
  ACCOUNTING_TABLE_CLASS,
} from "@/components/accounting/accounting-table";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { EmailComposeCard, type ComposeInit } from "@/components/admin/email/email-compose-card";
import { cn } from "@/lib/utils";
import type { EmailIndex } from "@/lib/admin/google/gmail/suggest";
import type { EmailSettings } from "@/lib/admin/google/gmail/email-style";
import type { EmailDraftDirective } from "@/lib/admin/google/gmail/draft-spec";
import { draftOutreachEmail } from "@/lib/admin/outreach/draft";
import { cancelScheduledEmail, deleteEnrollment, recordStep } from "@/lib/admin/outreach/sequence-actions";
import { addToOutbox } from "@/lib/admin/outreach/outbox-actions";
import type { ScheduledEmail } from "@/lib/admin/outreach/settings";
import type { Outbox } from "@/lib/admin/outreach/outbox-types";
import {
  DEFAULT_SEQUENCE_STEPS,
  todayInAdminZone,
  type Enrollment,
  type EventOutcome,
  type ProspectingSettings,
  type SequenceAction,
} from "@/lib/admin/outreach/types";

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const when = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Chicago",
});

const OUTCOME_LABEL: Record<string, string> = {
  sent: "Emailed",
  scheduled: "Email scheduled",
  outboxed: "In outbox",
  done: "Called",
  no_answer: "No answer",
  replied: "Replied",
  meeting: "Meeting booked",
  skipped: "Skipped",
};

/** "Email 2 of 3" for a step: its action and how many of that action the cadence holds. */
function stepLabel(stepIndex: number): { action: SequenceAction; text: string } {
  const steps = DEFAULT_SEQUENCE_STEPS;
  const step = steps[stepIndex];
  if (!step) return { action: "email", text: "Done" };
  const same = steps.filter((s) => s.action === step.action);
  const n = same.indexOf(step) + 1;
  return { action: step.action, text: `${step.action === "email" ? "Email" : "Call"} ${n} of ${same.length}` };
}

/**
 * The Sequence tab: every enrolled company, what is due and when, with the
 * day's work first. Draft opens the Email page's compose card with Orion's
 * draft in it; the user sends, or adds it to an outbox. Calls are the
 * user's own; the row records the outcome and moves on.
 */
export function SequenceWorkspace({
  enrollments,
  scheduled,
  outboxes = [],
  settings,
  emailIndex,
  emailSettings,
  onChanged,
}: {
  enrollments: Enrollment[];
  scheduled: ScheduledEmail[];
  /** The open outboxes a draft can be added to (the /outbound Queue tab). */
  outboxes?: Outbox[];
  settings: ProspectingSettings;
  emailIndex: EmailIndex;
  emailSettings: EmailSettings;
  onChanged: () => void;
}) {
  const [, startTransition] = useTransition();
  const [drafting, setDrafting] = useState<string | null>(null);
  const [compose, setCompose] = useState<{
    key: string;
    enrollment: Enrollment;
    init: ComposeInit;
    draft: { nonce: number; directive: EmailDraftDirective };
    title: string;
  } | null>(null);
  const today = todayInAdminZone();

  async function handleDraft(e: Enrollment) {
    setDrafting(e.id);
    try {
      const d = await draftOutreachEmail(e.id);
      setCompose({
        key: `seq-${e.id}-${e.stepIndex}`,
        enrollment: e,
        init: { to: d.to, subject: d.subject },
        draft: { nonce: 1, directive: { to: d.to, subject: d.subject, html: d.html } },
        title: d.subject,
      });
    } catch (error) {
      console.error("Failed to draft", error);
      toast.error("Couldn't draft the email.");
    } finally {
      setDrafting(null);
    }
  }

  function record(e: Enrollment, action: SequenceAction, outcome: EventOutcome) {
    startTransition(async () => {
      try {
        await recordStep(e.id, action, outcome);
      } catch (error) {
        console.error("Failed to record the step", error);
        toast.error("Couldn't record that.");
      }
      onChanged();
    });
  }

  function remove(e: Enrollment) {
    startTransition(async () => {
      try {
        await deleteEnrollment(e.id);
      } catch (error) {
        console.error("Failed to delete the enrollment", error);
        toast.error("Couldn't delete it.");
      }
      onChanged();
    });
  }

  // The draft, in the app's modal: dimmed + blurred page, Escape to close,
  // the card's own fields and Send / Add to outbox inside.
  const draftModal = compose && (
    <SwipeUpModal
      open
      onClose={() => setCompose(null)}
      title={compose.title || "New message"}
      className="sm:max-w-4xl"
    >
      <div className="flex h-[80vh] max-h-full min-h-0 flex-col">
        <EmailComposeCard
          cardKey={compose.key}
          init={compose.init}
          index={emailIndex}
          settings={emailSettings}
          draft={compose.draft}
          onSubjectChange={(subject) => setCompose((c) => (c ? { ...c, title: subject } : c))}
          onSent={() => {
            const e = compose.enrollment;
            setCompose(null);
            record(e, "email", "sent");
          }}
          schedule={{
            options: settings.schedules,
            existing: outboxes
              .filter((o) => o.status === "open")
              .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
              .map((o) => ({ id: o.id, label: `${o.scheduleName ?? "Outbox"} · ${when.format(new Date(o.dueAt))}` })),
            label: "Add to outbox",
            onSchedule: async (form, at) => {
              try {
                const { dueAt } = await addToOutbox({ enrollmentId: compose.enrollment.id, ...form, when: at });
                toast.success(`In the outbox for ${when.format(new Date(dueAt))} Central.`);
                setCompose(null);
                onChanged();
                return true;
              } catch (error) {
                console.error("Failed to add to the outbox", error);
                toast.error(error instanceof Error ? error.message : "Couldn't add it to the outbox.");
                return false;
              }
            },
          }}
        />
      </div>
    </SwipeUpModal>
  );

  const active = enrollments.filter((e) => e.state === "active");
  const rest = enrollments.filter((e) => e.state !== "active");

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Table className={ACCOUNTING_TABLE_CLASS}>
        <TableHeader className={ACCOUNTING_HEADER_CLASS}>
          <TableRow className={ACCOUNTING_HEADER_ROW_CLASS}>
            <TableHead>Company</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Step</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Last</TableHead>
            <TableHead className="w-72">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {enrollments.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                Nothing in a sequence yet. Enroll companies from the Enrich tab.
              </TableCell>
            </TableRow>
          ) : (
            [...active, ...rest].map((e) => {
              const step = stepLabel(e.stepIndex);
              const overdue = e.state === "active" && e.nextDueOn != null && e.nextDueOn < today;
              const dueToday = e.state === "active" && e.nextDueOn === today;
              return (
                <TableRow key={e.id} className={cn(ACCOUNTING_ROW_CLASS, "group/row", e.state !== "active" && "text-muted-foreground")}>
                  <TableCell className="font-medium">{e.companyName}</TableCell>
                  <TableCell>
                    {e.contact ? (
                      <>
                        <span>{e.contact.name ?? e.contact.email ?? "—"}</span>
                        {e.contact.name && e.contact.email && (
                          <span className="ml-2 text-xs text-muted-foreground">{e.contact.email}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Company{e.companyPhone ? ` · ${e.companyPhone}` : ""}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {e.state === "active" ? step.text : <Badge variant="outline">{e.state === "done" ? "Finished" : OUTCOME_LABEL[e.state] ?? e.state}</Badge>}
                  </TableCell>
                  <TableCell className={cn("tabular-nums", dueToday && "font-semibold", overdue && "font-semibold text-red-600 dark:text-red-400")}>
                    {e.nextDueOn ? (dueToday ? "Today" : overdue ? `Overdue · ${day.format(new Date(e.nextDueOn))}` : day.format(new Date(e.nextDueOn))) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {e.lastEvent ? `${OUTCOME_LABEL[e.lastEvent.outcome] ?? e.lastEvent.outcome} · ${day.format(new Date(e.lastEvent.happenedAt))}` : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {e.state === "active" &&
                        // An email waiting in an outbox already advanced the step; the next
                        // step's buttons wait until it has gone out.
                        (e.lastEvent?.outcome === "outboxed" ? (
                          <Badge variant="outline">In outbox</Badge>
                        ) : step.action === "email" ? (
                          <Button size="xs" onClick={() => handleDraft(e)} disabled={drafting === e.id || !e.contact?.email}>
                            {drafting === e.id && <Loader2Icon className="animate-spin" />}
                            Draft
                          </Button>
                        ) : (
                          <>
                            <Button size="xs" variant="outline" onClick={() => record(e, "call", "done")}>
                              Called
                            </Button>
                            <Button size="xs" variant="outline" onClick={() => record(e, "call", "no_answer")}>
                              No answer
                            </Button>
                          </>
                        ))}
                      <button
                        type="button"
                        aria-label={`Delete ${e.companyName} from the sequence`}
                        onClick={() => remove(e)}
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive group-hover/row:opacity-100 focus-visible:opacity-100"
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {scheduled.length > 0 && (
        <section className="border-t">
          <h3 className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Scheduled emails</h3>
          <Table className={ACCOUNTING_TABLE_CLASS}>
            <TableBody>
              {scheduled.map((s) => (
                <TableRow key={s.id} className={ACCOUNTING_ROW_CLASS}>
                  <TableCell>{s.to}</TableCell>
                  <TableCell className="font-medium">{s.subject}</TableCell>
                  <TableCell className="tabular-nums">
                    {when.format(new Date(s.sendAt))}
                    {s.scheduleName ? <span className="ml-1 text-xs text-muted-foreground">· {s.scheduleName}</span> : null}
                  </TableCell>
                  <TableCell>
                    {s.status === "failed" ? (
                      <span className="text-red-600 dark:text-red-400" title={s.error ?? undefined}>
                        Failed
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Pending</span>
                    )}
                  </TableCell>
                  <TableCell className="w-10">
                    <button
                      type="button"
                      aria-label="Cancel"
                      onClick={() =>
                        startTransition(async () => {
                          await cancelScheduledEmail(s.id).catch(() => toast.error("Couldn't cancel it."));
                          onChanged();
                        })
                      }
                      className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive group-hover:opacity-100"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {draftModal}
    </div>
  );
}
