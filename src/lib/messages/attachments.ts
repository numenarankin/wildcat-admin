import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ChatAttachment } from "@/lib/messages/types";

/**
 * Message attachments: the storage convention and the `files` row behind one,
 * shared by both ways of sending a file into a chat.
 *
 * The browser hands its bytes to a server action (`uploadMessageAttachments`);
 * the phone cannot call one, and cannot reach Storage itself either (the anon
 * key holds no `storage.objects` policy), so it takes a signed upload target,
 * pushes the bytes straight to Storage, and hands back the key
 * (`/api/messages/attachments`). Both then land here, so a file looks the same
 * in the thread whichever client sent it.
 *
 * The admin client is what touches the bucket in both paths, for the reason
 * `uploadMessageAttachments` already gave: a member may not hold `manage_files`,
 * and these files are reachable only through the message they are linked to,
 * never through the Files tree.
 */

export const CHAT_FILES_BUCKET = "files";
export const CHAT_SIGNED_URL_TTL = 60 * 60; // one hour, matching the support chat

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"];

/** Map a filename to one of the `files.type` values (mirrors files/actions). */
export function attachmentType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "md";
  if (IMAGE_EXTS.includes(ext)) return "image";
  return "doc";
}

/**
 * Where a chat attachment's bytes live: `${orgId}/<uuid>` inside the shared
 * `files` bucket.
 *
 * Namespaced by org, and namespaced for a reason: {@link isOwnedAttachmentKey}
 * is what stops a caller from handing the finalize route somebody ELSE's
 * storage key and having a `files` row minted in their own org that points at
 * it, which would sign a stranger's document into their chat. Same convention,
 * and the same defence, as `lib/accounting/storage.ts`.
 */
export function attachmentKey(orgId: string): string {
  return `${orgId}/${crypto.randomUUID()}`;
}

/** Whether a client-supplied storage key belongs to the given org. */
export function isOwnedAttachmentKey(key: string, orgId: string): boolean {
  return key.startsWith(`${orgId}/`);
}

/** Mint a one-time signed upload URL for a chat attachment. */
export async function createAttachmentUploadTarget(
  admin: SupabaseClient,
  orgId: string
): Promise<{ bucket: string; path: string; token: string }> {
  const path = attachmentKey(orgId);
  const { data, error } = await admin.storage
    .from(CHAT_FILES_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    throw new Error(
      `createAttachmentUploadTarget: ${error?.message ?? "no signed URL"}`
    );
  }
  return { bucket: CHAT_FILES_BUCKET, path, token: data.token };
}

/**
 * Record bytes that are already in the bucket as a `files` row, and hand back
 * the attachment the composer will send. The row's id is what goes into
 * `chat_files`, so this is the point at which a file becomes attachable.
 */
export async function registerAttachment(
  admin: SupabaseClient,
  input: {
    orgId: string;
    userId: string;
    /** Key inside {@link CHAT_FILES_BUCKET}; already ownership-checked. */
    storageKey: string;
    name: string;
    mime: string | null;
    size: number | null;
  }
): Promise<ChatAttachment> {
  const id = crypto.randomUUID();
  const { error } = await admin.from("files").insert({
    id,
    name: input.name,
    type: attachmentType(input.name),
    mime: input.mime,
    size: input.size,
    storage_key: input.storageKey,
    org_id: input.orgId,
    created_by: input.userId,
  });
  if (error) throw new Error(`registerAttachment: ${error.message}`);

  const { data: signed } = await admin.storage
    .from(CHAT_FILES_BUCKET)
    .createSignedUrl(input.storageKey, CHAT_SIGNED_URL_TTL);
  return { id, name: input.name, url: signed?.signedUrl ?? null };
}

/**
 * The user's org, resolved without depending on RLS. Mirrors support/actions 
 * lives here rather than in the `"use server"` actions file so the bearer routes
 * can call it without it becoming a server-action endpoint.
 */
export async function resolveOrgId(
  admin: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("owner_uid", userId)
    .maybeSingle();
  if (org?.id) return org.id as string;
  const { data: member } = await admin
    .from("org_members")
    .select("org_id")
    .eq("auth_user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (member?.org_id as string | undefined) ?? null;
}
