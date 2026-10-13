"use server";

import { requireGoogleAdminId } from "@/lib/admin/google/guard";
import { inOrionCall } from "@/lib/admin/google/orion-guard";
import { googleErrorMessage } from "@/lib/admin/google/fetch";
import {
  getAttachment,
  isGmailId,
  isPartId,
  markThreadRead,
  modifyThreadLabels,
  THREAD_LABELS,
  trashThread,
  type ThreadLabel,
} from "@/lib/admin/google/gmail/client";
import { sendMessage } from "@/lib/admin/google/gmail/send";
import { getEmailSettings } from "@/lib/admin/google/gmail/email-settings";
import { recordSent } from "@/lib/admin/google/gmail/index-sync";
import { parseAddress } from "@/lib/admin/google/gmail/mime";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  buildMessage,
  MAX_ATTACHMENT_BYTES,
  toRaw,
  validateCompose,
  type ComposeInput,
  type OutgoingAttachment,
} from "@/lib/admin/google/gmail/compose";

/**
 * /email's server actions: send (new, reply, forward), mark read, archive,
 * star, unread, trash. Reads are GET routes, so
 * they never queue behind these. Each one resolves the SESSION's admin id
 * first (`requireGoogleAdminId` throws "Not found." for anyone else) and
 * never takes a user id from input.
 */

export type GmailResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function markGmailThreadRead(threadId: string): Promise<GmailResult<null>> {
  const userId = await requireGoogleAdminId();
  if (!isGmailId(threadId)) return { ok: false, error: "No such thread." };
  try {
    await markThreadRead(userId, threadId);
    return { ok: true, data: null };
  } catch (error) {
    console.error("markGmailThreadRead failed", error);
    return { ok: false, error: googleErrorMessage(error, "Email") };
  }
}

/** What makes a send a reply or a forward; ids checked before use. */
export interface SendOptions {
  /** Reply: the thread it belongs to and the message it answers. */
  reply?: { threadId: string; inReplyTo: string | null; references: string | null };
  /** Forward: the original's attachments to carry along. */
  forward?: { messageId: string; partIds: string[] };
}

/** Send a message from the admin's own Gmail: new, a reply, or a forward. */
export async function sendGmailMessage(
  input: ComposeInput,
  options: SendOptions = {}
): Promise<GmailResult<{ threadId: string }>> {
  // Belt and braces: the fetch layer refuses this too (`orion-guard.ts`).
  if (inOrionCall()) return { ok: false, error: "Orion cannot send email." };
  const userId = await requireGoogleAdminId();
  const checked = validateCompose({
    to: String(input?.to ?? ""),
    cc: String(input?.cc ?? ""),
    bcc: String(input?.bcc ?? ""),
    subject: String(input?.subject ?? ""),
    html: String(input?.html ?? ""),
  });
  if (!checked.ok) return { ok: false, error: checked.error };
  const reply = options.reply;
  if (reply && !isGmailId(reply.threadId)) return { ok: false, error: "No such thread." };
  const forward = options.forward;
  if (forward && (!isGmailId(forward.messageId) || !forward.partIds.every(isPartId))) return { ok: false, error: "No such attachment." };

  try {
    // A forward carries the original's files: fetched here (cached after the
    // first read), never trusted from the browser.
    const attachments: OutgoingAttachment[] = [];
    for (const partId of forward?.partIds ?? []) {
      const file = await getAttachment(userId, forward!.messageId, partId);
      if (file) attachments.push(file);
    }
    const total = attachments.reduce((n, a) => n + a.bytes.byteLength, 0);
    if (total > MAX_ATTACHMENT_BYTES) return { ok: false, error: "Attachments are over Gmail's 25 MB limit." };

    // The font comes from the admin's saved settings, never from the request.
    const { fontFamily, fontSize } = await getEmailSettings();
    const message = buildMessage(
      {
        recipients: checked.recipients,
        subject: String(input.subject ?? "").slice(0, 998),
        html: String(input.html),
        style: { fontFamily, fontSize },
        inReplyTo: reply ? String(reply.inReplyTo ?? "") : null,
        references: reply ? String(reply.references ?? "") : null,
        attachments,
      },
      `wc_${crypto.randomUUID().replace(/-/g, "")}`
    );
    const sent = await sendMessage(userId, toRaw(message), reply?.threadId);
    // The autofill index learns from this send at once; a failure here
    // never fails the send.
    try {
      const all = [...checked.recipients.to, ...checked.recipients.cc, ...checked.recipients.bcc];
      const seen = new Set<string>();
      const recipients = all
        .map((raw) => parseAddress(raw))
        .map(({ name, email }) => ({ email: email.toLowerCase(), name: name === email ? "" : name }))
        .filter((r) => r.email.includes("@") && !seen.has(r.email) && seen.add(r.email));
      const subject = String(input.subject ?? "").replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, "").trim() || null;
      await recordSent(getSupabaseAdmin(), userId, { at: Date.now(), recipients, subject });
    } catch (error) {
      console.error("sendGmailMessage: index update failed", error);
    }
    return { ok: true, data: { threadId: sent.threadId } };
  } catch (error) {
    console.error("sendGmailMessage failed", error);
    return { ok: false, error: googleErrorMessage(error, "Email") };
  }
}

/** Archive (out of Inbox), star, mark unread and their reverses. */
export async function modifyGmailThread(
  threadId: string,
  change: { add?: ThreadLabel[]; remove?: ThreadLabel[] }
): Promise<GmailResult<null>> {
  const userId = await requireGoogleAdminId();
  if (!isGmailId(threadId)) return { ok: false, error: "No such thread." };
  const ok = (l: unknown): l is ThreadLabel => (THREAD_LABELS as readonly string[]).includes(l as string);
  const add = (change?.add ?? []).filter(ok);
  const remove = (change?.remove ?? []).filter(ok);
  if (!add.length && !remove.length) return { ok: false, error: "Nothing to change." };
  try {
    await modifyThreadLabels(userId, threadId, { add, remove });
    return { ok: true, data: null };
  } catch (error) {
    console.error("modifyGmailThread failed", error);
    return { ok: false, error: googleErrorMessage(error, "Email") };
  }
}

/** To Trash. Gmail keeps it 30 days; there is no permanent delete here. */
export async function trashGmailThread(threadId: string): Promise<GmailResult<null>> {
  const userId = await requireGoogleAdminId();
  if (!isGmailId(threadId)) return { ok: false, error: "No such thread." };
  try {
    await trashThread(userId, threadId);
    return { ok: true, data: null };
  } catch (error) {
    console.error("trashGmailThread failed", error);
    return { ok: false, error: googleErrorMessage(error, "Email") };
  }
}
