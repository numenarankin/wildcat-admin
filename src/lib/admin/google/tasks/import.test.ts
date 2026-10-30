import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Google Tasks into the board: open tasks never imported go to Queue, assigned
 * to the admin; completed, deleted, hidden and already-imported ones do not;
 * a task another load claimed first is left to that load.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/google/guard", () => ({ googleAdminId: async () => "u1" }));
const settings = vi.fn(async (): Promise<unknown> => ({ services: ["tasks"], needsReauth: false }));
vi.mock("@/lib/admin/google/settings", () => ({ getGoogleSettings: () => settings() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => ({ email: "rankin@wildcatiq.ai" }) }));
vi.mock("@/lib/admin/google/tasks/client", () => ({
  listTaskLists: async () => [{ id: "L1", title: "My Tasks" }, { id: "L2", title: "Work" }],
  listTasks: async (_u: string, list: string) =>
    list === "L1"
      ? [
          { id: "g-new", title: "Call Sky Resources", notes: "re: renewal", status: "needsAction", due: "2026-11-03T00:00:00.000Z" },
          { id: "g-done", title: "Old", status: "completed" },
          { id: "g-seen", title: "Already on the board", status: "needsAction" },
        ]
      : [
          { id: "g-raced", title: "Claimed by the other tab", status: "needsAction" },
          { id: "g-hidden", title: "Cleared", status: "needsAction", hidden: true },
        ],
}));

// A tiny admin_google_task_imports + admin_tasks, as PostgREST would answer.
const imports = new Map<string, Record<string, unknown>>();
const tasks: Record<string, unknown>[] = [];
let raced = false;
function from(table: string) {
  if (table === "admin_tasks") {
    return {
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            const id = `t${tasks.length + 1}`;
            tasks.push({ id, ...row });
            return { data: { id }, error: null };
          },
        }),
      }),
    };
  }
  return {
    select: () => ({
      in: async (_c: string, ids: string[]) => ({ data: ids.filter((i) => imports.has(i)).map((i) => ({ google_task_id: i })), error: null }),
    }),
    upsert: (rows: Record<string, unknown>[]) => ({
      select: async () => {
        // The other tab inserts g-raced between our read and our claim.
        if (raced) imports.set("g-raced", { google_task_id: "g-raced" });
        const inserted = rows.filter((r) => !imports.has(r.google_task_id as string));
        for (const r of inserted) imports.set(r.google_task_id as string, r);
        return { data: inserted.map((r) => ({ google_task_id: r.google_task_id })), error: null };
      },
    }),
    update: (patch: Record<string, unknown>) => ({
      eq: async (_c: string, id: string) => {
        Object.assign(imports.get(id)!, patch);
        return { error: null };
      },
    }),
    delete: () => ({ eq: async (_c: string, id: string) => (imports.delete(id), { error: null }) }),
  };
}
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServer: async () => ({ from }) }));

beforeEach(() => {
  imports.clear();
  tasks.length = 0;
  imports.set("g-seen", { google_task_id: "g-seen", admin_task_id: null });
  raced = false;
  settings.mockResolvedValue({ services: ["tasks"], needsReauth: false });
});

describe("importGoogleTasks", () => {
  it("adds only open, never-imported tasks, to Queue, assigned to the admin, with notes and due date", async () => {
    const { importGoogleTasks } = await import("./import");
    expect(await importGoogleTasks()).toEqual({ added: 2 });
    expect(tasks).toEqual([
      {
        id: "t1", title: "Call Sky Resources", description: "<p>re: renewal</p>", status: "priority",
        priority: "Medium", assignee: "rankin@wildcatiq.ai", deadline: "2026-11-03",
      },
      expect.objectContaining({ id: "t2", title: "Claimed by the other tab", status: "priority" }),
    ]);
    expect(imports.get("g-new")).toMatchObject({ google_list_id: "L1", user_id: "u1", admin_task_id: "t1" });
  });

  it("imports nothing twice: a second load adds nothing, even after the board task is deleted", async () => {
    const { importGoogleTasks } = await import("./import");
    await importGoogleTasks();
    tasks.length = 0; // the board tasks deleted; their import rows remain (admin_task_id set null)
    expect(await importGoogleTasks()).toEqual({ added: 0 });
    expect(tasks).toEqual([]);
  });

  it("leaves a task another load claimed first to that load", async () => {
    raced = true;
    const { importGoogleTasks } = await import("./import");
    expect(await importGoogleTasks()).toEqual({ added: 1 });
    expect(tasks.map((t) => t.title)).toEqual(["Call Sky Resources"]);
  });

  it("does nothing when Google Tasks is not connected or needs reconnecting", async () => {
    const { importGoogleTasks } = await import("./import");
    settings.mockResolvedValueOnce({ services: ["gmail"], needsReauth: false });
    expect(await importGoogleTasks()).toEqual({ skipped: "not_connected" });
    settings.mockResolvedValueOnce({ services: ["tasks"], needsReauth: true });
    expect(await importGoogleTasks()).toEqual({ skipped: "not_connected" });
    expect(tasks).toEqual([]);
  });
});
