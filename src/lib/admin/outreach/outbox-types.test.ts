import { describe, it, expect } from "vitest";
import { isOutboxDue, splitOutboxes, unsentEmails, type Outbox, type OutboxEmail } from "@/lib/admin/outreach/outbox-types";

const email = (status: OutboxEmail["status"]): OutboxEmail => ({
  id: `e-${status}`,
  enrollmentId: null,
  companyName: null,
  contactName: null,
  to: "a@b.co",
  cc: "",
  bcc: "",
  subject: "s",
  html: "<p>x</p>",
  status,
  error: null,
  sentAt: null,
});

const box = (id: string, dueAt: string, status: Outbox["status"], emails: OutboxEmail[] = []): Outbox => ({
  id,
  dueAt,
  scheduleName: null,
  status,
  sentAt: null,
  emails,
});

describe("splitOutboxes", () => {
  it("opens are current soonest first; sent are past newest first", () => {
    const { current, past } = splitOutboxes([
      box("late", "2026-10-20T13:00:00.000Z", "open"),
      box("old", "2026-10-06T13:00:00.000Z", "sent"),
      box("soon", "2026-10-13T13:00:00.000Z", "open"),
      box("recent", "2026-10-13T13:00:00.000Z", "sent"),
    ]);
    expect(current.map((o) => o.id)).toEqual(["soon", "late"]);
    expect(past.map((o) => o.id)).toEqual(["recent", "old"]);
  });
});

describe("isOutboxDue", () => {
  const now = new Date("2026-10-15T15:00:00.000Z");
  it("an open outbox at or before now is due", () => {
    expect(isOutboxDue(box("a", "2026-10-15T15:00:00.000Z", "open"), now)).toBe(true);
    expect(isOutboxDue(box("b", "2026-10-13T13:00:00.000Z", "open"), now)).toBe(true);
  });
  it("a future or sent outbox is not", () => {
    expect(isOutboxDue(box("c", "2026-10-20T13:00:00.000Z", "open"), now)).toBe(false);
    expect(isOutboxDue(box("d", "2026-10-13T13:00:00.000Z", "sent"), now)).toBe(false);
  });
});

describe("unsentEmails", () => {
  it("pending and failed go out; sent do not", () => {
    const o = box("a", "2026-10-15T15:00:00.000Z", "open", [email("sent"), email("pending"), email("failed")]);
    expect(unsentEmails(o).map((e) => e.status)).toEqual(["pending", "failed"]);
  });
});
