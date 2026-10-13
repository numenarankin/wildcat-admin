import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => ({}) }));

import { sentFacts } from "@/lib/admin/google/gmail/index-sync";

describe("sentFacts", () => {
  it("collects every recipient once, lower-cased, and the bare subject", () => {
    expect(
      sentFacts({
        id: "m1",
        threadId: "t1",
        internalDate: "1759920000000",
        payload: {
          partId: "",
          mimeType: "text/plain",
          headers: [
            { name: "To", value: '"Rapaport, Yoni" <Yoni@checkbook.test>, jerry@checkbook.test' },
            { name: "Cc", value: "Yoni@Checkbook.test, Ann <ann@x.co>" },
            { name: "Subject", value: "Re: Fwd: Checkbook call" },
          ],
        },
      })
    ).toEqual({
      at: 1759920000000,
      recipients: [
        { email: "yoni@checkbook.test", name: "Rapaport, Yoni" },
        { email: "jerry@checkbook.test", name: "" },
        { email: "ann@x.co", name: "Ann" },
      ],
      subject: "Checkbook call",
    });
  });

  it("has no subject for an empty one", () => {
    expect(sentFacts({ id: "m", threadId: "t", payload: { partId: "", mimeType: "text/plain", headers: [{ name: "Subject", value: "Re:" }] } }).subject).toBeNull();
  });
});
