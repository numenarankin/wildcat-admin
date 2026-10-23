"use server";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";

const BUCKET = "admin-files";

/**
 * A signed link to a file Orion wrote, readable for an hour: inline for View,
 * as an attachment named `filename` for Download. Only paths under `orion/`, so
 * this cannot be pointed at a project's files (those go through
 * `getAdminProjectFileUrl`, which checks the project row).
 */
export async function getOrionFileUrl(
  path: string,
  opts: { download?: string } = {}
): Promise<string | null> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  if (!/^orion\/[0-9a-f-]{36}\/[^/]+$/.test(path)) return null;
  const { data, error } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .createSignedUrl(path, 60 * 60, opts.download ? { download: opts.download } : undefined);
  if (error) throw new Error(`getOrionFileUrl: ${error.message}`);
  return data?.signedUrl ?? null;
}
