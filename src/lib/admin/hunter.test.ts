import { describe, it, expect } from "vitest";
import { parseDomainSearch, parseEmailFinder, parseVerifier } from "./hunter";

/** Hunter v2 response shapes, as documented, cut to the fields read. */

describe("parseDomainSearch", () => {
  it("reads the pattern and each address with its person and sources", () => {
    const out = parseDomainSearch({
      data: {
        domain: "acmeoil.com",
        organization: "Acme Oil",
        pattern: "{first}.{last}",
        emails: [
          {
            value: "john.doe@acmeoil.com",
            type: "personal",
            confidence: 92,
            first_name: "John",
            last_name: "Doe",
            position: "President",
            sources: [{ uri: "https://acmeoil.com/team" }],
          },
          { value: "info@acmeoil.com", type: "generic", confidence: 60, first_name: null, last_name: null, position: null, sources: [] },
          { value: "", type: "generic" },
        ],
      },
    });
    expect(out.pattern).toBe("{first}.{last}");
    expect(out.emails).toHaveLength(2);
    expect(out.emails[0]).toEqual({
      email: "john.doe@acmeoil.com",
      type: "personal",
      confidence: 92,
      firstName: "John",
      lastName: "Doe",
      position: "President",
      sources: ["https://acmeoil.com/team"],
    });
  });
  it("is empty for a 404-style empty body", () => {
    expect(parseDomainSearch({})).toEqual({ domain: "", organization: null, pattern: null, emails: [] });
  });
});

describe("parseEmailFinder", () => {
  it("reads the address and score", () => {
    expect(parseEmailFinder({ data: { email: "jane.roe@acmeoil.com", score: 88, position: "CFO" } })).toEqual({
      email: "jane.roe@acmeoil.com",
      score: 88,
      position: "CFO",
    });
    expect(parseEmailFinder({ data: { email: null, score: null } })).toEqual({ email: null, score: null, position: null });
  });
});

describe("parseVerifier", () => {
  it("maps result to the verdict and keeps the status", () => {
    expect(parseVerifier({ data: { email: "a@b.com", result: "deliverable", status: "valid", score: 97 } }, "a@b.com")).toEqual({
      email: "a@b.com",
      verification: "deliverable",
      status: "valid",
      score: 97,
    });
    expect(parseVerifier({ data: { result: "risky", status: "accept_all", score: 50 } }, "x@y.com").verification).toBe("risky");
    expect(parseVerifier({}, "x@y.com")).toEqual({ email: "x@y.com", verification: "unknown", status: "unknown", score: null });
  });
});
