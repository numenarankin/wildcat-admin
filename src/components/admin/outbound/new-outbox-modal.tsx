"use client";

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { createOutbox } from "@/lib/admin/outreach/outbox-actions";
import type { SendSchedule } from "@/lib/admin/outreach/types";

const when = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Chicago",
});

/**
 * New outbox: pick one of the named schedules (its next occurrence) or a
 * time. An outbox already open for that moment is simply the one you get.
 */
export function NewOutboxModal({
  schedules,
  onClose,
  onCreated,
}: {
  schedules: SendSchedule[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(pick: { at: string } | { scheduleId: string }) {
    setBusy(true);
    try {
      const { dueAt } = await createOutbox(pick);
      toast.success(`Outbox for ${when.format(new Date(dueAt))} Central.`);
      onCreated();
      onClose();
    } catch (error) {
      console.error("Failed to create the outbox", error);
      toast.error(error instanceof Error ? error.message : "Couldn't create the outbox.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SwipeUpModal open onClose={onClose} title="New outbox" className="sm:max-w-md">
      <div className="flex flex-col gap-4 p-4">
        {schedules.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {schedules.map((s) => (
              <Button key={s.id} variant="outline" className="h-9 justify-start" disabled={busy} onClick={() => create({ scheduleId: s.id })}>
                {s.name}
              </Button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            aria-label="Due at"
            className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          />
          <Button className="h-9" disabled={busy || !at} onClick={() => at && create({ at: new Date(at).toISOString() })}>
            {busy && <Loader2Icon className="animate-spin" />}
            Create
          </Button>
        </div>
      </div>
    </SwipeUpModal>
  );
}
