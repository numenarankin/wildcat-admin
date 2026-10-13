import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ACCOUNTING_UPLOAD_BUCKET,
  isOwnedStorageKey,
} from "@/lib/accounting/storage";

/**
 * A short-lived signed URL for a run ticket's attached photo/PDF — the audit
 * path back to the primary source. The ticket is read through the caller's
 * RLS client (so a ticket outside their org is simply not found) and the
 * stored key is re-checked against the caller's org prefix before the admin
 * client (which bypasses RLS) signs the bytes. Null when there is no
 * attachment.
 *
 * Shared by the tank page's paperclip, the Files tab / Files page (where the
 * photo is listed under a synthetic file id) and the bearer URL route.
 */
export async function signRunTicketFile(
  sb: SupabaseClient,
  admin: SupabaseClient,
  ticketId: string,
  ttlSeconds = 60 * 60
): Promise<string | null> {
  if (!ticketId) return null;
  const { data, error } = await sb
    .from("run_tickets")
    .select("image_ref")
    .eq("id", ticketId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const storageKey = (data as { image_ref: string | null }).image_ref;
  if (!storageKey) return null;

  const { data: orgId } = await sb.rpc("current_org_id");
  if (!orgId || !isOwnedStorageKey(storageKey, orgId as string)) return null;

  const { data: signed, error: signErr } = await admin.storage
    .from(ACCOUNTING_UPLOAD_BUCKET)
    .createSignedUrl(storageKey, ttlSeconds);
  if (signErr || !signed) return null;
  return signed.signedUrl;
}
