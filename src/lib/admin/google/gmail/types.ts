/**
 * Gmail on the admin side: the API's documented shapes (users.threads,
 * users.messages, MessagePart) and what the /admin/email page renders.
 * Plan: docs/plans/google-integration.md section 7.1. Read only until phase 7.
 */

// ---- Gmail API v1 shapes (only the fields read here) ----

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePartBody {
  attachmentId?: string;
  size: number;
  /** base64url. */
  data?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** Epoch milliseconds, as a string. */
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  snippet?: string;
  messages?: GmailMessage[];
}

export interface GmailThreadList {
  threads?: { id: string; snippet?: string; historyId?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

// ---- What the page renders ----

/** The label filter over the one thread list. */
export type GmailFilter = "inbox" | "sent" | "starred" | "all";

export const GMAIL_FILTERS: ReadonlyArray<{ id: GmailFilter; label: string; labelId: string | null }> = [
  { id: "inbox", label: "Inbox", labelId: "INBOX" },
  { id: "sent", label: "Sent", labelId: "SENT" },
  { id: "starred", label: "Starred", labelId: "STARRED" },
  // No label: every thread outside Spam and Trash, Gmail's All Mail.
  { id: "all", label: "All", labelId: null },
];

export function isGmailFilter(value: unknown): value is GmailFilter {
  return GMAIL_FILTERS.some((f) => f.id === value);
}

export interface GmailThreadSummary {
  id: string;
  /** Who the row leads with: the latest sender who isn't the account, else `To: <recipient>`. */
  who: string;
  subject: string;
  snippet: string;
  /** The latest message was sent from this account. */
  lastIsMine: boolean;
  unread: boolean;
  starred: boolean;
  lastMessageAt: number;
  messageCount: number;
  /** Gmail's change stamp for the thread; opening it with this skips Google. */
  historyId?: string;
}

export interface GmailThreadPage {
  threads: GmailThreadSummary[];
  nextPageToken: string | null;
}

export interface GmailAttachment {
  messageId: string;
  /** Stable across fetches, unlike Gmail's attachmentId; the download route resolves it. */
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailMessageView {
  id: string;
  fromName: string;
  fromEmail: string;
  /** Recipients by name, for display. */
  to: string;
  /** Recipients as written (`Name <a@b.c>`), for Reply all. */
  toAddresses: string[];
  ccAddresses: string[];
  /** The address a reply goes to: Reply-To, else From. */
  replyTo: string;
  /** The RFC 5322 Message-ID and References, so a reply threads in every client. */
  rfcMessageId: string | null;
  references: string | null;
  date: number;
  mine: boolean;
  /** Raw email HTML with cid: images inlined as data URLs; rendered only inside the sandboxed frame. */
  html: string | null;
  text: string | null;
  attachments: GmailAttachment[];
}

export interface GmailThreadView {
  /** Gmail's change stamp for the thread. */
  historyId?: string;
  id: string;
  subject: string;
  messages: GmailMessageView[];
}

export const GMAIL_NO_SUBJECT = "(no subject)";
