import { describe, it, expect } from "vitest";
import { accessFromRows } from "./platform-admin-access";
import { ADMIN_PAGE_KEYS } from "@/lib/admin/pages";
import { hashInviteToken, inviteExpiry } from "./invite";

/** What a `platform_admin_access()` answer grants, as the proxy and the guards read it. */
describe("accessFromRows", () => {
  it("no row: not an admin, no pages", () => {
    expect(accessFromRows([])).toEqual({ isAdmin: false, isSeed: false, pages: [] });
    expect(accessFromRows(null)).toEqual({ isAdmin: false, isSeed: false, pages: [] });
  });

  it("a member gets exactly their list, unknown keys dropped", () => {
    expect(accessFromRows([{ is_seed: false, pages: ["git", "bogus", "tasks"] }])).toEqual({
      isAdmin: true,
      isSeed: false,
      pages: ["tasks", "git"],
    });
  });

  it("a member with an empty list is on the side but opens nothing", () => {
    expect(accessFromRows([{ is_seed: false, pages: [] }])).toEqual({ isAdmin: true, isSeed: false, pages: [] });
  });

  it("the seed admin has every page whatever the column says", () => {
    expect(accessFromRows([{ is_seed: true, pages: [] }]).pages).toEqual([...ADMIN_PAGE_KEYS]);
  });
});

describe("invite tokens", () => {
  it("stores the SHA-256 of the token, never the token", () => {
    // sha256("abc"), from the FIPS 180 test vector.
    expect(hashInviteToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashInviteToken(" abc ")).toBe(hashInviteToken("abc"));
  });

  it("expires 7 days out", () => {
    expect(inviteExpiry(Date.UTC(2026, 9, 13))).toBe("2026-10-20T00:00:00.000Z");
  });
});
