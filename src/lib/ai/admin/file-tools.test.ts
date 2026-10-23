import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

/**
 * create_file: the bytes for each format (checked by reading them back the way
 * Excel or a text editor would), the storage path the download action accepts,
 * and the chat block a result turns into.
 */

const isAdmin = vi.fn(async () => true);
vi.mock("@/lib/auth/platform-admin", () => ({ isPlatformAdmin: () => isAdmin() }));
const upload = vi.fn(async (..._a: unknown[]): Promise<{ error: { message: string } | null }> => ({ error: null }));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({ storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a) }) } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  isAdmin.mockResolvedValue(true);
});

describe("buildFile", () => {
  it("writes a CSV Excel reads back cell for cell, quoting commas, quotes and newlines", async () => {
    const { buildCsv } = await import("@/lib/admin/orion-file-build");
    const { parseCsv } = await import("@/lib/ai/file-spec");
    const csv = buildCsv({ columns: ["Company", "Note", "Wells"], rows: [["Sky, Inc.", 'said "hi"\nthen left', 23], ["Acme", null, 0]] });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(parseCsv(csv).filter((r) => r.some(Boolean))).toEqual([
      ["Company", "Note", "Wells"],
      ["Sky, Inc.", 'said "hi"\nthen left', "23"],
      ["Acme", "", "0"],
    ]);
  });

  it("writes an xlsx with one tab per sheet, numbers kept as numbers", async () => {
    const { buildXlsx } = await import("@/lib/admin/orion-file-build");
    const bytes = buildXlsx([
      { name: "Customers", columns: ["Name", "ARR"], rows: [["Sky", 9600]] },
      { name: "Customers", columns: ["X"], rows: [] },
    ]);
    const book = XLSX.read(bytes, { type: "array" });
    expect(book.SheetNames).toEqual(["Customers", "Customers 2"]);
    expect(XLSX.utils.sheet_to_json(book.Sheets.Customers, { header: 1 })).toEqual([["Name", "ARR"], ["Sky", 9600]]);
    expect(book.Sheets.Customers.B2.t).toBe("n");
  });

  it("lays a long Markdown table out over as many PDF pages as its rows need", async () => {
    const { buildFile } = await import("@/lib/admin/orion-file-build");
    const { PDFDocument } = await import("pdf-lib");
    const rows = Array.from({ length: 120 }, (_, i) => `| Operator ${i + 1} | ${i} |`).join("\n");
    const md = `# Customers\n\n| Company | Wells |\n|---|---:|\n${rows}\n\nSky → Tier 2 🚀`;
    const { bytes, mediaType } = await buildFile({ format: "pdf", content: md, title: "Customers" });
    expect(mediaType).toBe("application/pdf");
    const doc = await PDFDocument.load(bytes);
    // ~17 table rows fit a Letter page at this size, so 120 rows cannot fit on fewer than 4 pages.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(4);
    expect(doc.getTitle()).toBe("Customers");
  });

  it("names the file safely with the format's extension", async () => {
    const { fileName } = await import("@/lib/admin/orion-file-build");
    expect(fileName("../Q4 report: final.xlsx", "md")).toBe(".._Q4 report_ final.md");
    expect(fileName("", "csv")).toBe("orion-file.csv");
  });
});

describe("create_file", () => {
  const run = async (input: unknown) => {
    const { fileTools } = await import("./file-tools");
    return (fileTools().create_file.execute as unknown as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {});
  };

  it("stores the file under orion/<uuid>/ and returns the card the chat renders", async () => {
    const r = await run({ filename: "customers", format: "csv", sheets: [{ columns: ["Name"], rows: [["Sky"]] }] });
    const [path, bytes, opts] = upload.mock.calls[0] as [string, Uint8Array, { contentType: string }];
    expect(path).toMatch(/^orion\/[0-9a-f-]{36}\/customers\.csv$/);
    expect(opts.contentType).toBe("text/csv");
    expect(r).toEqual({ ok: true, file: { path, filename: "customers.csv", format: "csv", sizeBytes: bytes.byteLength } });

    const { messageBlocks } = await import("@/lib/ai/chart-spec");
    const blocks = messageBlocks({ parts: [{ type: "text", text: "Here it is." }, { type: "tool-create_file", output: r }] });
    expect(blocks).toEqual([{ kind: "text", text: "Here it is." }, { kind: "file", file: r.file }]);
  });

  it("refuses a table format without sheets, a text format without content, and a CSV of two sheets", async () => {
    expect(await run({ filename: "x", format: "xlsx" })).toMatchObject({ ok: false });
    expect(await run({ filename: "x", format: "md" })).toMatchObject({ ok: false });
    const two = [{ columns: ["a"], rows: [] }, { columns: ["b"], rows: [] }];
    expect(await run({ filename: "x", format: "csv", sheets: two })).toMatchObject({ ok: false, error: expect.stringMatching(/one table/) });
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses a non-admin before storing anything", async () => {
    isAdmin.mockResolvedValue(false);
    await expect(run({ filename: "x", format: "txt", content: "hi" })).rejects.toThrow(/Platform admin/);
    expect(upload).not.toHaveBeenCalled();
  });
});
