import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect, vi } from "vitest";

/**
 * The Prospecting map's routes reach the RRC mirror through a connection that
 * bypasses RLS, so each one must answer an outsider the admin side's 404
 * before it reads anything. Every route under this folder is found on disk, so
 * a route added later without the gate fails here.
 */

// One layer under the real gate: the signed-in user and the database's own
// `is_platform_admin()` answer, so `notFoundUnlessPlatformAdmin` itself runs.
const isAdmin = vi.fn(async () => false);
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  hasSupabase: () => true,
}));
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getSessionUser: async () => ({ id: "u1" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: async () => ({
    rpc: async () => ({ data: await isAdmin(), error: null }),
  }),
}));
// Any read past the gate is a failure for an outsider.
const read = vi.fn(async () => {
  throw new Error("read past the gate");
});
vi.mock("@/lib/scout/rrc-db", () => ({
  hasRrcDb: () => true,
  rrcQuery: () => read(),
  rrcQueryOne: () => read(),
}));

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

const ROUTES = routeFiles(__dirname);
// Every dynamic segment a scout route uses, so each handler gets its params.
const PARAMS = {
  z: "5", x: "7", y: "13", api: "42", id: "1", countyNo: "1", fieldNo: "1",
  operator: "1", og: "O", district: "08", lease: "1", county: "1", year: "2025",
  ownerId: "1",
};

describe("/api/scout/* gate", () => {
  it("finds all 21 routes", () => {
    expect(ROUTES).toHaveLength(21);
  });

  for (const file of ROUTES) {
    it(`${relative(__dirname, file)} answers an outsider 404 before reading`, async () => {
      isAdmin.mockResolvedValue(false);
      const mod = (await import(file)) as Record<string, unknown>;
      const handlers = ["GET", "POST"].filter((m) => typeof mod[m] === "function");
      expect(handlers.length).toBeGreaterThan(0);
      for (const m of handlers) {
        const handler = mod[m] as (req: Request, ctx: unknown) => Promise<Response>;
        const res = await handler(
          new Request("http://x/api/scout/test?field=depth", { method: m, body: m === "POST" ? "{}" : undefined }),
          { params: Promise.resolve(PARAMS) }
        );
        expect(res.status).toBe(404);
      }
      expect(read).not.toHaveBeenCalled();
    });
  }

  it("lets an admin through", async () => {
    isAdmin.mockResolvedValue(true);
    const { GET } = await import("./histogram/route");
    const res = await GET(new Request("http://x/api/scout/histogram?field=depth"));
    expect(res.status).toBe(200);
  });
});
