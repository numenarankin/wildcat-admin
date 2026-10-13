import { describe, it, expect } from "vitest";
import { stripQuotedHtml, stripQuotedText } from "@/lib/admin/google/gmail/view";

describe("stripQuotedHtml", () => {
  it("removes Gmail's quote container with everything nested in it", () => {
    const html =
      '<div dir="ltr">Let\'s do 10:30.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr">On Wed wrote:<br></div><blockquote class="gmail_quote"><div>older<div>deeper</div></div></blockquote></div><div>after</div>';
    expect(stripQuotedHtml(html)).toBe('<div dir="ltr">Let\'s do 10:30.</div><br><div>after</div>');
  });

  it("removes an Apple Mail cite block", () => {
    expect(stripQuotedHtml('<div>Thanks</div><blockquote type="cite"><div>q</div></blockquote>')).toBe("<div>Thanks</div>");
  });

  it("cuts from Outlook's reply header to the end", () => {
    expect(stripQuotedHtml('<div>Hi</div><div id="divRplyFwdMsg"><b>From:</b></div><div>q</div>')).toBe("<div>Hi</div>");
  });

  it("is null when nothing is quoted", () => {
    expect(stripQuotedHtml("<div>Hi<div>nested</div></div>")).toBeNull();
  });
});

describe("stripQuotedText", () => {
  it("cuts at the wrote: line", () => {
    expect(stripQuotedText("Sounds good\n\nOn Tue, Oct 7, 2026 at 5:41 PM Yoni <y@x.co> wrote:\n> Hi")).toBe("Sounds good");
  });
  it("is null without a quote", () => {
    expect(stripQuotedText("Just this")).toBeNull();
  });
});
