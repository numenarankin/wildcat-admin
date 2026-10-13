/**
 * Shared support-chat types. Plain module (no `server-only`) so both the client
 * components and the server data/action modules can import it.
 */

export type SupportSenderRole = "user" | "staff";

export type SupportStatus = "open" | "closed";

/** A file attached to a support message. `url` is a short-lived signed link. */
export interface SupportAttachment {
  id: string;
  name: string;
  url: string | null;
}

/** One message in a support thread. `createdAt` is epoch ms for easy sorting. */
export interface SupportMessage {
  id: string;
  threadId: string;
  senderRole: SupportSenderRole;
  body: string;
  createdAt: number;
  attachments: SupportAttachment[];
}

/** A support thread with its messages, most-recent-activity first when listed. */
export interface SupportThread {
  id: string;
  subject: string;
  status: SupportStatus;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
  /** Unread from the viewing side's perspective (computed per side on load). */
  unread: boolean;
  messages: SupportMessage[];
}

/** Who a thread belongs to, as the staff desk lists it. */
export interface SupportCustomer {
  name: string;
  email: string | null;
  orgName: string;
}

/** A thread as the staff side sees it: the conversation plus its customer. */
export interface StaffSupportThread extends SupportThread {
  customer: SupportCustomer;
}

export const SUPPORT_NEW_SUBJECT = "New request";

const MAX_SUBJECT_LENGTH = 48;

/** Derive a short thread subject from the first user message body. */
export function deriveSubject(body: string): string | null {
  const text = body.trim();
  if (!text) return null;
  return text.length > MAX_SUBJECT_LENGTH
    ? `${text.slice(0, MAX_SUBJECT_LENGTH).trimEnd()}…`
    : text;
}
