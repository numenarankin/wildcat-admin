import { beforeEach, describe, expect, it, vi } from "vitest";
import { qLiteral, toDriveRow } from "@/lib/admin/google/drive/map";

/**
 * Oracle tests for Drive, read only (plan section 7.4): rows as the browser
 * shows them, the download route's exports and gate, and the exact listing
 * request. Drive responses are hand-written from the Drive API v3 reference.
 */

const session = { adminId: "u1" as string | null };
vi.mock("@/lib/admin/google/guard", () => ({
  googleAdminId: vi.fn(async () => session.adminId),
}));
vi.mock("@/lib/admin/google/connections", () => ({
  getGoogleAccessToken: vi.fn(async () => "ya29.drive"),
}));

const urls: string[] = [];
let meta: Record<string, unknown> = {};

beforeEach(() => {
  session.adminId = "u1";
  urls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/export") || url.includes("alt=media")) {
        return new Response("BYTES", { headers: { "Content-Type": "application/x-test", "Content-Length": "5" } });
      }
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) return Response.json({ files: [] });
      return Response.json(meta);
    })
  );
});

describe("Drive rows", () => {
  it("shows a Google Doc with no size and Chicago date", () => {
    expect(
      toDriveRow({
        id: "d1",
        name: "Lease notes",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-10-01T03:00:00Z",
        webViewLink: "https://docs.google.com/document/d/d1/edit",
      })
    ).toEqual({
      id: "d1",
      name: "Lease notes",
      kind: "doc",
      type: "Doc",
      size: "",
      // 03:00 UTC on Oct 1 is Sep 30 in Chicago.
      modified: "Sep 30, 2026",
      webViewLink: "https://docs.google.com/document/d/d1/edit",
      downloadable: true,
    });
  });

  it("sizes an uploaded file the way the Files browser does", () => {
    const row = toDriveRow({ id: "f1", name: "run_ticket.pdf", mimeType: "application/pdf", size: "2516582" });
    // 2516582 / 1024 / 1024 = 2.4 MB
    expect([row.kind, row.type, row.size]).toEqual(["pdf", "PDF", "2.4 MB"]);
    expect(toDriveRow({ id: "f2", name: "survey.las", mimeType: "application/octet-stream", size: "900" }).type).toBe("LAS");
  });

  it("does not offer Download for Google types that cannot be exported", () => {
    expect(toDriveRow({ id: "x", name: "Form", mimeType: "application/vnd.google-apps.form" }).downloadable).toBe(false);
    expect(toDriveRow({ id: "y", name: "F", mimeType: "application/vnd.google-apps.folder" }).downloadable).toBe(false);
  });

  it("escapes a search term for Drive's q syntax", () => {
    expect(qLiteral("O'Neil \\ unit")).toBe("'O\\'Neil \\\\ unit'");
  });
});

describe("GET /api/admin/google/drive/download", () => {
  async function get(id: string) {
    const { GET } = await import("./route");
    return GET(new Request(`https://app.test/api/admin/google/drive/download?id=${id}`));
  }

  it("404s a non-admin before any Google call", async () => {
    session.adminId = null;
    const res = await get("d1");
    expect(res.status).toBe(404);
    expect(urls).toHaveLength(0);
  });

  it("exports a Google Doc as .docx", async () => {
    meta = { id: "d1", name: "Lease notes", mimeType: "application/vnd.google-apps.document" };
    const res = await get("d1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("BYTES");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Lease notes.docx"; filename*=UTF-8''Lease%20notes.docx`
    );
    const exportUrl = new URL(urls[1]);
    expect(exportUrl.pathname).toBe("/drive/v3/files/d1/export");
    expect(exportUrl.searchParams.get("mimeType")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  it("streams an uploaded file as is", async () => {
    meta = { id: "f1", name: "ticket.pdf", mimeType: "application/pdf" };
    const res = await get("f1");
    expect(res.headers.get("content-type")).toBe("application/x-test");
    const media = new URL(urls[1]);
    expect(media.pathname).toBe("/drive/v3/files/f1");
    expect(media.searchParams.get("alt")).toBe("media");
    expect(media.searchParams.get("supportsAllDrives")).toBe("true");
  });

  it("refuses an id that is not a Drive id", async () => {
    const res = await get("..%2Fsecrets");
    expect(res.status).toBe(400);
    expect(urls).toHaveLength(0);
  });

  it("refuses a Google Form", async () => {
    meta = { id: "x", name: "Form", mimeType: "application/vnd.google-apps.form" };
    const res = await get("x");
    expect(res.status).toBe(415);
  });
});

describe("Drive folder listing request", () => {
  it("asks for one folder's children across shared drives, folders first", async () => {
    const { listFolder } = await import("@/lib/admin/google/drive/client");
    await listFolder("u1", "abc123");
    const url = new URL(urls[0]);
    expect(url.searchParams.get("q")).toBe("'abc123' in parents and trashed=false");
    expect(url.searchParams.get("orderBy")).toBe("folder,name");
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
    expect(url.searchParams.get("fields")).toBe(
      "nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,parents)"
    );
  });
});
