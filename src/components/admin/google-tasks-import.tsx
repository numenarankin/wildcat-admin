"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { syncGoogleTasksToBoard } from "@/lib/admin/google/tasks-actions";

/**
 * Runs once when the team board opens: adds the admin's new open Google tasks
 * to Queue (`tasks/import.ts`), then refreshes so the cards appear. The board
 * renders first; this never holds the page up. Renders nothing.
 */
export function GoogleTasksImport() {
  const router = useRouter();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void syncGoogleTasksToBoard().then((r) => {
      if ("error" in r) toast.error(`Couldn't add your Google tasks: ${r.error}`);
      else if (r.added > 0) {
        toast.success(`Added ${r.added} ${r.added === 1 ? "task" : "tasks"} from Google Tasks to Queue.`);
        router.refresh();
      }
    });
  }, [router]);
  return null;
}
