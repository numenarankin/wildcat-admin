import { describe, it, expect } from "vitest";
import { parseExaFailures, parseExaResults } from "./exa";

/** Exa's documented response shapes, cut to the fields read. */

describe("parseExaResults", () => {
  it("joins a search result's highlights into its text", () => {
    const out = parseExaResults({
      results: [
        {
          title: "Acme Oil & Gas",
          url: "https://acmeoil.com/",
          publishedDate: "2025-01-02",
          highlights: ["Acme Oil & Gas operates 40 wells in Midland County.", "Call (432) 555-0100."],
          highlightScores: [0.9, 0.5],
        },
        { url: "https://acmeoil.com/contact", text: "Contact us at info@acmeoil.com" },
        { title: "no url" },
      ],
    });
    expect(out).toEqual([
      {
        title: "Acme Oil & Gas",
        url: "https://acmeoil.com/",
        text: "Acme Oil & Gas operates 40 wells in Midland County.\nCall (432) 555-0100.",
        publishedDate: "2025-01-02",
      },
      { title: "https://acmeoil.com/contact", url: "https://acmeoil.com/contact", text: "Contact us at info@acmeoil.com", publishedDate: null },
    ]);
  });
  it("is empty for anything else", () => {
    expect(parseExaResults(null)).toEqual([]);
    expect(parseExaResults({})).toEqual([]);
  });
});

describe("parseExaFailures", () => {
  it("lists the URLs a contents call could not read", () => {
    expect(
      parseExaFailures({
        results: [],
        statuses: [
          { id: "https://ok.example", status: "success" },
          { id: "https://slow.example", status: "error", error: { tag: "CRAWL_TIMEOUT", httpStatusCode: 408 } },
          { id: "https://gone.example", status: "error" },
        ],
      })
    ).toEqual([
      { url: "https://slow.example", error: "CRAWL_TIMEOUT" },
      { url: "https://gone.example", error: "error" },
    ]);
  });
});
