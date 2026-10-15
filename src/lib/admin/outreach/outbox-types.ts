/**
 * The Outbox tab's shapes and the pure arithmetic over them. Plain module (no
 * `server-only`) so the tab and the tests share it.
 */

export type OutboxEmailStatus = "pending" | "sent" | "failed";

export interface OutboxEmail {
  id: string;
  enrollmentId: string | null;
  companyName: string | null;
  contactName: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  status: OutboxEmailStatus;
  error: string | null;
  sentAt: string | null;
}

export interface Outbox {
  id: string;
  /** ISO instant the batch is meant to go. */
  dueAt: string;
  scheduleName: string | null;
  status: "open" | "sent";
  sentAt: string | null;
  emails: OutboxEmail[];
}

/**
 * Current outboxes are the open ones, soonest first: due today, overdue, or
 * still ahead. Past ones are the sent batches, newest first; the tab starts
 * them collapsed.
 */
export function splitOutboxes(outboxes: Outbox[]): { current: Outbox[]; past: Outbox[] } {
  const current = outboxes.filter((o) => o.status === "open").sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const past = outboxes.filter((o) => o.status === "sent").sort((a, b) => b.dueAt.localeCompare(a.dueAt));
  return { current, past };
}

/** An open outbox whose moment has passed: the batch is waiting on the admin. */
export function isOutboxDue(o: Outbox, now: Date): boolean {
  return o.status === "open" && Date.parse(o.dueAt) <= now.getTime();
}

/** What Send to all will send: the rows not yet sent (a failed one is retried). */
export function unsentEmails(o: Outbox): OutboxEmail[] {
  return o.emails.filter((e) => e.status !== "sent");
}
