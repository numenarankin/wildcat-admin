"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TasksBoard } from "@/components/tasks/tasks-board";
import { SalesToolbar, type SalesTab } from "@/components/admin/sales/sales-toolbar";
import { ProspectsTable } from "@/components/admin/sales/prospects-table";
import { ProspectsBoard } from "@/components/admin/sales/prospects-board";
import { ProspectModal } from "@/components/admin/sales/prospect-modal";
import { useServerState } from "@/hooks/use-server-state";
import {
  createProspect,
  deleteProspect,
  moveProspect,
  updateProspect,
} from "@/lib/admin/prospect-actions";
import { ADMIN_TASK_ACTIONS } from "@/lib/admin/task-board";
import type { Prospect, ProspectInput, ProspectStage } from "@/lib/admin/prospect-types";
import { ADMIN_TASK_COLUMNS, type Task } from "@/lib/tasks/tasks";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { prospectModalSlice, prospectsSlice, tabSlice } from "@/lib/ai/admin/page-slices";

// Horizontal padding that lines content up with the topbar page label (matches
// AppMain's padded routes; this route is full-bleed for the toolbar's rule).
const GUTTER = "px-[77px] md:px-[85px]";

/**
 * /admin/sales: the project workspace's shape (tab switch · title · add
 * actions) over three surfaces. Prospects and Pipeline are two views of ONE
 * list held here, so a card dragged to Trial is the row whose Stage reads
 * Trial. Tasks is the customer task board over the admin team's own table.
 */
export function SalesWorkspace({
  prospects: initialProspects,
  tasks,
  assignees,
}: {
  prospects: Prospect[];
  tasks: Task[];
  /** The admin roster, by email; the task modal's assignee list. */
  assignees: string[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tab, setTab] = useState<SalesTab>("prospects");
  // Rows move the moment they're dragged or typed; the refresh that follows
  // each write hands the list back to the server.
  const [prospects, setProspects] = useServerState<Prospect[]>(initialProspects);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Prospect | null>(null);
  const [deleting, setDeleting] = useState<Prospect | null>(null);
  const [addTaskOpen, setAddTaskOpen] = useState(false);

  // The Orion drawer's view: the tab, the prospects behind both prospect
  // views, and the prospect open in its modal. The Tasks tab's board
  // publishes its own slice.
  usePageContextSlice("admin-sales-tab", tabSlice("Sales", { prospects: "Prospects", pipeline: "Pipeline", tasks: "Tasks" }[tab]));
  usePageContextSlice("admin-sales-prospects", tab === "tasks" ? null : prospectsSlice(prospects));
  usePageContextSlice("admin-sales-prospect", editing ? prospectModalSlice(editing) : null);

  const handleDropProspect = useCallback(
    (id: string, stage: ProspectStage) => {
      setProspects((prev) =>
        prev.map((p) =>
          p.id === id && p.stage !== stage
            ? { ...p, stage, stageChangedAt: new Date().toISOString() }
            : p
        )
      );
      startTransition(async () => {
        try {
          await moveProspect(id, stage);
        } catch (error) {
          console.error("Failed to move prospect", error);
          toast.error("Couldn't move the prospect.");
        }
        // On failure too: the refresh puts the card back where the server has it.
        router.refresh();
      });
    },
    [router, setProspects]
  );

  const handleOpenProspect = useCallback((p: Prospect) => setEditing(p), []);
  const handleDeleteProspect = useCallback((p: Prospect) => setDeleting(p), []);

  function handleNewProspect() {
    // The new card lands in Queue, visible on either prospect view; only the
    // task board has nowhere to show it.
    if (tab === "tasks") setTab("prospects");
    setAddOpen(true);
  }

  function handleNewTask() {
    setTab("tasks");
    setAddTaskOpen(true);
  }

  function handleAddProspect(input: ProspectInput) {
    const now = new Date().toISOString();
    const localId = `prospect-local-${Date.now()}`;
    setProspects((prev) => [
      { id: localId, ...input, stageChangedAt: now, createdAt: now },
      ...prev,
    ]);
    startTransition(async () => {
      try {
        await createProspect(input);
      } catch (error) {
        console.error("Failed to create prospect", error);
        toast.error("Couldn't add the prospect.");
      }
      router.refresh();
    });
  }

  function handleSaveProspect(input: ProspectInput) {
    if (!editing) return;
    const id = editing.id;
    const stageChanged = input.stage !== editing.stage;
    setProspects((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              ...input,
              stageChangedAt: stageChanged ? new Date().toISOString() : p.stageChangedAt,
            }
          : p
      )
    );
    startTransition(async () => {
      try {
        await updateProspect(id, input);
      } catch (error) {
        console.error("Failed to update prospect", error);
        toast.error("Couldn't save the prospect.");
      }
      router.refresh();
    });
  }

  function handleConfirmDelete() {
    const target = deleting;
    if (!target) return;
    setProspects((prev) => prev.filter((p) => p.id !== target.id));
    startTransition(async () => {
      try {
        await deleteProspect(target.id);
      } catch (error) {
        console.error("Failed to delete prospect", error);
        toast.error("Couldn't delete the prospect.");
      }
      router.refresh();
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SalesToolbar
        tab={tab}
        onTab={setTab}
        onNewProspect={handleNewProspect}
        onNewTask={handleNewTask}
      />

      {tab === "prospects" && (
        <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto py-4 md:py-6", GUTTER)}>
          <ProspectsTable prospects={prospects} onOpenProspect={handleOpenProspect} />
        </div>
      )}

      {tab === "pipeline" && (
        <div className={cn("flex min-h-0 flex-1 flex-col py-4 md:py-6", GUTTER)}>
          <ProspectsBoard
            prospects={prospects}
            onDropProspect={handleDropProspect}
            onOpenProspect={handleOpenProspect}
            onDeleteProspect={handleDeleteProspect}
          />
        </div>
      )}

      {tab === "tasks" && (
        <div className={cn("flex min-h-0 flex-1 flex-col py-4 md:py-6", GUTTER)}>
          <TasksBoard
            tasks={tasks}
            assignees={assignees}
            actions={ADMIN_TASK_ACTIONS}
            columns={ADMIN_TASK_COLUMNS}
            embedded
            // The toolbar owns the add control for every tab.
            hideHeader
            contextLabel="Sales tasks (the admin task board's rows)"
            addOpen={addTaskOpen}
            onAddOpenChange={setAddTaskOpen}
          />
        </div>
      )}

      <ProspectModal
        mode="add"
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={handleAddProspect}
      />

      <ProspectModal
        mode="edit"
        open={editing !== null}
        prospect={editing}
        onClose={() => setEditing(null)}
        onSubmit={handleSaveProspect}
        // Close the editor first: the confirm dialog replaces it rather than
        // stacking on top of it.
        onDelete={(p) => {
          setEditing(null);
          setDeleting(p);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleConfirmDelete}
        title={deleting ? `Delete ${deleting.company}?` : "Delete?"}
        description="This permanently removes the prospect. This can't be undone."
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}
