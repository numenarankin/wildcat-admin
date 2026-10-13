/**
 * GET /api/admin/google/gmail/attachment?m=<messageId>&p=<partId>[&view=1]
 *
 * `view=1` asks to show it in the browser; honoured only for `VIEWABLE_TYPES`
 * (PDF, raster images, plain text), everything else still downloads.
 *
 * One Gmail attachment, downloaded through the server for the session's own
 * Google account and never stored. 404 for anyone who isn't a platform
 * admin, before any Google call. Plan: docs/plans/google-integration.md 7.1.
 */

import { googleAdminId } from "@/lib/admin/google/guard";
import { googleErrorMessage, GoogleApiError } from "@/lib/admin/google/fetch";
import { getAttachment, isGmailId, isPartId } from "@/lib/admin/google/gmail/client";
import { contentDisposition, isViewable } from "@/lib/admin/google/gmail/mime";

const NOT_FOUND = () => new Response("Not found", { status: 404 });

export async function GET(req: Request) {
  const userId = await googleAdminId();
  if (!userId) return NOT_FOUND();

  const query = new URL(req.url).searchParams;
  const messageId = query.get("m");
  const partId = query.get("p");
  if (!isGmailId(messageId) || !isPartId(partId)) return NOT_FOUND();

  let file: Awaited<ReturnType<typeof getAttachment>>;
  try {
    file = await getAttachment(userId, messageId, partId);
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) return NOT_FOUND();
    console.error("gmail attachment failed", error);
    return new Response(googleErrorMessage(error, "Email"), { status: 502 });
  }
  if (!file) return NOT_FOUND();

  const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(file.mimeType)
    ? file.mimeType
    : "application/octet-stream";
  const inline = query.get("view") === "1" && isViewable(type);
  return new Response(new Blob([file.bytes as BlobPart]), {
    headers: {
      "Content-Type": type.startsWith("text/") ? `${type}; charset=utf-8` : type,
      "Content-Length": String(file.bytes.byteLength),
      "Content-Disposition": contentDisposition(file.filename, inline ? "inline" : "attachment"),
      // A message's parts never change: the browser keeps them.
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
