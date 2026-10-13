/**
 * GET /api/admin/google/gmail/thread?id=<threadId>
 *
 * One Gmail thread for /email's reading pane. A route, not a server action:
 * Next runs server actions one at a time per page, so opening an email would
 * wait behind whatever list refresh was already in flight. 404 for anyone
 * who isn't a platform admin, before any Google call.
 */

import { googleAdminId } from "@/lib/admin/google/guard";
import { googleErrorMessage } from "@/lib/admin/google/fetch";
import { getThread, isGmailId } from "@/lib/admin/google/gmail/client";

export async function GET(req: Request) {
  const userId = await googleAdminId();
  if (!userId) return new Response("Not found", { status: 404 });
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  // The list's historyId: a cached copy at that stamp is served without Google.
  const h = params.get("h");
  const historyId = h && /^[0-9]{1,30}$/.test(h) ? h : undefined;
  if (!isGmailId(id)) return Response.json({ ok: false, error: "No such thread." }, { status: 404 });
  try {
    return Response.json({ ok: true, data: await getThread(userId, id, historyId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("gmail thread failed", error);
    return Response.json({ ok: false, error: googleErrorMessage(error, "Email") }, { status: 502 });
  }
}
