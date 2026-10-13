import { describe, it, expect } from "vitest";
import { completeRecipient, completeSubject, formatContact } from "@/lib/admin/google/gmail/suggest";

const NOW = Date.UTC(2026, 9, 8);
const day = 86_400_000;
const contacts = [
  { email: "yoni@checkbook.test", name: "Yoni Rapaport", uses: 14, lastUsedAt: NOW - 1 * day },
  { email: "yolanda@mesa.test", name: "Yolanda Perez", uses: 2, lastUsedAt: NOW - 400 * day },
  { email: "jerry@checkbook.test", name: "Jerry Lin", uses: 1, lastUsedAt: NOW - 2 * day },
  { email: "noreply@acretrader.test", name: "", uses: 1, lastUsedAt: NOW - 30 * day },
];

describe("completeRecipient", () => {
  it("completes a name, keeping what was typed, and leaves the cursor ready for the next address", () => {
    expect(completeRecipient("yo", contacts, NOW)).toEqual({
      value: "yo" + "ni Rapaport <yoni@checkbook.test>, ",
      tail: "ni Rapaport <yoni@checkbook.test>, ",
    });
  });

  it("prefers the recent, frequent contact over an old one that also matches", () => {
    expect(completeRecipient("Yo", contacts, NOW)?.value).toBe("Yoni Rapaport <yoni@checkbook.test>, ");
  });

  it("matches a later word or the address, then shows the whole contact", () => {
    expect(completeRecipient("rapa", contacts, NOW)).toEqual({
      value: "rapa (Yoni Rapaport <yoni@checkbook.test>), ",
      tail: " (Yoni Rapaport <yoni@checkbook.test>), ",
    });
    expect(completeRecipient("jerry@", contacts, NOW)?.tail).toBe(" (Jerry Lin <jerry@checkbook.test>), ");
  });

  it("works on the fragment after the last comma, keeping earlier recipients", () => {
    expect(completeRecipient("Jerry Lin <jerry@checkbook.test>, yon", contacts, NOW)?.value).toBe(
      "Jerry Lin <jerry@checkbook.test>, yoni Rapaport <yoni@checkbook.test>, "
    );
  });

  it("needs two characters and gives up when nothing matches", () => {
    expect(completeRecipient("y", contacts, NOW)).toBeNull();
    expect(completeRecipient("zzz", contacts, NOW)).toBeNull();
    expect(completeRecipient("Yoni Rapaport <yoni@checkbook.test>, ", contacts, NOW)).toBeNull();
  });

  it("uses the bare address for a contact with no name", () => {
    expect(formatContact(contacts[3])).toBe("noreply@acretrader.test");
    expect(completeRecipient("nore", contacts, NOW)?.value).toBe("noreply@acretrader.test, ");
  });
});

describe("completeSubject", () => {
  const subjects = [
    { subject: "Checkbook Technical Thread for Wildcatiq", uses: 6, lastUsedAt: NOW - day },
    { subject: "Checkbook call", uses: 1, lastUsedAt: NOW - 90 * day },
  ];

  it("completes the best past subject", () => {
    expect(completeSubject("check", subjects, NOW)).toEqual({
      value: "check" + "book Technical Thread for Wildcatiq",
      tail: "book Technical Thread for Wildcatiq",
    });
  });

  it("offers nothing once the subject is fully typed, or for one character", () => {
    expect(completeSubject("Checkbook call", subjects, NOW)).toBeNull();
    expect(completeSubject("c", subjects, NOW)).toBeNull();
  });
});
