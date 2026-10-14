"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SettingsIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OutboundToolbar, type OutboundTab } from "@/components/admin/outbound/outbound-toolbar";
import { SequenceWorkspace } from "@/components/admin/prospecting/sequence-workspace";
import { ProspectingSettingsSheet } from "@/components/admin/prospecting/prospecting-settings-sheet";
import { clearEnrollments } from "@/lib/admin/outreach/sequence-actions";
import type { ScheduledEmail } from "@/lib/admin/outreach/settings";
import { todayInAdminZone, type Enrollment, type ProspectingSettings } from "@/lib/admin/outreach/types";
import type { EmailIndex } from "@/lib/admin/google/gmail/suggest";
import type { EmailSettings } from "@/lib/admin/google/gmail/email-style";
import { useServerState } from "@/hooks/use-server-state";

const count = new Intl.NumberFormat("en-US");

/**
 * /outbound: the outbound pipeline. Its Queue tab is the Sequence tab of
 * /prospecting (same rows, same `SequenceWorkspace`, same settings sheet),
 * the first of the tabs this page will hold.
 */
export function OutboundWorkspace({
  enrollments,
  scheduled,
  settings: initialSettings,
  emailIndex,
  emailSettings,
}: {
  enrollments: Enrollment[];
  scheduled: ScheduledEmail[];
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
  const refresh = useCallback(() => router.refresh(), [router]);
  const active = enrollments.filter((e) => e.state === "active").length;
  const dueToday = enrollments.filter((e) => e.state === "active" && e.nextDueOn != null && e.nextDueOn <= todayInAdminZone()).length;

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OutboundToolbar tab={tab} onTab={setTab} actions={tab === "queue" ? queueActions : null} />
      {tab === "queue" && (
        <SequenceWorkspace
          enrollments={enrollments}
          scheduled={scheduled}
          settings={settings}
          emailIndex={emailIndex}
          emailSettings={emailSettings}
          onChanged={refresh}
        />
      )}
      <ProspectingSettingsSheet
        key={settingsOpen ? "open" : "closed"}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
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
