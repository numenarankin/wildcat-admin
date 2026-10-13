import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashInviteToken } from "@/lib/auth/invite";

/**
 * Inviting onto the admin team: seed admin only, a hashed single-use token in
 * the row and the raw one only in the email, the pages cleaned to the catalog,
 * and no unreachable invite left behind when the email fails.
 */

const isSeed = vi.fn(async () => true);
vi.mock("@/lib/admin/team", () => ({ isSeedPlatformAdmin: () => isSeed() }));
vi.mock("@/lib/auth/session", () => ({ assertSignedIn: async () => ({ id: "seed-user" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const sendEmail = vi.fn(async (input: { name: string; email: string; token: string }) => void input);
vi.mock("@/lib/email/admin-invite-email", () => ({
  sendAdminInviteEmail: (input: { name: string; email: string; token: string }) => sendEmail(input),
}));

let roster: Array<{ user_id: string; email: string; pages?: string[]; is_seed: boolean }>;
let invites: Array<Record<string, unknown> & { id: string }>;
let rosterUpdates: Array<{ user_id: string; pages: string[] }>;
let inviteUpdates: Array<{ id: string; patch: Record<string, unknown> }>;

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "platform_admins")
        return {
          select: () => ({
            ilike: (_c: string, email: string) => ({
              maybeSingle: async () => ({ data: roster.find((r) => r.email === email) ?? null, error: null }),
            }),
          }),
          update: (patch: { pages: string[] }) => ({
            eq: (_c1: string, userId: string) => ({
              eq: (_c2: string, isSeed: boolean) => ({
                select: async () => {
                  const hit = roster.filter((r) => r.user_id === userId && r.is_seed === isSeed);
                  for (const r of hit) {
                    r.pages = patch.pages;
                    rosterUpdates.push({ user_id: r.user_id, pages: patch.pages });
                  }
                  return { data: hit.map((r) => ({ user_id: r.user_id })), error: null };
                },
              }),
            }),
          }),
        };
      if (table === "platform_admin_invites")
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                if (invites.some((i) => i.email === row.email)) return { data: null, error: { code: "23505", message: "dup" } };
                const inserted = { id: `inv-${invites.length + 1}`, ...row };
                invites.push(inserted);
                return { data: { id: inserted.id }, error: null };
              },
            }),
          }),
          delete: () => ({
            eq: async (_c: string, id: string) => {
              invites = invites.filter((i) => i.id !== id);
              return { error: null };
            },
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: (_c: string, id: string) => ({
              select: async () => {
                const hit = invites.filter((i) => i.id === id);
                for (const i of hit) inviteUpdates.push({ id: i.id, patch });
                return { data: hit.map((i) => ({ id: i.id })), error: null };
              },
            }),
          }),
        };
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  isSeed.mockResolvedValue(true);
  roster = [
    { user_id: "seed-user", email: "rankin@wildcatiq.ai", is_seed: true },
    { user_id: "u2", email: "bob@wildcatiq.ai", pages: ["tasks"], is_seed: false },
  ];
  invites = [];
  rosterUpdates = [];
  inviteUpdates = [];
});

describe("invitePlatformAdmin", () => {
  it("is refused for anyone but the seed admin, before anything is written", async () => {
    isSeed.mockResolvedValue(false);
    const { invitePlatformAdmin } = await import("./team-actions");
    await expect(invitePlatformAdmin("Jane", "jane@wildcatiq.ai", ["tasks"])).rejects.toThrow(/seed admin/);
    expect(invites).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("needs a real address and at least one page", async () => {
    const { invitePlatformAdmin } = await import("./team-actions");
    await expect(invitePlatformAdmin("Jane", "jane", ["tasks"])).rejects.toThrow(/email/);
    await expect(invitePlatformAdmin("Jane", "jane@wildcatiq.ai", ["bogus" as never])).rejects.toThrow(/at least one page/);
    expect(invites).toEqual([]);
  });

  it("refuses an address already on the team", async () => {
    const { invitePlatformAdmin } = await import("./team-actions");
    await expect(invitePlatformAdmin("Bob", "Bob@WildcatIQ.ai", ["tasks"])).rejects.toThrow(/already on the admin team/);
    expect(invites).toEqual([]);
  });

  it("stores the hash, mails the raw token, keeps only catalog pages", async () => {
    const { invitePlatformAdmin } = await import("./team-actions");
    const before = Date.now();
    const result = await invitePlatformAdmin("  Jane Doe ", " Jane@WildcatIQ.ai ", ["git", "bogus" as never, "tasks"]);
    expect(result).toEqual({ email: "jane@wildcatiq.ai" });

    expect(invites).toHaveLength(1);
    const row = invites[0];
    expect(row).toMatchObject({ email: "jane@wildcatiq.ai", name: "Jane Doe", pages: ["tasks", "git"], invited_by: "seed-user" });
    // 7 days out.
    const expires = Date.parse(row.invite_expires_at as string);
    expect(expires - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(expires - before).toBeLessThanOrEqual(7 * 86_400_000 + 1000);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const { token, email, name } = sendEmail.mock.calls[0][0];
    expect(email).toBe("jane@wildcatiq.ai");
    expect(name).toBe("Jane Doe");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(row.invite_token_hash).toBe(hashInviteToken(token));
    expect(row.invite_token_hash).not.toBe(token);
  });

  it("deletes the pending row when the email cannot be sent", async () => {
    sendEmail.mockRejectedValueOnce(new Error("Brevo down"));
    const { invitePlatformAdmin } = await import("./team-actions");
    await expect(invitePlatformAdmin("Jane", "jane@wildcatiq.ai", ["tasks"])).rejects.toThrow(/Couldn't email the invite: Brevo down/);
    expect(invites).toEqual([]);
  });

  it("a second invite to the same address says to resend instead", async () => {
    const { invitePlatformAdmin } = await import("./team-actions");
    await invitePlatformAdmin("Jane", "jane@wildcatiq.ai", ["tasks"]);
    await expect(invitePlatformAdmin("Jane", "jane@wildcatiq.ai", ["tasks"])).rejects.toThrow(/pending invite/);
    expect(invites).toHaveLength(1);
  });
});

describe("setPlatformAdminPages", () => {
  it("replaces a member's pages, cleaned", async () => {
    const { setPlatformAdminPages } = await import("./team-actions");
    await setPlatformAdminPages("u2", ["git", "bogus" as never, "dashboard"]);
    expect(rosterUpdates).toEqual([{ user_id: "u2", pages: ["dashboard", "git"] }]);
  });

  it("never edits the seed row", async () => {
    const { setPlatformAdminPages } = await import("./team-actions");
    await expect(setPlatformAdminPages("seed-user", ["git"])).rejects.toThrow(/cannot be changed/);
    expect(rosterUpdates).toEqual([]);
    expect(inviteUpdates).toEqual([]);
  });

  it("falls through to a pending invite's pages", async () => {
    const { invitePlatformAdmin, setPlatformAdminPages } = await import("./team-actions");
    await invitePlatformAdmin("Jane", "jane@wildcatiq.ai", ["tasks"]);
    await setPlatformAdminPages("inv-1", ["tasks", "git"]);
    expect(inviteUpdates).toEqual([{ id: "inv-1", patch: { pages: ["tasks", "git"] } }]);
  });
});
