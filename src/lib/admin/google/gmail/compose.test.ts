import { describe, it, expect } from "vitest";
import {
  buildMessage,
  encodeHeader,
  forwardQuote,
  forwardSubject,
  htmlToText,
  parseRecipients,
  quotable,
  replyAllRecipients,
  replyQuote,
  replySubject,
  toRaw,
  validateCompose,
  MAX_RECIPIENTS,
} from "@/lib/admin/google/gmail/compose";

/**
 * The bytes Gmail is handed for a new email. Expected values are written by
 * hand from RFC 2822 / 2045 / 2047, not produced by running the builder.
 */

const decodePart = (message: string, type: string) => {
  const block = message.split(/--b1(?:--)?\r\n/).find((p) => p.startsWith(`Content-Type: ${type}`));
  const body = block!.split("\r\n\r\n")[1];
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
};

describe("buildMessage", () => {
  const message = buildMessage(
    {
      recipients: { to: ["Jim Poage <jim@sky.test>", "ann@mesa.test"], cc: [], bcc: ["boss@wildcat.test"] },
      subject: "Checkbook call",
      html: "<p>Hi Jim,</p><p>See <a href=\"https://x.test/a\">the doc</a>.</p>",
    },
    "b1"
  );

  it("writes the headers, with Bcc kept for Gmail to route and strip", () => {
    expect(message.split("\r\n\r\n")[0]).toBe(
      [
        "To: Jim Poage <jim@sky.test>, ann@mesa.test",
        "Bcc: boss@wildcat.test",
        "Subject: Checkbook call",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="b1"',
      ].join("\r\n")
    );
  });

  it("carries a plain text copy and the HTML", () => {
    expect(decodePart(message, "text/plain")).toBe("Hi Jim,\nSee the doc (https://x.test/a).");
    expect(decodePart(message, "text/html")).toBe(
      '<div dir="ltr"><p>Hi Jim,</p><p>See <a href="https://x.test/a">the doc</a>.</p></div>'
    );
  });

  it("closes the multipart and uses CRLF only", () => {
    expect(message.endsWith("\r\n--b1--\r\n")).toBe(true);
    expect(message.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("keeps base64 lines at 76 characters", () => {
    const long = buildMessage({ recipients: { to: ["a@b.co"], cc: [], bcc: [] }, subject: "x", html: "y".repeat(500) }, "b1");
    const lines = long.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]+$/.test(l));
    expect(Math.max(...lines.map((l) => l.length))).toBe(76);
  });
});

describe("encodeHeader", () => {
  it("leaves ASCII alone and encodes UTF-8 as B words", () => {
    expect(encodeHeader("Hello")).toBe("Hello");
    // "Café" is 43 61 66 C3 A9.
    expect(encodeHeader("Café")).toBe("=?UTF-8?B?Q2Fmw6k=?=");
  });

  it("cannot be used to inject a header", () => {
    expect(encodeHeader("Hi\r\nBcc: evil@x.test")).toBe("Hi Bcc: evil@x.test");
  });

  it("splits long non-ASCII text into words of at most 75 characters", () => {
    const words = encodeHeader("é".repeat(60)).split("\r\n ");
    // 22 two-byte characters fit in 45 bytes: 60 = 22 + 22 + 16.
    expect(words).toHaveLength(3);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
  });
});

describe("parseRecipients", () => {
  it("splits on commas, semicolons and new lines", () => {
    expect(parseRecipients("a@b.co; Jim <jim@sky.test>\nc@d.co,")).toEqual({
      ok: true,
      list: ["a@b.co", "Jim <jim@sky.test>", "c@d.co"],
    });
  });

  it("names the first entry that is not an address", () => {
    expect(parseRecipients("a@b.co, jim at sky")).toEqual({ ok: false, bad: "jim at sky" });
  });
});

describe("validateCompose", () => {
  const base = { to: "", cc: "", bcc: "", subject: "", html: "" };

  it("needs at least one recipient", () => {
    expect(validateCompose(base)).toEqual({ ok: false, error: "Add at least one recipient." });
  });

  it("accepts a Cc-only message", () => {
    expect(validateCompose({ ...base, cc: "a@b.co" })).toEqual({ ok: true, recipients: { to: [], cc: ["a@b.co"], bcc: [] } });
  });

  it("caps the recipients", () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@x.co`).join(",");
    expect(validateCompose({ ...base, to: many })).toEqual({ ok: false, error: `At most ${MAX_RECIPIENTS} recipients.` });
  });
});

describe("htmlToText", () => {
  it("turns lists and breaks into lines", () => {
    expect(htmlToText("<p>A&amp;B</p><ul><li><p>one</p></li><li><p>two</p></li></ul><p>x<br>y</p>")).toBe(
      "A&B\n\n- one\n\n- two\n\nx\ny"
    );
  });
});

describe("toRaw", () => {
  it("is base64url with no padding", () => {
    // "?>?" is 3F 3E 3F: base64 "Pz4/", url-safe "Pz4_".
    expect(toRaw("?>?")).toBe("Pz4_");
  });
});

describe("a reply", () => {
  const message = buildMessage(
    {
      recipients: { to: ["yoni@checkbook.test"], cc: [], bcc: [] },
      subject: "Re: Call",
      html: "<p>Yes</p>",
      inReplyTo: "<abc@mail.gmail.com>",
      references: "<first@x.co> <abc@mail.gmail.com>",
    },
    "b1"
  );

  it("carries the threading headers", () => {
    expect(message.split("\r\n\r\n")[0]).toBe(
      [
        "To: yoni@checkbook.test",
        "Subject: Re: Call",
        "In-Reply-To: <abc@mail.gmail.com>",
        "References: <first@x.co> <abc@mail.gmail.com>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="b1"',
      ].join("\r\n")
    );
  });

  it("drops a malformed id rather than injecting a header", () => {
    const bad = buildMessage(
      { recipients: { to: ["a@b.co"], cc: [], bcc: [] }, subject: "s", html: "x", inReplyTo: "<a@b>\r\nBcc: evil@x.co" },
      "b1"
    );
    expect(bad).not.toContain("In-Reply-To");
    expect(bad).not.toContain("evil");
  });
});

describe("a forward with attachments", () => {
  const message = buildMessage(
    {
      recipients: { to: ["a@b.co"], cc: [], bcc: [] },
      subject: "Fwd: Deck",
      html: "<p>FYI</p>",
      attachments: [{ filename: "café.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) }],
    },
    "b1"
  );

  it("is multipart/mixed wrapping the alternative and the file", () => {
    expect(message).toBe(
      [
        "To: a@b.co",
        "Subject: Fwd: Deck",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b1m"',
        "",
        "--b1m",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("FYI").toString("base64"),
        "--b1",
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from('<div dir="ltr"><p>FYI</p></div>').toString("base64"),
        "--b1--",
        "--b1m",
        'Content-Type: application/pdf; name="caf_.pdf"',
        "Content-Disposition: attachment; filename=\"caf_.pdf\"; filename*=UTF-8''caf%C3%A9.pdf",
        "Content-Transfer-Encoding: base64",
        "",
        "AQID",
        "--b1m--",
        "",
      ].join("\r\n")
    );
  });
});

describe("quoting", () => {
  const m = {
    fromName: "Yoni Rapaport",
    fromEmail: "yoni@checkbook.test",
    date: Date.UTC(2026, 9, 7, 23, 12), // 6:12 PM Central
    subject: "Call",
    to: "Rankin Poage",
    html: "<html><head><style>p{}</style></head><body><p>Moved <b>it</b></p><script>x()</script></body></html>",
    text: null,
  };

  it("strips the document wrapper, scripts and styles from the quoted email", () => {
    expect(quotable(m.html, null)).toBe("<p>Moved <b>it</b></p>");
    expect(quotable(null, "a < b\nc")).toBe("<div>a &lt; b<br>c</div>");
    expect(quotable('<p>Hi</p><img src="/api/admin/google/gmail/attachment?m=1&amp;p=2"><img src="https://x.co/a.png">', null)).toBe(
      '<p>Hi</p><img src="https://x.co/a.png">'
    );
  });

  it("writes Gmail's reply attribution", () => {
    expect(replyQuote(m)).toBe(
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Wed, Oct 7, 2026 at 6:12 PM Yoni Rapaport &lt;yoni@checkbook.test&gt; wrote:<br></div>' +
        '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><p>Moved <b>it</b></p></blockquote></div>'
    );
  });

  it("writes Gmail's forward header", () => {
    expect(forwardQuote(m)).toBe(
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>' +
        "From: <b>Yoni Rapaport</b> &lt;yoni@checkbook.test&gt;<br>Date: Wed, Oct 7, 2026 at 6:12 PM<br>Subject: Call<br>To: Rankin Poage<br></div><br><br>" +
        "<p>Moved <b>it</b></p></div>"
    );
  });

  it("prefixes subjects once", () => {
    expect(replySubject("Call")).toBe("Re: Call");
    expect(replySubject("RE: Call")).toBe("RE: Call");
    expect(forwardSubject("Fwd: Call")).toBe("Fwd: Call");
    expect(forwardSubject("Re: Call")).toBe("Fwd: Re: Call");
  });

  it("reply all drops me and the sender from Cc, without duplicates", () => {
    expect(
      replyAllRecipients(
        {
          replyTo: "Yoni <yoni@checkbook.test>",
          fromEmail: "yoni@checkbook.test",
          toAddresses: ["Rankin <rankin@wildcatiq.ai>", "Jerry <jerry@checkbook.test>"],
          ccAddresses: ["jerry@checkbook.test", "ann@x.co"],
        },
        "rankin@wildcatiq.ai"
      )
    ).toEqual({ to: "Yoni <yoni@checkbook.test>", cc: "Jerry <jerry@checkbook.test>, ann@x.co" });
  });
});
