"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { slugify } from "@/lib/slug";
import { ProjectToolbar, type ProjectTab } from "@/components/projects/project-toolbar";
import { TasksBoard } from "@/components/tasks/tasks-board";
import { FacilityNotesTab } from "@/components/notes/facility-notes-tab";
import {
  OrionWorkspace,
  type ConversationPersistence,
  type OrionWorkspaceHandle,
} from "@/components/ai/orion-workspace";
import { SetPageBreadcrumb } from "@/components/breadcrumb-context";
import { AdminProjectFiles } from "@/components/admin/projects/admin-project-files";
import { useFacilityNoteDraft } from "@/lib/notes/use-note-draft";
import { useServerState } from "@/hooks/use-server-state";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/files/limits";
import { ADMIN_TASK_ACTIONS } from "@/lib/admin/task-board";
import { ADMIN_NOTE_ACTIONS } from "@/lib/admin/note-board";
import { renameAdminProject, uploadAdminProjectFiles } from "@/lib/admin/project-actions";
import { deleteAdminConversation, saveAdminMessages } from "@/lib/ai/admin/conversation-actions";
import { ADMIN_TASK_COLUMNS, type Task } from "@/lib/tasks/tasks";
import type { Conversation } from "@/lib/ai/conversations";
import type { NoteSummary } from "@/lib/notes/types";
import type { AdminProjectFile } from "@/lib/admin/project-types";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { adminProjectSlice } from "@/lib/ai/admin/page-slices";

// Horizontal padding that lines content up with the topbar page label (matches
// AppMain's padded routes; the project route itself is full-bleed).
const GUTTER = "px-[77px] md:px-[85px]";

const ADMIN_PERSISTENCE: ConversationPersistence = {
  save: (id, messages, projectId) => saveAdminMessages(id, messages, projectId),
  remove: deleteAdminConversation,
};

/**
 * An admin project: the customer project workspace (`ProjectWorkspace`) over
 * the admin tables. Same toolbar, same four tabs. Orion is the admin
 * assistant scoped to this project, Tasks is the admin board
 * filtered to the project, Notes is the shared notes grid over `admin_notes`,
 * Files is the project's uploads. No Share: every admin sees every admin
 * project, so there is no one to share with.
 */
export function AdminProjectWorkspace({
  projectId,
  projectName,
  tasks,
  assignees,
  orionConversations,
  firstName,
  notes,
  files,
}: {
  projectId: string;
  projectName: string;
  tasks: Task[];
  assignees: string[];
  orionConversations: Conversation[];
  firstName: string;
  notes: NoteSummary[];
  files: AdminProjectFile[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tab, setTab] = useState<ProjectTab>("orion");
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const orionRef = useRef<OrionWorkspaceHandle>(null);
  const diskInputRef = useRef<HTMLInputElement>(null);
  // The rename shows at once and the server catches up (see ProjectWorkspace).
  const [name, setName] = useServerState(projectName);
  usePageContextSlice(
    "admin-project",
    adminProjectSlice({
      id: projectId,
      name,
      tab: { orion: "Orion", tasks: "Tasks", notes: "Notes", files: "Files" }[tab],
      tasks,
      notes,
      files,
    })
  );
  // A new note opens carrying this project's tag, which is what files it here.
  const noteDraft = useFacilityNoteDraft({
    targetType: "project",
    targetId: projectId,
    targetLabel: name,
  });

  function handleRenameProject(newName: string) {
    const previous = name;
    setName(newName);
    startTransition(async () => {
      try {
        await renameAdminProject(projectId, newName);
        router.replace(`/projects/${slugify(newName)}`);
      } catch (error) {
        setName(previous);
        console.error("Failed to rename project", error);
        toast.error("Couldn't rename the project.");
      }
    });
  }

  function handleNewChat() {
    // Mounting the Orion tab seeds a fresh chat; only an open one needs telling.
    if (tab !== "orion") {
      setTab("orion");
      return;
    }
    orionRef.current?.newChat();
  }

  function handleNewTask() {
    setTab("tasks");
    setAddTaskOpen(true);
  }

  function handleNewNote() {
    setTab("notes");
    noteDraft.openNew();
  }

  function handleUploadFromComputer(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length === 0) return;
    const total = selected.reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_UPLOAD_BYTES) {
      toast.error(`Uploads are limited to ${MAX_UPLOAD_LABEL} at a time.`);
      return;
    }
    const formData = new FormData();
    selected.forEach((file) => formData.append("files", file));
    setTab("files");
    setUploadingNames(selected.map((f) => f.name));
    startTransition(async () => {
      try {
        await uploadAdminProjectFiles(projectId, formData);
        router.refresh();
      } catch (error) {
        console.error("Upload failed", error);
        toast.error("Couldn't upload the files.");
      } finally {
        setUploadingNames([]);
      }
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Project name in the topbar breadcrumb; click it there to rename. */}
      <SetPageBreadcrumb label={name} onRename={handleRenameProject} />

      <ProjectToolbar
        projectName={name}
        tab={tab}
        onTab={setTab}
        onNewChat={handleNewChat}
        onNewTask={handleNewTask}
        onUploadFromComputer={() => diskInputRef.current?.click()}
        onNewNote={handleNewNote}
        onRename={handleRenameProject}
        uploading={uploadingNames.length > 0}
        themed
      />

      {tab === "orion" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <OrionWorkspace
            ref={orionRef}
            initialConversations={orionConversations}
            firstName={firstName}
            folderId={projectId}
            projectName={name}
            api="/api/admin/chat"
            persistence={ADMIN_PERSISTENCE}
            allowVoice={false}
          />
        </div>
      )}

      {tab === "tasks" && (
        <div className={cn("flex min-h-0 flex-1 flex-col py-4 md:py-6", GUTTER)}>
          <TasksBoard
            tasks={tasks}
            assignees={assignees}
            folderId={projectId}
            actions={ADMIN_TASK_ACTIONS}
            columns={ADMIN_TASK_COLUMNS}
            embedded
            hideHeader
            contextLabel={`Tasks of project "${name}"`}
            addOpen={addTaskOpen}
            onAddOpenChange={setAddTaskOpen}
          />
        </div>
      )}

      {tab === "notes" && (
        <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto py-4 md:py-6", GUTTER)}>
          <FacilityNotesTab
            notes={notes}
            draft={noteDraft.draft}
            onNewNote={noteDraft.openNew}
            onOpenNote={noteDraft.openExisting}
            onCloseNote={noteDraft.close}
            actions={ADMIN_NOTE_ACTIONS}
            showTags={false}
            emptyLabel="No notes in this project yet."
          />
        </div>
      )}

      {tab === "files" && (
        <div className={cn("flex min-h-0 flex-1 flex-col py-4 md:py-6", GUTTER)}>
          <AdminProjectFiles files={files} uploadingNames={uploadingNames} />
        </div>
      )}

      <input
        ref={diskInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleUploadFromComputer}
      />
    </div>
  );
}
