import { ALL_ADMIN_PAGES, cleanPages, type AdminPageKey } from "@/lib/admin/pages";

/**
 * What a `platform_admin_access()` answer grants. On its own, with no server
 * imports, because the proxy (edge runtime) and the server guards both read
 * the RPC and must agree on what it means.
 */

export interface PlatformAdminAccess {
  /** On the list at all. */
  isAdmin: boolean;
  isSeed: boolean;
  /** The pages they may open. Every page for the seed admin. */
  pages: AdminPageKey[];
}

export const NO_ACCESS: PlatformAdminAccess = { isAdmin: false, isSeed: false, pages: [] };

/**
 * The seed admin's pages column is ignored on purpose: the bootstrap account
 * can never lock itself out. Anyone else gets exactly their list, unknown keys
 * dropped.
 */
export function accessFromRows(rows: unknown): PlatformAdminAccess {
  const row = Array.isArray(rows)
    ? (rows[0] as { is_seed?: unknown; pages?: unknown } | undefined)
    : undefined;
  if (!row) return NO_ACCESS;
  const isSeed = row.is_seed === true;
  const stored = Array.isArray(row.pages) ? row.pages.filter((p): p is string => typeof p === "string") : [];
  return { isAdmin: true, isSeed, pages: isSeed ? [...ALL_ADMIN_PAGES] : cleanPages(stored) };
}

/**
 * PostgREST's answer when an RPC does not exist (PGRST202), i.e. the migration
 * that creates it has not been applied to this database.
 */
export function isMissingFunction(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === "PGRST202" || /could not find the function/i.test(String(e?.message ?? ""));
}
