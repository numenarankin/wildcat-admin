/**
 * Private Supabase Storage bucket holding the original files behind accounting
 * upload batches. Shared by the server (admin reads/writes, signed-URL minting)
 * and the browser (direct-to-storage upload via a signed upload URL), so it
 * lives in a plain module rather than the `"use server"` actions file.
 */
export const ACCOUNTING_UPLOAD_BUCKET = "accounting-uploads";

/**
 * Validates that a client-supplied storage key belongs to the given org. Keys
 * are namespaced `${orgId}/<uuid>`; rejecting anything outside the caller's
 * prefix stops one org from referencing (extracting, claiming, or deleting)
 * another org's uploaded bytes via a forged key.
 */
export function isOwnedStorageKey(key: string, orgId: string): boolean {
  return key.startsWith(`${orgId}/`);
}

/**
 * Mint a one-time signed upload URL into the accounting bucket for `orgId`.
 *
 * Callers stream the bytes straight to Storage with
 * `uploadToSignedUrl(path, token, bytes)` and then hand `path` back as a
 * `storageKey` — the extract routes take a reference, never a body, because a
 * scanned document would blow the serverless request-body cap.
 *
 * The path is namespaced `${orgId}/<uuid>`, which is exactly what
 * {@link isOwnedStorageKey} later verifies, so a key can neither collide with
 * nor impersonate another org's. Takes an already-resolved `orgId` and an admin
 * client rather than resolving them itself, so the `"use server"` action
 * (browser) and the bearer route (mobile) share one implementation.
 */
export async function createUploadTarget(
  admin: {
    storage: {
      from(bucket: string): {
        createSignedUploadUrl(path: string): Promise<{
          data: { token: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
  },
  orgId: string
): Promise<{ bucket: string; path: string; token: string }> {
  const path = `${orgId}/${crypto.randomUUID()}`;
  const { data, error } = await admin.storage
    .from(ACCOUNTING_UPLOAD_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    throw new Error(`createUploadTarget: ${error?.message ?? "no signed URL"}`);
  }
  return { bucket: ACCOUNTING_UPLOAD_BUCKET, path, token: data.token };
}
