/**
 * GET /api/admin/google/gmail/index
 *
 * The composer's autofill index, re-read after a send so the new recipient
 * and subject appear at once (the page gets its first copy server-side).
 * 404 for anyone who isn't a platform admin.
 */

import { googleAdminId } from "@/lib/admin/google/guard";
import { readEmailIndex } from "@/lib/admin/google/gmail/index-read";

export async function GET() {
  const userId = await googleAdminId();
  if (!userId) return new Response("Not found", { status: 404 });
  return Response.json(await readEmailIndex(userId), { headers: { "Cache-Control": "private, no-store" } });
}
