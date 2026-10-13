import { describe, it, expect, vi, beforeEach } from "vitest";
import { ADMIN_PAGE_KEYS } from "@/lib/admin/pages";

/**
 * The page-level resolver against a database that predates it: with
 * `platform_admin_access()` missing, an admin keeps every page (the gate as it
 * was), an outsider still gets nothing.
 */
const rpc = vi.fn(async (fn: string): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), hasSupabase: () => true }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth/session")>()), getSessionUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServer: async () => ({ rpc: (fn: string) => rpc(fn) }) }));
vi.mock("@/lib/cache/render-cache", () => ({ memoRender: (_k: string, load: () => Promise<unknown>) => load }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("getPlatformAdminAccess before migration 2026101300100", () => {
  it("an admin gets every page", async () => {
    rpc.mockImplementation(async (fn) =>
      fn === "is_platform_admin" ? { data: true, error: null } : { data: null, error: { code: "PGRST202", message: "missing" } }
    );
    const { getPlatformAdminAccess } = await import("./platform-admin");
    expect(await getPlatformAdminAccess()).toEqual({ isAdmin: true, isSeed: false, pages: [...ADMIN_PAGE_KEYS] });
  });

  it("an outsider gets nothing", async () => {
    rpc.mockImplementation(async (fn) =>
      fn === "is_platform_admin" ? { data: false, error: null } : { data: null, error: { code: "PGRST202", message: "missing" } }
    );
    const { getPlatformAdminAccess } = await import("./platform-admin");
    expect(await getPlatformAdminAccess()).toEqual({ isAdmin: false, isSeed: false, pages: [] });
  });

  it("after the migration, the list is read as stored", async () => {
    rpc.mockImplementation(async () => ({ data: [{ is_seed: false, pages: ["git"] }], error: null }));
    const { getPlatformAdminAccess } = await import("./platform-admin");
    expect(await getPlatformAdminAccess()).toEqual({ isAdmin: true, isSeed: false, pages: ["git"] });
  });
});
