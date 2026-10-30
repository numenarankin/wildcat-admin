import "server-only";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { googleAdminId } from "@/lib/admin/google/guard";
import { getGoogleSettings } from "@/lib/admin/google/settings";
import { listTaskLists, listTasks } from "@/lib/admin/google/tasks/client";
import { notesToHtml, type GoogleTask } from "@/lib/admin/google/tasks/map";

/**
 * Google Tasks into the admin task board. Google has no push for Tasks, so the
 * board pulls: each time an admin opens /tasks (and before Orion reads the
 * board), that admin's OPEN Google tasks, from every list, that were never
 * imported are added to Queue, assigned to them. Completed and deleted Google
 * tasks are never imported. One-way: nothing on the board writes back.
 *
 * `admin_google_task_imports` remembers every imported Google task (migration
 * 2026102300400), so a task deleted from the board is not imported again, and
 * its primary key is the claim that stops two loads importing one task twice:
 * a task is only created after its import row is inserted by THIS call.
 */

export interface ImportCandidate {
  listId: string;
  task: GoogleTask;
}

/** Open tasks not yet imported. Pure. */
export function tasksToImport(candidates: ImportCandidate[], imported: Set<string>): ImportCandidate[] {
  return candidates.filter(
    (c) => c.task.status === "needsAction" && !c.task.deleted && !c.task.hidden && !imported.has(c.task.id)
  );
}

export type ImportResult = { added: number } | { skipped: "not_connected" };

export async function importGoogleTasks(): Promise<ImportResult> {
  const userId = await googleAdminId();
  const google = await getGoogleSettings();
  if (!userId || !google?.services.includes("tasks") || google.needsReauth) return { skipped: "not_connected" };

  const lists = await listTaskLists(userId);
  const candidates = (
    await Promise.all(lists.map(async (l) => (await listTasks(userId, l.id)).map((task) => ({ listId: l.id, task }))))
  ).flat();

  const sb = await getSupabaseServer();
  const ids = candidates.map((c) => c.task.id);
  if (ids.length === 0) return { added: 0 };
  const { data: seen, error: seenErr } = await sb
    .from("admin_google_task_imports")
    .select("google_task_id")
    .in("google_task_id", ids);
  if (seenErr) throw new Error(`admin_google_task_imports: ${seenErr.message}`);
  const fresh = tasksToImport(candidates, new Set((seen ?? []).map((r) => r.google_task_id as string)));
  if (fresh.length === 0) return { added: 0 };

  // Claim: only the rows this call inserted are this call's to create.
  const { data: claimed, error: claimErr } = await sb
    .from("admin_google_task_imports")
    .upsert(
      fresh.map((c) => ({ google_task_id: c.task.id, google_list_id: c.listId, user_id: userId })),
      { onConflict: "google_task_id", ignoreDuplicates: true }
    )
    .select("google_task_id");
  if (claimErr) throw new Error(`admin_google_task_imports: ${claimErr.message}`);
  const mine = new Set((claimed ?? []).map((r) => r.google_task_id as string));

  const email = (await getSessionUser())?.email ?? null;
  let added = 0;
  for (const { task } of fresh.filter((c) => mine.has(c.task.id))) {
    const { data: row, error } = await sb
      .from("admin_tasks")
      .insert({
        title: task.title?.trim() || "(untitled)",
        description: notesToHtml(task.notes) ?? null,
        status: "priority",
        priority: "Medium",
        assignee: email,
        deadline: task.due ? task.due.slice(0, 10) : null,
      })
      .select("id")
      .single();
    if (error) {
      // Release the claim so the next load tries again.
      await sb.from("admin_google_task_imports").delete().eq("google_task_id", task.id);
      throw new Error(`admin_tasks: ${error.message}`);
    }
    await sb.from("admin_google_task_imports").update({ admin_task_id: row.id }).eq("google_task_id", task.id);
    added++;
  }
  return { added };
}
