"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { deriveSubject, type SupportAttachment } from "@/lib/support/types";
import { notifyAccountExecutive } from "@/lib/support/ae-alert";

const FILES_BUCKET = "files";
const SIGNED_URL_TTL = 60 * 60;
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"];

/** Map a filename to one of the `files.type` values (mirrors files/actions). */
function fileType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "md";
  if (IMAGE_EXTS.includes(ext)) return "image";
  return "doc";
}

/** Resolve the user's org id with the admin client (no RLS dependency). */
async function resolveOrgId(
  admin: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("owner_uid", userId)
    .maybeSingle();
  if (org?.id) return org.id;
  const { data: member } = await admin
    .from("org_members")
    .select("org_id")
    .eq("auth_user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return member?.org_id ?? null;
}

/**
 * Upload attachments for a support message into the shared `files` bucket. Uses
 * the admin client because a support user may not hold `manage_files`; the files
 * are linked to a message (support_message_files) rather than placed in the
 * Files tree, so they never surface outside the conversation. Returns each
 * file's id, name, and a short-lived signed URL for immediate rendering.
 */
export async function uploadSupportAttachments(
  formData: FormData
): Promise<SupportAttachment[]> {
  const user = await requireUser();
  const admin = getSupabaseAdmin();
  const orgId = await resolveOrgId(admin, user.id);
  if (!orgId) throw new Error("uploadSupportAttachments: no organization found");

  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File);

  const out: SupportAttachment[] = [];
  for (const file of files) {
    const id = crypto.randomUUID();
    const bytes = await file.arrayBuffer();

    const { error: upErr } = await admin.storage
      .from(FILES_BUCKET)
      .upload(id, bytes, {
        contentType: file.type || undefined,
        upsert: false,
      });
    if (upErr) throw new Error(`uploadSupportAttachments (storage): ${upErr.message}`);

    const { error: fErr } = await admin.from("files").insert({
      id,
      name: file.name,
      type: fileType(file.name),
      mime: file.type || null,
      size: file.size,
      storage_key: id,
      org_id: orgId,
      created_by: user.id,
    });
    if (fErr) throw new Error(`uploadSupportAttachments (files): ${fErr.message}`);

    const { data: signed } = await admin.storage
      .from(FILES_BUCKET)
      .createSignedUrl(id, SIGNED_URL_TTL);

    out.push({ id, name: file.name, url: signed?.signedUrl ?? null });
  }
  return out;
}

/**
 * Send a user message in a support thread. Creates the thread on first send
 * (drafts live client-side until then), appends the message, links any
 * attachments, and derives the thread subject from the first message. Returns
 * the new message's id + timestamp so the client can reconcile its optimistic row.
 */
export async function sendSupportMessage(
  threadId: string,
  body: string,
  fileIds: string[] = []
): Promise<{ id: string; createdAt: number }> {
  const user = await requireUser();
  const sb = await getSupabaseServer();

  const text = body.trim();
  if (!text && fileIds.length === 0) {
    throw new Error("sendSupportMessage: empty message");
  }

  // Ensure the thread exists (owner_id/org_id come from column defaults on
  // insert). ignoreDuplicates so an existing thread is left untouched.
  const { error: threadErr } = await sb
    .from("support_threads")
    .upsert({ id: threadId }, { onConflict: "id", ignoreDuplicates: true });
  if (threadErr) throw new Error(`sendSupportMessage (thread): ${threadErr.message}`);

  // Next position = current message count for this thread.
  const { count, error: countErr } = await sb
    .from("support_messages")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId);
  if (countErr) throw new Error(`sendSupportMessage (count): ${countErr.message}`);
  const position = count ?? 0;

  const { data: inserted, error: msgErr } = await sb
    .from("support_messages")
    .insert({
      thread_id: threadId,
      sender_role: "user",
      sender_id: user.id,
      body: text,
      position,
    })
    .select("id, created_at")
    .single();
  if (msgErr) throw new Error(`sendSupportMessage (message): ${msgErr.message}`);

  if (fileIds.length > 0) {
    const { error: linkErr } = await sb
      .from("support_message_files")
      .insert(fileIds.map((fileId) => ({ message_id: inserted.id, file_id: fileId })));
    if (linkErr) throw new Error(`sendSupportMessage (attachments): ${linkErr.message}`);
  }

  // Name the thread from the first message.
  if (position === 0) {
    const subject = deriveSubject(text);
    if (subject) {
      await sb.from("support_threads").update({ subject }).eq("id", threadId);
    }
  }

  // Mark the user caught up on their own send.
  await sb
    .from("support_threads")
    .update({ user_last_read_at: new Date().toISOString() })
    .eq("id", threadId);

  // Heads-up email to the platform account executive. Best-effort: a failure to
  // read the profile or send the alert must never break the user's send, so it
  // is fully guarded and the AE-notify helper swallows its own send errors.
  try {
    const [{ data: prof }, { data: org }] = await Promise.all([
      sb.from("profile").select("name").maybeSingle<{ name: string | null }>(),
      sb
        .from("organizations")
        .select("name")
        .maybeSingle<{ name: string | null }>(),
    ]);
    console.info("sendSupportMessage: notifying AE", {
      threadId,
      from: user.email ?? "(no email on session)",
      company: (org?.name ?? "").trim() || "(none)",
      attachments: fileIds.length,
    });
    await notifyAccountExecutive({
      name: (prof?.name ?? "").trim(),
      email: user.email ?? "",
      company: (org?.name ?? "").trim(),
      body: text,
      attachmentCount: fileIds.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("sendSupportMessage: AE notification failed", msg);
  }

  revalidatePath("/support");
  return { id: inserted.id, createdAt: new Date(inserted.created_at).getTime() };
}

/** Stamp the user's read watermark for a thread (clears its unread dot). */
export async function markSupportThreadRead(threadId: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("support_threads")
    .update({ user_last_read_at: new Date().toISOString() })
    .eq("id", threadId);
  if (error) throw new Error(`markSupportThreadRead: ${error.message}`);
}
