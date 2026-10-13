import "server-only";
import { googleFetch, googleUrl } from "@/lib/admin/google/fetch";
import type { GoogleTask, GoogleTaskList, GoogleTaskWrite } from "@/lib/admin/google/tasks/map";

/**
 * Tasks API v1. Plan: docs/plans/google-integration.md section 7.3. `userId`
 * is always the session's (see guard.ts).
 */

const BASE = "https://tasks.googleapis.com/tasks/v1";

function listPath(listId: string): string {
  return `${BASE}/lists/${encodeURIComponent(listId)}/tasks`;
}

export async function listTaskLists(userId: string): Promise<GoogleTaskList[]> {
  const out: GoogleTaskList[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleFetch<{ items?: GoogleTaskList[]; nextPageToken?: string }>(
      userId,
      "tasks",
      googleUrl(`${BASE}/users/@me/lists`, { maxResults: 100, pageToken })
    );
    out.push(...(page.items ?? []).map((l) => ({ id: l.id, title: l.title })));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export async function listTasks(userId: string, listId: string): Promise<GoogleTask[]> {
  const out: GoogleTask[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleFetch<{ items?: GoogleTask[]; nextPageToken?: string }>(
      userId,
      "tasks",
      googleUrl(listPath(listId), {
        maxResults: 100,
        showCompleted: true,
        // Completed tasks cleared in Google's apps are `hidden`; Done shows them too.
        showHidden: true,
        pageToken,
      })
    );
    out.push(...(page.items ?? []).filter((t) => !t.deleted));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export function insertTask(userId: string, listId: string, body: GoogleTaskWrite): Promise<GoogleTask> {
  return googleFetch<GoogleTask>(userId, "tasks", listPath(listId), { method: "POST", json: body });
}

export function patchTask(
  userId: string,
  listId: string,
  taskId: string,
  body: Partial<GoogleTaskWrite>
): Promise<GoogleTask> {
  return googleFetch<GoogleTask>(userId, "tasks", `${listPath(listId)}/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    json: body,
  });
}

export async function deleteTask(userId: string, listId: string, taskId: string): Promise<void> {
  await googleFetch<null>(userId, "tasks", `${listPath(listId)}/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
}
