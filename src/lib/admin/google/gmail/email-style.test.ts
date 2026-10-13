import { describe, it, expect } from "vitest";
import { cleanSignature, composeSeed, hasContent, styleEmailHtml } from "@/lib/admin/google/gmail/email-style";
import { buildMessage } from "@/lib/admin/google/gmail/compose";

describe("styleEmailHtml", () => {
  it("wraps the body in the saved font and size, paragraphs tight, empty lines kept", () => {
    expect(styleEmailHtml("<p>Hi</p><p></p><p>Rankin</p>", { fontFamily: "georgia", fontSize: "large" })).toBe(
      '<div dir="ltr" style="font-family:Georgia, serif;font-size:18px">' +
        '<p style="margin:0">Hi</p><p style="margin:0"><br></p><p style="margin:0">Rankin</p></div>'
    );
  });

  it("escapes the quotes in a font list so the style attribute stays closed", () => {
    expect(styleEmailHtml("x", { fontFamily: "serif", fontSize: "normal" })).toBe(
      '<div dir="ltr" style="font-family:&quot;Times New Roman&quot;, Times, serif;font-size:13px">x</div>'
    );
  });

  it("is what Send puts in the HTML part", () => {
    const message = buildMessage(
      { recipients: { to: ["a@b.co"], cc: [], bcc: [] }, subject: "s", html: "<p>Hi</p>", style: { fontFamily: "sans", fontSize: "normal" } },
      "b1"
    );
    const html = message.split("--b1\r\n").find((p) => p.startsWith("Content-Type: text/html"))!.split("\r\n\r\n")[1].split("\r\n--b1--")[0];
    expect(Buffer.from(html.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(
      '<div dir="ltr" style="font-family:Arial, Helvetica, sans-serif;font-size:13px"><p style="margin:0">Hi</p></div>'
    );
  });
});

describe("styleEmailHtml links", () => {
  it("leaves links unstyled, so each client's default blue applies to them and to its auto-links alike", () => {
    expect(styleEmailHtml('<p><a href="https://x.co">x</a></p>', { fontFamily: "sans", fontSize: "normal" })).toContain(
      '<a href="https://x.co">x</a>'
    );
  });
});

describe("cleanSignature", () => {
  it("keeps the editor's styling and links", () => {
    const sig = '<p><strong><span style="font-family: Georgia, serif; font-size: 14px; color: #1a73e8">Rankin Poage</span></strong></p><p><a target="_blank" rel="noopener noreferrer" href="https://wildcatiq.ai">wildcatiq.ai</a></p>';
    expect(cleanSignature(sig)).toBe(sig);
  });

  it("strips scripts, handlers and javascript: links", () => {
    expect(
      cleanSignature('<p onclick="x()">Hi<script>alert(1)</script><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)></p>')
    ).toBe('<p>Hi<a href="#">x</a><img src=x></p>');
  });
});

describe("composeSeed", () => {
  it("leaves two lines to type on, then the signature", () => {
    expect(composeSeed("<p>Rankin</p>")).toBe("<p></p><p></p><p>Rankin</p>");
  });

  it("puts a draft's body above the signature", () => {
    expect(composeSeed("<p>Rankin</p>", "<p>Hi Yoni</p>")).toBe("<p>Hi Yoni</p><p></p><p>Rankin</p>");
  });

  it("adds nothing for an empty signature", () => {
    expect(composeSeed("<p></p>")).toBe("<p></p><p></p>");
    expect(hasContent("<p></p>")).toBe(false);
    expect(hasContent('<p><a href="https://x.co"></a></p>')).toBe(true);
  });
});
