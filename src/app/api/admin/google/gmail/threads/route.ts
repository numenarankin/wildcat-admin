/**
 * GET /api/admin/google/gmail/threads?filter=<folder>&q=<search>&pageToken=<token>
 *
 * A page of /email's thread list. A route for the same reason as `../thread`:
 * a list refresh (every window focus) must not queue ahead of opening an
 * email. 404 for anyone who isn't a platform admin, before any Google call.
 */

import { googleAdminId } from "@/lib/admin/google/guard";
import { googleErrorMessage } from "@/lib/admin/google/fetch";
import { listThreads } from "@/lib/admin/google/gmail/client";
import { isGmailFilter } from "@/lib/admin/google/gmail/types";

const Q_MAX = 500;

export async function GET(req: Request) {
  const userId = await googleAdminId();
  if (!userId) return new Response("Not found", { status: 404 });
  const params = new URL(req.url).searchParams;
  const filter = params.get("filter");
  if (!isGmailFilter(filter)) return Response.json({ ok: false, error: "Unknown folder." }, { status: 400 });
  const q = params.get("q")?.slice(0, Q_MAX) || undefined;
  const pageToken = params.get("pageToken") || undefined;
  try {
    return Response.json(
      { ok: true, data: await listThreads(userId, { filter, q, pageToken }) },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error("gmail threads failed", error);
    return Response.json({ ok: false, error: googleErrorMessage(error, "Email") }, { status: 502 });
  }
}
