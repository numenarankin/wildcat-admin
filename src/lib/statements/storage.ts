/**
 * Private Supabase Storage bucket holding the original purchaser-statement PDFs.
 * Shared by the server (admin reads/writes, signed-URL minting) and the browser
 * (direct-to-storage upload via a signed upload URL), so it lives in a plain
 * module rather than the `"use server"` actions file. Mirrors
 * `@/lib/accounting/storage`.
 */
export const STATEMENT_UPLOAD_BUCKET = "statement-uploads";

/**
 * Validates that a client-supplied storage key belongs to the given org. Keys
 * are namespaced `${orgId}/<uuid>`; rejecting anything outside the caller's
 * prefix stops one org from referencing another org's uploaded bytes via a
 * forged key.
 */
export function isOwnedStorageKey(key: string, orgId: string): boolean {
  return key.startsWith(`${orgId}/`);
}

/**
 * Where the PRE-CROP original of a photographed statement lives, beside the crop
 * it was derived from. Mirrors the `<file id>.original` convention `files`
 * uploads use (`src/lib/files/hygiene.ts`).
 *
 * Derived rather than stored so cleanup paths can remove the sibling without
 * having to read `hygiene->>'originalKey'` first — `remove()` on a key that was
 * never written is a no-op, so deleting both is always safe.
 */
export function originalStorageKey(key: string): string {
  return `${key}.original`;
}

/**
 * Where the TRANSCRIPT of an uploaded statement lives, beside the bytes it was
 * read from.
 *
 * The document is transcribed once, at extract time, and the run-grain backfill
 * needs that same text — but it runs AFTER the user saves, so that the review
 * screen is not held up by an extraction whose output nothing reads until then.
 * Parking the markdown next to the upload is what lets the two steps be
 * separate requests without paying for a second read.
 *
 * Derived, like `originalStorageKey`, so every cleanup path can remove the
 * sibling without looking it up first.
 */
export function transcriptStorageKey(key: string): string {
  return `${key}.transcript.md`;
}
