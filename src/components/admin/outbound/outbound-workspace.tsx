"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OutboundToolbar, type OutboundTab } from "@/components/admin/outbound/outbound-toolbar";
import { SequenceWorkspace } from "@/components/admin/prospecting/sequence-workspace";
import { OutboxWorkspace } from "@/components/admin/outbound/outbox-workspace";
import { NewOutboxModal } from "@/components/admin/outbound/new-outbox-modal";
import { ProspectingSettingsModal } from "@/components/admin/prospecting/prospecting-settings-modal";
import { clearEnrollments } from "@/lib/admin/outreach/sequence-actions";
import type { ScheduledEmail } from "@/lib/admin/outreach/settings";
import type { Outbox } from "@/lib/admin/outreach/outbox-types";
import { todayInAdminZone, type Enrollment, type ProspectingSettings } from "@/lib/admin/outreach/types";
import type { EmailIndex } from "@/lib/admin/google/gmail/suggest";
import type { EmailSettings } from "@/lib/admin/google/gmail/email-style";
import { useServerState } from "@/hooks/use-server-state";

const count = new Intl.NumberFormat("en-US");

/**
 * /outbound: the outbound pipeline. Its Queue tab is the Sequence tab of
 * /prospecting (same rows, same `SequenceWorkspace`, same settings sheet);
 * its Outbox tab holds the batches the Queue's drafts are added to.
 */
export function OutboundWorkspace({
  enrollments,
  scheduled,
  outboxes,
  settings: initialSettings,
  emailIndex,
  emailSettings,
}: {
  enrollments: Enrollment[];
  scheduled: ScheduledEmail[];
  outboxes: Outbox[];
  settings: ProspectingSettings;
  /** For the compose card the Queue tab opens: autofill and signature. */
  emailIndex: EmailIndex;
  emailSettings: EmailSettings;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tab, setTab] = useState<OutboundTab>("queue");
  const [settings, setSettings] = useServerState<ProspectingSettings>(initialSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clearingSequence, setClearingSequence] = useState(false);
  const [newOutbox, setNewOutbox] = useState(false);
  const refresh = useCallback(() => router.refresh(), [router]);
  const active = enrollments.filter((e) => e.state === "active").length;
  const dueToday = enrollments.filter((e) => e.state === "active" && e.nextDueOn != null && e.nextDueOn <= todayInAdminZone()).length;
  const openOutboxes = outboxes.filter((o) => o.status === "open").length;

  const handleClearSequence = useCallback(() => {
    startTransition(async () => {
      try {
        await clearEnrollments();
      } catch (error) {
        console.error("Failed to clear the sequence", error);
        toast.error("Couldn't clear the sequence.");
      }
      router.refresh();
    });
  }, [router]);

  const queueActions = (
    <>
      <div className="flex items-center gap-3 whitespace-nowrap text-sm tabular-nums text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{count.format(active)}</span>{" "}
          {active === 1 ? "enrollment" : "enrollments"}
        </span>
        <span>
          <span className="font-medium text-foreground">{count.format(dueToday)}</span> due today
        </span>
      </div>
      {enrollments.length > 0 && (
        <Button size="sm" variant="outline" className="h-9 text-muted-foreground hover:text-destructive" onClick={() => setClearingSequence(true)}>
          Clear
        </Button>
      )}
      <Button size="sm" variant="outline" className="h-9" onClick={() => setSettingsOpen(true)}>
        <SettingsIcon />
        Settings
      </Button>
    </>
  );

  const outboxActions = (
    <>
      <div className="flex items-center gap-3 whitespace-nowrap text-sm tabular-nums text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{count.format(openOutboxes)}</span> {openOutboxes === 1 ? "outbox" : "outboxes"}
        </span>
      </div>
      <Button size="sm" className="h-9" onClick={() => setNewOutbox(true)}>
        <PlusIcon />
        New outbox
      </Button>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OutboundToolbar tab={tab} onTab={setTab} actions={tab === "queue" ? queueActions : outboxActions} />
      {tab === "queue" && (
        <SequenceWorkspace
          enrollments={enrollments}
          scheduled={scheduled}
          outboxes={outboxes}
          settings={settings}
          emailIndex={emailIndex}
          emailSettings={emailSettings}
          onChanged={refresh}
        />
      )}
      {tab === "outbox" && <OutboxWorkspace outboxes={outboxes} emailSettings={emailSettings} onChanged={refresh} />}
      {newOutbox && <NewOutboxModal schedules={settings.schedules} onClose={() => setNewOutbox(false)} onCreated={refresh} />}
      <ProspectingSettingsModal
        key={settingsOpen ? "open" : "closed"}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        emailSettings={emailSettings}
        onSaved={setSettings}
      />
      <ConfirmDialog
        open={clearingSequence}
        onClose={() => setClearingSequence(false)}
        onConfirm={handleClearSequence}
        title="Clear the sequence?"
        description={`Removes all ${enrollments.length} enrollments, their history and any emails still scheduled for them. This can't be undone.`}
        confirmLabel="Clear"
        destructive
      />
    </div>
  );
}
