import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The team task board catalog: one read, three writes, every write behind an
 * approval card and returning the directive that refreshes an open board. An
 * update changes only the fields it names.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const task = {
  id: ID, title: "Ship pricing page", description: "Annual toggle", status: "doing" as const, priority: "High" as const,
  assignee: "rankin@wildcatiq.ai", deadline: "2026-11-01", deadlineTime: "09:00", budget: 500, spend: 120, folderId: "p1",
};
const getAdminTasks = vi.fn(async (..._a: unknown[]) => [task]);
vi.mock("@/lib/admin/tasks", () => ({ getAdminTasks: (...a: unknown[]) => getAdminTasks(...a) }));
const createAdminTask = vi.fn(async (..._a: unknown[]) => {});
const updateAdminTask = vi.fn(async (..._a: unknown[]) => {});
const deleteAdminTask = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/admin/task-actions", () => ({
  createAdminTask: (...a: unknown[]) => createAdminTask(...a),
  updateAdminTask: (...a: unknown[]) => updateAdminTask(...a),
  deleteAdminTask: (...a: unknown[]) => deleteAdminTask(...a),
}));
vi.mock("@/lib/admin/projects", () => ({ getAdminProjects: async () => [{ id: "p1", name: "Q4 Launch" }] }));
vi.mock("@/lib/admin/team", () => ({ listPlatformAdmins: async () => [{ email: "rankin@wildcatiq.ai" }] }));

type Exec = (input: unknown, opts?: unknown) => Promise<Record<string, unknown>>;
const run = async (name: string, input: unknown) => {
  const { taskTools } = await import("./task-tools");
  const t = (taskTools() as Record<string, { execute?: unknown }>)[name];
  return (t.execute as Exec)(input, {});
};

beforeEach(() => vi.clearAllMocks());

describe("taskTools", () => {
  it("offers the read and three batch writes, each behind ONE approval card titled by its count", async () => {
    const { taskTools, TASK_TOOL_NAMES, TASK_WRITE_TOOL_NAMES } = await import("./task-tools");
    const tools = taskTools() as Record<string, { needsApproval?: boolean }>;
    expect(Object.keys(tools).sort()).toEqual([...TASK_TOOL_NAMES].sort());
    const { hasRegisteredApprovalTitle, describeApproval } = await import("@/lib/ai/approval-view");
    for (const n of Object.keys(tools)) {
      const write = (TASK_WRITE_TOOL_NAMES as readonly string[]).includes(n);
      expect(Boolean(tools[n].needsApproval), n).toBe(write);
      if (write) expect(hasRegisteredApprovalTitle(n), n).toBe(true);
    }
    const view = describeApproval("create_team_task", { tasks: [{ title: "A" }, { title: "B" }, { title: "C" }] });
    expect(view.title).toBe("Add 3 tasks to the team board");
    expect(view.table?.rows).toEqual([["A"], ["B"], ["C"]]);
    expect(describeApproval("delete_team_task", { tasks: [{ id: ID, task: "Ship pricing page" }] }).title).toBe(
      "Delete 1 task from the team board"
    );
  });

  it("lists the board with column labels, project names, assignees and projects", async () => {
    const r = await run("list_team_tasks", {});
    expect(r.tasks).toEqual([
      expect.objectContaining({ id: ID, column: "Doing", project: { id: "p1", name: "Q4 Launch" } }),
    ]);
    expect(r.columns).toEqual(["Backlog", "Queue", "Doing", "Done"]);
    expect(r.assignees).toEqual(["rankin@wildcatiq.ai"]);
    expect((await run("list_team_tasks", { column: "Done" })).tasks).toEqual([]);
  });

  it("creates every task in the list, in Backlog at Medium unless told otherwise", async () => {
    const r = await run("create_team_task", {
      tasks: [{ title: "Call Sky Resources" }, { title: "Fix logs", column: "Queue", priority: "High", projectId: "p1" }],
    });
    expect(createAdminTask).toHaveBeenCalledTimes(2);
    expect(createAdminTask).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: "Call Sky Resources", status: "planned", priority: "Medium" }));
    expect(createAdminTask).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "priority", priority: "High", folderId: "p1" }));
    expect(r).toEqual({ ok: true, count: 2, directive: { count: 2 } });
  });

  it("an update moves the column and keeps every field it does not name; an empty string clears", async () => {
    await run("update_team_task", { tasks: [{ id: ID, task: "ship pricing page", column: "Done", assignee: "" }] });
    expect(updateAdminTask).toHaveBeenCalledWith(ID, {
      title: "Ship pricing page", description: "Annual toggle", status: "done", priority: "High",
      assignee: undefined, deadline: "2026-11-01", deadlineTime: "09:00", budget: 500, spend: 120, folderId: "p1",
    });
  });

  it("writes nothing when any entry is off the board or its title does not match", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const mixed = [{ id: ID, task: "Ship pricing page" }, { id: other, task: "Ghost" }];
    expect(await run("update_team_task", { tasks: mixed.map((t) => ({ ...t, column: "Done" })) })).toMatchObject({ ok: false });
    expect(await run("delete_team_task", { tasks: mixed })).toMatchObject({ ok: false });
    const wrong = await run("delete_team_task", { tasks: [{ id: ID, task: "Something else" }] });
    expect(wrong).toMatchObject({ ok: false, error: expect.stringContaining('is "Ship pricing page"') });
    expect(updateAdminTask).not.toHaveBeenCalled();
    expect(deleteAdminTask).not.toHaveBeenCalled();
  });

  it("deletes and hands back the refresh directive", async () => {
    expect(await run("delete_team_task", { tasks: [{ id: ID, task: "Ship pricing page" }] })).toEqual({ ok: true, count: 1, directive: { count: 1 } });
    expect(deleteAdminTask).toHaveBeenCalledWith(ID);
  });
});
