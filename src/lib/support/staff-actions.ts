"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertSignedIn } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { notifyThreadOwnerOfReply } from "@/lib/support/reply-alert";
import type { SupportAttachment } from "@/lib/support/types";

/**
 * The staff side of a support thread, from /admin/support. Every action runs
 * on the SERVICE ROLE (the viewer owns none of these rows) behind the
 * platform-admin check, which is therefore the whole boundary.
 */

const FILES_BUCKET = "files";
const SIGNED_URL_TTL = 60 * 60;
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"];

function fileType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "md";
  if (IMAGE_EXTS.includes(ext)) return "image";
  return "doc";
}

async function requireStaff() {
  const me = await assertSignedIn();
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  return me;
}

/**
 * Upload a staff reply's attachments. Filed under the THREAD's org (the
 * customer's), since that is whose conversation they belong to and who must
 * be able to open them; never under a workspace of the admin's own.
 */
export async function uploadStaffAttachments(
  threadId: string,
  formData: FormData
): Promise<SupportAttachment[]> {
  const me = await requireStaff();
  const admin = getSupabaseAdmin();
  const { data: thread, error } = await admin
    .from("support_threads")
    .select("org_id")
    .eq("id", threadId)
    .maybeSingle<{ org_id: string }>();
  if (error) throw new Error(`uploadStaffAttachments: ${error.message}`);
  if (!thread) throw new Error("No such thread.");

  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  const out: SupportAttachment[] = [];
  for (const file of files) {
    const id = crypto.randomUUID();
    const bytes = await file.arrayBuffer();
    const { error: upErr } = await admin.storage
      .from(FILES_BUCKET)
      .upload(id, bytes, { contentType: file.type || undefined, upsert: false });
    if (upErr) throw new Error(`uploadStaffAttachments (storage): ${upErr.message}`);
    const { error: fErr } = await admin.from("files").insert({
      id,
      name: file.name,
      type: fileType(file.name),
      mime: file.type || null,
      size: file.size,
      storage_key: id,
      org_id: thread.org_id,
      created_by: me.id,
    });
    if (fErr) throw new Error(`uploadStaffAttachments (files): ${fErr.message}`);
    const { data: signed } = await admin.storage.from(FILES_BUCKET).createSignedUrl(id, SIGNED_URL_TTL);
    out.push({ id, name: file.name, url: signed?.signedUrl ?? null });
  }
  return out;
}

/**
 * Append a staff reply. The insert fires the DB trigger that puts the reply
 * in the customer's bell; the email goes out from here (`reply-alert.ts`).
 */
export async function sendStaffReply(
  threadId: string,
  body: string,
  fileIds: string[] = []
): Promise<{ id: string; createdAt: number }> {
  const me = await requireStaff();
  const admin = getSupabaseAdmin();
  const text = body.trim();
  if (!text && fileIds.length === 0) throw new Error("sendStaffReply: empty message");

  const { data: thread, error: tErr } = await admin
    .from("support_threads")
    .select("id, owner_id, subject")
    .eq("id", threadId)
    .maybeSingle<{ id: string; owner_id: string; subject: string }>();
  if (tErr) throw new Error(`sendStaffReply (thread): ${tErr.message}`);
  if (!thread) throw new Error("No such thread.");

  const { count, error: cErr } = await admin
    .from("support_messages")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId);
  if (cErr) throw new Error(`sendStaffReply (count): ${cErr.message}`);

  const { data: inserted, error: mErr } = await admin
    .from("support_messages")
    .insert({ thread_id: threadId, sender_role: "staff", sender_id: me.id, body: text, position: count ?? 0 })
    .select("id, created_at")
    .single();
  if (mErr) throw new Error(`sendStaffReply (message): ${mErr.message}`);

  if (fileIds.length > 0) {
    const { error: linkErr } = await admin
      .from("support_message_files")
      .insert(fileIds.map((fileId) => ({ message_id: inserted.id, file_id: fileId })));
    if (linkErr) throw new Error(`sendStaffReply (attachments): ${linkErr.message}`);
  }

  // Staff are caught up on their own reply.
  await admin
    .from("support_threads")
    .update({ staff_last_read_at: new Date().toISOString() })
    .eq("id", threadId);

  const { data: owner } = await admin.auth.admin.getUserById(thread.owner_id);
  await notifyThreadOwnerOfReply(admin, {
    ownerId: thread.owner_id,
    ownerEmail: owner?.user?.email ?? null,
    subject: thread.subject,
    body: text,
  });

  revalidatePath("/support");
  return { id: inserted.id, createdAt: new Date(inserted.created_at).getTime() };
}

/** Stamp the staff read watermark for a thread (clears its unread dot on the desk). */
export async function markSupportThreadReadByStaff(threadId: string): Promise<void> {
  await requireStaff();
  const { error } = await getSupabaseAdmin()
    .from("support_threads")
    .update({ staff_last_read_at: new Date().toISOString() })
    .eq("id", threadId);
  if (error) throw new Error(`markSupportThreadReadByStaff: ${error.message}`);
}
