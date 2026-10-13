import { TasksBoard } from "@/components/tasks/tasks-board";
import { TaskSourcePicker } from "@/components/admin/task-source-picker";
import { SettingsMessage } from "@/components/settings/panel";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import { getAdminTasks } from "@/lib/admin/tasks";
import { listPlatformAdmins } from "@/lib/admin/team";
import { ADMIN_TASK_ACTIONS } from "@/lib/admin/task-board";
import { GOOGLE_TASK_ACTIONS } from "@/lib/admin/google/task-board";
import { googleAdminId } from "@/lib/admin/google/guard";
import { getGoogleSettings } from "@/lib/admin/google/settings";
import { googleErrorMessage } from "@/lib/admin/google/fetch";
import { listTaskLists, listTasks } from "@/lib/admin/google/tasks/client";
import { isGoogleListId, sortGoogleTasks, toBoardTask, type GoogleTaskList } from "@/lib/admin/google/tasks/map";
import { ADMIN_TASK_COLUMNS, GOOGLE_TASK_COLUMNS, type Task, type TaskField } from "@/lib/tasks/tasks";

export const metadata = { title: "Tasks" };

const WILDCAT = { value: "wildcat", label: "Wildcat" };
const GOOGLE_PREFIX = "google:";
// Google Tasks stores none of these (plan section 7.3).
const GOOGLE_HIDDEN: readonly TaskField[] = ["assignee", "priority", "deadlineTime", "budget"];

/**
 * The admin team's task board: the customer Tasks page over `admin_tasks`,
 * with a Testing column between Doing and Done. The same rows as the Tasks
 * tab of /admin/sales. With Google Tasks connected, `?source=google:<listId>`
 * shows one of the admin's own Google lists on the same board instead
 * (docs/plans/google-integration.md D4).
 */
export default async function AdminTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  await requireAdminPage("tasks");
  const { source } = await searchParams;
  const google = await getGoogleSettings();
  const userId = google?.services.includes("tasks") ? await googleAdminId() : null;

  let lists: GoogleTaskList[] = [];
  let listsError: string | null = null;
  if (userId) {
    try {
      lists = await listTaskLists(userId);
    } catch (error) {
      listsError = googleErrorMessage(error, "Tasks");
    }
  }
  const options = lists.map((l) => ({ value: `${GOOGLE_PREFIX}${l.id}`, label: l.title }));
  const picker =
    userId && !listsError ? <TaskSourcePicker value={source ?? WILDCAT.value} wildcat={WILDCAT} google={options} /> : null;

  const listId = source?.startsWith(GOOGLE_PREFIX) ? source.slice(GOOGLE_PREFIX.length) : null;
  const list = listId && isGoogleListId(listId) ? lists.find((l) => l.id === listId) : undefined;

  if (userId && list) {
    let tasks: Task[] | null = null;
    let error: string | null = null;
    try {
      tasks = sortGoogleTasks(await listTasks(userId, list.id)).map((t) => toBoardTask(list.id, t));
    } catch (e) {
      error = googleErrorMessage(e, "Tasks");
    }
    if (tasks) {
      return (
        <TasksBoard
          // Remount per list: the board seeds its optimistic state from `tasks`.
          key={list.id}
          tasks={tasks}
          assignees={[]}
          folderId={list.id}
          actions={GOOGLE_TASK_ACTIONS}
          columns={GOOGLE_TASK_COLUMNS}
          hiddenFields={GOOGLE_HIDDEN}
          headerAction={picker}
          contextLabel={`Google Tasks list "${list.title}"`}
        />
      );
    }
    return <GoogleTasksError picker={picker} error={error ?? "Couldn't load that Google list."} />;
  }

  const [tasks, admins] = await Promise.all([getAdminTasks(), listPlatformAdmins()]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {listsError && <SettingsMessage error={listsError} />}
      <TasksBoard
        tasks={tasks}
        // The admin roster is the assignee list: the board is the team's.
        assignees={admins.map((a) => a.email)}
        actions={ADMIN_TASK_ACTIONS}
        columns={ADMIN_TASK_COLUMNS}
        headerAction={picker}
        contextLabel="Admin task board (Wildcat team)"
      />
    </div>
  );
}

/** A Google list that failed to load: the header stays, so another source is one click away. */
function GoogleTasksError({ picker, error }: { picker: React.ReactNode; error: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Tasks</h1>
        {picker}
      </div>
      <SettingsMessage error={error} />
    </div>
  );
}
