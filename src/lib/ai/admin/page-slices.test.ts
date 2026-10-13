import { describe, it, expect } from "vitest";
import { buildPageContext } from "@/lib/ai/page-context";
import {
  customerPanelFacts,
  customersTableSlice,
  emailListSlice,
  logsSlice,
  prospectsSlice,
  quote,
  tasksBoardSlice,
} from "@/lib/ai/admin/page-slices";
import type { CustomerRow } from "@/lib/admin/customer-rows";
import type { Prospect } from "@/lib/admin/prospect-types";
import type { GmailThreadSummary } from "@/lib/admin/google/gmail/types";
import type { LogLine } from "@/lib/admin/log-rows";
import type { Task } from "@/lib/tasks/tasks";
import type { CustomerPanelData } from "@/lib/admin/customer-panel-types";

/**
 * What the Orion drawer is told about each admin page. The expected text is
 * written out by hand from the rows a page shows, so a builder that drops an
 * id, miscounts a column or lists rows as the whole population fails here.
 */

const customer = (over: Partial<CustomerRow>): CustomerRow => ({
  orgId: "o1",
  name: "Sky Resources",
  email: "jim@sky.test",
  term: "month",
  status: "active",
  activeWells: 23,
  revenueUsd: 9600,
  signedUpAt: "2026-06-20T14:00:00Z",
  referrals: 0,
  referredByOrg: null,
  subscriptionId: "sub_1",
  ...over,
} as CustomerRow);

describe("customersTableSlice", () => {
  it("lists every customer with its org id, in the order on screen", () => {
    const slice = customersTableSlice(
      [customer({}), customer({ orgId: "o2", name: "Mesa Oil", term: "year", revenueUsd: 24000.4, activeWells: 60, signedUpAt: "2026-09-01T00:00:00Z" })],
      "Revenue /yr, descending"
    );
    expect(slice?.lines).toEqual([
      "2 rows.",
      "Sorted by Revenue /yr, descending. Customer tools take the org id.",
      "- Sky Resources (org o1): active, month, $9,600/yr, 23 active wells, signed up 2026-06-20",
      "- Mesa Oil (org o2): active, year, $24,000/yr, 60 active wells, signed up 2026-09-01",
    ]);
  });

  it("says nothing for an empty table", () => {
    expect(customersTableSlice([], "Revenue /yr, descending")).toBeNull();
  });
});

describe("prospectsSlice", () => {
  const p = (id: string, stage: Prospect["stage"], extra: Partial<Prospect> = {}): Prospect => ({
    id,
    company: `Co ${id}`,
    stage,
    stageChangedAt: "2026-10-01T00:00:00Z",
    createdAt: "2026-09-01T00:00:00Z",
    ...extra,
  });

  it("counts every stage, zeros included, then lists rows with ids", () => {
    const slice = prospectsSlice([
      p("a", "queue", { contactName: "Ann", county: "Reeves", wells: 12 }),
      p("b", "trial"),
      p("c", "queue"),
    ]);
    expect(slice?.lines).toEqual([
      "3 rows.",
      "By stage: Queue 2, Reached Out 0, Meeting Booked 0, Trial 1, Won 0, Lost 0.",
      "- Co a (prospect a): Queue, Ann, Reeves County, 12 wells",
      "- Co b (prospect b): Trial",
      "- Co c (prospect c): Queue",
    ]);
  });
});

describe("tasksBoardSlice", () => {
  const columns = [
    { status: "planned", label: "Backlog" },
    { status: "doing", label: "Doing" },
    { status: "done", label: "Done" },
  ];
  const task = (id: string, status: string, extra: Partial<Task> = {}) =>
    ({ id, title: `T${id}`, status, priority: "medium", ...extra }) as Task;

  it("counts per column by the board's own labels", () => {
    const slice = tasksBoardSlice("Admin task board", [task("1", "doing", { assignee: "a@x", deadline: "2026-10-09" }), task("2", "done")], columns);
    expect(slice?.label).toBe("Admin task board");
    expect(slice?.lines).toEqual([
      "2 rows.",
      "By column: Backlog 0, Doing 1, Done 1.",
      "- T1 (task 1): Doing, medium priority, assigned a@x, due 2026-10-09",
      "- T2 (task 2): Done, medium priority",
    ]);
  });
});

describe("emailListSlice", () => {
  const thread = (i: number): GmailThreadSummary =>
    ({
      id: `t${i}`,
      who: `Sender ${i}`,
      subject: `Subject ${i}`,
      snippet: "",
      unread: i === 0,
      lastMessageAt: Date.UTC(2026, 9, 8, 12, 0, 0),
      messageCount: i === 0 ? 3 : 1,
      lastIsMine: false,
    }) as GmailThreadSummary;

  it("leads with the loaded count, says more exist, and lists at most 15", () => {
    const threads = Array.from({ length: 20 }, (_, i) => thread(i));
    const slice = emailListSlice({ folder: "Inbox", search: "", threads, more: true })!;
    expect(slice.label).toBe("Email: Inbox");
    expect(slice.lines[0]).toBe("20 threads loaded (more below, not loaded), 1 unread. 15 listed below.");
    expect(slice.lines[2]).toBe("- Subject 0 (thread t0): Sender 0, 3 messages, unread, 2026-10-08T12:00:00.000Z");
    expect(slice.lines).toHaveLength(2 + 15);
  });

  it("names the search in the heading", () => {
    expect(emailListSlice({ folder: "All", search: "checkbook", threads: [], more: false })!.label).toBe(
      'Email: All, searching "checkbook"'
    );
  });
});

describe("logsSlice", () => {
  it("states only the filters that are set", () => {
    const line: LogLine = {
      id: "l1",
      at: "2026-10-08T10:00:00Z",
      source: "lambda",
      level: "error",
      message: "boom\n  at x",
      statusCode: 500,
      method: "POST",
      path: "/api/sync",
      requestId: "r1",
      userId: "u1",
      userEmail: "jim@sky.test",
      orgId: "o1",
      action: null,
    };
    const slice = logsSlice({ range: "24h", level: "error", q: "" } as never, [line]);
    expect(slice?.lines).toEqual([
      "1 rows.",
      "Filters: range=24h, level=error. search_logs takes the same filters; request_logs takes a request id.",
      "- 2026-10-08T10:00:00Z | error | lambda | 500 | POST /api/sync | user jim@sky.test | request r1 | boom at x",
    ]);
  });
});

describe("customerPanelFacts", () => {
  it("leaves removed members out of the count and the list", () => {
    const panel = {
      orgId: "o1",
      name: "Sky",
      createdAt: "2026-06-20T00:00:00Z",
      accountType: "customer",
      ownerEmail: "jim@sky.test",
      referredBy: null,
      subscription: null,
      billableWells: 23,
      credits: { freeRemaining: 40, paidBalance: 0, platformCents: 0 },
      members: [
        { name: "Jim", email: "jim@sky.test", isOwner: true, isAdmin: true, status: "active" },
        { name: "Old", email: "old@sky.test", isOwner: false, isAdmin: false, status: "removed" },
        { name: "New", email: null, isOwner: false, isAdmin: false, status: "invited" },
      ],
    } as unknown as CustomerPanelData;
    expect(customerPanelFacts(panel, null)).toEqual([
      "customer account, created 2026-06-20, owner jim@sky.test.",
      "No subscription.",
      "23 billable wells; AI credits: 40 free, 0 paid.",
      "2 members: Jim <jim@sky.test> (owner); New (invited)",
    ]);
  });
});

describe("the whole block", () => {
  it("names the admin page and puts the modal ahead of the table", () => {
    const table = customersTableSlice([customer({})], "Revenue /yr, descending")!;
    const block = buildPageContext("/clients", [
      table,
      { priority: 100, label: "Open: customer panel for Sky Resources (org o1), Billing tab", lines: ['"This customer" means org o1.'] },
    ]);
    expect(block.split("\n\n")).toEqual([
      "The user is currently on the Clients page (every customer org) (route /clients).",
      '### Open: customer panel for Sky Resources (org o1), Billing tab\n"This customer" means org o1.',
      "### Customers table\n1 rows.\nSorted by Revenue /yr, descending. Customer tools take the org id.\n" +
        "- Sky Resources (org o1): active, month, $9,600/yr, 23 active wells, signed up 2026-06-20",
    ]);
  });
});

describe("quote", () => {
  it("flattens whitespace and cuts with an ellipsis", () => {
    expect(quote("a\n\n  b", 10)).toBe("a b");
    expect(quote("abcdefghijkl", 5)).toBe("abcd…");
    expect(quote(null)).toBe("");
  });
});
