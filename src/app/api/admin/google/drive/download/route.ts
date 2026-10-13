/**
 * GET /api/admin/google/drive/download?id=<fileId>: stream one Drive file to
 * the admin. Google-native files are exported (Docs as .docx, Sheets as .xlsx,
 * Slides as .pptx, Drawings as .pdf). Nothing is stored. 404 for anyone off
 * the admin list, before any Google call.
 */

import { googleAdminId } from "@/lib/admin/google/guard";
import { GoogleApiError } from "@/lib/admin/google/fetch";
import { downloadFile, getFile } from "@/lib/admin/google/drive/client";
import { downloadName, isDownloadable, isDriveId } from "@/lib/admin/google/drive/map";

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(req: Request) {
  const userId = await googleAdminId();
  if (!userId) return new Response("Not found", { status: 404 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !isDriveId(id)) return new Response("Bad file id", { status: 400 });

  try {
    const file = await getFile(userId, id);
    if (!isDownloadable(file.mimeType)) {
      return new Response("This Google file type can't be downloaded. Open it in Google.", { status: 415 });
    }
    const res = await downloadFile(userId, file);
    const headers = new Headers({
      "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition": contentDisposition(downloadName(file)),
      "Cache-Control": "no-store",
    });
    const length = res.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);
    return new Response(res.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof GoogleApiError) {
      return new Response(error.message, { status: error.status === 404 ? 404 : 502 });
    }
    console.error("drive download failed", error);
    return new Response("Couldn't download from Google Drive.", { status: 502 });
  }
}
