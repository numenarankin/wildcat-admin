import { describe, it, expect } from "vitest";
import { bodyToHtml, normalizeEmailDraft } from "@/lib/admin/google/gmail/draft-spec";

describe("normalizeEmailDraft", () => {
  it("sets only the fields Orion supplied", () => {
    expect(normalizeEmailDraft({ subject: "Checkbook call" })).toEqual({ subject: "Checkbook call" });
  });

  it("keeps header fields on one line", () => {
    expect(normalizeEmailDraft({ to: "a@b.co\r\nBcc: x@y.co", subject: "Hi\nthere" })).toEqual({
      to: "a@b.co Bcc: x@y.co",
      subject: "Hi there",
    });
  });
});

describe("bodyToHtml", () => {
  it("makes paragraphs from blank lines and keeps single breaks", () => {
    expect(bodyToHtml("Hi Yoni,\n\nThanks for the call.\nTalk Friday.\n\n\nRankin")).toBe(
      "<p>Hi Yoni,</p><p>Thanks for the call.<br>Talk Friday.</p><p>Rankin</p>"
    );
  });

  it("escapes markup, so a draft can never inject HTML", () => {
    expect(bodyToHtml('<img src=x onerror="alert(1)"> & more')).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; more</p>"
    );
  });
});
