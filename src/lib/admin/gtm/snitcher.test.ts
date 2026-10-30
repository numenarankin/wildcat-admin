import { describe, expect, it } from "vitest";
import { parseDelivery, verifySignature } from "./snitcher";

describe("verifySignature", () => {
  // The published HMAC-SHA256 test vector (RFC 4231 style, key "key").
  const body = "The quick brown fox jumps over the lazy dog";
  const signature = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8";

  it("accepts the body's own signature, in either case", () => {
    expect(verifySignature(body, signature, "key")).toBe(true);
    expect(verifySignature(body, signature.toUpperCase(), "key")).toBe(true);
  });

  it("refuses a missing, wrong or altered signature", () => {
    expect(verifySignature(body, null, "key")).toBe(false);
    expect(verifySignature(body, signature, "other-key")).toBe(false);
    expect(verifySignature(`${body}.`, signature, "key")).toBe(false);
    expect(verifySignature(body, signature.slice(0, 10), "key")).toBe(false);
  });
});

describe("parseDelivery", () => {
  // Snitcher's documented webhook payload (reference/snitcher-com/docs/product/integrations/webhooks.md).
  const documented = {
    event: "company.identified",
    timestamp: "2024-01-15T10:30:00Z",
    workspace: { uuid: "ws_abc123", name: "My Workspace" },
    company: {
      uuid: "org_xyz789",
      name: "Acme Inc",
      domain: "acme.com",
      industry: "Technology",
      employee_range: "50-200",
      location: { city: "San Francisco", region: "California", country: "United States" },
    },
    session: { uuid: "sess_123", started_at: "2024-01-15T10:25:00Z", pages_viewed: 3, referrer: "google.com" },
  };

  it("reads the company, its headquarters and the session", () => {
    expect(parseDelivery(documented)).toEqual({
      event: "company.identified",
      workspaceUuid: "ws_abc123",
      company: {
        uuid: "org_xyz789",
        name: "Acme Inc",
        domain: "acme.com",
        industry: "Technology",
        employeeRange: "50-200",
        city: "San Francisco",
        state: "California",
        country: "United States",
      },
      session: { uuid: "sess_123", startedAt: "2024-01-15T10:25:00Z", pagesViewed: 3, referrer: "google.com" },
    });
  });

  it("has nothing to store for a contacts reveal, which carries no session", () => {
    expect(parseDelivery({ event: "contacts_revealed", site_id: 12345, subjects: [] })).toBeNull();
  });
});
