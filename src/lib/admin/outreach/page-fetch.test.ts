import { describe, it, expect } from "vitest";
import { contactLinks, extractContacts, htmlToText, normalizePhone, pageTitle, robotsAllows } from "./page-fetch";

const HTML = `<html><head><title>Acme Oil &amp; Gas | Home</title><style>p{}</style></head>
<body><script>var x = "noise@example.com";</script>
<h1>Acme Oil &amp; Gas</h1>
<p>Office: (432) 555-0100 &middot; 100 Main St, Midland, TX 79701</p>
<p>Email <a href="mailto:Info@AcmeOil.com?subject=hi">us</a> or call <a href="tel:+1-432-555-0199">the field office</a>.</p>
<p>John Doe, President: john.doe@acmeoil.com, 432.555.0150</p>
<img src="logo@2x.png">
<a href="/about-us">About</a> <a href="/contact">Contact Us</a> <a href="https://other.com/team">Partner</a>
<a href="/news">News</a> <a href="/contact#form">Contact form</a>
</body></html>`;

describe("htmlToText", () => {
  it("drops scripts and styles, keeps the words, decodes entities", () => {
    const text = htmlToText(HTML);
    expect(text).toContain("Acme Oil & Gas");
    expect(text).toContain("John Doe, President");
    expect(text).not.toContain("noise@example.com");
    expect(text).not.toContain("p{}");
  });
  it("reads the title", () => {
    expect(pageTitle(HTML)).toBe("Acme Oil & Gas | Home");
  });
});

describe("normalizePhone", () => {
  it("accepts the written forms and rejects the rest", () => {
    expect(normalizePhone("432.555.0150")).toBe("(432) 555-0150");
    expect(normalizePhone("+1 (432) 555-0100")).toBe("(432) 555-0100");
    expect(normalizePhone("555-0100")).toBeNull();
  });
});

describe("extractContacts", () => {
  it("takes mailto and tel links, then addresses and numbers in the text, once each", () => {
    const { emails, phones } = extractContacts(HTML, htmlToText(HTML));
    expect(emails).toEqual(["info@acmeoil.com", "john.doe@acmeoil.com"]);
    expect(phones).toEqual(["(432) 555-0199", "(432) 555-0100", "(432) 555-0150"]);
  });
});

describe("contactLinks", () => {
  it("keeps same-site contact-ish links, deduplicated, without fragments", () => {
    expect(contactLinks(HTML, "https://acmeoil.com/")).toEqual([
      "https://acmeoil.com/about-us",
      "https://acmeoil.com/contact",
    ]);
  });
});

describe("robotsAllows", () => {
  const robots = `User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/ok\n`;
  it("applies only the * group", () => {
    expect(robotsAllows(robots, "/contact")).toBe(true);
    expect(robotsAllows(robots, "/private/x")).toBe(false);
    expect(robotsAllows(robots, "/private/ok")).toBe(true);
    expect(robotsAllows("", "/anything")).toBe(true);
  });
});
