import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashInviteToken } from "@/lib/auth/invite";

/**
 * Accepting an admin invite: the token is the only credential, a password is
 * all a newcomer provides, and the roster row carries the pages and the name
 * the invite did. An existing account joins as it is.
 */

type Invite = {
  id: string;
  email: string;
  name: string;
  pages: string[];
  invite_token_hash: string;
  invite_expires_at: string;
  invited_by: string | null;
};

const DAY = 86_400_000;
let invites: Invite[];
let rosterInserts: Record<string, unknown>[];
let rosterInsertError: { code?: string; message: string } | null;
let existingUserId: string | null;
let profileUpserts: Record<string, unknown>[];
const createUser = vi.fn(async (input: Record<string, unknown>) => ({
  data: { user: { id: "new-user", email: input.email } },
  error: null,
}));
const deleteUser = vi.fn(async () => ({ error: null }));

function invitesTable() {
  return {
    select: () => ({
      eq: (_col: string, hash: string) => ({
        maybeSingle: async () => ({ data: invites.find((i) => i.invite_token_hash === hash) ?? null, error: null }),
      }),
    }),
    delete: () => ({
      eq: (_c1: string, id: string) => ({
        eq: async (_c2: string, hash: string) => {
          invites = invites.filter((i) => !(i.id === id && i.invite_token_hash === hash));
          return { error: null };
        },
      }),
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "platform_admin_invites") return invitesTable();
      if (table === "platform_admins")
        return {
          insert: async (row: Record<string, unknown>) => {
            if (rosterInsertError) return { error: rosterInsertError };
            rosterInserts.push(row);
            return { error: null };
          },
        };
      if (table === "profile")
        return {
          upsert: async (row: Record<string, unknown>) => {
            profileUpserts.push(row);
            return { error: null };
          },
        };
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string) => {
      if (fn !== "auth_user_id_by_email") throw new Error(fn);
      return { data: existingUserId, error: null };
    },
    auth: { admin: { createUser, deleteUser } },
  }),
}));

const post = async (body: unknown) => {
  const { POST } = await import("./route");
  return POST(new Request("http://x/api/auth/accept-invite", { method: "POST", body: JSON.stringify(body) }));
};

beforeEach(() => {
  vi.clearAllMocks();
  invites = [
    {
      id: "inv-1",
      email: "jane@wildcatiq.ai",
      name: "Jane Doe",
      pages: ["tasks", "bogus", "git"],
      invite_token_hash: hashInviteToken("good-token"),
      invite_expires_at: new Date(Date.now() + DAY).toISOString(),
      invited_by: "seed-user",
    },
    {
      id: "inv-2",
      email: "old@wildcatiq.ai",
      name: "",
      pages: ["tasks"],
      invite_token_hash: hashInviteToken("stale-token"),
      invite_expires_at: new Date(Date.now() - DAY).toISOString(),
      invited_by: null,
    },
  ];
  rosterInserts = [];
  rosterInsertError = null;
  existingUserId = null;
  profileUpserts = [];
});

describe("POST /api/auth/accept-invite", () => {
  it("refuses an unknown token before touching an account", async () => {
    const res = await post({ token: "nope", password: "secret1" });
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
    expect(rosterInserts).toEqual([]);
  });

  it("refuses an expired token with 410", async () => {
    const res = await post({ token: "stale-token", password: "secret1" });
    expect(res.status).toBe(410);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("a newcomer needs only a password of 6+ characters", async () => {
    expect((await post({ token: "good-token" })).status).toBe(400);
    expect((await post({ token: "good-token", password: "short" })).status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("creates an admin-only account, puts it on the list with the invite's pages and name, consumes the invite", async () => {
    const res = await post({ token: "good-token", password: "secret1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: "jane@wildcatiq.ai", existingAccount: false });

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser.mock.calls[0][0]).toEqual({
      email: "jane@wildcatiq.ai",
      password: "secret1",
      email_confirm: true,
      app_metadata: { admin_only: true },
    });
    expect(rosterInserts).toEqual([
      {
        user_id: "new-user",
        email: "jane@wildcatiq.ai",
        name: "Jane Doe",
        pages: ["tasks", "git"],
        is_seed: false,
        added_by: "seed-user",
      },
    ]);
    // Single use: the row is gone, so the same link is now "invalid".
    expect(invites.map((i) => i.id)).toEqual(["inv-2"]);
    expect((await post({ token: "good-token", password: "secret1" })).status).toBe(400);
    // The header shows the name the inviter typed.
    expect(profileUpserts).toEqual([{ user_id: "new-user", name: "Jane Doe" }]);
  });

  it("an existing account joins as it is: no account created, no password needed, sign in next", async () => {
    existingUserId = "existing-user";
    const res = await post({ token: "good-token" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: "jane@wildcatiq.ai", existingAccount: true });
    expect(createUser).not.toHaveBeenCalled();
    expect(rosterInserts[0]).toMatchObject({ user_id: "existing-user", pages: ["tasks", "git"] });
    expect(profileUpserts).toEqual([]);
    expect(invites.map((i) => i.id)).toEqual(["inv-2"]);
  });

  it("rolls a just-created account back when the roster insert fails, and keeps the invite", async () => {
    rosterInsertError = { message: "boom" };
    const res = await post({ token: "good-token", password: "secret1" });
    expect(res.status).toBe(500);
    expect(deleteUser).toHaveBeenCalledWith("new-user");
    expect(invites.map((i) => i.id)).toEqual(["inv-1", "inv-2"]);
  });

  it("never deletes an existing account on a failed insert", async () => {
    existingUserId = "existing-user";
    rosterInsertError = { code: "23505", message: "dup" };
    const res = await post({ token: "good-token" });
    expect(res.status).toBe(409);
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
