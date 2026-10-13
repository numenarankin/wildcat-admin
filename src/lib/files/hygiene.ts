import "server-only";

import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Server side of photo hygiene: validate the crop metadata the browser sends
 * alongside an upload, and keep the pre-crop original bytes.
 *
 * The uploaded bytes are the CROP — deliberately. Everything downstream reads
 * `storage_key`: the ingest scan, `embedFile`'s OCR for search, and the file
 * preview. Storing the crop there keeps all three consistent, so a neighbouring
 * page cropped out of the photo is also absent from the search index, not just
 * from extraction. The original is kept beside it purely as an audit and
 * recovery path for when a crop turns out to be wrong.
 */

const PointSchema = z.object({ x: z.number(), y: z.number() });

const QuadSchema = z.object({
  topLeft: PointSchema,
  topRight: PointSchema,
  bottomRight: PointSchema,
  bottomLeft: PointSchema,
});

/**
 * Mirrors `HygieneMeta` in `components/scan/crop-review-modal`. Parsed rather
 * than trusted: this is client-supplied JSON headed for a `jsonb` column, so a
 * malformed or hostile payload must degrade to "no metadata", never poison the
 * row or throw mid-upload.
 */
const HygieneMetaSchema = z.object({
  name: z.string().max(512).optional(),
  cropped: z.boolean(),
  uncropped: z.boolean(),
  rotatedDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  reject: z
    .enum(["no-contour", "not-convex", "too-small", "full-frame", "skewed"])
    .nullable()
    .default(null),
  adjusted: z.boolean().default(false),
  quad: QuadSchema.nullable().default(null),
  originalBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
});

export type HygieneMetaInput = z.infer<typeof HygieneMetaSchema>;

/** What lands in `files.hygiene` / `statements.hygiene`. */
export type StoredHygiene = HygieneMetaInput & {
  /** Storage key of the pre-crop original, when one was kept. */
  originalKey: string | null;
  /**
   * Which surface produced this, for future migrations. `web-crop-review` is
   * the `files` path (well/data-entry uploads, which post FormData to a server
   * action); `revenue-upload` is the Revenue statement path, which streams
   * direct to the `statement-uploads` bucket and so stores its original itself.
   */
  source: "web-crop-review" | "revenue-upload";
};

const BUCKET = "files";

/**
 * Parse one `hygiene` form field. Returns null for anything absent, non-JSON, or
 * failing the schema — an upload must never fail because its metadata was bad.
 */
export function parseHygiene(raw: FormDataEntryValue | null): HygieneMetaInput | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = HygieneMetaSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn("[hygiene] discarding malformed metadata", {
        issues: parsed.error.issues.map((i) => i.message).slice(0, 3),
      });
      return null;
    }
    return parsed.data;
  } catch {
    console.warn("[hygiene] metadata was not JSON");
    return null;
  }
}

/**
 * Store the pre-crop original beside the uploaded crop and return its key.
 * Best-effort: losing the audit copy must not fail the upload the user is
 * waiting on, so a storage error is logged and swallowed.
 */
export async function storeOriginal(
  fileId: string,
  original: FormDataEntryValue | null
): Promise<string | null> {
  if (!(original instanceof File) || original.size === 0) return null;
  const key = `${fileId}.original`;
  try {
    const bytes = Buffer.from(await original.arrayBuffer());
    const { error } = await getSupabaseAdmin()
      .storage.from(BUCKET)
      .upload(key, bytes, {
        contentType: original.type || undefined,
        upsert: false,
      });
    if (error) throw new Error(error.message);
    return key;
  } catch (error) {
    console.error("[hygiene] failed to store pre-crop original", {
      fileId,
      error,
    });
    return null;
  }
}

/**
 * Resolve the `files.hygiene` value for one upload: parse the metadata, store
 * the original, and fold the two together. Returns null when the file had no
 * hygiene step (every non-image, and every surface not yet wired up), so the
 * column stays null rather than filling with meaningless defaults.
 */
export async function resolveHygiene(
  fileId: string,
  rawMeta: FormDataEntryValue | null,
  rawOriginal: FormDataEntryValue | null
): Promise<StoredHygiene | null> {
  const meta = parseHygiene(rawMeta);
  if (!meta) return null;
  const originalKey = await storeOriginal(fileId, rawOriginal);
  return { ...meta, originalKey, source: "web-crop-review" };
}
